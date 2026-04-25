/**
 * VENU Server v3
 * - Phone number + Name = Login (no OTP)
 * - WebSocket real-time messaging
 * - Works on any network
 */

const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 4000;

const users    = new Map();
const sessions = new Map();
const online   = new Map();

function genToken() { return crypto.randomBytes(32).toString("hex"); }
function genId()    { return crypto.randomUUID(); }
function wsend(socket, data) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  let body = "";
  req.on("data", d => body += d);
  req.on("end", () => {
    try { route(req, res, body ? JSON.parse(body) : {}); }
    catch { res.writeHead(400); res.end(JSON.stringify({ error: "Bad request" })); }
  });
});

function ok(res, data)       { res.writeHead(200); res.end(JSON.stringify(data)); }
function err(res, code, msg) { res.writeHead(code); res.end(JSON.stringify({ error: msg })); }

function route(req, res, body) {
  const url = req.url.split("?")[0];

  if (url === "/health") {
    return ok(res, { status: "ok", users: users.size, online: online.size });
  }

  if (url === "/auth/login" && req.method === "POST") {
    const phone = (body.phone || "").replace(/\D/g, "");
    const name  = (body.name  || "").trim();
    if (phone.length < 10) return err(res, 400, "Valid 10-digit phone number required");
    if (!name)             return err(res, 400, "Name is required");

    if (!users.has(phone)) {
      users.set(phone, { userId: genId(), name, phone });
    } else {
      users.get(phone).name = name;
    }

    const user  = users.get(phone);
    const token = genToken();
    sessions.set(token, { userId: user.userId, name: user.name, phone });
    console.log(`[Login] ${name} (${phone})`);
    return ok(res, { success: true, token, userId: user.userId, name: user.name, phone });
  }

  if (url === "/users/find" && req.method === "POST") {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (!sessions.has(token)) return err(res, 401, "Unauthorized");
    const phone = (body.phone || "").replace(/\D/g, "");
    if (!phone) return err(res, 400, "Phone required");
    if (!users.has(phone)) return err(res, 404, "User not found. Ask them to open Venu and register first.");
    const user = users.get(phone);
    return ok(res, { userId: user.userId, name: user.name, phone: user.phone, online: online.has(user.userId) });
  }

  err(res, 404, "Not found");
}

const wss = new WebSocket.Server({ server, path: "/ws" });

wss.on("connection", socket => {
  let myUserId = null, mySession = null;

  socket.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case "auth": {
        const session = sessions.get(msg.token);
        if (!session) { wsend(socket, { type: "error", message: "Session expired. Login again." }); return socket.close(); }
        myUserId = session.userId; mySession = session;
        online.set(myUserId, { socket, ...session });
        wsend(socket, { type: "auth_ok", userId: myUserId, name: session.name, phone: session.phone });
        broadcast({ type: "presence", userId: myUserId, name: session.name, online: true });
        console.log(`[+] ${session.name} online`);
        break;
      }
      case "message": {
        if (!myUserId) return;
        const { to, text, tempId } = msg;
        if (!text?.trim() || !to) return;
        const payload = { type: "message", from: myUserId, fromName: mySession.name, fromPhone: mySession.phone, text: text.trim(), timestamp: Date.now(), tempId };
        const recipient = online.get(to);
        if (recipient) wsend(recipient.socket, payload);
        wsend(socket, { type: "message_sent", tempId, delivered: !!recipient, timestamp: payload.timestamp });
        break;
      }
      case "typing": {
        if (!myUserId) return;
        const r = online.get(msg.to);
        if (r) wsend(r.socket, { type: "typing", from: myUserId, fromName: mySession.name });
        break;
      }
      case "offer": case "answer": case "ice_candidate": {
        if (!myUserId) return;
        const r = online.get(msg.to);
        if (r) wsend(r.socket, { ...msg, from: myUserId, fromName: mySession.name });
        break;
      }
      case "ping": wsend(socket, { type: "pong" }); break;
    }
  });

  socket.on("close", () => {
    if (myUserId) {
      online.delete(myUserId);
      broadcast({ type: "presence", userId: myUserId, name: mySession?.name, online: false });
      console.log(`[-] ${mySession?.name} offline`);
    }
  });
});

function broadcast(data) {
  const str = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(str); });
}

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   🔒 VENU Server v3 — Port ${PORT}          ║
║   Phone + Name login · No OTP needed     ║
║   Works on any network                   ║
╚══════════════════════════════════════════╝
  `);
});
