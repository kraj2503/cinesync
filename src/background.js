

// Public WebSocket signaling server (free tier)
// Uses a simple pub/sub over WebSocket
const WS_SERVER = 'https://cinesync-gj33.onrender.com';
// CineSync Background Service Worker
// Fixed: service worker keep-alive, reconnect dedup, clean join logic

let ws = null;
let roomId = null;
let isHost = false;
let reconnectTimer = null;
let heartbeatInterval = null;
let keepAliveInterval = null;
let isIntentionalClose = false;   // true only when user clicks "Leave"
let isConnecting = false;          // prevent concurrent connect() calls
let joinedRooms = new Set();       // track which rooms we've sent 'join' for this WS session


// ─── Keep the service worker alive ──────────────────────────────────────────
// MV3 service workers die after ~30s of inactivity; we self-ping to stay alive.
function startKeepAlive() {
  stopKeepAlive();
  keepAliveInterval = setInterval(() => {
    // Posting to self keeps the SW event loop active
    chrome.runtime.sendMessage({ action: '_keepalive' }).catch(() => { });
  }, 20000);
}

function stopKeepAlive() {
  if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
}

// ─── Connect ─────────────────────────────────────────────────────────────────
function connect(room, host) {
  if (isConnecting) return;
  if (ws && ws.readyState === WebSocket.OPEN && roomId === room) {
    // Already connected to this room — just ensure join was sent
    ensureJoined(room, host);
    return;
  }

  isConnecting = true;
  isIntentionalClose = false;
  roomId = room;
  isHost = host;
  joinedRooms.clear();

  if (ws) {
    try { ws.close(); } catch (_) { }
    ws = null;
  }
  clearInterval(heartbeatInterval);

  try {
    ws = new WebSocket(`${WS_SERVER}?room=${encodeURIComponent(room)}`);

    ws.onopen = () => {
      isConnecting = false;
      console.log('[CineSync] Connected, room:', room);

      // Heartbeat — keeps WS alive on Render (which also has idle timeouts)
      clearInterval(heartbeatInterval);
      heartbeatInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping', room }));
        }
      }, 20000);

      ensureJoined(room, host);
      broadcastToTabs({ type: 'CONNECTED', roomId: room, isHost: host });
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.room && msg.room !== room) return;
        if (msg.type === 'ping' || msg.type === 'pong') return;
        if (['PLAY', 'PAUSE', 'SEEK', 'SYNC_STATE', 'CHAT', 'USER_JOIN', 'USER_LEAVE', 'MEMBER_COUNT', 'REQUEST_STATE'].includes(msg.type)) {
          broadcastToTabs(msg);
        }
      } catch (e) {
        console.error('[CineSync] Parse error:', e);
      }
    };

    ws.onclose = (evt) => {
      isConnecting = false;
      console.log('[CineSync] WS closed:', evt.code, evt.reason);
      clearInterval(heartbeatInterval);

      if (!isIntentionalClose && roomId) {
        broadcastToTabs({ type: 'RECONNECTING' });
        scheduleReconnect(room, host);
      } else {
        broadcastToTabs({ type: 'DISCONNECTED' });
      }
    };

    ws.onerror = () => {
      isConnecting = false;
      // onclose will fire right after onerror, let that handle reconnect
    };

  } catch (e) {
    isConnecting = false;
    console.error('[CineSync] connect() threw:', e);
    scheduleReconnect(room, host);
  }
}

// Send 'join' exactly once per WS session per room
// Always includes a persistent clientId so the server can deduplicate reconnects
function ensureJoined(room, host) {
  if (joinedRooms.has(room)) return;
  joinedRooms.add(room);
  chrome.storage.local.get(['myName', 'clientId'], (data) => {
    // Generate a persistent clientId once per browser profile
    let cid = data.clientId;
    if (!cid) {
      cid = Math.random().toString(36).substring(2, 10);
      chrome.storage.local.set({ clientId: cid });
    }
    ws.send(JSON.stringify({
      type: 'join',
      room,
      role: host ? 'host' : 'guest',
      name: data.myName || 'Guest',
      clientId: cid      // server uses this to detect reconnects vs new joins
    }));
  });
}

// Exponential back-off: 2s, 4s, 8s … capped at 30s
let reconnectAttempts = 0;
function scheduleReconnect(room, host) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = Math.min(2000 * Math.pow(2, reconnectAttempts), 30000);
  reconnectAttempts = Math.min(reconnectAttempts + 1, 5);
  console.log(`[CineSync] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => connect(room, host), delay);
}

function resetReconnectBackoff() {
  reconnectAttempts = 0;
}

// ─── Send ────────────────────────────────────────────────────────────────────
function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    msg.room = roomId;
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

// ─── Disconnect (intentional) ────────────────────────────────────────────────
function disconnect() {
  isIntentionalClose = true;
  stopKeepAlive();
  clearInterval(heartbeatInterval);
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectAttempts = 0;
  joinedRooms.clear();
  if (ws) {
    try { ws.close(1000, 'user left'); } catch (_) { }
    ws = null;
  }
  roomId = null;
  isHost = false;
  broadcastToTabs({ type: 'DISCONNECTED' });
}

// ─── Broadcast to all content-script tabs + popup ───────────────────────────
async function broadcastToTabs(msg) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, msg).catch(() => { });
    }
    chrome.runtime.sendMessage(msg).catch(() => { });
  } catch (_) { }
}

// ─── Message listener ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === '_keepalive') { sendResponse({ ok: true }); return true; }

  switch (msg.action) {

    case 'CREATE_ROOM': {
      const newRoom = Math.random().toString(36).substring(2, 8).toUpperCase();
      chrome.storage.local.set({ roomId: newRoom, isHost: true });
      resetReconnectBackoff();
      connect(newRoom, true);
      startKeepAlive();
      sendResponse({ roomId: newRoom });
      break;
    }

    case 'JOIN_ROOM': {
      const room = msg.roomId.trim().toUpperCase();
      chrome.storage.local.set({ roomId: room, isHost: false });
      resetReconnectBackoff();
      connect(room, false);
      startKeepAlive();
      sendResponse({ roomId: room });
      break;
    }

    case 'LEAVE_ROOM': {
      chrome.storage.local.remove(['roomId', 'isHost']);
      disconnect();
      sendResponse({ ok: true });
      break;
    }

    case 'SEND_SYNC': {
      const sent = send(msg.payload);
      sendResponse({ sent });
      break;
    }

    case 'GET_STATE': {
      chrome.storage.local.get(['roomId', 'isHost'], (data) => {
        sendResponse({
          roomId: data.roomId || null,
          isHost: !!data.isHost,
          connected: !!(ws && ws.readyState === WebSocket.OPEN)
        });
      });
      return true; // async
    }
  }

  return true;
});

// ─── On SW startup: restore session ─────────────────────────────────────────
// Using chrome.runtime.onInstalled + storage check instead of onStartup
// (onStartup only fires on browser start, not SW restart)
chrome.storage.local.get(['roomId', 'isHost'], (data) => {
  if (data.roomId) {
    console.log('[CineSync] Restoring session for room:', data.roomId);
    resetReconnectBackoff();
    connect(data.roomId, !!data.isHost);
    startKeepAlive();
  }
});
