import { createClient } from 'matrix-js-sdk';

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

  const client = createClient({
    baseUrl: cfg.homeserverUrl,
    userId: res.user_id,
    accessToken: res.access_token,
    deviceId: res.device_id,
  });

  // Rust-crypto backend. No cross-signing/secret-storage bootstrap here on
  // purpose -- see addon/larpnet_matrix/CLAUDE.md "Why there's no device
  // verification UI". A single device can encrypt/decrypt in a room it's
  // a member of without ever setting up cross-signing; that's only needed
  // to establish trust *across* multiple devices, which this v1 client
  // doesn't attempt to model.
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

  return client;
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
