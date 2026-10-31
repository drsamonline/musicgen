// Seeded PRNG. The ONLY source of randomness in the app.
// Determinism is enforced: nothing in core/ may call Math.random().

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a 32-bit
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const B32 = 'abcdefghijkmnpqrstuvwxyz23456789'; // no look-alikes

export function randomSeed(len = 12) {
  let s = '';
  const b = new Uint8Array(len);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(b);
  } else {
    for (let i = 0; i < len; i++) b[i] = (Math.random() * 256) | 0;
  }
  for (let i = 0; i < len; i++) s += B32[b[i] % B32.length];
  return s;
}

export class Rng {
  constructor(seed) {
    this.seed = typeof seed === 'number' ? seed >>> 0 : hashString(String(seed ?? 'seed'));
    this._next = mulberry32(this.seed);
    this._calls = 0;
  }
  float() { this._calls++; return this._next(); }
  int(n) { return Math.floor(this.float() * n); }
  range(a, b) { return a + this.float() * (b - a); }
  irange(a, b) { return a + Math.floor(this.float() * (b - a + 1)); }
  chance(p) { return this.float() < p; }
  pick(arr) { return arr.length ? arr[this.int(arr.length)] : undefined; }
  // weighted pick: weights aligned to items
  weighted(items, weights) {
    let total = 0;
    for (const w of weights) total += Math.max(0, w);
    if (total <= 0) return this.pick(items);
    let r = this.float() * total;
    for (let i = 0; i < items.length; i++) {
      r -= Math.max(0, weights[i]);
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  // independent stream, stable for a given label — keeps tracks from
  // consuming each other's entropy and changing each other's output.
  fork(label) {
    const r = new Rng(hashString(this.seed + '|' + label));
    r._calls = 0;
    return r;
  }
}

export function gauss(rng) {
  // Box-Muller, one value per call
  const u = Math.max(1e-9, rng.float());
  const v = rng.float();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
