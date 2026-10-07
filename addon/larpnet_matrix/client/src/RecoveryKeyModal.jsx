import { useState } from 'preact/hooks';

/**
 * Three modes:
 * - 'setup': first time ever for this account -- let the user choose
 *   between a randomly generated key or their own phrase, then show the
 *   resulting encoded key once (there's no way to see it again -- we never
 *   keep a copy).
 * - 'reset': same choose-then-show flow as 'setup', but for
 *   recovery.js's resetRecovery() instead -- used from Settings when the
 *   user deliberately wants to invalidate their old key. `onChoose` is
 *   still the prop name (App.jsx wires it to whichever function fits).
 * - 'restore': secret storage/key backup already exist elsewhere -- let
 *   the user enter their saved recovery key *or* the phrase they set it up
 *   with, or skip (this device just won't be able to decrypt old history
 *   until they enter it some other time). `legacy` = the account is being
 *   moved to standard mode but still has the user's own old key, and this
 *   device needs it once to migrate cleanly (see ensureEncryption()).
 * - 'private': same choose-then-show flow again, for switching from
 *   standard (server-held passphrase) to private encryption mode -- see
 *   encryption.js's switchToPrivate(). Cancellable before choosing.
 * - 'show_phrase': just displays `recoveryKey` (the server-held passphrase
 *   in standard mode) for export to another Matrix client.
 *
 * `recoveryKey` starts null in 'setup'/'reset' mode -- while it's null,
 * this shows the choose-your-own-phrase-or-random form; once the parent's
 * onChoose() resolves and passes the result back in as `recoveryKey`, this
 * switches to the "here it is, save it" view. Kept in one component
 * (rather than two App.jsx-level states) so the transition is a plain prop
 * change, not a route change.
 */
export function RecoveryKeyModal({ mode, recoveryKey, legacy, onChoose, onConfirmSetup, onSubmitRestore, onSkip }) {
  const [input, setInput] = useState('');
  const [passphrase, setPassphrase] = useState('');
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

  const choose = async (value) => {
    setSubmitting(true);
    setError(false);
    try {
      await onChoose(value);
    } catch (e) {
      console.error('larpnet chat: recovery key change failed', e);
      setError(true);
    }
    setSubmitting(false);
  };

  const handleChooseRandom = () => choose(undefined);

  const handleChoosePassphrase = async (e) => {
    e.preventDefault();
    const trimmed = passphrase.trim();
    if (!trimmed) {
      return;
    }
    await choose(trimmed);
  };

  if (mode === 'show_phrase') {
    return (
      <div class="lnc-picker-overlay">
        <div class="lnc-picker lnc-recovery-modal" onClick={(e) => e.stopPropagation()}>
          <div class="lnc-picker-header">
            <span>Twoja fraza odzyskiwania</span>
          </div>
          <p class="lnc-recovery-text">
            Larpnet używa jej automatycznie na wszystkich Twoich urządzeniach -- nie musisz jej
            nigdzie wpisywać. Przyda się tylko, jeśli chcesz używać innej aplikacji Matrix (np.
            Element, jako „Security Phrase”). Nie udostępniaj jej nikomu.
          </p>
          <code class="lnc-recovery-key">{recoveryKey}</code>
          <button type="button" class="lnc-new-chat-btn" onClick={onConfirmSetup}>
            Zamknij
          </button>
        </div>
      </div>
    );
  }

  if (mode === 'setup' || mode === 'reset' || mode === 'private') {
    if (!recoveryKey) {
      const isReset = mode === 'reset';
      const isPrivate = mode === 'private';
      return (
        <div class="lnc-picker-overlay">
          <div class="lnc-picker lnc-recovery-modal" onClick={(e) => e.stopPropagation()}>
            <div class="lnc-picker-header">
              <span>{isPrivate ? 'Włącz tryb prywatny' : isReset ? 'Resetuj klucz odzyskiwania' : 'Ustaw klucz odzyskiwania'}</span>
            </div>
            <p class="lnc-recovery-text">
              {isPrivate
                ? 'Larpnet przestanie przechowywać klucz do Twojej historii czatu -- administratorzy nie będą mieli dostępu do Twoich nowych wiadomości. Na każdym nowym urządzeniu trzeba będzie wpisać klucz lub frazę, którą teraz wybierzesz, a jej utrata oznacza utratę historii. Wybierz losowy klucz albo własną frazę.'
                : isReset
                ? 'Stary klucz przestanie działać, a wiadomości wysłane przed resetem nie będą już do odczytania na nowych urządzeniach. Wybierz nowy klucz -- losowy albo własną frazę.'
                : 'Ten klucz pozwala odczytać historię czatu na nowym urządzeniu lub w innej przeglądarce. Możesz wygenerować losowy klucz albo ustawić własną, łatwą do zapamiętania frazę.'}
            </p>
            <button type="button" class="lnc-new-chat-btn" onClick={handleChooseRandom} disabled={submitting}>
              {submitting ? 'Generowanie…' : 'Wygeneruj losowy klucz'}
            </button>
            <form onSubmit={handleChoosePassphrase}>
              <input
                type="text"
                class="lnc-picker-search"
                placeholder="Albo wpisz własną frazę…"
                value={passphrase}
                onInput={(e) => setPassphrase(e.currentTarget.value)}
              />
              <div class="lnc-recovery-actions">
                {isPrivate && (
                  <button type="button" class="lnc-btn-secondary" onClick={onSkip} disabled={submitting}>
                    Anuluj
                  </button>
                )}
                <button type="submit" class="lnc-new-chat-btn" disabled={submitting || !passphrase.trim()}>
                  {submitting ? 'Ustawianie…' : 'Ustaw frazę'}
                </button>
              </div>
            </form>
            {error && <div class="lnc-recovery-error">Nie udało się zmienić klucza. Odśwież stronę i spróbuj ponownie.</div>}
          </div>
        </div>
      );
    }

    // Whether THIS confirmation is for the phrase just chosen (not just whether the input is
    // non-empty right now -- `handleChooseRandom` never touches `passphrase`, so this is exactly
    // "did the choice that produced `recoveryKey` come from the phrase form"). Framed
    // differently on purpose: someone who chose a memorable phrase specifically to avoid
    // writing anything down was, before this, told to save this cryptic key as if it were
    // mandatory -- confusing/alarming ("I typed my own phrase, why is it showing me something
    // else and telling me to write THAT down?"). The phrase is fully sufficient to restore with
    // (`restoreFromRecoveryKey()` accepts it directly); this key is just an optional fallback.
    const chosePassphrase = Boolean(passphrase.trim());

    return (
      <div class="lnc-picker-overlay">
        <div class="lnc-picker lnc-recovery-modal" onClick={(e) => e.stopPropagation()}>
          <div class="lnc-picker-header">
            <span>{chosePassphrase ? 'Fraza ustawiona' : 'Zapisz swój klucz odzyskiwania'}</span>
          </div>
          <p class="lnc-recovery-text">
            {chosePassphrase
              ? 'Od teraz możesz odblokować historię czatu na nowym urządzeniu, wpisując swoją frazę -- nie musisz nigdzie jej zapisywać, wystarczy że ją pamiętasz. Poniżej masz też surowy klucz zapasowy na wszelki wypadek (np. gdybyś zapomniał/-a frazy) -- możesz go zapisać, ale to nie jest wymagane.'
              : 'Zapisz go w bezpiecznym miejscu (np. menedżerze haseł) -- nikt inny, w tym administrator serwera, go nie zna i nie może go odzyskać.'}
          </p>
          <code class="lnc-recovery-key">{recoveryKey}</code>
          <button type="button" class="lnc-new-chat-btn" onClick={onConfirmSetup}>
            {chosePassphrase ? 'Rozumiem' : 'Zapisałem/-am klucz'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="lnc-picker-overlay">
      <div class="lnc-picker lnc-recovery-modal" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={handleRestoreSubmit}>
          <div class="lnc-picker-header">
            <span>Odblokuj historię czatu</span>
          </div>
          <p class="lnc-recovery-text">
            {legacy
              ? 'Larpnet od teraz sam pamięta klucz do historii czatu, więc nie trzeba go będzie więcej wpisywać. Żeby przenieść Twoją dotychczasową historię, wpisz jeszcze tylko raz swój stary klucz odzyskiwania (albo frazę). Możesz to też zrobić później lub na innym urządzeniu, na którym czat jest już odblokowany.'
              : 'To nowe urządzenie/przeglądarka -- wpisz swój klucz odzyskiwania (albo frazę, jeśli taką ustawiłeś/-aś), aby odczytać wcześniejsze wiadomości. Możesz to zrobić później -- nowe wiadomości będą działać już teraz.'}
          </p>
          <input
            type="text"
            class="lnc-picker-search"
            placeholder="Klucz odzyskiwania lub fraza…"
            value={input}
            onInput={(e) => setInput(e.currentTarget.value)}
            autoFocus
          />
          {error && <div class="lnc-recovery-error">Nieprawidłowy klucz lub fraza. Spróbuj ponownie.</div>}
          <div class="lnc-recovery-actions">
            <button type="button" class="lnc-btn-secondary" onClick={onSkip} disabled={submitting}>
              Później
            </button>
            <button type="submit" class="lnc-new-chat-btn" disabled={submitting || !input.trim()}>
              {submitting ? 'Sprawdzanie…' : 'Odblokuj'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
