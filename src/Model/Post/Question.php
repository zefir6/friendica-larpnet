<?php

// Copyright (C) 2010-2026, the Friendica project
// SPDX-FileCopyrightText: 2010-2026 the Friendica project
//
// SPDX-License-Identifier: AGPL-3.0-or-later

namespace Friendica\Model\Post;

use BadMethodCallException;
use Friendica\Database\DBA;
use Friendica\DI;
use Friendica\Model\Post;
use Friendica\Util\DateTimeFormat;

class Question
{
	// larpnet: local (non-federated) poll creation/voting. Outcome constants
	// returned by vote(), mapped to a JSON error (API) or a flash message
	// (classic web) by the respective callers.
	public const VOTE_OK             = 'ok';
	public const VOTE_NOT_FOUND      = 'not_found';
	public const VOTE_ALREADY_VOTED  = 'already_voted';
	public const VOTE_EXPIRED        = 'expired';
	public const VOTE_INVALID_OPTION = 'invalid_option';

	// larpnet: shared poll-creation limits, enforced here and advertised via
	// Object\Api\Mastodon\InstanceV2\Polls (/api/v2/instance). Mastodon's own
	// stock defaults.
	public const MAX_OPTIONS               = 20;
	public const MAX_CHARACTERS_PER_OPTION = 100;
	public const MIN_EXPIRATION            = 300;      // 5 minutes
	public const MAX_EXPIRATION            = 2629746;  // ~1 month

	/**
	 * Update a post question entry
	 *
	 * @param integer $uri_id
	 * @param array   $data
	 * @param bool    $insert_if_missing
	 * @return bool
	 * @throws \Exception
	 */
	public static function update(int $uri_id, array $data = [], bool $insert_if_missing = true)
	{
		if (empty($uri_id)) {
			throw new BadMethodCallException('Empty URI_id');
		}

		$fields = DI::dbaDefinition()->truncateFieldsForTable('post-question', $data);

		// Remove the key fields
		unset($fields['uri-id']);

		if (empty($fields)) {
			return true;
		}

		return DBA::update('post-question', $fields, ['uri-id' => $uri_id], $insert_if_missing ? true : []);
	}

	/**
	 * @param integer $id     Question ID
	 * @param array   $fields Array of selected fields, empty for all
	 * @return array|boolean  Question record if it exists, false otherwise
	 */
	public static function getById($id, $fields = [])
	{
		return DBA::selectFirst('post-question', $fields, ['id' => $id]);
	}

	/**
	 * @param integer $uri_id
	 * @param array   $fields Array of selected fields, empty for all
	 * @return array|boolean  Question record if it exists, false otherwise
	 */
	public static function getByURIId(int $uri_id, array $fields = [])
	{
		return DBA::selectFirst('post-question', $fields, ['uri-id' => $uri_id]);
	}

	/**
	 * larpnet: Validates poll-creation input, shared by the Mastodon API
	 * (Module\Api\Mastodon\Statuses::post()) and the classic web compose form
	 * (mod/item.php), so both enforce the exact same limits.
	 *
	 * @param string[] $options
	 * @param bool     $multiple
	 * @param integer  $expires_in Seconds from now until the poll closes
	 * @return string|null Localized error message, or null if valid
	 */
	public static function validatePoll(array $options, bool $multiple, int $expires_in): ?string
	{
		$options = array_values(array_filter(array_map(trim(...), $options)));

		if (count($options) < 2) {
			return DI::l10n()->t('A poll needs at least two options.');
		}

		if (count($options) > self::MAX_OPTIONS) {
			return DI::l10n()->t('A poll can have at most %d options.', self::MAX_OPTIONS);
		}

		foreach ($options as $option) {
			if (mb_strlen($option) > self::MAX_CHARACTERS_PER_OPTION) {
				return DI::l10n()->t('Poll options can have at most %d characters.', self::MAX_CHARACTERS_PER_OPTION);
			}
		}

		if ($expires_in < self::MIN_EXPIRATION || $expires_in > self::MAX_EXPIRATION) {
			return DI::l10n()->t('Poll expiry must be between %d and %d seconds.', self::MIN_EXPIRATION, self::MAX_EXPIRATION);
		}

		return null;
	}

	/**
	 * larpnet: Placeholder text ("Option 1", "Option 2", ...) for each poll
	 * option input, shared by every editor that offers poll creation
	 * (Module\Item\Compose and Content\Conversation\StatusEditor).
	 *
	 * @return string[]
	 */
	public static function optionPlaceholders(): array
	{
		$placeholders = [];
		for ($i = 1; $i <= self::MAX_OPTIONS; $i++) {
			$placeholders[] = DI::l10n()->t('Option %d', $i);
		}

		return $placeholders;
	}

	/**
	 * larpnet: Poll-duration choices offered in the editor, shared by every
	 * editor that offers poll creation. Bounded by MIN_EXPIRATION/MAX_EXPIRATION.
	 *
	 * @return array
	 */
	public static function expiryOptions(): array
	{
		return [
			['value' => 300,     'label' => DI::l10n()->t('5 minutes')],
			['value' => 1800,    'label' => DI::l10n()->t('30 minutes')],
			['value' => 3600,    'label' => DI::l10n()->t('1 hour')],
			['value' => 21600,   'label' => DI::l10n()->t('6 hours')],
			['value' => 86400,   'label' => DI::l10n()->t('1 day')],
			['value' => 259200,  'label' => DI::l10n()->t('3 days')],
			['value' => 604800,  'label' => DI::l10n()->t('1 week')],
			['value' => 2629746, 'label' => DI::l10n()->t('1 month')],
		];
	}

	/**
	 * larpnet: Writes the `post-question`/`post-question-option` rows for a
	 * newly-created local post. Assumes validatePoll() has already been called.
	 * Option ids are assigned 0..n-1 in submission order, matching the numbering
	 * convention used by the ActivityPub inbound path
	 * (Protocol\ActivityPub\Processor::storeQuestion()).
	 *
	 * @param integer  $uri_id
	 * @param string[] $options
	 * @param bool     $multiple
	 * @param integer  $expires_in Seconds from now until the poll closes
	 * @return bool
	 * @throws \Exception
	 */
	public static function createFromOptions(int $uri_id, array $options, bool $multiple, int $expires_in): bool
	{
		$options = array_values(array_filter(array_map(trim(...), $options)));

		$result = self::update($uri_id, [
			'multiple' => $multiple,
			'voters'   => 0,
			'end-time' => DateTimeFormat::utc('now + ' . $expires_in . ' seconds'),
		]);

		foreach ($options as $index => $option) {
			$result = QuestionOption::update($uri_id, $index, ['name' => $option, 'replies' => 0]) && $result;
		}

		return $result;
	}

	/**
	 * larpnet: Casts a local user's vote for a poll. Local-only: this records
	 * the vote on this instance but does not federate it to the poll's origin
	 * server. Shared by the Mastodon API vote endpoint
	 * (Module\Api\Mastodon\Polls\Votes) and the classic web vote form
	 * (Module\Item\Vote), so both enforce the exact same rules.
	 *
	 * @param integer $uri_id
	 * @param integer $uid
	 * @param int[]   $option_ids
	 * @return string One of the VOTE_* outcome constants
	 * @throws \Exception
	 */
	public static function vote(int $uri_id, int $uid, array $option_ids): string
	{
		$question = self::getByURIId($uri_id);
		if (empty($question) || !Post::exists(['uri-id' => $uri_id, 'uid' => [0, $uid]])) {
			return self::VOTE_NOT_FOUND;
		}

		if (!empty($question['end-time']) && DateTimeFormat::utcNow() > DateTimeFormat::utc($question['end-time'])) {
			return self::VOTE_EXPIRED;
		}

		if (QuestionOptionVote::hasVoted($uri_id, $uid)) {
			return self::VOTE_ALREADY_VOTED;
		}

		$option_ids = array_values(array_unique(array_map(intval(...), $option_ids)));
		if (empty($option_ids) || (!$question['multiple'] && count($option_ids) > 1)) {
			return self::VOTE_INVALID_OPTION;
		}

		$valid_ids = array_column(QuestionOption::getByURIId($uri_id), 'id');
		if (array_diff($option_ids, $valid_ids)) {
			return self::VOTE_INVALID_OPTION;
		}

		return QuestionOptionVote::add($uri_id, $uid, $option_ids) ? self::VOTE_OK : self::VOTE_NOT_FOUND;
	}
}
