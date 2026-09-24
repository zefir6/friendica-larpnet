import { useState } from 'preact/hooks';

/**
 * Currently just the one destructive action -- reset recovery key. Kept as
 * its own small modal (rather than folding straight into RecoveryKeyModal)
 * so there's a deliberate "are you sure" step before the actual reset flow
 * opens; App.jsx's onResetRecovery closes this and opens
 * `RecoveryKeyModal` mode="reset" (see recovery.js's resetRecovery()).
 */
export function SettingsModal({ onClose, onResetRecovery }) {
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
            <button type="button" class="lnc-room-info-leave" onClick={() => setConfirming(true)}>
              Resetuj klucz odzyskiwania
            </button>
          ) : (
            <>
              <p class="lnc-recovery-text">
                To usunie dostęp do historii czatu za pomocą starego klucza -- wiadomości
                wysłane przed resetem nie będą już do odczytania na nowych urządzeniach.
                Nowe wiadomości będą działać normalnie. Tej operacji nie można odwrócić.
              </p>
              <div class="lnc-recovery-actions">
                <button type="button" class="lnc-header-btn" onClick={() => setConfirming(false)}>
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
