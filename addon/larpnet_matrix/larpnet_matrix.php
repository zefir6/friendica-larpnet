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
 *
 *   POST /larpnet_matrix/push implements the Matrix Push Gateway API
 *   (https://spec.matrix.org/latest/push-gateway-api/) for the native
 *   iOS/Android clients -- Synapse calls this directly (not a browser
 *   session, no OAuth) whenever a pusher's room has a new event. See
 *   larpnet_matrix_push_notify() for the full contract and CLAUDE.md for
 *   why this is a small custom endpoint here rather than a separately
 *   deployed Sygnal instance.
 * Version: 2.1
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
	$internal = rtrim((string) getenv('LARPNET_MATRIX_INTERNAL_URL'), '/') ?: null;
	if ($internal) {
		larpnet_matrix_allow_internal_host($internal);
	}
	return [
		'secret'       => $secret,
		'server'       => $server,
		'url'          => rtrim($url, '/'),
		'internal_url' => $internal,
	];
}

/**
 * Friendica's own SSRF protection (system.block_private_addresses,
 * defaulting to true -- see src/Util/Network.php's isPrivateTarget(),
 * checked by every DI::httpClient() call) blocks ANY outbound request to a
 * private/non-public address -- which LARPNET_MATRIX_INTERNAL_URL
 * necessarily is, since it's an internal Docker-network address. Every
 * larpnet_matrix_sync_profile() call was silently hitting this wall the
 * whole time (confirmed live: "profile sync login failed" with return
 * code "0" -- a blocked request, not a real HTTP response -- once logging
 * was actually turned on to see it at all; see git history for that whole
 * investigation).
 *
 * Fixed via Friendica's own documented escape hatch,
 * system.allowed_internal_hosts, adding just this one host rather than
 * disabling the protection wholesale. Deriving the host from the env var
 * itself (not hardcoding "synapse-test" or any other deployment's
 * hostname) means this works unmodified on any deployment.
 *
 * Called from larpnet_matrix_settings() (every request that uses this
 * addon at all) rather than only larpnet_matrix_install(), which runs
 * once when the addon is first enabled and would NOT re-fire just because
 * this code shipped after the addon was already enabled -- this way it
 * self-heals on a plain redeploy. Idempotent and cheap: only ever writes
 * when the host isn't already present.
 */
function larpnet_matrix_allow_internal_host(string $internalUrl): void
{
	$host = parse_url($internalUrl, PHP_URL_HOST);
	if (!$host) {
		return;
	}

	$allowed = DI::config()->get('system', 'allowed_internal_hosts', []);
	if (in_array($host, $allowed, true)) {
		return;
	}

	$allowed[] = $host;
	DI::config()->set('system', 'allowed_internal_hosts', $allowed);
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
			'body'    => json_encode(['type' => 'org.matrix.login.jwt', 'token' => $identity['token']]),
			'headers' => ['Content-Type' => 'application/json'],
		]);
		$token = $login->isSuccess() ? (json_decode($login->getBodyString(), true)['access_token'] ?? null) : null;
		if (!$token) {
			DI::logger()->warning('larpnet_matrix: profile sync login failed', ['code' => $login->getReturnCode()]);
			return;
		}
		// Friendica's HTTPClient wraps Guzzle -- the request() option key is
		// 'headers' (plural, Guzzle's RequestOptions::HEADERS), taking an
		// ASSOCIATIVE array (['Name' => 'value'], not "Name: value" strings).
		// Every call below silently sent no headers at all until this was
		// fixed (confirmed live: login worked regardless since Synapse
		// doesn't require auth there, but every authenticated call after it
		// failed with M_MISSING_TOKEN -- Authorization was never actually
		// being sent).
		$auth = ['Authorization' => 'Bearer ' . $token];

		$current     = DI::httpClient()->request('GET', $internal . '/_matrix/client/v3/profile/' . $mxid, ['headers' => $auth]);
		$currentName = $current->isSuccess() ? (json_decode($current->getBodyString(), true)['displayname'] ?? null) : null;
		if ($currentName !== $identity['displayname']) {
			$displaynamePut = DI::httpClient()->request('PUT', $internal . '/_matrix/client/v3/profile/' . $mxid . '/displayname', [
				'body'    => json_encode(['displayname' => $identity['displayname']]),
				'headers' => [...$auth, 'Content-Type' => 'application/json'],
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
					'body'    => $data,
					'headers' => [...$auth, 'Content-Type' => $photo['type']],
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
						'body'    => json_encode(['avatar_url' => $mxcUri]),
						'headers' => [...$auth, 'Content-Type' => 'application/json'],
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
 * with type "org.matrix.login.jwt". Also includes `contacts` -- the same
 * nickname->displayname list larpnet_matrix_content() injects for the web
 * client (see larpnet_matrix_contact_list()) -- so a native client can
 * resolve names for users who've never opened chat themselves.
 */
function larpnet_matrix_post()
{
	// POST /larpnet_matrix/push -- Synapse calling our push gateway, not a
	// browser/OAuth session. Must be checked before anything below touches
	// BaseApi::getCurrentUserID(), which has no meaning for this caller.
	$argv = DI::args()->getArgv();
	if (($argv[1] ?? null) === 'push') {
		larpnet_matrix_push_notify();
	}

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

	// Same nickname->displayname fallback the web client's
	// resolveDisplayName() uses (config.contacts, larpnet_matrix_content())
	// -- a native client needs it too, for anyone who's never opened chat
	// themselves and so has no Matrix displayname yet.
	$identity['contacts'] = larpnet_matrix_contact_list((int) $uid);

	echo json_encode($identity);
	exit;
}

/**
 * The two app_id values the native clients register their pushers with
 * (see POST /_matrix/client/v3/pushers/set in each client's own repo) --
 * single source of truth for the dispatch in larpnet_matrix_push_deliver()
 * below. Kept as plain constants (not e.g. reading the client's bundle id
 * from config) since they're a cross-repo contract: the iOS/Android app_id
 * a client registers with Synapse must byte-for-byte match one of these,
 * the same way OAUTH_REDIRECT_URI has to match between larpnet-android and
 * this server.
 */
const LARPNET_MATRIX_APP_ID_ANDROID = 'pl.larpnet.android';
const LARPNET_MATRIX_APP_ID_IOS     = 'pl.larpnet.ios';

/**
 * POST /larpnet_matrix/push -- the Matrix Push Gateway API
 * (https://spec.matrix.org/latest/push-gateway-api/notify/). Synapse POSTs
 * here whenever a pusher's room gets a new event; we forward to FCM
 * (Android) or APNs (iOS) and hand back which pushkeys were permanently
 * dead so Synapse can prune those pushers. Not an OAuth/session
 * endpoint -- Synapse is the caller, authenticated only by a shared secret
 * in the URL (see larpnet_matrix_push_notify_authorized() below), which is
 * why this branches off larpnet_matrix_post() before that function's own
 * BaseApi:: checks.
 *
 * Deliberately a small custom endpoint here rather than a separately
 * deployed Sygnal instance: the Push Gateway contract is just this one
 * HTTP call in, one JSON object out, and both delivery paths (FCM, APNs)
 * already need hand-rolled signing code in this codebase anyway (see
 * larpnet_fcm's RS256 JWT and larpnet_matrix_apns_jwt()'s ES256 JWT below)
 * -- running a whole extra Python service for this would be more
 * deployment surface for no real benefit.
 *
 * Never sends real message content to Apple/Google: for an encrypted
 * room, the event's own `content` here is already opaque megolm
 * ciphertext (so even forwarding it verbatim would leak nothing), but we
 * don't even do that -- only event_id/room_id are forwarded, and the
 * receiving app fetches + decrypts that one event itself via
 * MatrixRustSDK's NotificationClient before showing anything to the user.
 */
function larpnet_matrix_push_notify(): void
{
	header('Content-Type: application/json');

	if (!larpnet_matrix_push_notify_authorized()) {
		http_response_code(401);
		echo json_encode(['error' => 'unauthorized']);
		exit;
	}

	$body         = json_decode(file_get_contents('php://input'), true);
	$notification = is_array($body) ? ($body['notification'] ?? null) : null;
	$devices      = is_array($notification) ? ($notification['devices'] ?? null) : null;
	if (!is_array($devices)) {
		http_response_code(400);
		echo json_encode(['error' => 'invalid_body']);
		exit;
	}

	$data = [
		'event_id' => $notification['event_id'] ?? '',
		'room_id'  => $notification['room_id'] ?? '',
	];

	$rejected = [];
	foreach ($devices as $device) {
		$appId   = $device['app_id'] ?? null;
		$pushkey = $device['pushkey'] ?? null;
		if (!$appId || !$pushkey) {
			continue;
		}
		if (larpnet_matrix_push_deliver((string) $appId, (string) $pushkey, $data)) {
			$rejected[] = $pushkey;
		}
	}

	echo json_encode(['rejected' => $rejected]);
	exit;
}

/**
 * A shared secret in the URL (LARPNET_MATRIX_PUSH_SECRET, same
 * env-var-per-deployment convention as the JWT secret in
 * larpnet_matrix_settings()) rather than any Matrix-level auth -- the Push
 * Gateway spec defines none, since a gateway is normally just told a
 * pushkey/app_id and trusts whichever homeserver was configured to reach
 * it. Since our gateway and homeserver are both ours, this is just
 * defense in depth against something else on the internet spamming
 * FCM/APNs sends through this endpoint, not a real trust boundary.
 * hash_equals() (not ===) to avoid a timing side-channel on the compare.
 */
function larpnet_matrix_push_notify_authorized(): bool
{
	$secret = getenv('LARPNET_MATRIX_PUSH_SECRET');
	return $secret && hash_equals($secret, (string) ($_GET['key'] ?? ''));
}

/**
 * Dispatches one device's delivery by app_id (see the two
 * LARPNET_MATRIX_APP_ID_* constants above). An app_id we don't recognise
 * is logged and treated as delivered (not rejected) -- rejecting would
 * tell Synapse to prune that pusher, which is wrong for e.g. a future
 * third platform this server build just doesn't know about yet; silently
 * dropping the send is the safer failure mode.
 *
 * @return bool true only if the delivery layer confirmed $pushkey itself
 *   is permanently dead -- see larpnet_fcm_send_data_message()'s and
 *   larpnet_matrix_apns_send()'s own doc comments for why a transient
 *   failure must never return true here.
 */
function larpnet_matrix_push_deliver(string $appId, string $pushkey, array $data): bool
{
	if ($appId === LARPNET_MATRIX_APP_ID_ANDROID) {
		// Reaches into the larpnet_fcm addon the same way
		// src/Worker/FcmPush.php and src/Model/Profile.php already reach
		// into larpnet_matrix/larpnet_fcm -- an established cross-addon
		// pattern in this codebase, not a new one.
		$fcmFile = __DIR__ . '/../larpnet_fcm/larpnet_fcm.php';
		if (!file_exists($fcmFile)) {
			DI::logger()->warning('larpnet_matrix: push notify for Android but larpnet_fcm addon is missing');
			return false;
		}
		require_once $fcmFile;
		return larpnet_fcm_send_data_message($pushkey, $data);
	}

	if ($appId === LARPNET_MATRIX_APP_ID_IOS) {
		return larpnet_matrix_apns_send($pushkey, $data);
	}

	DI::logger()->warning('larpnet_matrix: push notify for unrecognised app_id', ['app_id' => $appId]);
	return false;
}

/**
 * Sends one push to a single APNs device token via Apple's HTTP/2
 * provider API. The alert text is always the same static, generic
 * placeholder -- it exists only so `mutable-content: 1` gets this
 * delivered to the device's Notification Service Extension, which then
 * replaces the placeholder with the real decrypted sender/preview
 * (fetched+decrypted locally via MatrixRustSDK's NotificationClient)
 * before the banner is ever shown. Apple's own servers see nothing beyond
 * that placeholder, same "aps-push-type: alert" + "mutable-content"
 * pattern Element X's iOS client uses for encrypted rooms -- a pure
 * "content-available"-only background push would NOT invoke the NSE for
 * content modification and has no delivery-time guarantee, which is why
 * this isn't a silent/background push instead.
 *
 * @return bool true if APNs reported $deviceToken itself as dead
 *   (BadDeviceToken/Unregistered/DeviceTokenNotForTopic). False covers
 *   both success and a transient failure (network error, ExpiredProviderToken,
 *   TooManyRequests, ...), which must NOT be reported to Synapse as
 *   rejected -- only a genuinely dead token should prune the pusher.
 */
function larpnet_matrix_apns_send(string $deviceToken, array $data): bool
{
	$keyId    = getenv('LARPNET_MATRIX_APNS_KEY_ID');
	$teamId   = getenv('LARPNET_MATRIX_APNS_TEAM_ID');
	$keyPemB64 = getenv('LARPNET_MATRIX_APNS_KEY_PEM_B64');
	$topic    = getenv('LARPNET_MATRIX_APNS_TOPIC') ?: 'pl.larpnet.ios';
	$sandbox  = filter_var(getenv('LARPNET_MATRIX_APNS_USE_SANDBOX') ?: '', FILTER_VALIDATE_BOOLEAN);
	if (!$keyId || !$teamId || !$keyPemB64) {
		return false;
	}

	// Base64, not the raw PEM, in the env var: a .p8 key's contents are
	// multi-line, and a literal newline inside a .env file's value is not
	// reliably supported across every parser/deployment tool in this
	// project's chain (docker compose, systemd EnvironmentFile, ...) --
	// base64 sidesteps that entirely by construction, same reasoning as
	// why `LARPNET_MATRIX_APNS_KEY_PEM_B64` exists instead of a plain
	// `..._PEM` var.
	$keyPem = base64_decode($keyPemB64, true);
	if ($keyPem === false) {
		DI::logger()->warning('larpnet_matrix: LARPNET_MATRIX_APNS_KEY_PEM_B64 is not valid base64');
		return false;
	}

	$jwt = larpnet_matrix_apns_jwt((string) $keyId, (string) $teamId, $keyPem);
	if (!$jwt) {
		return false;
	}

	$payload = json_encode([
		'aps' => [
			'alert'           => [
				'title' => 'Larpnet',
				'body'  => DI::l10n()->t('New message'),
			],
			'mutable-content' => 1,
			'sound'           => 'default',
		],
		...$data,
	]);

	$host = $sandbox ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';

	$response = DI::httpClient()->request('POST', "https://$host/3/device/$deviceToken", [
		'body'    => $payload,
		'headers' => [
			'authorization'  => 'bearer ' . $jwt,
			'apns-topic'     => (string) $topic,
			'apns-push-type' => 'alert',
			'apns-priority'  => '10',
			'content-type'   => 'application/json',
		],
		// APNs' HTTP/2 provider API requires an actual HTTP/2 connection --
		// it does not speak HTTP/1.1 on this endpoint. Guzzle/curl only
		// negotiate that when explicitly told to; without this option the
		// request fails outright regardless of the payload's correctness.
		'version' => 2.0,
	]);

	if ($response->isSuccess()) {
		return false;
	}

	$result = json_decode($response->getBodyString(), true);
	$reason = $result['reason'] ?? '';

	DI::logger()->info('larpnet_matrix: apns send failed', [
		'code'   => $response->getReturnCode(),
		'reason' => $reason,
	]);

	return in_array($reason, ['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'], true);
}

/**
 * The APNs provider auth token: a short-lived ES256-signed JWT, per
 * https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns.
 * $keyPem is the .p8 key's raw (already base64-decoded) contents -- see
 * larpnet_matrix_apns_send() for where LARPNET_MATRIX_APNS_KEY_PEM_B64
 * is read and decoded. Env-var-configured like the rest of this addon's
 * LARPNET_MATRIX_* settings, rather than admin-config the way
 * larpnet_fcm's fcm_service_account_json is -- both are equally valid
 * places to put a secret in this codebase; this one just follows the
 * convention already established for everything else this addon reads.
 */
function larpnet_matrix_apns_jwt(string $keyId, string $teamId, string $keyPem): ?string
{
	$b64 = fn(string $d): string => rtrim(strtr(base64_encode($d), '+/', '-_'), '=');

	$header       = ['alg' => 'ES256', 'kid' => $keyId];
	$claims       = ['iss' => $teamId, 'iat' => time()];
	$signingInput = $b64(json_encode($header)) . '.' . $b64(json_encode($claims));

	$pkey = openssl_pkey_get_private($keyPem);
	if (!$pkey) {
		DI::logger()->warning('larpnet_matrix: failed to load APNs private key');
		return null;
	}

	$derSignature = '';
	if (!openssl_sign($signingInput, $derSignature, $pkey, OPENSSL_ALGO_SHA256)) {
		DI::logger()->warning('larpnet_matrix: failed to sign APNs auth JWT');
		return null;
	}

	// ES256 (RFC 7518 section 3.4) needs the raw, fixed-width R||S
	// concatenation (32 bytes each for P-256) -- see
	// larpnet_matrix_der_ecdsa_to_raw()'s own doc comment for why openssl's
	// DER output can't be used directly.
	$rawSignature = larpnet_matrix_der_ecdsa_to_raw($derSignature, 32);
	if ($rawSignature === null) {
		DI::logger()->warning('larpnet_matrix: failed to convert APNs signature DER to raw R||S');
		return null;
	}

	return $signingInput . '.' . $b64($rawSignature);
}

/**
 * ext-openssl's ECDSA signatures are always DER-encoded (a SEQUENCE of two
 * INTEGERs, R and S) -- there is no PHP option to get raw output directly.
 * JWS ES256 (what APNs, and every other ES256-verifying JWT consumer,
 * expects) instead requires the raw fixed-width concatenation R||S, each
 * padded/truncated to $size bytes. A DER-encoded signature is rejected
 * outright by any spec-compliant verifier, so this conversion isn't
 * optional -- it's the one non-obvious step every hand-rolled ES256 JWT
 * implementation needs and the one most likely to be silently skipped.
 *
 * Returns null on anything that doesn't parse as the expected DER shape
 * (defensive -- openssl_sign() should never actually produce something
 * else for an EC key, but a malformed/wrong-type key loaded via
 * openssl_pkey_get_private() could).
 */
function larpnet_matrix_der_ecdsa_to_raw(string $der, int $size): ?string
{
	$offset = 0;
	if (($der[$offset] ?? '') !== "\x30") {
		return null;
	}
	$offset++;

	$seqLen = ord($der[$offset] ?? "\x00");
	$offset++;
	// A length byte with the high bit set means "the low 7 bits are the
	// COUNT of following length bytes", not the length itself -- we don't
	// need the actual sequence length (readInt() below re-derives each
	// component's own length independently), just to step past however
	// many bytes encode it.
	if ($seqLen & 0x80) {
		$offset += $seqLen & 0x7F;
	}

	$readInt = function (string $der, int &$offset): ?string {
		if (($der[$offset] ?? '') !== "\x02") {
			return null;
		}
		$offset++;
		$len = ord($der[$offset] ?? "\x00");
		$offset++;
		$bytes = substr($der, $offset, $len);
		$offset += $len;

		// DER pads a leading 0x00 onto an integer whenever its first real
		// byte's high bit is set, purely so it isn't misread as a negative
		// number in two's-complement -- R/S are never actually negative,
		// so this pad byte carries no value and must be dropped before
		// re-padding to a fixed width below.
		if (strlen($bytes) > 1 && $bytes[0] === "\x00" && (ord($bytes[1]) & 0x80)) {
			$bytes = substr($bytes, 1);
		}

		return $bytes;
	};

	$r = $readInt($der, $offset);
	$s = $readInt($der, $offset);
	if ($r === null || $s === null) {
		return null;
	}

	// Left-pad with zero bytes if shorter than $size (the common case --
	// DER strips leading zero bytes from the integer itself), or take the
	// low $size bytes if somehow longer (shouldn't happen for a
	// well-formed P-256 signature, but fail safe rather than throw).
	$fit = fn(string $v): string => strlen($v) > $size ? substr($v, -$size) : str_pad($v, $size, "\x00", STR_PAD_LEFT);

	return $fit($r) . $fit($s);
}
