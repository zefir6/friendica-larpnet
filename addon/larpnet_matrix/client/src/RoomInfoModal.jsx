import { useState } from 'preact/hooks';
import { resolveDisplayName } from './matrix.js';

/**
 * "Room info" overlay for the currently open conversation -- rename (group
 * rooms only; see below), member list with remove, "+ Dodaj osobę" (opens
 * the shared ContactPicker via onAddMember, see App.jsx), and "Opuść
 * rozmowę" (leave, removing yourself).
 *
 * Renaming is hidden for a plain 1:1 DM (`others.length === 1`):
 * `roomDisplayName()` always prefers the other person's own name for a 1:1
 * over the room's `name` state event (see matrix.js), so setting one here
 * would silently have no visible effect and just confuse whoever tries it.
 * It only ever matters once a room has more than one other member.
 */
export function RoomInfoModal({ client, room, contacts, onClose, onLeft, onAddMember }) {
  const [nameInput, setNameInput] = useState(room.name || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const others = room
    .getMembersWithMembership('join')
    .concat(room.getMembersWithMembership('invite'))
    .filter((m) => m.userId !== client.getUserId());
  const isGroup = others.length !== 1;

  const handleRename = async (e) => {
    e.preventDefault();
    const trimmed = nameInput.trim();
    if (!trimmed || trimmed === room.name) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await client.setRoomName(room.roomId, trimmed);
    } catch (e2) {
      setError('Nie udało się zmienić nazwy.');
    }
    setBusy(false);
  };

  const handleRemove = async (userId) => {
    setBusy(true);
    setError(null);
    try {
      await client.kick(room.roomId, userId);
    } catch (e2) {
      setError('Nie udało się usunąć osoby z rozmowy.');
    }
    setBusy(false);
  };

  const handleLeave = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.leave(room.roomId);
      onLeft();
    } catch (e2) {
      setError('Nie udało się opuścić rozmowy.');
      setBusy(false);
    }
  };

  return (
    <div class="lnc-picker-overlay" onClick={onClose}>
      <div class="lnc-picker" onClick={(e) => e.stopPropagation()}>
        <div class="lnc-picker-header">
          <span>Informacje o rozmowie</span>
          <button type="button" class="lnc-picker-close" onClick={onClose}>&times;</button>
        </div>
        <div class="lnc-room-info-body">
          {isGroup && (
            <form onSubmit={handleRename} class="lnc-room-info-rename">
              <input
                type="text"
                class="lnc-picker-search"
                value={nameInput}
                onInput={(e) => setNameInput(e.currentTarget.value)}
                placeholder="Nazwa rozmowy…"
              />
              <button
                type="submit"
                class="lnc-btn-secondary"
                disabled={busy || !nameInput.trim() || nameInput.trim() === room.name}
              >
                Zapisz
              </button>
            </form>
          )}
          <div class="lnc-room-info-members">
            {others.map((m) => (
              <div key={m.userId} class="lnc-room-info-member">
                <span>{resolveDisplayName(m.userId, contacts) || m.name || m.userId}</span>
                <button type="button" class="lnc-btn-secondary" onClick={() => handleRemove(m.userId)} disabled={busy}>
                  Usuń
                </button>
              </div>
            ))}
          </div>
          <button type="button" class="lnc-new-chat-btn" onClick={onAddMember} disabled={busy}>
            + Dodaj osobę
          </button>
          {error && <div class="lnc-recovery-error">{error}</div>}
          <button type="button" class="lnc-room-info-leave" onClick={handleLeave} disabled={busy}>
            Opuść rozmowę
          </button>
        </div>
      </div>
    </div>
  );
}
