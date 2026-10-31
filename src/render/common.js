// Shared render helpers. Rendering may use floats freely: it only draws sim state.
import * as THREE from 'three';
import { N, V, WATER } from '../sim/world.js';
import { Rng } from '../sim/prng.js';

export const HS = 0.016;                       // world units per height unit
export const hY = (h) => (h - WATER) * HS;      // sim height -> world Y (sea level = 0)
export const HALF = N / 2;
export const cellX = (x) => x - HALF;           // cell/vertex coordinate -> world X
export const cellZ = (y) => y - HALF;

// Terrain height (world Y) at world (x, z), bilinear over the vertex grid.
export function heightAt(world, wx, wz) {
  const gx = Math.min(Math.max(wx + HALF, 0), N - 1e-4), gz = Math.min(Math.max(wz + HALF, 0), N - 1e-4);
  const x0 = Math.floor(gx), z0 = Math.floor(gz), fx = gx - x0, fz = gz - z0;
  const H = world.H;
  const a = H[z0 * V + x0], b = H[z0 * V + x0 + 1], c = H[(z0 + 1) * V + x0], d = H[(z0 + 1) * V + x0 + 1];
  return hY(a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz);
}

// Water surface (world Y) at a vertex, or null.
export const surfY = (world, vx, vz) => { const s = world.surf[vz * V + vx]; return s ? hY(s) : null; };

// Tileable value-noise texture (RGBA = 4 independent octaves), seeded.
let noiseTex = null;
export function getNoiseTexture() {
  if (noiseTex) return noiseTex;
  const S = 256, data = new Uint8Array(S * S * 4);
  const rng = new Rng(1234567);
  for (let ch = 0; ch < 4; ch++) {
    const per = [8, 16, 32, 64][ch];
    const lat = new Float32Array(per * per).map(() => rng.next() / 4294967296);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const fx = (x / S) * per, fy = (y / S) * per;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const g = (i, j) => lat[((j % per) * per) + (i % per)];
      const v = g(x0, y0) * (1 - sx) * (1 - sy) + g(x0 + 1, y0) * sx * (1 - sy) + g(x0, y0 + 1) * (1 - sx) * sy + g(x0 + 1, y0 + 1) * sx * sy;
      data[(y * S + x) * 4 + ch] = Math.round(v * 255);
    }
  }
  noiseTex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping;
  noiseTex.magFilter = THREE.LinearFilter;
  noiseTex.minFilter = THREE.LinearMipmapLinearFilter;
  noiseTex.generateMipmaps = true;
  noiseTex.needsUpdate = true;
  return noiseTex;
}

// GLSL snippet: sRGB-ish authoring colors -> linear.
export const GLSL_COMMON = /* glsl */ `
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
`;

// Drifting cloud shadows (0 = sunlit, 1 = under a cloud). Needs uNoise, uTime, uCloud, uWindDir.
export const GLSL_CLOUDSHADOW = /* glsl */ `
float cloudShadow(vec2 xz) {
  vec2 wind = vec2(cos(uWindDir), sin(uWindDir)) * uTime * 0.9;
  float n = texture2D(uNoise, (xz - wind) * 0.0045).r * 0.65 + texture2D(uNoise, (xz - wind * 1.3) * 0.011).g * 0.35;
  float cov = mix(0.70, 0.30, uCloud);
  return smoothstep(cov, cov + 0.12, n) * (1.0 - smoothstep(0.75, 1.0, uCloud));
}`;

// Seeded float RNG for render-only variation.
export function frand(seed) { const r = new Rng(seed); return () => r.next() / 4294967296; }
