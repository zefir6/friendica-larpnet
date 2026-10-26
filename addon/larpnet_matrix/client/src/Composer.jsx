import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { EmojiPicker } from './EmojiPicker.jsx';
import { replaceShortcodes, searchShortcodes } from './emojiShortcodes.js';

// A just-closed ":name:" right before the caret -- replaced live as you type.
const CLOSED_SHORTCODE_RE = /:([a-z0-9_+-]+):$/i;
// An open ":na" at the start or after whitespace -- offers suggestions.
// Requiring that boundary keeps "12:30" or "http://" from popping the list.
const OPEN_SHORTCODE_RE = /(^|\s):([a-z0-9_+-]{2,})$/i;

export function Composer({ onSend, onSendFile, uploadLimitBytes }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [uploadError, setUploadError] = useState('');
  // null, or {items, index, start, end}: the suggestion list and which
  // slice of `text` (the ":query") a pick replaces.
  const [suggest, setSuggest] = useState(null);
  const fileInputRef = useRef(null);
  const inputRef = useRef(null);
  // Caret position to restore after a re-render that changed the text
  // around it (shortcode replaced by a shorter emoji).
  const pendingCaretRef = useRef(null);

  useLayoutEffect(() => {
    if (pendingCaretRef.current != null && inputRef.current) {
      inputRef.current.setSelectionRange(pendingCaretRef.current, pendingCaretRef.current);
      pendingCaretRef.current = null;
    }
  });

  const updateSuggestions = (value, caret) => {
    const m = OPEN_SHORTCODE_RE.exec(value.slice(0, caret));
    const items = m ? searchShortcodes(m[2]) : [];
    setSuggest(items.length ? { items, index: 0, start: caret - m[2].length - 1, end: caret } : null);
  };

  const handleInput = (e) => {
    const el = e.currentTarget;
    let value = el.value;
    let caret = el.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const m = CLOSED_SHORTCODE_RE.exec(before);
    if (m) {
      const replaced = replaceShortcodes(m[0]);
      if (replaced !== m[0]) {
        value = before.slice(0, m.index) + replaced + value.slice(caret);
        caret = m.index + replaced.length;
        pendingCaretRef.current = caret;
      }
    }
    setText(value);
    updateSuggestions(value, caret);
  };

  const acceptSuggestion = (item) => {
    const value = text.slice(0, suggest.start) + item.emoji + text.slice(suggest.end);
    pendingCaretRef.current = suggest.start + item.emoji.length;
    setText(value);
    setSuggest(null);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e) => {
    if (!suggest) {
      return;
    }
    const count = suggest.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setSuggest({ ...suggest, index: (suggest.index + step + count) % count });
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      // Picks the suggestion instead of sending the message.
      e.preventDefault();
      acceptSuggestion(suggest.items[suggest.index]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setSuggest(null);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    // Also covers shortcodes that never went through live replacement
    // (pasted text, or typed with the caret moved in between).
    const body = replaceShortcodes(text.trim());
    if (!body || sending) {
      return;
    }
    setSending(true);
    try {
      await onSend(body);
      setText('');
      setSuggest(null);
    } catch (e) {
      console.error('larpnet chat: send failed', e);
    } finally {
      setSending(false);
    }
  };

  const pickEmoji = (emoji) => {
    setText((t) => t + emoji);
  };

  const openFilePicker = () => {
    setUploadError('');
    fileInputRef.current?.click();
  };

  const handleFileChosen = async (e) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) {
      return;
    }
    if (uploadLimitBytes != null && file.size > uploadLimitBytes) {
      setUploadError(`Plik jest za duży (limit serwera: ${Math.floor(uploadLimitBytes / 1024 / 1024)} MB)`);
      return;
    }
    setSending(true);
    setUploadError('');
    try {
      await onSendFile(file);
    } catch (err) {
      console.error('larpnet chat: attachment send failed', err);
      setUploadError('Nie udało się wysłać pliku');
    } finally {
      setSending(false);
    }
  };

  return (
    <div class="lnc-composer-wrap">
      {uploadError && <div class="lnc-composer-error">{uploadError}</div>}
      {showEmoji && (
        <EmojiPicker onPick={pickEmoji} onClose={() => setShowEmoji(false)} />
      )}
      {suggest && (
        <div class="lnc-emoji-suggest" role="listbox">
          {suggest.items.map((item, i) => (
            <button
              type="button"
              key={item.name}
              role="option"
              aria-selected={i === suggest.index}
              class={'lnc-emoji-suggest-item' + (i === suggest.index ? ' lnc-emoji-suggest-item-active' : '')}
              // mousedown, not click: keeps focus (and the caret) in the input.
              onMouseDown={(e) => {
                e.preventDefault();
                acceptSuggestion(item);
              }}
            >
              <span class="lnc-emoji-suggest-emoji">{item.emoji}</span>
              <span>:{item.name}:</span>
            </button>
          ))}
        </div>
      )}
      <form class="lnc-composer" onSubmit={submit}>
        <button
          type="button"
          class="lnc-composer-icon-btn"
          title="Dodaj plik"
          disabled={sending}
          onClick={openFilePicker}
        >
          <i class="ri ri-attachment-line" aria-hidden="true"></i>
        </button>
        <input ref={fileInputRef} type="file" class="lnc-hidden-file-input" onChange={handleFileChosen} />
        <button
          type="button"
          class="lnc-composer-icon-btn"
          title="Emoji"
          disabled={sending}
          onClick={() => setShowEmoji((v) => !v)}
        >
          <i class="ri ri-emotion-line" aria-hidden="true"></i>
        </button>
        <input
          ref={inputRef}
          type="text"
          value={text}
          placeholder="Napisz wiadomość…"
          // readOnly, not disabled: a disabled input loses focus, so after
          // sending with Enter you had to click back into it to type again.
          readOnly={sending}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onFocus={() => setShowEmoji(false)}
          onBlur={() => setSuggest(null)}
        />
        <button type="submit" disabled={sending || !text.trim()}>Wyślij</button>
      </form>
    </div>
  );
}
