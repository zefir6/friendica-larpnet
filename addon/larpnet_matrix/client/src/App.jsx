import { useEffect, useState, useCallback } from 'preact/hooks';
import { loginAndStart, dmTargetMxid, findOrCreateDirectRoom, roomDisplayName } from './matrix.js';
import { getRecoveryStatus, setUpRecovery, resetRecovery, restoreFromRecoveryKey } from './recovery.js';
import { RoomList } from './RoomList.jsx';
import { Conversation } from './Conversation.jsx';
import { ContactPicker } from './ContactPicker.jsx';
import { RecoveryKeyModal } from './RecoveryKeyModal.jsx';
import { RoomInfoModal } from './RoomInfoModal.jsx';
import { SettingsModal } from './SettingsModal.jsx';

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
  const [recoveryKeyCache, setRecoveryKeyCache] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [error, setError] = useState(null);
  const [selectedRoomId, setSelectedRoomId] = useState(null);
  const [isFullWindow, setIsFullWindow] = useState(false);
  // null | 'new_chat' | 'add_member' -- which purpose the ContactPicker
  // overlay is open for, so the same picker component can drive either
  // "start a new DM" (findOrCreateDirectRoom) or "invite to the currently
  // open room" (client.invite) without duplicating the picker itself.
  const [pickerMode, setPickerMode] = useState(null);
  const [roomListCollapsed, setRoomListCollapsed] = useState(false);
  const [showRoomInfo, setShowRoomInfo] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // null once resolved to 'ready' (nothing to show); 'needs_setup' or
  // 'needs_restore' render RecoveryKeyModal -- see recovery.js. 'reset' is
  // the same setup flow, triggered from Settings instead of first login.
  const [recoveryPrompt, setRecoveryPrompt] = useState(null);
  const [recoveryKeyToShow, setRecoveryKeyToShow] = useState(null);
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
        const { client: c, recoveryKeyCache: rkc } = await loginAndStart(config);
        if (cancelled) {
          return;
        }
        c.on('Room', bump);
        c.on('Room.timeline', bump);
        c.on('Room.name', bump);
        c.on('RoomMember.membership', bump);
        c.on('sync', bump);
        setClient(c);
        setRecoveryKeyCache(rkc);
        setStatus('ready');

        const recoveryStatus = await getRecoveryStatus(c);
        if (!cancelled && recoveryStatus === 'needs_setup') {
          // Key generation is deferred until the user picks random-vs-phrase
          // in the modal itself -- see handleChooseSetup below.
          setRecoveryPrompt('needs_setup');
        } else if (!cancelled && recoveryStatus === 'needs_restore') {
          setRecoveryPrompt('needs_restore');
        }

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
    setPickerMode(null);
    const targetMxid = '@' + nickname + ':' + config.serverName;
    if (pickerMode === 'add_member') {
      await client.invite(selectedRoomId, targetMxid);
      return;
    }
    const roomId = await findOrCreateDirectRoom(client, targetMxid);
    selectRoom(roomId);
  };

  const handleChooseSetup = async (passphrase) => {
    const key = await setUpRecovery(client, passphrase);
    setRecoveryKeyToShow(key);
  };

  const handleChooseReset = async (passphrase) => {
    const key = await resetRecovery(client, passphrase);
    setRecoveryKeyToShow(key);
  };

  const handleConfirmRecoverySetup = () => {
    setRecoveryPrompt(null);
    setRecoveryKeyToShow(null);
  };

  const handleSubmitRecoveryRestore = async (text) => {
    const ok = await restoreFromRecoveryKey(client, recoveryKeyCache, text);
    if (ok) {
      setRecoveryPrompt(null);
    }
    return ok;
  };

  const handleSkipRecoveryRestore = () => setRecoveryPrompt(null);

  const handleOpenReset = () => {
    setShowSettings(false);
    setRecoveryPrompt('reset');
  };

  const handleRoomLeft = () => {
    setShowRoomInfo(false);
    setSelectedRoomId(null);
    setRoomListCollapsed(false);
  };

  // The header shows who you're talking TO, never your own name (own name
  // was an earlier, actually-backwards design -- see git history) --
  // falls back to a generic label when no conversation is open yet (e.g.
  // right after opening the bare bubble with no ?dm= target).
  const selectedRoom = selectedRoomId ? client.getRoom(selectedRoomId) : null;
  const headerTitle = selectedRoom ? roomDisplayName(selectedRoom, client, config.contacts) : 'Czat';

  const existingMemberNicknames = selectedRoom
    ? new Set(
        selectedRoom
          .getMembersWithMembership('join')
          .concat(selectedRoom.getMembersWithMembership('invite'))
          .map((m) => /^@([^:]+):/.exec(m.userId)?.[1]?.toLowerCase())
          .filter(Boolean),
      )
    : new Set();

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
        {selectedRoom && (
          <button type="button" class="lnc-header-btn" title="Informacje o rozmowie" onClick={() => setShowRoomInfo(true)}>
            Info
          </button>
        )}
        <button type="button" class="lnc-header-btn" title="Ustawienia" onClick={() => setShowSettings(true)}>
          ⚙
        </button>
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
          onNewChat={() => setPickerMode('new_chat')}
          collapsed={roomListCollapsed}
          contacts={config.contacts}
        />
        <Conversation client={client} roomId={selectedRoomId} contacts={config.contacts} />
      </div>
      {pickerMode && (
        <ContactPicker
          contacts={(config.contacts || []).filter((c) => !existingMemberNicknames.has(c.nickname.toLowerCase()))}
          onPick={handlePick}
          onClose={() => setPickerMode(null)}
        />
      )}
      {showRoomInfo && selectedRoom && (
        <RoomInfoModal
          client={client}
          room={selectedRoom}
          contacts={config.contacts}
          onClose={() => setShowRoomInfo(false)}
          onLeft={handleRoomLeft}
          onAddMember={() => {
            setShowRoomInfo(false);
            setPickerMode('add_member');
          }}
        />
      )}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} onResetRecovery={handleOpenReset} />}
      {(recoveryPrompt === 'needs_setup' || recoveryPrompt === 'reset') && (
        <RecoveryKeyModal
          mode={recoveryPrompt === 'reset' ? 'reset' : 'setup'}
          recoveryKey={recoveryKeyToShow}
          onChoose={recoveryPrompt === 'reset' ? handleChooseReset : handleChooseSetup}
          onConfirmSetup={handleConfirmRecoverySetup}
        />
      )}
      {recoveryPrompt === 'needs_restore' && (
        <RecoveryKeyModal
          mode="restore"
          onSubmitRestore={handleSubmitRecoveryRestore}
          onSkip={handleSkipRecoveryRestore}
        />
      )}
    </div>
  );
}
