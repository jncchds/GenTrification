// The walker's needs: cold, water and shelter; the away replay; save codes with player state;
// and the world staying a pure function of seed + log (player state never touches it).
import * as THREE from 'three';
import { Engine, encodeSave, decodeSave } from '../src/sim/engine.js';
import { T } from '../src/sim/rules.js';
import { N } from '../src/sim/world.js';
import { HOURS, YEAR_DAYS } from '../src/sim/climate.js';
import { heightAt, HALF } from '../src/render/common.js';
import { newPlayerState, stepNeeds, replayAway, lastHouse, waterAt, nearHearth, barnCenter } from '../src/player/needs.js';

globalThis.window = { addEventListener() {} };
globalThis.document = { pointerLockElement: null };
const { FirstPersonControls } = await import('../src/render/controls.js');

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${extra}`); if (!ok) failures++; };

// Seconds until warmth runs out (or Infinity) under a fixed environment.
function secondsToFaint(env, wet = 0) {
  const ps = { ...newPlayerState(), wet };
  for (let s = 0; s < 3600; s += 0.5) if (stepNeeds(ps, env, 0.5) === 'faint') return s;
  return Infinity;
}
const base = { airC: 10, wind: 0.3, rain: 0, snow: false, sun: 0, depth: 0, swimming: false, hearth: false, running: false };

check('mild summer day is comfortable', secondsToFaint({ ...base, airC: 21, sun: 1 }) === Infinity);
const winter = secondsToFaint({ ...base, airC: -5, wind: 0.5 });
check('a winter walk lasts a few minutes', winter > 90 && winter < 300, `${winter.toFixed(0)} s`);
const winterSwim = secondsToFaint({ ...base, airC: -5, wind: 0.5, depth: 1, swimming: true });
check('swimming in winter chills you faster', winterSwim < winter * 0.7, `${winterSwim.toFixed(0)} s`);
const summerSwim = secondsToFaint({ ...base, airC: 21, sun: 1, depth: 1, swimming: true });
check('a summer swim is safe for a good while', summerSwim > 300, `${summerSwim === Infinity ? 'never' : summerSwim.toFixed(0) + ' s'}`);
check('by a house you never freeze', secondsToFaint({ ...base, airC: -15, wind: 1, hearth: true }) === Infinity);

{ // Rain soaks you; a house dries and warms you.
  const ps = newPlayerState();
  for (let s = 0; s < 60; s++) stepNeeds(ps, { ...base, airC: 8, rain: 1 }, 1);
  const soaked = ps.wet, cold = ps.warmth;
  for (let s = 0; s < 20; s++) stepNeeds(ps, { ...base, airC: 8, hearth: true }, 1);
  check('rain soaks, a hearth dries and warms', soaked > 0.6 && ps.wet < soaked / 2 && ps.warmth > cold, `wet ${soaked.toFixed(2)} -> ${ps.wet.toFixed(2)}, warmth ${cold.toFixed(0)} -> ${ps.warmth.toFixed(0)}`);
}

// A village with two houses; the walker is left on a cold, high spot for a winter.
const eng = new Engine(20261031);
const st = eng.state;
let houses = 0, lastId = 0;
for (let y = 60; y < N - 60 && houses < 2; y += 3) for (let x = 60; x < N - 60 && houses < 2; x += 3) {
  const e = { tick: 0, owner: 1, type: T.HOUSE, x, y, s: 2, seed: 5 + houses };
  if (!eng.check(e)) { eng.add(e); eng.advanceTo(eng.state.tick + 1); houses++; lastId = eng.state.buildings.length; }
}
const hashBefore = eng.hash();
let peak = 0, px = 0, pz = 0;
for (let y = 10; y < N - 10; y += 4) for (let x = 10; x < N - 10; x += 4) {
  const h = eng.world.cellH[y * N + x];
  if (h > peak && !eng.world.water[y * N + x]) { peak = h; px = x; pz = y; }
}
const winterStart = 36 * HOURS;
const away = () => ({ ...newPlayerState(), x: px + 0.5 - N / 2, z: pz + 0.5 - N / 2 });
const a = away(), b = away();
const ra = replayAway(eng.world, eng.state, eng.seed, a, winterStart, winterStart + 6 * HOURS, 1, [0, 0]);
const rb = replayAway(eng.world, eng.state, eng.seed, b, winterStart, winterStart + 6 * HOURS, 1, [0, 0]);
const home = lastHouse(eng.state, 1);
check('left on a winter peak, the walker wakes at their last built house', ra === 'faint' && home.id === lastId &&
  Math.abs(a.x - (home.x - N / 2)) < home.s + 2 && Math.abs(a.z - (home.y - N / 2)) < home.s + 2, `house #${home.id} at ${home.x},${home.y}; woke at ${(a.x + N / 2).toFixed(1)},${(a.z + N / 2).toFixed(1)}`);
check('away replay is deterministic', ra === rb && a.x === b.x && a.warmth === b.warmth && a.wet === b.wet);
const sum = away();
check('a summer afternoon away is fine', replayAway(eng.world, eng.state, eng.seed, sum, 14 * HOURS + 12, 14 * HOURS + 18, 1, [0, 0]) === null, `warmth ${sum.warmth.toFixed(0)}`);
check('player state never changes the world', eng.hash() === hashBefore);

{ // Fires: next to a house, a mill's lodge or a farm's barn; not out in a farm's far corner.
  const add = (type, s, seed) => {
    for (let y = 40; y < N - 40; y += 2) for (let x = 40; x < N - 40; x += 2) {
      const e = { tick: eng.state.tick, owner: 1, type, x, y, s, seed };
      if (!eng.check(e)) { eng.add(e); eng.advanceTo(eng.state.tick + 1); return eng.state.buildings.at(-1); }
    }
  };
  const house = lastHouse(eng.state, 1);
  check('by the fire next to a house', nearHearth(eng.state, house.x + house.s / 2, house.y + house.s + 1.5));
  const mill = add(T.MILL, 2, 11);
  check('by the fire next to a mill', nearHearth(eng.state, mill.x + 1, mill.y + mill.s + 1.5));
  const farm = add(T.FARM, 4, 12);
  const [bx, by] = barnCenter(farm);
  check('by the fire next to a farm barn', nearHearth(eng.state, bx + 1.2, by + 0.8));
  const far = [farm.x + farm.s / 2 - (bx - farm.x - farm.s / 2), farm.y + farm.s / 2 - (by - farm.y - farm.s / 2)]; // the opposite corner
  const others = eng.state.buildings.filter((b) => b.alive && b !== farm && b.type !== T.FARM);
  const clear = others.every((b) => Math.hypot(Math.max(b.x - far[0], 0, far[0] - b.x - b.s), Math.max(b.y - far[1], 0, far[1] - b.y - b.s)) > 4);
  if (clear) check('no fire out in the far corner of a field', !nearHearth(eng.state, far[0], far[1]));
}

{ // Save codes carry the player state, and old codes without it still load.
  const ps = { x: -12.34, z: 56.7, yaw: 1.234, warmth: 64, wet: 0.5 };
  const code = encodeSave(eng.seed, eng.state.tick, eng.log, ps);
  const d = decodeSave(code);
  check('save code round-trips the player', d.player && Math.abs(d.player.x - ps.x) < 0.1 && Math.abs(d.player.z - ps.z) < 0.1 &&
    d.player.warmth === 64 && d.player.wet === 0.5 && d.log.length === eng.log.length, code.split('.').at(-1));
  const old = decodeSave(encodeSave(eng.seed, eng.state.tick, eng.log));
  check('old save codes still load', old.player === null && old.log.length === eng.log.length);
  const e2 = new Engine(d.seed, d.log); e2.advanceTo(d.tick);
  check('world from a save code with a player matches', e2.hash() === eng.hash());
}

{ // Deep water: the walker swims (floats at the surface) instead of being blocked.
  const world = eng.world;
  const fp = new FirstPersonControls(new THREE.PerspectiveCamera(), { addEventListener() {} }, world, () => false);
  let spot = null;
  for (let y = 30; y < N - 30 && !spot; y++) for (let x = 30; x < N - 30; x++) {
    const wx = x - HALF + 0.5, wz = y - HALF + 0.5, g = heightAt(world, wx, wz);
    if (waterAt(world, wx, wz, g).depth > 1) { spot = [wx, wz]; break; }
  }
  fp.focus(...spot);
  for (let i = 0; i < 30; i++) fp.update(1 / 60);
  const w = waterAt(world, spot[0], spot[1], heightAt(world, ...spot));
  check('deep water is swum, head above the surface', fp.swimming && fp.camera.position.y > w.surface, `eye ${fp.camera.position.y.toFixed(2)} vs surface ${w.surface.toFixed(2)}`);
}

process.exit(failures ? 1 : 0);
void YEAR_DAYS;
