<?php

// Copyright (C) 2010-2024, the Friendica project
// SPDX-FileCopyrightText: 2010-2024 the Friendica project
//
// SPDX-License-Identifier: AGPL-3.0-or-later

namespace Friendica\Factory\Api\Mastodon;

use Friendica\BaseFactory;
use Friendica\Database\Database;
use Friendica\Model\Contact;
use Friendica\Network\HTTPException;
use ImagickException;
use Psr\Log\LoggerInterface;

class Conversation extends BaseFactory
{
	/** @var Database */
	private $dba;
	/** @var Status */
	private $mstdnStatusFactory;
	/** @var Account */
	private $mstdnAccountFactory;

	public function __construct(LoggerInterface $logger, Database $dba, Status $mstdnStatusFactory, Account $mstdnAccountFactoryFactory)
	{
		parent::__construct($logger);
		$this->dba                 = $dba;
		$this->mstdnStatusFactory  = $mstdnStatusFactory;
		$this->mstdnAccountFactory = $mstdnAccountFactoryFactory;
	}

	/**
	 * @param int $id  Conversation id
	 * @param int $uid Current user id. `mail.contact-id` is the caller's own per-user contact
	 *                 record for *the other party in the thread* (see the `mail` table's DDL
	 *                 comment) -- resolving that per row, rather than deriving participants from
	 *                 each message's sender (`from-url`/`author-id`), is what makes this work
	 *                 for a one-way (never-replied-to) thread too, see bug note below.
	 *
	 * @return \Friendica\Object\Api\Mastodon\Conversation
	 * @throws ImagickException|HTTPException\InternalServerErrorException|HTTPException\NotFoundException
	 */
	public function createFromConvId(int $id, int $uid = 0): \Friendica\Object\Api\Mastodon\Conversation
	{
		$accounts    = [];
		$unread      = false;
		$last_status = null;

		$participantIds = [];

		$mails = $this->dba->select('mail', ['id', 'contact-id', 'seen'], ['convid' => $id], ['order' => ['id' => true]]);
		while ($mail = $this->dba->fetch($mails)) {
			if (!$mail['seen']) {
				$unread = true;
			}

			if (empty($last_status)) {
				$last_status = $this->mstdnStatusFactory->createFromMailId($mail['id']);
			}

			// Bug fix: this used to derive the participant from each message's *sender*
			// (from-url/author-id) and exclude it when it matched the caller. That worked for
			// a replied-to thread, but for a one-way thread -- every message sent by the
			// caller, nothing yet from the other party -- the only "sender" ever seen was the
			// caller themselves, so they got excluded and `accounts` came back empty instead
			// of showing the actual recipient. `contact-id` is invariant across the thread and
			// always the other party by definition, regardless of who sent which message.
			$contactId = $uid ? Contact::getPublicContactId((int)$mail['contact-id'], $uid) : 0;
			if ($contactId && !in_array($contactId, $participantIds)) {
				$participantIds[] = $contactId;
				$accounts[]       = $this->mstdnAccountFactory->createFromContactId($contactId, 0);
			}
		}

		return new \Friendica\Object\Api\Mastodon\Conversation($id, $accounts, $unread, $last_status);
	}
}
