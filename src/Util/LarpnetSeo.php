<?php

// Copyright (C) 2010-2026, the Friendica project
// SPDX-FileCopyrightText: 2010-2026 the Friendica project
//
// SPDX-License-Identifier: AGPL-3.0-or-later

namespace Friendica\Util;

use Friendica\Content\Text\BBCode;
use Friendica\DI;

/**
 * larpnet: search-engine / link-preview helpers shared by the patched
 * Display (posts), Profile and App\Page (site-wide defaults) modules and the
 * Sitemap module. Everything here only builds strings; the callers decide
 * what applies to which page.
 */
final class LarpnetSeo
{
	public const SITE_NAME           = 'Larpnet';
	public const LOCALE              = 'pl_PL';
	public const HOME_TITLE          = 'Larpnet – polska sieć społecznościowa dla larpowców';
	public const DEFAULT_DESCRIPTION = 'Polska sieć społecznościowa dla larpowców, oparta na Friendice i Fediversie. Twoje posty. Twoje zasady. Brak algorytmów.';
	public const DEFAULT_IMAGE       = 'view/theme/larpnet/img/og-image.png';


	/**
	 * Modules that answer anonymous visitors with a login form, a permission
	 * error or nothing worth finding (HTTP 200 all the same), so they are
	 * marked noindex. Kept in sync with RobotsTxt's disallow list.
	 */
	public const NOINDEX_MODULES = [
		'login', 'register', 'lostpass', 'search', 'help', 'network', 'compose', 'message',
		'contact', 'channel', 'notifications', 'notes', 'settings', 'admin', 'circle',
		'delegation', 'larpnet_matrix', 'calendar', 'events', 'bookmarklet', 'removeme',
		'filer', 'item', 'post', 'oauth', 'ping', 'proxy', 'install', 'update', 'pretheme',
		'probe', 'webfinger', 'magic', 'acctlink', 'follow', 'unfollow', 'ostatus_subscribe',
	];

	/**
	 * Whether "Only Larpnet" (Item::SERVER_ONLY) posts may be indexed. They
	 * are readable by anonymous visitors, but their author chose to keep them
	 * off the wider network, so by default search engines are asked to skip
	 * them too. Override: `bin/console config larpnet seo_index_server_only 1`.
	 */
	public static function indexServerOnlyPosts(): bool
	{
		return (bool) DI::config()->get('larpnet', 'seo_index_server_only', false);
	}

	/** HTML-attribute escaping that never returns "" on invalid UTF-8. */
	public static function esc(string $value): string
	{
		return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8');
	}

	/**
	 * Single-line plain-text excerpt cut on a word boundary, multibyte-safe.
	 * (Upstream used byte-based substr(), which split Polish characters and
	 * made htmlspecialchars() return an empty description.)
	 */
	public static function excerpt(string $plain, int $max = 160): string
	{
		$plain = trim(preg_replace('/\s+/u', ' ', $plain) ?? '');
		if (mb_strlen($plain) <= $max) {
			return $plain;
		}

		$cut   = mb_substr($plain, 0, $max - 1);
		$space = mb_strrpos($cut, ' ');
		if ($space !== false && $space > $max * 0.6) {
			$cut = mb_substr($cut, 0, $space);
		}
		return rtrim($cut, " \t,.;:-–—") . '…';
	}

	public static function absoluteUrl(string $url): string
	{
		if ($url === '' || preg_match('#^https?://#i', $url)) {
			return $url;
		}
		return DI::baseUrl() . '/' . ltrim($url, '/');
	}

	public static function defaultImage(): string
	{
		return self::absoluteUrl(self::DEFAULT_IMAGE);
	}

	/** True when the request carries no query parameters (besides nginx's own "pagename"). */
	public static function isBareRequest(): bool
	{
		return empty($_GET) || array_keys($_GET) === ['pagename'];
	}

	/**
	 * Description, canonical, Open Graph and schema.org ProfilePage for a
	 * local user's profile (the posts tab at /profile/<nick> and the "about"
	 * tab at /profile/<nick>/profile).
	 *
	 * @param array  $profile  Profile::load() result
	 * @param string $nickname
	 * @param string $url      Canonical URL of the page being rendered
	 */
	public static function profileHead(array $profile, string $nickname, string $url): string
	{
		$name   = (string) ($profile['name'] ?? $nickname);
		$about  = self::excerpt(BBCode::toPlaintext((string) ($profile['about'] ?? ''), false), 160);
		$image  = self::absoluteUrl((string) ($profile['photo'] ?? ''));
		$handle = '@' . $nickname . '@' . DI::baseUrl()->getHost();

		$description = $about !== ''
			? $about
			: sprintf('%s (%s) w serwisie Larpnet – polskiej sieci społecznościowej dla larpowców.', $name, $handle);

		$head = self::metaTags([
			'title'            => $name . ' (' . $handle . ')',
			'description'      => $description,
			'url'              => $url,
			'type'             => 'profile',
			'image'            => $image,
			'card'             => 'summary',
			'profile:username' => $nickname,
		]);

		return $head . self::jsonLd(array_filter([
			'@context'    => 'https://schema.org',
			'@type'       => 'ProfilePage',
			'url'         => $url,
			'dateCreated' => !empty($profile['register_date']) ? DateTimeFormat::utc($profile['register_date'], DateTimeFormat::ATOM) : '',
			'mainEntity'  => array_filter([
				'@type'         => 'Person',
				'name'          => $name,
				'alternateName' => $handle,
				'identifier'    => $nickname,
				'description'   => $about,
				'image'         => $image,
				'url'           => DI::baseUrl() . '/profile/' . $nickname,
			]),
		]));
	}

	public static function jsonLd(array $data): string
	{
		$json = json_encode(
			$data,
			JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP | JSON_INVALID_UTF8_SUBSTITUTE,
		);
		return $json ? '<script type="application/ld+json">' . $json . "</script>\n" : '';
	}

	/**
	 * Description, canonical, Open Graph and Twitter Card tags.
	 *
	 * @param array $tags title, description, url, image, type (og:type),
	 *                    card (twitter:card), plus any extra 'og:*'/'article:*'/
	 *                    'profile:*' => value pairs (value may be a list)
	 */
	public static function metaTags(array $tags): string
	{
		$out = '';
		if (($tags['description'] ?? '') !== '') {
			$out .= '<meta name="description" content="' . self::esc($tags['description']) . "\" />\n";
		}
		if (($tags['url'] ?? '') !== '') {
			$out .= '<link rel="canonical" href="' . self::esc($tags['url']) . "\" />\n";
		}

		$og = [
			'og:site_name'   => self::SITE_NAME,
			'og:locale'      => self::LOCALE,
			'og:type'        => $tags['type']        ?? 'website',
			'og:title'       => $tags['title']       ?? '',
			'og:description' => $tags['description'] ?? '',
			'og:url'         => $tags['url']         ?? '',
			'og:image'       => $tags['image']       ?? '',
		];
		foreach ($tags as $key => $value) {
			if (preg_match('/^(og|article|profile):/', (string) $key)) {
				$og[$key] = $value;
			}
		}
		foreach ($og as $property => $values) {
			foreach ((array) $values as $value) {
				if ((string) $value !== '') {
					$out .= '<meta property="' . $property . '" content="' . self::esc((string) $value) . "\" />\n";
				}
			}
		}

		$twitter = [
			'twitter:card'        => $tags['card']        ?? 'summary',
			'twitter:title'       => $tags['title']       ?? '',
			'twitter:description' => $tags['description'] ?? '',
			'twitter:image'       => $tags['image']       ?? '',
		];
		foreach ($twitter as $name => $value) {
			if ((string) $value !== '') {
				$out .= '<meta name="' . $name . '" content="' . self::esc((string) $value) . "\" />\n";
			}
		}

		return $out;
	}

	/**
	 * Fills in whatever the current module did not set itself: robots,
	 * description, canonical, Open Graph defaults, and site-level JSON-LD on
	 * the home page. Called by App\Page right before <head> is rendered.
	 *
	 * @param string $htmlhead What the module has put into the head so far
	 * @param string $title    Page title as shown in <title> (incl. " | Larpnet")
	 * @param string $module   Current module name
	 * @param bool   $loggedIn Whether a local user is logged in
	 */
	public static function defaultHead(string $htmlhead, string $title, string $module, bool $loggedIn): string
	{
		$out = '';

		if (!str_contains($htmlhead, 'name="robots"') && in_array($module, self::NOINDEX_MODULES, true)) {
			$out .= "<meta name=\"robots\" content=\"noindex\" />\n";
		}

		// Logged-in pages are never what a crawler or link previewer sees.
		if ($loggedIn || str_contains($htmlhead, 'property="og:title"')) {
			return $out;
		}

		$isHome = in_array($module, ['', 'home'], true);
		$tags   = [
			'title'           => $isHome ? self::HOME_TITLE : preg_replace('/ \| ' . preg_quote(self::SITE_NAME, '/') . '$/', '', $title),
			'description'     => str_contains($htmlhead, 'name="description"') ? '' : self::DEFAULT_DESCRIPTION,
			'image'           => self::defaultImage(),
			'og:image:width'  => '1200',
			'og:image:height' => '630',
			'card'            => 'summary_large_image',
		];

		// Only self-canonicalise URLs without a query string (pagination and
		// filters stay their own page); this also folds www./http:// copies
		// of a page onto the canonical host.
		if (!str_contains($htmlhead, 'rel="canonical"')) {
			$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
			if (self::isBareRequest()) {
				$tags['url'] = $isHome ? DI::baseUrl() . '/' : DI::baseUrl() . '/' . ltrim($path, '/');
			}
		}

		$out .= self::metaTags($tags);

		if ($isHome) {
			$base = DI::baseUrl() . '/';
			$out .= self::jsonLd([
				'@context' => 'https://schema.org',
				'@graph'   => [
					[
						'@type'       => 'WebSite',
						'@id'         => $base . '#website',
						'name'        => self::SITE_NAME,
						'url'         => $base,
						'description' => self::DEFAULT_DESCRIPTION,
						'inLanguage'  => 'pl',
						'publisher'   => ['@id' => $base . '#organization'],
					],
					[
						'@type' => 'Organization',
						'@id'   => $base . '#organization',
						'name'  => self::SITE_NAME,
						'url'   => $base,
						'logo'  => self::absoluteUrl('view/theme/larpnet/img/larpnet-512.png'),
					],
				],
			]);
		}

		return $out;
	}
}
