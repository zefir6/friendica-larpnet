import { useEffect, useState } from 'preact/hooks';
import { decryptEventAttachment, formatFileSize } from './mediaAttachments.js';

// Images decrypt eagerly (so they show inline like a normal chat), files only
// decrypt on click (download) -- matches what a Messenger-style client does,
// and avoids pulling a large file's bytes just because it scrolled into view.
function useDecryptedObjectUrl(client, fileInfo) {
  const [state, setState] = useState({ url: null, loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    let objectUrl = null;
    decryptEventAttachment(client, fileInfo)
      .then((buffer) => {
        if (cancelled) {
          return;
        }
        objectUrl = URL.createObjectURL(new Blob([buffer]));
        setState({ url: objectUrl, loading: false, error: null });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({ url: null, loading: false, error: err });
        }
      });
    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, fileInfo?.url]);

  return state;
}

export function ImageMessage({ client, content, onOpenLightbox }) {
  const { url, loading, error } = useDecryptedObjectUrl(client, content.file);
  if (error) {
    return <div class="lnc-attachment-status">Nie można wczytać obrazu</div>;
  }
  if (loading || !url) {
    return <div class="lnc-attachment-status">Wczytywanie obrazu…</div>;
  }
  return (
    <img
      src={url}
      alt={content.body || 'obraz'}
      class="lnc-image-attachment"
      onClick={() => onOpenLightbox(url)}
    />
  );
}

export function FileMessage({ client, content }) {
  const [state, setState] = useState({ loading: false, error: false });

  const download = async () => {
    setState({ loading: true, error: false });
    try {
      const buffer = await decryptEventAttachment(client, content.file);
      const blob = new Blob([buffer], { type: content.info?.mimetype || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = content.body || 'plik';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setState({ loading: false, error: false });
    } catch (err) {
      console.error('larpnet chat: file decrypt failed', err);
      setState({ loading: false, error: true });
    }
  };

  return (
    <button type="button" class="lnc-file-chip" onClick={download} disabled={state.loading}>
      <span class="lnc-file-chip-icon">📄</span>
      <span class="lnc-file-chip-name">{content.body || 'plik'}</span>
      <span class="lnc-file-chip-size">{formatFileSize(content.info?.size)}</span>
      {state.loading && <span class="lnc-file-chip-status">…</span>}
      {state.error && <span class="lnc-file-chip-status">błąd</span>}
    </button>
  );
}
