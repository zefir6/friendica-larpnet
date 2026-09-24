import { useEffect, useState, useCallback } from 'preact/hooks';
import { loginAndStart, dmTargetMxid, findOrCreateDirectRoom, roomDisplayName } from './matrix.js';
import { RoomList } from './RoomList.jsx';
import { Conversation } from './Conversation.jsx';
import { ContactPicker } from './ContactPicker.jsx';

// Whether this client is running inside the widget's iframe overlay (see
// js/matrix-chat-widget.js) rather than as its own top-level window/tab
// (e.g. a direct navigation to /larpnet_matrix, the JS-disabled fallback
// vcard.tpl's Chat link href points at). Each case needs a different
// "full window" mechanism -- an iframe can't resize the real browser
// window it's embedded in, so it asks the parent page to expand the
// overlay panel itself (same-origin, so this is a plain direct call, no
// postMessage needed) instead of calling window.resizeTo like a real
// top-level window can.
const isEmbedded = window.top !== window.self;

// Remembers a real top-level window's own initial size/position so the
// maximize button has something to restore back to. Meaningless (and
// unused) when isEmbedded.
const initialWindowRect = { x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight };

function toggleFullWindow(setIsFull) {
  setIsFull((wasFull) => {
    if (isEmbedded) {
      try {
        const panel = window.parent.document.getElementById('larpnet-chat-panel');
        panel?.classList.toggle('larpnet-chat-panel-maximized', !wasFull);
      } catch (e) {
        // cross-origin or parent gone -- nothing we can do
      }
    } else if (wasFull) {
      window.resizeTo(initialWindowRect.w, initialWindowRect.h);
      window.moveTo(initialWindowRect.x, initialWindowRect.y);
    } else {
      window.moveTo(0, 0);
      window.resizeTo(window.screen.availWidth, window.screen.availHeight);
    }
    return !wasFull;
  });
}

export function App({ config }) {
  const [client, setClient] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [error, setError] = useState(null);
  const [selectedRoomId, setSelectedRoomId] = useState(null);
  const [isFullWindow, setIsFullWindow] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [roomListCollapsed, setRoomListCollapsed] = useState(false);
  // Bumped on any client event that could change what's on screen (new
  // room, new message, membership change...) -- components re-read live
  // state off `client` directly rather than duplicating it, so this is
  // just a re-render trigger, not a data store.
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const c = await loginAndStart(config);
        if (cancelled) {
          return;
        }
        c.on('Room', bump);
        c.on('Room.timeline', bump);
        c.on('Room.name', bump);
        c.on('RoomMember.membership', bump);
        c.on('sync', bump);
        setClient(c);
        setStatus('ready');

        const targetMxid = dmTargetMxid(config);
        if (targetMxid) {
          const roomId = await findOrCreateDirectRoom(c, targetMxid);
          if (!cancelled) {
            setSelectedRoomId(roomId);
            setRoomListCollapsed(true);
          }
        }
      } catch (e) {
        console.error('larpnet chat: login failed', e);
        if (!cancelled) {
          setError(e);
          setStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // config is injected once by the server for this page load; it never
    // changes during the component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === 'loading') {
    return <div class="lnc-status">Logowanie do czatu…</div>;
  }
  if (status === 'error') {
    return <div class="lnc-status lnc-status-error">Nie udało się zalogować do czatu.<br />{String(error?.message || error)}</div>;
  }

  const rooms = client
    .getRooms()
    .filter((r) => r.getMyMembership() === 'join' || r.getMyMembership() === 'invite')
    .sort((a, b) => (b.getLastActiveTimestamp() || 0) - (a.getLastActiveTimestamp() || 0));

  // Selecting a conversation auto-collapses the room list -- there isn't
  // much width to spare in the overlay panel, and once you're in a
  // conversation the list is one click away again via the toggle.
  const selectRoom = (roomId) => {
    setSelectedRoomId(roomId);
    setRoomListCollapsed(true);
  };

  const handlePick = async (nickname) => {
    setShowPicker(false);
    const targetMxid = '@' + nickname + ':' + config.serverName;
    const roomId = await findOrCreateDirectRoom(client, targetMxid);
    selectRoom(roomId);
  };

  // The header shows who you're talking TO, never your own name (own name
  // was an earlier, actually-backwards design -- see git history) --
  // falls back to a generic label when no conversation is open yet (e.g.
  // right after opening the bare bubble with no ?dm= target).
  const selectedRoom = selectedRoomId ? client.getRoom(selectedRoomId) : null;
  const headerTitle = selectedRoom ? roomDisplayName(selectedRoom, client, config.contacts) : 'Czat';

  return (
    <div class="lnc-app">
      <div class="lnc-header">
        <button
          type="button"
          class="lnc-header-btn"
          title={roomListCollapsed ? 'Pokaż rozmowy' : 'Zwiń rozmowy'}
          onClick={() => setRoomListCollapsed((c) => !c)}
        >
          Rozmowy
        </button>
        <span class="lnc-header-title">{headerTitle}</span>
        <button
          type="button"
          class="lnc-header-btn"
          title={isFullWindow ? 'Przywróć rozmiar okna' : 'Pełne okno'}
          onClick={() => toggleFullWindow(setIsFullWindow)}
        >
          {isFullWindow ? 'Przywróć' : 'Pełny ekran'}
        </button>
      </div>
      <div class="lnc-body">
        <RoomList
          rooms={rooms}
          selectedRoomId={selectedRoomId}
          onSelect={selectRoom}
          client={client}
          onNewChat={() => setShowPicker(true)}
          collapsed={roomListCollapsed}
          contacts={config.contacts}
        />
        <Conversation client={client} roomId={selectedRoomId} contacts={config.contacts} />
      </div>
      {showPicker && (
        <ContactPicker contacts={config.contacts || []} onPick={handlePick} onClose={() => setShowPicker(false)} />
      )}
    </div>
  );
}
