import { useState } from 'preact/hooks';
import { roomDisplayName, formatRelativeTime, avatarUrlForUserId, roomPeerUserId, lastMessagePreview } from './matrix.js';
import { Avatar } from './Avatar.jsx';
import { roomUnreadCount, isRoomMuted } from './notifications.js';

/**
 * `onLeft(roomId)` mirrors `RoomInfoModal`'s own leave flow (same
 * `client.leave()` call) -- deleting a conversation here is really "leave
 * this room", same as the mobile apps' room-list swipe-to-delete. Kept as
 * a per-row hover/tap "×" with an inline confirm step (not a
 * `window.confirm()`) to match `SettingsModal`'s existing
 * click-to-reveal-confirm pattern rather than introducing a second one.
 */
export function RoomList({ rooms, selectedRoomId, onSelect, client, onNewChat, collapsed, contacts, serverName, onLeft, showTimestamps, width }) {
  const [confirmingRoomId, setConfirmingRoomId] = useState(null);
  const [busyRoomId, setBusyRoomId] = useState(null);

  if (collapsed) {
    return null;
  }

  const handleDelete = async (roomId) => {
    setBusyRoomId(roomId);
    try {
      await client.leave(roomId);
      onLeft(roomId);
    } catch (e) {
      // Best-effort -- row just stops being busy so the user can retry;
      // no dedicated error slot in this compact a row.
    }
    setBusyRoomId(null);
    setConfirmingRoomId(null);
  };

  return (
    <div class="lnc-room-list" style={width ? { width: width + 'px' } : undefined}>
      <div class="lnc-room-list-top">
        <button type="button" class="lnc-new-chat-btn" onClick={onNewChat}>
          <i class="ri ri-chat-new-line" aria-hidden="true"></i>
          <span>Nowy czat</span>
        </button>
      </div>
      {rooms.length === 0 && <div class="lnc-room-list-empty">Brak rozmów</div>}
      {rooms.map((room) => {
        const lastActive = room.getLastActiveTimestamp();
        // Muted rooms never count (Synapse sees no 'notify' action), so
        // this is 0 for them; the bell icon says why.
        const unread = roomUnreadCount(room);
        const muted = isRoomMuted(client, room.roomId);
        const name = roomDisplayName(room, client, contacts);
        const avatarUrl = avatarUrlForUserId(roomPeerUserId(room, client), serverName, contacts);
        const preview = lastMessagePreview(room, client);
        return (
          <div key={room.roomId} class="lnc-room-row">
            <button
              type="button"
              class={
                'lnc-room-item' +
                (room.roomId === selectedRoomId ? ' lnc-room-item-active' : '') +
                (unread > 0 ? ' lnc-room-item-unread' : '')
              }
              onClick={() => onSelect(room.roomId)}
            >
              <Avatar url={avatarUrl} name={name} size={44} />
              <span class="lnc-room-item-text">
                <span class="lnc-room-item-line">
                  <span class="lnc-room-item-name">{name}</span>
                  {muted && <i class="ri ri-notification-off-line lnc-room-item-muted" title="Wyciszona" aria-label="Wyciszona"></i>}
                  {showTimestamps && lastActive > 0 && (
                    <span class="lnc-room-item-timestamp">{formatRelativeTime(lastActive)}</span>
                  )}
                </span>
                <span class="lnc-room-item-line">
                  <span class="lnc-room-item-preview">{preview || '\u00a0'}</span>
                  {unread > 0 && (
                    <span class="lnc-room-item-badge" aria-label={unread + ' nieprzeczytanych'}>
                      {unread > 99 ? '99+' : unread}
                    </span>
                  )}
                </span>
              </span>
            </button>
            {confirmingRoomId === room.roomId ? (
              <span class="lnc-room-delete-confirm">
                <button
                  type="button"
                  class="lnc-room-delete-confirm-btn"
                  disabled={busyRoomId === room.roomId}
                  onClick={() => handleDelete(room.roomId)}
                >
                  Usuń
                </button>
                <button
                  type="button"
                  class="lnc-room-delete-cancel-btn"
                  disabled={busyRoomId === room.roomId}
                  onClick={() => setConfirmingRoomId(null)}
                >
                  Anuluj
                </button>
              </span>
            ) : (
              <button
                type="button"
                class="lnc-room-delete-btn"
                title="Usuń rozmowę"
                aria-label="Usuń rozmowę"
                onClick={() => setConfirmingRoomId(room.roomId)}
              >
                <i class="ri ri-close-line" aria-hidden="true"></i>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
