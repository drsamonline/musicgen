// Canvas visualisations: piano roll and frequency bars.

const TRACK_COLOR = {
  lead: '#7f9bff',
  chords: '#4fbfa5',
  bass: '#ff8a5c',
  pad: '#a97bff',
  arp: '#ffd166',
  drums: '#5c6a8c',
};

const DRUM_LANE = { kick: 0.9, snare: 0.7, hat: 0.5, clap: 0.65, tom: 0.6, rim: 0.45, shaker: 0.35 };

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

export function drawPianoRoll(canvas, song, positionSec = 0) {
  const { w, h, dpr } = fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!song) return;

  const totalBeats = song.bars * song.beatsPerBar;
  const spb = 60 / song.bpm;
  const posBeat = positionSec / spb;
  const viewBeats = Math.min(totalBeats, 32);
  const startBeat = Math.max(0, Math.min(totalBeats - viewBeats, posBeat - viewBeats * 0.35));
  const xOf = (beat) => ((beat - startBeat) / viewBeats) * w;

  // pitch range across melodic tracks
  let lo = 36, hi = 88;
  const mel = ['lead', 'chords', 'bass', 'pad', 'arp'];
  const pitches = [];
  for (const t of mel) for (const n of song.tracks[t] || []) pitches.push(n.p);
  if (pitches.length) {
    pitches.sort((a, b) => a - b);
    lo = Math.max(21, pitches[Math.floor(pitches.length * 0.02)] - 2);
    hi = Math.min(108, pitches[Math.floor(pitches.length * 0.98)] + 2);
  }
  const laneTop = 8 * dpr;
  const laneH = h - 26 * dpr;
  const yOf = (p) => laneTop + laneH - ((p - lo) / Math.max(1, hi - lo)) * laneH;

  // bar lines
  ctx.strokeStyle = 'rgba(150,165,200,0.16)';
  ctx.lineWidth = 1;
  for (let b = Math.ceil(startBeat / song.beatsPerBar) * song.beatsPerBar; b < startBeat + viewBeats; b += song.beatsPerBar) {
    ctx.beginPath();
    ctx.moveTo(xOf(b), 0);
    ctx.lineTo(xOf(b), h - 22 * dpr);
    ctx.stroke();
  }

  // chord labels
  ctx.fillStyle = 'rgba(150,165,200,0.75)';
  ctx.font = `${9 * dpr}px system-ui, sans-serif`;
  for (const sec of song.sections) {
    for (const ch of sec.chords) {
      const x = xOf(ch.bar * song.beatsPerBar);
      if (x > -40 && x < w) ctx.fillText(ch.symbol, x + 2 * dpr, 10 * dpr);
    }
  }

  // notes
  for (const track of mel) {
    const notes = song.tracks[track] || [];
    ctx.fillStyle = TRACK_COLOR[track] || '#8aa';
    for (const n of notes) {
      if (n.t + n.d < startBeat || n.t > startBeat + viewBeats) continue;
      const x = xOf(n.t);
      const wid = Math.max(1.5 * dpr, (n.d / viewBeats) * w);
      const y = yOf(n.p);
      const nh = Math.max(2 * dpr, laneH / Math.max(8, hi - lo));
      ctx.globalAlpha = track === 'pad' ? 0.35 : 0.85;
      ctx.fillRect(x, y, wid, nh);
    }
  }
  ctx.globalAlpha = 1;

  // drum lane at the bottom
  const drumTop = h - 22 * dpr;
  for (const n of song.tracks.drums || []) {
    if (n.t + n.d < startBeat || n.t > startBeat + viewBeats) continue;
    const lvl = DRUM_LANE[n.drum] ?? 0.4;
    ctx.fillStyle = `rgba(150,170,210,${0.25 + lvl * 0.6})`;
    const bh = (drumTop + 20 * dpr - drumTop) * lvl;
    ctx.fillRect(xOf(n.t), drumTop + (20 * dpr - bh), Math.max(1.5 * dpr, 2 * dpr), bh);
  }

  // playhead
  const px = xOf(posBeat);
  ctx.strokeStyle = '#ff6f9c';
  ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath();
  ctx.moveTo(px, 0);
  ctx.lineTo(px, h);
  ctx.stroke();

  // section band
  ctx.fillStyle = 'rgba(127,155,255,0.06)';
  const sec = song.sections.find((s) => posBeat >= s.bar * song.beatsPerBar && posBeat < (s.bar + s.bars) * song.beatsPerBar);
  if (sec) {
    const x0 = Math.max(0, xOf(sec.bar * song.beatsPerBar));
    const x1 = Math.min(w, xOf((sec.bar + sec.bars) * song.beatsPerBar));
    ctx.fillRect(x0, 0, Math.max(0, x1 - x0), h);
  }
}

export function drawBars(canvas, analyser) {
  const { w, h, dpr } = fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!analyser) return;
  const bins = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(bins);
  const bars = Math.min(64, Math.floor(w / (5 * dpr)));
  const step = Math.floor(bins.length / bars);
  for (let i = 0; i < bars; i++) {
    let sum = 0;
    for (let j = 0; j < step; j++) sum += bins[i * step + j] || 0;
    const v = sum / step / 255;
    const bh = Math.max(1.5 * dpr, v * h * 0.92);
    const hue = 220 - v * 90;
    ctx.fillStyle = `hsl(${hue} 85% ${45 + v * 25}%)`;
    ctx.fillRect(i * (w / bars) + dpr, h - bh, (w / bars) - 2 * dpr, bh);
  }
}

// ---------------------------------------------------------------- waveform
export function drawWaveform(canvas, analyser) {
  const { w, h, dpr } = fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!analyser) return;
  const bins = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(bins);

  const mid = h / 2;
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, 'rgba(139,157,255,0.9)');
  grad.addColorStop(0.5, 'rgba(95,227,192,0.9)');
  grad.addColorStop(1, 'rgba(255,111,156,0.9)');

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
  ctx.strokeStyle = 'rgba(150,165,200,0.2)';
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
  if (!song) return;

  let st = artState.get(canvas);
  if (!st || st.seed !== song.seed) {
    let s = 0x9e3779b9;
    for (let i = 0; i < song.seed.length; i++) s = (Math.imul(s, 31) + song.seed.charCodeAt(i)) >>> 0;
    const rand = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const count = 120;
    st = {
      seed: song.seed,
      parts: Array.from({ length: count }, () => ({
        x: rand(), y: rand(), r: 0.4 + rand() * 1.8, sp: 0.2 + rand() * 0.8, hue: rand(),
      })),
    };
    artState.set(canvas, st);
  }

  let level = 0;
  if (analyser) {
    const bins = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(bins);
    let sum = 0;
    for (let i = 0; i < bins.length; i++) sum += bins[i];
    level = sum / bins.length / 255;
  }

  // trailing fade
  ctx.fillStyle = 'rgba(7,8,15,0.28)';
  ctx.fillRect(0, 0, w, h);

  const palette = song.palette || ['#0b1026', '#1b2a5e', '#5f7bd9', '#c9d6ff'];
  const t = now / 1000;
  for (const p of st.parts) {
    p.y += p.sp * 0.0006 * (0.4 + level * 4);
    if (p.y > 1.05) { p.y = -0.05; p.x = (p.x + 0.37) % 1; }
    const x = (p.x + Math.sin(t * 0.4 + p.hue * 6.28) * 0.02) * w;
    const y = p.y * h;
    const r = (p.r + level * 3) * dpr * 2.2;
    const col = palette[1 + Math.floor(p.hue * (palette.length - 2))] || palette[2];
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.6, r), 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.25 + level * 0.6;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
