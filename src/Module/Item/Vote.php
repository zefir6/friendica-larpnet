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

		$options = array_map(intval(...), (array) ($_REQUEST['options'] ?? []));

		$outcome = Question::vote($item['uri-id'], $uid, $options);

		$errorMessage = match ($outcome) {
			Question::VOTE_NOT_FOUND => $l10n->t('Poll not found.'),
			Question::VOTE_ALREADY_VOTED => $l10n->t('You have already voted on this poll.'),
			Question::VOTE_EXPIRED => $l10n->t('This poll has ended.'),
			Question::VOTE_INVALID_OPTION => $l10n->t('Invalid poll option.'),
			default => null,
		};

		if ($errorMessage !== null) {
			DI::sysmsg()->addNotice($errorMessage);
		}

		$return_path = $_REQUEST['return'] ?? '';
		if (!empty($return_path)) {
			DI::baseUrl()->redirect($return_path);
		}

		// No return path (e.g. a bare AJAX/API-style caller): report the real
		// outcome instead of always claiming success -- the flash-message
		// notice above is only ever seen on the next full page load via the
		// redirect, so a caller with no return_path would otherwise have no
		// way to know voting failed.
		if ($errorMessage !== null) {
			$httpCode = match ($outcome) {
				Question::VOTE_NOT_FOUND => 404,
				default => 422,
			};
			$this->earlyJsonError($httpCode, ['status' => 'error', 'message' => $errorMessage]);
		}

		$this->earlyJsonExit(['status' => 'ok']);
	}
}
