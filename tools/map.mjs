// Prints biome stats and an ASCII map for a seed: node tools/map.mjs [seed]
import { generateWorld, N, BIOME_NAMES } from '../src/sim/world.js';

const seed = Number(process.argv[2] ?? 12345);
const t0 = performance.now();
const w = generateWorld(seed);
console.log('generated in', (performance.now() - t0).toFixed(0), 'ms');
const cnt = new Array(BIOME_NAMES.length).fill(0);
for (const b of w.biome) cnt[b]++;
console.log(BIOME_NAMES.map((n, i) => `${n}: ${((cnt[i] * 100) / (N * N)).toFixed(1)}%`).join('  '));
let mx = 0, mn = 1e9;
for (const h of w.H) { mx = Math.max(mx, h); mn = Math.min(mn, h); }
console.log('height', mn, '..', mx, ' total tree cap', w.totalCap, ' waterfalls', w.waterfalls.length);
const ch = '~-.,T^*:Or';
let s = '';
for (let y = 0; y < N; y += 4) {
  for (let x = 0; x < N; x += 2.5) s += ch[w.biome[y * N + (x | 0)]];
  s += '\n';
}
console.log(s);
