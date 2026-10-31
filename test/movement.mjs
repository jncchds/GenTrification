// First-person movement vs terrain: steep faces block, slopes slow you down, flat ground is full speed.
import * as THREE from 'three';
import { generateWorld, N, V } from '../src/sim/world.js';
import { heightAt, HALF } from '../src/render/common.js';

globalThis.window = { addEventListener() {} };
globalThis.document = { pointerLockElement: null };
const { FirstPersonControls } = await import('../src/render/controls.js');

const world = generateWorld(20261031);
const fp = new FirstPersonControls(new THREE.PerspectiveCamera(), { addEventListener() {} }, world, () => false);
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${extra}`); if (!ok) failures++; };

// Walk "forward" (towards -z after yaw) for a while; return distance covered.
function walk(x, z, yaw, seconds = 2) {
  fp.focus(x, z); fp.yaw = yaw; fp.vy = 0; fp.onGround = true;
  fp.keys = new Set(['KeyW']);
  const x0 = fp.pos.x, z0 = fp.pos.z;
  for (let i = 0; i < seconds * 60; i++) fp.update(1 / 60);
  fp.keys = new Set();
  return Math.hypot(fp.pos.x - x0, fp.pos.z - z0);
}
const grade = (x, z, dx, dz) => (heightAt(world, x + dx * 0.5, z + dz * 0.5) - heightAt(world, x, z)) / 0.5;

// Find samples: flat dry ground, a moderate uphill, and a cliff face.
let flat = null, slope = null, cliff = null;
for (let y = 20; y < N - 20 && !(flat && slope && cliff); y += 1) for (let x = 20; x < N - 20; x += 1) {
  const wx = x - HALF + 0.5, wz = y - HALF + 0.5;
  if (heightAt(world, wx, wz) < 0.3) continue;
  // all three probe walking towards -z (yaw 0)
  const g1 = grade(wx, wz, 0, -1), g2 = grade(wx, wz - 0.5, 0, -1), g3 = grade(wx, wz - 1, 0, -1);
  if (!flat && Math.abs(g1) < 0.05 && Math.abs(g2) < 0.05 && Math.abs(g3) < 0.05 && heightAt(world, wx, wz - 6) > 0.3 && Math.abs(grade(wx, wz - 3, 0, -1)) < 0.1) flat = [wx, wz];
  if (!slope && g1 > 0.35 && g1 < 0.6 && g2 > 0.35 && g2 < 0.6 && g3 > 0.3 && g3 < 0.6) slope = [wx, wz];
  if (!cliff && g1 > 0.2 && g1 < 0.6 && g2 > 2.2) cliff = [wx, wz];
}
const dFlat = walk(...flat, 0), dSlope = walk(...slope, 0, 1);
check('flat ground walks at full speed', dFlat > 2.4 * 2 * 0.9, `${dFlat.toFixed(2)} units in 2 s`);
check('walking uphill is slower', dSlope < 2.6 * 0.85, `${dSlope.toFixed(2)} units in 1 s on a ~${(Math.atan(grade(...slope, 0, -1)) * 57.3).toFixed(0)}° slope`);
fp.focus(...cliff);
const top = Math.max(...[0, 0.5, 1, 1.5, 2].map((d) => heightAt(world, cliff[0], cliff[1] - d)));
walk(...cliff, 0, 3);
check('cannot walk up a cliff face', fp.pos.y < top - 0.5, `stopped at y=${fp.pos.y.toFixed(2)}, top ${top.toFixed(2)}${fp.tooSteep ? ' (too steep)' : ''}`);
process.exit(failures ? 1 : 0);
void V;
