// Timeline: seed + ordered placement log -> state at any tick.
// Keeps periodic snapshots so a late log entry (multiplayer) only replays a few days.
import { generateWorld } from './world.js';
import { createState, cloneState, step, checkEntry, hashState } from './sim.js';

const SNAP_EVERY = 96;   // ticks (4 days)
const SNAP_KEEP = 40;

// Log entry: { tick, owner, type, x, y, s, seed }. Order within a tick is log order.
// `seq` (optional) is the server's global order; same-tick entries apply in seq order.
export function normEntry(e) {
  const n = { tick: e.tick | 0, owner: e.owner | 0, type: e.type | 0, x: e.x | 0, y: e.y | 0, s: e.s | 0, seed: e.seed >>> 0 };
  if (e.seq !== undefined) n.seq = e.seq | 0;
  return n;
}

export class Engine {
  constructor(seed, log = []) {
    this.seed = seed >>> 0;
    this.world = generateWorld(this.seed);
    this.state = createState(this.world);
    this.log = [];
    this.byTick = new Map();
    this.snaps = [cloneState(this.state)];
    this.epoch = 0;          // bumped on rollback so the renderer refreshes everything
    this.onRollback = null;
    for (const e of log) this.add(e, false);
  }

  add(raw, allowRollback = true) {
    const e = normEntry(raw);
    this.log.push(e);
    let list = this.byTick.get(e.tick);
    if (!list) this.byTick.set(e.tick, (list = []));
    let at = list.length;
    if (e.seq !== undefined) while (at > 0 && list[at - 1].seq !== undefined && list[at - 1].seq > e.seq) at--;
    list.splice(at, 0, e);
    if (e.tick < this.state.tick) {
      if (!allowRollback) throw new Error('entry in the past');
      this.rollback(e.tick);
    }
    return e;
  }

  // Re-simulate from the latest snapshot at or before tick t, back up to where we were.
  rollback(t) {
    const target = this.state.tick;
    let k = this.snaps.length - 1;
    while (k > 0 && this.snaps[k].tick > t) k--;
    this.snaps.length = k + 1;
    this.state = cloneState(this.snaps[k]);
    this.epoch++;
    this.advanceTo(target);
    if (this.onRollback) this.onRollback();
  }

  advanceTo(t, budgetMs = Infinity) {
    const start = performance.now();
    while (this.state.tick < t) {
      step(this.world, this.state, this.byTick.get(this.state.tick) || []);
      if (this.state.tick % SNAP_EVERY === 0) {
        this.snaps.push(cloneState(this.state));
        if (this.snaps.length > SNAP_KEEP) this.snaps.splice(1, 1); // always keep tick 0
      }
      if ((this.state.tick & 15) === 0 && performance.now() - start > budgetMs) return false;
    }
    return true;
  }

  check(e) { return checkEntry(this.world, this.state, normEntry(e)); }
  hash() { return hashState(this.state); }
}

// ---- Save codes: a save is just numbers. "GT1.<seed>.<tick>.<base64url varints>"

function pushVarint(out, v) { v >>>= 0; while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v >>>= 7; } out.push(v); }
function readVarint(bytes, pos) { let v = 0, shift = 0, b; do { b = bytes[pos.i++]; v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80); return v; }

export function encodeSave(seed, tick, log) {
  const bytes = [];
  let last = 0;
  for (const e of log) {
    pushVarint(bytes, e.tick - last); last = e.tick;
    pushVarint(bytes, e.owner); pushVarint(bytes, e.type); pushVarint(bytes, e.x); pushVarint(bytes, e.y);
    pushVarint(bytes, e.s); pushVarint(bytes, e.seed);
  }
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
  return `GT1.${seed >>> 0}.${tick}.${b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

export function decodeSave(code) {
  const m = /^GT1\.(\d+)\.(\d+)\.([A-Za-z0-9_-]*)$/.exec(code.trim());
  if (!m) throw new Error('Not a save code');
  const b64 = m[3].replace(/-/g, '+').replace(/_/g, '/');
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const bytes = Array.from(bin, (c) => c.charCodeAt(0));
  const pos = { i: 0 }, log = [];
  let tick = 0;
  while (pos.i < bytes.length) {
    tick += readVarint(bytes, pos);
    log.push({ tick, owner: readVarint(bytes, pos), type: readVarint(bytes, pos), x: readVarint(bytes, pos), y: readVarint(bytes, pos), s: readVarint(bytes, pos), seed: readVarint(bytes, pos) });
  }
  return { seed: Number(m[1]) >>> 0, tick: Number(m[2]), log };
}

export { hashState };
