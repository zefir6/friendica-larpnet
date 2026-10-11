import { gemoji } from 'gemoji';

// Slack/Discord-style ":wave:" shortcodes. gemoji is GitHub's emoji name
// list -- the same names Slack and Discord use for the common ones -- with
// aliases included (`names` holds e.g. both "+1" and "thumbsup").
const BY_NAME = new Map();
const NAME_BY_EMOJI = new Map();
for (const entry of gemoji) {
  for (const name of entry.names) {
    BY_NAME.set(name, entry.emoji);
  }
  NAME_BY_EMOJI.set(entry.emoji, entry.names[0]);
}
const ALL_NAMES = [...BY_NAME.keys()];

// Only known names are replaced, so anything else that happens to sit
// between colons ("12:30:45", "a:b:c") is left exactly as typed.
const SHORTCODE_RE = /:([a-z0-9_+-]+):/gi;

export function replaceShortcodes(text) {
  return text.replace(SHORTCODE_RE, (match, name) => BY_NAME.get(name.toLowerCase()) ?? match);
}

// Prefix matches first (what the user is most likely typing), then
// substring matches, e.g. "smile" also offers "sweat_smile".
export function searchShortcodes(query, limit = 8) {
  const q = query.toLowerCase();
  const prefix = [];
  const substring = [];
  for (const name of ALL_NAMES) {
    if (name.startsWith(q)) {
      prefix.push(name);
    } else if (name.includes(q)) {
      substring.push(name);
    }
    if (prefix.length >= limit) {
      break;
    }
  }
  return prefix
    .concat(substring)
    .slice(0, limit)
    .map((name) => ({ name, emoji: BY_NAME.get(name) }));
}

// Primary shortcode for an emoji (picker tooltips), or null if gemoji has
// none -- some picker entries carry a variation selector gemoji lacks.
export function shortcodeForEmoji(emoji) {
  return NAME_BY_EMOJI.get(emoji) ?? NAME_BY_EMOJI.get(emoji.replace(/️/g, '')) ?? null;
}
