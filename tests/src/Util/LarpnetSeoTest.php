<?php

// Copyright (C) 2010-2026, the Friendica project
// SPDX-FileCopyrightText: 2010-2026 the Friendica project
//
// SPDX-License-Identifier: AGPL-3.0-or-later

namespace Friendica\Test\src\Util;

use Friendica\Util\LarpnetSeo;
use PHPUnit\Framework\TestCase;

class LarpnetSeoTest extends TestCase
{
	public function testExcerptKeepsShortTextAndCollapsesWhitespace(): void
	{
		self::assertSame('Larp jako wymiana energii', LarpnetSeo::excerpt("  Larp jako\n\n wymiana\tenergii "));
	}

	/**
	 * Regression: upstream cut at 157 *bytes*; landing inside a Polish
	 * two-byte character produced invalid UTF-8 and htmlspecialchars()
	 * then returned "", i.e. an empty meta description.
	 */
	public function testExcerptIsMultibyteSafeAndEscapable(): void
	{
		$text = str_repeat('zażółć gęślą jaźń ', 30);

		$excerpt = LarpnetSeo::excerpt($text, 160);

		self::assertTrue(mb_check_encoding($excerpt, 'UTF-8'));
		self::assertLessThanOrEqual(160, mb_strlen($excerpt));
		self::assertStringEndsWith('…', $excerpt);
		self::assertStringStartsWith('zażółć gęślą', $excerpt);
		self::assertNotSame('', LarpnetSeo::esc($excerpt));
	}

	public function testExcerptCutsOnWordBoundary(): void
	{
		$excerpt = LarpnetSeo::excerpt('aaaa bbbb cccc dddd eeee ffff', 17);

		self::assertSame('aaaa bbbb cccc…', $excerpt);
	}

	public function testEscNeverReturnsEmptyForInvalidUtf8(): void
	{
		self::assertNotSame('', LarpnetSeo::esc("ok \xC5"));
		self::assertSame('&quot;a&quot; &lt;b&gt; &amp;', LarpnetSeo::esc('"a" <b> &'));
	}

	public function testMetaTagsSkipsEmptyValuesAndEscapes(): void
	{
		$html = LarpnetSeo::metaTags([
			'title'                  => 'Tytuł "z" cudzysłowem',
			'description'            => '',
			'url'                    => 'https://larpnet.pl/display/abc',
			'type'                   => 'article',
			'image'                  => '',
			'article:published_time' => '2026-06-19T11:10:51Z',
		]);

		self::assertStringContainsString('<link rel="canonical" href="https://larpnet.pl/display/abc" />', $html);
		self::assertStringContainsString('<meta property="og:type" content="article" />', $html);
		self::assertStringContainsString('<meta property="og:title" content="Tytuł &quot;z&quot; cudzysłowem" />', $html);
		self::assertStringContainsString('<meta property="og:site_name" content="Larpnet" />', $html);
		self::assertStringContainsString('<meta property="article:published_time" content="2026-06-19T11:10:51Z" />', $html);
		self::assertStringNotContainsString('name="description"', $html);
		self::assertStringNotContainsString('og:image', $html);
	}

	public function testJsonLdCannotBreakOutOfScriptTag(): void
	{
		$html = LarpnetSeo::jsonLd(['text' => '</script><script>alert(1)</script>']);

		self::assertStringStartsWith('<script type="application/ld+json">', $html);
		self::assertSame(1, substr_count($html, '</script>'));
	}
}
