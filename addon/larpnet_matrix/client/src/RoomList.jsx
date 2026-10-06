import { useState } from 'preact/hooks';
import { roomDisplayName, formatRelativeTime } from './matrix.js';

/**
 * `onLeft(roomId)` mirrors `RoomInfoModal`'s own leave flow (same
 * `client.leave()` call) -- deleting a conversation here is really "leave
 * this room", same as the mobile apps' room-list swipe-to-delete. Kept as
 * a per-row hover/tap "×" with an inline confirm step (not a
 * `window.confirm()`) to match `SettingsModal`'s existing
 * click-to-reveal-confirm pattern rather than introducing a second one.
 */
export function RoomList({ rooms, selectedRoomId, onSelect, client, onNewChat, collapsed, contacts, onLeft, showTimestamps }) {
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
    <div class="lnc-room-list">
      <button type="button" class="lnc-new-chat-btn" onClick={onNewChat}>+ Nowy czat</button>
      {rooms.length === 0 && <div class="lnc-room-list-empty">Brak rozmów</div>}
      {rooms.map((room) => {
        const lastActive = room.getLastActiveTimestamp();
        return (
          <div key={room.roomId} class="lnc-room-row">
            <button
              type="button"
              class={'lnc-room-item' + (room.roomId === selectedRoomId ? ' lnc-room-item-active' : '')}
              onClick={() => onSelect(room.roomId)}
            >
              <span class="lnc-room-item-name">{roomDisplayName(room, client, contacts)}</span>
              {showTimestamps && lastActive > 0 && (
                <span class="lnc-room-item-timestamp">{formatRelativeTime(lastActive)}</span>
              )}
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
                onClick={() => setConfirmingRoomId(room.roomId)}
              >
                &times;
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
