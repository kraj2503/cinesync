// CineSync WebSocket Relay Server — Fixed
// Key fixes:
//  - Client identity tracked by persistent clientId (sent on join)
//  - Re-joining same clientId updates the socket instead of adding a new member
//  - Render keep-alive: HTTP /ping endpoint (add UptimeRobot to ping it every 5min)
//  - Proper ws.isAlive heartbeat using ws.ping/pong (not message-based)
//  - Room cleanup when truly empty

const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;
const PING_INTERVAL = 25000; // 25s server-side ping

const server = http.createServer((req, res) => {
  // Health check endpoint — ping this from UptimeRobot to keep Render alive
  if (req.url === '/ping' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('CineSync Relay Server ✅\n\nPing /ping to keep alive.');
});

const wss = new WebSocket.Server({ server });

// rooms: Map<roomId, Map<clientId, ClientInfo>>
// Using Map (not Set) so we can look up by clientId and replace stale sockets
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  return rooms.get(roomId);
}

function cleanRoom(roomId) {
  const room = rooms.get(roomId);
  if (room && room.size === 0) rooms.delete(roomId);
}

function roomCount(roomId) {
  return rooms.has(roomId) ? rooms.get(roomId).size : 0;
}

function broadcastToRoom(roomId, msg, exceptClientId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  const data = JSON.stringify(msg);
  room.forEach((client, cid) => {
    if (cid !== exceptClientId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  });
}

// ─── Server-side heartbeat (detect dead sockets without relying on messages) ─
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, PING_INTERVAL);

wss.on('close', () => clearInterval(pingInterval));

// ─── Connection handler ───────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const url = new URL(req.url, 'http://localhost');
  const roomId = url.searchParams.get('room');

  if (!roomId) { ws.close(1008, 'Room required'); return; }

  let clientId = null;   // set on 'join' message
  let clientName = null;
  let hasJoined = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.room && msg.room !== roomId) return;
    msg.room = roomId;

    // Respond to message-level ping (extension sends these too)
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', room: roomId }));
      return;
    }

    // ── JOIN ──────────────────────────────────────────────────────────────────
    if (msg.type === 'join') {
      const newId = msg.clientId || generateId();
      const name = msg.name || `User${newId.slice(0, 4)}`;
      const role = msg.role || 'guest';

      const room = getRoom(roomId);

      if (room.has(newId)) {
        // RECONNECT: same client, update socket — do NOT fire USER_JOIN again
        const existing = room.get(newId);
        existing.ws = ws;    // swap to new socket
        clientId = newId;
        clientName = existing.name;
        hasJoined = true;

        // Just tell this client the current count (silent rejoin)
        ws.send(JSON.stringify({
          type: 'MEMBER_COUNT',
          room: roomId,
          count: room.size,
          silent: true   // popup can ignore the join notification
        }));
        console.log(`[Room ${roomId}] ${clientName} RECONNECTED (${room.size} members)`);
      } else {
        // NEW member
        clientId = newId;
        clientName = name;
        hasJoined = true;
        room.set(clientId, { ws, name, role, clientId });

        const count = room.size;
        console.log(`[Room ${roomId}] ${name} JOINED (${count} members)`);

        // Announce to others
        broadcastToRoom(roomId, { type: 'USER_JOIN', room: roomId, name, count }, clientId);

        // Tell joiner their count and assigned clientId
        ws.send(JSON.stringify({ type: 'MEMBER_COUNT', room: roomId, count, clientId }));
      }
      return;
    }

    // ── All other messages: relay to room ────────────────────────────────────
    broadcastToRoom(roomId, msg, clientId);
  });

  ws.on('close', () => {
    if (!hasJoined || !clientId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const client = room.get(clientId);
    // Only remove if this socket is still the registered one
    // (prevents removing the new socket when old one closes after reconnect)
    if (client && client.ws === ws) {
      room.delete(clientId);
      const count = room.size;
      console.log(`[Room ${roomId}] ${clientName} LEFT (${count} members)`);
      broadcastToRoom(roomId, { type: 'USER_LEAVE', room: roomId, name: clientName, count });
      cleanRoom(roomId);
    }
  });

  ws.on('error', (err) => {
    console.error(`[Room ${roomId}] WS error for ${clientName}:`, err.message);
  });
});

function generateId() {
  return Math.random().toString(36).substring(2, 10);
}

server.listen(PORT, () => {
  console.log(`CineSync Relay running on :${PORT}`);
  console.log(`Health check: GET /ping`);
});
