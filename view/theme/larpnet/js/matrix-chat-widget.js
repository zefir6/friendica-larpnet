// Facebook/Google-Chat style floating chat widget: a bubble in the corner
// that expands into an in-page overlay panel embedding the larpnet_matrix
// client in an <iframe>.
//
// This embeds in-page (not a popup window) per explicit user preference.
// An earlier version of this widget used a popup window instead, because an
// EARLIER iframe-embedded design (still redirecting into a separately
// hosted Element Web at the time) hit a reliable "Unable to restore
// session" crypto-store corruption bug. Re-examining that bug's actual
// confirmed root cause: it was the old bridge page's `?jwt=` handoff
// SKIPPING a real login and hand-seeding a previous session's tokens into
// localStorage whenever one already existed, leaving Element's crypto
// engine to cold-boot-restore a session it never itself logged into. This
// addon's own client (client/src/matrix.js) never does that -- every boot
// does one real, fresh JWT login, iframe or not -- so that specific
// mechanism no longer applies. The separate, never-fully-confirmed
// suspicion (destroying/recreating the iframe's crypto store across page
// navigations racing IndexedDB teardown) is mitigated best-effort by the
// client itself calling stopClient() on pagehide -- see matrix.js. If this
// turns out to still be unsafe in practice, that's the thing to revisit
// (e.g. back to a popup window styled to sit in the corner), not something
// to silently paper over.
//
// window.openMatrixChat(nickname) is the public entry point -- called from
// the "Chat" button on another local user's profile page (see vcard.tpl),
// contact/directory rows (see contact/entry.tpl), as well as usable by this
// bubble itself. Injected only when chat is actually configured -- see
// larpnet_head() in theme.php, which sets window.LarpnetMatrixChat before
// this file is loaded.
(function () {
  if (!window.LarpnetMatrixChat) {
    return;
  }
  var chatUrl = window.LarpnetMatrixChat.chatUrl;

  var bubble, panel, badge, currentDm, loaded = false;
  // Unread-chat count for the bubble's badge. While the chat iframe is
  // loaded it reports the exact live number itself ('larpnet-chat-unread');
  // otherwise it comes from GET larpnet_matrix/unread, which is Synapse's
  // own count as last pushed to this user's web pusher (see
  // larpnet_matrix_unread_endpoint()). Polled every 30 s, and refreshed at
  // once when the service worker sees a chat push.
  var iframeReportsUnread = false;

  // Warm-up: start the chat client in the closed panel at least once a day
  // per account, without the user opening it. A message sent to someone
  // with no E2EE device yet is encrypted to nobody and stays undecryptable
  // for them forever, and users who never clicked the bubble had no device
  // at all (only the server's keyless LARPNET_SERVER one). One boot gives
  // them a device plus, in standard mode, key backup (ensureEncryption()),
  // and each later boot lets that device collect queued room keys and back
  // them up. The client posts 'larpnet-chat-ready' once that's done. The
  // claim stamp keeps a second tab from starting another client on the
  // same crypto store meanwhile.
  var WARMUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
  var WARMUP_CLAIM_MS = 10 * 60 * 1000;
  var warmupKey = 'lnc_warmup_' + (window.LarpnetMatrixChat.user || '');

  function readWarmup() {
    try {
      return JSON.parse(localStorage.getItem(warmupKey) || '{}') || {};
    } catch (e) {
      return null;
    }
  }

  function writeWarmup(state) {
    try {
      localStorage.setItem(warmupKey, JSON.stringify(state));
    } catch (e) {
      // Storage blocked: readWarmup() fails the same way, so no warm-ups.
    }
  }

  function maybeWarmUp() {
    if (loaded || !window.LarpnetMatrixChat.user || document.visibilityState !== 'visible') {
      return;
    }
    var state = readWarmup();
    var now = Date.now();
    if (state === null
      || (state.done && now - state.done < WARMUP_INTERVAL_MS)
      || (state.claimed && now - state.claimed < WARMUP_CLAIM_MS)) {
      return;
    }
    state.claimed = now;
    writeWarmup(state);
    ensureIframe(null);
  }

  function scheduleWarmUp() {
    // Let the page itself finish loading first; the client pulls in a few
    // MB of wasm.
    setTimeout(function () {
      if (document.visibilityState === 'visible') {
        maybeWarmUp();
      } else {
        document.addEventListener('visibilitychange', function onVisible() {
          if (document.visibilityState === 'visible') {
            document.removeEventListener('visibilitychange', onVisible);
            maybeWarmUp();
          }
        });
      }
    }, 5000);
  }

  function setBadge(count) {
    if (!badge) {
      return;
    }
    var n = parseInt(count, 10) || 0;
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.hidden = n <= 0;
    bubble.setAttribute('aria-label', n > 0 ? 'Czat, nieprzeczytane rozmowy: ' + n : 'Czat');
  }

  function fetchUnread() {
    if (iframeReportsUnread || document.visibilityState !== 'visible') {
      return;
    }
    fetch(chatUrl + '/unread', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.rooms !== null && data.rooms !== undefined && !iframeReportsUnread) {
          setBadge(data.rooms);
        }
      })
      .catch(function () {});
  }

  function build() {
    bubble = document.createElement('button');
    bubble.type = 'button';
    bubble.id = 'larpnet-chat-bubble';
    bubble.setAttribute('aria-label', 'Czat');
    bubble.setAttribute('aria-expanded', 'false');
    // Icon alone read as an unlabeled generic button in practice -- the
    // visible "Czat" label is what actually makes it recognizable as chat
    // at a glance (aria-label alone only helps screen readers).
    bubble.innerHTML = '<i class="ri ri-message-3-line" aria-hidden="true"></i><span class="larpnet-chat-bubble-label">Czat</span>'
      + '<span class="larpnet-chat-bubble-badge" hidden></span>';
    badge = bubble.querySelector('.larpnet-chat-bubble-badge');
    bubble.addEventListener('click', function () { toggle(); });

    panel = document.createElement('div');
    panel.id = 'larpnet-chat-panel';
    panel.innerHTML = '<div id="larpnet-chat-panel-body"></div>';

    document.body.appendChild(bubble);
    document.body.appendChild(panel);

    // The chat's own "list beside conversation" setting (Settings in the
    // client, App.jsx's popupLayout) needs a wider panel. Same origin as the
    // iframe, so the same localStorage key is readable here on page load;
    // a live change arrives via the postMessage handler below.
    try {
      setWide(localStorage.getItem('lnc_popup_layout') === 'side');
    } catch (e) {
      // Storage blocked: keep the default (narrow) panel.
    }

    fetchUnread();
    setInterval(fetchUnread, 30000);
    scheduleWarmUp();
    document.addEventListener('visibilitychange', fetchUnread);
    if (navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('message', function (e) {
        if (e.data && e.data.type === 'larpnet-chat-push') {
          fetchUnread();
        }
      });
    }
  }

  function setWide(wide) {
    panel.classList.toggle('wide', !!wide);
  }

  window.addEventListener('message', function (e) {
    var iframe = panel && panel.querySelector('iframe');
    if (e.origin !== window.location.origin || !iframe || e.source !== iframe.contentWindow) {
      return;
    }
    if (e.data && e.data.type === 'larpnet-chat-layout') {
      setWide(e.data.layout === 'side');
    }
    if (e.data && e.data.type === 'larpnet-chat-unread') {
      iframeReportsUnread = true;
      setBadge(e.data.count);
    }
    if (e.data && e.data.type === 'larpnet-chat-ready') {
      writeWarmup({ done: Date.now() });
    }
  });

  // The chat client only sends read receipts (and the service worker only
  // skips notifications) while the panel is actually open -- see
  // client/src/notifications.js's isChatActive().
  function postPanelState() {
    var iframe = panel && panel.querySelector('iframe');
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'larpnet-chat-panel', open: panel.classList.contains('open') }, window.location.origin);
    }
  }

  function ensureIframe(dm) {
    if (loaded && dm === currentDm) {
      return;
    }
    var body = panel.querySelector('#larpnet-chat-panel-body');
    body.innerHTML = '';
    var iframe = document.createElement('iframe');
    iframe.title = 'Czat';
    iframe.allow = 'clipboard-write; microphone; camera; storage-access';
    iframe.src = chatUrl + (dm ? '?dm=' + encodeURIComponent(dm) : '');
    iframe.addEventListener('load', postPanelState);
    body.appendChild(iframe);
    loaded = true;
    currentDm = dm || null;
  }

  function open(dm) {
    ensureIframe(dm || null);
    panel.classList.add('open');
    bubble.classList.add('open');
    bubble.setAttribute('aria-expanded', 'true');
    postPanelState();
  }

  function close() {
    panel.classList.remove('open');
    bubble.classList.remove('open');
    bubble.setAttribute('aria-expanded', 'false');
    postPanelState();
  }

  function toggle() {
    if (panel.classList.contains('open')) {
      close();
    } else {
      open(currentDm);
    }
  }

  window.openMatrixChat = function (nickname) {
    if (!bubble) {
      build();
    }
    open(nickname || null);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
