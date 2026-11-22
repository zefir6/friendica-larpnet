<?php

// Copyright (C) 2010-2026, the Friendica project
// SPDX-FileCopyrightText: 2010-2026 the Friendica project
//
// SPDX-License-Identifier: AGPL-3.0-or-later

namespace Friendica\Module;

use Friendica\BaseModule;
use Friendica\Core\System;
use Friendica\DI;

/**
 * Return the default robots.txt
 */
class RobotsTxt extends BaseModule
{
	protected function rawContent(array $request = [])
	{
		// larpnet: also keep crawlers out of the pages that answer anonymous
		// visitors with a login form or permission error (HTTP 200 all the
		// same -- see LarpnetSeo::NOINDEX_MODULES), and let them fetch
		// /photo and /avatar so post images and avatars used in link
		// previews / structured data are reachable.
		$allDisallowed = [
			'/settings/',
			'/admin/',
			'/message',
			'/search',
			'/help',
			'/proxy',
			'/login',
			'/register',
			'/lostpass',
			'/network',
			'/compose',
			'/contact',
			'/channel',
			'/notifications',
			'/notes',
			'/circle',
			'/calendar',
			'/events',
			'/delegation',
			'/larpnet_matrix',
			'/item/',
			'/post/',
			'/ping',
			'/oauth/',
			'/api/',
			'/bookmarklet',
			'/filer',
			'/follow',
			'/unfollow',
			'/magic',
			'/probe',
			'/ostatus_subscribe',
			'/removeme',
		];

		header('Content-Type: text/plain');
		echo 'User-agent: *' . PHP_EOL;
		foreach ($allDisallowed as $disallowed) {
			echo 'Disallow: ' . $disallowed . PHP_EOL;
		}

		echo PHP_EOL;
		echo 'User-agent: ChatGPT-User' . PHP_EOL;
		echo 'Disallow: /' . PHP_EOL;

		echo PHP_EOL;
		echo 'User-agent: Google-Extended' . PHP_EOL;
		echo 'Disallow: /' . PHP_EOL;

		echo PHP_EOL;
		echo 'User-agent: GPTBot' . PHP_EOL;
		echo 'Disallow: /' . PHP_EOL;

		echo PHP_EOL;
		echo 'Sitemap: ' . DI::baseUrl() . '/sitemap.xml' . PHP_EOL;

		System::exit();
	}
}
