<?php
/**
 * Name: LARPnet Matrix Chat
 * Description: Login bridge between a larpnet account and the self-hosted Synapse
 *   homeserver. Mints a 60-second HS256 JWT per user that clients trade at Synapse's
 *   standard /login (type org.matrix.login.jwt) for a normal Matrix access token, so
 *   no second password exists. GET /larpnet_matrix renders the chat widget (Element
 *   Web in an iframe) for a logged-in web user; POST /larpnet_matrix returns the
 *   identity + JWT as JSON to an OAuth2-authenticated native app. Inert unless the
 *   LARPNET_MATRIX_* environment variables are set.
 *
 *   GET /larpnet_matrix?dm=<nickname> deep-links the same widget straight into a
 *   DM with that other local user (src/Model/Profile.php's "Chat" link on a
 *   profile page builds this) -- chat/sso.html carries the target through the
 *   SSO handoff and opens Element's #/user/<mxid> panel once logged in.
 *
 *   On each (throttled) page load, also pushes the user's larpnet display
 *   name + avatar to their Matrix profile via a server-side login against
 *   LARPNET_MATRIX_INTERNAL_URL -- see larpnet_matrix_sync_profile().
 *
 *   Does NOT attempt silent E2EE device verification (tried and reverted --
 *   see chat/sso.html in larpnet-config for why: bootstrapping crypto state
 *   with a separately-versioned matrix-js-sdk broke Element's own session
 *   restore instead of just suppressing its "Verify this device" prompt).
 * Version: 1.4
 * Author: larpnet admin
 */

use Friendica\Core\Hook;
use Friendica\DI;
use Friendica\Model\Contact;
use Friendica\Model\Photo;
use Friendica\Model\User;
use Friendica\Module\BaseApi;

function larpnet_matrix_install()
{
	Hook::register('app_menu', __FILE__, 'larpnet_matrix_app_menu');
	DI::logger()->info('installed addon larpnet_matrix');
}

function larpnet_matrix_module() {}

function larpnet_matrix_app_menu(array &$data)
{
	if (larpnet_matrix_settings()) {
		$data['app_menu'][] = '<a href="larpnet_matrix">' . DI::l10n()->t('Chat') . '</a>';
	}
}

/**
 * Deployment settings from the environment (per stack — test never shares
 * prod's secret, which is why this is not a DB config row: the test DB is a
 * copy of prod's). Null = not configured = feature off.
 *
 * 'internal_url', unlike the others, is optional: profile sync
 * (larpnet_matrix_sync_profile()) is skipped without it, everything else
 * still works. It's deliberately NOT the same value as 'url' -- friendica's
 * container has no general internet egress (see CLAUDE.md's Test/staging
 * environment isolation design), so it can't reach the public
 * chat-test.larpnet.pl the browser uses. It reaches Synapse directly
 * instead, over the internal network they both sit on.
 */
function larpnet_matrix_settings(): ?array
{
	$secret = getenv('LARPNET_MATRIX_JWT_SECRET');
	$server = getenv('LARPNET_MATRIX_SERVER_NAME');
	$url    = getenv('LARPNET_MATRIX_HOMESERVER_URL');
	if (!$secret || !$server || !$url) {
		return null;
	}
	return [
		'secret'       => $secret,
		'server'       => $server,
		'url'          => rtrim($url, '/'),
		'internal_url' => rtrim((string) getenv('LARPNET_MATRIX_INTERNAL_URL'), '/') ?: null,
	];
}

/**
 * The Matrix localpart for a larpnet nickname (lower-cased), or null if it
 * isn't valid for Matrix. Shared with src/Model/Profile.php's
 * getMatrixChatLink() (require_once's this file, same pattern as
 * src/Worker/FcmPush.php + addon/larpnet_fcm) so "can this user be reached
 * via chat" can't drift from what larpnet_matrix_identity() actually mints.
 */
function larpnet_matrix_localpart(string $nickname): ?string
{
	$sub = strtolower($nickname);
	return preg_match('/^[a-z0-9._=\-\/+]+$/', $sub) ? $sub : null;
}

/**
 * Matrix identity + a fresh login JWT for a local user, or null if the
 * nickname isn't a valid Matrix localpart.
 */
function larpnet_matrix_identity(int $uid, array $settings): ?array
{
	$user = User::getById($uid, ['nickname']);
	$sub  = larpnet_matrix_localpart($user['nickname'] ?? '');
	if (!$sub) {
		return null;
	}

	$self = Contact::selectFirst(['name'], ['uid' => $uid, 'self' => true]);

	$now = time();
	return [
		'user_id'     => '@' . $sub . ':' . $settings['server'],
		'displayname' => $self['name'] ?? $sub,
		'homeserver'  => $settings['url'],
		'login_type'  => 'org.matrix.login.jwt',
		'token'       => larpnet_matrix_jwt(['sub' => $sub, 'iss' => 'friendica', 'aud' => 'synapse', 'iat' => $now, 'exp' => $now + 60], $settings['secret']),
	];
}

function larpnet_matrix_jwt(array $claims, string $secret): string
{
	$b64   = fn(string $d): string => rtrim(strtr(base64_encode($d), '+/', '-_'), '=');
	$input = $b64(json_encode(['alg' => 'HS256', 'typ' => 'JWT'])) . '.' . $b64(json_encode($claims));
	return $input . '.' . $b64(hash_hmac('sha256', $input, $secret, true));
}

/**
 * The target of a ?dm=<nickname> deep link, resolved against the real user
 * table rather than trusting the query string directly -- only a nickname
 * that actually exists (and maps to a valid localpart) becomes a mxid.
 */
function larpnet_matrix_dm_target(string $server): ?string
{
	$nickname = $_GET['dm'] ?? null;
	if (!$nickname) {
		return null;
	}

	$target = User::getByNickname($nickname, ['nickname']);
	$sub    = $target ? larpnet_matrix_localpart($target['nickname']) : null;
	return $sub ? '@' . $sub . ':' . $server : null;
}

/**
 * Best-effort: pushes the larpnet account's display name + avatar to its
 * Matrix profile, via a server-side login using the same short-lived JWT
 * larpnet_matrix_identity() just minted. Throttled to once an hour per user
 * (pconfig-tracked) -- this costs a handful of HTTP round-trips to Synapse,
 * no need to pay for it on every chat page load or DM navigation. Never
 * throws: a sync failure must not break the chat widget itself.
 */
function larpnet_matrix_sync_profile(int $uid, array $identity, array $settings): void
{
	$internal = $settings['internal_url'] ?? null;
	if (!$internal) {
		return;
	}

	if (time() - DI::pConfig()->get($uid, 'larpnet_matrix', 'synced_at', 0) < 3600) {
		return;
	}

	try {
		$mxid = rawurlencode($identity['user_id']);

		$login = DI::httpClient()->request('POST', $internal . '/_matrix/client/v3/login', [
			'body'   => json_encode(['type' => 'org.matrix.login.jwt', 'token' => $identity['token']]),
			'header' => ['Content-Type: application/json'],
		]);
		$token = $login->isSuccess() ? (json_decode($login->getBodyString(), true)['access_token'] ?? null) : null;
		if (!$token) {
			DI::logger()->warning('larpnet_matrix: profile sync login failed', ['code' => $login->getReturnCode()]);
			return;
		}
		$auth = ['Authorization: Bearer ' . $token];

		$current     = DI::httpClient()->request('GET', $internal . '/_matrix/client/v3/profile/' . $mxid, ['header' => $auth]);
		$currentName = $current->isSuccess() ? (json_decode($current->getBodyString(), true)['displayname'] ?? null) : null;
		if ($currentName !== $identity['displayname']) {
			DI::httpClient()->request('PUT', $internal . '/_matrix/client/v3/profile/' . $mxid . '/displayname', [
				'body'   => json_encode(['displayname' => $identity['displayname']]),
				'header' => [...$auth, 'Content-Type: application/json'],
			]);
		}

		// scale 4 = the small/avatar-sized rendition of the user's own
		// current profile photo -- same lookup src/Module/Photo.php uses
		// to serve /photo/profile/<uid>.jpg.
		$photo = Photo::selectFirst([], ['uid' => $uid, 'profile' => true, 'scale' => 4]);
		$tag   = $photo ? $photo['resource-id'] . '@' . $photo['edited'] : null;
		if ($photo && $tag !== DI::pConfig()->get($uid, 'larpnet_matrix', 'avatar_tag', '')) {
			$data = Photo::getImageDataForPhoto($photo);
			if ($data) {
				$upload  = DI::httpClient()->request('POST', $internal . '/_matrix/media/v3/upload', [
					'body'   => $data,
					'header' => [...$auth, 'Content-Type: ' . $photo['type']],
				]);
				$mxcUri = $upload->isSuccess() ? (json_decode($upload->getBodyString(), true)['content_uri'] ?? null) : null;
				if ($mxcUri) {
					DI::httpClient()->request('PUT', $internal . '/_matrix/client/v3/profile/' . $mxid . '/avatar_url', [
						'body'   => json_encode(['avatar_url' => $mxcUri]),
						'header' => [...$auth, 'Content-Type: application/json'],
					]);
					DI::pConfig()->set($uid, 'larpnet_matrix', 'avatar_tag', $tag);
				}
			}
		}

		DI::pConfig()->set($uid, 'larpnet_matrix', 'synced_at', time());
	} catch (\Throwable $e) {
		DI::logger()->warning('larpnet_matrix: profile sync failed', ['error' => $e->getMessage()]);
	}
}

/**
 * GET /larpnet_matrix — the chat widget for a logged-in web user. The JWT goes
 * in the URL fragment (never sent to a server or logged) of the chat host's
 * sso.html, which logs in and opens Element. An optional ?dm=<nickname>
 * (used by the "Chat" link on another local user's profile page) is passed
 * through the same fragment so sso.html can open a DM with them once logged
 * in, instead of just landing on Element's default view.
 */
function larpnet_matrix_content(): string
{
	$uid = DI::userSession()->getLocalUserId();
	if (!$uid) {
		return '<p>' . DI::l10n()->t('Please log in to use chat.') . '</p>';
	}

	$settings = larpnet_matrix_settings();
	$identity = $settings ? larpnet_matrix_identity((int) $uid, $settings) : null;
	if (!$identity) {
		return '<p>' . DI::l10n()->t('Chat is not available.') . '</p>';
	}

	larpnet_matrix_sync_profile((int) $uid, $identity, $settings);

	$src = $identity['homeserver'] . '/sso.html#jwt=' . $identity['token'];
	$dm  = larpnet_matrix_dm_target($settings['server']);
	if ($dm) {
		$src .= '&dm=' . urlencode($dm);
	}

	// ?embed=1 (used only by the floating popup widget's own <iframe>, see
	// js/matrix-chat-widget.js) redirects straight to the chat host instead
	// of rendering the normal full Friendica page below -- otherwise the
	// widget's iframe would show this ENTIRE page (nav bar and all) with
	// *its own* nested iframe inside, not a clean chat popup.
	if (!empty($_GET['embed'])) {
		header('Location: ' . $src);
		exit;
	}

	// storage-access: without it, some browsers (notably Safari, Firefox)
	// partition or block IndexedDB for a cross-origin iframe like this one,
	// which Element reads as "browser not supported" even though it's
	// really just storage access -- not an actual compatibility problem.
	return '<iframe src="' . htmlspecialchars($src) . '" title="Chat" allow="clipboard-write; microphone; camera; storage-access" '
		. 'style="width:100%;height:80vh;min-height:480px;border:0;"></iframe>';
}

/**
 * POST /larpnet_matrix — JSON identity + JWT for the OAuth2-authenticated
 * native apps. Any valid app token will do (same trust as reading the user's
 * own timeline). The app then POSTs the token to {homeserver}/_matrix/client/v3/login
 * with type "org.matrix.login.jwt".
 */
function larpnet_matrix_post()
{
	header('Content-Type: application/json');

	$uid = BaseApi::getCurrentUserID();
	if (empty($uid) || empty(BaseApi::getCurrentApplication())) {
		http_response_code(401);
		echo json_encode(['error' => 'unauthorized']);
		exit;
	}

	$settings = larpnet_matrix_settings();
	if (!$settings) {
		http_response_code(503);
		echo json_encode(['error' => 'chat_not_configured']);
		exit;
	}

	$identity = larpnet_matrix_identity($uid, $settings);
	if (!$identity) {
		http_response_code(422);
		echo json_encode(['error' => 'unsupported_nickname']);
		exit;
	}

	larpnet_matrix_sync_profile((int) $uid, $identity, $settings);

	echo json_encode($identity);
	exit;
}
