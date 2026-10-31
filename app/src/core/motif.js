// Motif algebra: pure transforms on note lists.
// A note is { t, d, p, v } — onset beats, duration beats, midi, velocity.
import { scaleOf } from './theory.js';

export function transposeChromatic(notes, semis) {
  return notes.map((n) => ({ ...n, p: n.p + semis }));
}

function degreeIndex(midi, tonicPc, scale) {
  // best (octave, index) pair
  const n = scale.length;
  const rel = midi - tonicPc;
  const oct = Math.floor(rel / 12);
  const within = rel - oct * 12;
  let best = 0, bestDiff = 99;
  for (let i = 0; i < n; i++) {
    const diff = Math.abs(scale[i] - within);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  return oct * n + best;
}

function fromDegree(idx, tonicPc, scale) {
  const n = scale.length;
  const oct = Math.floor(idx / n);
  const i = ((idx % n) + n) % n;
  return tonicPc + scale[i] + 12 * oct;
}

export function transposeDiatonic(notes, steps, tonicPc, scaleName) {
  const scale = scaleOf(scaleName);
  return notes.map((n) => ({
    ...n,
    p: fromDegree(degreeIndex(n.p, tonicPc, scale) + steps, tonicPc, scale),
  }));
}

export function invertDiatonic(notes, tonicPc, scaleName, axisMidi = null) {
  if (!notes.length) return [];
  const scale = scaleOf(scaleName);
  const axis = axisMidi ?? Math.round(notes.reduce((a, n) => a + n.p, 0) / notes.length);
  const axisIdx = degreeIndex(axis, tonicPc, scale);
  return notes.map((n) => ({
    ...n,
    p: fromDegree(2 * axisIdx - degreeIndex(n.p, tonicPc, scale), tonicPc, scale),
  }));
}

export function retrograde(notes, span) {
  return notes.map((n) => ({ ...n, t: span - (n.t + n.d) })).sort((a, b) => a.t - b.t);
}

export function retrogradeInversion(notes, span, tonicPc, scaleName) {
  return invertDiatonic(retrograde(notes, span), tonicPc, scaleName);
}

export function augment(notes, factor) {
  return notes.map((n) => ({ ...n, t: n.t * factor, d: n.d * factor }));
}

export function diminish(notes, factor) {
  return augment(notes, factor);
}

export function fragment(notes, from, to) {
  return notes.filter((n) => n.t >= from && n.t < to).map((n) => ({ ...n, t: n.t - from }));
}

export function extend(notes, span) {
  const out = notes.slice();
  for (const n of notes) out.push({ ...n, t: n.t + span });
  return out.sort((a, b) => a.t - b.t);
}

export function ornament(notes, rng, scaleName, tonicPc) {
  const out = [];
  const scale = scaleOf(scaleName);
  for (const n of notes) {
    if (rng.chance(0.3) && n.d >= 0.5) {
      const half = n.d / 2;
      out.push({ ...n, d: half });
      const neigh = fromDegree(degreeIndex(n.p, tonicPc, scale) + (rng.chance(0.5) ? 1 : -1), tonicPc, scale);
      out.push({ ...n, t: n.t + half, d: half, p: neigh, v: n.v * 0.8 });
    } else if (rng.chance(0.15) && n.d >= 0.5) {
      // grace note before the beat
      const g = fromDegree(degreeIndex(n.p, tonicPc, scale) - 1, tonicPc, scale);
      out.push({ ...n, t: Math.max(0, n.t - 0.125), d: 0.125, p: g, v: n.v * 0.6 });
      out.push({ ...n, t: n.t, d: n.d - 0.125 });
    } else {
      out.push(n);
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// Development curve: which transforms run in which section.
export const TRANSFORMS = {
  transposeUp: (notes, ctx) => transposeDiatonic(notes, 2, ctx.tonicPc, ctx.scale),
  transposeDown: (notes, ctx) => transposeDiatonic(notes, -2, ctx.tonicPc, ctx.scale),
  invert: (notes, ctx) => invertDiatonic(notes, ctx.tonicPc, ctx.scale),
  retrograde: (notes, ctx) => retrograde(notes, ctx.span),
  retrogradeInversion: (notes, ctx) => retrogradeInversion(notes, ctx.span, ctx.tonicPc, ctx.scale),
  augment: (notes) => augment(notes, 2),
  diminish: (notes) => diminish(notes, 0.5),
  fragment: (notes, ctx) => fragment(notes, 0, ctx.span / 2),
  extend: (notes, ctx) => extend(notes, ctx.span),
  ornament: (notes, ctx) => ornament(notes, ctx.rng, ctx.scale, ctx.tonicPc),
};

export const TRANSFORM_NAMES = Object.keys(TRANSFORMS);

export function applyTransform(name, notes, ctx) {
  const fn = TRANSFORMS[name];
  return fn ? fn(notes, ctx) : notes;
}
