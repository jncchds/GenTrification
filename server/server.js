// Multiplayer log server. It never simulates: it only owns the clock, orders the
// placement log, persists it, and broadcasts entries. Every client replays the log.
//
//   node server/server.js [port]          (default 8787)
// Rooms are created on first join with a random seed (or ?seed via the join message).
// Also serves the built game from ../dist if present, so one port is enough.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { normEntry } from '../src/sim/engine.js';
import { DEFS, T } from '../src/sim/rules.js';

const PORT = Number(process.argv[2] || process.env.PORT || 8787);
const MS_PER_TICK = Number(process.env.MS_PER_TICK || 250); // same pace as local 1x
const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, 'data');
const DIST = path.join(here, '..', 'dist');
fs.mkdirSync(DATA, { recursive: true });

const rooms = new Map();
const safeName = (s) => String(s || 'lobby').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'lobby';

function loadRoom(name) {
  if (rooms.has(name)) return rooms.get(name);
  const file = path.join(DATA, name + '.json');
  let room;
  try { room = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { room = { seed: (Math.random() * 2 ** 32) >>> 0, start: Date.now(), log: [], players: {} }; }
  room.name = name; room.file = file; room.clients = new Set(); room.dirty = true;
  rooms.set(name, room);
  return room;
}
function saveRooms() {
  for (const r of rooms.values()) {
    if (!r.dirty) continue;
    const { seed, start, log, players } = r;
    fs.writeFileSync(r.file, JSON.stringify({ seed, start, log, players }));
    r.dirty = false;
  }
}
setInterval(saveRooms, 5000);
process.on('SIGINT', () => { saveRooms(); process.exit(0); });

const tickOf = (room) => Math.floor((Date.now() - room.start) / MS_PER_TICK);
const roster = (room) => Object.fromEntries(Object.values(room.players).map((p) => [p.id, { name: p.name, online: [...room.clients].some((c) => c.player === p.id) }]));
const broadcast = (room, msg) => { const s = JSON.stringify(msg); for (const c of room.clients) if (c.readyState === 1) c.send(s); };

// Static file server for the built client (optional).
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = path.normalize(path.join(DIST, url === '/' ? 'index.html' : url));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('GenTrification log server is running. Build the client (npm run build) to serve it here.'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  let room = null;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'join' && !room) {
      room = loadRoom(safeName(msg.room));
      const token = String(msg.token || '').slice(0, 64) || Math.random().toString(36);
      let p = room.players[token];
      if (!p) {
        p = { id: Object.keys(room.players).length + 1, name: String(msg.name || 'Settler').slice(0, 24) };
        room.players[token] = p; room.dirty = true;
      }
      ws.player = p.id;
      room.clients.add(ws);
      ws.send(JSON.stringify({ t: 'welcome', seed: room.seed, start: room.start, msPerTick: MS_PER_TICK, now: Date.now(), log: room.log, you: p.id, roster: roster(room) }));
      broadcast(room, { t: 'roster', roster: roster(room) });
    } else if (msg.t === 'place' && room) {
      const e = normEntry(msg.entry || {});
      if (!DEFS[e.type] && e.type !== T.DEMOLISH) { ws.send(JSON.stringify({ t: 'reject', reason: 'unknown type' })); return; }
      // The server owns ordering: no edits to the past, players only act as themselves.
      e.owner = ws.player;
      e.tick = Math.max(e.tick, tickOf(room) + 1);
      e.seq = room.log.length;
      room.log.push(e); room.dirty = true;
      broadcast(room, { t: 'entry', entry: e });
    }
  });
  ws.on('close', () => { if (room) { room.clients.delete(ws); broadcast(room, { t: 'roster', roster: roster(room) }); } });
});

server.listen(PORT, () => console.log(`GenTrification server on :${PORT} (ws + static), ${MS_PER_TICK} ms per tick`));
