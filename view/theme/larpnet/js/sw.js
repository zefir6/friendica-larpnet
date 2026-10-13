/* Service Worker – larpnet push notifications */

self.addEventListener('install', function (event) { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(clients.claim()); });

// --- Chat (Matrix) messages --------------------------------------------------
//
// Chat pushes come over the same ntfy topic as classic notifications, sent by
// addon/larpnet_matrix's push gateway (larpnet_matrix_push_deliver_web()),
// tagged 'larpnet-chat' with room/event ids in the click URL. Two extras:
//  - one notification per room (tag = room id), replaced by newer messages
//    instead of stacking;
//  - none at all for a room the user is already looking at. Each chat
//    client reports {roomId, active} here (client/src/notifications.js);
//    reports are kept in memory, which is lost whenever the browser stops
//    this worker, so a missing report just means "show it".

const CHAT_TAG = 'larpnet-chat';
const CHAT_STATE_TTL_MS = 60000;
const chatState = new Map(); // clientId -> {roomId, active, at}

self.addEventListener('message', function (event) {
    const data = event.data || {};
    const id = event.source && event.source.id;
    if (data.type === 'larpnet-chat-state' && id) {
        chatState.set(id, { roomId: data.roomId || null, active: !!data.active, at: Date.now() });
    }
    // push.js's SSE fallback hands its messages over, so both paths share
    // the logic below.
    if (data.type === 'larpnet-ntfy-message' && data.message) {
        event.waitUntil(handleMessage(data.message));
    }
});

function chatRoomOf(msg) {
    const tags = msg.tags || [];
    const click = msg.click || '';
    if (tags.indexOf(CHAT_TAG) === -1 && click.indexOf('/larpnet_matrix?') === -1) {
        return null;
    }
    try {
        return new URL(click).searchParams.get('room');
    } catch (e) {
        return null;
    }
}

async function isRoomOnScreen(roomId) {
    const live = new Set((await clients.matchAll({ includeUncontrolled: true })).map(function (c) { return c.id; }));
    const now = Date.now();
    for (const [id, s] of chatState) {
        if (!live.has(id) || now - s.at > CHAT_STATE_TTL_MS) {
            chatState.delete(id);
        } else if (s.active && s.roomId === roomId) {
            return true;
        }
    }
    return false;
}

async function handleMessage(msg) {
    const roomId = chatRoomOf(msg);

    if (roomId) {
        // Lets the chat bubble on open pages refresh its unread badge now
        // rather than at its next 30 s poll.
        const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        windows.forEach(function (c) { c.postMessage({ type: 'larpnet-chat-push', roomId: roomId }); });

        if (await isRoomOnScreen(roomId)) {
            return;
        }
    }

    const title   = msg.title || 'larpnet';
    const options = {
        body:  msg.message || msg.body || '',
        icon:  msg.icon   || '/images/friendica.svg',
        badge: '/images/friendica.svg',
        tag:   roomId ? 'chat:' + roomId : String(msg.id || ''),
        // Re-alert for a newer message replacing an older one in the same room.
        renotify: !!roomId,
        data:  { url: msg.click || msg.url || '/' },
    };

    return self.registration.showNotification(title, options);
}

self.addEventListener('push', function (event) {
    if (!event.data) return;

    let data = {};
    try { data = event.data.json(); } catch (e) { return; }

    // ntfy web push payload: { event: "message", subscription_id: "...", message: {...} }
    if (data.event === 'subscription_expiring') {
        // ntfy signals that the subscription will expire soon — silently skip
        return;
    }

    event.waitUntil(handleMessage(data.message || data));
});

self.addEventListener('notificationclick', function (event) {
    event.notification.close();

    const target = (event.notification.data || {}).url || '/';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
            for (const client of list) {
                if (client.url.startsWith(self.location.origin) && 'focus' in client) {
                    client.navigate(target);
                    return client.focus();
                }
            }
            return clients.openWindow(target);
        })
    );
});
