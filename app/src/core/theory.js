// Music theory primitives. Pure functions only.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const NOTE_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

export const MODES = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
};

export const PENTATONICS = {
  majorPent: [0, 2, 4, 7, 9],
  minorPent: [0, 3, 5, 7, 10],
  egyptian: [0, 2, 5, 7, 10],
  hirajoshi: [0, 2, 3, 7, 8],
};

export const EXOTIC = {
  hijaz: [0, 1, 4, 5, 7, 8, 10],
  wholeTone: [0, 2, 4, 6, 8, 10],
  phrygianDominant: [0, 1, 4, 5, 7, 8, 10],
  miyako: [0, 1, 5, 7, 8],
};

// scale -> the 7-note mode used to harmonise it (pentatonics borrow harmony)
export const HARMONY_SOURCE = {
  majorPent: 'ionian',
  minorPent: 'aeolian',
  egyptian: 'phrygian',
  hirajoshi: 'aeolian',
  hijaz: 'phrygian',
  phrygianDominant: 'phrygian',
  wholeTone: 'lydian',
  miyako: 'phrygian',
};

export const SCALES = { ...MODES, ...PENTATONICS, ...EXOTIC };

export function scaleOf(name) {
  return SCALES[name] || MODES.aeolian;
}

export function harmonyScaleOf(name) {
  const base = MODES[name] ? name : HARMONY_SOURCE[name] || 'aeolian';
  return MODES[base];
}

export function isPentatonic(name) {
  return !!PENTATONICS[name] || !!EXOTIC[name];
}

// --- pitch helpers ------------------------------------------------------
export function pc(midi) { return ((midi % 12) + 12) % 12; }
export function midiName(midi, flats = false) {
  const n = (flats ? NOTE_NAMES_FLAT : NOTE_NAMES)[pc(midi)];
  return n + (Math.floor(midi / 12) - 1);
}
export function freqOf(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

// scale-degree (0-indexed, may exceed 7 or go negative) -> midi
export function degreeToMidi(tonicMidi, scale, degree) {
  const n = scale.length;
  const oct = Math.floor(degree / n);
  const idx = ((degree % n) + n) % n;
  return tonicMidi + scale[idx] + 12 * oct;
}

export function scalePcs(tonicPc, scale) {
  return scale.map((s) => (tonicPc + s) % 12);
}

export function inScale(midi, tonicPc, scale) {
  return scalePcs(tonicPc, scale).includes(pc(midi));
}

export function nearestInScale(midi, tonicPc, scale) {
  for (let d = 0; d < 12; d++) {
    if (inScale(midi + d, tonicPc, scale)) return midi + d;
    if (inScale(midi - d, tonicPc, scale)) return midi - d;
  }
  return midi;
}

// --- chords -------------------------------------------------------------
export const CHORD_INTERVALS = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dom7: [0, 4, 7, 10],
  dim7: [0, 3, 6, 9],
  hdim7: [0, 3, 6, 10],
  minmaj7: [0, 3, 7, 11],
  maj6: [0, 4, 7, 9],
  min6: [0, 3, 7, 9],
  add9: [0, 4, 7, 14],
  min9: [0, 3, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14],
  dom9: [0, 4, 7, 10, 14],
  min11: [0, 3, 7, 10, 14, 17],
  sus2add9: [0, 2, 7, 14],
};

export const CHORD_SYMBOL = {
  maj: '', min: 'm', dim: 'dim', aug: 'aug', sus2: 'sus2', sus4: 'sus4',
  maj7: 'maj7', min7: 'm7', dom7: '7', dim7: 'dim7', hdim7: 'm7b5',
  minmaj7: 'mMaj7', maj6: '6', min6: 'm6', add9: 'add9', min9: 'm9',
  maj9: 'maj9', dom9: '9', min11: 'm11', sus2add9: 'sus2add9',
};

// classify a set of intervals above the root into a quality name
export function classifyTriad(third, fifth, seventh) {
  const tri = `${third},${fifth}`;
  if (tri === '4,7') {
    if (seventh === 11) return 'maj7';
    if (seventh === 10) return 'dom7';
    if (seventh === 14) return 'add9';
    return 'maj';
  }
  if (tri === '3,7') {
    if (seventh === 10) return 'min7';
    if (seventh === 11) return 'minmaj7';
    return 'min';
  }
  if (tri === '3,6') {
    if (seventh === 10) return 'hdim7';
    if (seventh === 9) return 'dim7';
    return 'dim';
  }
  if (tri === '4,8') return 'aug';
  if (tri === '2,7') return 'sus2';
  if (tri === '5,7') return 'sus4';
  return 'maj';
}

// diatonic chord on `degree` (0..6) of the harmony scale
export function diatonicChord(tonicPc, scaleName, degree, withSeventh = false) {
  const hs = harmonyScaleOf(scaleName);
  const n = hs.length;
  const s = (i) => hs[((i % n) + n) % n] + 12 * Math.floor(i / n);
  const root = s(degree);
  const third = s(degree + 2) - root;
  const fifth = s(degree + 4) - root;
  const seventh = withSeventh ? s(degree + 6) - root : null;
  const quality = withSeventh ? classifyTriad(third, fifth, seventh) : classifyTriad(third, fifth, null);
  return { degree, rootPc: (tonicPc + root) % 12, quality, intervals: CHORD_INTERVALS[quality] };
}

export function chordPcs(chord) {
  const iv = CHORD_INTERVALS[chord.quality] || CHORD_INTERVALS.maj;
  return iv.map((i) => (chord.rootPc + i) % 12);
}

export function chordSymbol(chord, flats = false) {
  const name = (flats ? NOTE_NAMES_FLAT : NOTE_NAMES)[chord.rootPc % 12];
  return name + (CHORD_SYMBOL[chord.quality] ?? '');
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
export function romanNumeral(chord) {
  const base = ROMAN[chord.degree % 7] || 'I';
  const q = chord.quality;
  const minorish = q.startsWith('min') || q === 'dim' || q === 'dim7' || q === 'hdim7';
  let r = minorish ? base.toLowerCase() : base;
  if (q === 'dim' || q === 'dim7') r += '\u00b0';
  if (q === 'hdim7') r += '\u00f8';
  if (q === 'aug') r += '+';
  if (q === 'dom7' || q === 'dom9') r += '7';
  if (q === 'maj7') r += 'maj7';
  if (q === 'min7' || q === 'min9' || q === 'min11') r += '7';
  return r;
}

// --- voice leading ------------------------------------------------------
// cost of moving from voicing A to voicing B (both sorted midi arrays)
export function voiceLeadingCost(a, b) {
  if (!a || !a.length || !b || !b.length) return 0;
  let motion = 0;
  const n = Math.max(a.length, b.length);
  const A = padTo(a, n);
  const B = padTo(b, n);
  for (let i = 0; i < n; i++) motion += Math.abs(B[i] - A[i]);
  let penalty = 0;
  const m = Math.min(a.length, b.length);
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      const ia = Math.abs(a[j] - a[i]);
      const ib = Math.abs(b[j] - b[i]);
      if (ia === ib) {
        if (ia % 12 === 0) penalty += 24; // parallel octaves
        else if (ia % 12 === 7) penalty += 12; // parallel fifths
      }
    }
  }
  return motion + penalty;
}

function padTo(arr, n) {
  const out = arr.slice();
  while (out.length < n) out.push(out.length ? out[out.length - 1] : 60);
  return out.sort((x, y) => x - y);
}

// --- validation ---------------------------------------------------------
export function intervalBetween(a, b) { return Math.abs(b - a) % 12; }
