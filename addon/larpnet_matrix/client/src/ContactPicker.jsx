import { useEffect, useRef, useState } from 'preact/hooks';
import { Avatar } from './Avatar.jsx';
import { avatarUrlForNickname } from './matrix.js';

/**
 * "Nowy czat" / "Dodaj osobę" picker. `contacts` is everyone chat knows
 * (config.contacts: every published local profile, with `followed` set for
 * people the viewer follows), so with no search it's split into sections
 * instead of one long A-Z list: people from recent 1:1 conversations
 * (`recentNicknames`, newest first), then people you follow, then everyone
 * else. A search matches name or nickname and shows one flat list.
 *
 * Keyboard: arrows move the highlight, Enter picks it, Escape closes.
 */
export function ContactPicker({ title = 'Nowy czat', contacts, recentNicknames = [], onPick, onClose }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef(null);

  const q = query.trim().toLowerCase();
  const byNick = new Map(contacts.map((c) => [c.nickname.toLowerCase(), c]));
  let sections;
  if (q) {
    const hits = contacts.filter((c) => c.name.toLowerCase().includes(q) || c.nickname.toLowerCase().includes(q));
    sections = [{ label: null, items: hits }];
  } else {
    const recent = recentNicknames.map((n) => byNick.get(n)).filter(Boolean).slice(0, 5);
    const used = new Set(recent.map((c) => c.nickname));
    const followed = contacts.filter((c) => c.followed && !used.has(c.nickname));
    followed.forEach((c) => used.add(c.nickname));
    const rest = contacts.filter((c) => !used.has(c.nickname));
    sections = [
      { label: 'Ostatnie', items: recent },
      { label: 'Obserwowani', items: followed },
      { label: recent.length || followed.length ? 'Wszyscy' : null, items: rest },
    ].filter((s) => s.items.length > 0);
  }
  const flat = sections.flatMap((s) => s.items);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.lnc-picker-item-active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && flat[active]) {
      e.preventDefault();
      onPick(flat[active].nickname);
    }
  };

  let index = -1;
  return (
    <div class="lnc-picker-overlay" onClick={onClose} onKeyDown={onKeyDown}>
      <div class="lnc-picker" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div class="lnc-picker-header">
          <span>{title}</span>
          <button type="button" class="lnc-picker-close" aria-label="Zamknij" onClick={onClose}><i class="ri ri-close-line" aria-hidden="true"></i></button>
        </div>
        <input
          type="text"
          class="lnc-picker-search"
          placeholder="Szukaj po imieniu lub nicku…"
          value={query}
          onInput={(e) => setQuery(e.currentTarget.value)}
          autoFocus
        />
        <div class="lnc-picker-list" ref={listRef}>
          {flat.length === 0 && <div class="lnc-room-list-empty">Nie znaleziono</div>}
          {sections.map((s) => (
            <div key={s.label || 'all'}>
              {s.label && <div class="lnc-picker-section">{s.label}</div>}
              {s.items.map((c) => {
                index += 1;
                const i = index;
                return (
                  <button
                    key={c.nickname}
                    type="button"
                    class={'lnc-picker-item' + (i === active ? ' lnc-picker-item-active' : '')}
                    onClick={() => onPick(c.nickname)}
                    onMouseEnter={() => setActive(i)}
                  >
                    <Avatar url={avatarUrlForNickname(c.nickname)} name={c.name} size={32} />
                    <span class="lnc-picker-item-text">
                      <span class="lnc-picker-item-name">{c.name}</span>
                      <span class="lnc-picker-item-nick">@{c.nickname}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
