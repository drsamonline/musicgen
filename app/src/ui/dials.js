// The preset dials: selects, sliders, locks, random/evolve/mutate and the
// 16-step groove editor. Everything that changes what the composer is asked for.
import { state, setPresets, persist, emit } from '../state.js';
import { Rng, randomSeed } from '../core/rng.js';
import { normalisePresets, DEFAULT_PRESETS } from '../core/composer.js';
import { randomPresets } from '../presets/compatibility.js';
import { STYLES } from '../presets/styles.js';
import { MOODS } from '../presets/moods.js';
import { THEMES } from '../presets/themes.js';
import { TYPES } from '../presets/types.js';
import { TECHS } from '../presets/techs.js';
import { els, app, $, toast } from './ctx.js';
import { generate, debouncedGenerate, pushHistory, snapshot } from './generate.js';
import { applyTheme } from './visuals.js';
import { openSettings } from './exporters.js';
import { setVizMode } from './visuals.js';

// ------------------------------------------------------------- boot
export function fillSelect(sel, items, selected) {
  sel.innerHTML = '';
  for (const it of items) {
    const o = document.createElement('option');
    o.value = it.id;
    o.textContent = it.name;
    if (it.id === selected) o.selected = true;
    sel.appendChild(o);
  }
}

export function buildSelects() {
  fillSelect(els.style, Object.values(STYLES), state.presets.style);
  fillSelect(els.mood, Object.values(MOODS), state.presets.mood);
  fillSelect(els.theme, Object.values(THEMES), state.presets.theme);
  fillSelect(els.type, Object.values(TYPES), state.presets.type);
  fillSelect(els.tech, Object.values(TECHS), state.presets.tech);
}

export function syncControls() {
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
  els.loop.setAttribute('aria-pressed', String(!!app.player?.loop));
  els.ab.setAttribute('aria-pressed', String(!!state.showingPrevious));
  for (const btn of document.querySelectorAll('.lock')) {
    btn.setAttribute('aria-pressed', state.locks[btn.dataset.lock] ? 'true' : 'false');
    btn.textContent = state.locks[btn.dataset.lock] ? '🔒' : '🔓';
  }
  for (const btn of document.querySelectorAll('[data-viz]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.viz === app.vizMode));
  }
}

// ------------------------------------------------------------- presets
export function wirePresets() {
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

export function doRandom() {
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
export function flashDials(keys) {
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

export function doEvolve() {
  pushHistory();
  state.previous = { presets: snapshot(), seed: state.seed };
  state.seed = randomSeed(12);
  syncControls();
  generate();
}

export function doMutate() {
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

export function toggleMute() {
  state.ui.muted = !state.ui.muted;
  applyVolume();
  syncControls();
  emit('ui');
  toast(state.ui.muted ? 'Muted' : 'Sound on');
}

// ------------------------------------------------------------- groove editor
const GROOVE_KINDS = ['kick', 'snare', 'hat'];

export function currentGroove() {
  const style = STYLES[state.presets.style];
  const base = state.presets.grooveOverride || style?.groove || {};
  const out = {};
  for (const kind of GROOVE_KINDS) {
    const grid = base[kind] || style?.groove?.[kind] || new Array(16).fill(0);
    out[kind] = Array.from({ length: 16 }, (_, i) => (grid[Math.round((i / 16) * grid.length)] ? 1 : 0));
  }
  return out;
}

export function renderGroove() {
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
