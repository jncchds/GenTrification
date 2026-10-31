// Static world generated purely from the seed. Nothing here changes during play.
// Pipeline: noise heightfield -> terraced mountains -> priority-flood drainage
// (fills pits into lakes, gives every vertex a downhill receiver) -> flow
// accumulation -> carved rivers -> waterfalls where rivers drop off cliffs ->
// biomes, tree caps and soil fertility per cell.
import { hash3, clamp } from './prng.js';
import { fbm } from './noise.js';

export const N = 256;          // world is N x N cells
export const V = N + 1;        // vertices per side
export const CH = 32;          // chunk size in cells
export const NC = N / CH;      // chunks per side
export const WATER = 1000;     // sea level in height units (0..4095)
export const TREE_MAX = 1000;  // trees per cell, fixed point: 1000 = one full tree

export const BIOME = { DEEP: 0, SHALLOW: 1, SAND: 2, GRASS: 3, FOREST: 4, ROCK: 5, SNOW: 6, MEADOW: 7, LAKE: 8, RIVER: 9 };
export const BIOME_NAMES = ['Deep sea', 'Shallows', 'Beach', 'Grassland', 'Forest', 'Rock', 'Snow', 'Dry meadow', 'Lake', 'River'];
export const WKIND = { NONE: 0, SEA: 1, LAKE: 2, RIVER: 3 };

function rawHeight(seed, x, y) {
  const wx = x + (((fbm(seed + 7, x, y, 3, 6) - 512) * 30) >> 10);
  const wy = y + (((fbm(seed + 9, x, y, 3, 6) - 512) * 30) >> 10);
  const base = fbm(seed, wx, wy, 6, 7);
  const r = fbm(seed + 3, wx, wy, 5, 6);
  const ridge = 1023 - Math.abs(r * 2 - 1023);
  const mount = clamp((fbm(seed + 5, x, y, 2, 7) - 420) * 3, 0, 1023);
  const dx = x - N / 2, dy = y - N / 2;
  const R = Math.floor(N * 0.5);
  const fall = Math.floor(((dx * dx + dy * dy) * 1024) / (R * R));
  let h = 760 + Math.floor((base * 15) / 10)
    + Math.floor((((ridge * ridge) >> 10) * mount) / 250)
    - Math.floor((fall * fall) / 560);
  // Terraces in mountain areas: flat shelves with steep risers (cliffs).
  const tm = clamp((fbm(seed + 13, x, y, 2, 6) - 380) * 4, 0, 1024);
  if (h > 1500 && tm > 0) {
    const STEP = 230;
    const k = Math.floor(h / STEP), f = h - k * STEP;
    const q = Math.floor((f * f) / STEP);
    const t = Math.floor((q * q * f) / (STEP * STEP)); // f^5/STEP^4: flat shelf, sharp riser
    const terr = k * STEP + t;
    const w = (tm * clamp((h - 1500) * 4, 0, 1024)) >> 10;
    h = h + (((terr - h) * w) >> 10);
  }
  return clamp(h, 0, 4095);
}

// Binary min-heap of packed integer keys (exact in float64).
class Heap {
  constructor(n) { this.a = new Float64Array(n); this.n = 0; }
  push(k) { const a = this.a; let i = this.n++; a[i] = k; while (i > 0) { const p = (i - 1) >> 1; if (a[p] <= k) break; a[i] = a[p]; i = p; } a[i] = k; }
  pop() {
    const a = this.a, top = a[0], last = a[--this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1; if (c >= this.n) break;
      if (c + 1 < this.n && a[c + 1] < a[c]) c++;
      if (a[c] >= last) break;
      a[i] = a[c]; i = c;
    }
    a[i] = last; return top;
  }
}

const NB8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

export function generateWorld(seed) {
  seed = seed >>> 0;
  const VV = V * V;
  const H = new Int16Array(VV);
  for (let y = 0; y < V; y++) for (let x = 0; x < V; x++) H[y * V + x] = rawHeight(seed, x, y);

  // --- Drainage: priority flood from the sea and the map border.
  const F = new Int16Array(VV);      // filled (spill) height
  const recv = new Int32Array(VV).fill(-1);
  const order = new Int32Array(VV);  // vertices in pop order (low -> high)
  const seen = new Uint8Array(VV);
  const heap = new Heap(VV);
  const KEY = 1 << 17; // > VV
  for (let i = 0; i < VV; i++) {
    const x = i % V, y = (i / V) | 0;
    if (H[i] < WATER || x === 0 || y === 0 || x === V - 1 || y === V - 1) {
      seen[i] = 1; F[i] = H[i]; heap.push(H[i] * KEY + i);
    }
  }
  let on = 0;
  while (heap.n > 0) {
    const k = heap.pop(), i = k % KEY, x = i % V, y = (i / V) | 0;
    order[on++] = i;
    for (const [ox, oy] of NB8) {
      const nx = x + ox, ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= V || ny >= V) continue;
      const j = ny * V + nx;
      if (seen[j]) continue;
      seen[j] = 1;
      F[j] = Math.max(H[j], F[i] + 1);
      recv[j] = i;
      heap.push(F[j] * KEY + j);
    }
  }

  // Lakes: pits deeper than a few units become water at spill height; shallow ones are filled in.
  const surf = new Int16Array(VV);   // water surface height per vertex (0 = none)
  const vkind = new Uint8Array(VV);
  for (let i = 0; i < VV; i++) {
    if (H[i] < WATER) { vkind[i] = WKIND.SEA; surf[i] = WATER; }
    else if (F[i] - H[i] > 14) { vkind[i] = WKIND.LAKE; surf[i] = F[i]; }
    else if (F[i] > H[i]) H[i] = F[i];
  }

  // Flow accumulation (rain weighted by moisture), high -> low.
  const acc = new Float64Array(VV);
  for (let n = VV - 1; n >= 0; n--) {
    const i = order[n];
    const x = i % V, y = (i / V) | 0;
    acc[i] += 2 + (fbm(seed + 11, x, y, 2, 6) >> 7);
    if (recv[i] >= 0) acc[recv[i]] += acc[i];
  }

  // Rivers: carve channels where enough water collects.
  const RIVER_MIN = 2600;
  const river = new Uint8Array(VV);
  for (let i = 0; i < VV; i++) if (acc[i] >= RIVER_MIN && vkind[i] === WKIND.NONE) river[i] = 1;
  const carve = new Int16Array(VV);
  for (let i = 0; i < VV; i++) {
    if (!river[i]) continue;
    const depth = clamp(26 + Math.floor(acc[i] / 900), 26, 70);
    carve[i] = depth;
  }
  const Hc = H.slice();
  for (let i = 0; i < VV; i++) {
    if (!river[i]) continue;
    const x = i % V, y = (i / V) | 0, d = carve[i];
    Hc[i] = H[i] - d;
    // Soften banks so the channel is visible.
    for (const [ox, oy] of NB8) {
      const nx = x + ox, ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= V || ny >= V) continue;
      const j = ny * V + nx;
      if (!river[j] && vkind[j] === WKIND.NONE) Hc[j] = Math.min(Hc[j], H[j] - (d >> 1));
    }
  }
  for (let i = 0; i < VV; i++) if (river[i]) { vkind[i] = WKIND.RIVER; surf[i] = Hc[i] + Math.floor(carve[i] * 6 / 10); }

  // Waterfalls: river steps with a big drop to the receiver.
  const waterfalls = [];
  for (let i = 0; i < VV; i++) {
    if (vkind[i] !== WKIND.RIVER) continue;
    const r = recv[i]; if (r < 0) continue;
    const drop = surf[i] - (surf[r] || Hc[r]);
    if (drop > 80) {
      waterfalls.push({ x: i % V, y: (i / V) | 0, tx: r % V, ty: (r / V) | 0, top: surf[i], bottom: surf[r] || Hc[r], flow: Math.floor(acc[i]) });
    }
  }
  H.set(Hc);

  // --- Per-cell fields.
  const cells = N * N;
  const cellH = new Int16Array(cells);
  const slope = new Int16Array(cells);
  const moist = new Int16Array(cells);
  const biome = new Uint8Array(cells);
  const water = new Uint8Array(cells);
  const cap = new Int16Array(cells);
  const fert0 = new Int16Array(cells);
  const waterDist = new Uint8Array(cells);

  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const v0 = y * V + x, v1 = v0 + 1, v2 = v0 + V, v3 = v2 + 1;
    const a = H[v0], b = H[v1], c = H[v2], d = H[v3];
    const i = y * N + x;
    cellH[i] = (a + b + c + d) >> 2;
    slope[i] = Math.max(a, b, c, d) - Math.min(a, b, c, d);
    moist[i] = fbm(seed + 11, x, y, 4, 6);
    // A cell is water if most of its corners are, or if it is below the sea.
    let wsea = 0, wl = 0, wr = 0;
    for (const v of [v0, v1, v2, v3]) { if (vkind[v] === WKIND.SEA) wsea++; else if (vkind[v] === WKIND.LAKE) wl++; else if (vkind[v] === WKIND.RIVER) wr++; }
    if (cellH[i] < WATER || wsea >= 3) water[i] = WKIND.SEA;
    else if (wl >= 2) water[i] = WKIND.LAKE;
    else if (wr >= 1) water[i] = WKIND.RIVER;
  }

  // Distance to any water (multi-source BFS, capped).
  const queue = new Int32Array(cells);
  let qh = 0, qt = 0;
  waterDist.fill(255);
  for (let i = 0; i < cells; i++) if (water[i]) { waterDist[i] = 0; queue[qt++] = i; }
  while (qh < qt) {
    const i = queue[qh++], x = i % N, y = (i / N) | 0, nd = waterDist[i] + 1;
    if (nd > 40) continue;
    if (x > 0 && waterDist[i - 1] > nd) { waterDist[i - 1] = nd; queue[qt++] = i - 1; }
    if (x < N - 1 && waterDist[i + 1] > nd) { waterDist[i + 1] = nd; queue[qt++] = i + 1; }
    if (y > 0 && waterDist[i - N] > nd) { waterDist[i - N] = nd; queue[qt++] = i - N; }
    if (y < N - 1 && waterDist[i + N] > nd) { waterDist[i + N] = nd; queue[qt++] = i + N; }
  }

  // Seeded per-chunk traits.
  const chunkK = new Int16Array(NC * NC);
  const chunkF = new Int16Array(NC * NC);
  for (let c = 0; c < NC * NC; c++) {
    chunkK[c] = 450 + (hash3(seed, c, 1, 77) % 551);  // tree cap multiplier 450..1000
    chunkF[c] = 700 + (hash3(seed, c, 2, 77) % 501);  // fertility multiplier 700..1200
  }

  let totalCap = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x, h = cellH[i], s = slope[i], wd = waterDist[i];
    const c = ((y / CH) | 0) * NC + ((x / CH) | 0);
    const m = clamp(moist[i] + Math.max(0, 12 - wd) * 14, 0, 1023);
    let bm;
    if (water[i] === WKIND.SEA) bm = h < WATER - 160 ? BIOME.DEEP : BIOME.SHALLOW;
    else if (water[i] === WKIND.LAKE) bm = BIOME.LAKE;
    else if (water[i] === WKIND.RIVER) bm = BIOME.RIVER;
    else if (h < WATER + 70 && s < 140 && wd < 6) bm = BIOME.SAND;
    else if (h > 3050) bm = BIOME.SNOW;
    else if (h > 2550 || s > 230) bm = BIOME.ROCK;
    else if (m > 520) bm = BIOME.FOREST;
    else if (m > 380) bm = BIOME.GRASS;
    else bm = BIOME.MEADOW;
    biome[i] = bm;

    // Tree cap: how many trees this cell can carry at equilibrium.
    let suit = 0;
    if (bm === BIOME.FOREST) suit = clamp((m - 450) * 5, 300, 1024);
    else if (bm === BIOME.GRASS) suit = clamp((m - 430) * 3, 0, 360);
    else if (bm === BIOME.ROCK) suit = h < 2700 && s < 400 ? 200 : 0;
    else if (bm === BIOME.MEADOW) suit = 40;
    if (h > 2200) suit = (suit * clamp(2900 - h, 0, 700)) / 700 | 0;
    cap[i] = Math.min(TREE_MAX, (chunkK[c] * suit) >> 10);
    totalCap += cap[i];

    // Soil fertility: moisture, flatness and nearby fresh water.
    let f = 0;
    if (bm === BIOME.GRASS || bm === BIOME.FOREST || bm === BIOME.MEADOW) {
      f = 240 + ((m - 380) >> 1) + Math.max(0, 14 - wd) * 30 - (s >> 1) - (h > 1900 ? (h - 1900) >> 2 : 0);
      f = (clamp(f, 40, 1000) * chunkF[c]) >> 10;
    } else if (bm === BIOME.SAND) f = 60;
    fert0[i] = clamp(f, 0, 1000);
  }

  return { seed, N, V, CH, NC, H, surf, vkind, recv, cellH, slope, moist, biome, water, cap, fert0, waterDist, chunkK, chunkF, totalCap, waterfalls };
}

export const chunkOf = (x, y) => ((y / CH) | 0) * NC + ((x / CH) | 0);
