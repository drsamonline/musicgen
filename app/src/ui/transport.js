// Transport and platform: the player lifecycle, play/pause/stop, loop points,
// A/B, wake lock, MediaSession, install prompt and the offline badge.
import { state, persist } from '../state.js';
import { Player } from '../audio/engine.js';
import { drawArtwork } from '../export/artwork.js';
import { els, app, toast, fail } from './ctx.js';
import { drawViz, setVizMode, stopRaf, startRaf } from './visuals.js';
import { renderSections, snapshot } from './generate.js';
import { syncControls } from './dials.js';

// ------------------------------------------------------------- playback
export function ensurePlayer() {
  if (!app.player) {
    app.player = new Player(state.song);
    app.player.onTick = (pos) => {
      els.progressbar.style.width = `${Math.min(100, (pos / Math.max(0.001, state.song.durationSec)) * 100)}%`;
      markSection(pos);
    };
    app.player.onEnd = () => { els.play.textContent = '▶'; stopRaf(); releaseWakeLock(); };
  }
  return app.player;
}

export function applyVolume() {
  const v = state.ui.muted ? 0 : (state.ui.volume ?? 0.9);
  app.player?.setVolume(v);
}

export async function play() {
  ensurePlayer();
  try {
    // swap the song inside the same context first, and await it: scheduling
    // into a graph that is about to be replaced is how a regenerate goes silent
    if (app.player.song !== state.song) await app.player.setSong(state.song);
    await app.player.play();
  } catch (err) {
    // A closed or exhausted AudioContext is unrecoverable in place; build a
    // fresh player once and try again rather than leaving the app silent.
    console.warn('[musicgen] playback failed, rebuilding the audio context', err);
    try { await app.player.close(); } catch { /* noop */ }
    app.player = new Player(state.song);
    app.player.onTick = (pos) => {
      els.progressbar.style.width = `${Math.min(100, (pos / Math.max(0.001, state.song.durationSec)) * 100)}%`;
      markSection(pos);
    };
    app.player.onEnd = () => { els.play.textContent = '▶'; stopRaf(); releaseWakeLock(); };
    await app.player.play();
  }
  applyVolume();
  els.play.textContent = '⏸';
  startRaf();
  requestWakeLock();
  if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing';
}

export function pause() {
  if (!app.player) return;
  app.player.pause();
  els.play.textContent = '▶';
  stopRaf();
  releaseWakeLock();
  drawViz(app.player.position);
  if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused';
}

export function stop() {
  if (!app.player) return;
  app.player.stop();
  els.play.textContent = '▶';
  els.progressbar.style.width = '0%';
  stopRaf();
  releaseWakeLock();
  drawViz(0);
  if (navigator.mediaSession) navigator.mediaSession.playbackState = 'none';
}

export function markSection(posSec) {
  if (!state.song) return;
  const beat = (posSec * state.song.bpm) / 60;
  for (const btn of els.sections.children) {
    const bar = Number(btn.dataset.bar);
    const sec = state.song.sections.find((s) => s.bar === bar);
    const active = sec && beat >= sec.bar * state.song.beatsPerBar && beat < (sec.bar + sec.bars) * state.song.beatsPerBar;
    btn.classList.toggle('active', !!active);
  }
}

export function currentSection(posSec) {
  if (!state.song) return null;
  const beat = (posSec * state.song.bpm) / 60;
  return state.song.sections.find((s) => beat >= s.bar * state.song.beatsPerBar
    && beat < (s.bar + s.bars) * state.song.beatsPerBar) || null;
}

export function setLoopFor(sec) {
  if (!app.player || !sec || !state.song) return;
  const map = tempoMapOf(state.song);
  app.player.setLoop(
    map.secondsAt(sec.bar * state.song.beatsPerBar),
    map.secondsAt((sec.bar + sec.bars) * state.song.beatsPerBar),
  );
  syncControls();
}

export function toggleLoop() {
  if (!app.player) ensurePlayer();
  if (app.player.loop) {
    app.player.setLoop(null);
    toast('Loop off');
  } else {
    const sec = currentSection(app.player.position) || state.song.sections[0];
    setLoopFor(sec);
    toast(`Looping ${sec.name}`);
  }
  syncControls();
}

export function toggleAB() {
  if (!state.previous) { toast('No previous song yet'); return; }
  const cur = { presets: snapshot(), seed: state.seed };
  state.showingPrevious = !state.showingPrevious;
  const target = state.showingPrevious ? state.previous : cur;
  state.previous = state.showingPrevious ? cur : state.previous;
  const wasPlaying = app.player?.playing;
  if (wasPlaying) pause();
  state.presets = normalisePresets(target.presets);
  state.seed = target.seed;
  syncControls();
  generate({ announce: false });
  if (wasPlaying) play();
  toast(state.showingPrevious ? 'A — previous song' : 'B — current song');
}

// ------------------------------------------------------------- platform
export async function requestWakeLock() {
  try {
    if ('app.wakeLock' in navigator) app.wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* not supported or denied */ }
}

export function releaseWakeLock() {
  try { app.wakeLock?.release(); } catch { /* already gone */ }
  app.wakeLock = null;
}

export function updateMediaSession() {
  if (!navigator.mediaSession || !state.song) return;
  const s = state.song;
  try {
    if (!app.artUrl || updateMediaSession.seed !== s.seed) {
      const canvas = document.createElement('canvas');
      drawArtwork(canvas, s, 512);
      app.artUrl = canvas.toDataURL('image/png');
      updateMediaSession.seed = s.seed;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: s.title,
      artist: `MusicGen · ${STYLES[s.style]?.name ?? ''}`.trim(),
      album: `${s.key.name} · ${s.bpm} BPM`,
      artwork: [{ src: app.artUrl, sizes: '512x512', type: 'image/png' }],
    });
    navigator.mediaSession.setActionHandler('play', () => play());
    navigator.mediaSession.setActionHandler('pause', () => pause());
    navigator.mediaSession.setActionHandler('nexttrack', () => doRandom());
  } catch { /* MediaSession is a bonus */ }
}

export function wireInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    app.deferredInstall = e;
    els.offline.textContent = 'install';
    els.offline.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    app.deferredInstall = null;
    toast('Installed — it works offline now');
    markOfflineReady();
  });
  els.offline.addEventListener('click', async () => {
    if (app.deferredInstall) {
      app.deferredInstall.prompt();
      const choice = await app.deferredInstall.userChoice;
      if (choice.outcome === 'accepted') toast('Installing…');
      app.deferredInstall = null;
      return;
    }
    markOfflineReady();
    toast(navigator.serviceWorker?.controller ? 'Offline ready' : 'Install from your browser menu');
  });
}

export async function doInstall() {
  if (app.deferredInstall) {
    app.deferredInstall.prompt();
    app.deferredInstall = null;
  } else {
    toast('Use your browser menu → Install / Add to Home Screen');
  }
}

export function markOfflineReady() {
  if (!navigator.serviceWorker?.controller) return;
  els.offline.textContent = 'offline ready';
  els.offline.hidden = false;
  els.offline.title = 'The whole app is cached — it runs with the network off';
}

export function auditionNote(note) {
  try {
    ensurePlayer();
    if (app.player.ctx.state === 'suspended') app.player.ctx.resume();
    const track = note.track === 'drums' ? 'lead' : note.track;
    const spec = app.player.graph.tech.instruments[track] || app.player.graph.tech.instruments.lead;
    const when = app.player.ctx.currentTime + 0.02;
    synthVoice(app.player.ctx, app.player.graph.tracks[track].input, {
      when, dur: 0.4, freq: freqOf(note.p), vel: 0.85, spec, brightness: 0.95,
    });
    els.live.textContent = `Note ${note.p}, ${note.track}`;
  } catch (err) {
    fail('Audition', err);
  }
}

export function zoomRoll(factor) {
  if (!state.song) return;
  const totalBeats = state.song.bars * state.song.beatsPerBar;
  const base = app.view || { start: Math.max(0, ((app.player?.position ?? 0) * state.song.bpm) / 60 - 11), span: 32 };
  const span = Math.max(4, Math.min(totalBeats, base.span * factor));
  const centre = base.start + base.span / 2;
  app.view = { start: Math.max(0, Math.min(Math.max(0, totalBeats - span), centre - span / 2)), span };
  drawViz(app.player?.position ?? 0);
}
