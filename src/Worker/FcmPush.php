<?php

// Copyright (C) 2010-2024, the Friendica project
// SPDX-FileCopyrightText: 2010-2024 the Friendica project
//
// SPDX-License-Identifier: AGPL-3.0-or-later

namespace Friendica\Worker;

use Friendica\Database\DBA;
use Friendica\DI;

/**
 * Sends a push notification to a user's registered Firebase Cloud Messaging
 * (native Android) device tokens. Title/body/click-url are pre-extracted by
 * the larpnet_fcm addon's `push_notification`/`push_notification_mail` hook
 * handlers, so this worker only has to look up tokens and send/prune them —
 * the actual FCM API calls live in addon/larpnet_fcm/larpnet_fcm.php since
 * they're not reachable via the `Friendica\Worker` namespace that
 * Core\Worker::execute() hardcodes for worker classes.
 */
class FcmPush
{
	public static function execute(int $uid, string $title, string $body, string $click, ?string $icon = null)
	{
		$tokens = DBA::selectToArray('fcm-token', ['token'], ['uid' => $uid]);
		if (empty($tokens)) {
			return;
		}
		$tokens = array_column($tokens, 'token');

		require_once __DIR__ . '/../../addon/larpnet_fcm/larpnet_fcm.php';
		if (!function_exists('larpnet_fcm_send_to_tokens')) {
			DI::logger()->warning('FcmPush: larpnet_fcm addon not available');
			return;
		}

		$dead = larpnet_fcm_send_to_tokens($tokens, $title, $body, $click, $icon);
		if (!empty($dead)) {
			DBA::delete('fcm-token', ['token' => $dead]);
			DI::logger()->info('FcmPush: pruned dead tokens', ['count' => count($dead)]);
		}
	}
}
