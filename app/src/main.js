// App entry point: builds the selects, wires every control and boots.
// The work lives in ./ui — this file is wiring and nothing else.
import { state, loadState, persist, subscribe } from './state.js';
import { DEFAULT_PRESETS, normalisePresets, normalisePlan } from './core/composer.js';
import { decodeShare } from './export/artwork.js';
import { wirePlan, renderPlanPanel, sourceOf } from './ui/plan.js';
import { openHealth, closeHealth, rebuildAudio, resetHealth } from './ui/health.js';
import { startGamepads, stopGamepads, connectMidi, listPads, listMidiInputs, midiConnected, PAD_ACTIONS, PAD_LABELS } from './ui/controllers.js';
import { els, app, $, toast, notice, fail, VIZ_MODES, THEME_MODES } from './ui/ctx.js';
import { buildSelects, syncControls, wirePresets, renderGroove, toggleMute, doRandom, doEvolve, doMutate } from './ui/dials.js';
import { generate, renderMeta, renderSections, renderSummary } from './ui/generate.js';
import { ensurePlayer, play, pause, stop, toggleLoop, toggleAB, applyVolume, wireInstall, markOfflineReady, zoomRoll, auditionNote } from './ui/transport.js';
import { applyTheme, cycleTheme, setVizMode, wireRoll, stopRaf } from './ui/visuals.js';
import {
  exportWav, exportStems, exportMidi, exportJson, importJson, exportArt, doShare, doSave,
  exportLibrary, openLibrary, toggleRecord, openSettings, onFilePicked, onMidiPicked, exportXm } from './ui/exporters.js';

// ------------------------------------------------------------- wiring
function wireActions() {
  els.play.addEventListener('click', () => { if (app.player?.playing) pause(); else play(); });
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
    if (act === 'xm') exportXm();
    if (act === 'json') exportJson();
    if (act === 'import') importJson();
    if (act === 'art') exportArt();
    if (act === 'share') doShare();
    if (act === 'undo') undo();
    if (act === 'redo') redo();
    if (act === 'library') openLibrary();
    if (act === 'health') openHealth();
    if (act === 'controllers') openControllers();
    if (act === 'exportlib') exportLibrary();
    if (act === 'record') toggleRecord();
    if (act === 'importmidi') els.midiinput.click();
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
  els.midiinput.addEventListener('change', onMidiPicked);

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea, dialog')) return;
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); if (app.player?.playing) pause(); else play(); }
    else if (k === 'g') generate();
    else if (k === 'r') doRandom();
    else if (k === 'e') doEvolve();
    else if (k === 'm') doMutate();
    else if (k === 'b') toggleAB();
    else if (k === 'u') toggleMute();
    else if (k === 't') cycleTheme();
    else if (k === 'v') setVizMode(VIZ_MODES[(VIZ_MODES.indexOf(app.vizMode) + 1) % VIZ_MODES.length]);
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

  window.addEventListener('resize', () => drawViz(app.player?.position ?? 0));
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if ((state.ui.theme || 'system') === 'system') applyTheme('system');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopRaf();
    else if (app.player?.playing) startRaf();
    else setIdleAnimation();
  });
}

// A share link carries either the six dials and a seed, or — when the song has
// been edited — the whole plan. Both land here.
async function applySharedLink(encoded) {
  const decoded = await decodeShare(encoded);
  if (!decoded) return null;
  state.presets = normalisePresets({ ...DEFAULT_PRESETS, ...decoded.presets });
  state.seed = decoded.seed;
  if (decoded.plan) {
    try {
      state.plan = normalisePlan(decoded.plan);
      state.planSource = sourceOf();
    } catch {
      state.plan = null;
      state.planSource = null;
    }
  } else {
    state.plan = null;
    state.planSource = null;
  }
  return decoded;
}

// ------------------------------------------------------- controllers
// A gamepad and a MIDI keyboard both end up here, calling the same functions
// the buttons call. Nothing gets a second implementation.
function nudgeVolume(delta) {
  const next = Math.max(0, Math.min(1.5, Math.round(((state.ui.volume ?? 0.9) + delta) * 100) / 100));
  state.ui.volume = next;
  applyVolume();
  persist();
  syncControls();
}

function runPadAction(name) {
  switch (name) {
    case 'play': if (app.player?.playing) pause(); else play(); break;
    case 'generate': generate(); break;
    case 'random': doRandom(); break;
    case 'evolve': doEvolve(); break;
    case 'mutate': doMutate(); break;
    case 'vizNext': setVizMode(VIZ_MODES[(VIZ_MODES.indexOf(app.vizMode) + 1) % VIZ_MODES.length]); break;
    case 'volumeDown': nudgeVolume(-0.05); break;
    case 'volumeUp': nudgeVolume(0.05); break;
    case 'loop': toggleLoop(); break;
    case 'ab': toggleAB(); break;
    default: break;
  }
}

function onMidiAction(a) {
  if (a.type === 'noteon') auditionNote({ p: a.note, track: 'lead', v: a.velocity });
  else if (a.type === 'volume') {
    state.ui.volume = Math.max(0, Math.min(1.5, a.value * 1.5));
    applyVolume();
  }
}

function renderControllers() {
  if (!els.padStatus) return;
  const pads = listPads();
  els.padStatus.textContent = pads.length
    ? pads.map((p) => p.id || `gamepad ${p.index}`).join(', ')
    : 'None detected — press a button to wake one.';

  const inputs = listMidiInputs();
  els.midiList.textContent = '';
  if (!inputs.length) {
    const li = document.createElement('li');
    li.className = 'device-note';
    li.textContent = midiConnected() ? 'No MIDI inputs found.' : 'Not connected.';
    els.midiList.append(li);
  } else {
    for (const input of inputs) {
      const li = document.createElement('li');
      li.textContent = input.manufacturer ? `${input.name} — ${input.manufacturer}` : input.name;
      els.midiList.append(li);
    }
  }
}

function renderPadMap() {
  if (!els.padMap) return;
  els.padMap.textContent = '';
  for (const [button, action] of Object.entries(PAD_ACTIONS)) {
    const dt = document.createElement('dt');
    dt.textContent = `Button ${button}`;
    const dd = document.createElement('dd');
    dd.textContent = PAD_LABELS[action] || action;
    els.padMap.append(dt, dd);
  }
}

function openControllers() {
  renderControllers();
  renderPadMap();
  // polling only starts when someone opens this dialog
  startGamepads(runPadAction, { onChange: renderControllers });
  if (typeof els.controllersDialog.showModal === 'function') els.controllersDialog.showModal();
  else els.controllersDialog.hidden = false;
}

// ------------------------------------------------------------- boot
async function boot() {
  loadState();
  app.vizMode = VIZ_MODES.includes(state.ui.vizMode) ? state.ui.vizMode : 'roll';
  buildSelects();
  syncControls();
  wirePresets();
  wireActions();
  wireRoll();
  wireInstall();
  wirePlan();
  els.midiConnect?.addEventListener('click', async () => {
    try {
      els.midiConnect.disabled = true;
      els.midiConnect.textContent = 'Waiting for permission…';
      const inputs = await connectMidi(onMidiAction, { onChange: renderControllers });
      els.midiConnect.textContent = inputs.length ? 'Reconnect' : 'Connect a MIDI keyboard';
      els.midiConnect.disabled = false;
      renderControllers();
      toast(inputs.length ? `${inputs.length} MIDI input${inputs.length === 1 ? '' : 's'} connected` : 'No MIDI inputs found');
    } catch (err) {
      els.midiConnect.disabled = false;
      els.midiConnect.textContent = 'Connect a MIDI keyboard';
      toast('MIDI: ' + (err?.message || 'not available'));
    }
  });
  // the pad poll only runs while the dialog is open, like the health HUD
  els.controllersDialog?.addEventListener('close', stopGamepads);
  els.healthRebuild?.addEventListener('click', rebuildAudio);
  els.healthReset?.addEventListener('click', resetHealth);
  // the HUD polls only while it is open
  els.healthDialog?.addEventListener('close', closeHealth);
  els.healthDialog?.addEventListener('cancel', closeHealth);
  renderGroove();
  subscribe(() => syncControls());
  // the plan panel follows the song: a new seed, a preset change, an undo or a
  // link all produce a new plan, and the panel must show the one being heard
  subscribe((_state, reason) => { if (reason === 'song') renderPlanPanel(); });

  const hash = location.hash.match(/^#s=([~A-Za-z0-9_-]+)$/);
  if (hash) {
    const decoded = await applySharedLink(hash[1]);
    if (decoded) {
      syncControls();
      checkVersion(decoded.composerVersion, 'link');
    }
  }

  globalThis.__musicgen = { app, state };
  applyTheme(state.ui.theme || 'system', { redraw: false });
  generate();
  renderPlanPanel();

  if (!state.ui.seenIntro) {
    notice('Press ▶ to hear it · Random rolls new dials · Export takes the song to a DAW. '
      + 'Tap this line to dismiss.');
    els.notice.addEventListener('click', () => {
      notice('');
      state.ui.seenIntro = true;
      persist();
    }, { once: true });
  }
  if (app.vizMode === 'art') setIdleAnimation();

  // restore the last playback position (not playing — browsers want a gesture)
  if (state.ui.position > 1 && state.ui.position < (state.song?.durationSec ?? 0) - 2) {
    ensurePlayer();
    app.player.startPos = state.ui.position;
    drawViz(state.ui.position);
  }
  setInterval(() => {
    if (app.player && !app.player.playing && app.player.startPos > 0) {
      state.ui.position = app.player.startPos;
      persist();
    }
  }, 5000);

  const params = new URLSearchParams(location.search);
  if (params.get('action') === 'random') doRandom();
  if (params.get('action') === 'play') setTimeout(() => play(), 300);

  // share target: another app shared a link (or text) with us
  const shared = `${params.get('url') || ''} ${params.get('text') || ''}`;
  const sharedSeed = shared.match(/#s=([~A-Za-z0-9_-]+)/);
  if (sharedSeed) {
    const decoded = await applySharedLink(sharedSeed[1]);
    if (decoded) {
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
