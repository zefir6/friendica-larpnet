import { createClient } from 'matrix-js-sdk';
import { createRecoveryKeyCache } from './recovery.js';

const DEVICE_ID_KEY = 'larpnet_chat_device_id';

// A stable (but non-secret) per-browser device id, so repeat logins reuse
// the same Matrix device instead of registering a new one every time the
// chat popup is opened -- Synapse's /login re-issues a fresh access token
// for an existing device_id rather than creating a new device. Unlike the
// old Element-embedding bridge, this client never persists the access
// token itself; every popup open does a real, fresh JWT login. That's the
// fix for the "Unable to restore session" bug: that bug came from skipping
// the real login and hand-seeding a previous session's tokens into
// localStorage, which left Element's crypto engine to cold-boot-restore a
// session it never actually logged into itself. Always logging in for
// real, every time, means we only ever exercise the one well-tested code
// path (login -> initRustCrypto -> startClient), never a hand-rolled
// shortcut around it.
function getOrCreateDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = 'larpnet_web_' + crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export async function loginAndStart(cfg) {
  const deviceId = getOrCreateDeviceId();

  const loginClient = createClient({ baseUrl: cfg.homeserverUrl });
  const res = await loginClient.login('org.matrix.login.jwt', {
    token: cfg.jwt,
    device_id: deviceId,
    initial_device_display_name: cfg.deviceName || 'larpnet web',
  });

  // recoveryKeyCache backs cryptoCallbacks.getSecretStorageKey -- the crypto
  // stack calls into it whenever it needs the recovery key (e.g. to restore
  // key backup on this device). See recovery.js's own docblock for the full
  // cross-device history story; the caller (App.jsx) drives setup/restore
  // via getRecoveryStatus() once the client is ready.
  const recoveryKeyCache = createRecoveryKeyCache();
  const client = createClient({
    baseUrl: cfg.homeserverUrl,
    userId: res.user_id,
    accessToken: res.access_token,
    deviceId: res.device_id,
    cryptoCallbacks: recoveryKeyCache.cryptoCallbacks,
  });

  // Rust-crypto backend. cryptoDatabasePrefix MUST be unique per
  // (account, device) -- left unset, the SDK opens one hardcoded-named
  // IndexedDB database shared by *every* account and *every* device on
  // this origin (confirmed by reading matrix-js-sdk's client.js: no
  // cryptoDatabasePrefix -> a fixed default name in the underlying WASM
  // store). Without this, two tabs open to different accounts (or even the
  // same account, two devices) fight over the same store -- confirmed live
  // as both a hard crash ("account in the store doesn't match the account
  // in the constructor") switching accounts in one tab, and later as an
  // indefinite hang opening the store while some *other* tab anywhere in
  // the browser still held it open.
  //
  // NB: `client.initRustCrypto()`'s own public option is
  // `cryptoDatabasePrefix`, NOT `storePrefix` -- `storePrefix` is only the
  // name of the *lower-level* rust-crypto/index.js parameter that
  // `cryptoDatabasePrefix` gets translated into internally. Passing
  // `storePrefix` directly here is silently ignored (unknown key on a
  // plain object), which is exactly what happened on the first attempt at
  // this fix -- confirmed live: `indexedDB.databases()` still showed only
  // the old fixed-name database after deploying that version.
  //
  // Cross-signing/secret-storage/key-backup setup itself is NOT done here
  // -- it's a one-time-ever, user-facing flow (see recovery.js), not
  // something to trigger silently on every login.
  await client.initRustCrypto({ cryptoDatabasePrefix: `${res.user_id}::${res.device_id}` });

  await client.startClient({ initialSyncLimit: 30 });
  // startClient() resolves once the sync loop is STARTED, not once rooms
  // are actually populated -- calling findOrCreateDirectRoom() right after
  // it (before this) saw an empty room list every time and created a fresh
  // duplicate DM room on every single popup open. Wait for the first
  // completed sync (state -> 'PREPARED') before the caller looks at rooms.
  await waitForInitialSync(client);

  // Best-effort: give the crypto store's IndexedDB connection a chance to
  // close cleanly before this browsing context is torn down (chat is
  // embedded in an <iframe> again, so a Friendica page navigation destroys
  // it -- see js/matrix-chat-widget.js's docblock for the history here).
  // Not a guarantee -- pagehide handlers aren't given unlimited time -- but
  // better than doing nothing, and cheap to attempt.
  window.addEventListener('pagehide', () => {
    try {
      client.stopClient();
    } catch (e) {
      // best-effort only; nothing useful to do if this fails during teardown
    }
  });

  return { client, recoveryKeyCache };
}

function waitForInitialSync(client) {
  return new Promise((resolve, reject) => {
    const onSync = (state) => {
      if (state === 'PREPARED') {
        client.removeListener('sync', onSync);
        resolve();
      } else if (state === 'ERROR') {
        client.removeListener('sync', onSync);
        reject(new Error('Initial sync failed'));
      }
    };
    client.on('sync', onSync);
  });
}

// Larpnet display name for a Matrix userId, or null if it doesn't match
// anyone in `contacts` (config.contacts, the same nickname->name list the
// "+ Nowy czat" picker uses). Matrix's own displayname for a user is only
// set once *they themselves* have opened chat at least once (see
// larpnet_matrix_sync_profile() -- it pushes the logged-in user's own
// name to their own Matrix profile, not anyone else's), so someone who's
// never opened chat would otherwise show as their raw @localpart:server
// mxid in the room list/timeline. Preferring the Friendica name we already
// know avoids that regardless of whether the other party has logged in.
export function resolveDisplayName(userId, contacts) {
  const localpart = /^@([^:]+):/.exec(userId || '')?.[1];
  if (!localpart) {
    return null;
  }
  return contacts?.find((c) => c.nickname.toLowerCase() === localpart)?.name || null;
}

// The name to show for a room -- shared by the room list AND the
// conversation header (both must show the same thing: who you're actually
// talking to, never your own name).
export function roomDisplayName(room, client, contacts) {
  const others = room
    .getMembersWithMembership('join')
    .concat(room.getMembersWithMembership('invite'))
    .filter((m) => m.userId !== client.getUserId());

  // 1:1 DM (the dominant case): prefer the Friendica name we already know
  // over Matrix's own room-name calculation, which falls back to the raw
  // mxid whenever the other party has never opened chat themselves (see
  // resolveDisplayName()'s own comment).
  if (others.length === 1) {
    const resolved = resolveDisplayName(others[0].userId, contacts);
    if (resolved) {
      return resolved;
    }
  }

  // Group rooms (or a 1:1 DM with no Friendica match, e.g. an unpublished
  // profile): matrix-js-sdk's own default room-name calculation already
  // handles multi-member summaries reasonably.
  const name = room.name;
  if (name && name !== 'Empty room') {
    return name;
  }

  return others[0]?.name || others[0]?.userId || 'Rozmowa';
}

// Locale-aware relative timestamp ("5 min temu" / "5 minutes ago" depending on browser locale),
// via the standard Intl API rather than hand-rolling pl/en strings -- mirrors the iOS/Android
// clients' own RelativeTime helpers.
const RELATIVE_TIME_UNITS = [
  ['year', 31536000],
  ['month', 2592000],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];
const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function formatRelativeTime(timestampMs) {
  const diffSeconds = (timestampMs - Date.now()) / 1000;
  for (const [unit, secondsInUnit] of RELATIVE_TIME_UNITS) {
    if (Math.abs(diffSeconds) >= secondsInUnit) {
      return relativeTimeFormatter.format(Math.round(diffSeconds / secondsInUnit), unit);
    }
  }
  return relativeTimeFormatter.format(Math.round(diffSeconds), 'second');
}

export function dmTargetMxid(cfg) {
  if (!cfg.dm) {
    return null;
  }
  return '@' + cfg.dm + ':' + cfg.serverName;
}

// Adds roomId under targetMxid in the m.direct account-data map (merging,
// never overwriting other users' entries), creating the map if it doesn't
// exist yet. This is the actual Matrix-spec mechanism for "which room is
// my DM with this person" -- see findOrCreateDirectRoom()'s doc comment
// for why writing it here matters, not just reading it.
async function addDirectRoomAccountData(client, targetMxid, roomId) {
  const direct = client.getAccountData('m.direct')?.getContent() || {};
  const existingIds = direct[targetMxid] || [];
  if (existingIds.includes(roomId)) {
    return;
  }
  await client.setAccountData('m.direct', { ...direct, [targetMxid]: [...existingIds, roomId] });
}

// Auto-accepts room invites from other users on THIS homeserver -- the
// actual reason "messages never arrive": starting a chat creates an
// encrypted room and only *invites* the other person, and no client of ours
// ever joined an invited room. An invited user sees none of a room's
// timeline (Matrix only shows events to joined members), so the recipient's
// side stayed empty forever, even after reload, while the sender saw their
// own messages fine. Invites from other servers are left alone (prod
// federates; auto-joining arbitrary remote invites would be a spam vector).
//
// Runs over existing invites once at startup (backlog from before this
// fix) and then on every new invite. A joined DM is also added to our own
// m.direct (the inviter only wrote theirs), so findOrCreateDirectRoom() on
// this side resolves to the same room instead of creating a duplicate.
export function autoJoinLocalInvites(client) {
  const ownUserId = client.getUserId();
  const serverOf = (mxid) => mxid.slice(mxid.indexOf(':') + 1);
  const ownServer = serverOf(ownUserId);
  const inFlight = new Set();

  const tryJoin = async (room) => {
    if (room.getMyMembership() !== 'invite' || inFlight.has(room.roomId)) {
      return;
    }
    const inviteEvent = room.getMember(ownUserId)?.events?.member;
    const inviter = inviteEvent?.getSender() || room.getDMInviter?.();
    if (!inviter || serverOf(inviter) !== ownServer) {
      return;
    }
    inFlight.add(room.roomId);
    try {
      await client.joinRoom(room.roomId);
      if (inviteEvent?.getContent()?.is_direct) {
        await addDirectRoomAccountData(client, inviter, room.roomId);
      }
    } catch (e) {
      console.error('larpnet chat: auto-joining invite failed', room.roomId, e);
    } finally {
      inFlight.delete(room.roomId);
    }
  };

  client.on('Room.myMembership', (room, membership) => {
    if (membership === 'invite') {
      tryJoin(room);
    }
  });
  return Promise.all(client.getRooms().map(tryJoin));
}

// Finds an existing 1:1 room with this other member, or creates one.
//
// Primary lookup is the m.direct account-data event ({ [userId]: [roomId,
// ...] }) -- the actual spec mechanism every well-behaved Matrix client
// (including MatrixRustSDK's own Client::get_dm_room(), used by the iOS/
// Android apps) relies on to recognize "this room is my DM with them".
// This client used to never read OR write that event, using only a plain
// "exactly 2 members" heuristic instead -- which meant a room this client
// created was invisible to the mobile apps' lookup (and, symmetrically, a
// room *they* created could be invisible to this heuristic if their
// member-count assumption ever didn't hold), so starting a chat with the
// same person from the phone and then from web ended up creating two
// separate rooms instead of continuing the same conversation. Confirmed
// live: MatrixRustSDK's get_dm_room() reads direct_targets(), sourced from
// this same m.direct account data, nothing else.
//
// The old member-count heuristic is kept as a fallback (for rooms created
// before this fix, before m.direct was ever written for them) -- if it
// finds a match, this backfills m.direct so every client agrees on it from
// then on, self-healing existing duplicate-prone rooms without needing a
// migration script.
export async function findOrCreateDirectRoom(client, targetMxid) {
  const direct = client.getAccountData('m.direct')?.getContent() || {};
  const knownRoom = (direct[targetMxid] || [])
    .map((roomId) => client.getRoom(roomId))
    .find((room) => room && room.getMyMembership() !== 'leave' && room.getMyMembership() !== 'ban');
  if (knownRoom) {
    return knownRoom.roomId;
  }

  const existing = client.getRooms().find((room) => {
    const members = room.getMembersWithMembership('join').concat(room.getMembersWithMembership('invite'));
    return members.length === 2 && members.some((m) => m.userId === targetMxid);
  });
  if (existing) {
    await addDirectRoomAccountData(client, targetMxid, existing.roomId);
    return existing.roomId;
  }

  const { room_id } = await client.createRoom({
    is_direct: true,
    invite: [targetMxid],
    initial_state: [
      { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    ],
  });
  await addDirectRoomAccountData(client, targetMxid, room_id);
  return room_id;
}

// Cleans up the leftover duplicate DM rooms from before findOrCreateDirectRoom()
// read/wrote m.direct (see its doc comment) -- those old rooms are real,
// separate rooms on the server, not just a display glitch, so fixing the
// lookup going forward doesn't remove the ones that already exist. Confirmed
// live on a real account: the same contact ("oczko") had 4+ separate DM
// rooms, and which one a given client happened to open depended on lookup
// order -- explaining reports like "this conversation is empty" on one
// client while another shows real history for what looks like the same
// person.
//
// Run once per session, after sync. For every 1:1-shaped room (exactly 2
// members, matching findOrCreateDirectRoom's own heuristic) grouped by the
// other participant:
// - if more than one room has real messages, this is ambiguous (possibly
//   two genuinely separate historical conversations) -- leave all of them
//   alone, just repoint m.direct at whichever was most recently active so
//   new chats go to the right place;
// - otherwise, the room with a message (or, if none have one, the oldest
//   by room-creation time -- the duplicate is always the one created later
//   by a client that failed to find the original) is canonical: point
//   m.direct at it and leave the empty duplicates, since a room with zero
//   messages has nothing to lose by leaving it (the same action the room
//   list's own "Delete this conversation" swipe already performs on
//   purpose).
export async function consolidateDuplicateDirectRooms(client) {
  const ownUserId = client.getUserId();
  const rooms = client
    .getRooms()
    .filter((r) => r.getMyMembership() === 'join' || r.getMyMembership() === 'invite');

  const byTarget = new Map();
  for (const room of rooms) {
    const members = room.getMembersWithMembership('join').concat(room.getMembersWithMembership('invite'));
    if (members.length !== 2) {
      continue;
    }
    const other = members.find((m) => m.userId !== ownUserId);
    if (!other) {
      continue;
    }
    const list = byTarget.get(other.userId) || [];
    list.push(room);
    byTarget.set(other.userId, list);
  }

  // Checks for a message-shaped event whether or not it's currently
  // decryptable -- this device may not have unlocked chat history yet (see
  // the "Unlock chat history" flow), in which case a room with real history
  // still shows its messages as the raw 'm.room.encrypted' wire type until
  // decrypted. Treating only 'm.room.message' as "has content" would
  // misclassify that room as empty and risk leaving it instead of the
  // actually-empty duplicate.
  const hasMessage = (room) =>
    room
      .getLiveTimeline()
      .getEvents()
      .some((ev) => ev.getType() === 'm.room.message' || ev.getType() === 'm.room.encrypted');
  const createdAt = (room) => room.currentState.getStateEvents('m.room.create', '')?.getTs() ?? Infinity;

  for (const [targetMxid, roomsForTarget] of byTarget) {
    if (roomsForTarget.length < 2) {
      continue;
    }

    const withMessages = roomsForTarget.filter(hasMessage);
    let canonical;
    let duplicatesToLeave;
    if (withMessages.length > 1) {
      canonical = [...withMessages].sort(
        (a, b) => (b.getLastActiveTimestamp() || 0) - (a.getLastActiveTimestamp() || 0),
      )[0];
      duplicatesToLeave = [];
    } else if (withMessages.length === 1) {
      canonical = withMessages[0];
      duplicatesToLeave = roomsForTarget.filter((r) => r !== canonical);
    } else {
      const sortedByAge = [...roomsForTarget].sort((a, b) => createdAt(a) - createdAt(b));
      canonical = sortedByAge[0];
      duplicatesToLeave = sortedByAge.slice(1);
    }

    const direct = client.getAccountData('m.direct')?.getContent() || {};
    const existingIds = direct[targetMxid] || [];
    if (existingIds.length !== 1 || existingIds[0] !== canonical.roomId) {
      await client.setAccountData('m.direct', { ...direct, [targetMxid]: [canonical.roomId] });
    }

    for (const dup of duplicatesToLeave) {
      try {
        await client.leave(dup.roomId);
      } catch (e) {
        console.error('larpnet chat: failed to leave duplicate DM room', dup.roomId, e);
      }
    }
  }
}
