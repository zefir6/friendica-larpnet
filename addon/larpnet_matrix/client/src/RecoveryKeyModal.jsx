import { useState } from 'preact/hooks';

/**
 * Two modes, matching recovery.js's getRecoveryStatus() values:
 * - 'setup': first time ever for this account -- show the freshly generated
 *   recoveryKey once, require an explicit "I've saved it" before closing
 *   (there's no way to see it again -- we never keep a copy).
 * - 'restore': secret storage/key backup already exist elsewhere -- let the
 *   user enter their saved recovery key, or skip (this device just won't
 *   be able to decrypt old history until they enter it some other time).
 */
export function RecoveryKeyModal({ mode, recoveryKey, onConfirmSetup, onSubmitRestore, onSkip }) {
  const [input, setInput] = useState('');
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleRestoreSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(false);
    const ok = await onSubmitRestore(input);
    setSubmitting(false);
    if (!ok) {
      setError(true);
    }
  };

  return (
    <div class="lnc-picker-overlay">
      <div class="lnc-picker lnc-recovery-modal" onClick={(e) => e.stopPropagation()}>
        {mode === 'setup' ? (
          <>
            <div class="lnc-picker-header">
              <span>Zapisz swój klucz odzyskiwania</span>
            </div>
            <p class="lnc-recovery-text">
              Ten klucz pozwala odczytać historię czatu na nowym urządzeniu lub w innej
              przeglądarce. Zapisz go w bezpiecznym miejscu (np. menedżerze haseł) --
              nikt inny, w tym administrator serwera, go nie zna i nie może go odzyskać.
            </p>
            <code class="lnc-recovery-key">{recoveryKey}</code>
            <button type="button" class="lnc-new-chat-btn" onClick={onConfirmSetup}>
              Zapisałem/-am klucz
            </button>
          </>
        ) : (
          <form onSubmit={handleRestoreSubmit}>
            <div class="lnc-picker-header">
              <span>Odblokuj historię czatu</span>
            </div>
            <p class="lnc-recovery-text">
              To nowe urządzenie/przeglądarka -- wpisz swój klucz odzyskiwania, aby
              odczytać wcześniejsze wiadomości. Możesz to zrobić później -- nowe
              wiadomości będą działać już teraz.
            </p>
            <input
              type="text"
              class="lnc-picker-search"
              placeholder="Klucz odzyskiwania…"
              value={input}
              onInput={(e) => setInput(e.currentTarget.value)}
              autoFocus
            />
            {error && <div class="lnc-recovery-error">Nieprawidłowy klucz. Spróbuj ponownie.</div>}
            <div class="lnc-recovery-actions">
              <button type="button" class="lnc-header-btn" onClick={onSkip} disabled={submitting}>
                Później
              </button>
              <button type="submit" class="lnc-new-chat-btn" disabled={submitting || !input.trim()}>
                {submitting ? 'Sprawdzanie…' : 'Odblokuj'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
