const WebSocket = require('ws');
const port = process.env.PORT || 8080;
const server = new WebSocket.Server({ port: port });

console.log(`WebSocket server running on port ${port}`);

const rooms = {};

server.on('connection', (ws) => {
  let currentRoom = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.action === "create_room" || data.action === "join_room") {
        currentRoom = data.roomCode;
        if (!rooms[currentRoom]) rooms[currentRoom] = [];
        rooms[currentRoom].push(ws);
        console.log(`User joined room: ${currentRoom}`);
      }

      if (data.action === "broadcast_event" && currentRoom) {
        rooms[currentRoom].forEach(client => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ videoState: data.videoState }));
          }
        });
      }
    } catch (e) {
      console.error("Error parsing message", e);
    }
  });

  ws.on('close', () => {
    if (currentRoom && rooms[currentRoom]) {
      rooms[currentRoom] = rooms[currentRoom].filter(client => client !== ws);
      if (rooms[currentRoom].length === 0) {
        delete rooms[currentRoom];
        console.log(`Room ${currentRoom} closed.`);
      }
    }
  });
});