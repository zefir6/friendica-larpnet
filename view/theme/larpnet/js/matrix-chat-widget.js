// Facebook/Google-Chat style floating chat widget: a bubble in the corner
// that expands into a small popup panel embedding the larpnet_matrix iframe,
// on every page, instead of navigating away to a full page for it.
//
// window.openMatrixChat(nickname) is the public entry point -- called from
// the "Chat" button on another local user's profile page (see vcard.tpl),
// as well as usable by this bubble itself. Injected only when chat is
// actually configured -- see larpnet_head() in theme.php, which sets
// window.LarpnetMatrixChat before this file is loaded.
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
    panel.innerHTML =
      '<div id="larpnet-chat-panel-header">' +
      '<span>Czat</span>' +
      '<button type="button" id="larpnet-chat-panel-close" aria-label="Zamknij czat">&times;</button>' +
      '</div>' +
      '<div id="larpnet-chat-panel-body"></div>';
    panel.querySelector('#larpnet-chat-panel-close').addEventListener('click', function () { close(); });

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
