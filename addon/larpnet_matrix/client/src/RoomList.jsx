function roomDisplayName(room, client) {
  const name = room.name;
  if (name && name !== 'Empty room') {
    return name;
  }
  const other = room.getMembersWithMembership('join')
    .concat(room.getMembersWithMembership('invite'))
    .find((m) => m.userId !== client.getUserId());
  return other?.name || other?.userId || 'Rozmowa';
}

export function RoomList({ rooms, selectedRoomId, onSelect, client, onNewChat, collapsed }) {
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
          {roomDisplayName(room, client)}
        </button>
      ))}
    </div>
  );
}
