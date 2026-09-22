// Free signaling server for the video-call app.
// Only exchanges tiny JSON "handshake" messages (who's in the room, offer/answer/ICE,
// raise-hand, screen-share-status, chat). The actual video/audio/screen-share never
// passes through this server - that goes peer-to-peer via WebRTC.

const http = require("http");
const WebSocket = require("ws");
const { randomUUID } = require("crypto");

const PORT = process.env.PORT || 8080;
const MAX_NAME_LEN = 60;
const MAX_ROOM_LEN = 60;
const MAX_CHAT_LEN = 500;
const MAX_ROOM_SIZE = 60; // generous headroom above "a class"
const MAX_MSGS_PER_SEC = 40; // per-connection soft rate limit, abuse hardening

// A plain HTTP server so hosts like Render have something to health-check
// (they expect an HTTP response, not just an open TCP port) and so opening
// the URL in a browser confirms the deploy worked instead of erroring.
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("TeacherMeet signaling server is running.\n");
});

const wss = new WebSocket.Server({ server: httpServer });

// room name -> Map(clientId -> { ws, name, isAdmin })
const rooms = new Map();

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function getRoom(room) {
  if (!rooms.has(room)) rooms.set(room, new Map());
  return rooms.get(room);
}

// Normalizes room codes the same way both client apps do (trim + uppercase)
// so a stray lowercase paste doesn't land someone in the wrong room.
function normalizeRoom(room) {
  return String(room || "").trim().slice(0, MAX_ROOM_LEN).toUpperCase();
}

wss.on("connection", (ws) => {
  const id = randomUUID();
  let currentRoom = null;
  let displayName = "Guest";
  let joined = false;
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  // Simple fixed-window rate limit per connection, so one runaway/misbehaving
  // client can't flood the whole room (or the server) with messages.
  let msgCount = 0;
  let windowStart = Date.now();
  function rateLimited() {
    const now = Date.now();
    if (now - windowStart > 1000) {
      windowStart = now;
      msgCount = 0;
    }
    msgCount++;
    return msgCount > MAX_MSGS_PER_SEC;
  }

  ws.on("message", (raw) => {
    if (rateLimited()) return;

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;

    switch (msg.type) {
      case "join": {
        if (joined) return; // one join per connection
        const room = normalizeRoom(msg.room);
        if (!room) {
          send(ws, { type: "error", message: "Room code required" });
          return;
        }
        const roomPeers = getRoom(room);
        if (roomPeers.size >= MAX_ROOM_SIZE) {
          send(ws, { type: "error", message: "This room is full" });
          return;
        }

        currentRoom = room;
        displayName = String(msg.name || "Guest").trim().slice(0, MAX_NAME_LEN) || "Guest";
        const isAdmin = !!msg.isAdmin;
        joined = true;

        // tell the new client who is already here
        const existing = [...roomPeers.entries()].map(([pid, p]) => ({
          id: pid,
          name: p.name,
          isAdmin: p.isAdmin,
        }));
        send(ws, { type: "existing-peers", peers: existing, selfId: id });

        // add self to room, then tell everyone else a new peer joined
        roomPeers.set(id, { ws, name: displayName, isAdmin });
        for (const [pid, p] of roomPeers) {
          if (pid !== id) send(p.ws, { type: "new-peer", id, name: displayName, isAdmin });
        }
        break;
      }

      case "offer":
      case "answer":
      case "candidate": {
        if (!joined) return;
        const roomPeers = rooms.get(currentRoom);
        if (!roomPeers) return;
        const target = roomPeers.get(msg.to);
        if (target) send(target.ws, { ...msg, from: id });
        break;
      }

      // Raised/lowered hand - broadcast to everyone else in the room so the
      // teacher (and, like in Meet/Zoom, other students) see the ✋ badge.
      case "raise-hand": {
        if (!joined) return;
        const roomPeers = rooms.get(currentRoom);
        if (!roomPeers) return;
        for (const [pid, p] of roomPeers) {
          if (pid !== id) send(p.ws, { type: "raise-hand", from: id, name: displayName, raised: !!msg.raised });
        }
        break;
      }

      // Lets everyone show a "sharing screen" label on that person's tile.
      // The actual screen video swaps in via WebRTC track replacement -
      // this message is just the UI notification.
      case "screen-share-status": {
        if (!joined) return;
        const roomPeers = rooms.get(currentRoom);
        if (!roomPeers) return;
        for (const [pid, p] of roomPeers) {
          if (pid !== id) send(p.ws, { type: "screen-share-status", from: id, sharing: !!msg.sharing });
        }
        break;
      }

      // Chat / "ask a question" messages. `to` is one of:
      //   "admin" - deliver to every admin (teacher) currently in the room
      //             (students use this to ask a question)
      //   "all"   - broadcast to everyone else in the room (teacher announcement)
      //   <peerId> - deliver to exactly that peer (teacher replying to one student)
      // The server never stores chat history - it's relay-only, like the rest
      // of this file.
      case "chat": {
        if (!joined) return;
        const roomPeers = rooms.get(currentRoom);
        if (!roomPeers) return;
        const text = String(msg.text || "").trim().slice(0, MAX_CHAT_LEN);
        if (!text) return;
        const payload = { type: "chat", from: id, name: displayName, text };
        if (msg.to === "admin") {
          for (const [pid, p] of roomPeers) {
            if (pid !== id && p.isAdmin) send(p.ws, payload);
          }
        } else if (msg.to === "all") {
          for (const [pid, p] of roomPeers) {
            if (pid !== id) send(p.ws, payload);
          }
        } else if (msg.to) {
          const target = roomPeers.get(msg.to);
          if (target) send(target.ws, payload);
        }
        break;
      }

      default:
        break;
    }
  });

  ws.on("close", () => {
    if (!currentRoom) return;
    const roomPeers = rooms.get(currentRoom);
    if (!roomPeers) return;
    roomPeers.delete(id);
    for (const [, p] of roomPeers) send(p.ws, { type: "peer-left", id });
    if (roomPeers.size === 0) rooms.delete(currentRoom);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});

// Heartbeat: ping every client periodically. Keeps idle connections alive
// through most proxies/hosts (avoids silent idle-timeout disconnects), and
// terminates any socket that's gone dead without a clean close, so a
// disconnected participant is detected in seconds instead of lingering.
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

// Close things down cleanly on redeploy/restart (e.g. Render sends SIGTERM)
// instead of dropping connections abruptly mid-message.
function shutdown() {
  console.log("Shutting down signaling server...");
  clearInterval(heartbeat);
  wss.clients.forEach((ws) => ws.close(1001, "Server restarting"));
  httpServer.close(() => process.exit(0));
  // Safety net in case some socket refuses to close promptly.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
