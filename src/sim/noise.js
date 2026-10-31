// Integer value noise. Coordinates are integer cells, output is 0..1023.
import { hash3 } from './prng.js';

const lattice = (seed, ix, iy) => hash3(seed, ix, iy, 0x51ed) >>> 22; // 0..1023

// Smoothstep 3t^2 - 2t^3 in 10-bit fixed point (t in 0..1024).
function fade(t) {
  const t2 = (t * t) >> 10;
  return (t2 * (3072 - 2 * t)) >> 10;
}

// One octave; lattice period is 2^shift cells.
export function vnoise(seed, x, y, shift) {
  const P = 1 << shift;
  const ix = x >> shift, iy = y >> shift;
  const fx = ((x & (P - 1)) << 10) >> shift;
  const fy = ((y & (P - 1)) << 10) >> shift;
  const sx = fade(fx), sy = fade(fy);
  const a = lattice(seed, ix, iy), b = lattice(seed, ix + 1, iy);
  const c = lattice(seed, ix, iy + 1), d = lattice(seed, ix + 1, iy + 1);
  const top = a + (((b - a) * sx) >> 10);
  const bot = c + (((d - c) * sx) >> 10);
  return top + (((bot - top) * sy) >> 10);
}

// Fractal sum of octaves, normalized back to 0..1023.
export function fbm(seed, x, y, octaves, baseShift) {
  let total = 0, norm = 0, amp = 1024;
  for (let o = 0; o < octaves; o++) {
    const shift = baseShift - o;
    if (shift < 1) break;
    total += vnoise((seed + Math.imul(o, 1013)) >>> 0, x, y, shift) * amp;
    norm += amp;
    amp >>= 1;
  }
  return Math.floor(total / norm);
}
