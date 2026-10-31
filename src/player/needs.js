// The walker's own needs: warmth and wetness.
//
// This is player state, kept apart from the world simulation: the world is still a pure function of
// seed + build log, and the walker adds a small state of its own (position, warmth, wetness) that the
// world never reads. Needs run in real seconds while you play. While you are away they are replayed
// hour by hour against the seeded weather (one game hour = 5 real seconds at 1x), so the result is a
// pure function of seed + log + player state too.
//
//  - Cold air, wind, being wet and being in water make you lose warmth.
//  - Rain and snow slowly soak you; wading soaks you fast, swimming at once. You dry off in warm air.
//  - Standing next to a house, a mill's lodge or a farm's barn warms and dries you quickly (a fire nearby).
//  - Cold slows you down. If warmth runs out you wake up by the fire at your last built house.
import { weather, tempAt } from '../sim/climate.js';
import { T } from '../sim/rules.js';
import { N, V, WATER } from '../sim/world.js';
import { Rng } from '../sim/prng.js';

export const COMFORT = 12;      // °C felt: below this you lose warmth
export const HEARTH_R = 4;      // cells from a house (or mill) footprint that count as "by the fire"
export const BARN_R = 2.5;      // cells from the centre of a farm's barn
export const SECONDS_PER_TICK = 5;

export const newPlayerState = () => ({ x: null, z: null, yaw: 0, warmth: 100, wet: 0 });

// What the walker feels right now. env: { airC, wind 0..1, rain 0..1, snow, sun 0..1, depth (water above the
// ground at your feet, world units), swimming, hearth, running }.
export function feltTemp(env, wet) {
  let c = env.airC;
  if (c < 18) c -= env.wind * 7;            // wind chill
  c -= wet * 6;                             // wet clothes
  if (env.depth > 0.05) c -= env.swimming ? 9 : 4; // water pulls heat out of you
  c += (env.sun || 0) * 4;                  // sunshine on your face
  if (env.running) c += 3;
  if (env.hearth) c = Math.max(c, 24);
  return c;
}

// Advance needs by dt real seconds. Mutates ps; returns 'faint' when warmth runs out.
export function stepNeeds(ps, env, dt) {
  // Wetness first: water and rain soak, warmth dries.
  let soak = 0;
  if (env.swimming) soak = 1;
  else if (env.depth > 0.05) soak = 0.25;
  else if (env.rain > 0) soak = env.rain * (env.snow ? 0.008 : 0.02);
  if (env.hearth) soak = Math.min(soak, 0);
  if (soak > 0) ps.wet = Math.min(1, ps.wet + soak * dt);
  else ps.wet = Math.max(0, ps.wet - dt * (0.004 + Math.max(0, env.airC) * 0.0015 + (env.sun || 0) * 0.01 + (env.hearth ? 0.08 : 0)));

  const felt = feltTemp(env, ps.wet);
  if (felt < COMFORT) ps.warmth -= (COMFORT - felt) * 0.03 * dt;
  else ps.warmth += (env.hearth ? 3 : 0.5 + (felt - COMFORT) * 0.05) * dt;
  ps.warmth = Math.min(100, ps.warmth);
  ps.felt = felt;
  if (ps.warmth <= 0) { ps.warmth = 0; return 'faint'; }
  return null;
}

// Walking speed multiplier from the cold: full speed above 40 warmth, down to 70% when frozen.
export const coldSpeed = (warmth) => 0.7 + 0.3 * Math.min(1, warmth / 40);

// ---- helpers shared by the live game and the offline replay

const HS = 0.016;
const hY = (h) => (h - WATER) * HS;

// Water depth (world units) at a world position, from the nearest vertex's water surface.
export function waterAt(world, wx, wz, groundY) {
  const vx = Math.round(wx + N / 2), vz = Math.round(wz + N / 2);
  if (vx < 0 || vz < 0 || vx >= V || vz >= V) return { surface: null, depth: 0 };
  const s = world.surf[vz * V + vx];
  if (!s) return { surface: null, depth: 0 };
  const surface = hY(s);
  return { surface, depth: Math.max(0, surface - groundY) };
}

// Where a farm's barn stands (cell coordinates of its centre). The renderer places it with the
// first two rolls of the building's seeded random stream (see farmGrammar in render/buildings.js).
export function barnCenter(b) {
  const r = new Rng(b.seed ^ (b.type * 0x9e3779b9));
  const c = r.next() / 4294967296 < 0.5 ? -1 : 1, c2 = r.next() / 4294967296 < 0.5 ? -1 : 1;
  return [b.x + b.s / 2 + c * (b.s / 2 - 1.0), b.y + b.s / 2 + c2 * (b.s / 2 - 0.8)];
}

// Is there a fire near this spot? (px, py) in cell units, fractional (world x/z + N/2).
// Houses and mills warm you within HEARTH_R of their footprint; farms only near their barn.
export function nearHearth(state, px, py) {
  for (const b of state.buildings) {
    if (!b.alive) continue;
    if (b.type === T.HOUSE || b.type === T.MILL) {
      const dx = Math.max(b.x - px, 0, px - (b.x + b.s)), dy = Math.max(b.y - py, 0, py - (b.y + b.s));
      if (dx * dx + dy * dy <= HEARTH_R * HEARTH_R) return true;
    } else if (b.type === T.FARM) {
      const [bx, by] = barnCenter(b);
      if ((px - bx) ** 2 + (py - by) ** 2 <= BARN_R * BARN_R) return true;
    }
  }
  return false;
}

// The house you wake up at: your most recently built house still standing.
export function lastHouse(state, owner) {
  for (let k = state.buildings.length - 1; k >= 0; k--) {
    const b = state.buildings[k];
    if (b.alive && b.owner === owner && b.type === T.HOUSE) return b;
  }
  return null;
}

// Weather as the walker feels it at a spot (air temperature with altitude, wind, rain, sun).
// (px, py) in cell units, fractional.
export function envAt(world, state, seed, tick, px, py, extra = {}) {
  const w = weather(seed, tick);
  const cx = Math.floor(px), cy = Math.floor(py);
  const i = Math.min(N - 1, Math.max(0, cy)) * N + Math.min(N - 1, Math.max(0, cx));
  const airC = tempAt(w.temp, world.cellH[i]) / 10;
  const hour = tick % 24;
  const day = hour >= 7 && hour <= 18;
  return {
    airC, wind: w.wind / 1023, rain: w.rain / 1000, snow: w.snow,
    sun: day && w.cloud < 430 ? 1 : 0,
    depth: 0, swimming: false, running: false,
    hearth: nearHearth(state, px, py),
    ...extra,
  };
}

// Replay the walker standing still from tick `from` to `to` (they were away). Returns 'faint' if
// warmth ran out at some point; the caller then moves them to their last built house.
export function replayAway(world, state, seed, ps, from, to, owner, fallback) {
  if (ps.x === null) return null;
  const px = ps.x + N / 2, py = ps.z + N / 2, cx = Math.floor(px), cy = Math.floor(py);
  const groundY = world.cellH[Math.min(N - 1, Math.max(0, cy)) * N + Math.min(N - 1, Math.max(0, cx))];
  const wa = waterAt(world, ps.x, ps.z, hY(groundY));
  for (let t = from; t < to; t++) {
    const env = envAt(world, state, seed, t, px, py, { depth: wa.depth, swimming: wa.depth > 0.35 });
    if (stepNeeds(ps, env, SECONDS_PER_TICK) === 'faint') { wakeAtHome(world, state, ps, owner, fallback); return 'faint'; }
  }
  return null;
}

// Move the walker next to their last built house, warmed up and dry. Without a house they wake at
// `fallback` ([x, z] world position, e.g. where they first arrived). Returns the house or null.
export function wakeAtHome(world, state, ps, owner, fallback) {
  ps.warmth = 70; ps.wet = 0;
  const b = lastHouse(state, owner);
  if (!b) { if (fallback) [ps.x, ps.z] = fallback; return null; }
  // Stand just outside the house's front (south side), on dry land if we can find it.
  for (const [dx, dy] of [[b.s >> 1, b.s], [b.s, b.s >> 1], [-1, b.s >> 1], [b.s >> 1, -1], [b.s, b.s]]) {
    const x = b.x + dx, y = b.y + dy;
    if (x < 0 || y < 0 || x >= N || y >= N) continue;
    const i = y * N + x;
    if (state.occ[i] || world.water[i]) continue;
    ps.x = x + 0.5 - N / 2; ps.z = y + 0.5 - N / 2;
    return b;
  }
  ps.x = b.x + b.s / 2 - N / 2; ps.z = b.y + b.s + 0.5 - N / 2;
  return b;
}
