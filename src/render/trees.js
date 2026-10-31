import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { N, BIOME } from '../sim/world.js';
import { hash3 } from '../sim/prng.js';
import { T } from '../sim/rules.js';
import { HALF, heightAt, frand, GLSL_COMMON, GLSL_CLOUDSHADOW, getNoiseTexture } from './common.js';
import { GLSL_SEASON } from './terrain.js';

const BROAD = 4, CONIFER = 3, VARIANTS = BROAD + CONIFER;
const LOD_R = 50;
const HIGH_MAX = 2500, NEAR_MAX = 9000, FAR_MAX = 30000;
const BARK = new THREE.Color().setRGB(0.34, 0.24, 0.17, THREE.SRGBColorSpace);

// Seasonal leaf colors (hue = per-tree random 0..1).
const GLSL_LEAF = /* glsl */ `
vec3 leafColor(float season, float hue, float conifer) {
  vec3 autumn = mix(mix(srgb(vec3(0.95,0.62,0.15)), srgb(vec3(0.85,0.30,0.10)), hue), srgb(vec3(0.70,0.62,0.18)), step(0.8, hue));
  vec3 broad = seasonPick(season, mix(srgb(vec3(0.55,0.78,0.30)), srgb(vec3(0.92,0.75,0.82)), step(0.9, hue) * 0.7),
                          srgb(vec3(0.30,0.54,0.18)) * (0.85 + 0.3 * hue), autumn, srgb(vec3(0.45,0.33,0.20)));
  vec3 con = seasonPick(season, srgb(vec3(0.20,0.40,0.22)), srgb(vec3(0.16,0.34,0.20)), srgb(vec3(0.17,0.33,0.20)), srgb(vec3(0.15,0.28,0.20)));
  return mix(broad, con * (0.9 + 0.2 * hue), conifer);
}`;

// ---------------------------------------------------------------- geometry

function tag(geo, color, leaf, center) {
  geo = geo.index ? geo.toNonIndexed() : geo;
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3), lf = new Float32Array(n).fill(leaf), cen = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col.set([color.r, color.g, color.b], i * 3); cen.set([center.x, center.y, center.z], i * 3); }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aLeaf', new THREE.BufferAttribute(lf, 1));
  geo.setAttribute('aCenter', new THREE.BufferAttribute(cen, 3));
  delete geo.attributes.uv;
  return geo;
}

function limb(a, b, r0, r1, seg = 6) {
  const d = new THREE.Vector3().subVectors(b, a), len = d.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, true).translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  g.translate(a.x, a.y, a.z);
  return tag(g, BARK, 0, a);
}

// A fluffy leaf clump: softly lumpy sphere with normals pointing away from its center (soft, painterly shading).
// The lumps come from a smooth function of direction, so every level of detail has the same shape.
function clump(c, r, treeTop, detail) {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const p = g.attributes.position, nrm = g.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(p, i);
    const d = v.clone().normalize();
    const lump = Math.sin(d.x * 3.1 + c.x * 5.3) * Math.sin(d.y * 2.7 + c.y * 4.1) * Math.sin(d.z * 3.3 + c.z * 6.7);
    v.multiplyScalar(0.92 + 0.14 * lump + 0.05 * Math.sin(d.x * 7 + d.z * 5 + c.y * 9));
    v.y *= 0.82;
    p.setXYZ(i, v.x + c.x, v.y + c.y, v.z + c.z);
    const n = v.clone().normalize();
    nrm.setXYZ(i, n.x, n.y * 0.8 + 0.2, n.z);
  }
  const geo = tag(g, new THREE.Color(1, 1, 1), 1, c);
  // Ambient occlusion baked in the color: darker underneath and towards the trunk.
  const col = geo.attributes.color, pp = geo.attributes.position;
  for (let i = 0; i < pp.count; i++) {
    const y = pp.getY(i), x = pp.getX(i), z = pp.getZ(i);
    const up = THREE.MathUtils.clamp((y - (c.y - r)) / (2 * r), 0, 1);
    const out = THREE.MathUtils.clamp(Math.hypot(x, z) / (Math.hypot(c.x, c.z) + r + 0.01), 0, 1);
    const ao = 0.45 + 0.35 * up + 0.2 * out + 0.1 * (y / treeTop);
    col.setXYZ(i, ao, ao, ao);
  }
  return geo;
}

function broadleaf(seed, detail = 1) {
  const rnd = frand(seed);
  const parts = [], tips = [];
  const up = new THREE.Vector3(0, 1, 0);
  const grow = (p, dir, len, rad, depth) => {
    const end = p.clone().addScaledVector(dir, len);
    parts.push(limb(p, end, rad, rad * 0.68, detail > 1 ? 9 : 6));
    if (depth >= 3 || (depth >= 2 && rnd() < 0.35)) { tips.push(end); return; }
    const kids = 2 + (rnd() < 0.55 ? 1 : 0);
    const spin = rnd() * Math.PI * 2;
    for (let k = 0; k < kids; k++) {
      const axis = new THREE.Vector3(Math.cos(spin + (k * Math.PI * 2) / kids), 0, Math.sin(spin + (k * Math.PI * 2) / kids));
      const nd = dir.clone().applyAxisAngle(axis, 0.45 + rnd() * 0.45);
      nd.y += 0.25; nd.normalize();
      grow(end, nd, len * (0.62 + rnd() * 0.18), rad * 0.62, depth + 1);
    }
  };
  grow(new THREE.Vector3(0, -0.2, 0), up, 1.0 + rnd() * 0.5, 0.13, 0);
  let top = 0;
  for (const t of tips) top = Math.max(top, t.y);
  for (const t of tips) parts.push(clump(t, 0.5 + rnd() * 0.32, top + 0.6, detail));
  const cen = new THREE.Vector3(0, top * 0.82, 0);
  parts.push(clump(cen, 0.85 + rnd() * 0.25, top + 0.6, detail));
  return mergeGeometries(parts);
}

function conifer(seed) {
  const rnd = frand(seed);
  const parts = [];
  const H = 3.1 + rnd() * 0.9;
  parts.push(limb(new THREE.Vector3(0, -0.2, 0), new THREE.Vector3(0, H * 0.9, 0), 0.11, 0.04));
  const layers = 5 + Math.floor(rnd() * 2);
  for (let i = 0; i < layers; i++) {
    const f = i / (layers - 1);
    const y = 0.55 + f * (H - 1.1);
    const r = 0.95 * (1 - f * 0.78) + 0.12;
    const h = 0.9 - f * 0.25;
    const g = new THREE.ConeGeometry(r, h, 16, 2, true);
    const p = g.attributes.position, nrm = g.attributes.normal;
    const ph = rnd() * 6.28;
    for (let k = 0; k < p.count; k++) {
      const vy = p.getY(k);
      let vx = p.getX(k), vz = p.getZ(k);
      if (vy < 0) {
        // Soft scalloped rim instead of random spikes.
        const a = Math.atan2(vz, vx);
        const j = 0.92 + 0.1 * Math.sin(a * 5 + ph) + 0.04 * Math.sin(a * 11 + ph * 2);
        vx *= j; vz *= j; p.setY(k, vy - 0.06 - 0.05 * Math.sin(a * 7 + ph));
      }
      p.setX(k, vx); p.setZ(k, vz);
      const n = new THREE.Vector3(vx, 0.6, vz).normalize();
      nrm.setXYZ(k, n.x, n.y, n.z);
    }
    g.translate(0, y + h / 2, 0);
    const cen = new THREE.Vector3(0, y + h * 0.4, 0);
    const geo = tag(g, new THREE.Color(1, 1, 1), 1, cen);
    const col = geo.attributes.color, pp = geo.attributes.position;
    for (let k = 0; k < pp.count; k++) {
      const rim = Math.hypot(pp.getX(k), pp.getZ(k)) / r;
      const ao = 0.5 + 0.25 * f + 0.3 * rim;
      col.setXYZ(k, ao, ao, ao);
    }
    parts.push(geo);
  }
  return mergeGeometries(parts);
}

// ---------------------------------------------------------------- materials

// Foliage shading: leafy cut-out silhouettes (no hard polygon edges), light glowing through
// backlit leaves, a soft rim and wrapped ambient so the shaded side stays airy, plus cloud shadows.
function nearMaterial(env, isConifer) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, env, { uNoise: { value: getNoiseTexture() } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aLeaf; attribute vec3 aCenter; attribute float aHue;
        uniform float uTime, uWind, uLeafAmt;
        varying float vLeaf; varying float vHue; varying float vUp; varying vec3 vLeafW;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float amt = ${isConifer ? '1.0' : 'uLeafAmt'};
        if (aLeaf > 0.5) transformed = mix(aCenter, transformed, max(amt, 0.03));
        vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        float sway = (sin(uTime * 1.3 + ip.x * 0.37 + ip.z * 0.21) + 0.5 * sin(uTime * 2.9 + ip.x)) * (0.15 + uWind) * 0.035 * max(position.y, 0.0);
        transformed.x += sway; transformed.z += sway * 0.6;
        vLeaf = aLeaf; vHue = aHue; vUp = normal.y;
        vLeafW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        ${GLSL_COMMON}
        ${GLSL_SEASON}
        ${GLSL_LEAF}
        uniform sampler2D uNoise;
        uniform float uSeason, uSnowCover, uSnowLine, uTime, uCloud, uWindDir, uSunI;
        uniform vec3 uSunDir, uSunColor, uAmbient;
        varying float vLeaf; varying float vHue; varying float vUp; varying vec3 vLeafW;
        ${GLSL_CLOUDSHADOW}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (vLeaf > 0.5) {
          diffuseColor.rgb = leafColor(uSeason, vHue, ${isConifer ? '1.0' : '0.0'}) * vColor.r * 1.15;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.95, 1.0), uSnowCover * smoothstep(0.35, 0.8, vUp) * 0.85);
        }
        diffuseColor.rgb *= 1.0 - 0.3 * cloudShadow(vLeafW.xz);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        if (vLeaf > 0.5) {
          // Leafy silhouette: bite noise-shaped holes out of the clump edges.
          float edge = 1.0 - abs(dot(normal, normalize(vViewPosition)));
          float ln = texture2D(uNoise, vLeafW.xy * 1.9 + vLeafW.zx * 1.3).r * 0.6 + texture2D(uNoise, vLeafW.zy * 4.1).g * 0.4;
          if (edge > 0.5 && ln < (edge - 0.5) * 1.5) discard;
        }`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        if (vLeaf > 0.5) {
          vec3 Vd = normalize(vViewPosition);
          vec3 Ls = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
          float back = pow(clamp(dot(-Vd, Ls), 0.0, 1.0), 3.0);
          float rim = pow(clamp(1.0 - abs(dot(normal, Vd)), 0.0, 1.0), 2.5); // clamp: pow of a negative is NaN (blooms into blobs)
          vec3 sunC = uSunColor * uSunI;
          reflectedLight.indirectDiffuse += diffuseColor.rgb * (sunC * (0.55 * back + 0.2 * rim) + uAmbient * 0.45);
        }`);
  };
  return mat;
}

function farMaterial(env, texFull, texBare, size, isConifer) {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]),
    fog: true,
    vertexShader: /* glsl */ `
      attribute float aHue;
      varying vec2 vUv; varying float vHue;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv; vHue = aHue;
        vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        float sc = length(vec3(instanceMatrix[0][0], instanceMatrix[0][1], instanceMatrix[0][2]));
        vec3 toCam = cameraPosition - ip; toCam.y = 0.0;
        vec3 fwd = normalize(toCam + vec3(1e-4, 0.0, 0.0));
        vec3 right = vec3(fwd.z, 0.0, -fwd.x);
        vec3 wp = ip + right * position.x * sc + vec3(0.0, position.y * sc, 0.0);
        vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      ${GLSL_COMMON}
      ${GLSL_SEASON}
      ${GLSL_LEAF}
      uniform sampler2D tFull, tBare;
      uniform float uSeason, uLeafAmt, uSnowCover, uNight;
      uniform vec3 uSunDir, uSunColor, uAmbient;
      uniform float uSunI;
      varying vec2 vUv; varying float vHue;
      #include <fog_pars_fragment>
      void main() {
        vec4 a = texture2D(tFull, vUv), b = texture2D(tBare, vUv);
        float k = ${isConifer ? '0.0' : 'smoothstep(0.2, 0.9, 1.0 - uLeafAmt)'};
        vec4 t = mix(a, b, k);
        if (t.a < 0.5) discard;
        vec3 bark = srgb(vec3(0.34, 0.24, 0.17));
        vec3 base = mix(bark, leafColor(uSeason, vHue, ${isConifer ? '1.0' : '0.0'}) * 1.15, step(0.5, t.r)) * t.g;
        base = mix(base, vec3(0.92, 0.95, 1.0), uSnowCover * t.r * smoothstep(0.55, 0.85, t.b) * 0.8);
        float sun = max(uSunDir.y, 0.0) * (0.55 + 0.45 * t.b);
        vec3 col = base * (uAmbient + uSunColor * uSunI * sun * 0.9);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}

// Render a tree geometry into a small texture: R leaf mask, G baked shade, B up-facing, A coverage.
function captureImpostor(renderer, geo, bbox, leafAmt) {
  const W = 128, H = 256;
  const rt = new THREE.WebGLRenderTarget(W, H, { magFilter: THREE.LinearFilter, minFilter: THREE.LinearMipmapLinearFilter, generateMipmaps: true });
  const mat = new THREE.ShaderMaterial({
    uniforms: { uAmt: { value: leafAmt } },
    vertexShader: /* glsl */ `
      attribute float aLeaf; attribute vec3 aCenter; uniform float uAmt;
      varying float vLeaf; varying float vShade; varying float vUp;
      void main() {
        vec3 p = position;
        if (aLeaf > 0.5) p = mix(aCenter, p, max(uAmt, 0.03));
        vLeaf = aLeaf; vShade = color.r; vUp = normal.y * 0.5 + 0.5;
        if (aLeaf < 0.5) vShade = 0.8;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying float vLeaf; varying float vShade; varying float vUp;
      void main() { gl_FragColor = vec4(vLeaf, vShade, vUp, 1.0); }`,
    vertexColors: true, side: THREE.DoubleSide,
  });
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geo, mat));
  const w = Math.max(bbox.max.x - bbox.min.x, bbox.max.z - bbox.min.z) * 1.04, h = (bbox.max.y - bbox.min.y) * 1.02;
  const cam = new THREE.OrthographicCamera(-w / 2, w / 2, bbox.max.y + 0.02, bbox.max.y - h, 0.1, 50);
  cam.position.set(0, 0, 20); cam.lookAt(0, 0, 0);
  cam.top = bbox.max.y; cam.bottom = bbox.max.y - h; cam.updateProjectionMatrix();
  const prevTarget = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  return { tex: rt.texture, w, h, bottom: bbox.max.y - h };
}

// ---------------------------------------------------------------- manager

export class Trees {
  constructor(world, env, renderer, seed, { mobile = false } = {}) {
    this.world = world;
    this.group = new THREE.Group();
    // Three levels of detail: smooth trees close by, standard ones at mid range, billboards beyond.
    this.highR = mobile ? 0 : 16;
    this.lodR = mobile ? 38 : LOD_R;
    this.high = []; this.near = []; this.far = [];
    const instanced = (geo, mat, max) => {
      geo.setAttribute('aHue', new THREE.InstancedBufferAttribute(new Float32Array(max), 1));
      const m = new THREE.InstancedMesh(geo, mat, max);
      m.count = 0; m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
      this.group.add(m);
      return m;
    };
    for (let v = 0; v < VARIANTS; v++) {
      const isCon = v >= BROAD;
      const geo = isCon ? conifer(seed + v * 7919) : broadleaf(seed + v * 7919, 1);
      geo.computeBoundingBox();
      const bbox = geo.boundingBox;
      const mat = nearMaterial(env, isCon);
      this.near.push(instanced(geo, mat, NEAR_MAX));
      // Conifers are already smooth enough; their high tier reuses the standard geometry.
      const hgeo = isCon ? geo.clone() : broadleaf(seed + v * 7919, 2);
      this.high.push(this.highR ? instanced(hgeo, mat, HIGH_MAX) : null);

      const full = captureImpostor(renderer, geo, bbox, 1.0);
      const bare = isCon ? full : captureImpostor(renderer, geo, bbox, 0.06);
      const plane = new THREE.PlaneGeometry(full.w, full.h).translate(0, full.bottom + full.h / 2, 0);
      plane.setAttribute('aHue', new THREE.InstancedBufferAttribute(new Float32Array(FAR_MAX), 1));
      const fmat = farMaterial(env, full.tex, bare.tex, full, isCon);
      Object.assign(fmat.uniforms, env, { tFull: { value: full.tex }, tBare: { value: bare.tex } });
      const fm = new THREE.InstancedMesh(plane, fmat, FAR_MAX);
      fm.count = 0; fm.frustumCulled = false;
      this.far.push(fm); this.group.add(fm);
    }

    // Static per-cell placement: jitter, rotation, variant, size, ground height.
    const cells = N * N;
    this.slot = new Float32Array(cells * 2 * 6); // 2 slots per cell: x, y, z, rot, size, hue
    this.variant = new Int8Array(cells * 2);
    this.thresh = new Int16Array(cells * 2);
    for (let i = 0; i < cells; i++) {
      const cx = i % N, cz = (i / N) | 0;
      for (let k = 0; k < 2; k++) {
        const h1 = hash3(seed, i, k, 11), h2 = hash3(seed, i, k, 12), h3 = hash3(seed, i, k, 13);
        const r = (h) => (h >>> 8) / 16777216;
        const jx = (r(h1) - 0.5) * (k ? 0.5 : 0.7), jz = (r(h2) - 0.5) * (k ? 0.5 : 0.7);
        const ox = k ? (r(h3) < 0.5 ? -0.33 : 0.33) : 0, oz = k ? (r(h1 ^ h2) < 0.5 ? -0.33 : 0.33) : 0;
        const x = cx - HALF + 0.5 + jx + ox, z = cz - HALF + 0.5 + jz + oz;
        const o = (i * 2 + k) * 6;
        this.slot[o] = x; this.slot[o + 1] = heightAt(world, x, z) - 0.05; this.slot[o + 2] = z;
        this.slot[o + 3] = r(h3) * Math.PI * 2;
        this.slot[o + 4] = (0.68 + r(h1 * 7) * 0.45) * (k ? 0.8 : 1);
        this.slot[o + 5] = r(h2 * 13);
        const high = world.cellH[i] > 1950 || world.biome[i] === BIOME.ROCK;
        const conifer = high ? r(h3 * 3) < 0.9 : r(h3 * 3) < 0.12;
        this.variant[i * 2 + k] = conifer ? BROAD + (h2 % CONIFER) : h1 % BROAD;
        this.thresh[i * 2 + k] = k ? 760 + (h3 % 240) : 70 + (h3 % 820);
      }
    }
    this.lastCenter = new THREE.Vector2(1e9, 1e9);
    this.seenVer = null; this.seenEpoch = -1;
  }

  update(state, epoch, center, force = false) {
    let changed = force || epoch !== this.seenEpoch || center.distanceTo(this.lastCenter) > 4;
    if (!this.seenVer) this.seenVer = new Uint32Array(state.chunkVer.length).fill(0xffffffff);
    for (let c = 0; c < state.chunkVer.length; c++) if (state.chunkVer[c] !== this.seenVer[c]) { changed = true; this.seenVer[c] = state.chunkVer[c]; }
    if (!changed) return;
    this.seenEpoch = epoch;
    this.lastCenter.copy(center);
    const highN = new Int32Array(VARIANTS), nearN = new Int32Array(VARIANTS), farN = new Int32Array(VARIANTS);
    const { trees, occ } = state, cap = this.world.cap, slot = this.slot;
    const r2 = this.lodR * this.lodR, h2 = this.highR * this.highR, cx = center.x, cz = center.y;
    // A building (not a reserve) or water on this cell? Trees next to one are kept clear of it.
    const water = this.world.water;
    const solid = (x, y) => {
      if (x < 0 || y < 0 || x >= N || y >= N) return 0;
      const id = occ[y * N + x];
      if (id > 0 && state.buildings[id - 1].type !== T.PARK) return 2;
      return water[y * N + x] ? 1 : 0;
    };
    for (let i = 0; i < N * N; i++) {
      const t = trees[i];
      if (t < 60 || occ[i]) continue;
      const fill = Math.min(1, t / Math.max(cap[i], 1));
      // Push away from neighbouring buildings: one smaller tree, shifted off the sides that touch one.
      const gx = i % N, gz = (i / N) | 0;
      let px = 0, pz = 0, near = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const k = dx || dz ? solid(gx + dx, gz + dz) : 0;
        if (k) { px -= dx; pz -= dz; near = Math.max(near, k); }
      }
      for (let k = 0; k < (near ? 1 : 2); k++) {
        const j = i * 2 + k;
        if (t < this.thresh[j]) continue;
        const o = j * 6, v = this.variant[j];
        let x = slot[o], y = slot[o + 1], z = slot[o + 2];
        let size = slot[o + 4] * (0.5 + 0.5 * fill);
        if (near) {
          const l = Math.hypot(px, pz) || 1;
          x = gx - HALF + 0.5 + (px / l) * 0.3; z = gz - HALF + 0.5 + (pz / l) * 0.3;
          y = heightAt(this.world, x, z) - 0.05;
          size *= near === 2 ? 0.6 : 0.85; // smaller by buildings; by water just keep the trunk dry
        }
        const dx = x - cx, dz = z - cz, d2 = dx * dx + dz * dz;
        const tier = d2 < h2 ? 0 : d2 < r2 ? 1 : 2;
        const mesh = tier === 0 ? this.high[v] : tier === 1 ? this.near[v] : this.far[v];
        const counts = tier === 0 ? highN : tier === 1 ? nearN : farN;
        const n = counts[v];
        if (n >= (tier === 0 ? HIGH_MAX : tier === 1 ? NEAR_MAX : FAR_MAX)) continue;
        const c = Math.cos(slot[o + 3]) * size, s = Math.sin(slot[o + 3]) * size;
        const m = mesh.instanceMatrix.array, b = n * 16;
        m[b] = c; m[b + 1] = 0; m[b + 2] = -s; m[b + 3] = 0;
        m[b + 4] = 0; m[b + 5] = size; m[b + 6] = 0; m[b + 7] = 0;
        m[b + 8] = s; m[b + 9] = 0; m[b + 10] = c; m[b + 11] = 0;
        m[b + 12] = x; m[b + 13] = y; m[b + 14] = z; m[b + 15] = 1;
        mesh.geometry.attributes.aHue.array[n] = slot[o + 5];
        counts[v]++;
      }
    }
    for (let v = 0; v < VARIANTS; v++) {
      for (const [mesh, n] of [[this.high[v], highN[v]], [this.near[v], nearN[v]], [this.far[v], farN[v]]]) {
        if (!mesh) continue;
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.geometry.attributes.aHue.needsUpdate = true;
      }
    }
  }
}
