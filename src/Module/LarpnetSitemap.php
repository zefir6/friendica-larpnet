<?php

// Copyright (C) 2010-2026, the Friendica project
// SPDX-FileCopyrightText: 2010-2026 the Friendica project
//
// SPDX-License-Identifier: AGPL-3.0-or-later

namespace Friendica\Module;

use Friendica\BaseModule;
use Friendica\Core\Cache\Enum\Duration;
use Friendica\Database\DBA;
use Friendica\DI;
use Friendica\Model\Item;
use Friendica\Model\Post;
use Friendica\Util\DateTimeFormat;
use Friendica\Util\LarpnetSeo;

/**
 * larpnet: /sitemap.xml -- the public, indexable part of the site: the front
 * and community pages, profiles whose owner allows search engines
 * ("Allow your profile to be searchable globally?" = profile.net-publish),
 * and those users' public top-level posts. Mirrors what the pages themselves
 * allow (see the noindex rules in Item\Display and Profile\Profile), so the
 * sitemap never lists a URL that answers with noindex.
 */
class LarpnetSitemap extends BaseModule
{
	/** Sitemap protocol limit is 50,000 URLs per file. */
	private const MAX_POSTS = 45000;
	private const CACHE_KEY = 'larpnet:sitemap.xml';

	protected function rawContent(array $request = [])
	{
		if (DI::config()->get('system', 'block_public')) {
			throw new \Friendica\Network\HTTPException\NotFoundException();
		}

		$xml = DI::cache()->get(self::CACHE_KEY);
		if (!is_string($xml) || $xml === '') {
			$xml = $this->build();
			DI::cache()->set(self::CACHE_KEY, $xml, Duration::HOUR);
		}

		$this->response->setHeader('public, max-age=3600', 'Cache-Control');
		$this->earlyHttpExit($xml, Response::TYPE_XML, 'application/xml; charset=utf-8');
	}

	private function build(): string
	{
		$base = (string) DI::baseUrl();
		$urls = [
			['loc' => $base . '/'],
			['loc' => $base . '/community'],
		];

		$visibleUser = "NOT `user`.`hidewall` AND NOT `user`.`blocked` AND NOT `user`.`account_removed`"
			. " AND NOT `user`.`account_expired` AND `user`.`verified` AND `user`.`uid` > 0";

		$profiles = DBA::p(
			"SELECT `user`.`nickname`, `user`.`uid` FROM `user`
			INNER JOIN `profile` ON `profile`.`uid` = `user`.`uid`
			WHERE `profile`.`net-publish` AND " . $visibleUser . "
			ORDER BY `user`.`uid`",
		);
		$indexableUids = [];
		while ($profile = DBA::fetch($profiles)) {
			$indexableUids[] = (int) $profile['uid'];
			$urls[]          = ['loc' => $base . '/profile/' . rawurlencode($profile['nickname'])];
		}
		DBA::close($profiles);

		if ($indexableUids) {
			$privacy = LarpnetSeo::indexServerOnlyPosts() ? [Item::PUBLIC, Item::SERVER_ONLY] : [Item::PUBLIC];

			$condition = [
				"`wall` AND `origin` AND NOT `deleted` AND `gravity` = ? AND `private` IN (" . implode(',', array_fill(0, count($privacy), '?')) . ")"
				. " AND `uid` IN (" . implode(',', array_fill(0, count($indexableUids), '?')) . ")"
				. " AND NOT `author-blocked` AND NOT `owner-blocked`"
				. " AND NOT EXISTS (SELECT `id` FROM `contact` WHERE `contact`.`id` IN (`post-thread-origin-view`.`author-id`, `post-thread-origin-view`.`owner-id`) AND `contact`.`unsearchable`)",
				Item::GRAVITY_PARENT, ...$privacy, ...$indexableUids,
			];
			$posts = Post::selectOriginThread(['guid', 'created', 'edited', 'commented'], $condition, [
				'order' => ['created' => true],
				'limit' => self::MAX_POSTS,
			]);
			while ($post = Post::fetch($posts)) {
				$lastmod = max((string) $post['edited'], (string) $post['commented'], (string) $post['created']);
				$urls[]  = [
					'loc'     => $base . '/display/' . rawurlencode($post['guid']),
					'lastmod' => DateTimeFormat::utc($lastmod, DateTimeFormat::ATOM),
				];
			}
			DBA::close($posts);
		}

		$xml = '<?xml version="1.0" encoding="UTF-8"?>' . "\n"
			. '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' . "\n";
		foreach ($urls as $url) {
			$xml .= '<url><loc>' . htmlspecialchars($url['loc'], ENT_XML1 | ENT_QUOTES, 'UTF-8') . '</loc>';
			if (!empty($url['lastmod'])) {
				$xml .= '<lastmod>' . $url['lastmod'] . '</lastmod>';
			}
			$xml .= "</url>\n";
		}
		return $xml . "</urlset>\n";
	}
}
