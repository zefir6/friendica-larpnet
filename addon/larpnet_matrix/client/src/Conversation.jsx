import { useEffect, useRef } from 'preact/hooks';
import { Composer } from './Composer.jsx';
import { resolveDisplayName } from './matrix.js';

export function Conversation({ client, roomId, contacts }) {
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  });

  if (!roomId) {
    return <div class="lnc-conversation lnc-status">Wybierz rozmowę</div>;
  }

  const room = client.getRoom(roomId);
  if (!room) {
    return <div class="lnc-conversation lnc-status">Wczytywanie…</div>;
  }

  const events = room
    .getLiveTimeline()
    .getEvents()
    .filter((ev) => ev.getType() === 'm.room.message');

  const send = (body) => client.sendTextMessage(roomId, body);

  return (
    <div class="lnc-conversation">
      <div class="lnc-timeline" ref={scrollRef}>
        {events.map((ev) => {
          const mine = ev.getSender() === client.getUserId();
          const failed = ev.isDecryptionFailure?.();
          return (
            <div key={ev.getId()} class={'lnc-message' + (mine ? ' lnc-message-mine' : '')}>
              {!mine && (
                <div class="lnc-message-sender">
                  {resolveDisplayName(ev.getSender(), contacts) || room.getMember(ev.getSender())?.name || ev.getSender()}
                </div>
              )}
              <div class="lnc-message-body">
                {failed ? <em>Nie można odszyfrować wiadomości</em> : ev.getContent().body}
              </div>
            </div>
          );
        })}
      </div>
      <Composer onSend={send} />
    </div>
  );
}
