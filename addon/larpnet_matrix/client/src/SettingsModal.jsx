import { useState } from 'preact/hooks';

/**
 * The destructive reset action, plus a non-destructive "restore" entry
 * point -- App.jsx's `getRecoveryStatus()` check only ever runs once, on
 * page load, so a user who dismissed that auto-prompt (or whose session
 * ended before finishing it) had no way back to it for the rest of that
 * page load short of reloading and hoping it re-prompts. `onRestoreRecovery`
 * re-opens the exact same `RecoveryKeyModal` mode="restore" flow on demand;
 * safe to run even when already unlocked (see recovery.js's
 * restoreFromRecoveryKey()). Reset is kept as its own small modal (rather
 * than folding straight into RecoveryKeyModal) so there's a deliberate "are
 * you sure" step before the actual reset flow opens; App.jsx's
 * onResetRecovery closes this and opens `RecoveryKeyModal` mode="reset"
 * (see recovery.js's resetRecovery()).
 *
 * Restore/reset only make sense in private encryption mode (or when the
 * server has no escrow configured, `encryption` null) -- in standard mode
 * the client unlocks itself, so those are replaced by "show my phrase" and
 * the switch to private mode (see encryption.js).
 */
export function SettingsModal({
  onClose,
  onResetRecovery,
  onRestoreRecovery,
  encryption,
  onSwitchToPrivate,
  onSwitchToStandard,
  onShowPhrase,
  showTimestamps,
  onShowTimestampsChange,
  showMessageTimes,
  onShowMessageTimesChange,
  // This user's own mxid, shown copyable so they can be added from any
  // other Matrix client.
  userId,
  // Corner-bubble popup only (App.jsx passes no handler in full-page mode,
  // where the list always sits beside the conversation).
  popupLayout,
  onPopupLayoutChange,
}) {
  // null | 'reset' | 'standard' -- which confirmation step is showing.
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(false);
  const [switchError, setSwitchError] = useState(null);
  const [copied, setCopied] = useState(false);
  const copyUserId = async () => {
    try {
      await navigator.clipboard.writeText(userId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      // Clipboard denied (e.g. insecure context) -- the field is still
      // selectable by hand.
    }
  };
  const isStandard = encryption?.mode === 'standard' && !!encryption?.passphrase;
  const isPrivate = encryption?.mode === 'private';

  const confirmStandard = async () => {
    setBusy(true);
    setSwitchError(null);
    const err = await onSwitchToStandard();
    setBusy(false);
    if (err) {
      setSwitchError(err);
    } else {
      setConfirming(null);
    }
  };

  return (
    <div class="lnc-picker-overlay" onClick={onClose}>
      <div class="lnc-picker" onClick={(e) => e.stopPropagation()}>
        <div class="lnc-picker-header">
          <span>Ustawienia</span>
          <button type="button" class="lnc-picker-close" onClick={onClose}><i class="ri ri-close-line" aria-hidden="true"></i></button>
        </div>
        <div class="lnc-room-info-body">
          {!confirming ? (
            <>
              {userId && (
                <div class="lnc-settings-mxid">
                  <span class="lnc-settings-mxid-label">Twój adres Matrix</span>
                  <div class="lnc-settings-mxid-row">
                    <input type="text" class="lnc-picker-search" readonly value={userId} onFocus={(e) => e.currentTarget.select()} />
                    <button type="button" class="lnc-btn-secondary" onClick={copyUserId}>
                      {copied ? 'Skopiowano' : 'Kopiuj'}
                    </button>
                  </div>
                </div>
              )}
              <label class="lnc-settings-toggle">
                <span>Pokazuj godziny w liście czatów</span>
                <input
                  type="checkbox"
                  checked={showTimestamps}
                  onChange={(e) => onShowTimestampsChange(e.target.checked)}
                />
              </label>
              <label class="lnc-settings-toggle">
                <span>Pokazuj godzinę przy każdej wiadomości</span>
                <input
                  type="checkbox"
                  checked={showMessageTimes}
                  onChange={(e) => onShowMessageTimesChange(e.target.checked)}
                />
              </label>
              {onPopupLayoutChange && (
                <label class="lnc-settings-toggle">
                  <span>Lista rozmów obok czatu (szersze okienko)</span>
                  <input
                    type="checkbox"
                    checked={popupLayout === 'side'}
                    onChange={(e) => onPopupLayoutChange(e.target.checked ? 'side' : 'switch')}
                  />
                </label>
              )}
              {(isStandard || isPrivate) && (
                <p class="lnc-recovery-text">
                  <strong>Szyfrowanie: {isStandard ? 'standardowe' : 'prywatne'}</strong>
                  <br />
                  {isStandard
                    ? 'Larpnet pamięta klucz do Twojej historii czatu, więc działa ona automatycznie na każdym urządzeniu. Administratorzy serwera mogą technicznie uzyskać do niej dostęp.'
                    : 'Tylko Ty znasz klucz do historii czatu -- administratorzy nie mają do niej dostępu. Na nowym urządzeniu trzeba go wpisać.'}
                </p>
              )}
              {isStandard ? (
                <>
                  <button type="button" class="lnc-settings-restore" onClick={onShowPhrase}>
                    Pokaż frazę odzyskiwania
                  </button>
                  <button type="button" class="lnc-settings-restore" onClick={onSwitchToPrivate}>
                    Włącz tryb prywatny
                  </button>
                </>
              ) : (
                <>
                  <button type="button" class="lnc-settings-restore" onClick={onRestoreRecovery}>
                    Odblokuj historię czatu
                  </button>
                  {isPrivate && (
                    <button type="button" class="lnc-settings-restore" onClick={() => setConfirming('standard')}>
                      Wróć do trybu standardowego
                    </button>
                  )}
                  <button type="button" class="lnc-room-info-leave" onClick={() => setConfirming('reset')}>
                    Resetuj klucz odzyskiwania
                  </button>
                </>
              )}
            </>
          ) : confirming === 'standard' ? (
            <>
              <p class="lnc-recovery-text">
                Larpnet znów będzie przechowywał klucz do Twojej historii czatu, więc nie
                trzeba go będzie wpisywać na nowych urządzeniach. Administratorzy serwera będą
                mogli technicznie uzyskać dostęp do Twoich wiadomości. Wymaga odblokowanej
                historii czatu na tym urządzeniu.
              </p>
              {switchError && <div class="lnc-recovery-error">{switchError}</div>}
              <div class="lnc-recovery-actions">
                <button type="button" class="lnc-btn-secondary" onClick={() => setConfirming(null)} disabled={busy}>
                  Anuluj
                </button>
                <button type="button" class="lnc-new-chat-btn" onClick={confirmStandard} disabled={busy}>
                  {busy ? 'Zmienianie…' : 'Tak, zmień'}
                </button>
              </div>
            </>
          ) : (
            <>
              <p class="lnc-recovery-text">
                To usunie dostęp do historii czatu za pomocą starego klucza -- wiadomości
                wysłane przed resetem nie będą już do odczytania na nowych urządzeniach.
                Nowe wiadomości będą działać normalnie. Tej operacji nie można odwrócić.
              </p>
              <div class="lnc-recovery-actions">
                <button type="button" class="lnc-btn-secondary" onClick={() => setConfirming(null)}>
                  Anuluj
                </button>
                <button type="button" class="lnc-room-info-leave" onClick={onResetRecovery}>
                  Tak, resetuj
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
