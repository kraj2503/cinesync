// CineSync Background Service Worker
// Handles WebSocket connection management and message routing

let ws = null;
let roomId = null;
let isHost = false;
let reconnectTimer = null;
let heartbeatInterval = null;

// Public WebSocket signaling server (free tier)
// Uses a simple pub/sub over WebSocket
const WS_SERVER = 'wss://cinesync-relay.glitch.me';

// Fallback: BroadcastChannel for same-machine testing
// In production, replace WS_SERVER with your own relay

function connect(room, host) {
  roomId = room;
  isHost = host;

  if (ws) {
    ws.close();
    ws = null;
  }

  // Use a free public WebSocket echo/relay service
  // For real deployment, use your own server
  try {
    ws = new WebSocket(`${WS_SERVER}?room=${encodeURIComponent(room)}`);

    ws.onopen = () => {
      console.log('[CineSync BG] WebSocket connected, room:', room);
      clearInterval(heartbeatInterval);
      heartbeatInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping', room }));
        }
      }, 25000);

      ws.send(JSON.stringify({
        type: 'join',
        room,
        role: host ? 'host' : 'guest'
      }));

      broadcastToTabs({ type: 'CONNECTED', roomId: room, isHost: host });
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.room !== room) return;
        if (msg.type === 'ping' || msg.type === 'pong') return;

        // Forward sync commands to content scripts
        if (['PLAY', 'PAUSE', 'SEEK', 'SYNC_STATE'].includes(msg.type)) {
          broadcastToTabs(msg);
        }
        // Forward chat/presence messages to popup
        if (['CHAT', 'USER_JOIN', 'USER_LEAVE', 'MEMBER_COUNT'].includes(msg.type)) {
          broadcastToTabs(msg);
        }
      } catch (e) {
        console.error('[CineSync BG] Parse error:', e);
      }
    };

    ws.onclose = () => {
      console.log('[CineSync BG] WebSocket closed');
      broadcastToTabs({ type: 'DISCONNECTED' });
      scheduleReconnect(room, host);
    };

    ws.onerror = (err) => {
      console.error('[CineSync BG] WebSocket error:', err);
      broadcastToTabs({ type: 'WS_ERROR' });
    };

  } catch (e) {
    console.error('[CineSync BG] Failed to connect:', e);
    broadcastToTabs({ type: 'WS_ERROR', message: e.message });
  }
}

function scheduleReconnect(room, host) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect(room, host), 3000);
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    msg.room = roomId;
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

function disconnect() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) {
    ws.close();
    ws = null;
  }
  roomId = null;
  isHost = false;
  broadcastToTabs({ type: 'DISCONNECTED' });
}

async function broadcastToTabs(msg) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, msg);
    } catch (_) {}
  }
  // Also try sending to popup
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// Listen for messages from popup and content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {

    case 'CREATE_ROOM': {
      const newRoom = Math.random().toString(36).substring(2, 10).toUpperCase();
      chrome.storage.local.set({ roomId: newRoom, isHost: true });
      connect(newRoom, true);
      sendResponse({ roomId: newRoom });
      break;
    }

    case 'JOIN_ROOM': {
      const room = msg.roomId.trim().toUpperCase();
      chrome.storage.local.set({ roomId: room, isHost: false });
      connect(room, false);
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
          connected: ws && ws.readyState === WebSocket.OPEN
        });
      });
      return true; // async
    }

    case 'RECONNECT': {
      chrome.storage.local.get(['roomId', 'isHost'], (data) => {
        if (data.roomId) connect(data.roomId, !!data.isHost);
      });
      break;
    }
  }
  return true;
});

// On startup, try to reconnect to previous room
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(['roomId', 'isHost'], (data) => {
    if (data.roomId) connect(data.roomId, !!data.isHost);
  });
});
