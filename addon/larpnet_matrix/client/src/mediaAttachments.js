import { encryptAttachment, decryptAttachment } from 'matrix-encrypt-attachment';

// The server's actual configured max upload size (bytes), fetched once and
// cached -- never a guessed/hardcoded number, since an admin can set this to
// anything. null means "the server didn't report one" -- callers shouldn't
// block on that, just let the server reject an actually-too-big upload.
let cachedUploadLimit;

export async function getUploadLimitBytes(client) {
  if (cachedUploadLimit !== undefined) {
    return cachedUploadLimit;
  }
  try {
    const config = await client.getMediaConfig();
    cachedUploadLimit = config?.['m.upload.size'] ?? null;
  } catch (e) {
    cachedUploadLimit = null;
  }
  return cachedUploadLimit;
}

// Encrypts `file` client-side (AES-CTR per the Matrix spec's "Sending
// encrypted attachments") and uploads only the ciphertext -- the server
// only ever sees encrypted bytes, same guarantee as message text in an
// encrypted room. Returns the `file` content fragment ready to spread
// directly into an m.image/m.file event's content.
export async function uploadEncryptedAttachment(client, file) {
  const plaintext = await file.arrayBuffer();
  const { data: ciphertext, info } = await encryptAttachment(plaintext);
  const { content_uri } = await client.uploadContent(new Blob([ciphertext]), {
    type: 'application/octet-stream',
  });
  return { ...info, url: content_uri };
}

// Downloads and decrypts an m.image/m.file event's `file` fragment back to
// an ArrayBuffer, for rendering (wrap in a Blob + object URL) or download.
// Auth'd manually (mxcUrlToHttp + bearer token) rather than via a matrix-js-sdk
// media helper -- there isn't one that returns raw bytes; this is the same
// two-step "download ciphertext, then decrypt" any Matrix client does.
export async function decryptEventAttachment(client, fileInfo) {
  const httpUrl = client.mxcUrlToHttp(fileInfo.url, undefined, undefined, undefined, false, false, true);
  const response = await fetch(httpUrl, {
    headers: { Authorization: `Bearer ${client.getAccessToken()}` },
  });
  if (!response.ok) {
    throw new Error(`Nie udało się pobrać pliku (HTTP ${response.status})`);
  }
  const ciphertext = await response.arrayBuffer();
  return decryptAttachment(ciphertext, fileInfo);
}

export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes)) {
    return '';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
