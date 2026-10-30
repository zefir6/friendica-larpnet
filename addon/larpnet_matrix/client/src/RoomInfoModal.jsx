import { useState } from 'preact/hooks';
import { resolveDisplayName, profileUrlForUserId, avatarUrlForUserId, formatMessageTime } from './matrix.js';
import { Avatar } from './Avatar.jsx';
import { isRoomMuted, muteUntil, muteRoom, unmuteRoom, MUTE_OPTIONS } from './notifications.js';

/**
 * "Room info" overlay for the currently open conversation -- rename (group
 * rooms only; see below), member list with remove, "+ Dodaj osobę" (opens
 * the shared ContactPicker via onAddMember, see App.jsx), and "Opuść
 * rozmowę" (leave, removing yourself).
 *
 * Removing someone is offered only in a group, behind an inline confirm
 * ("Usuń z rozmowy" -> "Usunąć?" Tak / Anuluj); in a 1:1 it would just
 * end the conversation for the other person, which "Opuść rozmowę" covers.
 *
 * Renaming is hidden for a plain 1:1 DM (`others.length === 1`):
 * `roomDisplayName()` always prefers the other person's own name for a 1:1
 * over the room's `name` state event (see matrix.js), so setting one here
 * would silently have no visible effect and just confuse whoever tries it.
 * It only ever matters once a room has more than one other member.
 */
export function RoomInfoModal({ client, config, room, contacts, serverName, linkTarget, onClose, onLeft, onAddMember }) {
  const [nameInput, setNameInput] = useState(room.name || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirmingRemove, setConfirmingRemove] = useState(null);

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
    setConfirmingRemove(null);
  };

  // The push rule / account data this changes come back over /sync, which
  // re-renders this modal (App.jsx bumps on accountData), so no local state.
  const muted = isRoomMuted(client, room.roomId);
  const until = muteUntil(client, room.roomId);
  const handleMute = async (durationMs) => {
    setBusy(true);
    setError(null);
    try {
      await (durationMs === undefined ? unmuteRoom(config, room.roomId) : muteRoom(config, room.roomId, durationMs));
    } catch (e2) {
      setError('Nie udało się zmienić powiadomień. Odśwież stronę i spróbuj ponownie.');
    }
    setBusy(false);
  };

  const handleLeave = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.leave(room.roomId);
      onLeft(room.roomId);
    } catch (e2) {
      setError('Nie udało się opuścić rozmowy.');
      setBusy(false);
    }
  };

  return (
    <div class="lnc-picker-overlay" onClick={onClose} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div class="lnc-picker" role="dialog" aria-label="Informacje o rozmowie" onClick={(e) => e.stopPropagation()}>
        <div class="lnc-picker-header">
          <span>Informacje o rozmowie</span>
          <button type="button" class="lnc-picker-close" aria-label="Zamknij" onClick={onClose} autoFocus><i class="ri ri-close-line" aria-hidden="true"></i></button>
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
          <div class="lnc-room-info-notifications">
            <span class="lnc-room-info-notifications-title">
              {muted ? (until ? 'Wyciszona do ' + formatMessageTime(until) : 'Wyciszona') : 'Powiadomienia włączone'}
            </span>
            {muted ? (
              <div class="lnc-room-info-mute-options">
                <button type="button" class="lnc-btn-secondary" onClick={() => handleMute(undefined)} disabled={busy}>
                  Włącz powiadomienia
                </button>
              </div>
            ) : (
              <div class="lnc-room-info-mute-options">
                <span>Wycisz na:</span>
                {MUTE_OPTIONS.map((o) => (
                  <button key={o.label} type="button" class="lnc-btn-secondary" onClick={() => handleMute(o.ms)} disabled={busy}>
                    {o.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div class="lnc-room-info-members">
            {others.map((m) => {
              const name = resolveDisplayName(m.userId, contacts) || m.name || m.userId;
              const profileUrl = profileUrlForUserId(m.userId, serverName, contacts);
              return (
                <div key={m.userId} class="lnc-room-info-member">
                  <Avatar url={avatarUrlForUserId(m.userId, serverName, contacts)} name={name} size={28} />
                  {profileUrl ? (
                    <a class="lnc-profile-link lnc-room-info-member-name" href={profileUrl} target={linkTarget} rel="noopener" title="Otwórz profil">
                      {name}
                    </a>
                  ) : (
                    <span class="lnc-room-info-member-name">{name}</span>
                  )}
                  {isGroup &&
                    (confirmingRemove === m.userId ? (
                      <span class="lnc-room-delete-confirm">
                        <button type="button" class="lnc-room-delete-confirm-btn" onClick={() => handleRemove(m.userId)} disabled={busy}>
                          Usuń
                        </button>
                        <button type="button" class="lnc-room-delete-cancel-btn" onClick={() => setConfirmingRemove(null)} disabled={busy}>
                          Anuluj
                        </button>
                      </span>
                    ) : (
                      <button type="button" class="lnc-btn-secondary" onClick={() => setConfirmingRemove(m.userId)} disabled={busy}>
                        Usuń z rozmowy
                      </button>
                    ))}
                </div>
              );
            })}
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
