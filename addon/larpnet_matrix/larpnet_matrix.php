<?php
/**
 * Name: LARPnet Matrix Chat
 * Description: Login bridge AND same-origin host for larpnet's own minimal Matrix
 *   web client (client/, Preact + matrix-js-sdk -- see CLAUDE.md). Mints a
 *   60-second HS256 JWT per user that the client trades at Synapse's standard
 *   /login (type org.matrix.login.jwt) for a normal Matrix access token, so no
 *   second password exists. GET /larpnet_matrix serves the client's HTML shell
 *   for a logged-in web user, with a fresh JWT injected inline; GET
 *   /larpnet_matrix/<asset path> serves the client's own built JS/CSS/wasm
 *   (client/dist/, same-origin, no separate chat subdomain). POST
 *   /larpnet_matrix returns the identity + JWT as JSON to an OAuth2-authenticated
 *   native app. Inert unless the LARPNET_MATRIX_* environment variables are set.
 *
 *   GET /larpnet_matrix?dm=<nickname> deep-links straight into a DM with that
 *   other local user (src/Model/Profile.php's "Chat" link on a profile page
 *   builds this) -- the target's localpart is injected into the client's config
 *   and it resolves/creates the DM room itself on load.
 *
 *   On each (throttled) page load, also pushes the user's larpnet display
 *   name + avatar to their Matrix profile via a server-side login against
 *   LARPNET_MATRIX_INTERNAL_URL -- see larpnet_matrix_sync_profile(). The
 *   active ?dm= target gets the same treatment (larpnet_matrix_content()),
 *   and a 'cron' hook (larpnet_matrix_cron()) eventually syncs everyone
 *   else too, so nobody shows up as a raw @localpart:server mxid to other
 *   users just for never having opened chat themselves.
 *
 *   Does NOT implement any device-verification UI -- see CLAUDE.md "Why
 *   there's no device verification UI". A single device can encrypt/decrypt
 *   without cross-signing; that's only needed for cross-device trust, which
 *   this client doesn't model. An earlier version of the previous
 *   (Element-embedding) design tried silently bootstrapping cross-signing
 *   with a separately-versioned matrix-js-sdk and broke Element's own session
 *   restore instead -- moot now that this addon owns the whole client, but
 *   the underlying lesson (don't derive/hold secret-storage keys ourselves)
 *   still applies, see CLAUDE.md.
 * Version: 2.0
 * Author: larpnet admin
 */

use Friendica\Core\Hook;
use Friendica\DI;
use Friendica\Model\Contact;
use Friendica\Model\Photo;
use Friendica\Model\Profile;
use Friendica\Model\User;
use Friendica\Module\BaseApi;

function larpnet_matrix_install()
{
	Hook::register('app_menu', __FILE__, 'larpnet_matrix_app_menu');
	Hook::register('cron', __FILE__, 'larpnet_matrix_cron');
	DI::logger()->info('installed addon larpnet_matrix');
}

/**
 * Periodic bulk sync of every local user's Matrix displayname/avatar --
 * covers users who show up in a group room or get picked via the client's
 * own "+ Nowy czat" picker without ever having opened chat themselves
 * (larpnet_matrix_content()'s per-request sync only ever covers the
 * viewer and, since larpnet_matrix_dm_localpart() support was added, the
 * active ?dm= target -- this cron hook is what eventually catches
 * everyone else). Only fires where a worker daemon actually runs cron
 * jobs -- the test stack deliberately has none, see CLAUDE.md's
 * "Test/staging environment" isolation design, so this is inert there by
 * construction, not a bug.
 *
 * Capped at 20 syncs per tick, not "all users every tick": the existing
 * per-user hourly throttle in larpnet_matrix_sync_profile() means this is
 * a fast no-op for anyone already synced, but a large *unsynced* backlog
 * (e.g. right after this feature ships) would otherwise mean one cron
 * tick doing dozens of serial HTTP round-trips to Synapse. Capping spreads
 * that backlog over several ticks instead.
 */
function larpnet_matrix_cron(): void
{
	$settings = larpnet_matrix_settings();
	if (!$settings || !($settings['internal_url'] ?? null)) {
		return;
	}

	$synced = 0;
	foreach (User::getList(0, 1000, 'active', 'name') as $user) {
		if ($synced >= 20) {
			break;
		}
		$uid = (int) $user['uid'];
		if (time() - DI::pConfig()->get($uid, 'larpnet_matrix', 'synced_at', 0) < 3600) {
			continue;
		}
		$identity = larpnet_matrix_identity($uid, $settings);
		if (!$identity) {
			continue;
		}
		larpnet_matrix_sync_profile($uid, $identity, $settings);
		$synced++;
	}
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
 * isn't valid for Matrix. Used by larpnet_matrix_chat_link_for_nickname()
 * below (itself the single source of truth every core-file call site goes
 * through, via src/Model/Profile.php's getMatrixChatLink()) so "can this
 * user be reached via chat" can't drift from what larpnet_matrix_identity()
 * actually mints.
 */
function larpnet_matrix_localpart(string $nickname): ?string
{
	$sub = strtolower($nickname);
	return preg_match('/^[a-z0-9._=\-\/+]+$/', $sub) ? $sub : null;
}

/**
 * The Chat deep link for a nickname, or null if chat isn't configured or
 * this isn't actually a real local user -- the single authoritative check
 * for "can this nickname be reached via chat," used from every core-file
 * call site that offers a Chat entry point (src/Model/Profile.php's own
 * profile page, src/Module/Contact.php's contact/directory listings, ...).
 * Unlike larpnet_matrix_localpart() alone, this re-validates against the
 * real user table rather than trusting the caller's context: a directory
 * or contact-list row's `nick` field is just a denormalized copy from
 * whenever the contact was added, not a guarantee it's a genuinely local
 * account (a remote contact could coincidentally share a nickname string
 * with an unrelated local user) -- same reasoning as
 * larpnet_matrix_dm_localpart()'s own re-validation of `?dm=`.
 */
function larpnet_matrix_chat_link_for_nickname(?string $nickname): ?string
{
	if (!$nickname || !larpnet_matrix_settings()) {
		return null;
	}
	$user = User::getByNickname($nickname, ['nickname']);
	if (!$user || !larpnet_matrix_localpart($user['nickname'])) {
		return null;
	}
	return 'larpnet_matrix?dm=' . urlencode($user['nickname']);
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
 * that actually exists (and maps to a valid localpart) is returned. The
 * client builds the full mxid itself (localpart + the serverName it's
 * already given), so this stays a plain localpart, not a mxid.
 */
function larpnet_matrix_dm_localpart(): ?string
{
	$nickname = $_GET['dm'] ?? null;
	if (!$nickname) {
		return null;
	}

	$target = User::getByNickname($nickname, ['nickname']);
	return $target ? larpnet_matrix_localpart($target['nickname']) : null;
}

/**
 * The picker list for the client's own "start a new chat" button --
 * everyone else Profile::searchProfiles() would list (same population, same
 * privacy semantics, as the existing Site Directory: verified, not
 * blocked/removed, and opted into `publish` unless the site publishes all
 * profiles) with a valid Matrix localpart. Reuses that method rather than
 * inventing a separate "who's chattable" population, so this list can't
 * drift from what the Directory already shows as publicly listed.
 */
function larpnet_matrix_contact_list(int $excludeUid): array
{
	$profiles = Profile::searchProfiles(0, 500)['entries'];

	$out = [];
	foreach ($profiles as $p) {
		if ((int) ($p['uid'] ?? 0) === $excludeUid) {
			continue;
		}
		$sub = larpnet_matrix_localpart($p['nickname'] ?? '');
		if (!$sub) {
			continue;
		}
		$out[] = ['nickname' => $p['nickname'], 'name' => $p['name'] ?: $p['nickname']];
	}

	usort($out, fn($a, $b) => strcasecmp($a['name'], $b['name']));
	return $out;
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
			$displaynamePut = DI::httpClient()->request('PUT', $internal . '/_matrix/client/v3/profile/' . $mxid . '/displayname', [
				'body'   => json_encode(['displayname' => $identity['displayname']]),
				'header' => [...$auth, 'Content-Type: application/json'],
			]);
			// Was previously unchecked: a failure here was completely silent
			// (no warning, and synced_at still got marked below as if it had
			// worked, blocking a retry for another hour) -- this is what
			// masked profile sync never actually updating anyone's name.
			if (!$displaynamePut->isSuccess()) {
				DI::logger()->warning('larpnet_matrix: profile sync displayname update failed', [
					'uid'  => $uid,
					'code' => $displaynamePut->getReturnCode(),
					'body' => $displaynamePut->getBodyString(),
				]);
			}
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
				if (!$mxcUri) {
					DI::logger()->warning('larpnet_matrix: profile sync avatar upload failed', [
						'uid'  => $uid,
						'code' => $upload->getReturnCode(),
						'body' => $upload->getBodyString(),
					]);
				} else {
					$avatarPut = DI::httpClient()->request('PUT', $internal . '/_matrix/client/v3/profile/' . $mxid . '/avatar_url', [
						'body'   => json_encode(['avatar_url' => $mxcUri]),
						'header' => [...$auth, 'Content-Type: application/json'],
					]);
					if (!$avatarPut->isSuccess()) {
						DI::logger()->warning('larpnet_matrix: profile sync avatar_url update failed', [
							'uid'  => $uid,
							'code' => $avatarPut->getReturnCode(),
							'body' => $avatarPut->getBodyString(),
						]);
					} else {
						DI::pConfig()->set($uid, 'larpnet_matrix', 'avatar_tag', $tag);
					}
				}
			}
		}

		DI::pConfig()->set($uid, 'larpnet_matrix', 'synced_at', time());
	} catch (\Throwable $e) {
		DI::logger()->warning('larpnet_matrix: profile sync failed', ['error' => $e->getMessage()]);
	}
}

/**
 * Extension -> Content-Type for files under client/dist/. Anything not
 * listed here is refused (see larpnet_matrix_serve_asset()) rather than
 * guessed, so this route can never be used to serve an arbitrary file type.
 */
const LARPNET_MATRIX_ASSET_TYPES = [
	'js'   => 'application/javascript; charset=utf-8',
	'css'  => 'text/css; charset=utf-8',
	'wasm' => 'application/wasm',
	'map'  => 'application/json; charset=utf-8',
];

/**
 * Serves one static file out of client/dist/ (the built chat client -- see
 * client/package.json's build script) and exits. Path segments come from
 * the request's own argv (e.g. GET /larpnet_matrix/pkg/foo.wasm ->
 * ['pkg', 'foo.wasm']), never trusted as a literal filesystem path: each
 * segment is checked against a plain filename pattern (rejects '..', '/',
 * hidden files) before being joined, and the final realpath() must still
 * land inside dist/ -- defense in depth, same spirit as core's
 * src/Module/Photo.php raw-response pattern this addon already follows for
 * the JSON API branch below.
 *
 * No cache-busting/hashed filenames in this build (see client/build.mjs),
 * so responses are marked no-cache rather than long-lived -- a redeploy
 * must not leave a browser tab stuck on a stale bundle indefinitely.
 */
function larpnet_matrix_serve_asset(array $segments): void
{
	// Note: '..' (and '.') match the character class below on their own --
	// they must be rejected explicitly, not just by restricting characters.
	$safe = array_filter($segments, fn($s) => $s !== '' && $s !== '.' && $s !== '..' && preg_match('/^[a-zA-Z0-9._-]+$/', $s));
	if (count($safe) !== count($segments)) {
		http_response_code(404);
		exit;
	}

	$distRoot = realpath(__DIR__ . '/client/dist');
	$path     = $distRoot ? realpath($distRoot . '/' . implode('/', $segments)) : false;
	if (!$path || !$distRoot || !str_starts_with($path, $distRoot . DIRECTORY_SEPARATOR)) {
		http_response_code(404);
		exit;
	}

	$ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
	if (!isset(LARPNET_MATRIX_ASSET_TYPES[$ext])) {
		http_response_code(404);
		exit;
	}

	header('Content-Type: ' . LARPNET_MATRIX_ASSET_TYPES[$ext]);
	header('Cache-Control: no-cache');
	echo file_get_contents($path);
	exit;
}

/**
 * GET /larpnet_matrix[/<asset path>] — with no extra path segments, the chat
 * client's HTML shell for a logged-in web user, with a fresh login JWT and
 * (if ?dm=<nickname> was given, see larpnet_matrix_dm_localpart()) a DM
 * target injected inline as window.LARPNET_CHAT_CONFIG. With extra path
 * segments, one of the client's own built static files (see
 * larpnet_matrix_serve_asset()) -- same route, same origin, so the browser
 * never talks to a separate chat host at all.
 */
function larpnet_matrix_content(): string
{
	$argv = DI::args()->getArgv();
	if (count($argv) > 1) {
		larpnet_matrix_serve_asset(array_slice($argv, 1));
	}

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

	$dm = larpnet_matrix_dm_localpart();
	// Also sync the DM target's own Matrix name -- not just the viewer's.
	// Matrix's own displayname for someone is only ever set once *they*
	// open chat themselves (larpnet_matrix_sync_profile() only pushes the
	// currently-authenticated user's own name), so anyone who's never
	// opened chat would otherwise show up as a raw @localpart:server mxid
	// to everyone else -- in the room list, and in any group room they're
	// a member of (matrix-js-sdk's own multi-member name summary uses each
	// member's real Matrix displayname, so this fixes group naming too,
	// not just the client-side per-DM lookup in client/src/matrix.js).
	if ($dm) {
		$target = User::getByNickname($dm, ['uid']);
		if ($target) {
			$targetIdentity = larpnet_matrix_identity((int) $target['uid'], $settings);
			if ($targetIdentity) {
				larpnet_matrix_sync_profile((int) $target['uid'], $targetIdentity, $settings);
			}
		}
	}

	$config = [
		'homeserverUrl' => $settings['url'],
		'serverName'    => $settings['server'],
		'jwt'           => $identity['token'],
		'dm'            => $dm,
		'deviceName'    => 'larpnet web',
		'contacts'      => larpnet_matrix_contact_list((int) $uid),
		'displayName'   => $identity['displayname'],
	];

	// Raw exit, not a normal module return: this is meant to be a clean
	// standalone document (its own popup window, see
	// js/matrix-chat-widget.js), not wrapped in Friendica's own page chrome
	// (nav bar, sidebar) the way a plain _content() string return would be.
	header('Content-Type: text/html; charset=utf-8');
	echo '<!doctype html><html><head><meta charset="utf-8">'
		. '<title>Czat</title>'
		. '<link rel="stylesheet" href="larpnet_matrix/app.css">'
		. '</head><body><div id="app"></div>'
		. '<script>window.LARPNET_CHAT_CONFIG = ' . json_encode($config) . ';</script>'
		. '<script type="module" src="larpnet_matrix/app.js"></script>'
		. '</body></html>';
	exit;
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
