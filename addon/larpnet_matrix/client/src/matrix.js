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

  // Rust-crypto backend. Cross-signing/secret-storage/key-backup setup
  // itself is NOT done here -- it's a one-time-ever, user-facing flow (see
  // recovery.js), not something to trigger silently on every login.
  await client.initRustCrypto();

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

export function dmTargetMxid(cfg) {
  if (!cfg.dm) {
    return null;
  }
  return '@' + cfg.dm + ':' + cfg.serverName;
}

// Finds an existing 1:1 room with exactly this other member, or creates
// one. "1:1" here means exactly two joined/invited members total
// (ourself + them) -- good enough for this client's only use case (the
// profile-page Chat button), not a general DM-room heuristic.
export async function findOrCreateDirectRoom(client, targetMxid) {
  const existing = client.getRooms().find((room) => {
    const members = room.getMembersWithMembership('join').concat(room.getMembersWithMembership('invite'));
    return members.length === 2 && members.some((m) => m.userId === targetMxid);
  });
  if (existing) {
    return existing.roomId;
  }

  const { room_id } = await client.createRoom({
    is_direct: true,
    invite: [targetMxid],
    initial_state: [
      { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    ],
  });
  return room_id;
}
