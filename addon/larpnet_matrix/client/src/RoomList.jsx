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

export function RoomList({ rooms, selectedRoomId, onSelect, client }) {
  return (
    <div class="lnc-room-list">
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
