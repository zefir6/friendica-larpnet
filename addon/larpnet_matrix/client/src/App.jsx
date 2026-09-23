import { useEffect, useState, useCallback } from 'preact/hooks';
import { loginAndStart, dmTargetMxid, findOrCreateDirectRoom } from './matrix.js';
import { RoomList } from './RoomList.jsx';
import { Conversation } from './Conversation.jsx';
import { ContactPicker } from './ContactPicker.jsx';

// Remembers the popup's own initial size/position (set by
// js/matrix-chat-widget.js's window.open features) so the maximize button
// has something to restore back to.
const initialWindowRect = { x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight };

function toggleFullWindow(setIsFull) {
  setIsFull((wasFull) => {
    if (wasFull) {
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

  const handlePick = async (nickname) => {
    setShowPicker(false);
    const targetMxid = '@' + nickname + ':' + config.serverName;
    const roomId = await findOrCreateDirectRoom(client, targetMxid);
    setSelectedRoomId(roomId);
  };

  return (
    <div class="lnc-app">
      <div class="lnc-header">
        <span class="lnc-header-title">Czat</span>
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
          onSelect={setSelectedRoomId}
          client={client}
          onNewChat={() => setShowPicker(true)}
        />
        <Conversation client={client} roomId={selectedRoomId} />
      </div>
      {showPicker && (
        <ContactPicker contacts={config.contacts || []} onPick={handlePick} onClose={() => setShowPicker(false)} />
      )}
    </div>
  );
}
