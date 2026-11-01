// Landing page: a live specimen. Composes a real song in the browser,
// draws it, and plays it through the same engine the app uses.
import { compose } from './app/src/core/composer.js';
import { Player } from './app/src/audio/engine.js';
import { randomSeed } from './app/src/core/rng.js';
import { STYLES } from './app/src/presets/styles.js';
import { MOODS } from './app/src/presets/moods.js';

const canvas = document.getElementById('spec-canvas');
const metaEl = document.getElementById('spec-meta');
const noteEl = document.getElementById('spec-note');
const playBtn = document.getElementById('spec-play');
const nextBtn = document.getElementById('spec-next');
const openLink = document.getElementById('spec-open');

const PRESETS = {
  style: 'lofi', mood: 'dreamy', theme: 'rain', tech: 'analog',
  bpm: 84, type: 'loop', timeSig: [4, 4], arp: false, chaos: 0.15,
};

// three fixed seeds, so the page can play the same song twice
const FIXED_SEEDS = ['neon-rain-84', 'mainstage-128', 'dash-glow-132'];
const SEED_PRESETS = [
  { ...PRESETS },
  { ...PRESETS, style: 'edm', mood: 'epic', theme: 'festival', bpm: 128, tech: 'wavetable' },
  { ...PRESETS, style: 'jazz', mood: 'playful', theme: 'nightdrive', bpm: 132, tech: 'physical' },
];

const COLORS = { lead: '#c6f24e', chords: '#9aa8ff', bass: '#ff9f6b', pad: '#6ee7c8', arp: '#ffd166' };

let song = null;
let player = null;
let raf = null;
let playing = false;
let clock = 0;

function fit() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  return { dpr, w: canvas.width, h: canvas.height };
}

function draw(posSec = 0) {
  const { dpr, w, h } = fit();
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!song) return;

  const spb = 60 / song.bpm;
  const total = song.bars * song.beatsPerBar;
  const xOf = (beat) => (beat / total) * w;

  // section bands + bar lines
  for (const sec of song.sections) {
    const x0 = xOf(sec.bar * song.beatsPerBar);
    const x1 = xOf((sec.bar + sec.bars) * song.beatsPerBar);
    ctx.fillStyle = `rgba(241,243,236,${0.02 + sec.intensity * 0.05})`;
    ctx.fillRect(x0, 0, x1 - x0, h);
    ctx.fillStyle = 'rgba(241,243,236,0.4)';
    ctx.font = `${9 * dpr}px ui-monospace, monospace`;
    ctx.fillText(sec.name.toUpperCase(), x0 + 4 * dpr, 11 * dpr);
  }

  const mel = ['bass', 'chords', 'pad', 'arp', 'lead'];
  const pitches = [];
  for (const t of mel) for (const n of song.tracks[t] || []) pitches.push(n.p);
  pitches.sort((a, b) => a - b);
  const lo = pitches.length ? Math.max(24, pitches[Math.floor(pitches.length * 0.02)] - 2) : 36;
  const hi = pitches.length ? Math.min(100, pitches[Math.floor(pitches.length * 0.98)] + 2) : 84;
  const top = 22 * dpr;
  const laneH = h - top - 26 * dpr;
  const yOf = (p) => top + laneH - ((p - lo) / Math.max(1, hi - lo)) * laneH;
  const nh = Math.max(2 * dpr, laneH / Math.max(10, hi - lo));

  for (const track of mel) {
    ctx.fillStyle = COLORS[track];
    ctx.globalAlpha = track === 'pad' ? 0.3 : 0.85;
    for (const n of song.tracks[track] || []) {
      const x = xOf(n.t);
      const wBar = Math.max(1.4 * dpr, xOf(n.t + n.d) - x);
      ctx.fillRect(x, yOf(n.p), wBar, nh);
    }
  }
  ctx.globalAlpha = 1;

  // drum lane
  const drumTop = h - 20 * dpr;
  for (const n of song.tracks.drums || []) {
    const x = xOf(n.t);
    const size = n.drum === 'kick' ? 5 : n.drum === 'snare' || n.drum === 'clap' ? 3.5 : 2;
    ctx.fillStyle = 'rgba(241,243,236,0.5)';
    ctx.fillRect(x, drumTop - size * dpr * 0.5, Math.max(1.2 * dpr, size * dpr * 0.4), size * dpr);
  }

  // playhead
  const beat = posSec / spb;
  const px = xOf(Math.min(total, beat));
  ctx.strokeStyle = '#c6f24e';
  ctx.lineWidth = 1.6 * dpr;
  ctx.beginPath();
  ctx.moveTo(px, 0);
  ctx.lineTo(px, h);
  ctx.stroke();
  ctx.fillStyle = '#c6f24e';
  ctx.beginPath();
  ctx.arc(px, 4 * dpr, 3 * dpr, 0, Math.PI * 2);
  ctx.fill();
}

function setMeta() {
  if (!song) return;
  metaEl.textContent = `${song.title} · ${song.key.name} · ${song.bpm} BPM · #${song.seed.slice(0, 6)}`;
  openLink.href = `app/#s=${encodeSeed(song)}`;
}

// reuse the app's compact share encoding so the studio opens the same song
function encodeSeed(s) {
  const compact = {
    s: s.presets.style, m: s.presets.mood, t: s.presets.theme, h: s.presets.tech,
    b: s.presets.bpm, y: s.presets.type, k: s.presets.timeSig.join('x'),
    i: 0, w: null, a: 0, p: s.seed,
  };
  return btoa(unescape(encodeURIComponent(JSON.stringify(compact))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function regenerate() {
  song = compose(PRESETS, randomSeed(12));
  setMeta();
  draw(0);
  markSeed(-1);
}

function markSeed(index) {
  const buttons = document.querySelectorAll('#seeds button');
  buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(i === index)));
}

async function playFixed(index) {
  if (playing) {
    player.pause();
    playing = false;
    playBtn.textContent = '▶ Play';
    stopRaf();
  }
  song = compose(SEED_PRESETS[index], FIXED_SEEDS[index]);
  if (!player) player = new Player(song);
  else {
    // a new song needs a new graph
    await player.close();
    player = new Player(song);
  }
  setMeta();
  draw(0);
  markSeed(index);
  await togglePlay();
  noteEl.textContent = `Fixed seed “${FIXED_SEEDS[index]}” — the same notes every time you press it.`;
}

function buildSeeds() {
  const host = document.getElementById('seeds');
  if (!host) return;
  FIXED_SEEDS.forEach((seed, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${SEED_PRESETS[i].style} · ${SEED_PRESETS[i].bpm}`;
    b.setAttribute('aria-pressed', 'false');
    b.title = `Play the fixed seed ${seed}`;
    b.addEventListener('click', () => playFixed(i));
    host.appendChild(b);
  });
}

async function togglePlay() {
  if (!song) return;
  if (playing) {
    player.pause();
    playing = false;
    playBtn.textContent = '▶ Play';
    stopRaf();
    draw(player.position);
    noteEl.textContent = 'Paused. Regenerate for a different song from the same dials.';
    return;
  }
  if (!player) {
    player = new Player(song);
    player.onEnd = () => {
      playing = false;
      playBtn.textContent = '▶ Play';
      stopRaf();
      draw(0);
      noteEl.textContent = 'That was one tap. Regenerate, or open the studio and change the dials.';
    };
  }
  await player.play();
  player.setVolume(0.85);
  playing = true;
  playBtn.textContent = '⏸ Pause';
  noteEl.textContent = `${STYLES[song.style].name} · ${MOODS[song.mood].name} — synthesised live, no audio files.`;
  startRaf();
}

function startRaf() {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fps = reduce ? 8 : 30;
  let last = 0;
  const loop = (t) => {
    if (!playing) return;
    if (t - last > 1000 / fps) {
      last = t;
      clock = t;
      draw(player.position);
    }
    raf = requestAnimationFrame(loop);
  };
  stopRaf();
  raf = requestAnimationFrame(loop);
}

function stopRaf() {
  if (raf) cancelAnimationFrame(raf);
  raf = null;
}

playBtn.addEventListener('click', togglePlay);
nextBtn.addEventListener('click', () => {
  if (playing) {
    player.pause();
    playing = false;
    playBtn.textContent = '▶ Play';
    stopRaf();
  }
  buildSeeds();
regenerate();
});
window.addEventListener('resize', () => draw(playing ? player.position : 0));

buildSeeds();
regenerate();

// pause the specimen if the visitor scrolls away or hides the tab
document.addEventListener('visibilitychange', () => {
  if (document.hidden && playing) {
    player.pause();
    playing = false;
    playBtn.textContent = '▶ Play';
    stopRaf();
  }
});

void clock;
