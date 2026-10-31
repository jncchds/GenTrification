// A simple settler bot: picks a home and grows a village around it.
// Used for the demo village and for balance testing. It only produces log
// entries, so it plays by exactly the same rules as a human.
import { N } from './world.js';
import { T, DEFS } from './rules.js';
import { checkEntry } from './sim.js';
import { Rng } from './prng.js';

export function findHome(world, s, owner, rng) {
  let best = null, bestScore = -1;
  for (let k = 0; k < 4000; k++) {
    const x = 20 + rng.int(N - 40), y = 20 + rng.int(N - 40);
    if (checkEntry(world, s, { type: T.FARM, x, y, s: 4, owner, seed: 1 })) continue;
    let f = 0, trees = 0;
    for (let dy = -10; dy <= 10; dy += 2) for (let dx = -10; dx <= 10; dx += 2) {
      const i = (y + dy) * N + x + dx;
      f += world.fert0[i]; trees += s.trees[i];
    }
    const score = f + trees * 0.8 + (world.waterDist[y * N + x] < 8 ? 20000 : 0);
    if (score > bestScore) { bestScore = score; best = [x, y]; }
  }
  return best;
}

const PLAN = [
  [T.FARM, 4], [T.HOUSE, 3], [T.BEACON, 1], [T.MILL, 2], [T.HOUSE, 2], [T.FARM, 5], [T.HOUSE, 3], [T.PARK, 3],
  [T.FARM, 4], [T.HOUSE, 4], [T.HOUSE, 3], [T.MILL, 2], [T.FARM, 5], [T.PARK, 4], [T.HOUSE, 3],
];

export class Bot {
  constructor(engine, owner, seed = 1) {
    this.engine = engine; this.owner = owner;
    this.rng = new Rng(seed ^ (owner * 7919));
    this.home = null; this.step = 0;
  }
  // Returns a log entry to place now, or null.
  think() {
    const { world, state } = this.engine;
    if (!this.home) this.home = findHome(world, state, this.owner, this.rng);
    if (!this.home || this.step >= PLAN.length) return null;
    const [type, size] = PLAN[this.step];
    const p = state.players[this.owner];
    if (p && p.wood < DEFS[type].cost(size)) return null;
    const [hx, hy] = this.home;
    for (let r = 0; r < 26; r++) {
      for (let k = 0; k < 10 + r * 4; k++) {
        const a = this.rng.int(6283) / 1000;
        const x = Math.round(hx + Math.cos(a) * r * 1.3), y = Math.round(hy + Math.sin(a) * r * 1.3);
        const e = { tick: state.tick, owner: this.owner, type, x, y, s: size, seed: this.rng.next() };
        if (type === T.MILL && r < 8) continue; // mills go to the forest edge
        if (!checkEntry(world, state, e)) { this.step++; return e; }
      }
    }
    this.step++;
    return null;
  }
}
