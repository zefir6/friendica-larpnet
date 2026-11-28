/* "Get the app" banner on phones (config: window.LarpnetAppBanner, set by
 * theme.php's larpnet_app_banner_head()).
 *
 * - iPhone/iPad in Safari: nothing here -- Safari shows its own Smart App
 *   Banner from the apple-itunes-app meta tag ("Open" once installed, which
 *   opens this page in the app via app-argument).
 * - iPhone/iPad in another browser: a dismissible bar whose "Open" tries
 *   larpnet://open?url=<this page> and goes to the App Store when nothing
 *   took it (no browser lets a page check whether an app is installed).
 * - Android: the same bar. Its link is an intent:// URL for the app's
 *   larpnet://open, which Android opens in the app when installed and
 *   otherwise sends to browser_fallback_url (the Google Play opt-in). Where
 *   Chrome can tell (getInstalledRelatedApps, needs related_applications in
 *   the web manifest and the app's asset_statements), it says "Open" up front.
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

  var here = location.href.split('#')[0];
  var openUrl = (cfg.scheme || 'larpnet') + '://open?url=' + encodeURIComponent(here);

  function androidIntentUrl() {
    return 'intent://open?url=' + encodeURIComponent(here)
      + '#Intent;scheme=' + (cfg.scheme || 'larpnet')
      + ';package=' + platform.package
      + ';S.browser_fallback_url=' + encodeURIComponent(platform.url)
      + ';end';
  }

  // iOS outside Safari: hand the page to the app; if we're still here and
  // visible a moment later, nothing took it, so go to the App Store.
  function openOnIos(event) {
    event.preventDefault();
    var left = false;
    function onHide() {
      if (document.hidden) {
        left = true;
      }
    }
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    location.href = openUrl;
    setTimeout(function () {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      if (!left && !document.hidden) {
        location.href = platform.url;
      }
    }, 1500);
  }

  function show(installed) {
    var bar = el('div');
    bar.id = 'lnc-app-banner';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', cfg.title);

    var icon = el('img', 'lnc-app-banner-icon');
    icon.src = cfg.icon;
    icon.alt = '';

    var text = el('div', 'lnc-app-banner-text');
    text.appendChild(el('strong', null, cfg.title));
    text.appendChild(el('span', null, installed ? platform.openText : platform.text));

    var link = el('a', 'lnc-app-banner-get', installed ? platform.openButton : platform.button);
    if (isAndroid) {
      // Same tab: Android takes intent:// out of the browser either way.
      link.href = androidIntentUrl();
    } else {
      link.href = platform.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.addEventListener('click', openOnIos);
    }

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
    // Going to the store counts as an answer too. Opening the app doesn't:
    // the bar should still offer it on the next page.
    if (!installed) {
      link.addEventListener('click', function () {
        setTimeout(hide, 2000);
      });
    }

    bar.appendChild(icon);
    bar.appendChild(text);
    bar.appendChild(link);
    bar.appendChild(close);
    document.body.appendChild(bar);
    document.body.classList.add('lnc-app-banner-shown');
    document.body.style.setProperty('--lnc-app-banner-h', bar.offsetHeight + 'px');
  }

  function start() {
    if (isAndroid && navigator.getInstalledRelatedApps) {
      navigator.getInstalledRelatedApps().then(function (apps) {
        show(apps.some(function (app) {
          return app.id === platform.package;
        }));
      }, function () {
        show(false);
      });
    } else {
      show(false);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
