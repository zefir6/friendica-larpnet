// Facebook/Google-Chat style floating chat bubble, on every page, that
// opens the larpnet_matrix chat client in its own popup window (not an
// embedded <iframe>).
//
// Why a popup window and not an iframe: an earlier iframe-embedded version
// of this widget hit a reliable "Unable to restore session" crypto-store
// corruption bug. Root cause, confirmed by live testing: Friendica is a
// classic multi-page app, so every click-through to a new Friendica page
// destroyed and recreated the iframe (and the Matrix client rebooting
// inside it), racing the browser's IndexedDB connection teardown for the
// crypto store against the next boot's connection open. A popup window is
// its own top-level browsing context: it survives every Friendica page
// navigation in the *parent* tab untouched, so the chat client inside it
// only ever boots once per real session instead of once per page click.
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

  // A fixed window.open target name: calling window.open again with the
  // same name re-navigates and focuses the SAME popup instead of spawning
  // a new one, so switching DM targets from different profile pages still
  // reuses one chat window/session.
  var POPUP_NAME = 'larpnet-chat';
  var POPUP_FEATURES = 'width=380,height=640,resizable=yes,scrollbars=yes';

  function openPopup(dm) {
    var url = chatUrl + (dm ? '?dm=' + encodeURIComponent(dm) : '');
    var win = window.open(url, POPUP_NAME, POPUP_FEATURES);
    if (win) {
      win.focus();
    }
  }

  function build() {
    var bubble = document.createElement('button');
    bubble.type = 'button';
    bubble.id = 'larpnet-chat-bubble';
    bubble.setAttribute('aria-label', 'Czat');
    bubble.innerHTML = '<i class="ri ri-message-3-line" aria-hidden="true"></i>';
    bubble.addEventListener('click', function () { openPopup(null); });
    document.body.appendChild(bubble);
  }

  window.openMatrixChat = function (nickname) {
    openPopup(nickname || null);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
