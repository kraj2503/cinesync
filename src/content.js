// CineSync Content Script — v3
// Fix: "Extension context invalidated" by wrapping every chrome.* call,
//      self-destructing on invalidation, and throttling the MutationObserver.

(function () {
  'use strict';

  // ─── Guard: only one instance per page ──────────────────────────────────
  if (window.__cinesync_loaded) return;
  window.__cinesync_loaded = true;

  // ─── Context validity check ───────────────────────────────────────────────
  // chrome.runtime.id is undefined when the extension context is invalidated.
  // Call this before EVERY chrome.* API use.
  function isContextValid() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  // Safe wrappers — silently no-op if context is gone
  function safeStorageGet(keys, cb) {
    if (!isContextValid()) return;
    try { chrome.storage.local.get(keys, cb); } catch (_) { }
  }

  function safeSendMessage(msg) {
    if (!isContextValid()) return;
    try {
      chrome.runtime.sendMessage(msg).catch(() => { });
    } catch (_) { }
  }

  // ─── Self-destruct when context dies ─────────────────────────────────────
  // Poll every 3 s; if invalid, tear everything down so the old content script
  // stops trying to talk to the dead extension and throws no more errors.
  const contextWatcher = setInterval(() => {
    if (!isContextValid()) {
      teardown('context invalidated');
    }
  }, 3000);

  // ─── State ───────────────────────────────────────────────────────────────
  let video = null;
  let isHost = false;
  let isSyncing = false;
  let lastSentTime = -1;
  let overlayEl = null;
  let toastTimeout = null;
  let memberCount = 1;
  const SEEK_TOLERANCE = 2.5; // seconds

  let destroyed = false;

  function teardown(reason) {
    if (destroyed) return;
    destroyed = true;
    clearInterval(contextWatcher);
    observer.disconnect();
    removeOverlay();
    if (video) {
      detachVideoListeners(video);
      video = null;
    }
    window.__cinesync_loaded = false; // allow fresh injection after extension reload
    console.log('[CineSync] Torn down:', reason);
  }

  // ─── Video helpers ────────────────────────────────────────────────────────
  function findVideo() {
    const all = Array.from(document.querySelectorAll('video'));
    if (!all.length) return null;
    return all.sort((a, b) =>
      (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight)
    )[0];
  }

  function ensureVideo() {
    if (video && !video.isConnected) { detachVideoListeners(video); video = null; }
    if (!video) video = findVideo();
    return video;
  }

  // ─── Overlay ─────────────────────────────────────────────────────────────
  function createOverlay() {
    if (overlayEl) return;
    overlayEl = document.createElement('div');
    overlayEl.id = '__cinesync_overlay';
    overlayEl.innerHTML = `
      <style>
        #__cinesync_overlay{position:fixed;top:18px;right:18px;z-index:2147483647;font-family:'Segoe UI',system-ui,sans-serif;pointer-events:none}
        #__cinesync_badge{display:flex;align-items:center;gap:8px;background:rgba(10,10,20,.88);border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(12px);border-radius:24px;padding:7px 14px;color:#fff;font-size:13px;font-weight:600;letter-spacing:.3px;box-shadow:0 4px 24px rgba(0,0,0,.5)}
        #__cinesync_badge .dot{width:8px;height:8px;border-radius:50%;background:#22c55e;animation:cs-pulse 2s infinite}
        #__cinesync_badge .dot.yellow{background:#f59e0b}
        @keyframes cs-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(1.3)}}
        #__cinesync_toast{margin-top:10px;background:rgba(10,10,20,.92);border:1px solid rgba(255,255,255,.1);backdrop-filter:blur(12px);border-radius:12px;padding:10px 16px;color:#fff;font-size:13px;max-width:240px;opacity:0;transform:translateY(-6px);transition:opacity .3s,transform .3s}
        #__cinesync_toast.show{opacity:1;transform:translateY(0)}
      </style>
      <div id="__cinesync_badge">
        <div class="dot" id="__cinesync_dot"></div>
        <span id="__cinesync_label">CineSync</span>
        <span id="__cinesync_members" style="opacity:.6;font-weight:400">• 1</span>
      </div>
      <div id="__cinesync_toast"></div>
    `;
    document.body.appendChild(overlayEl);
  }

  function showToast(icon, message, duration = 2500) {
    if (!overlayEl) return;
    const toast = document.getElementById('__cinesync_toast');
    if (!toast) return;
    toast.innerHTML = `<span style="margin-right:6px">${icon}</span>${escHtml(message)}`;
    toast.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('show'), duration);
  }

  function updateBadge(reconnecting = false) {
    const label = document.getElementById('__cinesync_label');
    const members = document.getElementById('__cinesync_members');
    const dot = document.getElementById('__cinesync_dot');
    if (!label) return;
    label.textContent = reconnecting ? '🔄 Reconnecting…' : (isHost ? '👑 Host' : '🎬 CineSync');
    if (members) members.textContent = `• ${memberCount}`;
    if (dot) dot.className = `dot${reconnecting ? ' yellow' : ''}`;
  }

  function removeOverlay() {
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ─── Video listeners ──────────────────────────────────────────────────────
  function attachVideoListeners(v) {
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('seeked', onSeeked);
  }

  function detachVideoListeners(v) {
    if (!v) return;
    v.removeEventListener('play', onPlay);
    v.removeEventListener('pause', onPause);
    v.removeEventListener('seeked', onSeeked);
  }

  function onPlay() {
    if (destroyed || isSyncing || !isHost) return;
    safeSendMessage({ action: 'SEND_SYNC', payload: { type: 'PLAY', time: video.currentTime } });
    showToast('▶️', 'Playing — syncing guests');
  }

  function onPause() {
    if (destroyed || isSyncing || !isHost) return;
    safeSendMessage({ action: 'SEND_SYNC', payload: { type: 'PAUSE', time: video.currentTime } });
    showToast('⏸️', 'Paused — syncing guests');
  }

  function onSeeked() {
    if (destroyed || isSyncing || !isHost) return;
    const t = video.currentTime;
    if (Math.abs(t - lastSentTime) < 0.5) return;
    lastSentTime = t;
    safeSendMessage({ action: 'SEND_SYNC', payload: { type: 'SEEK', time: t } });
    showToast('⏩', `Seeked to ${formatTime(t)}`);
  }

  // ─── Apply incoming sync from host ────────────────────────────────────────
  function applySync(msg) {
    if (destroyed) return;
    const v = ensureVideo();
    if (!v) return;

    isSyncing = true;
    try {
      switch (msg.type) {
        case 'PLAY':
          if (Math.abs(v.currentTime - msg.time) > SEEK_TOLERANCE) v.currentTime = msg.time;
          v.play().catch(() => { });
          showToast('▶️', 'Host pressed play');
          break;
        case 'PAUSE':
          if (Math.abs(v.currentTime - msg.time) > SEEK_TOLERANCE) v.currentTime = msg.time;
          v.pause();
          showToast('⏸️', 'Host paused');
          break;
        case 'SEEK':
          v.currentTime = msg.time;
          showToast('⏩', `Synced to ${formatTime(msg.time)}`);
          break;
        case 'SYNC_STATE':
          if (Math.abs(v.currentTime - msg.time) > SEEK_TOLERANCE) v.currentTime = msg.time;
          if (msg.paused) { v.pause(); } else { v.play().catch(() => { }); }
          showToast('🔄', 'Synced with party!');
          break;
      }
    } finally {
      setTimeout(() => { isSyncing = false; }, 400);
    }
  }

  // ─── Message listener (from background) ──────────────────────────────────
  // Wrapped in try/catch — adding the listener itself can throw if context
  // is already invalidated by the time this code runs.
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (destroyed) return;

      switch (msg.type) {

        case 'CONNECTED': {
          isHost = msg.isHost;
          createOverlay();
          updateBadge();
          showToast('🎉', isHost ? 'Party started! Share the code.' : 'Joined the party!', 3000);
          const v = ensureVideo();
          if (v) { detachVideoListeners(v); attachVideoListeners(v); }
          if (!isHost) {
            // Ask host for current position
            safeSendMessage({ action: 'SEND_SYNC', payload: { type: 'REQUEST_STATE' } });
          }
          break;
        }

        case 'RECONNECTING': {
          // Don't tear down — just show reconnecting state in badge
          updateBadge(true);
          break;
        }

        case 'DISCONNECTED': {
          teardown('disconnected');
          break;
        }

        case 'PLAY':
        case 'PAUSE':
        case 'SEEK':
          if (!isHost) applySync(msg);
          break;

        case 'SYNC_STATE':
          if (!isHost) applySync(msg);
          break;

        case 'REQUEST_STATE':
          if (isHost) {
            const v = ensureVideo();
            if (v) {
              safeSendMessage({
                action: 'SEND_SYNC',
                payload: { type: 'SYNC_STATE', time: v.currentTime, paused: v.paused }
              });
            }
          }
          break;

        case 'MEMBER_COUNT':
          memberCount = msg.count || 1;
          updateBadge();
          break;

        case 'USER_JOIN':
          // Don't show toast for silent reconnects
          if (!msg.silent) showToast('👋', `${msg.name || 'Someone'} joined!`);
          memberCount = msg.count || memberCount + 1;
          updateBadge();
          // Host pushes current state to newly joined guest
          if (isHost && !msg.silent) {
            const v = ensureVideo();
            if (v) {
              setTimeout(() => {
                safeSendMessage({
                  action: 'SEND_SYNC',
                  payload: { type: 'SYNC_STATE', time: v.currentTime, paused: v.paused }
                });
              }, 800);
            }
          }
          break;

        case 'USER_LEAVE':
          showToast('🚪', `${msg.name || 'Someone'} left.`);
          memberCount = Math.max(1, msg.count || memberCount - 1);
          updateBadge();
          break;
      }
    });
  } catch (e) {
    // Context already gone on load — nothing we can do
    console.warn('[CineSync] Could not add message listener:', e.message);
    teardown('listener registration failed');
  }

  // ─── MutationObserver — throttled, not on every mutation ─────────────────
  // Previously called chrome.storage on EVERY DOM change — very noisy.
  // Now we debounce and only act when the video element itself changes.
  let observerTimer = null;
  let lastVideoEl = null;

  const observer = new MutationObserver(() => {
    if (destroyed) return;
    clearTimeout(observerTimer);
    observerTimer = setTimeout(() => {
      if (destroyed) return;
      const v = ensureVideo();
      if (v && v !== lastVideoEl) {
        // A new (or replacement) video element appeared
        if (lastVideoEl) detachVideoListeners(lastVideoEl);
        lastVideoEl = v;
        // Only re-attach if we're in an active party
        safeStorageGet(['roomId'], (data) => {
          if (data && data.roomId) {
            detachVideoListeners(v); // idempotent — removes if already attached
            attachVideoListeners(v);
          }
        });
      }
    }, 500); // 500 ms debounce
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // ─── On load: restore session if already in a room ───────────────────────
  safeStorageGet(['roomId', 'isHost'], (data) => {
    if (!data || !data.roomId) return;
    isHost = !!data.isHost;
    createOverlay();
    updateBadge();
    const v = ensureVideo();
    if (v) { lastVideoEl = v; attachVideoListeners(v); }
    // Don't call RECONNECT — background.js restores on its own SW restart
  });

  // ─── Helpers ─────────────────────────────────────────────────────────────
  function formatTime(s) {
    if (!s || isNaN(s)) return '0:00';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

})();
