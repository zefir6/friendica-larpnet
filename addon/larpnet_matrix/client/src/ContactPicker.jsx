import { useState } from 'preact/hooks';

export function ContactPicker({ contacts, onPick, onClose }) {
  const [query, setQuery] = useState('');
  const filtered = contacts.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div class="lnc-picker-overlay" onClick={onClose}>
      <div class="lnc-picker" onClick={(e) => e.stopPropagation()}>
        <div class="lnc-picker-header">
          <span>Nowy czat</span>
          <button type="button" class="lnc-picker-close" onClick={onClose}>&times;</button>
        </div>
        <input
          type="text"
          class="lnc-picker-search"
          placeholder="Szukaj osoby…"
          value={query}
          onInput={(e) => setQuery(e.currentTarget.value)}
          autoFocus
        />
        <div class="lnc-picker-list">
          {filtered.length === 0 && <div class="lnc-room-list-empty">Nie znaleziono</div>}
          {filtered.map((c) => (
            <button key={c.nickname} type="button" class="lnc-picker-item" onClick={() => onPick(c.nickname)}>
              {c.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
