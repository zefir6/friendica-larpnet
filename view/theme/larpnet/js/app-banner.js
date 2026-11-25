/* "Get the app" banner on phones (config: window.LarpnetAppBanner, set by
 * theme.php's larpnet_app_banner_head()).
 *
 * - iPhone/iPad in Safari: nothing here -- Safari shows its own Smart App
 *   Banner from the apple-itunes-app meta tag (with "Open" once installed).
 * - iPhone/iPad in another browser, and Android: a dismissible bar at the
 *   bottom with a link to the App Store / the Google Play testing opt-in.
 *
 * Dismissing hides it for DISMISS_DAYS in this browser. While shown, the
 * chat bubble moves up above it (body.lnc-app-banner-shown, see
 * css/app-banner.css).
 */
(function () {
  'use strict';
  var cfg = window.LarpnetAppBanner;
  if (!cfg || document.getElementById('lnc-app-banner')) {
    return;
  }

  var DISMISS_KEY = 'lnc_app_banner_dismissed';
  var DISMISS_DAYS = 30;

  var ua = navigator.userAgent || '';
  var isAndroid = /Android/i.test(ua);
  // iPadOS reports itself as a Mac; touch points give it away.
  var isIos = /iPhone|iPad|iPod/i.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isIosSafari = isIos && /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//i.test(ua);

  var platform = isAndroid ? cfg.android : (isIos && !isIosSafari ? cfg.ios : null);
  if (!platform || !platform.url) {
    return;
  }

  try {
    var dismissed = parseInt(localStorage.getItem(DISMISS_KEY) || '0', 10);
    if (dismissed && Date.now() - dismissed < DISMISS_DAYS * 86400000) {
      return;
    }
  } catch (e) {
    // Storage blocked: show it; dismissing then lasts for this page only.
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) {
      node.className = cls;
    }
    if (text) {
      node.textContent = text;
    }
    return node;
  }

  function show() {
    var bar = el('div');
    bar.id = 'lnc-app-banner';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', cfg.title);

    var icon = el('img', 'lnc-app-banner-icon');
    icon.src = cfg.icon;
    icon.alt = '';

    var text = el('div', 'lnc-app-banner-text');
    text.appendChild(el('strong', null, cfg.title));
    text.appendChild(el('span', null, platform.text));

    var link = el('a', 'lnc-app-banner-get', platform.button);
    link.href = platform.url;
    link.target = '_blank';
    link.rel = 'noopener';

    var close = el('button', 'lnc-app-banner-close');
    close.type = 'button';
    close.setAttribute('aria-label', cfg.close);
    close.innerHTML = '&times;';

    function hide() {
      try {
        localStorage.setItem(DISMISS_KEY, String(Date.now()));
      } catch (e) {
        // ignore
      }
      bar.remove();
      document.body.classList.remove('lnc-app-banner-shown');
    }
    close.addEventListener('click', hide);
    // Going to the store counts as an answer too.
    link.addEventListener('click', hide);

    bar.appendChild(icon);
    bar.appendChild(text);
    bar.appendChild(link);
    bar.appendChild(close);
    document.body.appendChild(bar);
    document.body.classList.add('lnc-app-banner-shown');
    document.body.style.setProperty('--lnc-app-banner-h', bar.offsetHeight + 'px');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', show);
  } else {
    show();
  }
})();
