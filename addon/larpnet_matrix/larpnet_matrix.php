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
 * Version: 1.0
 * Author: larpnet admin
 */

use Friendica\Core\Hook;
use Friendica\DI;
use Friendica\Model\Contact;
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
 */
function larpnet_matrix_settings(): ?array
{
	$secret = getenv('LARPNET_MATRIX_JWT_SECRET');
	$server = getenv('LARPNET_MATRIX_SERVER_NAME');
	$url    = getenv('LARPNET_MATRIX_HOMESERVER_URL');
	if (!$secret || !$server || !$url) {
		return null;
	}
	return ['secret' => $secret, 'server' => $server, 'url' => rtrim($url, '/')];
}

/**
 * Matrix identity + a fresh login JWT for a local user, or null if the
 * nickname isn't a valid Matrix localpart. Localpart = lower-cased nickname,
 * so it maps 1:1 and stays stable.
 */
function larpnet_matrix_identity(int $uid, array $settings): ?array
{
	$user = User::getById($uid, ['nickname']);
	$sub  = strtolower($user['nickname'] ?? '');
	if (!preg_match('/^[a-z0-9._=\-\/+]+$/', $sub)) {
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
 * GET /larpnet_matrix — the chat widget for a logged-in web user. The JWT goes
 * in the URL fragment (never sent to a server or logged) of the chat host's
 * sso.html, which logs in and opens Element.
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

	$src = $identity['homeserver'] . '/sso.html#jwt=' . $identity['token'];
	return '<iframe src="' . htmlspecialchars($src) . '" title="Chat" allow="clipboard-write; microphone; camera" '
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

	echo json_encode($identity);
	exit;
}
