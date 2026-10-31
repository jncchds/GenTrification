// Multiplayer smoke test: start the log server, connect two clients, place from both,
// and check both replay to the same state hash.
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { Engine } from '../src/sim/engine.js';
import { findHome } from '../src/sim/bot.js';
import { Rng } from '../src/sim/prng.js';
import { T } from '../src/sim/rules.js';

const PORT = 18787;
const srv = spawn(process.execPath, ['server/server.js', String(PORT)], { env: { ...process.env, MS_PER_TICK: '20' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.once('data', r));
const room = 'test' + Date.now();

function client(name, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const c = { ws, engine: null, me: 0 };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', room, name, token })));
    ws.on('message', (m) => {
      const msg = JSON.parse(m);
      if (msg.t === 'welcome') { c.engine = new Engine(msg.seed, msg.log); c.me = msg.you; c.start = msg.start; c.off = msg.now - Date.now(); resolve(c); }
      if (msg.t === 'entry') c.engine.add(msg.entry);
    });
  });
}
const a = await client('Ada', 'tok-a'), b = await client('Bo', 'tok-b');
const now = (c) => Math.floor((Date.now() + c.off - c.start) / 20);
const homeA = findHome(a.engine.world, a.engine.state, a.me, new Rng(1));
const homeB = findHome(b.engine.world, b.engine.state, b.me, new Rng(2));
const place = (c, home, type, s, dx) => c.ws.send(JSON.stringify({ t: 'place', entry: { tick: now(c), type, x: home[0] + dx, y: home[1], s, seed: 99 + dx } }));
place(a, homeA, T.FARM, 4, 0); place(b, homeB, T.FARM, 4, 0);
place(a, homeA, T.HOUSE, 3, 6); place(b, homeB, T.MILL, 2, 7);
await new Promise((r) => setTimeout(r, 1500));
const t = now(a);
a.engine.advanceTo(t); b.engine.advanceTo(t);
const ok = a.engine.hash() === b.engine.hash() && a.engine.log.length === 4;
console.log(`${ok ? 'ok  ' : 'FAIL'} two clients agree at tick ${t}: ${a.engine.hash()} / ${b.engine.hash()}, ${a.engine.log.length} entries, players ${a.me} & ${b.me}, buildings ${a.engine.state.buildings.length}`);
a.ws.close(); b.ws.close(); srv.kill();
process.exit(ok ? 0 : 1);
