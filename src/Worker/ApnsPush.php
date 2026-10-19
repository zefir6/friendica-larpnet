<?php

// Copyright (C) 2010-2024, the Friendica project
// SPDX-FileCopyrightText: 2010-2024 the Friendica project
//
// SPDX-License-Identifier: AGPL-3.0-or-later

namespace Friendica\Worker;

use Friendica\Database\DBA;
use Friendica\DI;

/**
 * Sends a push notification to a user's registered APNs (native iOS) device
 * tokens. Title/body/click-url are pre-extracted by the larpnet_apns addon's
 * `push_notification`/`push_notification_mail` hook handlers, so this
 * worker only has to look up tokens and send/prune them -- the actual APNs
 * calls live in addon/larpnet_apns/larpnet_apns.php since they're not
 * reachable via the `Friendica\Worker` namespace that Core\Worker::execute()
 * hardcodes for worker classes. Exact mirror of FcmPush for Android.
 */
class ApnsPush
{
	/**
	 * $key identifies the notification ("social:<nid>", "mail:<id>") so a
	 * repeat replaces it on the device -- optional because jobs queued
	 * before it existed don't carry it.
	 */
	public static function execute(int $uid, string $title, string $body, string $click, string $key = '')
	{
		$tokens = DBA::selectToArray('apns-token', ['token'], ['uid' => $uid]);
		if (empty($tokens)) {
			return;
		}
		$tokens = array_column($tokens, 'token');

		require_once __DIR__ . '/../../addon/larpnet_apns/larpnet_apns.php';
		if (!function_exists('larpnet_apns_send_to_tokens')) {
			DI::logger()->warning('ApnsPush: larpnet_apns addon not available');
			return;
		}

		$dead = larpnet_apns_send_to_tokens($tokens, $title, $body, $click, $key);
		if (!empty($dead)) {
			DBA::delete('apns-token', ['token' => $dead]);
			DI::logger()->info('ApnsPush: pruned dead tokens', ['count' => count($dead)]);
		}
	}
}
