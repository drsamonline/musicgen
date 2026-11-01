// App wiring: presets, playback, visualisers, export, keyboard, persistence.
import { compose, normalisePresets, DEFAULT_PRESETS, BPM_MIN, BPM_MAX, COMPOSER_VERSION } from './core/composer.js';
import { validateSong } from './core/validate.js';
import { Rng, randomSeed } from './core/rng.js';
import { STYLES } from './presets/styles.js';
import { MOODS } from './presets/moods.js';
import { THEMES } from './presets/themes.js';
import { TYPES } from './presets/types.js';
import { TECHS } from './presets/techs.js';
import { randomPresets } from './presets/compatibility.js';
import { Player, renderSong, tempoMapOf } from './audio/engine.js';
import { describeTempo } from './core/tempo.js';
import { encodeWav, analyseBuffer, normalisationGain, download } from './export/wav.js';
import { songToMidi } from './export/midi.js';
import { zipStore } from './export/zip.js';
import { drawArtwork, encodeState, decodeState, shareUrl } from './export/artwork.js';
import {
  drawPianoRoll, drawBars, drawWaveform, drawArt, invalidatePalette, beatAtX, noteAt,
} from './visual/pianoRoll.js';
import { synthVoice } from './audio/instruments.js';
import { freqOf } from './core/theory.js';
import {
  state, loadState, subscribe, emit, setPresets, toggleLock, persist,
  librarySave, libraryList, libraryDelete, libraryRename, libraryDuplicate,
} from './state.js';

const $ = (id) => document.getElementById(id);

const els = {
  play: $('play'), mute: $('mute'), themeToggle: $('themetoggle'), generate: $('generate'),
  random: $('random'), evolve: $('evolve'), mutate: $('mutate'), menu: $('menu'),
  ab: $('ab'), loop: $('loop'),
  title: $('title'), meta: $('meta'), seed: $('seed'), offline: $('offline'),
  viz: $('viz'), progressbar: $('progressbar'),
  style: $('style'), mood: $('mood'), theme: $('theme'), bpm: $('bpm'),
  bpmout: $('bpmout'), type: $('type'), tech: $('tech'),
  timesig: $('timesig'), tempodrift: $('tempodrift'), tempodriftout: $('tempodriftout'), intensity: $('intensity'), intensityout: $('intensityout'),
  swing: $('swing'), swingout: $('swingout'), chaos: $('chaos'), chaosout: $('chaosout'),
  arp: $('arp'), lockdrums: $('lockdrums'), locklead: $('locklead'),
  microtuning: $('microtuning'), settings: $('settings'), settingsDialog: $('settings-dialog'),
  setTheme: $('set-theme'), setVolume: $('set-volume'), setVolumeOut: $('set-volumeout'),
  setTarget: $('set-target'), grooveGrid: $('groovegrid'), groovereset: $('groovereset'),
  volume: $('volume'), volumeout: $('volumeout'), reset: $('reset'),
  sections: $('sections'), summary: $('summary'), toast: $('toast'), live: $('live'), notice: $('notice'),
  sheet: $('menu-sheet'), help: $('help'), library: $('library'),
  libraryList: $('library-list'), searchlib: $('searchlib'), fileinput: $('fileinput'),
  exporttarget: $('exporttarget'),
};

const VIZ_MODES = ['roll', 'bars', 'wave', 'art'];
const THEME_MODES = ['system', 'light', 'dark'];
const THEME_GLYPH = { system: '◐', light: '☀', dark: '☾' };

let player = null;
let rafId = null;
let regenTimer = null;
let artClock = 0;
let wakeLock = null;
let artUrl = null;
let vizMode = state.ui.vizMode || 'roll';
let view = null;                 // piano-roll viewport {start, span}
let lastLufs = null;
let deferredInstall = null;
let announceNext = true;         // throttle the aria-live region

const history = { past: [], future: [] };

// ------------------------------------------------------------- boot
function fillSelect(sel, items, selected) {
  sel.innerHTML = '';
  for (const it of items) {
    const o = document.createElement('option');
    o.value = it.id;
    o.textContent = it.name;
    if (it.id === selected) o.selected = true;
    sel.appendChild(o);
  }
}

function buildSelects() {
  fillSelect(els.style, Object.values(STYLES), state.presets.style);
  fillSelect(els.mood, Object.values(MOODS), state.presets.mood);
  fillSelect(els.theme, Object.values(THEMES), state.presets.theme);
  fillSelect(els.type, Object.values(TYPES), state.presets.type);
  fillSelect(els.tech, Object.values(TECHS), state.presets.tech);
}

function syncControls() {
  const p = state.presets;
  els.style.value = p.style;
  els.mood.value = p.mood;
  els.theme.value = p.theme;
  els.type.value = p.type;
  els.tech.value = p.tech;
  els.bpm.value = String(p.bpm);
  els.bpmout.textContent = String(p.bpm);
  els.timesig.value = `${p.timeSig[0]}x${p.timeSig[1]}`;
  els.tempodrift.value = String(Math.round((p.tempoDrift ?? 0.08) * 100));
  els.tempodriftout.textContent = `${Math.round((p.tempoDrift ?? 0.08) * 100)}%`;
  els.intensity.value = String(Math.round((p.intensityBias || 0) * 100));
  els.intensityout.textContent = String(Math.round((p.intensityBias || 0) * 100));
  els.swing.value = String(Math.round((p.swing ?? 0) * 100));
  els.swingout.textContent = p.swing == null ? 'auto' : String(Math.round(p.swing * 100));
  els.chaos.value = String(Math.round((p.chaos ?? 0.15) * 100));
  els.chaosout.textContent = `${Math.round((p.chaos ?? 0.15) * 100)}%`;
  els.arp.checked = !!p.arp;
  els.microtuning.checked = !!p.microtuning;
  els.lockdrums.checked = !!p.lockTracks?.drums;
  els.locklead.checked = !!p.lockTracks?.lead;
  els.volume.value = String(Math.round((state.ui.volume ?? 0.9) * 100));
  els.volumeout.textContent = els.volume.value;
  els.mute.setAttribute('aria-pressed', String(!!state.ui.muted));
  els.mute.textContent = state.ui.muted ? 'Muted' : 'Mute';
  els.loop.setAttribute('aria-pressed', String(!!player?.loop));
  els.ab.setAttribute('aria-pressed', String(!!state.showingPrevious));
  for (const btn of document.querySelectorAll('.lock')) {
    btn.setAttribute('aria-pressed', state.locks[btn.dataset.lock] ? 'true' : 'false');
    btn.textContent = state.locks[btn.dataset.lock] ? '🔒' : '🔓';
  }
  for (const btn of document.querySelectorAll('[data-viz]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.viz === vizMode));
  }
}

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => els.toast.classList.remove('show'), 2600);
}

function notice(msg) {
  if (!els.notice) return;
  els.notice.textContent = msg;
  els.notice.hidden = !msg;
}

function checkVersion(version, source) {
  if (version == null) return true;
  if (Number(version) === COMPOSER_VERSION) return true;
  notice(`This ${source} was made with composer v${version}; you are on v${COMPOSER_VERSION}, `
    + 'so the same seed now produces different notes. Re-save it if you like what you hear.');
  return false;
}

function fail(what, err) {
  console.error(what, err);
  toast(`${what} failed — see console`);
}

// ------------------------------------------------------------- theme
function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(pref, { redraw = true } = {}) {
  const next = THEME_MODES.includes(pref) ? pref : 'system';
  state.ui.theme = next;
  document.documentElement.dataset.theme = next;
  els.themeToggle.textContent = THEME_GLYPH[next];
  els.themeToggle.setAttribute('aria-label', `Colour theme: ${next}`);
  els.themeToggle.title = `Colour theme: ${next} (T)`;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolveTheme(next) === 'light' ? '#f2f4fa' : '#07080f');
  invalidatePalette();
  if (redraw) drawViz(player?.position ?? 0);
  persist();
}

function cycleTheme() {
  const i = THEME_MODES.indexOf(state.ui.theme || 'system');
  const next = THEME_MODES[(i + 1) % THEME_MODES.length];
  applyTheme(next);
  toast(`Theme: ${next}`);
}

// ------------------------------------------------------------- history
function snapshot() {
  return JSON.parse(JSON.stringify(state.presets));
}

function pushHistory() {
  history.past.push(snapshot());
  if (history.past.length > 50) history.past.shift();
  history.future.length = 0;
}

function undo() {
  const prev = history.past.pop();
  if (!prev) { toast('Nothing to undo'); return; }
  history.future.push(snapshot());
  state.presets = normalisePresets(prev);
  syncControls();
  generate();
  toast('Undone');
}

function redo() {
  const next = history.future.pop();
  if (!next) { toast('Nothing to redo'); return; }
  history.past.push(snapshot());
  state.presets = normalisePresets(next);
  syncControls();
  generate();
  toast('Redone');
}

// ------------------------------------------------------------- generate
function generate({ keepPosition = false, announce = true } = {}) {
  const wasPlaying = player?.playing;
  if (wasPlaying) pause();
  try {
    const t0 = performance.now();
    state.song = compose(state.presets, state.seed);
    const ms = Math.round(performance.now() - t0);
    const check = validateSong(state.song);
    renderMeta(ms, check);
    renderSections();
    renderSummary();
    drawViz(keepPosition ? player?.position ?? 0 : 0);
    updateMediaSession();
    announceNext = announce;
    emit('song');
    if (wasPlaying) play();
  } catch (err) {
    fail('Compose', err);
  }
}

function renderMeta(ms = null, check = null) {
  const s = state.song;
  if (!s) return;
  els.title.textContent = s.title;
  const tempo = s.tempo ? describeTempo(tempoMapOf(s)) : `${s.bpm} BPM`;
  const bits = [s.key.name, tempo, `${s.bars} bars`, STYLES[s.style]?.name, MOODS[s.mood]?.name];
  els.meta.textContent = bits.join(' · ');
  els.seed.textContent = `#${s.seed.slice(0, 6)}`;
  els.seed.title = `${s.totalNotes} notes${ms != null ? ` · composed in ${ms} ms` : ''}`;
  if (announceNext) {
    els.live.textContent = `New song: ${s.title}, ${s.key.name}, ${s.tempo ? describeTempo(tempoMapOf(s)) : `${s.bpm} BPM`}`;
  }
  if (check && !check.ok) console.warn('theory validation', check.issues);
}

function renderSections() {
  els.sections.innerHTML = '';
  for (const sec of state.song?.sections ?? []) {
    const d = document.createElement('button');
    d.className = 'sec';
    d.textContent = `${sec.name} ${sec.bars}`;
    d.dataset.bar = String(sec.bar);
    const secMap = tempoMapOf(state.song);
    const secBpm = Math.round(secMap.bpmAt(sec.bar * state.song.beatsPerBar));
    d.title = `${sec.name} — ${secBpm} BPM — ${sec.chords.map((c) => c.symbol).join(' ')}`;
    d.addEventListener('click', () => {
      const at = tempoMapOf(state.song).secondsAt(sec.bar * state.song.beatsPerBar);
      if (player?.playing) player.play(at);
      else { ensurePlayer(); player.startPos = at; drawViz(at); }
      if (player?.loop) setLoopFor(sec);
    });
    d.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const next = e.key === 'ArrowRight' ? d.nextElementSibling : d.previousElementSibling;
      next?.focus();
    });
    els.sections.appendChild(d);
  }
}

function renderSummary() {
  const s = state.song;
  if (!s || !els.summary) return;
  const lines = s.sections.map((sec) => {
    const chords = sec.chords.map((c) => c.symbol).join(' ');
    const counts = ['drums', 'bass', 'chords', 'lead', 'pad']
      .map((t) => (s.tracks[t] || []).filter((n) => n.t >= sec.bar * s.beatsPerBar
        && n.t < (sec.bar + sec.bars) * s.beatsPerBar).length);
    return `${sec.name} (${sec.bars} bars, intensity ${sec.intensity.toFixed(2)}): ${chords}. `
      + `Notes — drums ${counts[0]}, bass ${counts[1]}, chords ${counts[2]}, lead ${counts[3]}, pad ${counts[4]}.`;
  });
  els.summary.innerHTML = '';
  const p = document.createElement('p');
  const tempoText = s.tempo ? describeTempo(tempoMapOf(s)) : `${s.bpm} BPM`;
  p.textContent = `${s.title} — ${s.key.name}, ${tempoText}, ${s.bars} bars, ${s.timeSig[0]}/${s.timeSig[1]}. `
    + `${s.totalNotes} notes in total.`;
  const ol = document.createElement('ol');
  for (const line of lines) {
    const li = document.createElement('li');
    li.textContent = line;
    ol.appendChild(li);
  }
  els.summary.append(p, ol);
}

function debouncedGenerate() {
  clearTimeout(regenTimer);
  regenTimer = setTimeout(() => generate({ keepPosition: true, announce: false }), 400);
}

// ------------------------------------------------------------- playback
function ensurePlayer() {
  if (!player || player.song !== state.song) {
    if (player) player.close();
    player = new Player(state.song);
    player.onTick = (pos) => {
      els.progressbar.style.width = `${Math.min(100, (pos / Math.max(0.001, state.song.durationSec)) * 100)}%`;
      markSection(pos);
    };
    player.onEnd = () => { els.play.textContent = '▶'; stopRaf(); releaseWakeLock(); };
  }
  return player;
}

function applyVolume() {
  const v = state.ui.muted ? 0 : (state.ui.volume ?? 0.9);
  player?.setVolume(v);
}

async function play() {
  ensurePlayer();
  await player.play();
  applyVolume();
  els.play.textContent = '⏸';
  startRaf();
  requestWakeLock();
  if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing';
}

function pause() {
  if (!player) return;
  player.pause();
  els.play.textContent = '▶';
  stopRaf();
  releaseWakeLock();
  drawViz(player.position);
  if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused';
}

function stop() {
  if (!player) return;
  player.stop();
  els.play.textContent = '▶';
  els.progressbar.style.width = '0%';
  stopRaf();
  releaseWakeLock();
  drawViz(0);
  if (navigator.mediaSession) navigator.mediaSession.playbackState = 'none';
}

function markSection(posSec) {
  if (!state.song) return;
  const beat = (posSec * state.song.bpm) / 60;
  for (const btn of els.sections.children) {
    const bar = Number(btn.dataset.bar);
    const sec = state.song.sections.find((s) => s.bar === bar);
    const active = sec && beat >= sec.bar * state.song.beatsPerBar && beat < (sec.bar + sec.bars) * state.song.beatsPerBar;
    btn.classList.toggle('active', !!active);
  }
}

function currentSection(posSec) {
  if (!state.song) return null;
  const beat = (posSec * state.song.bpm) / 60;
  return state.song.sections.find((s) => beat >= s.bar * state.song.beatsPerBar
    && beat < (s.bar + s.bars) * state.song.beatsPerBar) || null;
}

function setLoopFor(sec) {
  if (!player || !sec || !state.song) return;
  const map = tempoMapOf(state.song);
  player.setLoop(
    map.secondsAt(sec.bar * state.song.beatsPerBar),
    map.secondsAt((sec.bar + sec.bars) * state.song.beatsPerBar),
  );
  syncControls();
}

function toggleLoop() {
  if (!player) ensurePlayer();
  if (player.loop) {
    player.setLoop(null);
    toast('Loop off');
  } else {
    const sec = currentSection(player.position) || state.song.sections[0];
    setLoopFor(sec);
    toast(`Looping ${sec.name}`);
  }
  syncControls();
}

function toggleAB() {
  if (!state.previous) { toast('No previous song yet'); return; }
  const cur = { presets: snapshot(), seed: state.seed };
  state.showingPrevious = !state.showingPrevious;
  const target = state.showingPrevious ? state.previous : cur;
  state.previous = state.showingPrevious ? cur : state.previous;
  const wasPlaying = player?.playing;
  if (wasPlaying) pause();
  state.presets = normalisePresets(target.presets);
  state.seed = target.seed;
  syncControls();
  generate({ announce: false });
  if (wasPlaying) play();
  toast(state.showingPrevious ? 'A — previous song' : 'B — current song');
}

// ------------------------------------------------------------- platform
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* not supported or denied */ }
}

function releaseWakeLock() {
  try { wakeLock?.release(); } catch { /* already gone */ }
  wakeLock = null;
}

function updateMediaSession() {
  if (!navigator.mediaSession || !state.song) return;
  const s = state.song;
  try {
    if (!artUrl || updateMediaSession.seed !== s.seed) {
      const canvas = document.createElement('canvas');
      drawArtwork(canvas, s, 512);
      artUrl = canvas.toDataURL('image/png');
      updateMediaSession.seed = s.seed;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: s.title,
      artist: `MusicGen · ${STYLES[s.style]?.name ?? ''}`.trim(),
      album: `${s.key.name} · ${s.bpm} BPM`,
      artwork: [{ src: artUrl, sizes: '512x512', type: 'image/png' }],
    });
    navigator.mediaSession.setActionHandler('play', () => play());
    navigator.mediaSession.setActionHandler('pause', () => pause());
    navigator.mediaSession.setActionHandler('nexttrack', () => doRandom());
  } catch { /* MediaSession is a bonus */ }
}

function wireInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    els.offline.textContent = 'install';
    els.offline.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    toast('Installed — it works offline now');
    markOfflineReady();
  });
  els.offline.addEventListener('click', async () => {
    if (deferredInstall) {
      deferredInstall.prompt();
      const choice = await deferredInstall.userChoice;
      if (choice.outcome === 'accepted') toast('Installing…');
      deferredInstall = null;
      return;
    }
    markOfflineReady();
    toast(navigator.serviceWorker?.controller ? 'Offline ready' : 'Install from your browser menu');
  });
}

async function doInstall() {
  if (deferredInstall) {
    deferredInstall.prompt();
    deferredInstall = null;
  } else {
    toast('Use your browser menu → Install / Add to Home Screen');
  }
}

function markOfflineReady() {
  if (!navigator.serviceWorker?.controller) return;
  els.offline.textContent = 'offline ready';
  els.offline.hidden = false;
  els.offline.title = 'The whole app is cached — it runs with the network off';
}

// ------------------------------------------------------------- visual
function drawViz(posSec = 0) {
  if (!state.song) return;
  const analyser = player?.graph?.analyser ?? null;
  if (vizMode === 'bars') drawBars(els.viz, analyser);
  else if (vizMode === 'wave') drawWaveform(els.viz, analyser);
  else if (vizMode === 'art') drawArt(els.viz, state.song, analyser, artClock);
  else drawPianoRoll(els.viz, state.song, posSec, view);
}

function startRaf() {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fps = reduce ? 10 : 30;
  let last = 0;
  const loop = (t) => {
    if (!player?.playing) { rafId = null; return; }
    artClock = t;
    if (t - last > 1000 / fps) {
      last = t;
      drawViz(player.position);
      if (vizMode !== 'roll') markSection(player.position);
    }
    rafId = requestAnimationFrame(loop);
  };
  stopRaf();
  rafId = requestAnimationFrame(loop);
}

function stopRaf() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

function setIdleAnimation() {
  if (vizMode !== 'art') return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { drawViz(player?.position ?? 0); return; }
  const loop = (t) => {
    if (vizMode !== 'art' || player?.playing) { rafId = null; return; }
    artClock = t;
    drawViz(player?.position ?? 0);
    rafId = requestAnimationFrame(loop);
  };
  stopRaf();
  rafId = requestAnimationFrame(loop);
}

function setVizMode(mode) {
  vizMode = VIZ_MODES.includes(mode) ? mode : 'roll';
  state.ui.vizMode = vizMode;
  syncControls();
  emit('ui');
  drawViz(player?.position ?? 0);
  if (vizMode === 'art') setIdleAnimation();
}

// piano roll gestures: wheel zooms, drag pans, click scrubs
function wireRoll() {
  let dragging = false;
  let dragStartX = 0;
  let dragStartView = null;

  els.viz.addEventListener('wheel', (e) => {
    if (vizMode !== 'roll' || !state.song) return;
    e.preventDefault();
    const totalBeats = state.song.bars * state.song.beatsPerBar;
    const base = view || { start: Math.max(0, ((player?.position ?? 0) * state.song.bpm) / 60 - 11), span: 32 };
    const factor = e.deltaY > 0 ? 1.18 : 0.85;
    const span = Math.max(4, Math.min(totalBeats, base.span * factor));
    const centre = base.start + base.span / 2;
    const start = Math.max(0, Math.min(Math.max(0, totalBeats - span), centre - span / 2));
    view = { start, span };
    drawViz(player?.position ?? 0);
  }, { passive: false });

  els.viz.addEventListener('pointerdown', (e) => {
    if (vizMode !== 'roll' || !state.song) return;
    dragging = true;
    dragStartX = e.clientX;
    dragStartView = view ? { ...view } : null;
    els.viz.setPointerCapture?.(e.pointerId);
  });

  els.viz.addEventListener('pointermove', (e) => {
    if (!dragging || !dragStartView || !state.song) return;
    const rect = els.viz.getBoundingClientRect();
    const beatsPerPx = dragStartView.span / Math.max(1, rect.width);
    const totalBeats = state.song.bars * state.song.beatsPerBar;
    const start = Math.max(0, Math.min(Math.max(0, totalBeats - dragStartView.span),
      dragStartView.start - (e.clientX - dragStartX) * beatsPerPx));
    view = { start, span: dragStartView.span };
    drawViz(player?.position ?? 0);
  });

  els.viz.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    const moved = Math.abs(e.clientX - dragStartX);
    if (moved > 6 || !state.song) return;

    // tapping a note auditions it; tapping empty space scrubs
    const hit = noteAt(els.viz, state.song, e.clientX, e.clientY, view);
    if (hit) { auditionNote(hit); return; }

    const beat = beatAtX(els.viz, state.song, e.clientX, view);
    const at = (beat * 60) / state.song.bpm;
    ensurePlayer();
    if (player.playing) player.play(at);
    else { player.startPos = at; drawViz(at); }
  });

  els.viz.addEventListener('dblclick', () => {
    view = null;
    drawViz(player?.position ?? 0);
    toast('Piano roll zoom reset');
  });
}

// ------------------------------------------------------------- presets
function wirePresets() {
  const bind = (el, key) => {
    el.addEventListener('change', () => {
      pushHistory();
      setPresets({ [key]: el.value });
      debouncedGenerate();
    });
  };
  bind(els.style, 'style');
  bind(els.mood, 'mood');
  bind(els.theme, 'theme');
  bind(els.type, 'type');
  bind(els.tech, 'tech');

  els.bpm.addEventListener('input', () => {
    const v = Math.max(BPM_MIN, Math.min(BPM_MAX, Number(els.bpm.value)));
    els.bpmout.textContent = String(v);
    setPresets({ bpm: v });
    debouncedGenerate();
  });
  els.bpm.addEventListener('change', () => pushHistory());
  els.tempodrift.addEventListener('input', () => {
    els.tempodriftout.textContent = `${els.tempodrift.value}%`;
    setPresets({ tempoDrift: Number(els.tempodrift.value) / 100 });
    debouncedGenerate();
  });
  els.timesig.addEventListener('change', () => {
    const [a, b] = els.timesig.value.split('x').map(Number);
    pushHistory();
    setPresets({ timeSig: [a, b] });
    debouncedGenerate();
  });
  els.intensity.addEventListener('input', () => {
    els.intensityout.textContent = els.intensity.value;
    setPresets({ intensityBias: Number(els.intensity.value) / 100 });
    debouncedGenerate();
  });
  els.swing.addEventListener('input', () => {
    els.swingout.textContent = els.swing.value === '0' ? 'auto' : els.swing.value;
    setPresets({ swing: els.swing.value === '0' ? null : Number(els.swing.value) / 100 });
    debouncedGenerate();
  });
  els.chaos.addEventListener('input', () => {
    els.chaosout.textContent = `${els.chaos.value}%`;
    setPresets({ chaos: Number(els.chaos.value) / 100 });
  });
  els.arp.addEventListener('change', () => {
    pushHistory();
    setPresets({ arp: els.arp.checked });
    debouncedGenerate();
  });

  // track locks: pinning a track freezes its seed
  const bindTrackLock = (el, name) => {
    el.addEventListener('change', () => {
      pushHistory();
      const lockTracks = { ...(state.presets.lockTracks || {}), [name]: el.checked };
      const trackSeeds = { ...(state.presets.trackSeeds || {}) };
      if (el.checked) trackSeeds[name] = state.seed;
      setPresets({ lockTracks, trackSeeds });
      generate({ announce: false });
      toast(el.checked ? `${name} locked` : `${name} unlocked`);
    });
  };
  bindTrackLock(els.lockdrums, 'drums');
  bindTrackLock(els.locklead, 'lead');

  els.volume.addEventListener('input', () => {
    state.ui.volume = Number(els.volume.value) / 100;
    state.ui.muted = false;
    els.volumeout.textContent = els.volume.value;
    applyVolume();
    syncControls();
    emit('ui');
  });

  els.microtuning.addEventListener('change', () => {
    pushHistory();
    setPresets({ microtuning: els.microtuning.checked });
    generate({ announce: false });
    toast(els.microtuning.checked ? 'Just intonation on' : 'Equal temperament');
  });

  els.settings.addEventListener('click', openSettings);
  els.setTheme.addEventListener('change', () => applyTheme(els.setTheme.value));
  els.setVolume.addEventListener('input', () => {
    state.ui.volume = Number(els.setVolume.value) / 100;
    els.setVolumeOut.textContent = els.setVolume.value;
    els.volume.value = els.setVolume.value;
    els.volumeout.textContent = els.setVolume.value;
    applyVolume();
    emit('ui');
  });
  els.setTarget.addEventListener('change', () => {
    if (els.exporttarget) els.exporttarget.value = els.setTarget.value;
  });

  els.groovereset.addEventListener('click', () => {
    pushHistory();
    setPresets({ grooveOverride: null });
    renderGroove();
    generate({ announce: false });
    toast('Groove reset to the style default');
  });

  els.reset.addEventListener('click', () => {
    pushHistory();
    state.presets = normalisePresets({ ...DEFAULT_PRESETS });
    syncControls();
    generate();
    toast('Presets reset');
  });

  for (const btn of document.querySelectorAll('.lock')) {
    btn.addEventListener('click', () => toggleLock(btn.dataset.lock));
  }
  for (const btn of document.querySelectorAll('[data-viz]')) {
    btn.addEventListener('click', () => setVizMode(btn.dataset.viz));
  }
}

function doRandom() {
  const rng = new Rng(randomSeed(10));
  const picks = randomPresets(rng, { chaos: state.presets.chaos ?? 0.15, locks: state.locks });
  const patch = {};
  if (!state.locks.style && picks.style) patch.style = picks.style;
  if (!state.locks.mood && picks.mood) patch.mood = picks.mood;
  if (!state.locks.theme && picks.theme) patch.theme = picks.theme;
  if (!state.locks.tech && picks.tech) patch.tech = picks.tech;
  if (!state.locks.bpm) patch.bpm = picks.bpm;
  if (!state.locks.type) patch.type = rng.pick(Object.keys(TYPES));
  pushHistory();
  state.previous = { presets: snapshot(), seed: state.seed };
  state.seed = randomSeed(12);
  state.presets = normalisePresets({ ...state.presets, ...patch });
  syncControls();
  flashDials(Object.keys(patch));
  generate();
}

// the dials that changed glow for a moment, so Random reads as an action
function flashDials(keys) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const key of keys) {
    const el = els[key];
    if (!el) continue;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 700);
  }
}

function doEvolve() {
  pushHistory();
  state.previous = { presets: snapshot(), seed: state.seed };
  state.seed = randomSeed(12);
  syncControls();
  generate();
}

function doMutate() {
  const axes = ['style', 'mood', 'theme', 'tech', 'type'].filter((a) => !state.locks[a]);
  if (!axes.length) { toast('Everything is locked'); return; }
  const axis = axes[Math.floor(Math.random() * axes.length)];
  const table = { style: STYLES, mood: MOODS, theme: THEMES, tech: TECHS, type: TYPES }[axis];
  const ids = Object.keys(table).filter((id) => id !== state.presets[axis]);
  const next = ids[Math.floor(Math.random() * ids.length)];
  pushHistory();
  state.previous = { presets: snapshot(), seed: state.seed };
  state.presets = normalisePresets({ ...state.presets, [axis]: next });
  syncControls();
  generate();
  toast(`Mutated ${axis} → ${table[next].name}`);
}

function toggleMute() {
  state.ui.muted = !state.ui.muted;
  applyVolume();
  syncControls();
  emit('ui');
  toast(state.ui.muted ? 'Muted' : 'Sound on');
}

// ------------------------------------------------------------- export
function stemTracks(song) {
  return ['drums', 'bass', 'chords', 'lead', 'pad', 'arp'].filter((t) => (song.tracks[t] || []).length > 0);
}

function targetLufs() {
  const v = els.exporttarget?.value ?? 'style';
  if (v === 'raw') return null;
  if (v === 'style') return state.song?.lufs ?? -14;
  return Number(v);
}

async function exportWav() {
  if (!state.song) return;
  toast('Rendering audio…');
  try {
    const buf = await renderSong(state.song, { sampleRate: 44100 });
    const target = targetLufs();
    const gain = target == null ? 1 : normalisationGain(buf, target, -1);
    const info = analyseBuffer(buf);
    lastLufs = info.lufs + 20 * Math.log10(gain || 1);
    const bytes = encodeWav(buf, { bitDepth: 16, gain });
    download(new Blob([bytes], { type: 'audio/wav' }), `${slug(state.song.title)}.wav`);
    toast(target == null
      ? `WAV ready · ${info.lufs.toFixed(1)} LUFS (unnormalised)`
      : `WAV ready · ${lastLufs.toFixed(1)} LUFS → target ${target}`);
    renderSummary();
  } catch (err) {
    fail('WAV export', err);
  }
}

async function exportStems() {
  if (!state.song) return;
  const song = state.song;
  const tracks = stemTracks(song);
  if (!tracks.length) { toast('Nothing to stem'); return; }
  try {
    toast('Measuring mix…');
    const mix = await renderSong(song, { sampleRate: 44100 });
    const target = targetLufs();
    const gain = target == null ? 1 : normalisationGain(mix, target, -1);
    const files = [];
    const levels = [];
    for (let i = 0; i < tracks.length; i++) {
      toast(`Rendering stem ${i + 1}/${tracks.length} — ${tracks[i]}`);
      const buf = await renderSong(song, { sampleRate: 44100, only: [tracks[i]] });
      const info = analyseBuffer(buf);
      levels.push(`${tracks[i]}: ${(info.lufs + 20 * Math.log10(gain || 1)).toFixed(1)} LUFS`);
      files.push({ name: `${slug(song.title)}-${tracks[i]}.wav`, data: encodeWav(buf, { bitDepth: 16, gain }) });
    }
    files.push({
      name: 'README.txt',
      data: new TextEncoder().encode(
        `Stems for "${song.title}"\nSeed: ${song.seed}\nKey: ${song.key.name}\nTempo: ${song.bpm} BPM\n`
        + `Style: ${song.style} · Mood: ${song.mood} · Tech: ${song.tech}\n`
        + `All stems share one gain (measured on the full mix), so they sum to the exported mix.\n\n`
        + `Per-stem loudness at that gain:\n${levels.map((l) => `  ${l}`).join('\n')}\n`,
      ),
    });
    const zip = zipStore(files);
    download(new Blob([zip], { type: 'application/zip' }), `${slug(song.title)}-stems.zip`);
    toast(`${tracks.length} stems exported`);
  } catch (err) {
    fail('Stem export', err);
  }
}

function exportMidi() {
  if (!state.song) return;
  try {
    const bytes = songToMidi(state.song);
    download(new Blob([bytes], { type: 'audio/midi' }), `${slug(state.song.title)}.mid`);
    toast('MIDI exported');
  } catch (err) { fail('MIDI export', err); }
}

function exportJson() {
  if (!state.song) return;
  const blob = new Blob([JSON.stringify(state.song, null, 2)], { type: 'application/json' });
  download(blob, `${slug(state.song.title)}.musicgen.json`);
  toast('Song JSON exported');
}

function importJson() {
  els.fileinput.value = '';
  els.fileinput.click();
}

function applySong(song) {
  if (!song || !song.tracks || !song.presets || !song.seed) throw new Error('not a song file');
  state.song = song;
  state.presets = normalisePresets(song.presets);
  state.seed = song.seed;
  syncControls();
  renderMeta();
  renderSections();
  renderSummary();
  drawViz(0);
  checkVersion(song.composerVersion, 'song file');
  toast(`Imported “${song.title}”`);
}

async function onFilePicked() {
  const file = els.fileinput.files?.[0];
  if (!file) return;
  try {
    applySong(JSON.parse(await file.text()));
  } catch (err) {
    fail('Import', err);
    toast('That file is not a MusicGen song');
  }
}

function exportArt() {
  if (!state.song) return;
  try {
    const canvas = document.createElement('canvas');
    drawArtwork(canvas, state.song, 1024);
    canvas.toBlob((blob) => {
      download(blob, `${slug(state.song.title)}-cover.png`);
      toast('Cover art exported');
    }, 'image/png');
  } catch (err) { fail('Cover art', err); }
}

async function doShare() {
  const url = shareUrl(state.presets, state.seed);
  const text = `${state.song?.title ?? 'A song'} — made with MusicGen`;
  try {
    if (navigator.share) {
      const payload = { title: 'MusicGen', text, url };
      if (state.song && navigator.canShare) {
        const canvas = document.createElement('canvas');
        drawArtwork(canvas, state.song, 512);
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
        if (blob) {
          const file = new File([blob], `${slug(state.song.title)}.png`, { type: 'image/png' });
          if (navigator.canShare({ files: [file] })) payload.files = [file];
        }
      }
      await navigator.share(payload);
      return;
    }
    await navigator.clipboard.writeText(url);
    toast('Share link copied');
  } catch {
    history.replaceState(null, '', `#s=${encodeState(state.presets, state.seed)}`);
    toast('Link is in the address bar');
  }
}

async function doSave() {
  if (!state.song) return;
  try {
    await librarySave(state.song);
    toast(`Saved “${state.song.title}”`);
  } catch (err) {
    fail('Save', err);
    toast('Could not save — storage may be full');
  }
}

async function exportLibrary() {
  try {
    const items = await libraryList();
    if (!items.length) { toast('Library is empty'); return; }
    const files = items.map((it) => ({
      name: `${slug(it.title)}-${it.id.slice(0, 8)}.musicgen.json`,
      data: new TextEncoder().encode(JSON.stringify(it.song || { presets: it.presets, seed: it.seed, title: it.title }, null, 2)),
    }));
    files.push({
      name: 'library.txt',
      data: new TextEncoder().encode(items.map((it) => `${it.title}\t${it.style}\t${it.mood}\t${it.bpm}\t${it.seed}`).join('\n')),
    });
    download(new Blob([zipStore(files)], { type: 'application/zip' }), 'musicgen-library.zip');
    toast(`${items.length} songs exported`);
  } catch (err) {
    fail('Library export', err);
  }
}

async function openLibrary() {
  const render = async (query = '') => {
    els.libraryList.innerHTML = '';
    try {
      const items = await libraryList();
      const q = query.trim().toLowerCase();
      const filtered = q
        ? items.filter((it) => `${it.title} ${it.style} ${it.mood} ${(it.tags || []).join(' ')}`.toLowerCase().includes(q))
        : items;
      if (!filtered.length) els.libraryList.textContent = items.length ? 'No matches.' : 'Nothing saved yet.';
      for (const it of filtered) {
        const row = document.createElement('div');
        row.className = 'lib-item';
        const label = document.createElement('div');
        label.innerHTML = `<strong>${escapeHtml(it.title)}</strong><br><small>${escapeHtml(it.style)} · ${escapeHtml(it.mood)} · ${it.bpm} BPM</small>`;
        const load = document.createElement('button');
        load.textContent = 'Load';
        load.addEventListener('click', () => {
          pushHistory();
          state.previous = { presets: snapshot(), seed: state.seed };
          state.presets = normalisePresets({ ...state.presets, ...it.presets });
          state.seed = it.seed;
          syncControls();
          generate();
          checkVersion(it.composerVersion, 'saved song');
          els.library.close();
        });
        const rename = document.createElement('button');
        rename.textContent = 'Rename';
        rename.addEventListener('click', async () => {
          const name = prompt('New title', it.title);
          if (!name) return;
          await libraryRename(it.id, name);
          render(els.searchlib.value);
        });
        const dup = document.createElement('button');
        dup.textContent = 'Copy';
        dup.addEventListener('click', async () => {
          await libraryDuplicate(it.id);
          render(els.searchlib.value);
        });
        const del = document.createElement('button');
        del.textContent = '✕';
        del.setAttribute('aria-label', `Delete ${it.title}`);
        del.addEventListener('click', async () => {
          await libraryDelete(it.id);
          row.remove();
        });
        row.append(label, load, rename, dup, del);
        els.libraryList.appendChild(row);
      }
    } catch (err) {
      fail('Library', err);
      els.libraryList.textContent = 'Library unavailable.';
    }
  };
  els.searchlib.oninput = () => render(els.searchlib.value);
  await render('');
  els.library.showModal();
}

function slug(s) {
  return (s || 'song').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'song';
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ------------------------------------------------------------- wiring
function wireActions() {
  els.play.addEventListener('click', () => { if (player?.playing) pause(); else play(); });
  els.mute.addEventListener('click', toggleMute);
  els.themeToggle.addEventListener('click', cycleTheme);
  els.generate.addEventListener('click', () => generate());
  els.random.addEventListener('click', doRandom);
  els.evolve.addEventListener('click', doEvolve);
  els.mutate.addEventListener('click', doMutate);
  els.ab.addEventListener('click', toggleAB);
  els.loop.addEventListener('click', toggleLoop);

  els.menu.addEventListener('click', () => {
    const open = els.sheet.hidden;
    els.sheet.hidden = !open;
    els.menu.setAttribute('aria-expanded', String(open));
  });
  els.sheet.addEventListener('click', async (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (!act) return;
    els.sheet.hidden = true;
    els.menu.setAttribute('aria-expanded', 'false');
    if (act === 'wav') exportWav();
    if (act === 'stems') exportStems();
    if (act === 'midi') exportMidi();
    if (act === 'json') exportJson();
    if (act === 'import') importJson();
    if (act === 'art') exportArt();
    if (act === 'share') doShare();
    if (act === 'undo') undo();
    if (act === 'redo') redo();
    if (act === 'library') openLibrary();
    if (act === 'exportlib') exportLibrary();
    if (act === 'record') toggleRecord();
    if (act === 'install') doInstall();
    if (act === 'help') els.help.showModal();
  });

  $('exportwav').addEventListener('click', exportWav);
  $('exportmidi').addEventListener('click', exportMidi);
  $('stems').addEventListener('click', exportStems);
  $('art').addEventListener('click', exportArt);
  $('share').addEventListener('click', doShare);
  $('save').addEventListener('click', doSave);
  els.seed.addEventListener('click', doShare);
  els.fileinput.addEventListener('change', onFilePicked);

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea, dialog')) return;
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); if (player?.playing) pause(); else play(); }
    else if (k === 'g') generate();
    else if (k === 'r') doRandom();
    else if (k === 'e') doEvolve();
    else if (k === 'm') doMutate();
    else if (k === 'b') toggleAB();
    else if (k === 'u') toggleMute();
    else if (k === 't') cycleTheme();
    else if (k === 'v') setVizMode(VIZ_MODES[(VIZ_MODES.indexOf(vizMode) + 1) % VIZ_MODES.length]);
    else if (k === 'escape') { stop(); els.sheet.hidden = true; }
    else if (k === '?') els.help.showModal();
    else if (k === 'l') {
      const focused = document.activeElement?.dataset?.lock;
      if (focused) toggleLock(focused);
    } else if (k === '+' || k === '=') {
      zoomRoll(0.85);
    } else if (k === '-' || k === '_') {
      zoomRoll(1.18);
    } else if ('123456'.includes(k)) {
      const map = { 1: els.style, 2: els.mood, 3: els.theme, 4: els.bpm, 5: els.type, 6: els.tech };
      map[k]?.focus();
    }
  });

  window.addEventListener('resize', () => drawViz(player?.position ?? 0));
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if ((state.ui.theme || 'system') === 'system') applyTheme('system');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopRaf();
    else if (player?.playing) startRaf();
    else setIdleAnimation();
  });
}

// ------------------------------------------------------------- groove editor
const GROOVE_KINDS = ['kick', 'snare', 'hat'];

function currentGroove() {
  const style = STYLES[state.presets.style];
  const base = state.presets.grooveOverride || style?.groove || {};
  const out = {};
  for (const kind of GROOVE_KINDS) {
    const grid = base[kind] || style?.groove?.[kind] || new Array(16).fill(0);
    out[kind] = Array.from({ length: 16 }, (_, i) => (grid[Math.round((i / 16) * grid.length)] ? 1 : 0));
  }
  return out;
}

function renderGroove() {
  if (!els.grooveGrid) return;
  const groove = currentGroove();
  els.grooveGrid.innerHTML = '';
  for (const kind of GROOVE_KINDS) {
    const row = document.createElement('div');
    row.className = 'groove-row';
    const label = document.createElement('span');
    label.textContent = kind;
    row.appendChild(label);
    groove[kind].forEach((on, i) => {
      const b = document.createElement('button');
      b.className = 'groove-step';
      b.type = 'button';
      b.setAttribute('aria-pressed', String(!!on));
      b.setAttribute('aria-label', `${kind} step ${i + 1}`);
      b.addEventListener('click', () => {
        const next = currentGroove();
        next[kind][i] = next[kind][i] ? 0 : 1;
        pushHistory();
        setPresets({ grooveOverride: next });
        b.setAttribute('aria-pressed', String(!!next[kind][i]));
        generate({ announce: false });
      });
      row.appendChild(b);
    });
    els.grooveGrid.appendChild(row);
  }
}

// ------------------------------------------------------------- settings
function openSettings() {
  els.setTheme.value = state.ui.theme || 'system';
  els.setVolume.value = String(Math.round((state.ui.volume ?? 0.9) * 100));
  els.setVolumeOut.textContent = els.setVolume.value;
  els.setTarget.value = els.exporttarget?.value ?? 'style';
  els.settingsDialog.showModal();
}

// ------------------------------------------------------------- recording
let recorder = null;
let recordChunks = [];

async function toggleRecord() {
  if (recorder && recorder.state === 'recording') {
    recorder.stop();
    return;
  }
  try {
    ensurePlayer();
    if (player.ctx.state === 'suspended') await player.ctx.resume();
    const dest = player.ctx.createMediaStreamDestination();
    player.graph.chain.output.connect(dest);
    const stream = dest.stream;
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recordChunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) recordChunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(recordChunks, { type: recorder.mimeType || 'audio/webm' });
      download(blob, `${slug(state.song?.title || 'take')}.webm`);
      toast('Recording saved');
      try { player.graph.chain.output.disconnect(dest); } catch { /* noop */ }
    };
    recorder.start();
    if (!player.playing) await play();
    toast('Recording — press Record again to stop');
  } catch (err) {
    fail('Recording', err);
  }
}

function auditionNote(note) {
  try {
    ensurePlayer();
    if (player.ctx.state === 'suspended') player.ctx.resume();
    const track = note.track === 'drums' ? 'lead' : note.track;
    const spec = player.graph.tech.instruments[track] || player.graph.tech.instruments.lead;
    const when = player.ctx.currentTime + 0.02;
    synthVoice(player.ctx, player.graph.tracks[track].input, {
      when, dur: 0.4, freq: freqOf(note.p), vel: 0.85, spec, brightness: 0.95,
    });
    els.live.textContent = `Note ${note.p}, ${note.track}`;
  } catch (err) {
    fail('Audition', err);
  }
}

function zoomRoll(factor) {
  if (!state.song) return;
  const totalBeats = state.song.bars * state.song.beatsPerBar;
  const base = view || { start: Math.max(0, ((player?.position ?? 0) * state.song.bpm) / 60 - 11), span: 32 };
  const span = Math.max(4, Math.min(totalBeats, base.span * factor));
  const centre = base.start + base.span / 2;
  view = { start: Math.max(0, Math.min(Math.max(0, totalBeats - span), centre - span / 2)), span };
  drawViz(player?.position ?? 0);
}

// ------------------------------------------------------------- boot
async function boot() {
  loadState();
  vizMode = VIZ_MODES.includes(state.ui.vizMode) ? state.ui.vizMode : 'roll';
  buildSelects();
  syncControls();
  wirePresets();
  wireActions();
  wireRoll();
  wireInstall();
  renderGroove();
  subscribe(() => syncControls());

  const hash = location.hash.match(/^#s=(.+)$/);
  if (hash) {
    const decoded = decodeState(hash[1]);
    if (decoded) {
      state.presets = normalisePresets({ ...DEFAULT_PRESETS, ...decoded.presets });
      state.seed = decoded.seed;
      syncControls();
      checkVersion(decoded.composerVersion, 'link');
    }
  }

  applyTheme(state.ui.theme || 'system', { redraw: false });
  generate();

  if (!state.ui.seenIntro) {
    notice('Press ▶ to hear it · Random rolls new dials · Export takes the song to a DAW. '
      + 'Tap this line to dismiss.');
    els.notice.addEventListener('click', () => {
      notice('');
      state.ui.seenIntro = true;
      persist();
    }, { once: true });
  }
  if (vizMode === 'art') setIdleAnimation();

  // restore the last playback position (not playing — browsers want a gesture)
  if (state.ui.position > 1 && state.ui.position < (state.song?.durationSec ?? 0) - 2) {
    ensurePlayer();
    player.startPos = state.ui.position;
    drawViz(state.ui.position);
  }
  setInterval(() => {
    if (player && !player.playing && player.startPos > 0) {
      state.ui.position = player.startPos;
      persist();
    }
  }, 5000);

  const params = new URLSearchParams(location.search);
  if (params.get('action') === 'random') doRandom();
  if (params.get('action') === 'play') setTimeout(() => play(), 300);

  // share target: another app shared a link (or text) with us
  const shared = `${params.get('url') || ''} ${params.get('text') || ''}`;
  const sharedSeed = shared.match(/#s=([A-Za-z0-9_-]+)/);
  if (sharedSeed) {
    const decoded = decodeState(sharedSeed[1]);
    if (decoded) {
      state.presets = normalisePresets({ ...DEFAULT_PRESETS, ...decoded.presets });
      state.seed = decoded.seed;
      syncControls();
      generate();
      checkVersion(decoded.composerVersion, 'shared link');
      toast('Opened the shared song');
    }
  }

  // file handler: the OS opened a .json song with us
  if (globalThis.launchQueue) {
    globalThis.launchQueue.setConsumer(async (launch) => {
      for (const handle of launch.files || []) {
        try {
          const song = JSON.parse(await handle.text());
          applySong(song);
        } catch (err) {
          fail('Opening file', err);
        }
      }
    });
  }

  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('sw.js');
      if (navigator.serviceWorker.controller) markOfflineReady();
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        markOfflineReady();
        toast('Updated — reload for the new version');
      });
    } catch { /* offline install is a bonus */ }
  }
}

boot();
