import { useRef, useState } from 'preact/hooks';
import { EmojiPicker } from './EmojiPicker.jsx';

export function Composer({ onSend, onSendFile, uploadLimitBytes }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileInputRef = useRef(null);

  const submit = async (e) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || sending) {
      return;
    }
    setSending(true);
    try {
      await onSend(body);
      setText('');
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
      <form class="lnc-composer" onSubmit={submit}>
        <button
          type="button"
          class="lnc-composer-icon-btn"
          title="Dodaj plik"
          disabled={sending}
          onClick={openFilePicker}
        >
          📎
        </button>
        <input ref={fileInputRef} type="file" class="lnc-hidden-file-input" onChange={handleFileChosen} />
        <button
          type="button"
          class="lnc-composer-icon-btn"
          title="Emoji"
          disabled={sending}
          onClick={() => setShowEmoji((v) => !v)}
        >
          😊
        </button>
        <input
          type="text"
          value={text}
          placeholder="Napisz wiadomość…"
          disabled={sending}
          onInput={(e) => setText(e.currentTarget.value)}
          onFocus={() => setShowEmoji(false)}
        />
        <button type="submit" disabled={sending || !text.trim()}>Wyślij</button>
      </form>
    </div>
  );
}
