<?php

// Copyright (C) 2010-2026, the Friendica project
// SPDX-FileCopyrightText: 2010-2026 the Friendica project
//
// SPDX-License-Identifier: AGPL-3.0-or-later

namespace Friendica\Model\Post;

use Friendica\Database\DBA;
use Friendica\Util\DateTimeFormat;

/**
 * larpnet: Tracks which local users voted for which poll options. Upstream
 * Friendica only mirrors remote-origin poll tallies via ActivityPub and never
 * tracks per-user votes locally, so this table (and model) is a larpnet
 * addition backing local poll voting (Model\Post\Question::vote()).
 */
class QuestionOptionVote
{
	/**
	 * @param integer $uri_id
	 * @param integer $uid
	 * @return bool
	 * @throws \Exception
	 */
	public static function hasVoted(int $uri_id, int $uid): bool
	{
		return DBA::exists('post-question-option-vote', ['uri-id' => $uri_id, 'uid' => $uid]);
	}

	/**
	 * @param integer $uri_id
	 * @param integer $uid
	 * @return int[] Option ids the given user has already voted for
	 * @throws \Exception
	 */
	public static function getVotedOptions(int $uri_id, int $uid): array
	{
		$votes = DBA::selectToArray('post-question-option-vote', ['option'], ['uri-id' => $uri_id, 'uid' => $uid], ['order' => ['option']]);

		return array_column($votes, 'option');
	}

	/**
	 * Records a local user's vote for one or more poll options and updates the
	 * cached reply/voter counts on `post-question(-option)`. Does not itself
	 * enforce voting rules (already-voted, expiry, valid option ids) -- see
	 * Question::vote() for the validated entry point.
	 *
	 * @param integer $uri_id
	 * @param integer $uid
	 * @param int[]   $option_ids
	 * @return bool
	 * @throws \Exception
	 */
	public static function add(int $uri_id, int $uid, array $option_ids): bool
	{
		if (empty($uri_id) || empty($uid) || empty($option_ids)) {
			return false;
		}

		DBA::transaction();

		foreach ($option_ids as $option_id) {
			if (!DBA::insert('post-question-option-vote', [
				'uri-id'  => $uri_id,
				'uid'     => $uid,
				'option'  => $option_id,
				'created' => DateTimeFormat::utcNow(),
			])) {
				DBA::rollback();
				return false;
			}

			DBA::e('UPDATE `post-question-option` SET `replies` = `replies` + 1 WHERE `uri-id` = ? AND `id` = ?', $uri_id, $option_id);
		}

		DBA::e('UPDATE `post-question` SET `voters` = `voters` + 1 WHERE `uri-id` = ?', $uri_id);

		return DBA::commit();
	}
}
