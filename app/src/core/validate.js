// Music theory validator. Used by tests and by the QA matrix page.
import { scalePcs, pc, scaleOf } from './theory.js';

const DRUM_KINDS = {
  kick: 1, snare: 1, hat: 1, openhat: 1, clap: 1, tom: 1, rim: 1,
  shaker: 1, ride: 1, crash: 1, conga: 1, timpani: 1, cowbell: 1,
};

export function barOf(song, t) {
  // epsilon absorbs humanise jitter around the bar line
  return Math.max(0, Math.floor((t + 0.05) / song.beatsPerBar));
}

function chordPcsOf(ch) {
  return ch.pcs || (ch.voicing ? ch.voicing.map((v) => pc(v)) : []);
}

export function sectionAt(song, t) {
  const bar = barOf(song, t);
  return song.sections.find((s) => bar >= s.bar && bar < s.bar + s.bars) || null;
}

export function chordAt(song, t) {
  const sec = sectionAt(song, t);
  if (!sec) return null;
  const bar = barOf(song, t);
  return sec.chords.find((c) => c.bar === bar) || sec.chords[0] || null;
}

// A pitch is legal if it is in the key, or a tone of the chord sounding at
// that moment (modal interchange / chromatic chords are intentional).
export function scaleSetAt(song, t) {
  const sec = sectionAt(song, t);
  const key = sec?.key || song.key;
  return scalePcs(key.tonic, scaleOf(key.mode));
}

export function isLegalPitch(song, t, midi, scaleSet) {
  const set = scaleSet || scaleSetAt(song, t);
  if (set.includes(pc(midi))) return true;
  // a note on a bar line belongs to the chord either side of it
  for (const tt of [t, t - 0.51, t + 0.51]) {
    const ch = chordAt(song, tt);
    if (ch && chordPcsOf(ch).includes(pc(midi))) return true;
    const local = scaleSetAt(song, tt);
    if (local.includes(pc(midi))) return true;
  }
  return false;
}

export function validateSong(song, opts = {}) {
  const issues = [];
  const { strict = false } = opts;
  const scaleSet = scalePcs(song.key.tonic, scaleOf(song.key.mode));
  const setCache = new Map();
  const isJazzOrClassical = ['jazz', 'classical'].includes(song.style);
  const totalBeats = song.bars * song.beatsPerBar;

  for (const [name, notes] of Object.entries(song.tracks)) {
    if (!notes.length) continue;
    let illegal = 0;
    for (const n of notes) {
      if (name === 'drums') {
        if (!(n.drum in DRUM_KINDS)) issues.push(`${name}: unknown drum ${n.drum}`);
        if (!(n.t >= -0.05)) issues.push(`${name}: negative onset`);
        continue;
      }
      if (n.t < -0.05) issues.push(`${name}: note before song start (${n.t.toFixed(3)})`);
      if (n.t > totalBeats + 0.5) issues.push(`${name}: note after song end`);
      if (!(n.d > 0)) issues.push(`${name}: non-positive duration`);
      if (n.p < 21 || n.p > 108) issues.push(`${name}: pitch out of MIDI range (${n.p})`);
      if (!isLegalPitch(song, n.t, n.p, null)) illegal++;
    }
    const ratio = illegal / Math.max(1, notes.length);
    if (ratio > 0.02) issues.push(`${name}: ${(ratio * 100).toFixed(1)}% notes outside key and chord`);
  }

  const range = (track, lo, hi, label) => {
    for (const n of song.tracks[track] || []) {
      if (n.p < lo || n.p > hi) { issues.push(`${label} out of range: ${n.p}`); break; }
    }
  };
  range('bass', 24, 62, 'bass');
  range('lead', 46, 96, 'lead');

  // every chord-track note must belong to the chord sounding under it
  let bad = 0;
  for (const n of song.tracks.chords || []) {
    const ch = chordAt(song, n.t);
    if (!ch) continue;
    if (!chordPcsOf(ch).includes(pc(n.p))) bad++;
  }
  if (bad > 0) issues.push(`chords: ${bad} notes are not tones of the chord under them`);

  // the bass should not teleport: a leap of more than an octave between
  // consecutive notes is a mistake in every style, not just jazz
  // (walking and pedal bass in jazz/classical cross registers on purpose)
  if (!isJazzOrClassical) {
    const bassNotes = song.tracks.bass || [];
    let leaps = 0;
    for (let i = 1; i < bassNotes.length; i++) {
      if (Math.abs(bassNotes[i].p - bassNotes[i - 1].p) > 15) leaps++;
    }
    if (bassNotes.length > 8 && leaps / bassNotes.length > 0.25) {
      issues.push(`bass: ${leaps} leaps larger than a tenth`);
    }
  }

  // parallel fifths / octaves between bass and the chord top voice
  if (isJazzOrClassical) {
    const bass = song.tracks.bass || [];
    const chords = song.tracks.chords || [];
    let parallels = 0;
    for (let i = 1; i < bass.length; i++) {
      const b0 = bass[i - 1], b1 = bass[i];
      const c0 = nearestNote(chords, b0.t), c1 = nearestNote(chords, b1.t);
      if (c0 == null || c1 == null) continue;
      const i0 = Math.abs(c0 - b0.p) % 12, i1 = Math.abs(c1 - b1.p) % 12;
      if (i0 === i1 && (i0 === 7 || i0 === 0) && b1.p !== b0.p) parallels++;
    }
    if (parallels > bass.length * 0.25) issues.push(`${parallels} parallel fifths/octaves between bass and chords`);
  }

  if (strict && !(song.tracks.lead || []).length) issues.push('lead: empty');

  return { ok: issues.length === 0, issues };
}

function nearestNote(notes, t) {
  let best = null, bd = 0.3;
  for (const n of notes) {
    const d = Math.abs(n.t - t);
    if (d < bd) { bd = d; best = n.p; }
  }
  return best;
}
