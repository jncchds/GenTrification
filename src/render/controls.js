import * as THREE from 'three';
import { HALF, heightAt } from './common.js';

// RTS camera: WASD / arrows / edge-free drag to pan, right-drag (or Q/E) to rotate, wheel to zoom.
export class RTSControls {
  constructor(camera, dom, world) {
    this.camera = camera; this.dom = dom; this.world = world;
    this.target = new THREE.Vector3(0, 0, 0);
    this.dist = 70; this.yaw = 0.6; this.pitch = 0.85;
    this.goal = { dist: this.dist, yaw: this.yaw, pitch: this.pitch, target: this.target.clone() };
    this.keys = new Set();
    this.drag = null;
    this.enabled = false;
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      if (e.button === 2 || e.button === 1) { this.drag = { b: e.button, x: e.clientX, y: e.clientY }; dom.setPointerCapture(e.pointerId); }
    });
    dom.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      this.drag.x = e.clientX; this.drag.y = e.clientY;
      if (this.drag.b === 2 && !e.shiftKey) {
        this.goal.yaw -= dx * 0.005;
        this.goal.pitch = THREE.MathUtils.clamp(this.goal.pitch + dy * 0.004, 0.18, 1.45);
      } else this.pan(-dx * this.dist * 0.0016, dy * this.dist * 0.0016); // ground follows the cursor
    });
    dom.addEventListener('pointerup', () => { this.drag = null; });
    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.enabled) return;
      this.goal.dist = THREE.MathUtils.clamp(this.goal.dist * Math.exp(e.deltaY * 0.0012), 8, 260);
    }, { passive: false });
    window.addEventListener('keydown', (e) => { if (!e.target.closest?.('input,textarea')) this.keys.add(e.code); });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }
  pan(right, fwd) {
    const c = Math.cos(this.goal.yaw), s = Math.sin(this.goal.yaw);
    this.goal.target.x += right * c - fwd * s;
    this.goal.target.z += -right * s - fwd * c;
    this.goal.target.x = THREE.MathUtils.clamp(this.goal.target.x, -HALF - 20, HALF + 20);
    this.goal.target.z = THREE.MathUtils.clamp(this.goal.target.z, -HALF - 20, HALF + 20);
  }
  focus(x, z) { this.goal.target.set(x, 0, z); }
  update(dt) {
    if (!this.enabled) return;
    const k = this.keys, sp = this.dist * 0.9 * dt;
    if (k.has('KeyW') || k.has('ArrowUp')) this.pan(0, sp);
    if (k.has('KeyS') || k.has('ArrowDown')) this.pan(0, -sp);
    if (k.has('KeyA') || k.has('ArrowLeft')) this.pan(-sp, 0);
    if (k.has('KeyD') || k.has('ArrowRight')) this.pan(sp, 0);
    if (k.has('KeyQ')) this.goal.yaw += 1.4 * dt;
    if (k.has('KeyE')) this.goal.yaw -= 1.4 * dt;
    const a = 1 - Math.exp(-dt * 10);
    this.yaw += (this.goal.yaw - this.yaw) * a;
    this.pitch += (this.goal.pitch - this.pitch) * a;
    this.dist += (this.goal.dist - this.dist) * a;
    this.target.x += (this.goal.target.x - this.target.x) * a;
    this.target.z += (this.goal.target.z - this.target.z) * a;
    const gy = Math.max(0, heightAt(this.world, this.target.x, this.target.z));
    this.target.y += (gy - this.target.y) * (1 - Math.exp(-dt * 4));
    const cp = Math.cos(this.pitch);
    const pos = new THREE.Vector3(
      this.target.x + Math.sin(this.yaw) * cp * this.dist,
      this.target.y + Math.sin(this.pitch) * this.dist,
      this.target.z + Math.cos(this.yaw) * cp * this.dist);
    const floor = Math.max(0, heightAt(this.world, pos.x, pos.z)) + 1.5;
    if (pos.y < floor) pos.y = floor;
    this.camera.position.copy(pos);
    this.camera.lookAt(this.target);
  }
}

// First person: walk the world. WASD + mouse look (pointer lock), Shift runs, Space jumps.
// Houses and mills block movement; deep water does too.
export class FirstPersonControls {
  constructor(camera, dom, world, blocked) {
    this.camera = camera; this.dom = dom; this.world = world;
    this.blocked = blocked;               // (x, z) -> true if the cell can't be entered
    this.pos = new THREE.Vector3(0, 0, 0);
    this.target = this.pos;               // what grass / trees / shadows follow
    this.yaw = 0; this.pitch = -0.1;
    this.vy = 0; this.onGround = true;
    this.eye = 0.45;                      // 1 cell ~ 4 m, so eyes at ~1.8 m
    this.keys = new Set();
    this.enabled = true;
    this.goal = { target: this.pos };
    dom.addEventListener('mousemove', (e) => {
      if (!this.enabled || document.pointerLockElement !== dom) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.0022, -1.45, 1.45);
    });
    window.addEventListener('keydown', (e) => { if (!e.target.closest?.('input,textarea')) this.keys.add(e.code); });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }
  lock() { if (document.pointerLockElement !== this.dom) this.dom.requestPointerLock?.()?.catch?.(() => {}); }
  look(dx, dy) {
    this.yaw -= dx;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy, -1.45, 1.45);
  }
  get locked() { return document.pointerLockElement === this.dom; }
  focus(x, z) { this.pos.set(x, Math.max(0, heightAt(this.world, x, z)), z); }
  ground(x, z) { return heightAt(this.world, x, z); }
  update(dt) {
    if (!this.enabled) return;
    const k = this.keys;
    let f = 0, r = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) f += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) f -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) r += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) r -= 1;
    // Virtual joystick (touch): analog; pushing to the rim runs.
    const tm = this.touchMove;
    let run = k.has('ShiftLeft') || k.has('ShiftRight');
    if (tm && (tm.f || tm.r)) { f += tm.f; r += tm.r; run = run || Math.hypot(tm.f, tm.r) > 0.92; }
    const want = Math.min(1, Math.hypot(f, r));
    const len = Math.hypot(f, r) || 1;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const mx = (fx * f - fz * r) / len, mz = (fz * f + fx * r) / len; // unit walking direction
    const cur = this.ground(this.pos.x, this.pos.z);
    const LOOK = 0.3;                       // look a little ahead for a stable incline reading
    const gradeTo = (dirx, dirz) => (this.ground(this.pos.x + dirx * LOOK, this.pos.z + dirz * LOOK) - cur) / LOOK;
    // Incline along the walking direction: climbing is slower, going downhill a little faster.
    const grade = want > 0 ? gradeTo(mx, mz) : 0;
    this.grade = grade;
    const slopeK = grade > 0 ? Math.max(0.3, 1 - grade * 0.75) : Math.min(1.2, 1 - grade * 0.2);
    const speed = (run ? 7.5 : 2.6) * dt * want * (this.onGround ? slopeK : 0.8);
    const dx = mx * speed, dz = mz * speed;
    const MAX_GRADE = 1.0;                  // ~45 degrees: steeper than this cannot be walked up
    this.tooSteep = false;
    // Move one axis at a time so we slide along obstacles and steep faces.
    const tryMove = (nx, nz, dirx, dirz) => {
      if (Math.abs(nx) > HALF - 0.5 || Math.abs(nz) > HALF - 0.5) return false;
      if (this.blocked(nx, nz)) return false;
      const g = this.ground(nx, nz);
      if (g < -0.35) return false;          // too deep to wade
      if (!this.onGround) return g <= this.pos.y + 0.02; // in the air: only over ground below our feet (jump onto ledges)
      if (gradeTo(dirx, dirz) > MAX_GRADE && g > cur) { this.tooSteep = true; return false; } // cliff or steep climb
      return true;
    };
    if (dx && tryMove(this.pos.x + dx, this.pos.z, Math.sign(dx), 0)) this.pos.x += dx;
    if (dz && tryMove(this.pos.x, this.pos.z + dz, 0, Math.sign(dz))) this.pos.z += dz;
    // Standing on ground steeper than ~50 degrees: slide down it.
    if (this.onGround) {
      const e = 0.2;
      const gx = (this.ground(this.pos.x + e, this.pos.z) - this.ground(this.pos.x - e, this.pos.z)) / (2 * e);
      const gz = (this.ground(this.pos.x, this.pos.z + e) - this.ground(this.pos.x, this.pos.z - e)) / (2 * e);
      const steep = Math.hypot(gx, gz);
      if (steep > 1.2) {
        const s = Math.min(4, (steep - 1.2) * 5) * dt / steep;
        const nx = this.pos.x - gx * s, nz = this.pos.z - gz * s;
        if (Math.abs(nx) < HALF - 0.5 && Math.abs(nz) < HALF - 0.5 && !this.blocked(nx, nz) && this.ground(nx, nz) > -0.35) { this.pos.x = nx; this.pos.z = nz; }
      }
    }
    const g = Math.max(this.ground(this.pos.x, this.pos.z), -0.3);
    if ((k.has('Space') || this.wantJump) && this.onGround) { this.vy = 3.2; this.onGround = false; }
    this.wantJump = false;
    this.vy -= 9.0 * dt;
    this.pos.y += this.vy * dt;
    if (this.pos.y <= g) {
      // Smooth stepping up slopes, snap down when walking downhill.
      this.pos.y = this.onGround ? THREE.MathUtils.lerp(this.pos.y, g, 1 - Math.exp(-dt * 18)) : g;
      if (this.pos.y < g) this.pos.y = Math.max(this.pos.y, g - 0.05);
      this.vy = 0; this.onGround = true;
    } else if (this.onGround && this.pos.y - g < 0.25) { this.pos.y = g; this.vy = 0; }
    else this.onGround = false;
    // Head bob while walking.
    const moving = (f || r) && this.onGround;
    this.bob = (this.bob || 0) + (moving ? dt * (speed / dt) * 2.2 : 0);
    const bob = moving ? Math.sin(this.bob) * 0.012 : 0;
    this.camera.position.set(this.pos.x, this.pos.y + this.eye + bob, this.pos.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}

// Ray-march the heightfield (and sea) to find the picked ground point.
export function pickGround(world, camera, ndc, maxDist = 900) {
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  const o = ray.ray.origin, d = ray.ray.direction;
  let prev = 0;
  const ground = (t) => { const x = o.x + d.x * t, z = o.z + d.z * t; return o.y + d.y * t - Math.max(0, heightAt(world, x, z)); };
  for (let t = 0.05; t < maxDist; t += Math.max(0.05, t * 0.01)) {
    if (ground(t) < 0) {
      let lo = prev, hi = t;
      for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; if (ground(m) < 0) hi = m; else lo = m; }
      const p = o.clone().addScaledVector(d, hi);
      if (Math.abs(p.x) > HALF || Math.abs(p.z) > HALF) return null;
      return p;
    }
    prev = t;
  }
  return null;
}
