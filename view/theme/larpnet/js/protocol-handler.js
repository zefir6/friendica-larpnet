/* Settings > Display: "Fediverse links" panel (config: window.LarpnetProtocolHandler,
 * set by theme.php's larpnet_protocol_handler_head()). Registers Larpnet as this
 * browser's handler for web+mastodon:// (Mastodon's follow/share buttons) and
 * web+ap:// (FEP-07d7) links; Module\LarpnetOpenLink turns them into local pages.
 */
(function () {
  'use strict';
  var cfg = window.LarpnetProtocolHandler;
  var form = document.querySelector('#settings-form, form[action="settings/display"]');
  if (!cfg || !form || document.getElementById('lnc-protocol-handler')) {
    return;
  }

  var panel = document.createElement('div');
  panel.className = 'panel';
  panel.id = 'lnc-protocol-handler';

  var body = document.createElement('div');
  body.className = 'panel-body';

  var title = document.createElement('h2');
  title.textContent = cfg.title;

  var text = document.createElement('p');
  text.textContent = cfg.description;

  var button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-default';
  button.textContent = cfg.button;

  var status = document.createElement('p');
  status.className = 'help-block';
  status.setAttribute('role', 'status');

  button.addEventListener('click', function () {
    if (!navigator.registerProtocolHandler) {
      status.textContent = cfg.unsupported;
      return;
    }
    try {
      navigator.registerProtocolHandler('web+mastodon', cfg.url);
      navigator.registerProtocolHandler('web+ap', cfg.url);
      status.textContent = cfg.done;
    } catch (e) {
      status.textContent = cfg.unsupported;
    }
  });

  body.appendChild(title);
  body.appendChild(text);
  body.appendChild(button);
  body.appendChild(status);
  panel.appendChild(body);
  form.parentNode.insertBefore(panel, form.nextSibling);
})();
