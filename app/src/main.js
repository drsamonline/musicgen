// App wiring: presets, playback, visualisers, export, keyboard, persistence.
import { compose, normalisePresets, DEFAULT_PRESETS } from './core/composer.js';
import { validateSong } from './core/validate.js';
import { Rng, randomSeed } from './core/rng.js';
import { STYLES } from './presets/styles.js';
import { MOODS } from './presets/moods.js';
import { THEMES } from './presets/themes.js';
import { TYPES } from './presets/types.js';
import { TECHS } from './presets/techs.js';
import { randomPresets } from './presets/compatibility.js';
import { Player, renderSong } from './audio/engine.js';
import { encodeWav, analyseBuffer, normalisationGain, download } from './export/wav.js';
import { songToMidi } from './export/midi.js';
import { zipStore } from './export/zip.js';
import { drawArtwork, encodeState, decodeState, shareUrl } from './export/artwork.js';
import { drawPianoRoll, drawBars, drawWaveform, drawArt } from './visual/pianoRoll.js';
import {
  state, loadState, subscribe, emit, setPresets, toggleLock,
  librarySave, libraryList, libraryDelete,
} from './state.js';

const $ = (id) => document.getElementById(id);

const els = {
  play: $('play'), mute: $('mute'), generate: $('generate'), random: $('random'),
  evolve: $('evolve'), mutate: $('mutate'), menu: $('menu'),
  title: $('title'), meta: $('meta'), seed: $('seed'),
  viz: $('viz'), progressbar: $('progressbar'),
  style: $('style'), mood: $('mood'), theme: $('theme'), bpm: $('bpm'),
  bpmout: $('bpmout'), type: $('type'), tech: $('tech'),
  timesig: $('timesig'), intensity: $('intensity'), intensityout: $('intensityout'),
  swing: $('swing'), swingout: $('swingout'), chaos: $('chaos'), chaosout: $('chaosout'),
  arp: $('arp'), volume: $('volume'), volumeout: $('volumeout'),
  sections: $('sections'), toast: $('toast'), live: $('live'),
  sheet: $('menu-sheet'), help: $('help'), library: $('library'),
  libraryList: $('library-list'),
};

const VIZ_MODES = ['roll', 'bars', 'wave', 'art'];

let player = null;
let rafId = null;
let regenTimer = null;
let artClock = 0;
let wakeLock = null;
let artUrl = null;
let vizMode = state.ui.vizMode || 'roll';

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
  els.intensity.value = String(Math.round((p.intensityBias || 0) * 100));
  els.intensityout.textContent = String(Math.round((p.intensityBias || 0) * 100));
  els.swing.value = String(Math.round((p.swing ?? 0) * 100));
  els.swingout.textContent = p.swing == null ? 'auto' : String(Math.round(p.swing * 100));
  els.chaos.value = String(Math.round((p.chaos ?? 0.15) * 100));
  els.chaosout.textContent = `${Math.round((p.chaos ?? 0.15) * 100)}%`;
  els.arp.checked = !!p.arp;
  els.volume.value = String(Math.round((state.ui.volume ?? 0.9) * 100));
  els.volumeout.textContent = els.volume.value;
  els.mute.setAttribute('aria-pressed', String(!!state.ui.muted));
  els.mute.textContent = state.ui.muted ? 'Muted' : 'Mute';
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
  toast.t = setTimeout(() => els.toast.classList.remove('show'), 2400);
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
function generate({ keepPosition = false } = {}) {
  const wasPlaying = player?.playing;
  if (wasPlaying) pause();
  const t0 = performance.now();
  state.song = compose(state.presets, state.seed);
  const ms = Math.round(performance.now() - t0);
  const check = validateSong(state.song);
  renderMeta(ms, check);
  renderSections();
  drawViz(keepPosition ? player?.position ?? 0 : 0);
  updateMediaSession();
  emit('song');
  if (wasPlaying) play();
}

function renderMeta(ms = null, check = null) {
  const s = state.song;
  if (!s) return;
  els.title.textContent = s.title;
  const bits = [s.key.name, `${s.bpm} BPM`, `${s.bars} bars`, STYLES[s.style]?.name, MOODS[s.mood]?.name];
  els.meta.textContent = bits.join(' · ');
  els.seed.textContent = `#${s.seed.slice(0, 6)}`;
  els.seed.title = `${s.totalNotes} notes${ms != null ? ` · composed in ${ms} ms` : ''}`;
  els.live.textContent = `New song: ${s.title}, ${s.key.name}, ${s.bpm} BPM`;
  if (check && !check.ok) console.warn('theory validation', check.issues);
}

function renderSections() {
  els.sections.innerHTML = '';
  for (const sec of state.song?.sections ?? []) {
    const d = document.createElement('button');
    d.className = 'sec';
    d.textContent = `${sec.name} ${sec.bars}`;
    d.dataset.bar = String(sec.bar);
    d.title = `${sec.name} — ${sec.chords.map((c) => c.symbol).join(' ')}`;
    d.addEventListener('click', () => {
      const at = (sec.bar * state.song.beatsPerBar * 60) / state.song.bpm;
      if (player?.playing) player.play(at);
      else { ensurePlayer(); player.startPos = at; drawViz(at); }
    });
    els.sections.appendChild(d);
  }
}

function debouncedGenerate() {
  clearTimeout(regenTimer);
  regenTimer = setTimeout(() => generate({ keepPosition: true }), 400);
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

// ------------------------------------------------------------- platform
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* not supported or denied — playback still works */ }
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

// ------------------------------------------------------------- visual
function drawViz(posSec = 0) {
  if (!state.song) return;
  const analyser = player?.graph?.analyser ?? null;
  if (vizMode === 'bars') drawBars(els.viz, analyser);
  else if (vizMode === 'wave') drawWaveform(els.viz, analyser);
  else if (vizMode === 'art') drawArt(els.viz, state.song, analyser, artClock);
  else drawPianoRoll(els.viz, state.song, posSec);
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
  // the generative art mode keeps breathing when playback is stopped
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
    els.bpmout.textContent = els.bpm.value;
    setPresets({ bpm: Number(els.bpm.value) });
    debouncedGenerate();
  });
  els.bpm.addEventListener('change', () => pushHistory());
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
  els.volume.addEventListener('input', () => {
    state.ui.volume = Number(els.volume.value) / 100;
    state.ui.muted = false;
    els.volumeout.textContent = els.volume.value;
    applyVolume();
    syncControls();
    emit('ui');
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
  state.seed = randomSeed(12);
  state.presets = normalisePresets({ ...state.presets, ...patch });
  syncControls();
  generate();
}

function doEvolve() {
  pushHistory();
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
  return ['drums', 'bass', 'chords', 'lead', 'pad', 'arp']
    .filter((t) => (song.tracks[t] || []).length > 0);
}

async function exportWav() {
  if (!state.song) return;
  toast('Rendering audio…');
  try {
    const buf = await renderSong(state.song, { sampleRate: 44100 });
    const gain = normalisationGain(buf, state.song.lufs ?? -14, -1);
    const info = analyseBuffer(buf);
    const bytes = encodeWav(buf, { bitDepth: 16, gain });
    download(new Blob([bytes], { type: 'audio/wav' }), `${slug(state.song.title)}.wav`);
    toast(`WAV ready · ${info.lufs.toFixed(1)} LUFS → target ${state.song.lufs}`);
  } catch (err) {
    console.error(err);
    toast('Export failed — see console');
  }
}

async function exportStems() {
  if (!state.song) return;
  const song = state.song;
  const tracks = stemTracks(song);
  if (!tracks.length) { toast('Nothing to stem'); return; }
  try {
    // one gain for the whole set, measured on the full mix, so the stems sum
    // back to the mix instead of each being normalised on its own
    toast('Measuring mix…');
    const mix = await renderSong(song, { sampleRate: 44100 });
    const gain = normalisationGain(mix, song.lufs ?? -14, -1);
    const files = [];
    for (let i = 0; i < tracks.length; i++) {
      toast(`Rendering stem ${i + 1}/${tracks.length} — ${tracks[i]}`);
      const buf = await renderSong(song, { sampleRate: 44100, only: [tracks[i]] });
      files.push({ name: `${slug(song.title)}-${tracks[i]}.wav`, data: encodeWav(buf, { bitDepth: 16, gain }) });
    }
    files.push({
      name: 'README.txt',
      data: new TextEncoder().encode(
        `Stems for "${song.title}"\nSeed: ${song.seed}\nKey: ${song.key.name}\nTempo: ${song.bpm} BPM\n`
        + `Style: ${song.style} · Mood: ${song.mood} · Tech: ${song.tech}\n`
        + `All stems share one gain (measured on the full mix), so they sum to the exported mix.\n`,
      ),
    });
    const zip = zipStore(files);
    download(new Blob([zip], { type: 'application/zip' }), `${slug(song.title)}-stems.zip`);
    toast(`${tracks.length} stems exported`);
  } catch (err) {
    console.error(err);
    toast('Stem export failed — see console');
  }
}

function exportMidi() {
  if (!state.song) return;
  const bytes = songToMidi(state.song);
  download(new Blob([bytes], { type: 'audio/midi' }), `${slug(state.song.title)}.mid`);
  toast('MIDI exported');
}

function exportArt() {
  if (!state.song) return;
  const canvas = document.createElement('canvas');
  drawArtwork(canvas, state.song, 1024);
  canvas.toBlob((blob) => {
    download(blob, `${slug(state.song.title)}-cover.png`);
    toast('Cover art exported');
  }, 'image/png');
}

async function doShare() {
  const url = shareUrl(state.presets, state.seed);
  const text = `${state.song?.title ?? 'A song'} — made with MusicGen`;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'MusicGen', text, url });
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
    console.error(err);
    toast('Could not save to the library');
  }
}

async function openLibrary() {
  els.libraryList.innerHTML = '';
  try {
    const items = await libraryList();
    if (!items.length) els.libraryList.textContent = 'Nothing saved yet.';
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'lib-item';
      const label = document.createElement('div');
      label.innerHTML = `<strong>${escapeHtml(it.title)}</strong><br><small>${escapeHtml(it.style)} · ${escapeHtml(it.mood)} · ${it.bpm} BPM</small>`;
      const load = document.createElement('button');
      load.textContent = 'Load';
      load.addEventListener('click', () => {
        pushHistory();
        state.presets = normalisePresets({ ...state.presets, ...it.presets });
        state.seed = it.seed;
        syncControls();
        generate();
        els.library.close();
      });
      const del = document.createElement('button');
      del.textContent = '✕';
      del.setAttribute('aria-label', `Delete ${it.title}`);
      del.addEventListener('click', async () => {
        await libraryDelete(it.id);
        row.remove();
      });
      row.append(label, load, del);
      els.libraryList.appendChild(row);
    }
  } catch (err) {
    console.error(err);
    els.libraryList.textContent = 'Library unavailable.';
  }
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
  els.generate.addEventListener('click', () => generate());
  els.random.addEventListener('click', doRandom);
  els.evolve.addEventListener('click', doEvolve);
  els.mutate.addEventListener('click', doMutate);

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
    if (act === 'art') exportArt();
    if (act === 'share') doShare();
    if (act === 'undo') undo();
    if (act === 'redo') redo();
    if (act === 'library') openLibrary();
    if (act === 'help') els.help.showModal();
  });

  $('exportwav').addEventListener('click', exportWav);
  $('exportmidi').addEventListener('click', exportMidi);
  $('stems').addEventListener('click', exportStems);
  $('art').addEventListener('click', exportArt);
  $('share').addEventListener('click', doShare);
  $('save').addEventListener('click', doSave);
  els.seed.addEventListener('click', doShare);

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
    else if (k === 'u') toggleMute();
    else if (k === 'v') setVizMode(VIZ_MODES[(VIZ_MODES.indexOf(vizMode) + 1) % VIZ_MODES.length]);
    else if (k === 'escape') { stop(); els.sheet.hidden = true; }
    else if (k === '?') els.help.showModal();
    else if (k === 'l') {
      const focused = document.activeElement?.dataset?.lock;
      if (focused) toggleLock(focused);
    } else if ('123456'.includes(k)) {
      const map = { 1: els.style, 2: els.mood, 3: els.theme, 4: els.bpm, 5: els.type, 6: els.tech };
      map[k]?.focus();
    }
  });

  window.addEventListener('resize', () => drawViz(player?.position ?? 0));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopRaf();
    else if (player?.playing) startRaf();
    else setIdleAnimation();
  });
}

// ------------------------------------------------------------- boot
async function boot() {
  loadState();
  vizMode = VIZ_MODES.includes(state.ui.vizMode) ? state.ui.vizMode : 'roll';
  buildSelects();
  syncControls();
  wirePresets();
  wireActions();
  subscribe(() => syncControls());

  const hash = location.hash.match(/^#s=(.+)$/);
  if (hash) {
    const decoded = decodeState(hash[1]);
    if (decoded) {
      state.presets = normalisePresets({ ...DEFAULT_PRESETS, ...decoded.presets });
      state.seed = decoded.seed;
      syncControls();
    }
  }

  generate();
  if (vizMode === 'art') setIdleAnimation();

  const params = new URLSearchParams(location.search);
  if (params.get('action') === 'random') doRandom();
  if (params.get('action') === 'play') setTimeout(() => play(), 300);

  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('sw.js');
      if (!navigator.serviceWorker.controller) {
        navigator.serviceWorker.addEventListener('controllerchange', () => toast('Offline ready'));
      }
    } catch { /* offline install is a bonus */ }
  }
}

boot();
