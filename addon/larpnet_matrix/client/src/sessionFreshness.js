/**
 * Keep the outbound Megolm session in step with the room's current devices.
 *
 * The web device ID is persistent, so its crypto store (IndexedDB) -- and
 * the outbound Megolm session in it -- survives page loads and is reused
 * indefinitely. A session only gets the keys of devices known when it was
 * shared; a recipient device that appeared (or whose device list we never
 * refreshed) afterwards can't decrypt anything sent in it, shown as
 * "Nie można odszyfrować wiadomości" on their side while the native apps
 * (fresh sessions) keep working.
 *
 * Before every send: force-download the device lists of the room's members,
 * compare the resulting device set with the one the current session was
 * last used with (kept in localStorage, so it survives reloads), and
 * discard the session if it differs or is unknown -- the send then starts a
 * new session and shares it with every current device. Never throws: on any
 * failure the send proceeds as before.
 */
const STORE_PREFIX = 'lnc-megolm-devices:';

function readSignature(roomId) {
  try {
    return localStorage.getItem(STORE_PREFIX + roomId);
  } catch (e) {
    return null;
  }
}

function writeSignature(roomId, signature) {
  try {
    localStorage.setItem(STORE_PREFIX + roomId, signature);
  } catch (e) {
    /* storage unavailable: next send just rotates again */
  }
}

export async function ensureFreshOutboundSession(client, roomId) {
  try {
    const crypto = client.getCrypto();
    const room = client.getRoom(roomId);
    if (!crypto || !room || !(await crypto.isEncryptionEnabledInRoom(roomId))) return;

    const userIds = room
      .getMembersWithMembership('join')
      .concat(room.getMembersWithMembership('invite'))
      .map((m) => m.userId);
    const devices = await crypto.getUserDeviceInfo(userIds, true);

    const entries = [];
    for (const [userId, byDevice] of devices) {
      for (const deviceId of byDevice.keys()) entries.push(`${userId}|${deviceId}`);
    }
    const signature = entries.sort().join(',');

    if (readSignature(roomId) !== signature) {
      await crypto.forceDiscardSession(roomId);
      writeSignature(roomId, signature);
    }
  } catch (e) {
    console.warn('larpnet_matrix: could not refresh outbound session', e);
  }
}
