// The composer. Pure function of (presets, seed) -> Song.
// No Math.random, no Date.now, no DOM. Enforced by lint + test.
import { Rng, gauss } from './rng.js';
import { euclid, buildMarkov, markovNext, rhythmTree } from './algorithms.js';
import {
  SCALES, scaleOf, harmonyScaleOf, degreeToMidi,
  diatonicChord, chordPcs, chordSymbol, romanNumeral, pc, CHORD_INTERVALS,
} from './theory.js';
import { voiceProgression } from './voicing.js';
import { applyTransform } from './motif.js';
import { makeTempoMap, DEFAULT_DRIFT } from './tempo.js';
import { STYLES, STYLE_EXTRAS } from '../presets/styles.js';
import { MOODS } from '../presets/moods.js';
import { THEMES } from '../presets/themes.js';
import { TYPES, SECTION_TRACKS, SECTION_INTENSITY, TYPE_TRACK_MASK } from '../presets/types.js';
import { TECHS } from '../presets/techs.js';

const TONIC_WEIGHTS = [
  // C  C# D  D# E  F  F# G  G# A  A# B
  3, 1, 3, 1, 3, 3, 1, 3, 1, 3, 2, 2,
];

// Bump this whenever the composer's output changes for the same inputs.
// Seeds and share links carry it so an old link can say "this will sound
// different now" instead of silently lying.
export const COMPOSER_VERSION = 5;

export const BPM_MIN = 20;
export const BPM_MAX = 500;

export const DEFAULT_PRESETS = {
  texture: 'auto',
  style: 'lofi', mood: 'dreamy', theme: 'rain', tech: 'analog',
  bpm: 84, type: 'full', timeSig: [4, 4],
  key: null, bars: null, intensityBias: 0, swing: null, chaos: 0.15,
  arp: false, seed: null,
};

export function normalisePresets(p) {
  const out = { ...DEFAULT_PRESETS, ...(p || {}) };
  if (!STYLES[out.style]) out.style = 'lofi';
  if (!MOODS[out.mood]) out.mood = 'dreamy';
  if (!THEMES[out.theme]) out.theme = 'rain';
  if (!TECHS[out.tech]) out.tech = 'analog';
  if (!TYPES[out.type]) out.type = 'full';
  out.bpm = Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(Number(out.bpm) || 84)));
  out.texture = out.texture || 'auto';
  out.tempoDrift = Math.max(0, Math.min(0.35, Number(out.tempoDrift ?? DEFAULT_DRIFT) || 0));
  const ts = Array.isArray(out.timeSig) ? out.timeSig : [4, 4];
  out.timeSig = [Math.max(1, Math.min(12, ts[0] | 0)), ts[1] | 0 || 4];
  return out;
}

// ---------------------------------------------------------------- key/mode
function chooseKey(rng, mood, presets) {
  if (presets.key && typeof presets.key.tonic === 'number' && SCALES[presets.key.mode]) {
    return { tonic: ((presets.key.tonic % 12) + 12) % 12, mode: presets.key.mode };
  }
  const tonic = rng.weighted([...Array(12).keys()], TONIC_WEIGHTS);
  const modes = mood.modes;
  const mode = rng.weighted(modes.map((m) => m[0]), modes.map((m) => m[1]));
  return { tonic, mode };
}

// --------------------------------------------------------------- tempo
// How much faster or slower each kind of section wants to be, before mood
// and rubato are applied.
const SECTION_TEMPO = {
  intro: -0.06, verse: -0.02, chorus: 0.05, bridge: -0.08,
  outro: -0.1, loop: 0, break: -0.05, drone: 0, A: 0.02, B: 0.06,
};

function buildTempo(rng, style, mood, presets, sections, beatsPerBar) {
  const base = presets.bpm;
  const drift = Math.max(0, Math.min(0.35, presets.tempoDrift ?? style.tempoDrift ?? DEFAULT_DRIFT));
  const tension = 1 + Math.max(0, mood.tensionBias || 0) * 0.6;
  const segs = [{ beat: 0, bpm: base }];
  let bar = 0;

  sections.forEach((sec, si) => {
    const factor = 1 + (SECTION_TEMPO[sec.name] ?? 0) * tension;
    segs.push({ beat: bar * beatsPerBar, bpm: base * factor });
    // rubato: a small, deterministic nudge every four bars, so a phrase can
    // lean forward into its climax and ease off at the end
    for (let b = 4; b < sec.bars; b += 4) {
      const r = rng.fork(`rubato|${si}|${b}`).float() - 0.5;
      segs.push({ beat: (bar + b) * beatsPerBar, bpm: base * factor * (1 + r * drift * 0.8) });
    }
    bar += sec.bars;
  });

  // ritardando: the last two bars ease off, which is what makes an ending
  // sound like an ending rather than a stop
  if (bar >= 2) {
    segs.push({ beat: (bar - 2) * beatsPerBar, bpm: base * (1 - drift * 0.45) });
    segs.push({ beat: (bar - 1) * beatsPerBar, bpm: base * (1 - drift * 0.8) });
  }

  const lo = base * (1 - drift);
  const hi = base * (1 + drift);
  const clamped = segs.map((s) => ({ beat: s.beat, bpm: Math.max(lo, Math.min(hi, s.bpm)) }));
  return makeTempoMap(clamped, { base, drift });
}

// --------------------------------------------------------------- structure
function buildForm(rng, type, presets) {
  const form = TYPES[type].form;
  let sections = form.map(([name, bars], i) => ({ name, bars, index: i }));
  if (presets.bars) {
    // scale the form to the requested length, proportionally
    const total = sections.reduce((a, s) => a + s.bars, 0);
    const target = Math.max(4, Math.round(presets.bars / 4) * 4);
    let acc = 0;
    sections = sections.map((s, i) => {
      const share = i === sections.length - 1
        ? target - acc
        : Math.max(4, Math.round((s.bars / total) * target / 4) * 4);
      acc += share;
      return { ...s, bars: share };
    });
  }
  return sections;
}

// ------------------------------------------------------------- harmony
function sectionChords(rng, style, mood, section, ctx) {
  const { tonic, mode, beatsPerBar, prevProg, scaleName } = ctx;
  const progs = style.progressions;
  let prog = rng.pick(progs);
  let guard = 0;
  while (prevProg && prog.join(',') === prevProg.join(',') && guard++ < 8) prog = rng.pick(progs);
  // 2nd-order Markov variation over a corpus of the style's progressions
  if (rng.chance(0.25)) {
    const table = buildMarkov(progs.map((p) => p.map(String)), 2);
    const hist = prog.slice(0, 2).map(String);
    for (let i = 2; i < prog.length; i++) {
      const nxt = markovNext(table, hist, rng);
      if (nxt != null) { prog[i] = Number(nxt); hist.push(nxt); }
    }
  }

  const seventhChance = Math.max(0, Math.min(1, style.seventhChance + mood.seventhBias));
  const add9Chance = Math.max(0, Math.min(1, (style.add9Chance ?? 0) + mood.add9Bias));
  const chords = [];
  const intensity = section.intensity;

  for (let bar = 0; bar < section.bars; bar++) {
    const degree = prog[bar % prog.length];
    const withSeventh = rng.chance(seventhChance + intensity * 0.15);
    let ch = diatonicChord(tonic, scaleName, degree, withSeventh);
    // modal interchange: borrowed chords at low probability, gated by mood
    if (rng.chance(0.06 + Math.max(0, mood.tensionBias) * 0.1)) {
      const borrowed = [1, 3, 5, 6][rng.int(4)];
      const b = diatonicChord(tonic, 'aeolian', borrowed, withSeventh);
      if (b.rootPc !== ch.rootPc) ch = b;
    }
    let quality = ch.quality;
    if (rng.chance(add9Chance) && CHORD_INTERVALS[quality]) {
      if (quality === 'min7') quality = 'min9';
      else if (quality === 'maj7') quality = 'maj9';
      else if (quality === 'dom7') quality = 'dom9';
      else if (quality === 'maj') quality = 'add9';
    }
    if (rng.chance((style.susChance ?? 0) * 0.6) && (quality === 'maj' || quality === 'min')) {
      quality = quality === 'maj' ? 'sus2' : 'sus4';
    }
    chords.push({
      bar, durBars: 1, degree: ch.degree, rootPc: ch.rootPc, quality,
      intervals: CHORD_INTERVALS[quality],
      symbol: chordSymbol({ rootPc: ch.rootPc, quality }),
      roman: romanNumeral({ degree: ch.degree, quality }),
    });
  }
  return { chords, prog };
}

// ------------------------------------------------------------- drums
function resampleGrid(grid, steps) {
  if (steps === grid.length) return grid.slice();
  const out = new Array(steps).fill(0);
  for (let i = 0; i < steps; i++) {
    const src = Math.round((i / steps) * grid.length) % grid.length;
    out[i] = grid[src];
  }
  return out;
}

function drumBar(rng, style, intensity, bar, barInSection, sectionBars, steps, ctx) {
  const out = [];
  const stepBeats = ctx.beatsPerBar / steps;
  // a user groove override replaces the style template wholesale
  const groove = ctx.grooveOverride || style.groove;
  const density = Math.max(0.15, Math.min(1.2, 0.45 + intensity * 0.7 + ctx.mood.densityBias * 0.5));
  const kinds = Object.keys(groove);
  const fillZone = barInSection >= sectionBars - 1 || (barInSection % 4 === 3 && rng.chance(style.fillChance * 0.5));

  for (const kind of kinds) {
    let grid = resampleGrid(groove[kind], steps);
    // phrase mutation: every other 4-bar phrase nudges the pattern so a
    // section does not repeat a bar eight times
    if (barInSection >= 4 && barInSection % 4 < 2 && kind !== 'kick' && rng.chance(0.5)) {
      const shift = rng.chance(0.5) ? 1 : -1;
      grid = grid.map((v, i) => grid[(i + shift + steps) % steps]);
    }
    const baseVel = kind === 'kick' ? 1 : kind === 'snare' || kind === 'clap' ? 0.85 : 0.55;
    if (kind === 'hat' && ctx.polyrhythm && rng.chance(0.5)) {
      // polymeter: three against the bar's four
      grid = euclid(3, steps, 0);
    } else if (kind === 'hat') {
      // euclidean hat layer for non-4/4 and low-intensity sections
      const pulses = Math.max(2, Math.round(steps * Math.min(1, style.hatDensity * density)));
      const e = euclid(pulses, steps, rng.int(steps));
      grid = grid.map((v, i) => (v || (e[i] && rng.chance(0.6)) ? 1 : 0));
    }
    for (let i = 0; i < steps; i++) {
      if (!grid[i]) continue;
      if (rng.chance(1 - Math.min(1, density)) && kind !== 'kick') continue;
      let vel = baseVel * (i % 4 === 0 ? 1 : i % 2 === 0 ? 0.78 : 0.62) * (0.75 + intensity * 0.35);
      if (kind === 'snare' && rng.chance(style.ghostSnare ?? 0)) vel *= 0.35;
      out.push({ t: ctx.barStart + i * stepBeats, d: stepBeats * 0.9, v: vel, drum: kind });
    }
  }

  // fills
  if (fillZone && intensity > 0.35) {
    const fillKind = style.groove.tom ? 'tom' : (rng.chance(0.5) ? 'tom' : 'snare');
    const startStep = Math.max(0, steps - (rng.chance(0.5) ? 8 : 4));
    const n = steps - startStep;
    for (let i = 0; i < n; i++) {
      const prog = i / n;
      const subdiv = prog < 0.5 ? 2 : 1; // acceleration
      if (subdiv === 2 && i % 2 === 1) continue;
      out.push({
        t: ctx.barStart + (startStep + i) * stepBeats,
        d: stepBeats * 0.8,
        v: 0.45 + prog * 0.45,
        drum: fillKind,
      });
    }
  }
  return out;
}

// ------------------------------------------------------------- bass
function bassBar(rng, style, chord, intensity, ctx) {
  const { beatsPerBar } = ctx;
  const out = [];
  const root = ctx.bassRoot ?? chord.rootPc;
  const base = 36 + ((root - 36) % 12 + 12) % 12 + (style.bassOctave || 0) + (ctx.mood.register < 0 ? 0 : 0);
  const rootMidi = base;
  const fifth = rootMidi + (chord.intervals && chord.intervals[2] != null ? chord.intervals[2] : 7);
  const pattern = style.bassPattern;

  if (pattern === 'pedal') {
    out.push({ t: ctx.barStart, d: beatsPerBar * 0.98, p: rootMidi, v: 0.6 + intensity * 0.25 });
    return out;
  }
  if (pattern === 'sub') {
    out.push({ t: ctx.barStart, d: beatsPerBar * 0.45, p: rootMidi, v: 0.85 });
    if (beatsPerBar >= 4) out.push({ t: ctx.barStart + 2, d: beatsPerBar * 0.4, p: rootMidi, v: 0.7 });
    return out;
  }
  if (pattern === 'octave') {
    for (let i = 0; i < beatsPerBar * 2; i++) {
      const t = i * 0.5;
      const p = i % 2 === 0 ? rootMidi : rootMidi + 12;
      out.push({ t: ctx.barStart + t, d: 0.45, p, v: (i % 4 === 0 ? 0.9 : 0.65) * (0.7 + intensity * 0.3) });
    }
    return out;
  }
  if (pattern === 'walking') {
    const tones = chordPcs(chord).map((c) => 36 + ((c - 36) % 12 + 12) % 12);
    const ascending = rng.chance(0.6);
    for (let b = 0; b < beatsPerBar; b++) {
      const idx = ascending ? b % tones.length : (tones.length - 1 - (b % tones.length));
      const p = tones[idx] + 12 * (rng.chance(0.2) ? 1 : 0);
      out.push({ t: ctx.barStart + b, d: 0.85, p, v: (b === 0 ? 0.85 : 0.6) * (0.75 + intensity * 0.25) });
    }
    return out;
  }
  if (pattern === 'syncopated') {
    const steps = beatsPerBar * 4;
    const g = euclid(Math.max(2, Math.round(steps * 0.28)), steps, rng.int(steps));
    for (let i = 0; i < steps; i++) {
      if (!g[i]) continue;
      const p = i % 8 === 0 ? rootMidi : rng.chance(0.5) ? fifth : rootMidi;
      out.push({ t: ctx.barStart + i * 0.25, d: 0.22, p, v: (i % 4 === 0 ? 0.9 : 0.6) * (0.7 + intensity * 0.3) });
    }
    return out;
  }
  // root5th (default)
  const hits = [[0, rootMidi, 0.9], [beatsPerBar / 2, fifth, 0.7], [beatsPerBar - 1, rootMidi, 0.6]];
  for (const [t, p, v] of hits) {
    out.push({ t: ctx.barStart + t, d: Math.min(1, beatsPerBar / 2 - 0.1), p, v: v * (0.7 + intensity * 0.3) });
  }
  if (rng.chance(0.3)) {
    // passing tone on a weak beat
    const hs = scaleOf(ctx.scaleName);
    const p = fromDeg(degIndex(rootMidi, ctx.tonic, hs) + 1, ctx.tonic, hs);
    out.push({ t: ctx.barStart + beatsPerBar - 0.5, d: 0.4, p, v: 0.4 });
  }
  return out;
}

// ------------------------------------------------------------- motif/lead
// ---------------------------------------------------------------- theme
// One idea for the whole song. Every section is a derivation of this, which is
// what makes a piece sound composed rather than assembled.

export function buildTheme(rng, ctx) {
  const { beatsPerBar, tonic, scaleName, mood } = ctx;
  const scale = scaleOf(scaleName);
  const home = harmonyScaleOf(scaleName);
  const bars = 2;
  const steps = Math.round(beatsPerBar * 2 * bars);
  const centre = 62 + (mood.register ?? 0) * 4;
  const chordTones = [0, 2, 4].map((d) => (tonic + home[d % home.length]) % 12);

  const notes = [];
  let last = null;
  let step = 0;
  while (step < steps) {
    const position = step / steps;
    // rhythm: denser in the middle of the phrase, space at both ends
    const rest = rng.chance(0.22 + Math.abs(position - 0.5) * 0.35);
    if (rest) { step += 1; continue; }
    let p;
    if (last == null) {
      const options = chordTones.map((c) => 60 + ((c - 60) % 12 + 12) % 12);
      p = options.reduce((a, b) => (Math.abs(b - centre) < Math.abs(a - centre) ? b : a));
    } else if (step % 4 === 0) {
      // land on a chord tone at the strong beats
      const base = last - pc(last);
      p = chordTones.map((c) => base + c).reduce((a, b) => (Math.abs(b - last) < Math.abs(a - last) ? b : a));
    } else {
      const upBias = position < 0.5 ? 1.7 : 0.6;
      const d = rng.weighted([-2, -1, 1, 2], [1 * (2 - upBias), 3, 3 * upBias, 1 * upBias]);
      p = fromDeg(degIndex(last, tonic, scale) + d, tonic, scale);
    }
    p = clampPitch(p, 50, 88);
    const dur = rng.weighted([0.5, 1, 2], [2, 3, 1]);
    notes.push({ t: step * 0.5, d: dur, p, v: 0.62 + rng.float() * 0.2 });
    last = p;
    step += dur > 1 ? 2 : 1;
  }
  if (!notes.length) notes.push({ t: 0, d: 2, p: centre, v: 0.6 });
  // the theme ends where it can be picked up again
  notes[notes.length - 1].d = Math.max(1, notes[notes.length - 1].d);
  return notes;
}

// How each kind of section uses the theme.
export function deriveTheme(theme, sectionName, ctx, rng) {
  const { tonic, scaleName, beatsPerBar } = ctx;
  const span = beatsPerBar * 2;
  const shift = (n, degrees) => ({
    ...n, p: fromDeg(degIndex(n.p, tonic, scaleOf(scaleName)) + degrees, tonic, scaleOf(scaleName)),
  });

  switch (sectionName) {
    case 'intro':
      return theme.slice(0, Math.ceil(theme.length / 2)).map((n) => ({ ...n, v: n.v * 0.7 }));
    case 'verse':
      return theme.map((n) => ({ ...n, v: n.v * 0.92 }));
    case 'chorus':
      // same shape, lifted a third and opened out — and into the upper
      // register, so the chorus is heard as a lift and not a repeat
      return theme.map((n) => {
        const lifted = shift(n, 2);
        return {
          ...lifted,
          p: clampPitch(lifted.p < 74 ? lifted.p + 12 : lifted.p, 50, 96),
          v: Math.min(1, n.v * 1.12),
          d: n.d * 0.85,
        };
      });
    case 'bridge':
      return applyTransform('invert', theme, { rng, span, tonicPc: tonic, scale: scaleName })
        .map((n) => ({ ...n, v: n.v * 0.8 }));
    case 'outro':
      return theme.slice(0, Math.ceil(theme.length * 0.6))
        .map((n) => ({ ...n, v: n.v * 0.75, d: n.d * 1.6 }));
    case 'break':
      return theme.filter((_, i) => i % 2 === 0).map((n) => ({ ...n, v: n.v * 0.8 }));
    default:
      return theme;
  }
}

function makeMotif(rng, ctx, chord, density) {
  const { beatsPerBar, tonic, scaleName, mood } = ctx;
  const scale = scaleOf(scaleName);
  const steps = Math.round(beatsPerBar * 2);
  // melody tones are restricted to the key; a borrowed chord's own tones
  // only get used where they are also diatonic, so a chromatic chord tone
  // can never be carried into the next bar's harmony.
  const keyPcs = scale.map((x) => (ctx.tonic + x) % 12);
  const chordPcsAll = chordPcs(chord);
  const diatonic = chordPcsAll.filter((c) => keyPcs.includes(c));
  const chordTones = diatonic.length ? diatonic : chordPcsAll;
  const out = [];
  let lastPitch = null;
  const centre = 60 + mood.register * 5;

  for (let i = 0; i < steps; i++) {
    const strong = i % 2 === 0;
    const restChance = (mood.restChance ?? 0.25) * (strong ? 0.55 : 1.25) * (1.25 - density);
    if (rng.chance(Math.min(0.95, restChance))) { continue; }
    let p;
    if (lastPitch == null) {
      const base = chordTones.map((c) => 60 + ((c - 60) % 12 + 12) % 12);
      p = base.reduce((a, b) => (Math.abs(b - centre) < Math.abs(a - centre) ? b : a));
    } else if (strong && rng.chance(0.6)) {
      // chord tone nearest to the previous note
      const cands = chordTones.flatMap((c) => {
        const base = lastPitch - pc(lastPitch) + c;
        return [base - 12, base, base + 12];
      });
      p = cands.reduce((a, b) => (Math.abs(b - lastPitch) <= Math.abs(a - lastPitch) ? b : a));
    } else {
      // contour: rise through the first half of the phrase, fall through the
      // second. A melody that only wanders is the difference between "notes"
      // and a line.
      const position = i / Math.max(1, steps - 1);
      const upBias = position < 0.5 ? 1.6 : 0.55;
      const step = rng.weighted([-2, -1, 1, 2], [1 * (2 - upBias), 3, 3 * upBias, 1 * upBias]);
      p = fromDeg(degIndex(lastPitch, ctx.tonic, scale) + step, ctx.tonic, scale);
      while (p - lastPitch > 7) p -= 12;
      while (lastPitch - p > 7) p += 12;
    }
    p = clampPitch(p, 48, 88);
    // articulation: mix short and held notes instead of one flat length
    const artic = rng.weighted(['short', 'mid', 'long'], [mood.staccato ?? 0.2, 3, 1]);
    const dur = artic === 'short' ? 0.25 : artic === 'long' ? 1 : 0.5;
    // a small arch in dynamics across the bar: louder at the climax
    const arch = 0.86 + 0.18 * Math.sin((i / Math.max(1, steps - 1)) * Math.PI);
    out.push({
      t: i * 0.5, d: dur, p,
      v: (strong ? 0.85 : 0.62) * (0.7 + (mood.velCurve ?? 0.6) * 0.4) * arch,
    });
    lastPitch = p;
  }
  // contour memory: the phrase resolves to a chord tone instead of wandering
  if (out.length) {
    const last = out[out.length - 1];
    let best = last.p, bd = 99;
    for (const c of chordTones) {
      for (let k = -2; k <= 2; k++) {
        const cand = last.p - (last.p % 12) + c + 12 * k;
        const d = Math.abs(cand - last.p);
        if (d < bd) { bd = d; best = cand; }
      }
    }
    if (bd <= 3) last.p = best;
  }
  return out;
}
function degIndex(midi, tonicPc, scale) {
  const n = scale.length;
  const rel = midi - tonicPc;
  const oct = Math.floor(rel / 12);
  const within = rel - oct * 12;
  let best = 0, bd = 99;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(scale[i] - within);
    if (d < bd) { bd = d; best = i; }
  }
  return oct * n + best;
}
function fromDeg(idx, tonicPc, scale) {
  const n = scale.length;
  const oct = Math.floor(idx / n);
  const i = ((idx % n) + n) % n;
  return tonicPc + scale[i] + 12 * oct;
}

function clampPitch(p, lo, hi) {
  let x = p;
  while (x < lo) x += 12;
  while (x > hi) x -= 12;
  return x;
}

function leadSection(rng, style, ctx, section, chords) {
  const out = [];
  const development = style.development || [];
  const density = Math.max(0.2, Math.min(1, 0.5 + section.intensity * 0.6 + (ctx.mood.densityBias || 0)));
  let motif = makeMotif(rng, ctx, chords[0], density);
  const span = ctx.beatsPerBar;

  for (let bar = 0; bar < section.bars; bar++) {
    const barStart = ctx.barStart + bar * span;
    let notes;
    const isPhraseStart = bar % 4 === 0;
    if (isPhraseStart) {
      // new motif or a transform of the previous one
      if (bar === 0 || rng.chance(0.45)) {
        motif = makeMotif(rng, ctx, chords[bar % chords.length], density);
      } else if (development.length) {
        const name = development[rng.int(development.length)];
        motif = applyTransform(name, motif, {
          rng, span, tonicPc: ctx.tonic, scale: ctx.scaleName,
        });
      }
    } else if (rng.chance(0.35) && development.length) {
      const name = development[rng.int(development.length)];
      notes = applyTransform(name, motif, { rng, span, tonicPc: ctx.tonic, scale: ctx.scaleName });
    } else if (rng.chance(0.3) && motif.length > 2) {
      // a repeat with one note changed, so the phrase develops instead of looping
      notes = motif.map((n) => ({ ...n }));
      const target = notes[rng.int(notes.length)];
      target.p = fromDeg(degIndex(target.p, ctx.tonic, scaleOf(ctx.scaleName)) + (rng.chance(0.5) ? 1 : -1),
        ctx.tonic, scaleOf(ctx.scaleName));
    }
    const src = notes ?? motif;
    for (const n of src) {
      if (n.t < 0 || n.t >= span) continue;
      // snap chord tones on downbeats of the bar
      let p = n.p;
      const chord = chords[bar % chords.length];
      if (Math.abs(n.t) < 1e-6 && rng.chance(0.7)) {
        const all = chordPcs(chord);
        const keyPcs = scaleOf(ctx.scaleName).map((x) => (ctx.tonic + x) % 12);
        const diat = all.filter((c) => keyPcs.includes(c));
        const cts = diat.length ? diat : all;
        let best = p, bd = 99;
        for (const c of cts) {
          for (let k = -6; k <= 6; k++) {
            const cand = p - pc(p) + c + 12 * k;
            if (Math.abs(cand - p) < bd) { bd = Math.abs(cand - p); best = cand; }
          }
        }
        if (bd <= 2) p = best;
      }
      out.push({ ...n, t: barStart + n.t, p: clampPitch(p, 50, 96) });
    }
  }

  // Human phrasing: breathe at the end of every four-bar phrase, swell into
  // the third bar, and land the section on a longer note.
  const barSpan = ctx.beatsPerBar;
  for (let i = out.length - 1; i >= 0; i--) {
    const n = out[i];
    const barIndex = Math.floor((n.t - ctx.barStart) / barSpan);
    const posInBar = (n.t - ctx.barStart) % barSpan;
    const phrasePos = barIndex % 4;
    const swell = [0.92, 1.0, 1.06, 0.9][phrasePos] ?? 1;
    n.v *= swell;
    // a rest in the last half-beat of each phrase
    if (phrasePos === 3 && posInBar >= barSpan - 0.5) {
      out.splice(i, 1);
      continue;
    }
    // the final note of the section is held, not clipped
    const isLast = i === out.length - 1;
    if (isLast) n.d = Math.max(n.d, barSpan * 0.9);
  }
  return out;
}

// ------------------------------------------------------------- pad / arp
// Counter-line: the pad answers in the gaps where the lead is silent.
function padSection(rng, ctx, section, chords, leadNotes = []) {
  const out = [];
  const beatOf = (n) => n.t;
  const busy = (start, end) => leadNotes.some((n) => beatOf(n) < end && beatOf(n) + n.d > start);

  for (let bar = 0; bar < section.bars; bar++) {
    const ch = chords[bar % chords.length];
    const notes = (ch.voicing || []).slice(1).map((p) => p + 12);
    const start = ctx.barStart + bar * ctx.beatsPerBar;
    const end = start + ctx.beatsPerBar;

    if (leadNotes.length && busy(start, end) && rng.chance(0.55)) {
      // answer instead of sustain: short chord stab in the second half
      const at = start + ctx.beatsPerBar * (0.5 + rng.float() * 0.25);
      for (const p of notes) {
        out.push({ t: at, d: ctx.beatsPerBar * 0.35, p, v: 0.3 + section.intensity * 0.18 });
      }
    } else {
      for (const p of notes) {
        out.push({ t: start, d: ctx.beatsPerBar * 0.99, p, v: 0.35 + section.intensity * 0.2 });
      }
    }
  }
  return out;
}

function arpSection(rng, ctx, section, chords) {
  const out = [];
  const rate = ctx.beatsPerBar >= 4 ? 0.25 : 0.5;
  for (let bar = 0; bar < section.bars; bar++) {
    const ch = chords[bar % chords.length];
    const pcs = chordPcs(ch);
    const base = 60 + ((pcs[0] - 60) % 12 + 12) % 12;
    const seq = pcs.map((c) => base + ((c - pc(base) + 12) % 12));
    const pattern = rng.pick(['up', 'updown', 'down']);
    let idxs = seq.map((_, i) => i);
    if (pattern === 'down') idxs.reverse();
    if (pattern === 'updown') idxs = idxs.concat(idxs.slice(1, -1).reverse());
    const n = Math.round(ctx.beatsPerBar / rate);
    for (let i = 0; i < n; i++) {
      const p = seq[idxs[i % idxs.length]] + (rng.chance(0.15) ? 12 : 0);
      out.push({ t: ctx.barStart + bar * ctx.beatsPerBar + i * rate, d: rate * 0.9, p, v: 0.3 + section.intensity * 0.3 });
    }
  }
  return out;
}

// ------------------------------------------------------------- humanise
function humanise(notes, rng, style, mood, bpm = 100) {
  const swing = style.swing ?? 0;
  return notes.map((n) => {
    const beatPos = n.t % 1;
    const swingShift = Math.abs(beatPos - 0.5) < 1e-6 ? swing * 0.28 : 0;
    // timing feel is relative to the beat: a slow song can breathe more than
    // a 500 BPM one, where 6 ms would already be a different note
    const beatSec = 60 / bpm;
    const jitterScale = Math.max(0.0015, Math.min(0.012, beatSec * 0.02));
    const jitter = gauss(rng) * jitterScale;
    const velJit = 1 + gauss(rng) * 0.07;
    const lenJit = 1 + gauss(rng) * 0.06;
    return {
      ...n,
      t: Math.max(0, n.t + swingShift + jitter),
      d: Math.max(0.05, n.d * lenJit),
      v: Math.max(0.05, Math.min(1, n.v * velJit)),
    };
  });
}

// ------------------------------------------------------------- title
function makeTitle(rng, theme) {
  const words = theme.words;
  const a = rng.pick(words);
  const b = rng.pick(words);
  const patterns = [() => a, () => `${a} ${b.toLowerCase()}`, () => `The ${a}`, () => `${a} / ${b}`];
  let t = rng.pick(patterns)();
  if (t.length > 28) t = a;
  return t;
}

// ============================================================= compose
// ------------------------------------------------------------------ the plan
//
// A song is two things: the decisions, and the notes those decisions produce.
// `plan()` makes the decisions — key, form, chords, voicing, theme, tempo — and
// returns plain JSON. `render()` turns that into scheduled notes. `compose()` is
// the two together, so every existing caller keeps working unchanged.
//
// The point of the split is that the plan is a *value*: you can print it, carry
// it in a share link, or change one chord and hear the same song with that
// chord. Every stage draws from its own named RNG fork and `fork()` never
// advances its parent, which is why cutting the pipeline in two here does not
// move a single note.
export const PLAN_VERSION = 1;

const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function plan(rawPresets, seed) {
  const presets = normalisePresets(rawPresets);
  const style = { ...STYLES[presets.style], ...(STYLE_EXTRAS[presets.style] || {}) };
  const mood = MOODS[presets.mood];

  const rng = new Rng(seed);
  const { tonic, mode } = chooseKey(rng.fork('key'), mood, presets);
  const scaleName = mode;
  const beatsPerBar = presets.timeSig[0];

  const form = buildForm(rng.fork('form'), presets.type, presets);
  const intensityCurve = style.intensity;

  // One theme for the whole song, in the home key: every section derives from
  // it, which is what makes a piece sound composed rather than assembled.
  const songTheme = presets.themeSeed
    ? normaliseTheme(presets.themeSeed, tonic, scaleName)
    : buildTheme(rng.fork('theme'), { beatsPerBar, tonic, scaleName, mood });

  // Section aliasing: a repeated section reuses the first one's musical
  // material, so the second verse is a variation rather than a new tune.
  const firstNameIndex = {};
  form.forEach((sec, i) => {
    if (firstNameIndex[sec.name] == null) firstNameIndex[sec.name] = i;
  });

  // Modulation: styles may lift the key between sections (whole-step "gear
  // change" or a pivot). Kept per section so the validator can follow it.
  const modChance = style.modulation ?? 0.12;
  let sectionTonic = tonic;
  let barCursor = 0;
  let prevProg = null;
  let prevVoicing = null;

  const sections = [];
  const aliases = [];

  form.forEach((sec, si) => {
    const aliasIndex = firstNameIndex[sec.name] ?? si;

    if (si > 0 && rng.fork('mod' + si).chance(modChance)) {
      sectionTonic = (tonic + (rng.fork('modstep' + si).chance(0.6) ? 2 : 5)) % 12;
    }
    const sTonic = sectionTonic;
    const base = SECTION_INTENSITY[sec.name] ?? 0.6;
    const curve = intensityCurve[si % intensityCurve.length];
    const intensity = Math.max(0, Math.min(1,
      base * 0.55 + curve * 0.45 + (mood.tensionBias || 0) * 0.4 + (presets.intensityBias || 0)));
    const section = {
      name: sec.name, index: si, bar: barCursor, bars: sec.bars, intensity,
      key: { tonic: sTonic, mode: scaleName },
    };

    const { chords, prog } = sectionChords(rng.fork('section' + aliasIndex).fork('harmony'), style, mood, section, {
      tonic: sTonic, mode, beatsPerBar, prevProg, scaleName,
    });
    prevProg = prog;

    const voiced = voiceProgression(
      chords.map((c) => ({ ...c })),
      {
        lo: 52 + (mood.register < 0 ? -4 : 0),
        hi: 76 + (mood.register > 0 ? 4 : 0),
        count: style.voiceCount ?? 4,
        strategy: style.voicing ?? 'close',
        prev: prevVoicing,
      },
    );
    prevVoicing = voiced[voiced.length - 1]?.voicing ?? prevVoicing;
    section.chords = voiced.map((c) => ({
      bar: barCursor + c.bar, rootPc: c.rootPc, quality: c.quality,
      symbol: c.symbol, roman: c.roman, voicing: c.voicing,
      pcs: chordPcs(c), intervals: c.intervals,
    }));

    sections.push(section);
    aliases.push(aliasIndex);
    barCursor += sec.bars;
  });

  const tempoMap = buildTempo(rng.fork('tempo'), style, mood, presets, form, beatsPerBar);

  return {
    v: 1,
    planVersion: PLAN_VERSION,
    composerVersion: COMPOSER_VERSION,
    seed: String(seed),
    presets,
    key: { tonic, mode, name: `${KEY_NAMES[tonic]} ${mode}` },
    bpm: presets.bpm,
    timeSig: presets.timeSig,
    beatsPerBar,
    bars: barCursor,
    totalBeats: barCursor * beatsPerBar,
    tempo: { base: presets.bpm, drift: tempoMap.drift },
    theme: songTheme,
    sections,
    aliases,
    variant: presets.variant ?? rng.fork('variant').int(3),
  };
}

// A plan can arrive from three places: `plan()` itself, a share link, or a
// person who moved a section or swapped a chord. Normalise all three into the
// shape `render()` expects, rebasing bar numbers so a reordered plan still
// lines up with the tempo map.
export function normalisePlan(raw) {
  const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!p || typeof p !== 'object') throw new Error('plan: not an object');
  if (!Array.isArray(p.sections) || p.sections.length === 0) throw new Error('plan: no sections');
  if (!p.presets || !p.key) throw new Error('plan: incomplete');

  const presets = normalisePresets(p.presets);
  const beatsPerBar = p.beatsPerBar || presets.timeSig[0];
  const homeTonic = ((p.key.tonic ?? 0) | 0) % 12;

  let bar = 0;
  const sections = p.sections.map((s, i) => {
    const startBar = bar;
    const bars = Math.max(1, Math.round(Number(s.bars ?? 4)));
    const from = Number(s.bar ?? 0);
    const sec = {
      name: String(s.name ?? 'verse'),
      index: i,
      bar: startBar,
      bars,
      intensity: clamp01(Number(s.intensity ?? 0.6)),
      key: {
        tonic: ((s.key?.tonic ?? homeTonic) | 0) % 12,
        mode: s.key?.mode ?? p.key.mode,
      },
      chords: (Array.isArray(s.chords) ? s.chords : []).map((c) => ({
        bar: startBar + (Number(c.bar ?? 0) - from),
        rootPc: ((c.rootPc ?? 0) | 0) % 12,
        quality: c.quality ?? 'maj',
        symbol: c.symbol ?? '',
        roman: c.roman ?? '',
        voicing: Array.isArray(c.voicing) ? c.voicing.map(Number) : [],
        pcs: Array.isArray(c.pcs) ? c.pcs.map(Number) : chordPcs({ rootPc: ((c.rootPc ?? 0) | 0) % 12, quality: c.quality ?? 'maj' }),
        intervals: c.intervals ?? CHORD_INTERVALS[c.quality ?? 'maj'],
      })),
    };
    if (!sec.chords.length) {
      // a section with no harmony cannot be rendered; give it the tonic triad
      sec.chords.push({
        bar: startBar, rootPc: sec.key.tonic, quality: 'maj', symbol: '',
        roman: 'I', voicing: [48 + sec.key.tonic, 52 + sec.key.tonic, 55 + sec.key.tonic],
        pcs: chordPcs({ rootPc: sec.key.tonic, quality: 'maj' }),
        intervals: CHORD_INTERVALS.maj,
      });
    }
    bar += bars;
    return sec;
  });

  return {
    ...p,
    presets,
    beatsPerBar,
    bars: bar,
    totalBeats: bar * beatsPerBar,
    sections,
    aliases: sections.map((s, i) => p.aliases?.[i] ?? i),
    seed: String(p.seed ?? 'seed'),
  };
}

// The plan's chords carry `intervals` so the bass knows the real shape of the
// chord; the Song keeps the smaller public shape it has always had.
function songChords(chords) {
  return chords.map((c) => ({
    bar: c.bar, rootPc: c.rootPc, quality: c.quality,
    symbol: c.symbol, roman: c.roman, voicing: c.voicing,
    pcs: c.pcs,
  }));
}

export function render(rawPlan) {
  const planObj = normalisePlan(rawPlan);
  const { presets, beatsPerBar, seed } = planObj;
  const style = { ...STYLES[presets.style], ...(STYLE_EXTRAS[presets.style] || {}) };
  const mood = MOODS[presets.mood];
  const theme = THEMES[presets.theme];
  const tech = TECHS[presets.tech];
  const songTheme = planObj.theme;
  const { tonic, mode } = planObj.key;

  const rng = new Rng(seed);
  // The tempo map is a pure function of the sections' names and lengths, so it
  // is rebuilt here rather than trusted from the plan: a reordered plan gets a
  // tempo map that matches it.
  const tempoMap = buildTempo(rng.fork('tempo'), style, mood, presets, planObj.sections, beatsPerBar);

  const tracks = { drums: [], bass: [], chords: [], lead: [], pad: [], arp: [], bed: [] };
  const songSections = [];

  // A locked track draws from a stream seeded ONLY by the lock, so a new
  // song seed cannot change it.
  const trackRng = (name, fallback) => {
    const locked = presets.lockTracks?.[name] && presets.trackSeeds?.[name];
    return locked ? new Rng(`locked|${name}|${presets.trackSeeds[name]}`) : fallback;
  };

  planObj.sections.forEach((section, si) => {
    const sec = section;
    const aliasIndex = planObj.aliases[si] ?? si;
    const rngS = rng.fork('section' + aliasIndex);
    const isLast = si === planObj.sections.length - 1;
    const barCursor = sec.bar;
    const sTonic = sec.key.tonic;
    const intensity = sec.intensity;
    const voiced = sec.chords;

    const ctx = {
      tonic: sTonic, scaleName: mode, beatsPerBar, mood, barStart: barCursor * beatsPerBar,
      bassRoot: null,
      theme: songTheme,
      sectionName: sec.name,
      grooveOverride: presets.grooveOverride || null,
      polyrhythm: false, // set per section from the drum stream below
    };

    const mask = TYPE_TRACK_MASK[presets.type];
    let allowed = SECTION_TRACKS[sec.name] || ['drums', 'bass', 'chords', 'lead'];
    if (mask) allowed = allowed.filter((t) => mask.includes(t));
    const thin = intensity < 0.32;

    // chords (always, if allowed)
    if (allowed.includes('chords')) {
      const rngC = rngS.fork('chords');
      for (let bar = 0; bar < sec.bars; bar++) {
        const ch = voiced[bar % voiced.length];
        const start = (barCursor + bar) * beatsPerBar;
        const strum = style.id === 'folk' || style.id === 'rock' ? 0.06 : 0.015;
        const level = 0.5 + intensity * 0.3;
        // chord rhythm: sometimes a push on the "and" of 2, sometimes a
        // staccato double hit — chords stop being one block per bar
        const rhythm = rngC.chance(style.chordRhythm ?? 0.25)
          ? (rngC.chance(0.5) ? 'push' : 'double')
          : 'whole';
        const hits = rhythm === 'whole'
          ? [{ at: 0, dur: beatsPerBar * 0.95, v: 1 }]
          : rhythm === 'push'
            ? [{ at: 0, dur: beatsPerBar * 0.6, v: 1 }, { at: beatsPerBar * 0.5 + 0.5, dur: beatsPerBar * 0.4, v: 0.8 }]
            : [{ at: 0, dur: beatsPerBar * 0.45, v: 1 }, { at: beatsPerBar * 0.5, dur: beatsPerBar * 0.4, v: 0.75 }];
        for (const hit of hits) {
          ch.voicing.forEach((p, i) => {
            tracks.chords.push({
              t: start + hit.at + i * strum,
              d: Math.max(0.08, hit.dur),
              p,
              v: level * hit.v * (i === 0 ? 1 : 0.85),
            });
          });
        }
      }
    }
    if (allowed.includes('bass')) {
      const rngB = trackRng('bass', rng.fork('bass'));
      for (let bar = 0; bar < sec.bars; bar++) {
        const ch = voiced[bar % voiced.length];
        const bctx = { ...ctx, barStart: (barCursor + bar) * beatsPerBar };
        tracks.bass.push(...bassBar(rngB, style, ch, intensity, bctx));
      }
    }
    if (allowed.includes('drums') && !thin) {
      const rngD = trackRng('drums', rng.fork('drums'));
      // decided inside the drum stream so a locked pattern stays locked
      ctx.polyrhythm = (style.polyrhythm ?? 0) > 0 && rngD.chance(style.polyrhythm);
      const steps = beatsPerBar * 4;
      for (let bar = 0; bar < sec.bars; bar++) {
        const dctx = { ...ctx, barStart: (barCursor + bar) * beatsPerBar, mood };
        tracks.drums.push(...drumBar(rngD, style, intensity, bar, bar, sec.bars, steps, dctx));
      }
    }
    if (allowed.includes('lead')) {
      const rngL = trackRng('lead', rng.fork('lead'));
      const leadNotes = leadSection(rngL, style, ctx, sec, voiced);
      tracks.lead.push(...leadNotes);
      sec.leadNotes = leadNotes;
      // doubling: rock/folk/chiptune often want the lead an octave up
      if ((style.doubleLead ?? 0) > 0 && rngS.chance(style.doubleLead)) {
        for (const n of leadNotes) {
          if (n.p + 12 <= 96) tracks.lead.push({ ...n, p: n.p + 12, v: n.v * 0.42 });
        }
      }
    }
    if (allowed.includes('pad')) {
      const rngP = rngS.fork('pad');
      tracks.pad.push(...padSection(rngP, ctx, sec, voiced, sec.leadNotes || []));
    }
    const bedTexture = textureFor(presets.theme, style, rng.fork('tex' + si), presets.texture ?? 'auto');
    const wantsBed = presets.texture === 'none'
      ? false
      : (bedTexture != null && (presets.texture !== 'auto' || (style.texture ?? 0) > 0));
    if (wantsBed && (allowed.includes('pad') || sec.name === 'drone')) {
      const level = 0.22 + intensity * 0.2;
      tracks.bed.push({
        t: barCursor * beatsPerBar,
        d: sec.bars * beatsPerBar,
        p: 48 + sTonic,
        v: level * (style.texture ?? 0.5),
        texture: bedTexture,
      });
    }
    if (presets.arp && allowed.includes('chords')) {
      const rngA = rngS.fork('arp');
      tracks.arp.push(...arpSection(rngA, ctx, sec, voiced));
    }

    if (isLast && sec.bars >= 4) {
      // an outro fades the arrangement, not just the volume
      const startBeat = barCursor * beatsPerBar;
      const span = sec.bars * beatsPerBar;
      for (const name of Object.keys(tracks)) {
        for (const n of tracks[name]) {
          if (n.t < startBeat) continue;
          const p = Math.min(1, (n.t - startBeat) / span);
          n.v *= 1 - p * 0.55;
        }
      }
    }

    songSections.push({ ...sec, chords: songChords(sec.chords) });
  });

  // humanise each track with its own stream (locked tracks keep theirs too)
  for (const k of Object.keys(tracks)) {
    const locked = presets.lockTracks?.[k] && presets.trackSeeds?.[k];
    const stream = locked
      ? new Rng(`lockedhum|${k}|${presets.trackSeeds[k]}`)
      : rng.fork('hum-' + k);
    tracks[k] = humanise(tracks[k], stream, style, mood, presets.bpm);
    tracks[k].sort((a, b) => a.t - b.t);
  }

  const totalBars = planObj.bars;
  const totalBeats = totalBars * beatsPerBar;
  const durationSec = tempoMap.secondsAt(totalBeats);

  const fx = {
    reverb: clamp01((style.fx.reverb ?? 0.3) + (theme.fxBias?.reverb ?? 0)),
    delay: clamp01((style.fx.delay ?? 0.2) + (theme.fxBias?.delay ?? 0)),
    chorus: clamp01((style.fx.chorus ?? 0) + (theme.fxBias?.chorus ?? 0)),
  };

  return {
    v: 1,
    composerVersion: COMPOSER_VERSION,
    seed: String(seed),
    presets,
    title: makeTitle(rng.fork('title'), theme),
    key: { tonic, mode, name: `${KEY_NAMES[tonic]} ${mode}` },
    bpm: presets.bpm,
    bpmRange: [tempoMap.min, tempoMap.max],
    tempo: {
      base: presets.bpm,
      drift: tempoMap.drift,
      segments: tempoMap.segments,
      min: tempoMap.min,
      max: tempoMap.max,
    },
    timeSig: presets.timeSig,
    beatsPerBar,
    bars: totalBars,
    durationSec,
    sections: songSections,
    tracks,
    fx,
    mix: { ...style.mix },
    style: style.id,
    mood: mood.id,
    theme: theme.id,
    tech: tech.id,
    lufs: style.lufs ?? -14,
    monoBass: !!style.monoBass,
    sidechain: !!style.sidechain,
    theme: songTheme,
    transitions: collectTransitions(songSections, style, mood, tempoMap, beatsPerBar),
    width: style.width ?? 0.4,
    variant: planObj.variant ?? presets.variant ?? rng.fork('variant').int(3),
    tuning: presets.microtuning ? { cents: justIntonationCents(tonic, mode) } : null,
    palette: theme.palette,
    totalNotes: Object.values(tracks).reduce((a, t) => a + t.length, 0),
  };
}

// The whole song from presets and a seed: plan, then render.
export function compose(rawPresets, seed) {
  return render(plan(rawPresets, seed));
}

// Which ambience sits under a section: the theme says what the song is about,
// the style says what it sounds like.
const THEME_TEXTURE = {
  rain: ['rain', 'rain', 'vinyl'],
  ocean: ['ocean', 'wind', 'stream'],
  space: ['wind', 'hum', 'ocean'],
  forest: ['crickets', 'stream', 'wind'],
  desert: ['wind', 'hum'],
  cyberpunk: ['hum', 'vinyl', 'rain'],
  nightdrive: ['vinyl', 'hum'],
  festival: ['wind', 'rain'],
  winter: ['wind', 'wind', 'hum'],
  fire: ['fire', 'fire', 'crickets'],
};

// A riser into a lift, an impact on the downbeat: only where the arrangement
// actually builds, and never more than a few per song.
export function collectTransitions(sections, style, mood, tempoMap, beatsPerBar) {
  const out = [];
  const strength = (style.modulation ?? 0.15) + (mood.tensionBias ?? 0);
  if (strength < 0.2) return out;
  sections.forEach((sec, i) => {
    if (i === 0) return;
    const prev = sections[i - 1];
    const lift = (sec.intensity ?? 0.5) - (prev.intensity ?? 0.5);
    if (lift <= 0.05) return;
    const beat = sec.bar * beatsPerBar;
    const gain = Math.min(1, 0.5 + lift);
    out.push({ beat, kind: 'riser', gain });
    out.push({ beat, kind: 'impact', gain: gain * 0.8 });
  });
  return out.slice(0, 8);
}

// `explicit` comes from the Ambience dial: 'auto' follows the theme, 'none'
// means silence, and any other value is the texture the listener asked for.
export function textureFor(themeId, style, rng, explicit = 'auto') {
  if (explicit === 'none') return null;
  if (explicit && explicit !== 'auto') return explicit;
  const options = THEME_TEXTURE[themeId] || ['rain', 'wind', 'vinyl'];
  if (style?.texture && style.texture > 0.6) return options[rng.int(options.length)];
  return options[0];
}

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

// An imported theme (from MIDI) is just notes in beats; clamp it into range so
// a wild import cannot break the register rules the validator enforces.
export function normaliseTheme(notes, tonic, scaleName) {
  const scale = scaleOf(scaleName);
  const start = notes.length ? Math.min(...notes.map((n) => n.t)) : 0;
  return notes
    .map((n) => ({
      t: Math.max(0, n.t - start),
      d: Math.max(0.25, Math.min(4, n.d ?? 0.5)),
      p: clampPitch(Math.round(n.p), 45, 92),
      v: Math.max(0.2, Math.min(1, n.v ?? 0.7)),
    }))
    .sort((a, b) => a.t - b.t)
    .slice(0, 24);
}

// Just-intonation ratios for a major scale, expressed as cents away from
// 12-TET so the engine can apply them as a detune per pitch class.
const JI_RATIOS = [1, 16 / 15, 9 / 8, 6 / 5, 5 / 4, 4 / 3, 45 / 32, 3 / 2, 8 / 5, 5 / 3, 9 / 5, 15 / 8];

export function justIntonationCents(tonic, mode) {
  const scale = scaleOf(mode);
  const cents = new Array(12).fill(0);
  for (let i = 0; i < scale.length; i++) {
    const semis = scale[i] % 12;
    const p = (tonic + semis) % 12;
    // the table is chromatic: index it by semitones, not by scale degree
    const jiCents = 1200 * Math.log2(JI_RATIOS[semis]);
    cents[p] = Math.round((jiCents - semis * 100) * 100) / 100;
  }
  return cents;
}
