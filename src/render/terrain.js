import * as THREE from 'three';
import { N, V, BIOME } from '../sim/world.js';
import { T } from '../sim/rules.js';
import { hY, HALF, getNoiseTexture, GLSL_COMMON } from './common.js';

// Season palette helper shared by terrain / trees / grass shaders.
export const GLSL_SEASON = /* glsl */ `
vec3 seasonPick(float s, vec3 a, vec3 b, vec3 c, vec3 d) {
  float i = floor(mod(s, 4.0));
  float f = smoothstep(0.55, 1.0, fract(s));
  vec3 cur = i < 0.5 ? a : i < 1.5 ? b : i < 2.5 ? c : d;
  vec3 nxt = i < 0.5 ? b : i < 1.5 ? c : i < 2.5 ? d : a;
  return mix(cur, nxt, f);
}
float seasonPickF(float s, float a, float b, float c, float d) {
  return seasonPick(s, vec3(a), vec3(b), vec3(c), vec3(d)).x;
}
`;

export class Terrain {
  constructor(world, env) {
    this.world = world;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(V * V * 3);
    const wA = new Float32Array(V * V * 4), wB = new Float32Array(V * V * 4);
    for (let z = 0; z < V; z++) for (let x = 0; x < V; x++) {
      const v = z * V + x;
      pos[v * 3] = x - HALF; pos[v * 3 + 1] = hY(world.H[v]); pos[v * 3 + 2] = z - HALF;
      // Average biome weights of the up-to-4 cells touching this vertex.
      let n = 0;
      const a = [0, 0, 0, 0], b = [0, 0, 0, 0];
      for (const [cx, cz] of [[x - 1, z - 1], [x, z - 1], [x - 1, z], [x, z]]) {
        if (cx < 0 || cz < 0 || cx >= N || cz >= N) continue;
        const bm = world.biome[cz * N + cx];
        n++;
        if (bm === BIOME.SAND) a[0]++;
        else if (bm === BIOME.GRASS) a[1]++;
        else if (bm === BIOME.FOREST) a[2]++;
        else if (bm === BIOME.MEADOW) a[3]++;
        else if (bm === BIOME.ROCK) b[0]++;
        else if (bm === BIOME.SNOW) b[1]++;
        else if (bm === BIOME.LAKE || bm === BIOME.RIVER) b[2]++;
        else b[3]++; // sea floor
      }
      for (let k = 0; k < 4; k++) { wA[v * 4 + k] = a[k] / n; wB[v * 4 + k] = b[k] / n; }
    }
    const idx = new Uint32Array(N * N * 6);
    let k = 0;
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
      const a = z * V + x, b = a + 1, c = a + V, d = c + 1;
      // Split along the shorter diagonal to avoid ugly creases.
      const h = world.H;
      if (Math.abs(h[a] - h[d]) < Math.abs(h[b] - h[c])) { idx.set([a, c, d, a, d, b], k); }
      else { idx.set([a, c, b, b, c, d], k); }
      k += 6;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('wA', new THREE.BufferAttribute(wA, 4));
    geo.setAttribute('wB', new THREE.BufferAttribute(wB, 4));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();

    // Dynamic per-cell data: R fertility, G tree density, B grassiness (static), A reserve.
    this.groundData = new Uint8Array(N * N * 4);
    this.groundTex = new THREE.DataTexture(this.groundData, N, N, THREE.RGBAFormat);
    this.groundTex.magFilter = THREE.LinearFilter; this.groundTex.minFilter = THREE.LinearFilter;
    // Occupancy (nearest): R building type, G farm furrow direction, B owner.
    this.occData = new Uint8Array(N * N * 4);
    this.occTex = new THREE.DataTexture(this.occData, N, N, THREE.RGBAFormat);
    this.occTex.magFilter = THREE.NearestFilter; this.occTex.minFilter = THREE.NearestFilter;
    for (let i = 0; i < N * N; i++) {
      const bm = world.biome[i];
      this.groundData[i * 4 + 2] = bm === BIOME.GRASS ? 255 : bm === BIOME.MEADOW ? 200 : bm === BIOME.FOREST ? 150 : bm === BIOME.ROCK ? 40 : 0;
    }

    const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
    const U = {
      uNoise: { value: getNoiseTexture() }, uGround: { value: this.groundTex }, uOcc: { value: this.occTex },
      uOverlay: { value: 0 },
    };
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, env, U);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec4 wA; attribute vec4 wB;
          varying vec4 vWA; varying vec4 vWB; varying vec3 vWPos; varying vec3 vWN;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vWA = wA; vWB = wB; vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vWN = normalize(normal);`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          ${GLSL_COMMON}
          ${GLSL_SEASON}
          uniform sampler2D uNoise, uGround, uOcc;
          uniform float uTime, uSeason, uSnowLine, uSnowCover, uWet, uOverlay, uCloud;
          uniform vec3 uSunDir;
          varying vec4 vWA; varying vec4 vWB; varying vec3 vWPos; varying vec3 vWN;
          float gSnow; float gWet;
          vec3 terrainColor() {
            vec2 uvc = (vWPos.xz + ${HALF.toFixed(1)}) / ${N.toFixed(1)};
            vec4 n = texture2D(uNoise, vWPos.xz * 0.013);
            vec4 n2 = texture2D(uNoise, vWPos.xz * 0.07);
            vec4 n3 = texture2D(uNoise, vWPos.xz * vec2(0.35, 0.12)); // brushy streaks
            vec4 g = texture2D(uGround, uvc);
            float s = uSeason;
            vec3 grass = seasonPick(s, srgb(vec3(0.46,0.68,0.27)), srgb(vec3(0.42,0.60,0.21)), srgb(vec3(0.62,0.56,0.27)), srgb(vec3(0.47,0.45,0.33)));
            grass *= 0.82 + 0.36 * n.g;
            grass = mix(grass, grass * vec3(1.15, 1.08, 0.65), smoothstep(0.45, 0.8, n2.r) * 0.6);
            vec3 forestF = srgb(vec3(0.36, 0.42, 0.20)) * (0.85 + 0.3 * n.b);
            vec3 meadowC = seasonPick(s, srgb(vec3(0.66,0.66,0.34)), srgb(vec3(0.76,0.68,0.38)), srgb(vec3(0.70,0.58,0.34)), srgb(vec3(0.55,0.50,0.38)));
            vec3 sandC = srgb(vec3(0.90, 0.82, 0.62)) * (0.9 + 0.15 * n2.g);
            vec3 rockC = srgb(mix(vec3(0.40, 0.38, 0.37), vec3(0.63, 0.58, 0.52), n2.b));
            rockC *= 0.82 + 0.22 * sin(vWPos.y * 2.3 + n.r * 5.0); // strata
            vec3 bedC = srgb(vec3(0.38, 0.35, 0.26)) * (0.8 + 0.3 * n2.r);
            vec3 seaBed = srgb(vec3(0.70, 0.66, 0.50));
            vec3 snowC = srgb(vec3(0.95, 0.97, 1.0));
            float wsum = dot(vWA, vec4(1.0)) + vWB.x + vWB.y + vWB.z + vWB.w + 1e-4;
            vec3 c = (sandC * vWA.x + grass * vWA.y + mix(grass, forestF, 0.5) * vWA.z + meadowC * vWA.w
                    + rockC * vWB.x + rockC * vWB.y + bedC * vWB.z + seaBed * vWB.w) / wsum;
            // Canopy shade: denser forest -> darker, mossier floor.
            c = mix(c, forestF, smoothstep(0.15, 0.85, g.g) * 0.45);
            // Fresh-water banks: lush, darker.
            float slope = 1.0 - vWN.y;
            float rk = smoothstep(0.32, 0.55, slope + (n2.r - 0.5) * 0.18);
            c = mix(c, rockC, rk);
            // Painterly brush variation.
            c *= 0.92 + 0.16 * n3.a;

            ivec2 cell = clamp(ivec2(floor(vWPos.xz + ${HALF.toFixed(1)})), ivec2(0), ivec2(${N - 1}));
            vec4 o = texelFetch(uOcc, cell, 0);
            int type = int(o.r * 255.0 + 0.5);
            if (type == ${T.FARM}) {
              float fert = g.r;
              float coord = o.g > 0.5 ? vWPos.x : vWPos.z;
              float furrow = 0.5 + 0.5 * sin(coord * 6.2832 * 3.0);
              vec3 soil = srgb(vec3(0.46, 0.34, 0.22)) * (0.6 + 0.5 * fert);
              float grow = seasonPickF(s, 0.6, 0.95, 0.7, 0.0);
              vec3 crop = seasonPick(s, srgb(vec3(0.50,0.70,0.30)), srgb(vec3(0.80,0.72,0.38)), srgb(vec3(0.76,0.66,0.42)), srgb(vec3(0.50,0.40,0.30)));
              crop *= (0.7 + 0.4 * fert) * (0.9 + 0.2 * n2.b);
              float rows = mix(0.75, 1.0, furrow);
              c = mix(soil, crop * rows, grow * (0.75 + 0.25 * furrow));
            } else if (type == ${T.HOUSE} || type == ${T.MILL}) {
              vec3 dirt = srgb(vec3(0.55, 0.47, 0.36)) * (0.8 + 0.3 * n2.g);
              float cob = step(0.5, fract(vWPos.x * 1.5 + step(0.5, fract(vWPos.z * 1.5)) * 0.5));
              c = mix(dirt, dirt * 0.85, cob * 0.5);
            } else if (type == ${T.PARK}) {
              c = mix(c, grass * vec3(0.9, 1.08, 0.9), 0.6);
            }
            // Snow: mountain snow line plus lowland cover in cold spells.
            float snowAmt = smoothstep(uSnowLine - 1.2, uSnowLine + 1.2, vWPos.y + (n.r - 0.5) * 5.0);
            snowAmt = max(snowAmt, uSnowCover * smoothstep(0.05, 0.4, vWPos.y) * smoothstep(0.2, 0.6, n2.a + uSnowCover));
            snowAmt *= smoothstep(0.72, 0.42, slope);
            gSnow = snowAmt;
            c = mix(c, snowC, snowAmt);
            gWet = uWet * (1.0 - snowAmt);
            c *= 1.0 - 0.28 * gWet;
            if (uOverlay > 0.5 && uOverlay < 1.5) {
              vec3 heat = mix(srgb(vec3(0.75, 0.25, 0.15)), srgb(vec3(0.25, 0.75, 0.25)), g.r);
              c = mix(c, heat, 0.65);
            } else if (uOverlay > 1.5) {
              vec3 tc = mix(srgb(vec3(0.85, 0.75, 0.55)), srgb(vec3(0.05, 0.45, 0.12)), g.g);
              c = mix(c, tc, 0.7);
            }
            return c;
          }`)
        .replace('#include <color_fragment>', `diffuseColor.rgb = terrainColor();`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.35, gWet * 0.8);
          roughnessFactor = mix(roughnessFactor, 0.6, gSnow);`);
    };
    this.material = mat;
    this.uniforms = U;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    this.seenVer = null;
    this.seenEpoch = -1;
    this.seenBuildings = -1;
  }

  update(state, epoch) {
    const { world } = this;
    // Only refresh when any chunk changed.
    let changed = epoch !== this.seenEpoch || state.buildings.length !== this.seenBuildings;
    if (!this.seenVer) this.seenVer = new Uint32Array(state.chunkVer.length).fill(0xffffffff);
    for (let c = 0; c < state.chunkVer.length; c++) if (state.chunkVer[c] !== this.seenVer[c]) { changed = true; this.seenVer[c] = state.chunkVer[c]; }
    if (!changed) return false;
    this.seenEpoch = epoch; this.seenBuildings = state.buildings.length;
    const gd = this.groundData, od = this.occData;
    for (let i = 0; i < N * N; i++) {
      gd[i * 4] = Math.min(255, (state.fert[i] * 255) / 1000) | 0;
      gd[i * 4 + 1] = Math.min(255, (state.trees[i] * 255) / 1000) | 0;
      gd[i * 4 + 3] = state.park[i] ? 255 : 0;
      const id = state.occ[i];
      if (id) {
        const b = state.buildings[id - 1];
        od[i * 4] = b.type; od[i * 4 + 1] = (b.seed & 1) * 255; od[i * 4 + 2] = b.owner;
      } else { od[i * 4] = 0; od[i * 4 + 1] = 0; od[i * 4 + 2] = 0; }
    }
    this.groundTex.needsUpdate = true;
    this.occTex.needsUpdate = true;
    return true;
  }
}

// Half-float height texture (V x V) of terrain world Y, for water depth and grass placement.
export function makeHeightTexture(world) {
  const data = new Uint16Array(V * V);
  for (let i = 0; i < V * V; i++) data[i] = THREE.DataUtils.toHalfFloat(hY(world.H[i]));
  const tex = new THREE.DataTexture(data, V, V, THREE.RedFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
