import { resolveDisplayName } from './matrix.js';

function roomDisplayName(room, client, contacts) {
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

export function RoomList({ rooms, selectedRoomId, onSelect, client, onNewChat, collapsed, contacts }) {
  if (collapsed) {
    return null;
  }
  return (
    <div class="lnc-room-list">
      <button type="button" class="lnc-new-chat-btn" onClick={onNewChat}>+ Nowy czat</button>
      {rooms.length === 0 && <div class="lnc-room-list-empty">Brak rozmów</div>}
      {rooms.map((room) => (
        <button
          key={room.roomId}
          type="button"
          class={'lnc-room-item' + (room.roomId === selectedRoomId ? ' lnc-room-item-active' : '')}
          onClick={() => onSelect(room.roomId)}
        >
          {roomDisplayName(room, client, contacts)}
        </button>
      ))}
    </div>
  );
}
