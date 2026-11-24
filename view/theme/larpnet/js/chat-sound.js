/* Chat message sound for the web (same choices and keys as the Android and
 * iOS apps: ChatSounds.kt / ChatSound.swift).
 *
 * Browsers can't give a web notification its own sound, so the service
 * worker (sw.js) asks the open Larpnet pages to play it: on a chat push it
 * posts 'larpnet-chat-sound-request' to every window, exactly one page plays
 * the sound (a Web Lock plus the last played id in localStorage) and answers
 * 'larpnet-chat-sound-played'. The worker then shows the notification
 * silently, so the browser's own sound doesn't play on top. With no page
 * open, or when autoplay is blocked (no click on the page yet), the
 * notification keeps the browser's sound.
 *
 * Loaded on every theme page and in the chat documents (iframe and full
 * page); the chat's settings use window.LarpnetChatSound for the picker.
 * The choice is per browser (localStorage), like the apps' per-device one,
 * and is copied to the service worker, which can't read localStorage.
 */
(function () {
  'use strict';
  if (window.LarpnetChatSound) {
    return;
  }

  var STORAGE_KEY = 'lnc_chat_sound';
  var LAST_PLAYED_KEY = 'lnc_chat_sound_last';
  var DEFAULT = 'double_glass';
  // Same order and keys as the apps.
  var SOUNDS = [
    { key: 'double_glass', label: 'Podwójne szkło (domyślny)' },
    { key: 'glass', label: 'Szkło' },
    { key: 'short', label: 'Krótki sygnał' },
    { key: 'rising', label: 'Narastający sygnał' },
    { key: 'two_tone', label: 'Dwa tony' },
    { key: 'question', label: 'Pytanie' },
    { key: 'bong', label: 'Gong' },
    { key: 'pluck', label: 'Szarpnięcie' },
    { key: 'double_bong', label: 'Podwójny gong' },
    { key: 'drop_glass', label: 'Kropla i szkło' },
    { key: 'system', label: 'Dźwięk przeglądarki' },
    { key: 'silent', label: 'Bez dźwięku' },
  ];

  // .../view/theme/larpnet/js/chat-sound.js -> .../view/theme/larpnet/sounds/
  var script = document.currentScript;
  var soundBase = script && script.src
    ? new URL('../sounds/', script.src).href
    : '/view/theme/larpnet/sounds/';

  function isKnown(key) {
    return SOUNDS.some(function (s) { return s.key === key; });
  }

  function get() {
    try {
      var key = localStorage.getItem(STORAGE_KEY);
      return isKnown(key) ? key : DEFAULT;
    } catch (e) {
      return DEFAULT;
    }
  }

  function hasFile(key) {
    return key !== 'system' && key !== 'silent';
  }

  var audio = null;

  // Resolves true once playback has started, false if the key has no file
  // or the browser refused (autoplay policy, decode error).
  function play(key) {
    if (!hasFile(key)) {
      return Promise.resolve(false);
    }
    try {
      if (audio) {
        audio.pause();
      }
      audio = new Audio(soundBase + 'chat_' + key + '.mp3');
      var started = audio.play();
      return started && started.then
        ? started.then(function () { return true; }, function () { return false; })
        : Promise.resolve(true);
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  function tellWorker() {
    if (!('serviceWorker' in navigator)) {
      return;
    }
    navigator.serviceWorker.ready.then(function (reg) {
      if (reg.active) {
        reg.active.postMessage({ type: 'larpnet-chat-sound-choice', sound: get() });
      }
    }).catch(function () {});
  }

  function set(key) {
    if (!isKnown(key)) {
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, key);
    } catch (e) {
      // Storage blocked: the choice lasts for this page only.
    }
    tellWorker();
  }

  function alreadyPlayed(id) {
    try {
      return localStorage.getItem(LAST_PLAYED_KEY) === id;
    } catch (e) {
      return false;
    }
  }

  function markPlayed(id) {
    try {
      localStorage.setItem(LAST_PLAYED_KEY, id);
    } catch (e) {
      // ignore
    }
  }

  // One page at a time, and only the first that manages to play.
  function playForPush(id, worker) {
    var key = get();
    if (!hasFile(key) || !id) {
      return;
    }
    var attempt = function () {
      if (alreadyPlayed(id)) {
        return Promise.resolve();
      }
      return play(key).then(function (ok) {
        if (ok) {
          markPlayed(id);
          if (worker) {
            worker.postMessage({ type: 'larpnet-chat-sound-played', id: id });
          }
        }
      });
    };
    if (navigator.locks && navigator.locks.request) {
      navigator.locks.request('lnc-chat-sound', attempt).catch(function () {});
    } else {
      attempt();
    }
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (e) {
      var data = e.data || {};
      if (data.type === 'larpnet-chat-sound-request') {
        playForPush(String(data.id || ''), e.source || navigator.serviceWorker.controller);
      }
    });
    tellWorker();
  }

  window.LarpnetChatSound = {
    sounds: SOUNDS.slice(),
    defaultSound: DEFAULT,
    get: get,
    set: set,
    play: play,
  };
})();
