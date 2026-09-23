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

  var bubble, panel, currentDm, loaded = false;

  function build() {
    bubble = document.createElement('button');
    bubble.type = 'button';
    bubble.id = 'larpnet-chat-bubble';
    bubble.setAttribute('aria-label', 'Czat');
    bubble.setAttribute('aria-expanded', 'false');
    bubble.innerHTML = '<i class="ri ri-message-3-line" aria-hidden="true"></i>';
    bubble.addEventListener('click', function () { toggle(); });

    panel = document.createElement('div');
    panel.id = 'larpnet-chat-panel';
    panel.innerHTML = '<div id="larpnet-chat-panel-body"></div>';

    document.body.appendChild(bubble);
    document.body.appendChild(panel);
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
    body.appendChild(iframe);
    loaded = true;
    currentDm = dm || null;
  }

  function open(dm) {
    ensureIframe(dm || null);
    panel.classList.add('open');
    bubble.classList.add('open');
    bubble.setAttribute('aria-expanded', 'true');
  }

  function close() {
    panel.classList.remove('open');
    bubble.classList.remove('open');
    bubble.setAttribute('aria-expanded', 'false');
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
