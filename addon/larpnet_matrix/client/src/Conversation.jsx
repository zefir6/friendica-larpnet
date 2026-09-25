import { useEffect, useRef, useState } from 'preact/hooks';
import { Composer } from './Composer.jsx';
import { resolveDisplayName } from './matrix.js';
import { getUploadLimitBytes, uploadEncryptedAttachment } from './mediaAttachments.js';
import { ImageMessage, FileMessage } from './AttachmentMessage.jsx';

export function Conversation({ client, roomId, contacts }) {
  const scrollRef = useRef(null);
  const [uploadLimit, setUploadLimit] = useState(null);
  const [lightboxUrl, setLightboxUrl] = useState(null);

  useEffect(() => {
    getUploadLimitBytes(client).then(setUploadLimit);
  }, [client]);

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
      <div class="lnc-timeline" ref={scrollRef}>
        {events.map((ev) => {
          const mine = ev.getSender() === client.getUserId();
          const failed = ev.isDecryptionFailure?.();
          const content = ev.getContent();
          return (
            <div key={ev.getId()} class={'lnc-message' + (mine ? ' lnc-message-mine' : '')}>
              {!mine && (
                <div class="lnc-message-sender">
                  {resolveDisplayName(ev.getSender(), contacts) || room.getMember(ev.getSender())?.name || ev.getSender()}
                </div>
              )}
              <div class="lnc-message-body">
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
            </div>
          );
        })}
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
