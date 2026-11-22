/**
 * One Matrix device per *running* chat, not one per browser.
 *
 * The crypto store (IndexedDB, see matrix.js's cryptoDatabasePrefix) holds
 * the device's Olm account. matrix-sdk-crypto assumes a single process owns
 * it: two chats running on the same store at once (two tabs, the corner
 * widget plus the full-screen page, ...) each keep their own in-memory copy
 * and save it back over the other's. Confirmed on test.larpnet.pl
 * 2026-11-22: a device's saved account went back to before keys it had
 * already published, after which every `/keys/upload` failed with 400 "One
 * time key ... already exists" and the device never uploaded keys again.
 *
 * So instead of one device ID per browser, each account has a few device
 * "slots" in this browser. A running chat holds its slot with a Web Lock
 * (released automatically when the page goes away) and only ever opens that
 * slot's store. One chat open: always slot 0, nothing changes. Several at
 * once: each gets its own device, side by side. A slot's device stays
 * registered while closed, keeps receiving room keys, and is reused next
 * time.
 *
 * Device IDs are also never reused for a *fresh* store: if the slot's store
 * is gone (cleared site data, the 2026-09 store rename), the slot gets a new
 * device ID. Re-creating an Olm account under an existing device ID left
 * the server holding one-time keys signed by the old identity, so nobody
 * could start an encrypted session with that device.
 */
const SLOT_COUNT = 3;
// How long a new page waits for slot 0 before taking another slot: a
// Friendica navigation reloads the chat iframe, and the old page's lock is
// only released once it has unloaded.
const HANDOVER_WAIT_MS = 2500;
const LEGACY_DEVICE_ID_KEY = 'larpnet_chat_device_id';
const DEVICES_KEY_PREFIX = 'larpnet_chat_devices:';

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    /* storage unavailable: a new device next time, same as before */
  }
}

function readDeviceIds(userId) {
  try {
    const ids = JSON.parse(storageGet(DEVICES_KEY_PREFIX + userId) || '[]');
    return Array.isArray(ids) ? ids : [];
  } catch (e) {
    return [];
  }
}

function writeDeviceIds(userId, ids) {
  storageSet(DEVICES_KEY_PREFIX + userId, JSON.stringify(ids));
}

function newDeviceId() {
  return 'larpnet_web_' + crypto.randomUUID();
}

export function cryptoStorePrefix(userId, deviceId) {
  return `${userId}::${deviceId}`;
}

// True/false when the browser can list databases, null when it can't
// (then the caller keeps the existing device ID, i.e. the old behaviour).
async function cryptoStoreExists(userId, deviceId) {
  if (!indexedDB.databases) {
    return null;
  }
  try {
    const name = cryptoStorePrefix(userId, deviceId) + '::matrix-sdk-crypto';
    return (await indexedDB.databases()).some((d) => d.name === name);
  } catch (e) {
    return null;
  }
}

/**
 * Resolves with a release function once the lock is held, or null if it
 * isn't available (ifAvailable) or the wait was aborted (signal).
 */
function requestLock(name, options) {
  return new Promise((resolve) => {
    navigator.locks
      .request(name, options, (lock) => {
        if (!lock) {
          resolve(null);
          return undefined;
        }
        // Held until release() is called or the page goes away.
        return new Promise((release) => resolve(release));
      })
      .catch(() => resolve(null));
  });
}

function lockName(userId, slot) {
  return `lnc-chat-slot:${userId}:${slot}`;
}

async function acquireSlot(userId, onWaiting) {
  if (!navigator.locks) {
    return { slot: 0, release: () => {} };
  }
  let release = await requestLock(lockName(userId, 0), { ifAvailable: true });
  if (release) {
    return { slot: 0, release };
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), HANDOVER_WAIT_MS);
  release = await requestLock(lockName(userId, 0), { signal: abort.signal });
  clearTimeout(timer);
  if (release) {
    return { slot: 0, release };
  }
  for (let slot = 1; slot < SLOT_COUNT; slot++) {
    release = await requestLock(lockName(userId, slot), { ifAvailable: true });
    if (release) {
      return { slot, release };
    }
  }

  // Every slot is in use: wait for whichever frees up first.
  onWaiting?.();
  const waiting = new AbortController();
  return new Promise((resolve) => {
    let won = false;
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      requestLock(lockName(userId, slot), { signal: waiting.signal }).then((rel) => {
        if (!rel) {
          return;
        }
        if (won) {
          rel();
          return;
        }
        won = true;
        waiting.abort();
        resolve({ slot, release: rel });
      });
    }
  });
}

/**
 * Claims a free device slot for `userId` in this browser and returns its
 * device ID. Keep the returned `release` for as long as the client runs
 * (the page unloading releases it anyway). `onWaiting` is called if every
 * slot is busy and this chat has to wait for one.
 *
 * `staleDeviceId` is set when the slot's previous device had lost its
 * crypto store: that device is dead (its keys on the server can never be
 * used again) and the caller should delete it on the server if it can.
 */
export async function claimDevice(userId, onWaiting) {
  const { slot, release } = await acquireSlot(userId, onWaiting);
  const ids = readDeviceIds(userId);
  let deviceId = ids[slot] || null;
  // Before slots, every account in a browser shared one device ID. Slot 0
  // adopts it for an account that already has a crypto store under it, so
  // existing users keep their device (and its keys).
  if (!deviceId && slot === 0) {
    const legacy = storageGet(LEGACY_DEVICE_ID_KEY);
    if (legacy && (await cryptoStoreExists(userId, legacy)) !== false) {
      deviceId = legacy;
    }
  }
  let staleDeviceId = null;
  if (deviceId && (await cryptoStoreExists(userId, deviceId)) === false) {
    staleDeviceId = deviceId;
    deviceId = null;
  }
  if (!deviceId) {
    deviceId = newDeviceId();
  }
  ids[slot] = deviceId;
  writeDeviceIds(userId, ids);
  return { deviceId, slot, release, staleDeviceId };
}

/**
 * Forgets this slot's device so the next start creates a new one (see
 * matrix.js's repairDevice()).
 */
export function forgetDevice(userId, deviceId) {
  const ids = readDeviceIds(userId).map((id) => (id === deviceId ? null : id));
  writeDeviceIds(userId, ids);
}
