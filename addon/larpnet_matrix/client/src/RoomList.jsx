import { roomDisplayName, formatRelativeTime } from './matrix.js';

export function RoomList({ rooms, selectedRoomId, onSelect, client, onNewChat, collapsed, contacts, showTimestamps }) {
  if (collapsed) {
    return null;
  }
  return (
    <div class="lnc-room-list">
      <button type="button" class="lnc-new-chat-btn" onClick={onNewChat}>+ Nowy czat</button>
      {rooms.length === 0 && <div class="lnc-room-list-empty">Brak rozmów</div>}
      {rooms.map((room) => {
        const lastActive = room.getLastActiveTimestamp();
        return (
          <button
            key={room.roomId}
            type="button"
            class={'lnc-room-item' + (room.roomId === selectedRoomId ? ' lnc-room-item-active' : '')}
            onClick={() => onSelect(room.roomId)}
          >
            <span class="lnc-room-item-name">{roomDisplayName(room, client, contacts)}</span>
            {showTimestamps && lastActive > 0 && (
              <span class="lnc-room-item-timestamp">{formatRelativeTime(lastActive)}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
