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
 */
export function SettingsModal({ onClose, onResetRecovery, onRestoreRecovery }) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div class="lnc-picker-overlay" onClick={onClose}>
      <div class="lnc-picker" onClick={(e) => e.stopPropagation()}>
        <div class="lnc-picker-header">
          <span>Ustawienia</span>
          <button type="button" class="lnc-picker-close" onClick={onClose}>&times;</button>
        </div>
        <div class="lnc-room-info-body">
          {!confirming ? (
            <>
              <button type="button" class="lnc-settings-restore" onClick={onRestoreRecovery}>
                Odblokuj historię czatu
              </button>
              <button type="button" class="lnc-room-info-leave" onClick={() => setConfirming(true)}>
                Resetuj klucz odzyskiwania
              </button>
            </>
          ) : (
            <>
              <p class="lnc-recovery-text">
                To usunie dostęp do historii czatu za pomocą starego klucza -- wiadomości
                wysłane przed resetem nie będą już do odczytania na nowych urządzeniach.
                Nowe wiadomości będą działać normalnie. Tej operacji nie można odwrócić.
              </p>
              <div class="lnc-recovery-actions">
                <button type="button" class="lnc-btn-secondary" onClick={() => setConfirming(false)}>
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
