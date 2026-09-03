<?php
/**
 * Name: LARPnet FCM Push
 * Description: Firebase Cloud Messaging push notifications for the native LARPnet
 *   Android app, running alongside the ntfy-based Web Push integration. Stores one
 *   FCM registration token per device (an OAuth2-authenticated app registers/
 *   unregisters its token at POST /larpnet_fcm) and pushes to all of a user's
 *   devices whenever a notification or direct message is created.
 * Version: 1.0
 * Author: larpnet admin
 */

use Friendica\Core\Hook;
use Friendica\Core\Worker;
use Friendica\Content\Text\BBCode;
use Friendica\Content\Text\Plaintext;
use Friendica\Database\DBA;
use Friendica\DI;
use Friendica\Model\Contact;
use Friendica\Model\Post;
use Friendica\Module\BaseApi;
use Friendica\Network\HTTPException\NotFoundException;
use Friendica\Util\DateTimeFormat;

function larpnet_fcm_install()
{
	Hook::register('dbstructure_definition',  __FILE__, 'larpnet_fcm_dbstructure_definition');
	Hook::register('push_notification',       __FILE__, 'larpnet_fcm_push_notification');
	Hook::register('push_notification_mail',  __FILE__, 'larpnet_fcm_push_notification_mail');
	DI::logger()->info('installed addon larpnet_fcm');
}

function larpnet_fcm_module() {}

/**
 * Declares the fcm-token table. Picked up next time an admin visits /admin
 * (Module\Admin\Summary triggers a schema diff on every dashboard view) or via
 * `bin/console dbstructure update` — no core dbstructure.config.php patch needed.
 */
function larpnet_fcm_dbstructure_definition(array &$data)
{
	$data['fcm-token'] = [
		'comment' => 'FCM registration tokens for native Android push, one row per device/app-install',
		'fields'  => [
			'id'             => ['type' => 'int unsigned', 'not null' => '1', 'extra' => 'auto_increment', 'primary' => '1', 'comment' => ''],
			'uid'            => ['type' => 'mediumint unsigned', 'not null' => '1', 'foreign' => ['user' => 'uid'], 'comment' => 'Owner User id'],
			'application-id' => ['type' => 'int unsigned', 'foreign' => ['application' => 'id'], 'comment' => 'OAuth application that registered this token'],
			'token'          => ['type' => 'varchar(512)', 'not null' => '1', 'comment' => 'FCM registration token'],
			'updated'        => ['type' => 'datetime', 'not null' => '1', 'default' => DBA::NULL_DATETIME, 'comment' => 'Last (re-)registration time. Note: DBA::replace() on the token-unique key is a delete+reinsert, so this is not a first-registration timestamp'],
		],
		'indexes' => [
			'PRIMARY' => ['id'],
			'token'   => ['UNIQUE', 'token(190)'],
			'uid'     => ['uid'],
		],
	];
}

/**
 * Fired unconditionally from Subscription::pushByNotification(), mirroring the
 * always-on NtfyPush dispatch right above it in that method.
 */
function larpnet_fcm_push_notification(array &$data)
{
	$uid = (int) ($data['uid'] ?? 0);
	$nid = (int) ($data['nid'] ?? 0);
	if (empty($uid) || empty($nid)) {
		return;
	}

	if (!DBA::exists('fcm-token', ['uid' => $uid])) {
		return;
	}

	try {
		$notification = DI::notification()->selectOneById($nid);
	} catch (NotFoundException $e) {
		return;
	}

	$actor = [];
	if ($notification->actorId) {
		$actor = Contact::getById($notification->actorId);
	}

	$body = '';
	if ($notification->targetUriId) {
		$post = Post::selectFirst([], ['uri-id' => $notification->targetUriId, 'uid' => [0, $uid]]);
		if (!empty($post['body'])) {
			$body = BBCode::toPlaintext($post['body'], false);
			$body = Plaintext::shorten($body, 160, $uid);
		}
	}

	$message = DI::notificationFactory()->getMessageFromNotification($notification);
	$title   = $message['plain'] ?? '';

	Worker::add(
		Worker::PRIORITY_HIGH,
		'FcmPush',
		$uid,
		$title ?: DI::l10n()->t('Notification'),
		$body ?: $title,
		(string) DI::baseUrl() . '/notification',
		$actor['thumb'] ?? null
	);
}

/**
 * Fired unconditionally from Mail::insert(), mirroring NtfyPushMail's dispatch.
 */
function larpnet_fcm_push_notification_mail(array &$data)
{
	$uid    = (int) ($data['uid'] ?? 0);
	$mailId = (int) ($data['mail_id'] ?? 0);
	if (empty($uid) || empty($mailId)) {
		return;
	}

	if (!DBA::exists('fcm-token', ['uid' => $uid])) {
		return;
	}

	$mail = DBA::selectFirst('mail', ['from-name', 'body', 'contact-id'], ['id' => $mailId, 'uid' => $uid]);
	if (!DBA::isResult($mail)) {
		return;
	}

	$body = BBCode::toPlaintext($mail['body'], false);
	$body = Plaintext::shorten($body, 160, $uid);

	$icon = null;
	if (!empty($mail['contact-id'])) {
		$contact = Contact::getById($mail['contact-id']);
		$icon    = $contact['thumb'] ?? null;
	}

	Worker::add(
		Worker::PRIORITY_HIGH,
		'FcmPush',
		$uid,
		DI::l10n()->t('New message from %s', $mail['from-name']),
		$body,
		(string) DI::baseUrl() . '/message/' . $mailId,
		$icon
	);
}

/**
 * POST /larpnet_fcm — registers or unregisters an FCM device token for the
 * OAuth-authenticated current user. Requires the `push` OAuth scope, same as
 * core's /api/v1/push/subscription.
 *
 * Body, either application/x-www-form-urlencoded or application/json:
 *   token       (required) the FCM registration token
 *   unregister  (optional) any truthy value deletes the token instead of storing it
 */
function larpnet_fcm_post()
{
	header('Content-Type: application/json');

	$application = BaseApi::getCurrentApplication();
	if (empty($application) || empty($application['push'])) {
		http_response_code(403);
		echo json_encode(['error' => 'insufficient_scope']);
		exit;
	}

	$uid = BaseApi::getCurrentUserID();
	if (empty($uid)) {
		http_response_code(401);
		echo json_encode(['error' => 'unauthorized']);
		exit;
	}

	// LegacyModule::runModuleFunction() calls this with no arguments, so $_POST is
	// the only thing populated by PHP itself — and only for form-encoded/multipart
	// bodies. Fall back to parsing a raw JSON body for clients (e.g. most Android
	// HTTP clients) that default to application/json.
	$params = $_POST;
	if (empty($params)) {
		$decoded = json_decode(file_get_contents('php://input'), true);
		if (is_array($decoded)) {
			$params = $decoded;
		}
	}

	$token = trim($params['token'] ?? '');
	if ($token === '') {
		http_response_code(422);
		echo json_encode(['error' => 'missing token']);
		exit;
	}

	if (!empty($params['unregister'])) {
		DBA::delete('fcm-token', ['uid' => $uid, 'token' => $token]);
		echo json_encode(['unregistered' => true]);
		exit;
	}

	DBA::replace('fcm-token', [
		'uid'            => $uid,
		'application-id' => $application['id'] ?? null,
		'token'          => $token,
		'updated'        => DateTimeFormat::utcNow(),
	]);

	echo json_encode(['registered' => true]);
	exit;
}

/**
 * Sends a data+notification message to each token via FCM's HTTP v1 API
 * (one request per token — v1 has no multicast endpoint), authenticated with
 * a hand-rolled Google OAuth2 service-account exchange (RS256-signed JWT via
 * openssl_sign(), no SDK dependency).
 *
 * @return string[] tokens FCM reported as unregistered/invalid — caller should delete these rows
 */
function larpnet_fcm_send_to_tokens(array $tokens, string $title, string $body, string $click, ?string $icon = null): array
{
	$account = larpnet_fcm_get_service_account();
	if (empty($account['project_id'])) {
		return [];
	}

	$accessToken = larpnet_fcm_get_access_token($account);
	if (empty($accessToken)) {
		return [];
	}

	$url     = 'https://fcm.googleapis.com/v1/projects/' . $account['project_id'] . '/messages:send';
	$headers = [
		'Authorization' => 'Bearer ' . $accessToken,
		'Content-Type'  => 'application/json',
	];

	$dead = [];
	foreach ($tokens as $token) {
		$payload = [
			'message' => [
				'token'        => $token,
				'notification' => [
					'title' => $title,
					'body'  => $body,
				],
				'data' => array_filter([
					'click' => $click,
					'icon'  => $icon,
				]),
			],
		];

		$response = DI::httpClient()->post($url, json_encode($payload), $headers);

		if ($response->isSuccess()) {
			continue;
		}

		$result = json_decode($response->getBodyString(), true);
		$status = $result['error']['status'] ?? '';

		DI::logger()->info('larpnet_fcm: send failed', [
			'code'   => $response->getReturnCode(),
			'status' => $status,
		]);

		if (in_array($status, ['NOT_FOUND', 'UNREGISTERED', 'INVALID_ARGUMENT'], true)) {
			$dead[] = $token;
		}
	}

	return $dead;
}

function larpnet_fcm_get_service_account(): ?array
{
	$json = DI::config()->get('larpnet_notifications', 'fcm_service_account_json');
	if (empty($json)) {
		return null;
	}

	$account = json_decode($json, true);
	if (empty($account['client_email']) || empty($account['private_key']) || empty($account['project_id'])) {
		DI::logger()->warning('larpnet_fcm: fcm_service_account_json is missing required fields');
		return null;
	}

	return $account;
}

function larpnet_fcm_get_access_token(array $account): ?string
{
	$now    = time();
	$header = ['alg' => 'RS256', 'typ' => 'JWT'];
	$claims = [
		'iss'   => $account['client_email'],
		'scope' => 'https://www.googleapis.com/auth/firebase.messaging',
		'aud'   => 'https://oauth2.googleapis.com/token',
		'iat'   => $now,
		'exp'   => $now + 3600,
	];

	$signingInput = larpnet_fcm_base64url(json_encode($header)) . '.' . larpnet_fcm_base64url(json_encode($claims));

	$signature = '';
	if (!openssl_sign($signingInput, $signature, $account['private_key'], OPENSSL_ALGO_SHA256)) {
		DI::logger()->warning('larpnet_fcm: failed to RS256-sign the auth JWT');
		return null;
	}

	$jwt = $signingInput . '.' . larpnet_fcm_base64url($signature);

	$response = DI::httpClient()->post('https://oauth2.googleapis.com/token', [
		'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
		'assertion'  => $jwt,
	]);

	if (!$response->isSuccess()) {
		DI::logger()->warning('larpnet_fcm: OAuth2 token exchange failed', ['code' => $response->getReturnCode()]);
		return null;
	}

	$data = json_decode($response->getBodyString(), true);
	return $data['access_token'] ?? null;
}

function larpnet_fcm_base64url(string $data): string
{
	return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}
