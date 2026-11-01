// Canvas visualisations: piano roll, spectrum bars, waveform, generative art.
// Colours come from the CSS theme tokens, so every mode re-themes with the UI.

let palCache = { key: null, pal: null };

export function invalidatePalette() { palCache.key = null; }

function parseRgb(str) {
  const m = String(str).match(/rgba?\(([^)]+)\)/);
  if (!m) return [0, 0, 0];
  const parts = m[1].split(',').map((v) => parseFloat(v));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

export function themePalette() {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const key = `${root.dataset.theme || 'system'}|${cs.getPropertyValue('--bg').trim()}`;
  if (palCache.key === key) return palCache.pal;

  const g = (name, fallback = '#888888') => (cs.getPropertyValue(name).trim() || fallback);
  // body has a gradient background, so backgroundColor is transparent —
  // the theme declares its own lightness instead of us guessing
  const isLight = g('--is-light', '0') === '1';
  const bodyBg = parseRgb(getComputedStyle(document.body).backgroundColor);
  const bgRgb = isLight ? [242, 244, 250] : [7, 8, 15];

  const pal = {
    lead: g('--viz-lead', '#8b9dff'),
    chords: g('--viz-chords', '#4fbfa5'),
    bass: g('--viz-bass', '#ff8a5c'),
    pad: g('--viz-pad', '#a97bff'),
    arp: g('--viz-arp', '#ffd166'),
    drums: g('--viz-drums', '#5c6a8c'),
    grid: g('--viz-grid', 'rgba(150,165,200,0.16)'),
    label: g('--viz-label', 'rgba(150,165,200,0.75)'),
    playhead: g('--viz-playhead', '#ff6f9c'),
    band: g('--viz-band', 'rgba(127,155,255,0.06)'),
    accent: g('--accent', '#8b9dff'),
    accent2: g('--accent-2', '#ff6f9c'),
    accent3: g('--accent-3', '#5fe3c0'),
    bg: bgRgb,
    isLight,
  };
  palCache = { key, pal };
  return pal;
}

export function fitCanvas(canvas) {
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { w, h, dpr };
}

// Analyser buffers are reused across frames — allocating 2048 bytes 30 times a
// second is avoidable garbage.
const bufferCache = new WeakMap();
function analyserBuffer(analyser, kind) {
  let m = bufferCache.get(analyser);
  if (!m) { m = {}; bufferCache.set(analyser, m); }
  const size = kind === 'time' ? analyser.fftSize : analyser.frequencyBinCount;
  if (!m[kind] || m[kind].length !== size) m[kind] = new Uint8Array(size);
  return m[kind];
}

const DRUM_LANE = { kick: 0.9, snare: 0.7, hat: 0.5, clap: 0.65, tom: 0.6, rim: 0.45, shaker: 0.35 };

// ---------------------------------------------------------------- piano roll
export function drawPianoRoll(canvas, song, positionSec = 0, view = null) {
  const { w, h, dpr } = fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const pal = themePalette();
  ctx.clearRect(0, 0, w, h);
  if (!song) return;

  const totalBeats = song.bars * song.beatsPerBar;
  const spb = 60 / song.bpm;
  const posBeat = positionSec / spb;
  const viewBeats = Math.max(4, Math.min(totalBeats, view?.span ?? 32));
  const startBeat = view
    ? Math.max(0, Math.min(Math.max(0, totalBeats - viewBeats), view.start))
    : Math.max(0, Math.min(totalBeats - viewBeats, posBeat - viewBeats * 0.35));
  const xOf = (beat) => ((beat - startBeat) / viewBeats) * w;

  const mel = ['lead', 'chords', 'bass', 'pad', 'arp'];
  const pitches = [];
  for (const t of mel) for (const n of song.tracks[t] || []) pitches.push(n.p);
  let lo = 36, hi = 88;
  if (pitches.length) {
    pitches.sort((a, b) => a - b);
    lo = Math.max(21, pitches[Math.floor(pitches.length * 0.02)] - 2);
    hi = Math.min(108, pitches[Math.floor(pitches.length * 0.98)] + 2);
  }
  const laneTop = 8 * dpr;
  const laneH = h - 26 * dpr;
  const yOf = (p) => laneTop + laneH - ((p - lo) / Math.max(1, hi - lo)) * laneH;

  // section band behind everything
  const sec = song.sections.find((s) => posBeat >= s.bar * song.beatsPerBar && posBeat < (s.bar + s.bars) * song.beatsPerBar);
  if (sec) {
    const x0 = Math.max(0, xOf(sec.bar * song.beatsPerBar));
    const x1 = Math.min(w, xOf((sec.bar + sec.bars) * song.beatsPerBar));
    ctx.fillStyle = pal.band;
    ctx.fillRect(x0, 0, Math.max(0, x1 - x0), h);
  }

  // bar lines
  ctx.strokeStyle = pal.grid;
  ctx.lineWidth = 1;
  for (let b = Math.ceil(startBeat / song.beatsPerBar) * song.beatsPerBar; b < startBeat + viewBeats; b += song.beatsPerBar) {
    ctx.beginPath();
    ctx.moveTo(xOf(b), 0);
    ctx.lineTo(xOf(b), h - 22 * dpr);
    ctx.stroke();
  }

  // chord labels
  ctx.fillStyle = pal.label;
  ctx.font = `${9 * dpr}px ui-monospace, monospace`;
  for (const s of song.sections) {
    for (const ch of s.chords) {
      const x = xOf(ch.bar * song.beatsPerBar);
      // keep clear of the visualiser-mode pills in the top-right corner
      if (x > w - 200 * dpr) continue;
      if (x > -40 && x < w) ctx.fillText(ch.symbol, x + 2 * dpr, 10 * dpr);
    }
  }

  // notes
  for (const track of mel) {
    const notes = song.tracks[track] || [];
    ctx.fillStyle = pal[track] || pal.lead;
    for (const n of notes) {
      if (n.t + n.d < startBeat || n.t > startBeat + viewBeats) continue;
      const x = xOf(n.t);
      const wid = Math.max(1.5 * dpr, (n.d / viewBeats) * w);
      const nh = Math.max(2 * dpr, laneH / Math.max(8, hi - lo));
      ctx.globalAlpha = track === 'pad' ? 0.38 : 0.88;
      ctx.fillRect(x, yOf(n.p), wid, nh);
    }
  }
  ctx.globalAlpha = 1;

  // drum lane
  const drumTop = h - 22 * dpr;
  for (const n of song.tracks.drums || []) {
    if (n.t + n.d < startBeat || n.t > startBeat + viewBeats) continue;
    const lvl = DRUM_LANE[n.drum] ?? 0.4;
    ctx.fillStyle = pal.drums;
    ctx.globalAlpha = 0.35 + lvl * 0.6;
    const bh = 20 * dpr * lvl;
    ctx.fillRect(xOf(n.t), drumTop + (20 * dpr - bh), Math.max(1.5 * dpr, 2 * dpr), bh);
  }
  ctx.globalAlpha = 1;

  // playhead
  const px = xOf(posBeat);
  ctx.strokeStyle = pal.playhead;
  ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath();
  ctx.moveTo(px, 0);
  ctx.lineTo(px, h);
  ctx.stroke();
}

// ---------------------------------------------------------------- bars
export function drawBars(canvas, analyser) {
  const { w, h, dpr } = fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const pal = themePalette();
  ctx.clearRect(0, 0, w, h);
  if (!analyser) return;
  const bins = analyserBuffer(analyser, 'freq');
  analyser.getByteFrequencyData(bins);
  const bars = Math.min(64, Math.floor(w / (5 * dpr)));
  const step = Math.max(1, Math.floor(bins.length / bars));
  for (let i = 0; i < bars; i++) {
    let sum = 0;
    for (let j = 0; j < step; j++) sum += bins[i * step + j] || 0;
    const v = sum / step / 255;
    const bh = Math.max(1.5 * dpr, v * h * 0.92);
    // dark theme: brightening with level. light theme: darkening.
    const lightness = pal.isLight ? 62 - v * 34 : 45 + v * 25;
    const hue = 225 - v * 95;
    ctx.fillStyle = `hsl(${hue} 78% ${lightness}%)`;
    ctx.fillRect(i * (w / bars) + dpr, h - bh, (w / bars) - 2 * dpr, bh);
  }
}

// ---------------------------------------------------------------- waveform
export function drawWaveform(canvas, analyser) {
  const { w, h, dpr } = fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const pal = themePalette();
  ctx.clearRect(0, 0, w, h);
  if (!analyser) return;
  const bins = analyserBuffer(analyser, 'time');
  analyser.getByteTimeDomainData(bins);

  const mid = h / 2;
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, pal.accent);
  grad.addColorStop(0.5, pal.accent3);
  grad.addColorStop(1, pal.accent2);

  for (const [scale, alpha] of [[1, 0.18], [0.55, 0.35], [1, 1]]) {
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const i = Math.floor((x / w) * bins.length);
      const v = (bins[i] - 128) / 128;
      const y = mid + v * (h / 2 - 6 * dpr) * scale;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = grad;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = (scale === 1 && alpha === 1 ? 1.8 : 3.4) * dpr;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = pal.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.stroke();
}

// ------------------------------------------------- generative reactive art
const artState = new WeakMap();

export function drawArt(canvas, song, analyser, now = 0) {
  const { w, h, dpr } = fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const pal = themePalette();
  if (!song) return;

  let st = artState.get(canvas);
  if (!st || st.seed !== song.seed) {
    let s = 0x9e3779b9;
    for (let i = 0; i < song.seed.length; i++) s = (Math.imul(s, 31) + song.seed.charCodeAt(i)) >>> 0;
    const rand = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    st = {
      seed: song.seed,
      parts: Array.from({ length: 120 }, () => ({
        x: rand(), y: rand(), r: 0.4 + rand() * 1.8, sp: 0.2 + rand() * 0.8, hue: rand(),
      })),
    };
    artState.set(canvas, st);
  }

  let level = 0;
  if (analyser) {
    const bins = analyserBuffer(analyser, 'freq');
    analyser.getByteFrequencyData(bins);
    let sum = 0;
    for (let i = 0; i < bins.length; i++) sum += bins[i];
    level = sum / bins.length / 255;
  }

  // trailing fade in the theme's own background colour
  const [r, g, b] = pal.bg;
  ctx.fillStyle = `rgba(${r},${g},${b},${pal.isLight ? 0.34 : 0.28})`;
  ctx.fillRect(0, 0, w, h);

  const theme = song.palette || ['#0b1026', '#1b2a5e', '#5f7bd9', '#c9d6ff'];
  const t = now / 1000;
  for (const p of st.parts) {
    p.y += p.sp * 0.0006 * (0.4 + level * 4);
    if (p.y > 1.05) { p.y = -0.05; p.x = (p.x + 0.37) % 1; }
    const x = (p.x + Math.sin(t * 0.4 + p.hue * 6.28) * 0.02) * w;
    const y = p.y * h;
    const radius = Math.max(0.6, (p.r + level * 3) * dpr * 2.2);
    const col = theme[1 + Math.floor(p.hue * (theme.length - 2))] || theme[2];
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.globalAlpha = (pal.isLight ? 0.18 : 0.25) + level * 0.6;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}


// Beat under a canvas x position, for scrub and zoom gestures.
export function beatAtX(canvas, song, x, view = null) {
  if (!song) return 0;
  const rect = canvas.getBoundingClientRect();
  const totalBeats = song.bars * song.beatsPerBar;
  const span = Math.max(4, Math.min(totalBeats, view?.span ?? 32));
  const start = view ? Math.max(0, Math.min(Math.max(0, totalBeats - span), view.start)) : 0;
  const rel = Math.max(0, Math.min(1, (x - rect.left) / Math.max(1, rect.width)));
  return start + rel * span;
}


// Which note is under a pointer, using the same layout as drawPianoRoll.
export function noteAt(canvas, song, clientX, clientY, view = null) {
  if (!song) return null;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const w = rect.width * dpr;
  const h = rect.height * dpr;
  const x = (clientX - rect.left) * dpr;
  const y = (clientY - rect.top) * dpr;

  const totalBeats = song.bars * song.beatsPerBar;
  const span = Math.max(4, Math.min(totalBeats, view?.span ?? 32));
  const start = view ? Math.max(0, Math.min(Math.max(0, totalBeats - span), view.start)) : 0;
  const beat = start + (x / Math.max(1, w)) * span;

  const mel = ['lead', 'chords', 'bass', 'pad', 'arp'];
  const pitches = [];
  for (const t of mel) for (const n of song.tracks[t] || []) pitches.push(n.p);
  let lo = 36, hi = 88;
  if (pitches.length) {
    pitches.sort((a, b) => a - b);
    lo = Math.max(21, pitches[Math.floor(pitches.length * 0.02)] - 2);
    hi = Math.min(108, pitches[Math.floor(pitches.length * 0.98)] + 2);
  }
  const laneTop = 8 * dpr;
  const laneH = h - 26 * dpr;
  const pitch = lo + ((laneTop + laneH - y) / Math.max(1, laneH)) * (hi - lo);
  const tolBeats = (6 / Math.max(1, w)) * span;
  const tolPitch = ((hi - lo) / Math.max(1, laneH)) * 8 * dpr;

  let best = null;
  let bestScore = Infinity;
  for (const track of mel) {
    for (const n of song.tracks[track] || []) {
      if (beat < n.t - tolBeats || beat > n.t + n.d + tolBeats) continue;
      if (Math.abs(n.p - pitch) > tolPitch) continue;
      const score = Math.abs(n.p - pitch) + Math.abs(beat - (n.t + n.d / 2));
      if (score < bestScore) { bestScore = score; best = { ...n, track }; }
    }
  }
  return best;
}
