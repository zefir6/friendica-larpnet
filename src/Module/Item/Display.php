<?php

// Copyright (C) 2010-2026, the Friendica project
// SPDX-FileCopyrightText: 2010-2026 the Friendica project
//
// SPDX-License-Identifier: AGPL-3.0-or-later

namespace Friendica\Module\Item;

use Friendica\App;
use Friendica\AppHelper;
use Friendica\BaseModule;
use Friendica\Content\Conversation\StatusEditor;
use Friendica\Content\Conversation\ConversationRenderer;
use Friendica\Content\Item as ContentItem;
use Friendica\Content\Post\Entity\PostMedia;
use Friendica\Content\Text\BBCode;
use Friendica\Core\Config\Capability\IManageConfigValues;
use Friendica\Core\L10n;
use Friendica\Core\PConfig\Capability\IManagePersonalConfigValues;
use Friendica\Core\Renderer;
use Friendica\Core\Session\Capability\IHandleUserSessions;
use Friendica\Model\Contact;
use Friendica\Model\Item;
use Friendica\Model\Post;
use Friendica\Model\Profile;
use Friendica\Model\Tag;
use Friendica\Model\User;
use Friendica\Module\Response;
use Friendica\Module\Special\DisplayNotFound;
use Friendica\Navigation\Notifications\Repository\Notification;
use Friendica\Navigation\Notifications\Repository\Notify;
use Friendica\Protocol\ActivityPub;
use Friendica\Util\DateTimeFormat;
use Friendica\Util\LarpnetSeo;
use Friendica\Util\Profiler;
use Friendica\Util\Proxy;
use Friendica\Network\HTTPException;
use Friendica\Content\Widget;
use Friendica\Core\System;
use Friendica\DI;
use Psr\Log\LoggerInterface;

/**
 * Controller to display one item and its conversation
 */
class Display extends BaseModule
{
	/** @var App\Page */
	protected $page;
	/** @var IManageConfigValues */
	protected $config;
	/** @var IManagePersonalConfigValues */
	protected $pConfig;
	/** @var IHandleUserSessions */
	protected $session;
	/** @var AppHelper */
	protected $appHelper;
	/** @var ContentItem */
	protected $contentItem;
	/** @var StatusEditor */
	protected $statusEditor;
	/** @var ConversationRenderer */
	protected $htmlRenderer;
	/** @var Notification */
	protected $notification;
	/** @var Notify */
	protected $notify;
	/** @var string larpnet: post title (or excerpt) for <title>, set by addMetaTags() */
	protected $seoTitle = '';

	public function __construct(L10n $l10n, App\BaseURL $baseUrl, App\Arguments $args, LoggerInterface $logger, Profiler $profiler, Response $response, IManageConfigValues $config, IManagePersonalConfigValues $pConfig, IHandleUserSessions $session, AppHelper $appHelper, App\Page $page, ContentItem $contentItem, StatusEditor $statusEditor, ConversationRenderer $htmlRenderer, Notification $notification, Notify $notify, array $server, array $parameters = [])
	{
		parent::__construct($l10n, $baseUrl, $args, $logger, $profiler, $response, $server, $parameters);

		$this->page         = $page;
		$this->config       = $config;
		$this->pConfig      = $pConfig;
		$this->session      = $session;
		$this->appHelper    = $appHelper;
		$this->contentItem  = $contentItem;
		$this->statusEditor = $statusEditor;
		$this->htmlRenderer = $htmlRenderer;
		$this->notification = $notification;
		$this->notify       = $notify;
	}

	protected function content(array $request = []): string
	{
		if (ActivityPub::isRequest()) {
			$this->baseUrl->redirect(str_replace('display/', 'objects/', $this->args->getQueryString()));
		}

		if ($this->config->get('system', 'block_public') && !$this->session->isAuthenticated()) {
			throw new HTTPException\UnauthorizedException($this->t('Access denied.'));
		}

		$guid = $this->parameters['guid'] ?? 0;

		$item    = null;
		$itemUid = $this->session->getLocalUserId();

		$fields = ['id', 'uri-id', 'parent-uri-id', 'author-id', 'author-link', 'contact-id', 'contact-contact-type', 'body', 'uid', 'guid', 'gravity',
			'plink', 'origin', 'uri', 'post-reason', 'owner-contact-type', 'owner-network', 'owner-id', 'guid',
			'author-network', 'author-alias', 'private', 'network'];

		// Does the local user have this item?
		if ($this->session->getLocalUserId()) {
			$item = Post::selectFirstForUser($this->session->getLocalUserId(), $fields, [
				'guid' => $guid,
				'uid'  => $this->session->getLocalUserId(),
			]);
		}

		// Is this item private but could be visible to the remove visitor?
		if (empty($item) && $this->session->getRemoteUserId()) {
			$item = Post::selectFirst($fields, ['guid' => $guid, 'private' => Item::PRIVATE, 'origin' => true]);
			if (!empty($item)) {
				if (!Contact::isFollower($this->session->getRemoteUserId(), $item['uid'])) {
					$item = null;
				} else {
					$itemUid = $item['uid'];
				}
			}
		}

		// Is it an item with uid = 0?
		if (empty($item)) {
			// larpnet: SERVER_ONLY ("Only Larpnet") posts are publicly visible, so no login check here
			$allowedPrivacy = [Item::PUBLIC, Item::UNLISTED, Item::SERVER_ONLY];

			$item = Post::selectFirstForUser($this->session->getLocalUserId(), $fields, [
				'guid'    => $guid,
				'private' => $allowedPrivacy,
				'uid'     => 0,
			]);
		}

		if (empty($item)) {
			$this->page['aside'] = '';
			// larpnet: answered with HTTP 200, so keep it out of search results
			$this->page['htmlhead'] .= "<meta name=\"robots\" content=\"noindex\" />\n";
			$displayNotFound = new DisplayNotFound($this->l10n, $this->baseUrl, $this->args, $this->logger, $this->profiler, $this->response, $this->server, $this->parameters);
			return $displayNotFound->content();
		}

		$plink = Item::getPlink($item);

		if (!$this->session->getLocalUserId() && isset($plink['href']) && !DI::baseUrl()->isLocalUrl($plink['href'])) {
			System::externalRedirect($plink['href']);
		}

		if ($item['gravity'] != Item::GRAVITY_PARENT) {
			$parent = Post::selectFirst($fields, [
				'uid'    => [0, $itemUid],
				'uri-id' => $item['parent-uri-id'],
			], ['order' => ['uid' => true]]);

			$item = $parent ?: $item;
		}

		if (!$this->pConfig->get($this->session->getLocalUserId(), 'system', 'detailed_notif')) {
			$this->notification->setAllSeenForUser($this->session->getLocalUserId(), ['parent-uri-id' => $item['parent-uri-id']]);
			$this->notify->setAllSeenForUser($this->session->getLocalUserId(), ['parent-uri-id' => $item['parent-uri-id']]);
		}

		if ($this->session->getLocalUserId() != 0) {
			$this->contentItem->setViewed($item['uri-id'], $this->session->getLocalUserId());
		}

		$this->displaySidebar($item);
		$this->displayHead($item['uri-id'], $item['parent-uri-id']);

		$output = '';

		// add the uri-id to the update_display parameter
		if ($this->session->getLocalUserId()) {
			$output .= "<script> var netargs = '?uri_id=" . $item['uri-id'] . "'; </script>";
		}

		$output .= $this->getDisplayData($item, false, false);

		$author = Contact::getByURLForUser($item['author-link'], $this->session->getLocalUserId());
		// larpnet: "<post title or excerpt> – <author>" instead of an untranslated "Post by <author>"
		$this->page['title'] = $this->seoTitle !== '' ? $this->seoTitle . ' – ' . $author['name'] : $this->l10n->t("Post by %s", $author['name']);

		return $output;
	}

	/**
	 * Loads the content for the sidebar of the display page
	 *
	 * @param array $item The current item
	 *
	 * @return void
	 * @throws HTTPException\InternalServerErrorException
	 * @throws HTTPException\NotFoundException
	 * @throws \ImagickException
	 */
	protected function displaySidebar(array $item)
	{
		$author = [];
		$shared = $this->contentItem->getSharedPost($item, ['author-link']);
		if (array_key_exists('comment', $shared) && strval($shared['comment']) === '') {
			$author = Contact::getByURLForUser($shared['post']['author-link'], $this->session->getLocalUserId());
		}

		if ($author === []) {
			if ($item['contact-contact-type'] == Contact::TYPE_COMMUNITY) {
				$author = Contact::getById($item['contact-id']);
			} else {
				$author = Contact::getById($item['author-id']);
			}
		}

		if ($this->baseUrl->isLocalUrl($author['url'])) {
			Profile::load($this->appHelper, $author['nick'], false);
		} else {
			$this->page['aside'] = Widget\VCard::getHTML($author);
		}

		$this->appHelper->setProfileOwner($item['uid']);
	}

	protected function getDisplayData(array $item, bool $update = false, bool $force = false): string
	{
		$itemUid = $this->session->getLocalUserId();

		$parent = null;
		if (!$this->session->getLocalUserId() && !empty($item['parent-uri-id'])) {
			$parent = Post::selectFirst(['uid'], ['uri-id' => $item['parent-uri-id'], 'wall' => true]);
		}

		if (!empty($parent)) {
			$pageUid = $parent['uid'];
			if ($this->session->getRemoteContactID($pageUid)) {
				$itemUid = $parent['uid'];
			}
		} else {
			$pageUid = $item['uid'];
		}

		if (!empty($pageUid) && ($pageUid != $this->session->getLocalUserId())) {
			$page_user = User::getById($pageUid, ['nickname', 'hidewall']);
		}

		if (!empty($page_user['hidewall']) && !$this->session->isAuthenticated()) {
			$this->baseUrl->redirect('profile/' . $page_user['nickname'] . '/restricted');
		}

		$sql_extra = Item::getPermissionsSQLByUserId($pageUid);

		if ($this->session->getLocalUserId() && ($this->session->getLocalUserId() == $pageUid)) {
			$unseen = Post::exists([
				'parent-uri-id' => $item['parent-uri-id'],
				'uid'           => $this->session->getLocalUserId(),
				'unseen'        => true,
			]);
		} else {
			$unseen = false;
		}

		if ($update && !$unseen && !$force) {
			return '';
		}

		$condition = ["`uri-id` = ? AND `uid` IN (0, ?) " . $sql_extra, $item['uri-id'], $itemUid];
		$fields    = [
			'parent-uri-id', 'body', 'title', 'author-name', 'author-avatar', 'plink', 'author-id',
			'owner-id', 'contact-id', 'uid',
			// larpnet: for the SEO meta tags / JSON-LD
			'author-link', 'created', 'edited', 'private', 'origin',
		];

		$item = Post::selectFirstForUser($pageUid, $fields, $condition);

		if (empty($item)) {
			$this->page['aside'] = '';
			// larpnet: answered with HTTP 200, so keep it out of search results
			$this->page['htmlhead'] .= "<meta name=\"robots\" content=\"noindex\" />\n";
			$displayNotFound = new DisplayNotFound($this->l10n, $this->baseUrl, $this->args, $this->logger, $this->profiler, $this->response, $this->server, $this->parameters);
			return $displayNotFound->content();
		}

		$item['uri-id'] = $item['parent-uri-id'];

		if ($unseen) {
			$condition = [
				'parent-uri-id' => $item['parent-uri-id'],
				'uid'           => $this->session->getLocalUserId(),
				'unseen'        => true,
			];
			Item::update(['unseen' => false], $condition);
		}

		$this->addMetaTags($item);

		$output = '';

		$is_owner = $this->session->getLocalUserId() && (in_array($pageUid, [$this->session->getLocalUserId(), 0]));

		// We need the editor here to be able to reshare an item.
		if ($is_owner && !$update) {
			$output .= $this->statusEditor->renderEditor([], 0, true);
		}

		$output .= $this->htmlRenderer->renderThreadByItem($item, $update, $itemUid, ConversationRenderer::MODE_DISPLAY);

		return $output;
	}

	// We are displaying an "alternate" link if that post was public. See issue 2864
	protected function displayHead(string $uriId, string $parentUriId)
	{
		if (Post::exists(['uri-id' => $uriId, 'private' => [Item::PUBLIC, Item::UNLISTED]])) {
			// For the atom feed the nickname doesn't matter at all, we only need the item id.
			$this->page['htmlhead'] .= Renderer::replaceMacros(Renderer::getMarkupTemplate('display-head.tpl'), [
				'$alternate'    => sprintf('display/feed-item/%s.atom', $uriId),
				'$conversation' => sprintf('display/feed-item/%s/conversation.atom', $parentUriId),
			]);
		}
	}

	/**
	 * Adds <meta> tags to the HTML output based on an item
	 *
	 * @param array $item The item with the information for the <meta> tags
	 *
	 * @return void
	 * @throws \Exception
	 */
	protected function addMetaTags(array $item)
	{
		// larpnet: rewritten. Upstream cut the description with byte-based
		// substr() (splitting Polish characters, which made htmlspecialchars()
		// return ""), pointed og:image at the site root, and had no canonical,
		// article dates or structured data.
		$plain       = trim(BBCode::toPlaintext($item['body'], false));
		$description = LarpnetSeo::excerpt($plain, 160);
		$title       = trim(BBCode::toPlaintext($item['title'] ?? '', false));
		$author_name = (string) $item['author-name'];
		$headline    = $title !== '' ? $title : LarpnetSeo::excerpt($plain, 70);

		$this->seoTitle = $headline;

		$url = $item['plink'] ?: $this->baseUrl . '/display/' . ($this->parameters['guid'] ?? '');

		$image = '';
		foreach (Post\Media::getByURIId($item['uri-id'], [PostMedia::TYPE_IMAGE]) as $media) {
			if (preg_match('#^https?://#i', (string) $media['url'])) {
				$image = $media['url'];
				break;
			}
		}
		if ($image === '' && preg_match('#\[img(?:=([^\]]+))?[^\]]*\]([^\[]*)#i', (string) $item['body'], $m)) {
			$candidate = preg_match('#^https?://#i', $m[1]) ? $m[1] : trim($m[2]);
			$image     = preg_match('#^https?://#i', $candidate) ? $candidate : '';
		}
		$authorImage = Contact::getAvatarUrlForId($item['author-id'], Proxy::SIZE_SMALL);

		$noindex = Contact::exists(['unsearchable' => true, 'id' => [$item['contact-id'], $item['author-id'], $item['owner-id']]])
			|| !$this->baseUrl->isLocalUrl($url)
			|| (($item['private'] ?? null) == Item::SERVER_ONLY && !LarpnetSeo::indexServerOnlyPosts());

		$head = '';
		if ($noindex) {
			$head .= "<meta content=\"noindex, noarchive\" name=\"robots\" />\n";
		}
		$head .= '<meta name="author" content="' . LarpnetSeo::esc($author_name) . "\" />\n";

		$published = !empty($item['created']) ? DateTimeFormat::utc($item['created'], DateTimeFormat::ATOM) : '';
		$modified  = !empty($item['edited']) ? DateTimeFormat::utc($item['edited'], DateTimeFormat::ATOM) : '';

		$keywords = LarpnetSeo::keywords(array_column(Tag::getByURIId($item['uri-id'], [Tag::HASHTAG]) ?: [], 'name'));

		$head .= LarpnetSeo::metaTags([
			'title'                  => $headline,
			'description'            => $description,
			'keywords'               => $keywords,
			'article:tag'            => $keywords,
			'url'                    => $url,
			'type'                   => 'article',
			'image'                  => $image ?: $authorImage,
			'card'                   => $image ? 'summary_large_image' : 'summary',
			'article:published_time' => $published,
			'article:modified_time'  => $modified !== $published ? $modified : '',
			'article:author'         => (string) ($item['author-link'] ?? ''),
		]);

		$posting = [
			'@context'         => 'https://schema.org',
			'@type'            => 'DiscussionForumPosting',
			'mainEntityOfPage' => $url,
			'url'              => $url,
			'headline'         => mb_substr($headline, 0, 110),
			'text'             => mb_substr($plain, 0, 5000),
			'datePublished'    => $published,
			'author'           => array_filter([
				'@type' => 'Person',
				'name'  => $author_name,
				'url'   => (string) ($item['author-link'] ?? ''),
			]),
			'isPartOf' => ['@type' => 'WebSite', 'name' => LarpnetSeo::SITE_NAME, 'url' => $this->baseUrl . '/'],
		];
		if ($modified !== '' && $modified !== $published) {
			$posting['dateModified'] = $modified;
		}
		if ($image !== '') {
			$posting['image'] = $image;
		}
		if ($keywords) {
			$posting['keywords'] = implode(', ', $keywords);
		}
		$head .= LarpnetSeo::jsonLd($posting);

		$this->page['htmlhead'] .= $head;
	}
}
