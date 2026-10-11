import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Composer } from './Composer.jsx';
import { resolveDisplayName, profileUrlForUserId, formatMessageTime, formatFullTime } from './matrix.js';
import { getUploadLimitBytes, uploadEncryptedAttachment } from './mediaAttachments.js';
import { ImageMessage, FileMessage } from './AttachmentMessage.jsx';

export function Conversation({ client, roomId, contacts, serverName, linkTarget, showMessageTimes }) {
  const scrollRef = useRef(null);
  const [uploadLimit, setUploadLimit] = useState(null);
  const [lightboxUrl, setLightboxUrl] = useState(null);

  useEffect(() => {
    getUploadLimitBytes(client).then(setUploadLimit);
  }, [client]);

  // "Stick to bottom": opening a room lands on the newest message, and new
  // messages keep it there -- but only while the user is already at (or near)
  // the bottom, so scrolling up to read history isn't yanked back down by
  // every sync-triggered re-render. The ResizeObserver covers content that
  // grows *after* render: images decrypting asynchronously, and older
  // history landing via scrollback() below.
  const pinnedRef = useRef(true);
  const pinnedRoomRef = useRef(roomId);
  const observerRef = useRef(null);
  const scrollToBottomIfPinned = () => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  };
  const onTimelineScroll = () => {
    const el = scrollRef.current;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  // Callback ref, so the observer follows the content element across the
  // "Wczytywanie…" -> loaded transition and room switches without effect deps.
  const contentRef = useCallback((node) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (node && typeof ResizeObserver !== 'undefined') {
      observerRef.current = new ResizeObserver(scrollToBottomIfPinned);
      observerRef.current.observe(node);
    }
    // scrollToBottomIfPinned only reads refs, so a stale closure is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    if (pinnedRoomRef.current !== roomId) {
      pinnedRoomRef.current = roomId;
      pinnedRef.current = true;
    }
    scrollToBottomIfPinned();
  });

  // client.getRoom()'s live timeline only holds whatever's already cached locally -- for a
  // conversation with no *recent* activity, that can be nothing at all, even once this
  // session's decryption keys are in place (confirmed live: a real conversation with history
  // on other clients showed "No messages yet" here, on an unlock-chat-history-completed
  // session, until backward pagination was requested). matrix-js-sdk never backfills this on
  // its own; a client has to explicitly call scrollback(). Bounded at 3 rounds (~90 events) as
  // a sane first-open depth, stopping early once oldState.paginationToken is null (the actual
  // start of the room's timeline). New events land via the room's own 'Room.timeline' event,
  // already wired to a re-render in App.jsx -- no local state needed here.
  useEffect(() => {
    if (!roomId) {
      return;
    }
    let cancelled = false;
    (async () => {
      let current = client.getRoom(roomId);
      for (let i = 0; i < 3 && current && !cancelled; i++) {
        if (current.oldState.paginationToken === null) {
          break;
        }
        current = await client.scrollback(current, 30).catch(() => null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, roomId]);

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

  // Attachments are always sent via the room's normal E2EE megolm session --
  // uploadEncryptedAttachment() encrypts client-side before upload, so the
  // server (and its media store) only ever sees ciphertext, same guarantee
  // as message text in an encrypted room.
  const sendFile = async (file) => {
    const encryptedFile = await uploadEncryptedAttachment(client, file);
    const isImage = file.type.startsWith('image/');
    const content = {
      msgtype: isImage ? 'm.image' : 'm.file',
      body: file.name,
      file: encryptedFile,
      info: { mimetype: file.type || 'application/octet-stream', size: file.size },
    };
    await client.sendMessage(roomId, content);
  };

  return (
    <div class="lnc-conversation">
      <div class="lnc-timeline" ref={scrollRef} onScroll={onTimelineScroll}>
        <div ref={contentRef}>
          {events.map((ev) => {
            const mine = ev.getSender() === client.getUserId();
            const failed = ev.isDecryptionFailure?.();
            const content = ev.getContent();
            const senderName = resolveDisplayName(ev.getSender(), contacts) || room.getMember(ev.getSender())?.name || ev.getSender();
            const profileUrl = profileUrlForUserId(ev.getSender(), serverName, contacts);
            return (
              <div key={ev.getId()} class={'lnc-message' + (mine ? ' lnc-message-mine' : '')}>
                {!mine && (
                  <div class="lnc-message-sender">
                    {profileUrl ? (
                      <a class="lnc-profile-link" href={profileUrl} target={linkTarget} rel="noopener" title="Otwórz profil">
                        {senderName}
                      </a>
                    ) : (
                      senderName
                    )}
                  </div>
                )}
                <div class="lnc-message-line">
                  <div class="lnc-message-body" title={formatFullTime(ev.getTs())}>
                    {failed ? (
                      <em>Nie można odszyfrować wiadomości</em>
                    ) : content.msgtype === 'm.image' && content.file ? (
                      <ImageMessage client={client} content={content} onOpenLightbox={setLightboxUrl} />
                    ) : content.msgtype === 'm.file' && content.file ? (
                      <FileMessage client={client} content={content} />
                    ) : (
                      content.body
                    )}
                  </div>
                  {showMessageTimes && <span class="lnc-message-time">{formatMessageTime(ev.getTs())}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {lightboxUrl && (
        <div class="lnc-lightbox" onClick={() => setLightboxUrl(null)}>
          <img src={lightboxUrl} alt="" />
        </div>
      )}
      <Composer onSend={send} onSendFile={sendFile} uploadLimitBytes={uploadLimit} />
    </div>
  );
}
