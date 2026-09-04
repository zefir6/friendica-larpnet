<?php

// Copyright (C) 2010-2026, the Friendica project
// SPDX-FileCopyrightText: 2010-2026 the Friendica project
//
// SPDX-License-Identifier: AGPL-3.0-or-later

namespace Friendica\Module\Api\Mastodon;

use Friendica\Database\DBA;
use Friendica\DI;
use Friendica\Module\BaseApi;
use Friendica\Network\HTTPException\NotFoundException;

/**
 * @see https://docs.joinmastodon.org/methods/timelines/conversations/
 */
class Conversations extends BaseApi
{
	protected function delete(array $request = [])
	{
		$this->checkAllowedScope(self::SCOPE_WRITE);
		$uid = self::getCurrentUserID();

		if (empty($this->parameters['id'])) {
			$this->logAndJsonError(422, $this->errorFactory->UnprocessableEntity());
		}

		DBA::delete('conv', ['id' => $this->parameters['id'], 'uid' => $uid]);
		DBA::delete('mail', ['convid' => $this->parameters['id'], 'uid' => $uid]);

		$this->earlyJsonExit([]);
	}

	/**
	 * @throws \Friendica\Network\HTTPException\InternalServerErrorException
	 */
	protected function rawContent(array $request = [])
	{
		$this->checkAllowedScope(self::SCOPE_READ);
		$uid = self::getCurrentUserID();

		$request = $this->getRequest([
			'limit'    => 20, // Maximum number of results. Defaults to 20. Max 40.
			'max_id'   => 0,  // Return results older than this ID. Use HTTP Link header to paginate.
			'since_id' => 0,  // Return results newer than this ID. Use HTTP Link header to paginate.
			'min_id'   => 0,  // Return results immediately newer than this ID. Use HTTP Link header to paginate.
		], $request);

		$params = ['order' => ['convid' => true], 'limit' => $request['limit'], 'group_by' => ['convid']];

		// Bug fix: this used to query the `conv` table scoped by uid. A `conv` row is only ever
		// created under the message *sender's* own uid (see Mail::send()) -- a recipient's own
		// `mail` row correctly carries the shared convid, but never gets a matching uid-scoped
		// `conv` row of their own. So the old query returned nothing for any conversation the
		// caller didn't start themselves -- confirmed live: an account that had only *received*
		// a DM saw an empty list here, while the Twitter-compat direct_messages endpoints (which
		// read `mail` directly) correctly showed it. Enumerating distinct convids straight from
		// the caller's own `mail` rows is the one place that's always correctly uid-scoped for
		// both senders and recipients.
		$condition = DBA::mergeConditions(['uid' => $uid], ["`convid` != ?", 0]);

		if (!empty($request['max_id'])) {
			$condition = DBA::mergeConditions($condition, ["`convid` < ?", $request['max_id']]);
		}

		if (!empty($request['since_id'])) {
			$condition = DBA::mergeConditions($condition, ["`convid` > ?", $request['since_id']]);
		}

		if (!empty($request['min_id'])) {
			$condition = DBA::mergeConditions($condition, ["`convid` > ?", $request['min_id']]);

			$params['order'] = ['convid'];
		}

		$convs = DBA::select('mail', ['convid'], $condition, $params);

		$conversations = [];

		try {
			while ($conv = DBA::fetch($convs)) {
				self::setBoundaries($conv['convid']);
				$conversations[] = DI::mstdnConversation()->createFromConvId($conv['convid'], $uid);
			}
		} catch (NotFoundException) {
			$this->logAndJsonError(404, $this->errorFactory->RecordNotFound());
		}

		DBA::close($convs);

		if (!empty($request['min_id'])) {
			$conversations = array_reverse($conversations);
		}

		$this->setPaginationLinkHeader();
		$this->earlyJsonExit($conversations);
	}
}
