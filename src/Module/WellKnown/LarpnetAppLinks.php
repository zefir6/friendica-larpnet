<?php

// Copyright (C) 2010-2026, the Friendica project
// SPDX-FileCopyrightText: 2010-2026 the Friendica project
//
// SPDX-License-Identifier: AGPL-3.0-or-later

namespace Friendica\Module\WellKnown;

use Friendica\BaseModule;
use Friendica\DI;

/**
 * larpnet: tells iOS and Android that the Larpnet apps may open this site's post and
 * profile links (iOS Universal Links, Android App Links). Without these files a link to
 * larpnet.pl always opens the browser, even with the app installed.
 *
 * - /.well-known/apple-app-site-association (no extension, application/json)
 * - /.well-known/assetlinks.json
 *
 * Only the paths the apps route natively (larpnet-ios / larpnet-android LinkRouter):
 * never /oauth/, or the apps' own login flow would be handed back to the app.
 *
 * Android checks the signing certificate. Builds from GitHub Releases are signed with our
 * release key (below). Builds from Google Play are re-signed with Google's app signing
 * key, shown in Play Console under Test and release > App integrity > App signing; add it
 * with `bin/console config larpnet android_cert_sha256 "AA:BB:..."` (comma-separate
 * several).
 */
class LarpnetAppLinks extends BaseModule
{
	public const PATHS = ['/display/*', '/profile/*', '/item/*', '/objects/*'];

	private const IOS_APP_ID      = 'ZR99PJ76A8.pl.larpnet.ios';
	private const ANDROID_PACKAGE = 'pl.larpnet.android';

	/** SHA-256 of the release key ("CN=Larpnet Android") GitHub Releases APKs are signed with. */
	private const ANDROID_RELEASE_CERT = '5F:5B:C7:5F:68:D6:AD:23:A7:D1:F1:28:07:BB:9D:AF:F9:D6:60:D1:96:DC:71:5E:82:37:5D:6A:DC:F5:32:CE';

	protected function rawContent(array $request = []): never
	{
		if (($this->parameters['file'] ?? '') === 'assetlinks.json') {
			$body = [[
				'relation' => ['delegate_permission/common.handle_all_urls'],
				'target'   => [
					'namespace'                => 'android_app',
					'package_name'             => self::ANDROID_PACKAGE,
					'sha256_cert_fingerprints' => self::androidFingerprints(),
				],
			]];
		} else {
			$body = [
				'applinks' => [
					'details' => [[
						'appIDs'     => [self::IOS_APP_ID],
						'components' => array_map(fn (string $path): array => ['/' => $path], self::PATHS),
					]],
				],
			];
		}

		header('Content-Type: application/json');
		header('Cache-Control: public, max-age=3600');
		echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
		exit;
	}

	/** @return string[] */
	private static function androidFingerprints(): array
	{
		$extra = array_map(trim(...), explode(',', (string) DI::config()->get('larpnet', 'android_cert_sha256', '')));
		$all   = array_merge([self::ANDROID_RELEASE_CERT], $extra);
		$all   = array_map(strtoupper(...), array_filter($all, fn (string $fp): bool => preg_match('/^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/', $fp) === 1));
		return array_values(array_unique($all));
	}
}
