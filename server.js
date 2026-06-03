// CineSync WebSocket Relay Server
// Deploy this FREE on Glitch.com, Railway, or Render
// 
// Glitch: Create new project → paste this as server.js
// Railway: railway init → railway up
// Render: Deploy as Web Service with "node server.js"

const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('CineSync Relay Server ✅');
});

const wss = new WebSocket.Server({ server });

// rooms: Map<roomId, Set<{ws, name, role}>>
const rooms = new Map();

function getRoomCount(roomId) {
  return rooms.has(roomId) ? rooms.get(roomId).size : 0;
}

function broadcastToRoom(roomId, msg, exceptWs = null) {
  if (!rooms.has(roomId)) return;
  const data = JSON.stringify(msg);
  rooms.get(roomId).forEach(client => {
    if (client.ws !== exceptWs && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  });
}

function broadcastToAll(roomId, msg) {
  broadcastToRoom(roomId, msg, null);
}

wss.on('connection', (ws, req) => {
  // Extract room from query string: ?room=XXXX
  const url = new URL(req.url, 'http://localhost');
  const roomId = url.searchParams.get('room');

  if (!roomId) {
    ws.close(1008, 'Room required');
    return;
  }

  let clientInfo = { ws, name: null, role: null, roomId };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Validate room matches connection room
    if (msg.room && msg.room !== roomId) return;
    msg.room = roomId;

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', room: roomId }));
      return;
    }

    if (msg.type === 'join') {
      clientInfo.name = msg.name || `User${Math.floor(Math.random()*1000)}`;
      clientInfo.role = msg.role || 'guest';

      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      rooms.get(roomId).add(clientInfo);

      const count = getRoomCount(roomId);

      // Tell others someone joined
      broadcastToRoom(roomId, {
        type: 'USER_JOIN',
        room: roomId,
        name: clientInfo.name,
        count
      }, ws);

      // Tell the joiner their member count
      ws.send(JSON.stringify({ type: 'MEMBER_COUNT', room: roomId, count }));
      return;
    }

    // Relay all other messages (PLAY, PAUSE, SEEK, SYNC_STATE, CHAT, etc.)
    broadcastToRoom(roomId, msg, ws);
  });

  ws.on('close', () => {
    if (rooms.has(roomId)) {
      rooms.get(roomId).delete(clientInfo);
      const count = getRoomCount(roomId);
      if (count === 0) {
        rooms.delete(roomId);
      } else {
        broadcastToRoom(roomId, {
          type: 'USER_LEAVE',
          room: roomId,
          name: clientInfo.name,
          count
        });
      }
    }
  });

  ws.on('error', () => ws.close());
});

server.listen(PORT, () => {
  console.log(`CineSync Relay running on port ${PORT}`);
});
