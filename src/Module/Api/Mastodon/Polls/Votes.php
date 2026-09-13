<?php

// Copyright (C) 2010-2026, the Friendica project
// SPDX-FileCopyrightText: 2010-2026 the Friendica project
//
// SPDX-License-Identifier: AGPL-3.0-or-later

namespace Friendica\Module\Api\Mastodon\Polls;

use Friendica\DI;
use Friendica\Model\Post\Question;
use Friendica\Module\BaseApi;

/**
 * larpnet: local (non-federated) poll voting.
 *
 * @see https://docs.joinmastodon.org/methods/polls/#vote
 */
class Votes extends BaseApi
{
	protected function post(array $request = [])
	{
		$this->checkAllowedScope(self::SCOPE_WRITE);
		$uid = self::getCurrentUserID();

		if (empty($this->parameters['id'])) {
			$this->logAndJsonError(422, $this->errorFactory->UnprocessableEntity());
		}

		$question = Question::getById($this->parameters['id']);
		if (empty($question)) {
			$this->logAndJsonError(404, $this->errorFactory->RecordNotFound());
		}

		$request = $this->getRequest([
			'choices' => [], // Array of chosen option indices (zero-based)
		], $request);

		switch (Question::vote($question['uri-id'], $uid, $request['choices'])) {
			case Question::VOTE_NOT_FOUND:
				$this->logAndJsonError(404, $this->errorFactory->RecordNotFound());
				// no break
			case Question::VOTE_ALREADY_VOTED:
				$this->logAndJsonError(422, $this->errorFactory->UnprocessableEntity($this->t('You have already voted on this poll.')));
				// no break
			case Question::VOTE_EXPIRED:
				$this->logAndJsonError(422, $this->errorFactory->UnprocessableEntity($this->t('This poll has ended.')));
				// no break
			case Question::VOTE_INVALID_OPTION:
				$this->logAndJsonError(422, $this->errorFactory->UnprocessableEntity($this->t('Invalid poll option.')));
		}

		$this->earlyJsonExit(DI::mstdnPoll()->createFromId($question['id'], $uid));
	}
}
