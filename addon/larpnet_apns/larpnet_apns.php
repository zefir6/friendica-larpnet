<?php
/**
 * Name: LARPnet APNs Push
 * Description: Apple Push Notification service push for the native LARPnet
 *   iOS app's classic Friendica notifications (likes, comments, follows,
 *   mentions, direct messages) -- the iOS counterpart of larpnet_fcm for
 *   Android. Stores one APNs device token per app install (an
 *   OAuth2-authenticated app registers/unregisters its token at
 *   POST /larpnet_apns) and pushes to all of a user's devices whenever a
 *   notification or direct message is created.
 *
 *   Deliberately separate from larpnet_matrix's own push gateway, which is
 *   for Matrix chat messages specifically and must never carry plaintext
 *   message content (see that addon's own CLAUDE.md). Classic Friendica
 *   notifications have no such constraint -- sending the real title/body to
 *   Apple here is exactly what larpnet_fcm_send_to_tokens() already does
 *   for Android. Both addons send through the same Apple Developer
 *   account/app though, so the actual JWT-signing/HTTP-to-Apple primitive
 *   lives once in larpnet_matrix (larpnet_matrix_apns_deliver()) and is
 *   reused here via a cross-addon require_once, the same way larpnet_matrix
 *   itself already reaches into larpnet_fcm_send_data_message() for
 *   Android's half of its own push gateway.
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

function larpnet_apns_install()
{
	Hook::register('dbstructure_definition', __FILE__, 'larpnet_apns_dbstructure_definition');
	Hook::register('push_notification',      __FILE__, 'larpnet_apns_push_notification');
	Hook::register('push_notification_mail', __FILE__, 'larpnet_apns_push_notification_mail');
	DI::logger()->info('installed addon larpnet_apns');
}

function larpnet_apns_module() {}

/**
 * Declares the apns-token table. Picked up next time an admin visits /admin
 * (Module\Admin\Summary triggers a schema diff on every dashboard view) or via
 * `bin/console dbstructure update` -- no core dbstructure.config.php patch needed.
 * Mirrors larpnet_fcm's fcm-token table exactly, one row per device/app-install.
 */
function larpnet_apns_dbstructure_definition(array &$data)
{
	$data['apns-token'] = [
		'comment' => 'APNs device tokens for native iOS push (classic notifications), one row per device/app-install',
		'fields'  => [
			'id'             => ['type' => 'int unsigned', 'not null' => '1', 'extra' => 'auto_increment', 'primary' => '1', 'comment' => ''],
			'uid'            => ['type' => 'mediumint unsigned', 'not null' => '1', 'foreign' => ['user' => 'uid'], 'comment' => 'Owner User id'],
			'application-id' => ['type' => 'int unsigned', 'foreign' => ['application' => 'id'], 'comment' => 'OAuth application that registered this token'],
			'token'          => ['type' => 'varchar(512)', 'not null' => '1', 'comment' => 'APNs device token, hex-encoded'],
			'updated'        => ['type' => 'datetime', 'not null' => '1', 'default' => DBA::NULL_DATETIME, 'comment' => 'Last (re-)registration time. Note: DBA::replace() on the token-unique key is a delete+reinsert, so this is not a first-registration timestamp'],
		],
		'indexes' => [
			'PRIMARY'         => ['id'],
			'token'           => ['UNIQUE', 'token(190)'],
			'uid'             => ['uid'],
			// Must stay declared: 'application-id' has a 'foreign' key above, and
			// MySQL/MariaDB refuses to drop an index still backing a foreign key
			// constraint (error 1553) -- see larpnet_fcm's identical comment on
			// its own fcm-token table for the full story.
			'application-id' => ['application-id'],
		],
	];
}

/**
 * Fired unconditionally from Subscription::pushByNotification(), mirroring
 * larpnet_fcm_push_notification() exactly (same event, same notification
 * data shape) -- just dispatching to APNs devices instead of FCM ones.
 */
function larpnet_apns_push_notification(array &$data)
{
	$uid = (int) ($data['uid'] ?? 0);
	$nid = (int) ($data['nid'] ?? 0);
	if (empty($uid) || empty($nid)) {
		return;
	}

	if (!DBA::exists('apns-token', ['uid' => $uid])) {
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
		'ApnsPush',
		$uid,
		$title ?: DI::l10n()->t('Notification'),
		$body ?: $title,
		(string) DI::baseUrl() . '/notification'
	);
}

/**
 * Fired unconditionally from Mail::insert(), mirroring
 * larpnet_fcm_push_notification_mail() exactly.
 */
function larpnet_apns_push_notification_mail(array &$data)
{
	$uid    = (int) ($data['uid'] ?? 0);
	$mailId = (int) ($data['mail_id'] ?? 0);
	if (empty($uid) || empty($mailId)) {
		return;
	}

	if (!DBA::exists('apns-token', ['uid' => $uid])) {
		return;
	}

	$mail = DBA::selectFirst('mail', ['from-name', 'body'], ['id' => $mailId, 'uid' => $uid]);
	if (!DBA::isResult($mail)) {
		return;
	}

	$body = BBCode::toPlaintext($mail['body'], false);
	$body = Plaintext::shorten($body, 160, $uid);

	Worker::add(
		Worker::PRIORITY_HIGH,
		'ApnsPush',
		$uid,
		DI::l10n()->t('New message from %s', $mail['from-name']),
		$body,
		(string) DI::baseUrl() . '/message/' . $mailId
	);
}

/**
 * POST /larpnet_apns -- registers or unregisters an APNs device token for
 * the OAuth-authenticated current user. Requires the `push` OAuth scope,
 * same as core's /api/v1/push/subscription and larpnet_fcm's own endpoint.
 *
 * Body, either application/x-www-form-urlencoded or application/json:
 *   token       (required) the APNs device token, hex-encoded
 *   unregister  (optional) any truthy value deletes the token instead of storing it
 */
function larpnet_apns_post()
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

	// Same fallback as larpnet_fcm_post(): LegacyModule::runModuleFunction()
	// calls this with no arguments, so $_POST only ever gets populated for
	// form-encoded/multipart bodies -- fall back to a raw JSON body for
	// clients (most iOS HTTP clients default to application/json) that
	// don't send form-encoded requests.
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
		DBA::delete('apns-token', ['uid' => $uid, 'token' => $token]);
		echo json_encode(['unregistered' => true]);
		exit;
	}

	DBA::replace('apns-token', [
		'uid'            => $uid,
		'application-id' => $application['id'] ?? null,
		'token'          => $token,
		'updated'        => DateTimeFormat::utcNow(),
	]);

	echo json_encode(['registered' => true]);
	exit;
}

/**
 * Sends a real title/body alert to each token via
 * larpnet_matrix_apns_deliver() (one HTTP/2 request per token, same as
 * larpnet_fcm_send_to_tokens()'s one-request-per-token FCM loop) -- unlike
 * larpnet_matrix's own push gateway, there's no content restriction here,
 * so the real notification text goes straight to Apple, same as
 * larpnet_fcm_send_to_tokens() already does for Android. No
 * 'mutable-content'/NSE involvement either: there's nothing to decrypt, the
 * alert shown is already the final one.
 *
 * $click is carried as a plain custom payload field (not under 'aps'), for
 * a future notification-tap deep link -- unused today, matching this
 * session's current parity with Android (PushNotifications.kt also just
 * opens the app generically on tap, no per-type routing yet either).
 *
 * @return string[] tokens APNs reported as dead -- caller should delete these rows
 */
function larpnet_apns_send_to_tokens(array $tokens, string $title, string $body, string $click): array
{
	require_once __DIR__ . '/../larpnet_matrix/larpnet_matrix.php';
	if (!function_exists('larpnet_matrix_apns_deliver')) {
		DI::logger()->warning('larpnet_apns: larpnet_matrix addon not available for APNs delivery');
		return [];
	}

	$dead = [];
	foreach ($tokens as $token) {
		$isDead = larpnet_matrix_apns_deliver($token, [
			'aps' => [
				'alert' => [
					'title' => $title,
					'body'  => $body,
				],
				'sound' => 'default',
			],
			'click' => $click,
		]);
		if ($isDead) {
			$dead[] = $token;
		}
	}

	return $dead;
}
