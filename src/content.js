// CineSync Content Script
// Hooks into video elements on streaming sites and syncs playback

(function () {
  'use strict';

  if (window.__cinesync_loaded) return;
  window.__cinesync_loaded = true;

  let video = null;
  let isHost = false;
  let isSyncing = false; // prevent feedback loops
  let lastSentTime = -1;
  let overlayEl = null;
  let toastTimeout = null;
  let seekTolerance = 2.5; // seconds
  let memberCount = 1;

  // ─── Find the video element ───────────────────────────────────────────────
  function findVideo() {
    const candidates = Array.from(document.querySelectorAll('video'));
    if (!candidates.length) return null;
    // Prefer the largest/visible one
    return candidates.sort((a, b) =>
      (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight)
    )[0];
  }

  function ensureVideo() {
    if (video && !video.isConnected) video = null;
    if (!video) video = findVideo();
    return video;
  }

  // ─── Overlay UI ──────────────────────────────────────────────────────────
  function createOverlay() {
    if (overlayEl) return;
    overlayEl = document.createElement('div');
    overlayEl.id = '__cinesync_overlay';
    overlayEl.innerHTML = `
      <style>
        #__cinesync_overlay {
          position: fixed;
          top: 18px;
          right: 18px;
          z-index: 2147483647;
          font-family: 'Segoe UI', system-ui, sans-serif;
          pointer-events: none;
        }
        #__cinesync_badge {
          display: flex;
          align-items: center;
          gap: 8px;
          background: rgba(10,10,20,0.88);
          border: 1px solid rgba(255,255,255,0.12);
          backdrop-filter: blur(12px);
          border-radius: 24px;
          padding: 7px 14px;
          color: #fff;
          font-size: 13px;
          font-weight: 600;
          letter-spacing: 0.3px;
          box-shadow: 0 4px 24px rgba(0,0,0,0.5);
          transition: opacity 0.3s;
        }
        #__cinesync_badge .dot {
          width: 8px; height: 8px;
          border-radius: 50%;
          background: #22c55e;
          animation: pulse 2s infinite;
        }
        @keyframes pulse {
          0%,100% { opacity:1; transform:scale(1); }
          50% { opacity:0.5; transform:scale(1.3); }
        }
        #__cinesync_toast {
          margin-top: 10px;
          background: rgba(10,10,20,0.92);
          border: 1px solid rgba(255,255,255,0.1);
          backdrop-filter: blur(12px);
          border-radius: 12px;
          padding: 10px 16px;
          color: #fff;
          font-size: 13px;
          max-width: 240px;
          opacity: 0;
          transform: translateY(-6px);
          transition: opacity 0.3s, transform 0.3s;
        }
        #__cinesync_toast.show {
          opacity: 1;
          transform: translateY(0);
        }
        #__cinesync_toast .icon { margin-right: 6px; }
      </style>
      <div id="__cinesync_badge">
        <div class="dot"></div>
        <span id="__cinesync_label">CineSync</span>
        <span id="__cinesync_members" style="opacity:0.6;font-weight:400">• 1</span>
      </div>
      <div id="__cinesync_toast"></div>
    `;
    document.body.appendChild(overlayEl);
  }

  function showToast(icon, message, duration = 2500) {
    const toast = document.getElementById('__cinesync_toast');
    if (!toast) return;
    toast.innerHTML = `<span class="icon">${icon}</span>${message}`;
    toast.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('show'), duration);
  }

  function updateBadge() {
    const label = document.getElementById('__cinesync_label');
    const members = document.getElementById('__cinesync_members');
    if (!label || !members) return;
    label.textContent = isHost ? '👑 Host' : '🎬 CineSync';
    members.textContent = `• ${memberCount}`;
  }

  function removeOverlay() {
    if (overlayEl) {
      overlayEl.remove();
      overlayEl = null;
    }
  }

  // ─── Video event listeners ────────────────────────────────────────────────
  function attachVideoListeners(v) {
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('seeked', onSeeked);
  }

  function detachVideoListeners(v) {
    v.removeEventListener('play', onPlay);
    v.removeEventListener('pause', onPause);
    v.removeEventListener('seeked', onSeeked);
  }

  function onPlay() {
    if (isSyncing || !isHost) return;
    sendSync({ type: 'PLAY', time: video.currentTime });
    showToast('▶️', 'Playing synced');
  }

  function onPause() {
    if (isSyncing || !isHost) return;
    sendSync({ type: 'PAUSE', time: video.currentTime });
    showToast('⏸️', 'Paused synced');
  }

  function onSeeked() {
    if (isSyncing || !isHost) return;
    const t = video.currentTime;
    if (Math.abs(t - lastSentTime) < 0.5) return;
    lastSentTime = t;
    sendSync({ type: 'SEEK', time: t });
    showToast('⏩', `Seeked to ${formatTime(t)}`);
  }

  // ─── Apply incoming sync commands ────────────────────────────────────────
  function applySync(msg) {
    const v = ensureVideo();
    if (!v) return;

    isSyncing = true;
    try {
      if (msg.type === 'PLAY') {
        if (Math.abs(v.currentTime - msg.time) > seekTolerance) {
          v.currentTime = msg.time;
        }
        v.play().catch(() => {});
        showToast('▶️', 'Host pressed play');
      } else if (msg.type === 'PAUSE') {
        if (Math.abs(v.currentTime - msg.time) > seekTolerance) {
          v.currentTime = msg.time;
        }
        v.pause();
        showToast('⏸️', 'Host paused');
      } else if (msg.type === 'SEEK') {
        v.currentTime = msg.time;
        showToast('⏩', `Synced to ${formatTime(msg.time)}`);
      } else if (msg.type === 'SYNC_STATE') {
        // Full state sync on join
        if (Math.abs(v.currentTime - msg.time) > seekTolerance) {
          v.currentTime = msg.time;
        }
        if (msg.paused) { v.pause(); } else { v.play().catch(() => {}); }
        showToast('🔄', 'Synced with party!');
      }
    } finally {
      setTimeout(() => { isSyncing = false; }, 400);
    }
  }

  // ─── Communication ────────────────────────────────────────────────────────
  function sendSync(payload) {
    chrome.runtime.sendMessage({ action: 'SEND_SYNC', payload });
  }

  // ─── Listen for messages from background ─────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'CONNECTED': {
        isHost = msg.isHost;
        createOverlay();
        updateBadge();
        showToast('🎉', isHost ? 'Party started! Share the code.' : 'Joined the party!', 3000);

        // Attach listeners
        const v = ensureVideo();
        if (v) attachVideoListeners(v);

        // If guest, request sync state from host
        if (!isHost) {
          sendSync({ type: 'REQUEST_STATE' });
        }
        break;
      }

      case 'DISCONNECTED': {
        removeOverlay();
        const v = ensureVideo();
        if (v) detachVideoListeners(v);
        break;
      }

      case 'PLAY':
      case 'PAUSE':
      case 'SEEK': {
        if (!isHost) applySync(msg);
        break;
      }

      case 'SYNC_STATE': {
        if (!isHost) applySync(msg);
        break;
      }

      case 'REQUEST_STATE': {
        // Host responds with current state
        if (isHost) {
          const v = ensureVideo();
          if (v) {
            sendSync({
              type: 'SYNC_STATE',
              time: v.currentTime,
              paused: v.paused
            });
          }
        }
        break;
      }

      case 'MEMBER_COUNT': {
        memberCount = msg.count || 1;
        updateBadge();
        break;
      }

      case 'USER_JOIN': {
        showToast('👋', `${msg.name || 'Someone'} joined!`);
        memberCount = msg.count || memberCount + 1;
        updateBadge();
        // If we're host, send current state
        if (isHost) {
          const v = ensureVideo();
          if (v) {
            setTimeout(() => {
              sendSync({ type: 'SYNC_STATE', time: v.currentTime, paused: v.paused });
            }, 800);
          }
        }
        break;
      }

      case 'USER_LEAVE': {
        showToast('👋', `${msg.name || 'Someone'} left.`);
        memberCount = Math.max(1, (msg.count || memberCount - 1));
        updateBadge();
        break;
      }
    }
  });

  // ─── Observe DOM for late-loaded video elements ───────────────────────────
  const observer = new MutationObserver(() => {
    if (!ensureVideo()) return;
    // Check if we're connected but haven't attached
    chrome.storage.local.get(['roomId'], (data) => {
      if (data.roomId && video) {
        detachVideoListeners(video);
        attachVideoListeners(video);
      }
    });
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function formatTime(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    return `${m}:${String(sec).padStart(2,'0')}`;
  }

  // Check if already in a room on load
  chrome.storage.local.get(['roomId', 'isHost'], (data) => {
    if (data.roomId) {
      isHost = !!data.isHost;
      createOverlay();
      updateBadge();
      const v = ensureVideo();
      if (v) attachVideoListeners(v);
      chrome.runtime.sendMessage({ action: 'RECONNECT' });
    }
  });

})();
