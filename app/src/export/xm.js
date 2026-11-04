// Extended Module (.xm) writer.
//
// A module file is the one portable format that carries the song *and* its
// instruments: a few KB, plays in OpenMPT, VLC, MilkyTracker, or any tracker
// from the last thirty years. A WAV keeps the sound and loses the editability;
// a MIDI keeps the notes and loses the timbre. This keeps both, and stays small
// enough to email.
//
// Written from the format specification (the XM layout is public and stable),
// not from any tracker's source — MilkyTracker and friends are GPL-family and
// this app is not.
//
// There are no samples in MusicGen, so the instruments are generated: one
// single-cycle waveform per pitched track, built from the harmonic series of
// the song's synthesis technology, and one short percussive sample per drum
// voice. A 32-sample cycle played at the module's fixed 8363 Hz is very nearly
// C-4, which is why 32 is the length.
import { TRACK_NAMES } from '../audio/graph.js';

const MODULE_RATE = 8363; // Hz, the fixed playback rate of note C-4 in a module
const CYCLE = 32;         // samples in one cycle: 8363 / 32 = 261.3 Hz ~= C-4
const ROWS_PER_PATTERN = 64;
const ROWS_PER_BEAT = 4;  // sixteenth-note resolution
// A tracker channel carries one note at a time, so a polyphonic track needs
// more than one: a four-note chord voicing on a single channel would lose three
// notes of every four. The pools below are sized to what the composer actually
// writes — four-voice chords, three-voice pads, a doubled lead.
const CHANNEL_PLAN = [
  ['drums', [0, 1, 2]],       // a kick and a hat on the same sixteenth is normal
  ['bass', [3]],
  ['chords', [4, 5, 6, 7]],   // four-voice voicings
  ['lead', [8, 9]],           // the doubling adds a second note
  ['pad', [10, 11, 12]],
  ['arp', [13]],
];
const CHANNELS = 14;
const PITCHED = ['bass', 'chords', 'lead', 'pad', 'arp'];

// How bright each engine's waveform is. A chiptune is a pulse, an additive pad
// is a stack of partials, noise has almost no pitch at all.
const HARMONICS = {
  none: 1, analog: 7, fm: 5, chiptune: 4, additive: 10,
  wavetable: 7, physical: 3, noise: 2,
};

const DRUM_VOICES = ['kick', 'snare', 'hat', 'clap', 'tom'];

// ---------------------------------------------------------------- helpers
function ascii(s, len) {
  const out = new Array(len).fill(0);
  const str = String(s ?? '');
  for (let i = 0; i < Math.min(len, str.length); i++) out[i] = str.charCodeAt(i) & 0x7f;
  return out;
}

const u8 = (n) => [n & 0xff];
const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];
const u32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
const i8 = (n) => [n < 0 ? (n + 256) & 0xff : n & 0xff];

// A single cycle of a harmonic series. Deterministic, and cheap: 32 samples per
// instrument is the whole cost of the timbre.
export function cycleWave(harmonics = 7, shape = 0) {
  const out = new Float32Array(CYCLE);
  let peak = 0;
  for (let i = 0; i < CYCLE; i++) {
    const t = (i / CYCLE) * Math.PI * 2;
    let v = 0;
    for (let h = 1; h <= harmonics; h++) {
      // 1/h rolloff, with a little phase spread so it is not a pure saw
      v += Math.sin(t * h + h * shape) / h;
    }
    out[i] = v;
    peak = Math.max(peak, Math.abs(v));
  }
  if (peak > 0) for (let i = 0; i < CYCLE; i++) out[i] = (out[i] / peak) * 0.82;
  return out;
}

// Percussion: a pitch-dropping sine for the drums with a body, filtered noise
// for the ones without. All at the module's fixed rate, so a C-4 note plays
// them at the length they were built for.
export function drumSample(voice) {
  const rate = MODULE_RATE;
  const noise = (() => {
    let s = 0x2f6e2b1;
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return (s / 0x7fffffff) * 2 - 1;
    };
  })();

  const specs = {
    kick: { len: 0.14, tone: [150, 45], noise: 0.02, decay: 26 },
    snare: { len: 0.10, tone: [190, 170], noise: 0.85, decay: 34 },
    hat: { len: 0.045, tone: [0, 0], noise: 1, decay: 90 },
    clap: { len: 0.09, tone: [0, 0], noise: 1, decay: 30 },
    tom: { len: 0.12, tone: [200, 130], noise: 0.06, decay: 24 },
  };
  const spec = specs[voice] || specs.hat;
  const n = Math.max(8, Math.round(rate * spec.len));
  const out = new Float32Array(n);
  let phase = 0;
  let hp = 0;
  for (let i = 0; i < n; i++) {
    const p = i / n;
    const env = Math.exp(-p * spec.decay);
    let v = 0;
    if (spec.tone[0] > 0) {
      const f = spec.tone[0] + (spec.tone[1] - spec.tone[0]) * p;
      phase += (Math.PI * 2 * f) / rate;
      v += Math.sin(phase) * (1 - spec.noise);
    }
    if (spec.noise > 0) {
      // a one-pole difference is enough of a high-pass to make a hat a hat
      const raw = noise();
      hp = raw - hp * 0.35;
      v += hp * spec.noise * 0.7;
    }
    out[i] = Math.max(-1, Math.min(1, v * env)) * 0.9;
  }
  return out;
}

// XM stores samples delta-encoded: each byte is the change from the last.
function delta8(samples) {
  const out = new Array(samples.length);
  let last = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-128, Math.min(127, Math.round(samples[i] * 127)));
    out[i] = (v - last) & 0xff;
    last = v;
  }
  return out;
}

function sampleHeader({ name, length, loopStart, loopLength, loop = true, volume = 64, relNote = 0, finetune = 0 }) {
  return [
    ...u32(length),
    ...u32(loopStart),
    ...u32(loopLength),
    ...u8(volume),
    ...i8(finetune),
    ...u8(loop ? 0x01 : 0x00), // bit 0-1: forward loop
    ...u8(128),                 // panning: centre
    ...i8(relNote),
    ...u8(0),
    ...ascii(name, 22),
  ];
}

function instrument({ name, samples }) {
  const body = [
    ...ascii(name, 22),
    ...u8(0),                      // type: none
    ...u16(samples.length),
  ];
  if (!samples.length) return [...u32(29), ...body];

  const head = [
    ...u32(263),                   // instrument header size
    ...body,
    ...u32(40),                    // sample header size
    ...new Array(96).fill(0),      // keymap: every key maps to sample 0
    // volume envelope: a gentle decay, on, so notes taper instead of cutting
    ...u8(0), ...u8(64),
    ...u8(16), ...u8(54),
    ...u8(40), ...u8(44),
    ...new Array(42).fill(0),      // rest of the 48-byte volume envelope
    ...new Array(48).fill(0),      // panning envelope
    ...u8(3), ...u8(0),            // 3 volume points, 0 panning points
    ...u8(0), ...u8(0),            // volume sustain point, loop start
    ...u8(0), ...u8(0),            // volume loop end, panning sustain
    ...u8(0), ...u8(0),            // panning loop start/end
    ...u8(1), ...u8(0),            // volume type: on. panning type: off
    ...u8(0), ...u8(0), ...u8(0), ...u8(0), // vibrato: none
    ...u16(512),                   // fadeout, so key-off fades rather than cuts
    ...new Array(22).fill(0),
  ];
  const headers = samples.flatMap((s) => sampleHeader(s));
  const data = samples.flatMap((s) => delta8(s.data));
  return [...head, ...headers, ...data];
}

// ---------------------------------------------------------------- the song
// Notes per channel, bucketed by the row they start on. Notes are placed
// first and key-offs second, so a note that starts where another ends wins the
// row — otherwise a short note's release could swallow the next note's attack.
function channelRows(song) {
  const totalRows = Math.ceil(song.bars * song.beatsPerBar * ROWS_PER_BEAT);
  const rows = new Map();

  const free = (row, pool) => {
    const at = rows.get(row);
    return pool.find((ch) => !at?.has(ch));
  };
  const put = (row, ch, cell) => {
    if (row < 0 || row >= totalRows || ch == null) return false;
    let at = rows.get(row);
    if (!at) { at = new Map(); rows.set(row, at); }
    at.set(ch, cell);
    return true;
  };

  const poolOf = Object.fromEntries(CHANNEL_PLAN);

  // pass 1: the notes
  const pending = [];
  for (const track of PITCHED) {
    const pool = poolOf[track];
    const instrument = PITCHED.indexOf(track) + 1;
    for (const n of song.tracks[track] || []) {
      const row = Math.round(n.t * ROWS_PER_BEAT);
      const ch = free(row, pool);
      if (ch == null) continue; // the pool is full on this row; drop, do not smear
      const note = Math.max(1, Math.min(96, Math.round(n.p) - 11));
      put(row, ch, {
        note,
        instrument,
        volume: Math.max(0, Math.min(64, Math.round((n.v ?? 0.7) * 64))),
      });
      pending.push({
        row: row + Math.max(1, Math.round((n.d ?? 0.25) * ROWS_PER_BEAT)),
        ch,
      });
    }
  }
  for (const n of song.tracks.drums || []) {
    const voice = DRUM_VOICES.indexOf(n.drum);
    if (voice < 0) continue;
    const row = Math.round(n.t * ROWS_PER_BEAT);
    const ch = free(row, poolOf.drums);
    if (ch == null) continue;
    put(row, ch, {
      note: 49,                    // C-4: the rate the drum samples were built for
      instrument: 6 + voice,       // instruments 6..10 are the drum voices
      volume: Math.max(0, Math.min(64, Math.round((n.v ?? 0.7) * 64))),
    });
  }

  // pass 2: the releases
  for (const k of pending) {
    const at = rows.get(k.row);
    if (at?.has(k.ch)) continue;
    put(k.row, k.ch, { note: 97, instrument: 0, volume: 0 });
  }

  return { rows, totalRows };
}

export function songToXm(song, { name = null } = {}) {
  const title = (name || song.title || 'MusicGen').slice(0, 20);
  const { rows, totalRows } = channelRows(song);
  const patternCount = Math.max(1, Math.ceil(totalRows / ROWS_PER_PATTERN));

  // ---- patterns
  const patterns = [];
  for (let p = 0; p < patternCount; p++) {
    const cells = [];
    for (let r = 0; r < ROWS_PER_PATTERN; r++) {
      const row = p * ROWS_PER_PATTERN + r;
      const at = rows.get(row);
      for (let ch = 0; ch < CHANNELS; ch++) {
        const c = at?.get(ch);
        // Packed cells: an empty cell is one byte (0x80) instead of five. Most
        // of a pattern is silence, and this is the difference between a 66 KB
        // file and a 20 KB one.
        if (!c) { cells.push(0x80); continue; }
        cells.push(c.note & 0xff, c.instrument & 0xff, c.volume & 0xff, 0, 0);
      }
    }
    patterns.push([
      ...u32(9),                    // pattern header size
      ...u8(0),                     // packing type: cells may be packed
      ...u16(ROWS_PER_PATTERN),
      ...u16(cells.length),
      ...cells,
    ]);
  }

  // ---- instruments: five pitched, then the drum voices
  const harmonics = HARMONICS[song.tech] ?? 7;
  const pitched = ['bass', 'chords', 'lead', 'pad', 'arp'].map((track, i) => {
    const wave = cycleWave(Math.max(1, harmonics - i), i * 0.6);
    // a 32-sample cycle at 8363 Hz is 261.34 Hz against C-4's 261.63: a shade
    // flat, so nudge it up by the couple of cents a finetune step can express
    const cents = 1200 * Math.log2(261.6256 / (MODULE_RATE / CYCLE));
    const finetune = Math.max(-128, Math.min(127, Math.round((cents * 128) / 100)));
    return instrument({
      name: track,
      samples: [{
        name: track,
        data: wave,
        length: CYCLE,
        loopStart: 0,
        loopLength: CYCLE,
        loop: true,
        relNote: 0,
        finetune,
      }],
    });
  });

  const drums = DRUM_VOICES.map((voice) => {
    const data = drumSample(voice);
    return instrument({
      name: voice,
      samples: [{
        name: voice,
        data,
        length: data.length,
        loopStart: 0,
        loopLength: 0,
        loop: false,
        relNote: 0,
        finetune: 0,
      }],
    });
  });

  const instruments = [...pitched, ...drums];
  const orders = Array.from({ length: patternCount }, (_, i) => i);

  const header = [
    ...ascii('Extended Module: ', 17),
    ...ascii(title, 20),
    ...u8(0x1a),
    ...ascii('MusicGen', 20),
    ...u16(0x0104),                  // version 1.04
    ...u32(276),                     // header size
    ...u16(orders.length),
    ...u16(0),                       // restart position
    ...u16(CHANNELS),
    ...u16(patternCount),
    ...u16(instruments.length),
    ...u16(1),                       // flags: linear frequency table
    ...u16(6),                       // default ticks per row
    ...u16(Math.max(32, Math.min(255, Math.round(song.bpm || 125)))),
    ...orders,
    ...new Array(Math.max(0, 256 - orders.length)).fill(0),
  ];

  const bytes = [...header, ...patterns.flat(), ...instruments.flat()];
  return new Uint8Array(bytes);
}
