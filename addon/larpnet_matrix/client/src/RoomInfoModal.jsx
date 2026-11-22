import { useEffect, useRef, useState } from 'preact/hooks';
import { resolveDisplayName, profileUrlForUserId, avatarUrlForUserId, formatMessageTime, absoluteUrl } from './matrix.js';
import { CopyButton } from './CopyButton.jsx';
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
 *
 * variant="panel": the same content as a permanent right-hand column
 * (full-screen chat on wide windows, Messenger-style, see App.jsx) instead
 * of an overlay. `title`/`avatarUrl` head the panel (linked to
 * `profileUrl`, the 1:1 peer's Larpnet profile, with "Zobacz profil" /
 * "Kopiuj link" under it -- the overlay shows those two at the top); App.jsx keys it by
 * room id so the rename field resets when the conversation changes.
 */
export function RoomInfoModal({ client, config, room, contacts, serverName, linkTarget, onClose, onLeft, onAddMember, variant, title, avatarUrl, profileUrl }) {
  const isPanel = variant === 'panel';
  const [nameInput, setNameInput] = useState(room.name || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirmingRemove, setConfirmingRemove] = useState(null);
  const closeRef = useRef(null);
  // Focus inside the dialog so Escape reaches its key handler; `autoFocus`
  // is ignored for elements mounted after page load.
  useEffect(() => {
    if (!isPanel) {
      closeRef.current?.focus();
    }
  }, []);

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

  // 1:1 only: open / copy the other person's Larpnet profile.
  const profileActions = profileUrl && (
    <div class="lnc-profile-actions">
      <a class="lnc-chip-btn" href={profileUrl} target={linkTarget} rel="noopener">
        <i class="ri ri-user-line" aria-hidden="true"></i>
        <span>Zobacz profil</span>
      </a>
      <CopyButton text={absoluteUrl(profileUrl)} label="Kopiuj link" title="Kopiuj link do profilu" />
    </div>
  );

  const content = (
    <div class="lnc-room-info-body">
      {!isPanel && profileActions}
      {isGroup && (
        <section class="lnc-info-section">
          <h3 class="lnc-info-section-title">Nazwa rozmowy</h3>
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
        </section>
      )}
      <section class="lnc-info-section">
        <h3 class="lnc-info-section-title">Powiadomienia</h3>
        <div class="lnc-room-info-notifications">
          <span class="lnc-room-info-notifications-state">
            <i class={'ri ' + (muted ? 'ri-notification-off-line' : 'ri-notification-3-line')} aria-hidden="true"></i>
            {muted ? (until ? 'Wyciszona do ' + formatMessageTime(until) : 'Wyciszona') : 'Włączone'}
          </span>
          {muted ? (
            <button type="button" class="lnc-btn-secondary" onClick={() => handleMute(undefined)} disabled={busy}>
              Włącz
            </button>
          ) : (
            <select
              class="lnc-select"
              aria-label="Wycisz rozmowę"
              disabled={busy}
              value=""
              onChange={(e) => {
                const o = MUTE_OPTIONS[Number(e.currentTarget.value)];
                e.currentTarget.value = '';
                if (o) {
                  handleMute(o.ms);
                }
              }}
            >
              <option value="" disabled>
                Wycisz…
              </option>
              {MUTE_OPTIONS.map((o, i) => (
                <option key={o.label} value={String(i)}>
                  {o.ms === null ? o.label : 'Na ' + o.label}
                </option>
              ))}
            </select>
          )}
        </div>
      </section>
      <section class="lnc-info-section">
        <h3 class="lnc-info-section-title">{isGroup ? 'Osoby (' + others.length + ')' : 'Osoba'}</h3>
        <div class="lnc-room-info-members">
          {others.map((m) => {
            const name = resolveDisplayName(m.userId, contacts) || m.name || m.userId;
            const memberProfileUrl = profileUrlForUserId(m.userId, serverName, contacts);
            const avatar = <Avatar url={avatarUrlForUserId(m.userId, serverName, contacts)} name={name} size={36} />;
            return (
              <div key={m.userId} class="lnc-room-info-member">
                {memberProfileUrl ? (
                  <a class="lnc-room-info-member-link" href={memberProfileUrl} target={linkTarget} rel="noopener" title={'Profil: ' + name}>
                    {avatar}
                    <span class="lnc-room-info-member-name">{name}</span>
                  </a>
                ) : (
                  <span class="lnc-room-info-member-link">
                    {avatar}
                    <span class="lnc-room-info-member-name">{name}</span>
                  </span>
                )}
                {memberProfileUrl && confirmingRemove !== m.userId && (
                  <CopyButton compact text={absoluteUrl(memberProfileUrl)} title={'Kopiuj link do profilu: ' + name} />
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
                    <button
                      type="button"
                      class="lnc-icon-btn lnc-icon-btn-danger"
                      title={'Usuń z rozmowy: ' + name}
                      aria-label={'Usuń z rozmowy: ' + name}
                      onClick={() => setConfirmingRemove(m.userId)}
                      disabled={busy}
                    >
                      <i class="ri ri-user-unfollow-line" aria-hidden="true"></i>
                    </button>
                  ))}
              </div>
            );
          })}
        </div>
        <button type="button" class="lnc-new-chat-btn" onClick={onAddMember} disabled={busy}>
          <i class="ri ri-user-add-line" aria-hidden="true"></i>
          <span>Dodaj osobę</span>
        </button>
      </section>
      {error && <div class="lnc-recovery-error">{error}</div>}
      <button type="button" class="lnc-room-info-leave" onClick={handleLeave} disabled={busy}>
        <i class="ri ri-logout-box-r-line" aria-hidden="true"></i>
        <span>Opuść rozmowę</span>
      </button>
    </div>
  );

  if (isPanel) {
    return (
      <aside class="lnc-room-info-panel" aria-label="Informacje o rozmowie">
        <div class="lnc-room-info-panel-head">
          {profileUrl ? (
            <a class="lnc-room-info-panel-person" href={profileUrl} target={linkTarget} rel="noopener" title={'Profil: ' + title}>
              <Avatar url={avatarUrl} name={title} size={72} />
              <span class="lnc-room-info-panel-title">{title}</span>
            </a>
          ) : (
            <span class="lnc-room-info-panel-person">
              <Avatar url={avatarUrl} name={title} size={72} />
              <span class="lnc-room-info-panel-title">{title}</span>
            </span>
          )}
          {profileActions}
          <button type="button" class="lnc-icon-btn lnc-room-info-panel-close" aria-label="Ukryj panel" title="Ukryj panel" onClick={onClose}>
            <i class="ri ri-close-line" aria-hidden="true"></i>
          </button>
        </div>
        {content}
      </aside>
    );
  }

  return (
    <div class="lnc-picker-overlay" onClick={onClose} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div class="lnc-picker" role="dialog" aria-label="Informacje o rozmowie" onClick={(e) => e.stopPropagation()}>
        <div class="lnc-picker-header">
          <span>Informacje o rozmowie</span>
          <button type="button" class="lnc-picker-close" aria-label="Zamknij" onClick={onClose} ref={closeRef}><i class="ri ri-close-line" aria-hidden="true"></i></button>
        </div>
        {content}
      </div>
    </div>
  );
}
