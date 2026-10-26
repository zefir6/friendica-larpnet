import { NotificationCountType, ReceiptType } from 'matrix-js-sdk';

// Unread counts, read receipts, per-room mute and "is the user looking at
// this room right now" -- see addon/larpnet_matrix/CLAUDE.md "Chat
// notifications". Mute itself is a server-side operation
// (POST /larpnet_matrix/mute, larpnet_matrix_mute_endpoint()) so timed mutes
// expire even with no client running; this side only reads the resulting
// push rule + account data, which arrive over /sync like anything else.

export const MUTE_ACCOUNT_DATA = 'pl.larpnet.mute_until';

// Synapse's own notification count, which already excludes muted rooms
// (a mute push rule has no 'notify' action, so nothing in the room counts).
export function roomUnreadCount(room) {
  return room.getUnreadNotificationCount(NotificationCountType.Total) || 0;
}

// Same number the server hands the push gateway as counts.unread: how many
// rooms have anything unread. Used for the bubble badge.
export function unreadRoomCount(rooms) {
  return rooms.filter((r) => r.getMyMembership() === 'join' && roomUnreadCount(r) > 0).length;
}

// The per-room override rule larpnet_matrix_set_mute() writes (also what
// Element and the Rust SDK call "mute"): rule_id = room id, no notify.
export function isRoomMuted(client, roomId) {
  const rule = client.pushRules?.global?.override?.find((r) => r.rule_id === roomId);
  return !!rule && rule.enabled !== false && !(rule.actions || []).includes('notify');
}

// Unix millis the mute ends at, or null when permanent / not muted.
export function muteUntil(client, roomId) {
  const until = client.getAccountData(MUTE_ACCOUNT_DATA)?.getContent()?.rooms?.[roomId];
  return typeof until === 'number' ? until : null;
}

export const MUTE_OPTIONS = [
  { label: '1 godz.', ms: 3600e3 },
  { label: '8 godz.', ms: 8 * 3600e3 },
  { label: '24 godz.', ms: 24 * 3600e3 },
  { label: '1 tydzień', ms: 7 * 24 * 3600e3 },
  { label: 'Do odwołania', ms: null },
];

// POST /larpnet_matrix/mute. Same auth as encryption.js's encryptionApi()
// (session + X-CSRF-Token, the token minted for 'larpnet_matrix_encryption').
export async function muteApi(config, body) {
  const res = await fetch('larpnet_matrix/mute', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': config.csrfToken || '' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error('mute endpoint failed: ' + res.status);
  }
  return res.json();
}

export function muteRoom(config, roomId, durationMs) {
  return muteApi(config, {
    action: 'mute',
    room_id: roomId,
    until: durationMs === null ? null : Date.now() + durationMs,
  });
}

export function unmuteRoom(config, roomId) {
  return muteApi(config, { action: 'unmute', room_id: roomId });
}

// Read receipt up to the newest event in the room, unless already there.
// Without these, unread counts (and the phones' badges) only ever cleared
// when some *other* client marked the room read.
export async function markRoomRead(client, room) {
  const events = room.getLiveTimeline().getEvents();
  const last = [...events].reverse().find((ev) => ev.getId() && !ev.getId().startsWith('~') && !ev.isState?.());
  if (!last || room.hasUserReadEvent(client.getUserId(), last.getId())) {
    return;
  }
  await client.sendReadReceipt(last, ReceiptType.Read);
}

// --- "Is the user actually looking at the chat?" ---------------------------
//
// True when this document is visible and focused and, inside the corner
// widget's iframe, the panel is open (js/matrix-chat-widget.js posts
// 'larpnet-chat-panel' on open/close). Read receipts are only sent while
// active, and the service worker skips a chat notification for the room an
// active client reports open (see view/theme/larpnet/js/sw.js).

let panelOpen = window.parent === window;
const listeners = new Set();
const panelOpenedListeners = new Set();

export function isChatActive() {
  return panelOpen && document.visibilityState === 'visible' && document.hasFocus();
}

export function onChatActivityChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Corner panel went from closed to open (the bubble or a "message" button).
export function onPanelOpened(fn) {
  panelOpenedListeners.add(fn);
  return () => panelOpenedListeners.delete(fn);
}

function emit() {
  listeners.forEach((fn) => fn(isChatActive()));
}

window.addEventListener('message', (e) => {
  if (e.origin === location.origin && e.source === window.parent && e.data?.type === 'larpnet-chat-panel') {
    const wasOpen = panelOpen;
    panelOpen = !!e.data.open;
    emit();
    if (panelOpen && !wasOpen) {
      panelOpenedListeners.forEach((fn) => fn());
    }
  }
});
document.addEventListener('visibilitychange', emit);
window.addEventListener('focus', emit);
window.addEventListener('blur', emit);

// Tells the service worker which room this client shows, and whether the
// user is looking at it. Re-sent every 20 s while active, since a service
// worker can be stopped (losing its in-memory state) at any time; it treats
// reports older than 60 s as gone.
let reportedRoomId = null;
function reportToServiceWorker() {
  try {
    navigator.serviceWorker?.controller?.postMessage({
      type: 'larpnet-chat-state',
      roomId: reportedRoomId,
      active: isChatActive(),
    });
  } catch (e) {
    // No service worker: nothing to suppress, notifications just show.
  }
}

export function setReportedRoom(roomId) {
  reportedRoomId = roomId;
  reportToServiceWorker();
}

onChatActivityChange(reportToServiceWorker);
setInterval(() => {
  if (isChatActive()) {
    reportToServiceWorker();
  }
}, 20000);

// Total unread rooms, for the corner bubble's badge (the iframe's parent).
export function reportUnreadToParent(count) {
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'larpnet-chat-unread', count }, location.origin);
  }
}
