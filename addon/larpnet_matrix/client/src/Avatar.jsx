import { useState } from 'preact/hooks';

// Same fixed palette as the mobile apps' InitialsAvatar, picked by the
// same kind of name hash, so a person's placeholder color reads the same
// everywhere.
const PALETTE = ['#4a2a5c', '#833a8a', '#3c7a89', '#89623c', '#4b8a3c', '#8a3c4b', '#3c5a8a', '#8a7a3c'];

function hashName(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Round avatar: the Friendica profile photo at `url` (see
 * avatarUrlForUserId()), or an initial on a colored circle when there's no
 * url or it fails to load -- never a broken-image icon.
 */
export function Avatar({ url, name, size = 32 }) {
  const [failedUrl, setFailedUrl] = useState(null);
  const label = (name || '?').trim();
  const style = { width: size + 'px', height: size + 'px' };

  if (url && failedUrl !== url) {
    return <img class="lnc-avatar" style={style} src={url} alt="" loading="lazy" onError={() => setFailedUrl(url)} />;
  }
  return (
    <span
      class="lnc-avatar lnc-avatar-initials"
      style={{ ...style, background: PALETTE[hashName(label) % PALETTE.length], fontSize: Math.round(size / 2.2) + 'px' }}
      aria-hidden="true"
    >
      {label.charAt(0).toUpperCase() || '?'}
    </span>
  );
}
