import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { V } from '../sim/world.js';
import { T, millRadius, parkRadius } from '../sim/rules.js';
import { hY, HALF, frand } from './common.js';

const col = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
export const OWNER_COLORS = [col(0.9, 0.3, 0.25), col(0.25, 0.5, 0.9), col(0.95, 0.75, 0.2), col(0.55, 0.3, 0.8), col(0.2, 0.75, 0.5), col(0.95, 0.5, 0.15), col(0.85, 0.35, 0.65), col(0.4, 0.8, 0.9)];
export const ownerColor = (o) => OWNER_COLORS[((o % 8) + 8) % 8];

const WALLS = [col(0.94, 0.89, 0.77), col(0.96, 0.95, 0.91), col(0.91, 0.77, 0.52), col(0.93, 0.80, 0.75), col(0.80, 0.86, 0.80)];
const ROOFS = [col(0.74, 0.33, 0.22), col(0.33, 0.38, 0.48), col(0.78, 0.64, 0.36), col(0.42, 0.52, 0.32), col(0.55, 0.25, 0.22)];
const STONE = col(0.58, 0.56, 0.52), WOOD = col(0.50, 0.36, 0.24), DARK = col(0.22, 0.16, 0.12), GLASS = col(0.20, 0.26, 0.32), BARK = col(0.40, 0.28, 0.18), LOGEND = col(0.82, 0.68, 0.48);

// ---- tiny geometry grammar helpers

class Kit {
  constructor() { this.parts = []; }
  add(geo, color, emit = 0) {
    geo = geo.index ? geo.toNonIndexed() : geo;
    delete geo.attributes.uv;
    const n = geo.attributes.position.count;
    const c = new Float32Array(n * 3), e = new Float32Array(n).fill(emit);
    for (let i = 0; i < n; i++) c.set([color.r, color.g, color.b], i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    geo.setAttribute('aEmit', new THREE.BufferAttribute(e, 1));
    this.parts.push(geo);
    return geo;
  }
  // Boxes get softly rounded edges (less edgy, catches light on the corners).
  box(x, y, z, w, h, d, color, rot = 0, emit = 0) {
    const r = Math.min(0.06, Math.min(w, h, d) * 0.3);
    const g = r > 0.012 ? new RoundedBoxGeometry(w, h, d, 2, r) : new THREE.BoxGeometry(w, h, d);
    return this.add(g.translate(0, h / 2, 0).rotateY(rot).translate(x, y, z), color, emit);
  }
  cyl(x, y, z, r0, r1, h, color, seg = 16) { return this.add(new THREE.CylinderGeometry(r1, r0, h, seg).translate(x, y + h / 2, z), color); }
  ball(x, y, z, r, color, sy = 1, emit = 0) { return this.add(new THREE.IcosahedronGeometry(r, 2).scale(1, sy, 1).translate(x, y, z), color, emit); }
  // Gable roof over a w x d footprint, ridge along X.
  gable(x, y, z, w, d, rh, o, roofC, wallC, rot = 0) {
    const W = w / 2 + o, D = d / 2 + o, slant = Math.hypot(D, rh), ang = Math.atan2(rh, D);
    // Two tilted roof slabs meeting at the ridge.
    for (const side of [1, -1]) {
      const g = new THREE.BoxGeometry(2 * W, 0.07, slant).rotateX(side * ang).translate(0, rh / 2 + 0.035, (side * D) / 2);
      this.add(g.rotateY(rot).translate(x, y, z), roofC);
    }
    // Pentagonal gable ends filling the wall up to the roof line.
    const gd = d / 2, gw = w / 2, eave = rh * (1 - gd / D);
    const shape = new THREE.Shape([new THREE.Vector2(-gd, 0), new THREE.Vector2(gd, 0), new THREE.Vector2(gd, eave), new THREE.Vector2(0, rh), new THREE.Vector2(-gd, eave)]);
    for (const sx of [1, -1]) {
      const g = new THREE.ShapeGeometry(shape).rotateY((sx * Math.PI) / 2).translate(sx * gw, 0, 0);
      this.add(g.rotateY(rot).translate(x, y, z), wallC);
    }
  }
  build() { return mergeGeometries(this.parts); }
}

// ---- grammars per building type

function cottage(k, rnd, x, z, w, d, rot) {
  const wallC = WALLS[Math.floor(rnd() * WALLS.length)], roofC = ROOFS[Math.floor(rnd() * ROOFS.length)];
  const floors = w > 1.5 && rnd() < 0.4 ? 2 : 1;
  const wh = 0.7 + rnd() * 0.25 + (floors - 1) * 0.6;
  k.box(x, 0, z, w, wh, d, wallC, rot);
  // timber band
  if (rnd() < 0.5) k.box(x, wh * 0.55, z, w + 0.02, 0.06, d + 0.02, WOOD, rot);
  k.gable(x, wh, z, w, d, 0.55 + rnd() * 0.35, 0.14, roofC, wallC, rot);
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const L = (lx, lz) => [x + lx * cr + lz * sr, z - lx * sr + lz * cr];
  // chimney
  const [chx, chz] = L(w * (rnd() < 0.5 ? -0.3 : 0.3), d * 0.2);
  k.box(chx, wh, chz, 0.18, 0.75, 0.18, STONE, rot);
  // windows (glow at night) and door on the long sides
  const nWin = Math.max(1, Math.floor(w / 0.55));
  for (let f = 0; f < floors; f++) for (let i = 0; i < nWin; i++) {
    const lx = -w / 2 + (w * (i + 0.5)) / nWin;
    for (const side of [1, -1]) {
      if (f === 0 && side === 1 && i === Math.floor(nWin / 2)) {
        const [dx, dz] = L(lx, side * (d / 2 + 0.01));
        k.box(dx, 0, dz, 0.22, 0.42, 0.04, DARK, rot);
        continue;
      }
      const [wx, wz] = L(lx, side * (d / 2 + 0.01));
      k.box(wx, 0.32 + f * 0.6, wz, 0.16, 0.2, 0.04, GLASS, rot, 1);
    }
  }
  return wh;
}

function houseGrammar(k, b, rnd) {
  const S = b.s;
  const n = S === 2 ? 1 : S === 3 ? 1 + (rnd() < 0.6 ? 1 : 0) : 2 + Math.floor(rnd() * 2);
  const slots = n === 1 ? [[0, 0]] : n === 2 ? [[-0.25, -0.2], [0.25, 0.22]] : [[-0.27, -0.25], [0.27, -0.2], [0, 0.27]];
  for (const [sx, sz] of slots) {
    const w = Math.min(S * 0.62, 1.3 + rnd() * 0.6) * (n > 1 ? 0.8 : 1), d = w * (0.72 + rnd() * 0.18);
    const rot = Math.round(rnd() * 2) * (Math.PI / 2) + (rnd() - 0.5) * 0.25;
    cottage(k, rnd, sx * S, sz * S, w, d, rot);
  }
  // little garden extras
  if (rnd() < 0.7) k.ball(S * 0.38, 0.15, S * 0.38, 0.22, col(0.30, 0.50, 0.22), 0.8);
}

function farmGrammar(k, b, rnd) {
  const S = b.s, c = rnd() < 0.5 ? -1 : 1, c2 = rnd() < 0.5 ? -1 : 1;
  const bx = c * (S / 2 - 1.0), bz = c2 * (S / 2 - 0.8);
  const red = col(0.66, 0.22, 0.16);
  k.box(bx, 0, bz, 1.6, 0.95, 1.15, red);
  k.gable(bx, 0.95, bz, 1.6, 1.15, 0.6, 0.12, col(0.38, 0.36, 0.34), red);
  k.box(bx, 0, bz + 0.58, 0.5, 0.7, 0.03, col(0.95, 0.92, 0.85));
  // silo
  k.cyl(bx - c * 1.1, 0, bz, 0.32, 0.32, 1.6, col(0.78, 0.76, 0.70), 12);
  k.ball(bx - c * 1.1, 1.6, bz, 0.33, col(0.45, 0.48, 0.52), 0.6);
  // haystacks in the field
  const nh = 2 + Math.floor(rnd() * 3);
  for (let i = 0; i < nh; i++) k.ball((rnd() - 0.5) * (S - 1.5), 0.18, (rnd() - 0.5) * (S - 1.5), 0.28, col(0.86, 0.72, 0.38), 0.75);
  // fence
  const h = S / 2 - 0.05;
  for (let i = 0; i <= S * 2; i++) {
    const t = -h + (i * (2 * h)) / (S * 2);
    for (const [px, pz] of [[t, -h], [t, h], [-h, t], [h, t]]) k.box(px, 0, pz, 0.05, 0.32, 0.05, WOOD);
  }
  for (const [px, pz, w, d] of [[0, -h, 2 * h, 0.03], [0, h, 2 * h, 0.03], [-h, 0, 0.03, 2 * h], [h, 0, 0.03, 2 * h]]) {
    k.box(px, 0.22, pz, w, 0.04, d, WOOD);
  }
}

function millGrammar(k, b, rnd, nearWater) {
  const S = b.s;
  const rot = Math.round(rnd() * 3) * (Math.PI / 2);
  const w = Math.min(S - 0.3, 2.2), d = Math.min(S - 0.5, 1.4);
  k.box(0, 0, -0.2, w, 0.9, d, WOOD, rot);
  k.gable(0, 0.9, -0.2, w, d, 0.5, 0.18, col(0.30, 0.28, 0.27), WOOD, rot);
  k.box(-w * 0.3, 0.9, -0.2, 0.2, 0.9, 0.2, STONE, rot);
  // log piles
  const piles = 1 + Math.floor(S / 2);
  for (let p = 0; p < piles; p++) {
    const px = (rnd() - 0.5) * (S - 0.8), pz = S / 2 - 0.45;
    for (let row = 0; row < 3; row++) for (let i = 0; i < 3 - row; i++) {
      const g = new THREE.CylinderGeometry(0.09, 0.09, 0.9, 7).rotateZ(Math.PI / 2).translate(px, 0.09 + row * 0.16, pz + (i - (2 - row) / 2) * 0.19);
      k.add(g, BARK);
    }
  }
  if (nearWater) {
    // water wheel on the side
    const wx = w / 2 + 0.12;
    const ring = new THREE.TorusGeometry(0.55, 0.05, 6, 16).rotateY(Math.PI / 2).translate(wx, 0.55, -0.2);
    k.add(ring.rotateY(rot), WOOD);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const g = new THREE.BoxGeometry(0.16, 0.05, 0.18).translate(0, 0.5, 0).rotateX(a).translate(wx, 0.55, -0.2);
      k.add(g.rotateY(rot), WOOD);
    }
  }
}

function parkGrammar(k, b, rnd) {
  const S = b.s;
  // stone lanterns
  const n = 1 + Math.floor(S / 2);
  for (let i = 0; i < n; i++) {
    const x = (rnd() - 0.5) * (S - 0.8), z = (rnd() - 0.5) * (S - 0.8);
    k.box(x, 0, z, 0.16, 0.4, 0.16, STONE);
    k.box(x, 0.4, z, 0.24, 0.16, 0.24, col(0.95, 0.85, 0.55), 0, 1);
    k.box(x, 0.56, z, 0.34, 0.06, 0.34, STONE);
  }
  if (S >= 4) {
    // gazebo
    const r = 0.7;
    for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; k.box(Math.cos(a) * r, 0, Math.sin(a) * r, 0.07, 0.9, 0.07, WOOD); }
    k.add(new THREE.ConeGeometry(r * 1.3, 0.55, 6).translate(0, 1.17, 0), col(0.36, 0.50, 0.40));
  } else {
    k.box(0, 0.18, 0, 0.8, 0.05, 0.25, WOOD);
    k.box(-0.32, 0, 0, 0.06, 0.18, 0.22, WOOD); k.box(0.32, 0, 0, 0.06, 0.18, 0.22, WOOD);
  }
  // flowering shrubs
  const fl = [col(0.95, 0.55, 0.70), col(0.98, 0.90, 0.40), col(0.70, 0.55, 0.95), col(0.98, 0.98, 0.95)];
  for (let i = 0; i < S * 2; i++) k.ball((rnd() - 0.5) * (S - 0.4), 0.12, (rnd() - 0.5) * (S - 0.4), 0.15 + rnd() * 0.1, fl[i % 4], 0.8);
}

// A tall waymarker: stone cairn, pole, glowing lantern and a pennant.
function beaconGrammar(k, b, rnd) {
  k.ball(0, 0.12, 0, 0.32, STONE, 0.6);
  k.ball(0.12, 0.3, -0.05, 0.2, col(0.5, 0.49, 0.46), 0.8);
  k.cyl(0, 0.2, 0, 0.06, 0.045, 2.6, WOOD, 10);
  k.cyl(0, 2.75, 0, 0.16, 0.12, 0.22, col(1.0, 0.86, 0.55), 12);
  k.parts[k.parts.length - 1].attributes.aEmit.array.fill(1);
  k.add(new THREE.ConeGeometry(0.22, 0.22, 12).translate(0, 3.08, 0), DARK);
  const flag = new THREE.BufferGeometry();
  const L = 0.7 + rnd() * 0.2;
  flag.setAttribute('position', new THREE.Float32BufferAttribute([0.05, 2.5, 0, 0.05 + L, 2.38, 0, 0.05, 2.22, 0, 0.05, 2.5, 0, 0.05, 2.22, 0, 0.05 + L, 2.38, 0], 3));
  flag.computeVertexNormals();
  k.add(flag, ownerColor(b.owner));
}

// Build the full mesh geometry for a building (also used for the placement preview).
export function buildingGeometry(world, b) {
  const rnd = frand(b.seed ^ (b.type * 0x9e3779b9));
  const k = new Kit();
  const ci = (b.y + (b.s >> 1)) * world.N + b.x + (b.s >> 1);
  if (b.type === T.HOUSE) houseGrammar(k, b, rnd);
  else if (b.type === T.FARM) farmGrammar(k, b, rnd);
  else if (b.type === T.MILL) millGrammar(k, b, rnd, world.waterDist[ci] < 5);
  else if (b.type === T.PARK) parkGrammar(k, b, rnd);
  else if (b.type === T.BEACON) beaconGrammar(k, b, rnd);
  if (b.type !== T.BEACON) {
    // owner banner
    const fx = -b.s / 2 + 0.25, fz = -b.s / 2 + 0.25;
    k.cyl(fx, 0, fz, 0.025, 0.02, 1.6, WOOD, 6);
    k.box(fx + 0.22, 1.3, fz, 0.42, 0.26, 0.02, ownerColor(b.owner));
  }
  // foundation down to the lowest terrain corner
  const { lo, hi } = footprintHeights(world, b);
  if (b.type !== T.FARM && b.type !== T.PARK && b.type !== T.BEACON) k.box(0, lo - hi - 0.05, 0, b.s - 0.15, hi - lo + 0.07, b.s - 0.15, STONE);
  return k.build();
}

function footprintHeights(world, b) {
  let lo = Infinity, hi = -Infinity;
  for (let z = b.y; z <= b.y + b.s; z++) for (let x = b.x; x <= b.x + b.s; x++) {
    const h = hY(world.H[z * V + x]); lo = Math.min(lo, h); hi = Math.max(hi, h);
  }
  return { lo, hi };
}

export function buildingAnchor(world, b) {
  const { lo, hi } = footprintHeights(world, b);
  const ground = b.type === T.FARM || b.type === T.PARK ? (lo + hi) / 2 : b.type === T.BEACON ? lo : hi;
  return new THREE.Vector3(b.x + b.s / 2 - HALF, ground, b.y + b.s / 2 - HALF);
}

export function buildingMaterial(env, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0, ...opts });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, env);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aEmit; varying float vEmit; varying float vUp;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vEmit = aEmit; vUp = normal.y;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uNight, uSnowCover; varying float vEmit; varying float vUp;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 1.0), uSnowCover * smoothstep(0.4, 0.8, vUp) * 0.9);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(1.0, 0.68, 0.32) * vEmit * (0.05 + uNight * 2.2);`);
  };
  return mat;
}

export class Buildings {
  constructor(world, env) {
    this.world = world;
    this.group = new THREE.Group();
    this.material = buildingMaterial(env);
    this.env = env;
    this.meshes = new Map();
  }
  // Soft column of light above a beacon, visible from far away (stronger at night).
  beam(owner) {
    if (!this.beamGeo) this.beamGeo = new THREE.CylinderGeometry(0.16, 0.3, 70, 16, 1, true).translate(0, 3.1 + 35, 0);
    this.beamMats ??= new Map();
    let mat = this.beamMats.get(owner);
    if (!mat) {
      mat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: ownerColor(owner).clone().lerp(new THREE.Color(1, 1, 1), 0.35) }, uNight: this.env.uNight, uTime: this.env.uTime },
        vertexShader: /* glsl */ `
          varying float vH; varying vec3 vN; varying vec3 vV;
          void main() {
            vH = uv.y; vec4 wp = modelMatrix * vec4(position, 1.0);
            vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - wp.xyz);
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor; uniform float uNight, uTime; varying float vH; varying vec3 vN; varying vec3 vV;
          void main() {
            float facing = abs(dot(normalize(vN), vV));
            float core = pow(facing, 2.0);
            float fade = smoothstep(0.0, 0.04, vH) * pow(1.0 - vH, 1.6);
            float shimmer = 0.85 + 0.15 * sin(vH * 60.0 - uTime * 2.0);
            float a = core * fade * shimmer * mix(0.28, 0.75, uNight);
            gl_FragColor = vec4(uColor * (1.0 + uNight), a);
          }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      this.beamMats.set(owner, mat);
    }
    const m = new THREE.Mesh(this.beamGeo, mat);
    m.castShadow = false; m.renderOrder = 5; m.frustumCulled = false;
    return m;
  }

  update(state, tickF) {
    const live = new Set();
    for (const b of state.buildings) {
      if (!b.alive) continue;
      const key = `${b.id}:${b.seed}:${b.tick}`;
      live.add(key);
      let m = this.meshes.get(key);
      if (!m) {
        m = new THREE.Mesh(buildingGeometry(this.world, b), this.material);
        m.position.copy(buildingAnchor(this.world, b));
        m.castShadow = true; m.receiveShadow = true;
        m.userData.b = b;
        if (b.type === T.BEACON) m.add(this.beam(b.owner));
        this.meshes.set(key, m);
        this.group.add(m);
      }
      const age = tickF - b.tick;
      const g = THREE.MathUtils.clamp(age / 2, 0.02, 1); // rises over ~2 in-game hours
      m.scale.set(1, g < 1 ? 1 - Math.pow(1 - g, 3) : 1, 1);
    }
    for (const [key, m] of this.meshes) {
      if (!live.has(key)) { this.group.remove(m); m.geometry.dispose(); this.meshes.delete(key); } // beam geometry is shared
    }
  }
}

export const radiusOf = (b) => (b.type === T.MILL ? millRadius(b) : b.type === T.PARK ? parkRadius(b) : 0);
