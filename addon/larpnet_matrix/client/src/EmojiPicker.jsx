import { useState } from 'preact/hooks';

// A curated, hand-picked set rather than the full Unicode emoji database --
// keeps this dependency-free (no emoji-data package) and the bundle small.
// Covers the emoji people actually reach for in a chat, organized the same
// way most chat apps group theirs.
const CATEGORIES = [
  {
    label: 'Emocje',
    icon: '😀',
    emoji: [
      '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃',
      '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😋', '😛',
      '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨',
      '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥', '😌', '😔',
      '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🥵', '🥶',
      '😵', '🤯', '🥳', '😎', '🤓', '🧐', '😕', '😟', '🙁', '😮',
      '😯', '😲', '😳', '🥺', '😦', '😧', '😨', '😰', '😥', '😢',
      '😭', '😱', '😖', '😣', '😞', '😓', '😩', '😫', '😤', '😡',
      '😠', '🤬',
    ],
  },
  {
    label: 'Gesty',
    icon: '👋',
    emoji: [
      '👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤏', '✌️', '🤞', '🤟',
      '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '👍', '👎', '✊',
      '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🙏', '✍️', '💪',
      '🫡', '🤝',
    ],
  },
  {
    label: 'Serca',
    icon: '❤️',
    emoji: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
      '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '😻',
    ],
  },
  {
    label: 'Ludzie',
    icon: '🧑',
    emoji: [
      '🧑', '👶', '🧒', '👦', '👧', '🧓', '👴', '👵', '🙋', '🙅',
      '🙆', '💁', '🙇', '🤦', '🤷', '🧙', '🧝', '🧛', '🧟', '💃',
      '🕺', '👯', '🧘', '🚶', '🏃', '🤺', '🏇', '⛹️', '🏋️', '🚴',
    ],
  },
  {
    label: 'Natura',
    icon: '🐶',
    emoji: [
      '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯',
      '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🦆', '🦉',
      '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞',
      '🌸', '💐', '🌹', '🌻', '🌼', '🌷', '🌳', '🌲', '🌴', '🍀',
      '🔥', '💧', '🌊', '☀️', '🌙', '⭐', '⚡', '❄️', '☔', '🌈',
    ],
  },
  {
    label: 'Jedzenie',
    icon: '🍕',
    emoji: [
      '🍏', '🍎', '🍌', '🍉', '🍇', '🍓', '🫐', '🍒', '🍑', '🥭',
      '🍍', '🥥', '🍅', '🍆', '🥑', '🥦', '🌽', '🥕', '🍞', '🧀',
      '🍳', '🥞', '🧇', '🥓', '🍔', '🍟', '🍕', '🌭', '🥪', '🌮',
      '🌯', '🍜', '🍝', '🍣', '🍤', '🍦', '🍩', '🍪', '🎂', '🍰',
      '🍫', '🍬', '🍭', '☕', '🍵', '🧃', '🥤', '🍺', '🍷', '🥂',
    ],
  },
  {
    label: 'Aktywności',
    icon: '⚽',
    emoji: [
      '⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🏉', '🎱', '🏓', '🏸',
      '🥊', '🎯', '🎮', '🎲', '🧩', '🎨', '🎭', '🎤', '🎧', '🎸',
      '🎻', '🎬', '📚', '🎉', '🎊', '🎁', '🏆', '🥇', '🎪', '🗺️',
    ],
  },
  {
    label: 'Symbole',
    icon: '✅',
    emoji: [
      '✅', '❌', '❓', '❗', '⭐', '✨', '💯', '🔔', '🔒', '🔓',
      '🔑', '💰', '💡', '🔧', '⚙️', '🧭', '⏰', '📌', '📎', '✂️',
      '🚀', '⚠️', '♻️', '🆗', '🆕', '🔝', '🎵', '🎶', '💤', '👀',
    ],
  },
];

export function EmojiPicker({ onPick, onClose }) {
  const [activeCategory, setActiveCategory] = useState(0);

  return (
    <div class="lnc-emoji-picker" onClick={(e) => e.stopPropagation()}>
      <div class="lnc-emoji-tabs">
        {CATEGORIES.map((cat, i) => (
          <button
            type="button"
            key={cat.label}
            class={'lnc-emoji-tab' + (i === activeCategory ? ' lnc-emoji-tab-active' : '')}
            title={cat.label}
            onClick={() => setActiveCategory(i)}
          >
            {cat.icon}
          </button>
        ))}
      </div>
      <div class="lnc-emoji-grid">
        {CATEGORIES[activeCategory].emoji.map((e) => (
          <button type="button" key={e} class="lnc-emoji-item" onClick={() => onPick(e)}>
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}
