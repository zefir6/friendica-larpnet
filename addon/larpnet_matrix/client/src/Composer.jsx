import { useState } from 'preact/hooks';

export function Composer({ onSend }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

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

  return (
    <form class="lnc-composer" onSubmit={submit}>
      <input
        type="text"
        value={text}
        placeholder="Napisz wiadomość…"
        disabled={sending}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      <button type="submit" disabled={sending || !text.trim()}>Wyślij</button>
    </form>
  );
}
