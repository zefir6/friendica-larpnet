import { useState } from 'preact/hooks';

/**
 * Copies `text` to the clipboard and says so for a moment. `compact`
 * renders an icon-only round button (member rows); otherwise icon + label.
 * Clipboard can be denied (insecure context, permissions) -- then nothing
 * happens; every place using this also shows the link itself.
 */
export function CopyButton({ text, label = 'Kopiuj link', compact = false, title }) {
  const [copied, setCopied] = useState(false);
  const copy = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      // Denied: leave the button as it was.
    }
  };
  const icon = <i class={'ri ' + (copied ? 'ri-check-line' : 'ri-link')} aria-hidden="true"></i>;
  if (compact) {
    return (
      <button type="button" class="lnc-icon-btn" title={copied ? 'Skopiowano' : title || label} aria-label={title || label} onClick={copy}>
        {icon}
      </button>
    );
  }
  return (
    <button type="button" class="lnc-chip-btn" title={title || label} onClick={copy}>
      {icon}
      <span>{copied ? 'Skopiowano' : label}</span>
    </button>
  );
}
