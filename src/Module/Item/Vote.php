<?php

// Copyright (C) 2010-2026, the Friendica project
// SPDX-FileCopyrightText: 2010-2026 the Friendica project
//
// SPDX-License-Identifier: AGPL-3.0-or-later

namespace Friendica\Module\Item;

use Friendica\BaseModule;
use Friendica\DI;
use Friendica\Model\Post;
use Friendica\Model\Post\Question;
use Friendica\Network\HTTPException;

/**
 * larpnet: classic web UI poll voting. Local-only (this instance's own vote
 * tally only, never federated to the poll's origin server), mirroring
 * Module\Api\Mastodon\Polls\Votes for the Mastodon API path -- both call the
 * same Model\Post\Question::vote().
 */
class Vote extends BaseModule
{
	protected function post(array $request = [])
	{
		$l10n = DI::l10n();
		$uid  = DI::userSession()->getLocalUserId();

		if (!$uid) {
			throw new HTTPException\ForbiddenException($l10n->t('Access denied.'));
		}

		if (empty($this->parameters['id'])) {
			throw new HTTPException\BadRequestException();
		}

		$item = Post::selectFirst(['uri-id'], ['id' => (int) $this->parameters['id'], 'uid' => [0, $uid]]);
		if (empty($item)) {
			throw new HTTPException\NotFoundException();
		}

		$options = array_map('intval', (array) ($_REQUEST['options'] ?? []));

		switch (Question::vote($item['uri-id'], $uid, $options)) {
			case Question::VOTE_NOT_FOUND:
				DI::sysmsg()->addNotice($l10n->t('Poll not found.'));
				break;
			case Question::VOTE_ALREADY_VOTED:
				DI::sysmsg()->addNotice($l10n->t('You have already voted on this poll.'));
				break;
			case Question::VOTE_EXPIRED:
				DI::sysmsg()->addNotice($l10n->t('This poll has ended.'));
				break;
			case Question::VOTE_INVALID_OPTION:
				DI::sysmsg()->addNotice($l10n->t('Invalid poll option.'));
				break;
		}

		$return_path = $_REQUEST['return'] ?? '';
		if (!empty($return_path)) {
			DI::baseUrl()->redirect($return_path);
		}

		$this->earlyJsonExit(['status' => 'ok']);
	}
}
