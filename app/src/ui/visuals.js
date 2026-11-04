// Theme and the canvas: the four visualisers, the render loop, and the
// piano-roll interaction (zoom, pan, scrub, audition).
import { state, persist, emit } from '../state.js';
import {
  drawPianoRoll, drawBars, drawWaveform, drawArt, invalidatePalette, beatAtX, noteAt,
} from '../visual/pianoRoll.js';
import { drawTracker } from '../visual/tracker.js';
import { synthVoice } from '../audio/instruments.js';
import { freqOf } from '../core/theory.js';
import { els, app, VIZ_MODES, THEME_MODES, THEME_GLYPH, toast, fail } from './ctx.js';
import { syncControls } from './dials.js';

// ------------------------------------------------------------- theme
export function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme(pref, { redraw = true } = {}) {
  const next = THEME_MODES.includes(pref) ? pref : 'system';
  state.ui.theme = next;
  document.documentElement.dataset.theme = next;
  els.themeToggle.textContent = THEME_GLYPH[next];
  els.themeToggle.setAttribute('aria-label', `Colour theme: ${next}`);
  els.themeToggle.title = `Colour theme: ${next} (T)`;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolveTheme(next) === 'light' ? '#f2f4fa' : '#07080f');
  invalidatePalette();
  if (redraw) drawViz(app.player?.position ?? 0);
  persist();
}

export function cycleTheme() {
  const i = THEME_MODES.indexOf(state.ui.theme || 'system');
  const next = THEME_MODES[(i + 1) % THEME_MODES.length];
  applyTheme(next);
  toast(`Theme: ${next}`);
}

// ------------------------------------------------------------- app.history

// ------------------------------------------------------------- visual
export function drawViz(posSec = 0) {
  if (!state.song) return;
  const analyser = app.player?.graph?.analyser ?? null;
  if (app.vizMode === 'grid') drawTracker(els.viz, state.song, posSec);
  else if (app.vizMode === 'bars') drawBars(els.viz, analyser);
  else if (app.vizMode === 'wave') drawWaveform(els.viz, analyser);
  else if (app.vizMode === 'art') drawArt(els.viz, state.song, analyser, app.artClock);
  else drawPianoRoll(els.viz, state.song, posSec, app.view);
}

export function startRaf() {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fps = reduce ? 10 : 30;
  let last = 0;
  const loop = (t) => {
    if (!app.player?.playing) { app.rafId = null; return; }
    app.artClock = t;
    if (t - last > 1000 / fps) {
      last = t;
      drawViz(app.player.position);
      if (app.vizMode !== 'roll') markSection(app.player.position);
    }
    app.rafId = requestAnimationFrame(loop);
  };
  stopRaf();
  app.rafId = requestAnimationFrame(loop);
}

export function stopRaf() {
  if (app.rafId) cancelAnimationFrame(app.rafId);
  app.rafId = null;
}

export function setIdleAnimation() {
  if (app.vizMode !== 'art') return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { drawViz(app.player?.position ?? 0); return; }
  const loop = (t) => {
    if (app.vizMode !== 'art' || app.player?.playing) { app.rafId = null; return; }
    app.artClock = t;
    drawViz(app.player?.position ?? 0);
    app.rafId = requestAnimationFrame(loop);
  };
  stopRaf();
  app.rafId = requestAnimationFrame(loop);
}

export function setVizMode(mode) {
  app.vizMode = VIZ_MODES.includes(mode) ? mode : 'roll';
  state.ui.vizMode = app.vizMode;
  syncControls();
  emit('ui');
  drawViz(app.player?.position ?? 0);
  if (app.vizMode === 'art') setIdleAnimation();
}

// piano roll gestures: wheel zooms, drag pans, click scrubs
export function wireRoll() {
  let dragging = false;
  let dragStartX = 0;
  let dragStartView = null;

  els.viz.addEventListener('wheel', (e) => {
    if (app.vizMode !== 'roll' || !state.song) return;
    e.preventDefault();
    const totalBeats = state.song.bars * state.song.beatsPerBar;
    const base = app.view || { start: Math.max(0, ((app.player?.position ?? 0) * state.song.bpm) / 60 - 11), span: 32 };
    const factor = e.deltaY > 0 ? 1.18 : 0.85;
    const span = Math.max(4, Math.min(totalBeats, base.span * factor));
    const centre = base.start + base.span / 2;
    const start = Math.max(0, Math.min(Math.max(0, totalBeats - span), centre - span / 2));
    app.view = { start, span };
    drawViz(app.player?.position ?? 0);
  }, { passive: false });

  els.viz.addEventListener('pointerdown', (e) => {
    if (app.vizMode !== 'roll' || !state.song) return;
    dragging = true;
    dragStartX = e.clientX;
    dragStartView = app.view ? { ...app.view } : null;
    els.viz.setPointerCapture?.(e.pointerId);
  });

  els.viz.addEventListener('pointermove', (e) => {
    if (!dragging || !dragStartView || !state.song) return;
    const rect = els.viz.getBoundingClientRect();
    const beatsPerPx = dragStartView.span / Math.max(1, rect.width);
    const totalBeats = state.song.bars * state.song.beatsPerBar;
    const start = Math.max(0, Math.min(Math.max(0, totalBeats - dragStartView.span),
      dragStartView.start - (e.clientX - dragStartX) * beatsPerPx));
    app.view = { start, span: dragStartView.span };
    drawViz(app.player?.position ?? 0);
  });

  els.viz.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    const moved = Math.abs(e.clientX - dragStartX);
    if (moved > 6 || !state.song) return;

    // tapping a note auditions it; tapping empty space scrubs
    const hit = noteAt(els.viz, state.song, e.clientX, e.clientY, app.view);
    if (hit) { auditionNote(hit); return; }

    const beat = beatAtX(els.viz, state.song, e.clientX, app.view);
    const at = (beat * 60) / state.song.bpm;
    ensurePlayer();
    if (app.player.playing) app.player.play(at);
    else { app.player.startPos = at; drawViz(at); }
  });

  els.viz.addEventListener('dblclick', () => {
    app.view = null;
    drawViz(app.player?.position ?? 0);
    toast('Piano roll zoom reset');
  });
}
