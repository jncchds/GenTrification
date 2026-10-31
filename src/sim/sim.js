// The tick simulation. state(t) = simulate(seed, log, t). 1 tick = 1 hour.
// Integer math only.
//  - hourly: log entries, mills and farms (daylight only, weather permitting)
//  - daily per chunk (staggered across the 24 hours): forest regrowth, seeding, soil recovery
//  - daily at midnight: food and firewood use, population, nature health, score
// Chunks that cannot change (forest at equilibrium, soil recovered) are skipped,
// so long offline catch-ups stay cheap.
import { hash3, mix32 } from './prng.js';
import { N, CH, NC } from './world.js';
import { T, DEFS, ECON, START, rollBuilding, quirkOf, millRadius, parkRadius, houseCap } from './rules.js';
import { HOURS, weather, tempAt, dayStats, isDaylight, seasonOf } from './climate.js';

const GROW_R = 200;            // logistic r = 0.020 / day, in 1/10000
const SEASON_GROW = [1500, 1100, 450, 60];
const SEASON_BIRTH = [1300, 1100, 900, 600];
const SEED_CHANCE = 8;         // per-mille chance / day that a bare cell next to forest sprouts
const MILL_CELL_MAX = 12;      // max tree units a mill takes from one cell per hour
const THIN_FLOOR = 250;        // mills thin cells down to 25% of cap before clear-cutting

const chunkOfIndex = (i) => (((i / N) | 0) / CH | 0) * NC + ((i % N) / CH | 0);

export function createState(world) {
  if (!world.chunkK0) {
    world.chunkK0 = new Int32Array(NC * NC);
    for (let i = 0; i < N * N; i++) world.chunkK0[chunkOfIndex(i)] += world.cap[i];
  }
  return {
    tick: 0,
    trees: Int16Array.from(world.cap),   // forest starts at equilibrium
    fert: world.fert0.slice(),
    occ: new Int32Array(N * N),          // building id (1-based) or 0
    park: new Uint8Array(N * N),         // number of reserves covering the cell
    grow: new Uint8Array(N * N),         // extra regrowth from "Old grove" reserves
    active: new Uint8Array(NC * NC),
    chunkT: Int32Array.from(world.chunkK0),
    chunkPark: new Int32Array(NC * NC),
    chunkVer: new Uint32Array(NC * NC),  // bumped on any visible change (for the renderer)
    buildings: [],
    players: {},
    worldNature: 850,
  };
}

export function cloneState(s) {
  return {
    tick: s.tick,
    trees: s.trees.slice(), fert: s.fert.slice(), occ: s.occ.slice(), park: s.park.slice(), grow: s.grow.slice(),
    active: s.active.slice(), chunkT: s.chunkT.slice(), chunkPark: s.chunkPark.slice(), chunkVer: s.chunkVer.slice(),
    buildings: s.buildings.map((b) => ({ ...b })),
    players: Object.fromEntries(Object.entries(s.players).map(([k, p]) => [k, { ...p }])),
    worldNature: s.worldNature,
  };
}

function newPlayer(id) {
  return {
    id, wood: START.wood, food: START.food, people: START.people,
    acc: 0, dec: 0, leftToday: 0, stocked: true, cap: START.baseCap, staffing: 1000, workers: 0,
    fed: true, warm: true, nature: 850, cover: 1000, bio: 1000, parkScore: 0,
    sustained: START.people * 1000, prosperity: 0,
    foodIn: 0, woodIn: 0, foodDay: 0, woodDay: 0, foodUse: 0, woodUse: 0,
  };
}
export const playerOf = (s, owner) => s.players[owner] || null;
export const previewPlayer = (owner) => newPlayer(owner);

function touch(s, c) { s.active[c] = 1; s.chunkVer[c]++; }

// ---------------------------------------------------------------- placement

const inBounds = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < N && y < N;

// Returns null if the entry is valid in this state, or a human readable reason.
export function checkEntry(world, s, e) {
  if (e.type === T.DEMOLISH) {
    if (!inBounds(e.x, e.y)) return 'Out of bounds';
    const id = s.occ[e.y * N + e.x];
    const b = id ? s.buildings[id - 1] : null;
    if (!b || !b.alive) return 'Nothing to demolish';
    if (b.owner !== e.owner) return 'Not your building';
    return null;
  }
  const def = DEFS[e.type];
  if (!def) return 'Unknown building';
  const sz = e.s;
  if (!Number.isInteger(sz) || sz < def.sizes[0] || sz > def.sizes[1]) return 'Bad size';
  if (!Number.isInteger(e.x) || !Number.isInteger(e.y) || e.x < 0 || e.y < 0 || e.x + sz > N || e.y + sz > N) return 'Out of bounds';
  let fsum = 0;
  for (let y = e.y; y < e.y + sz; y++) for (let x = e.x; x < e.x + sz; x++) {
    const i = y * N + x;
    if (s.occ[i]) return 'Overlaps a building';
    if (world.water[i]) return 'Cannot build on water';
    if (world.slope[i] > def.maxSlope) return 'Too steep';
    fsum += s.fert[i];
  }
  if (e.type === T.FARM && fsum < 150 * sz * sz) return 'Soil too poor for a farm';
  const p = s.players[e.owner];
  const wood = p ? p.wood : START.wood;
  if (wood < def.cost(sz)) return 'Not enough wood';
  return null;
}

export function applyEntry(world, s, e) {
  if (checkEntry(world, s, e)) return false;
  if (!s.players[e.owner]) s.players[e.owner] = newPlayer(e.owner);
  const p = s.players[e.owner];
  if (e.type === T.DEMOLISH) { removeBuilding(s, s.buildings[s.occ[e.y * N + e.x] - 1]); return true; }

  const roll = rollBuilding(e.type, e.seed >>> 0);
  const b = { id: s.buildings.length + 1, type: e.type, x: e.x, y: e.y, s: e.s, seed: e.seed >>> 0, owner: e.owner,
    eff: roll.eff, quirk: roll.quirk, tick: s.tick, alive: true, out: 0, acc: 0 };
  s.buildings.push(b);
  p.wood -= DEFS[e.type].cost(e.s);
  let cleared = 0;
  for (let y = b.y; y < b.y + b.s; y++) for (let x = b.x; x < b.x + b.s; x++) {
    const i = y * N + x, c = chunkOfIndex(i);
    cleared += s.trees[i];
    s.chunkT[c] -= s.trees[i];
    s.trees[i] = 0;
    s.occ[i] = b.id;
    touch(s, c);
  }
  p.wood += Math.floor((cleared * ECON.woodPerTreeUnit) / ECON.clearShare);
  if (b.type === T.PARK) applyPark(s, b, 1);
  return true;
}

function removeBuilding(s, b) {
  b.alive = false;
  for (let y = b.y; y < b.y + b.s; y++) for (let x = b.x; x < b.x + b.s; x++) {
    const i = y * N + x;
    s.occ[i] = 0;
    touch(s, chunkOfIndex(i));
  }
  if (b.type === T.PARK) applyPark(s, b, -1);
}

function applyPark(s, b, sign) {
  const r = parkRadius(b), q = quirkOf(b);
  const cx = b.x + (b.s >> 1), cy = b.y + (b.s >> 1);
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if (x < 0 || y < 0 || x >= N || y >= N) continue;
    const dx = x - cx, dy = y - cy;
    if (dx * dx + dy * dy > r * r) continue;
    const i = y * N + x;
    s.park[i] += sign;
    if (q.grow) s.grow[i] += sign * q.grow;
    touch(s, chunkOfIndex(i));
  }
  s.chunkPark[chunkOfIndex(cy * N + cx)] += sign * Math.floor((b.s * b.s * (q.nature || 1000)) / 1000);
}

// ---------------------------------------------------------------- mills

const ringCache = new Map();
export function ringOffsets(r) {
  if (ringCache.has(r)) return ringCache.get(r);
  const out = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const d2 = dx * dx + dy * dy;
    if (d2 <= r * r) out.push([d2, dy, dx]);
  }
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const res = out.map(([, dy, dx]) => [dx, dy]);
  ringCache.set(r, res);
  return res;
}

function runMill(world, s, b, p) {
  const q = quirkOf(b);
  let quota = ECON.millCut * b.s;
  quota = Math.floor((quota * b.eff) / 1000);
  quota = Math.floor((quota * (q.out || 1000)) / 1000);
  quota = Math.floor((quota * p.staffing) / 1000);
  if (quota <= 0) return;
  const want = quota;
  const offs = ringOffsets(millRadius(b));
  const cx = b.x + (b.s >> 1), cy = b.y + (b.s >> 1);
  const floorPm = q.selective ? 600 : THIN_FLOOR;
  // Pass 1 thins nearby cells down to a floor (sustainable if regrowth keeps up).
  // Pass 2 clear-cuts when nothing above the floor is left: that is how forests collapse.
  for (let pass = 0; pass < (q.selective ? 1 : 2) && quota > 0; pass++) {
    for (let k = 0; k < offs.length && quota > 0; k++) {
      const x = cx + offs[k][0], y = cy + offs[k][1];
      if (x < 0 || y < 0 || x >= N || y >= N) continue;
      const i = y * N + x;
      if (s.occ[i] || s.park[i]) continue;
      const t = s.trees[i];
      if (t <= 0) continue;
      const keep = pass === 0 ? Math.floor((world.cap[i] * floorPm) / 1000) : 0;
      let take = t - keep;
      if (take <= 0) continue;
      if (take > MILL_CELL_MAX) take = MILL_CELL_MAX;
      if (take > quota) take = quota;
      s.trees[i] = t - take;
      quota -= take;
      const c = chunkOfIndex(i);
      s.chunkT[c] -= take;
      touch(s, c);
    }
  }
  const got = (want - quota) * ECON.woodPerTreeUnit;
  b.acc += got;
  p.wood += got;
  p.woodIn += got;
}

// ---------------------------------------------------------------- farms

function runFarm(world, s, b, p, w) {
  const q = quirkOf(b);
  const center = (b.y + (b.s >> 1)) * N + b.x + (b.s >> 1);
  const tC = tempAt(w.temp, world.cellH[center]);
  // Crops grow from 4 C (or -2 C in a greenhouse), best from 16 C, heat-stressed above 30 C.
  const lo = 40 - (q.cold || 0);
  let tf = Math.min(1000, Math.max(0, Math.floor(((tC - lo) * 1000) / 120)));
  if (tC > 300) tf = Math.max(300, tf - (tC - 300) * 20);
  if (tf <= 0) return;
  const wear = q.wear || 1000;
  let sum = 0;
  for (let y = b.y; y < b.y + b.s; y++) for (let x = b.x; x < b.x + b.s; x++) {
    const i = y * N + x;
    sum += s.fert[i];
    // Soil wears about wear/1000 points per working day (~12 daylight hours).
    if (hash3(world.seed ^ s.tick, i, 0xfa, 1) % 12000 < wear && s.fert[i] > 30) s.fert[i]--;
  }
  if ((s.tick & 7) === 0) touch(s, chunkOfIndex(b.y * N + b.x));
  let food = Math.floor((sum * ECON.farmYield) / 1000);
  food = Math.floor((food * b.eff) / 1000);
  food = Math.floor((food * (q.out || 1000)) / 1000);
  food = Math.floor((food * p.staffing) / 1000);
  food = Math.floor((food * tf) / 1000);
  b.acc += food;
  p.food += food;
  p.foodIn += food;
}

// ---------------------------------------------------------------- forest growth (daily per chunk)

function growChunk(world, s, c, day) {
  const seed = world.seed, salt = (seed ^ Math.imul(day, 0x9e37)) >>> 0;
  const season = seasonOf(day * HOURS);
  const ds = dayStats(seed, day);
  const rainF = 800 + Math.min(400, ds.rain);
  const baseR = Math.floor((GROW_R * SEASON_GROW[season] * rainF) / 1e6);
  const canSeed = season <= 1;
  const x0 = (c % NC) * CH, y0 = ((c / NC) | 0) * CH;
  let canChange = false, changed = false, sumT = 0;
  for (let y = y0; y < y0 + CH; y++) for (let x = x0; x < x0 + CH; x++) {
    const i = y * N + x;
    if (s.occ[i]) continue; // built-on cells: no trees; farm soil is handled by the farm
    const K = world.cap[i];
    let t = s.trees[i];
    if (t > 0 && t < K) {
      const R = baseR * (s.park[i] ? 2 : 1) + s.grow[i] * 60;
      const num = t * (K - t) * R;
      const den = K * 10000;
      let d = Math.floor(num / den);
      if (hash3(salt, i, 0x7e, 2) % den < num - d * den) d++;
      if (d > 0) { t += d; if (t > K) t = K; s.trees[i] = t; changed = true; }
      canChange = true;
    } else if (t === 0 && K > 0) {
      // Bare ground re-seeds only next to standing trees, and only in spring/summer.
      const nb = (x > 0 && s.trees[i - 1] > 300) || (x < N - 1 && s.trees[i + 1] > 300) ||
        (y > 0 && s.trees[i - N] > 300) || (y < N - 1 && s.trees[i + N] > 300);
      if (nb) {
        canChange = true;
        if (canSeed && hash3(salt, i, 0x5e, 3) % 1000 < SEED_CHANCE * (s.park[i] ? 2 : 1)) { s.trees[i] = t = 40; changed = true; }
      }
    }
    if (s.fert[i] < world.fert0[i]) {
      canChange = true;
      if ((hash3(salt, i, 0xf3, 4) & 1) === 0) { s.fert[i]++; changed = true; }
    }
    sumT += s.trees[i];
  }
  s.chunkT[c] = sumT;
  s.active[c] = canChange ? 1 : 0;
  if (changed) {
    s.chunkVer[c]++;
    const cx = c % NC, cy = (c / NC) | 0;
    if (cx > 0) s.active[c - 1] = 1;
    if (cx < NC - 1) s.active[c + 1] = 1;
    if (cy > 0) s.active[c - NC] = 1;
    if (cy < NC - 1) s.active[c + NC] = 1;
  }
}

// ---------------------------------------------------------------- nature & economy

// Nature health (per-mille) over a set of chunks. Derived, never stored as truth.
export function natureOf(world, s, chunks) {
  let T0 = 0, K0 = 0, healthy = 0, forested = 0, parkV = 0;
  for (const c of chunks) {
    const k = world.chunkK0[c];
    T0 += s.chunkT[c]; K0 += k; parkV += s.chunkPark[c];
    if (k > CH * CH * 120) { forested++; if (s.chunkT[c] * 2 >= k) healthy++; }
  }
  const cover = K0 ? Math.floor((T0 * 1000) / K0) : 1000;
  const bio = forested ? Math.floor((healthy * 1000) / forested) : 1000;
  const park = Math.min(1000, Math.floor((parkV * 1000) / (chunks.length * 40)));
  return { nature: Math.floor((600 * cover + 250 * bio + 150 * park) / 1000), cover, bio, park };
}

export const ALL_CHUNKS = Array.from({ length: NC * NC }, (_, i) => i);

// Chunks within one chunk of any of the player's buildings.
export function playerChunks(s, owner) {
  const set = new Uint8Array(NC * NC);
  for (const b of s.buildings) {
    if (!b.alive || b.owner !== owner) continue;
    const cx = ((b.x + (b.s >> 1)) / CH) | 0, cy = ((b.y + (b.s >> 1)) / CH) | 0;
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++)
      if (x >= 0 && y >= 0 && x < NC && y < NC) set[y * NC + x] = 1;
  }
  const out = [];
  for (let c = 0; c < NC * NC; c++) if (set[c]) out.push(c);
  return out;
}

function runEconomy(world, s, p, day) {
  let workers = 0, cap = START.baseCap, heatW = 0, heatSum = 0, birthW = 0, birthSum = 0;
  for (const b of s.buildings) {
    if (!b.alive || b.owner !== p.id) continue;
    workers += DEFS[b.type].workers(b.s);
    b.out = b.acc; b.acc = 0; // yesterday's output, for display
    if (b.type === T.HOUSE) {
      const hc = houseCap(b), q = quirkOf(b);
      cap += hc;
      heatW += hc; heatSum += hc * (q.heat || 1000);
      birthW += hc; birthSum += hc * (q.births || 1000);
    }
  }
  const heatMul = heatW ? Math.floor(heatSum / heatW) : 1000;
  const birthMul = birthW ? Math.floor(birthSum / birthW) : 1000;
  const ds = dayStats(world.seed, day);
  const season = seasonOf(day * HOURS);
  const pop = p.people;
  const cold = Math.max(0, 160 - ds.temp); // deci-degrees below 16 C
  const foodNeed = pop * ECON.foodPerPerson;
  const woodNeed = Math.floor((pop * (ECON.heatBase * 10 + ECON.heatPerDegree * cold) * heatMul) / 10000);
  p.fed = p.food >= foodNeed;
  p.warm = p.wood >= woodNeed;
  // Share of today's need that went unmet (per-mille): shortages hurt in proportion.
  const foodGap = foodNeed ? Math.floor(((foodNeed - Math.min(p.food, foodNeed)) * 1000) / foodNeed) : 0;
  const woodGap = woodNeed ? Math.floor(((woodNeed - Math.min(p.wood, woodNeed)) * 1000) / woodNeed) : 0;
  p.foodUse = foodNeed; p.woodUse = woodNeed;
  p.food -= Math.min(p.food, foodNeed);
  p.wood -= Math.min(p.wood, woodNeed);
  // Newcomers only settle when the stores look safe: a few days of food and firewood in hand.
  const stocked = p.food >= foodNeed * ECON.pantryDays && p.wood >= woodNeed * ECON.pantryDays;
  p.stocked = stocked;
  p.foodDay = p.foodIn; p.woodDay = p.woodIn; p.foodIn = 0; p.woodIn = 0;

  const chunks = playerChunks(s, p.id);
  const nat = natureOf(world, s, chunks.length ? chunks : ALL_CHUNKS);
  p.nature = nat.nature; p.cover = nat.cover; p.bio = nat.bio; p.parkScore = nat.park;

  let people = pop;
  p.leftToday = 0;
  if (p.fed && p.warm && people <= cap) {
    if (stocked && people < cap) {
      let rate = Math.floor((people * (12 + Math.floor((20 * p.nature) / 1000)) * birthMul) / 1000);
      rate = Math.floor((rate * SEASON_BIRTH[season]) / 1000) + 350; // settlers keep arriving while there is room
      p.acc += rate;
      while (p.acc >= 1000 && people < cap) { people++; p.acc -= 1000; }
      if (people >= cap) p.acc = 0;
    }
    p.dec = 0;
  } else {
    // Hungry, cold or crowded households move away (gradually, in proportion to the shortfall).
    p.dec += Math.floor((foodGap * (people * 40 + 200)) / 1000);
    p.dec += Math.floor((woodGap * (people * (season === 3 ? 30 : 10) + 100)) / 1000);
    if (people > cap) p.dec += (people - cap) * 80;
    while (p.dec >= 1000 && people > 0) { people--; p.dec -= 1000; p.leftToday++; }
    if (people === 0) p.dec = 0;
  }
  p.people = people;
  p.cap = cap;
  p.workers = workers;
  p.staffing = workers === 0 ? 1000 : Math.min(1000, Math.floor((people * 1000) / workers));
  const healthy = p.nature >= ECON.natureThreshold;
  p.sustained += Math.trunc(((healthy ? people * 1000 : 0) - p.sustained) / 30);
  if (healthy) p.prosperity += people;
}

// ---------------------------------------------------------------- the tick

// Advance one hour. `entries` are this tick's log entries, already in log order.
export function step(world, s, entries) {
  for (const e of entries) applyEntry(world, s, e);
  const t = s.tick, hour = t % HOURS, day = Math.floor(t / HOURS);
  const ids = Object.keys(s.players).map(Number).sort((a, b) => a - b);

  if (isDaylight(t)) {
    const w = weather(world.seed, t);
    const millsWork = !w.storm && !(w.snow && w.rain > 500);
    for (const b of s.buildings) {
      if (!b.alive) continue;
      const p = s.players[b.owner];
      if (b.type === T.MILL && millsWork) runMill(world, s, b, p);
      else if (b.type === T.FARM && !w.storm) runFarm(world, s, b, p, w);
    }
  }
  for (let c = hour; c < NC * NC; c += HOURS) if (s.active[c]) growChunk(world, s, c, day);
  if (hour === HOURS - 1) {
    for (const id of ids) runEconomy(world, s, s.players[id], day);
    s.worldNature = natureOf(world, s, ALL_CHUNKS).nature;
  }
  s.tick++;
}

// Stable hash of the full state, for determinism checks between clients.
export function hashState(s) {
  let h = mix32(s.tick);
  for (const a of [s.trees, s.fert, s.occ, s.park, s.grow, s.chunkT])
    for (let i = 0; i < a.length; i++) h = mix32((h ^ (a[i] & 0xffff) ^ (i << 16)) >>> 0);
  const txt = JSON.stringify([s.buildings, Object.keys(s.players).sort().map((k) => s.players[k])]);
  for (let i = 0; i < txt.length; i++) h = mix32((h ^ txt.charCodeAt(i)) >>> 0);
  return h.toString(16).padStart(8, '0');
}
