// Deterministic hashing and PRNG. Integer-only (Math.imul + shifts), so every
// JS engine produces identical bits. Nothing in src/sim may use Math.random,
// Math.sin/exp/pow or other implementation-defined float functions.

export function mix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

// Hash of a seed and up to three integers -> uint32.
export function hash3(seed, a, b, c) {
  let h = mix32((seed ^ 0x9e3779b9) >>> 0);
  h = mix32((h ^ Math.imul(a | 0, 0x85ebca6b)) >>> 0);
  h = mix32((h ^ Math.imul(b | 0, 0xc2b2ae35)) >>> 0);
  h = mix32((h ^ Math.imul(c | 0, 0x27d4eb2f)) >>> 0);
  return h;
}

// Sequential PRNG (mulberry32).
export class Rng {
  constructor(seed) { this.s = seed >>> 0; }
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  int(n) { return this.next() % n; }
}

// Turn any string or number into a uint32 seed.
export function seedFrom(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value >>> 0;
  const s = String(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return mix32(h >>> 0);
}

// Integer division helpers (operands are always well inside the safe range).
export const idiv = (a, b) => Math.floor(a / b);
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
