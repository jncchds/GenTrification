// Determinism test: the same seed + log must give bit-identical state no matter
// how the log arrives (all up front, late with rollbacks, or via a save code).
import { Engine, encodeSave, decodeSave } from '../src/sim/engine.js';
import { Rng } from '../src/sim/prng.js';
import { T } from '../src/sim/rules.js';
import { N } from '../src/sim/world.js';

const SEED = Number(process.argv[2] ?? 4242);
const TICKS = Number(process.argv[3] ?? 24 * 48 * 2); // two years
const rng = new Rng(SEED ^ 0xabc);
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${extra}`); if (!ok) failures++; };

// 1. Generate a plausible log by "playing" on engine A, with two players.
let t0 = performance.now();
const A = new Engine(SEED);
console.log(`world generated in ${(performance.now() - t0).toFixed(0)} ms`);
const homes = [];
for (let p = 0; p < 2; p++) {
  // Find a flat, fertile spot per player.
  for (let tries = 0; tries < 5000; tries++) {
    const x = 10 + rng.int(N - 30), y = 10 + rng.int(N - 30);
    if (!A.check({ tick: 0, owner: p + 1, type: T.FARM, x, y, s: 4, seed: 1 })) { homes.push([x, y]); break; }
  }
}
const types = [T.HOUSE, T.FARM, T.MILL, T.PARK, T.HOUSE, T.FARM];
t0 = performance.now();
for (let t = 0; t < TICKS; t++) {
  if (t % 30 === 5) {
    const owner = 1 + rng.int(2), [hx, hy] = homes[owner - 1];
    const type = rng.int(10) === 0 ? T.DEMOLISH : types[rng.int(types.length)];
    for (let tries = 0; tries < 40; tries++) {
      const e = { tick: t, owner, type, x: hx - 14 + rng.int(28), y: hy - 14 + rng.int(28), s: type === T.FARM ? 3 + rng.int(3) : 2 + rng.int(2), seed: rng.next() };
      if (!A.check(e) || tries === 39) { A.add(e); break; } // also log some invalid entries
    }
  }
  A.advanceTo(t + 1);
}
const simMs = performance.now() - t0;
const hashA = A.hash();
console.log(`A: ${TICKS} ticks, ${A.log.length} log entries, ${simMs.toFixed(0)} ms (${((simMs * 1000) / TICKS).toFixed(0)} us/tick)`);
for (const p of Object.values(A.state.players))
  console.log(`   player ${p.id}: people ${p.people}/${p.cap} food ${(p.food / 1000).toFixed(1)} wood ${(p.wood / 1000).toFixed(1)} nature ${p.nature} sustained ${(p.sustained / 1000).toFixed(1)}`);
console.log(`   buildings alive: ${A.state.buildings.filter((b) => b.alive).length}/${A.state.buildings.length}`);

// 2. Engine B: whole log up front, simulated in one go (offline catch-up).
t0 = performance.now();
const B = new Engine(SEED, A.log);
B.advanceTo(TICKS);
check('log up front == live play', B.hash() === hashA, `${B.hash()} vs ${hashA} (${(performance.now() - t0).toFixed(0)} ms)`);

// 3. Engine C: entries (tagged with server seq) arrive 0..60 ticks late and out of order -> rollbacks.
const C = new Engine(SEED);
const pending = A.log.map((e, i) => ({ e: { ...e, seq: i }, arrive: e.tick + rng.int(60), r: rng.next() }))
  .sort((a, b) => a.arrive - b.arrive || a.r - b.r);
let k = 0, rollbacks = 0;
C.onRollback = () => rollbacks++;
for (let t = 0; t <= TICKS; t++) {
  while (k < pending.length && pending[k].arrive <= t) { C.add(pending[k].e); k++; }
  if (t < TICKS) C.advanceTo(t + 1);
}
while (k < pending.length) C.add(pending[k++].e); // stragglers that arrive after the last tick
check('late, shuffled delivery with rollbacks', C.hash() === hashA, `(${rollbacks} rollbacks)`);

// 4. Save code round trip.
const code = encodeSave(SEED, TICKS, A.log);
const dec = decodeSave(code);
const E = new Engine(dec.seed, dec.log);
E.advanceTo(dec.tick);
check('save code round trip', E.hash() === hashA, `(${code.length} chars for ${A.log.length} entries)`);

// 5. Different seed -> different world.
check('different seed differs', new Engine(SEED + 1).hash() !== new Engine(SEED).hash());

process.exit(failures ? 1 : 0);
