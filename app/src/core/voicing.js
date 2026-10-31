// Chord voicing + voice-leading solver.
import { CHORD_INTERVALS, voiceLeadingCost, pc } from './theory.js';

const STRATEGIES = ['close', 'open', 'drop2', 'quartal', 'cluster'];

// All chord tones as pitch classes, extended to `count` voices.
function tones(chord, count) {
  const iv = CHORD_INTERVALS[chord.quality] || CHORD_INTERVALS.maj;
  const out = [];
  for (let i = 0; i < count; i++) {
    const base = iv[i % iv.length];
    const oct = 12 * Math.floor(i / iv.length);
    out.push({ rel: base + oct, pc: (chord.rootPc + base) % 12 });
  }
  return out;
}

function buildFrom(chord, rootMidi, count, strategy) {
  const t = tones(chord, count);
  let v = t.map((x) => rootMidi + x.rel);
  if (strategy === 'open') {
    // spread: raise every other voice an octave
    v = v.map((m, i) => (i % 2 === 1 ? m + 12 : m));
  } else if (strategy === 'drop2' && v.length >= 3) {
    const idx = v.length - 2;
    v = v.slice();
    v[idx] -= 12;
  } else if (strategy === 'quartal') {
    // stack perfect fourths from the chord tones, snapped into the chord
    const pcs = new Set(t.map((x) => x.pc));
    const root = rootMidi;
    const q = [root];
    for (let i = 1; i < count; i++) {
      let cand = q[i - 1] + 5;
      for (let k = 0; k < 12; k++) {
        if (pcs.has(pc(cand + k))) { cand = cand + k; break; }
      }
      q.push(cand);
    }
    v = q;
  } else if (strategy === 'cluster') {
    // tight, semitone-ish cluster from the chord's pcs near the root
    const pcs = t.map((x) => x.pc);
    const sorted = pcs.slice().sort((a, b) => a - b);
    const root = rootMidi;
    v = sorted.map((p) => {
      const d = (p - pc(root) + 12) % 12;
      return root + d;
    });
    v = v.sort((a, b) => a - b);
  }
  return v.sort((a, b) => a - b);
}

export function candidateVoicings(chord, { lo = 50, hi = 76, count = 4, strategy = 'close' } = {}) {
  const strategies = strategy === 'auto' ? STRATEGIES : [strategy];
  const out = [];
  for (const st of strategies) {
    for (let oct = -2; oct <= 3; oct++) {
      const rootMidi = chord.rootPc + 12 * (4 + oct);
      const v = buildFrom(chord, rootMidi, count, st);
      if (v[0] < lo - 5 || v[v.length - 1] > hi + 5) continue;
      out.push({ notes: v, strategy: st });
    }
  }
  return out;
}

export function voiceChord(chord, opts = {}) {
  const { prev = null, count = 4, strategy = 'close' } = opts;
  const cands = candidateVoicings(chord, { ...opts, count, strategy });
  if (!cands.length) {
    const v = buildFrom(chord, chord.rootPc + 48, count, 'close');
    return { notes: v, strategy: 'close', cost: 0 };
  }
  let best = null;
  for (const c of cands) {
    let cost = voiceLeadingCost(prev, c.notes);
    // prefer middle of the range, mild
    const centre = (c.notes[0] + c.notes[c.notes.length - 1]) / 2;
    cost += Math.abs(centre - ((opts.lo ?? 50) + (opts.hi ?? 76)) / 2) * 0.15;
    if (!best || cost < best.cost) best = { ...c, cost };
  }
  return best;
}

// Voice a whole progression with continuity.
export function voiceProgression(chords, opts = {}) {
  let prev = null;
  return chords.map((ch) => {
    const v = voiceChord(ch, { ...opts, prev });
    prev = v.notes;
    return { ...ch, voicing: v.notes, strategy: v.strategy };
  });
}
