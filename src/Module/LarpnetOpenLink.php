<?php

// Copyright (C) 2010-2026, the Friendica project
// SPDX-FileCopyrightText: 2010-2026 the Friendica project
//
// SPDX-License-Identifier: AGPL-3.0-or-later

namespace Friendica\Module;

use Friendica\BaseModule;
use Friendica\DI;

/**
 * larpnet: the browser's handler for fediverse links, registered from Settings > Display
 * (js/protocol-handler.js, navigator.registerProtocolHandler). The browser calls
 * /open-link?target=<link> with:
 *
 * - web+mastodon://follow?uri=<handle or URL>: the follow page
 * - web+mastodon://share?text=...&url=...: a new post with that text
 * - web+ap://<host>/<path> (FEP-07d7): https://<host>/<path>, opened through search,
 *   which fetches the post or profile and redirects to its local page
 *
 * The native apps handle the same links themselves (larpnet-ios / larpnet-android
 * LinkRouter).
 */
class LarpnetOpenLink extends BaseModule
{
	protected function rawContent(array $request = [])
	{
		DI::baseUrl()->redirect(self::destination((string) ($request['target'] ?? '')));
	}

	/** The local page (relative to the base URL) for a web+mastodon:// or web+ap:// link. */
	public static function destination(string $target): string
	{
		$target = trim($target);
		$scheme = strtolower((string) parse_url($target, PHP_URL_SCHEME));

		if ($scheme === 'web+mastodon') {
			$action = strtolower((string) parse_url($target, PHP_URL_HOST));
			parse_str((string) parse_url($target, PHP_URL_QUERY), $params);
			if ($action === 'follow' && is_string($params['uri'] ?? null) && $params['uri'] !== '') {
				return 'contact/follow?url=' . urlencode(ltrim((string) preg_replace('/^acct:/', '', $params['uri']), '@'));
			}
			if ($action === 'share') {
				$text = trim(implode(' ', array_filter([$params['text'] ?? '', $params['url'] ?? ''], is_string(...))));
				return 'compose?body=' . urlencode($text);
			}
			return '';
		}

		if ($scheme === 'web+ap') {
			return 'search?q=' . urlencode('https://' . substr($target, strlen('web+ap://')));
		}

		return '';
	}
}
