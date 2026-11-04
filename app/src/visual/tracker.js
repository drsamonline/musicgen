// A tracker view: the song as a grid of rows and columns, the way a tracker
// shows it. Not a piano roll with different paint — a different reading of the
// same music. A roll answers "what is the melody doing"; this answers "what
// lands on the sixteenth", which is the question drums ask.
//
// The layout is computed by pure functions so it can be tested without a
// canvas; drawTracker() only paints what they return.
import { makeTempoMap, DEFAULT_DRIFT } from '../core/tempo.js';

export const TRACK_COLUMNS = ['drums', 'bass', 'chords', 'lead'];
export const STEPS_PER_BEAT = 4;

const NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];

// A drum has no pitch — it has a voice. Writing "C-2" for a kick would be a
// lie the rest of the app does not tell.
const DRUM_TAG = {
  kick: 'kck', snare: 'snr', hat: 'hat', clap: 'clp',
  tom: 'tom', rim: 'rim', shaker: 'shk', crash: 'crs', ride: 'rid',
};

// 60 -> "C-4", 61 -> "C#4". Three characters, the way a tracker writes them,
// so a column of notes lines up.
export function noteLabel(midi) {
  const p = Math.round(Number(midi));
  if (!Number.isFinite(p)) return '···';
  const pc = ((p % 12) + 12) % 12;
  const oct = Math.floor(p / 12) - 1;
  return `${NAMES[pc]}${oct}`;
}

export function tempoMapOfSong(song) {
  if (song?.tempo?.segments?.length) {
    return makeTempoMap(song.tempo.segments, {
      base: song.tempo.base ?? song.bpm,
      drift: song.tempo.drift ?? DEFAULT_DRIFT,
    });
  }
  return makeTempoMap([{ beat: 0, bpm: song?.bpm || 100 }], { base: song?.bpm || 100, drift: 0 });
}

// Every note bucketed by the sixteenth it starts on. Built once per song —
// scanning 1,500 notes for every row of every frame would be the whole cost of
// the view.
const indexCache = new WeakMap();

export function buildStepIndex(song, stepsPerBeat = STEPS_PER_BEAT) {
  const hit = indexCache.get(song);
  if (hit && hit.stepsPerBeat === stepsPerBeat) return hit;

  const step = 1 / stepsPerBeat;
  const map = new Map();
  for (const col of TRACK_COLUMNS) {
    for (const n of song.tracks?.[col] || []) {
      const s = Math.round(n.t / step);
      let cell = map.get(s);
      if (!cell) { cell = {}; map.set(s, cell); }
      (cell[col] || (cell[col] = [])).push(n);
    }
  }
  const index = { map, step, stepsPerBeat, columns: TRACK_COLUMNS.slice() };
  indexCache.set(song, index);
  return index;
}

// What a cell says. Pitched tracks print the note; the drum column prints the
// voice, and marks a stack with a trailing + rather than silently dropping the
// second hit — a kick and a hat on the same sixteenth is the most common thing
// in the whole song.
export function cellLabel(col, notes) {
  if (!notes || !notes.length) return null;
  if (col === 'drums') {
    let best = notes[0];
    for (const n of notes) if ((n.v ?? 0) > (best.v ?? 0)) best = n;
    const tag = DRUM_TAG[best.drum] || 'dr·';
    return notes.length > 1 ? `${tag}+` : tag;
  }
  return noteLabel(notes[0].p);
}

// `count` rows starting at `firstStep`. A cell is the label of the first note
// that starts in that step, or null for silence — which is what the dots mean.
export function rowsFor(index, firstStep, count) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const s = firstStep + i;
    const cell = index.map.get(s);
    const cells = {};
    for (const col of index.columns) {
      cells[col] = cellLabel(col, cell?.[col]);
    }
    rows.push({ step: s, beat: s * index.step, cells });
  }
  return rows;
}

// The window of rows to show, scrolled so the row being heard sits a third of
// the way down rather than jumping a screen at a time.
export function windowFor(song, positionSec, visibleRows) {
  const map = tempoMapOfSong(song);
  const beat = map.beatAt(Math.max(0, positionSec));
  const current = Math.round(beat * STEPS_PER_BEAT);
  const lead = Math.max(1, Math.round(visibleRows * 0.34));
  const first = Math.max(0, current - lead);
  return { firstStep: first, currentStep: current, beat };
}

// ------------------------------------------------------------------ paint
export function drawTracker(canvas, song, positionSec = 0) {
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  if (!song) return;

  const cs = getComputedStyle(document.documentElement);
  const g = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  const pal = {
    grid: g('--viz-grid', 'rgba(150,165,200,0.16)'),
    label: g('--viz-label', 'rgba(150,165,200,0.75)'),
    playhead: g('--viz-playhead', '#ff6f9c'),
    band: g('--viz-band', 'rgba(127,155,255,0.06)'),
    drums: g('--viz-drums', '#5c6a8c'),
    bass: g('--viz-bass', '#ff8a5c'),
    chords: g('--viz-chords', '#4fbfa5'),
    lead: g('--viz-lead', '#8b9dff'),
    dim: g('--dim', '#6b7695'),
  };

  ctx.clearRect(0, 0, w, h);

  // The visualiser pills float over the top-right of the canvas. Over a
  // spectrum that is harmless; over a grid it hides the last column, so the
  // grid starts below them.
  const pillBand = Math.round(40 * dpr); // the pills are 36 CSS px tall including their inset
  const headerH = pillBand + Math.round(12 * dpr);
  const rowH = Math.max(Math.round(10 * dpr), Math.round((h - headerH) / 9));
  const visible = Math.max(1, Math.floor((h - headerH) / rowH));
  const { firstStep, currentStep } = windowFor(song, positionSec, visible);
  const index = buildStepIndex(song);
  const rows = rowsFor(index, firstStep, visible);

  const gutterW = Math.round(46 * dpr);
  const colW = Math.max(1, (w - gutterW) / TRACK_COLUMNS.length);
  const stepsPerBar = song.beatsPerBar * STEPS_PER_BEAT;

  const mono = Math.round(9.5 * dpr);
  ctx.textBaseline = 'middle';

  // header
  ctx.font = `600 ${Math.round(8.5 * dpr)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.fillStyle = pal.label;
  ctx.textAlign = 'left';
  const headY = headerH - Math.round(6 * dpr);
  ctx.fillText('BAR·BEAT', Math.round(4 * dpr), headY);
  TRACK_COLUMNS.forEach((col, i) => {
    ctx.fillStyle = pal[col] || pal.label;
    ctx.fillText(col.toUpperCase(), gutterW + i * colW + 6 * dpr, headY);
  });

  ctx.strokeStyle = pal.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, headerH + 0.5);
  ctx.lineTo(w, headerH + 0.5);
  ctx.stroke();

  ctx.font = `${mono}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  rows.forEach((row, i) => {
    const y = headerH + i * rowH;
    const isNow = row.step === currentStep;
    const isBarLine = ((row.step % stepsPerBar) + stepsPerBar) % stepsPerBar === 0;
    const isBeat = ((row.step % STEPS_PER_BEAT) + STEPS_PER_BEAT) % STEPS_PER_BEAT === 0;

    if (isNow) {
      ctx.fillStyle = pal.band;
      ctx.fillRect(0, y, w, rowH);
      ctx.fillStyle = pal.playhead;
      ctx.fillRect(0, y, Math.round(2 * dpr), rowH);
    }

    // gutter: 003.2.1 — bar, beat, sixteenth, one-based like a tracker
    const bar = Math.floor(row.step / stepsPerBar) + 1;
    const beat = Math.floor((row.step % stepsPerBar) / STEPS_PER_BEAT) + 1;
    const sub = (row.step % STEPS_PER_BEAT) + 1;
    ctx.textAlign = 'left';
    ctx.fillStyle = isBarLine ? pal.label : pal.dim;
    ctx.fillText(
      `${String(bar).padStart(3, '0')}.${beat}.${sub}`,
      Math.round(4 * dpr),
      y + rowH / 2,
    );

    TRACK_COLUMNS.forEach((col, ci) => {
      const x = gutterW + ci * colW + 6 * dpr;
      const label = row.cells[col];
      if (label) {
        ctx.fillStyle = pal[col] || pal.label;
        ctx.fillText(label, x, y + rowH / 2);
      } else {
        ctx.fillStyle = pal.dim;
        ctx.globalAlpha = 0.42;
        ctx.fillText('···', x, y + rowH / 2);
        ctx.globalAlpha = 1;
      }
    });

    if (isBarLine) {
      ctx.strokeStyle = pal.grid;
      ctx.beginPath();
      ctx.moveTo(0, y + rowH - 0.5);
      ctx.lineTo(w, y + rowH - 0.5);
      ctx.stroke();
    } else if (isBeat) {
      ctx.strokeStyle = pal.grid;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(gutterW, y + rowH - 0.5);
      ctx.lineTo(w, y + rowH - 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  });
}
