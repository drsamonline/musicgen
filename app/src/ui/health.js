// The audio health HUD: the numbers behind "it went quiet".
//
// It reads the player's counters every half second while it is open and does
// nothing at all while it is closed — a diagnostics panel that costs frames is
// a diagnostics panel that causes the problem it is measuring.
import { app, els, toast } from './ctx.js';
import { makeHealth, report, verdict } from '../audio/health.js';

let timer = null;

function playerHealth() {
  if (!app.player) return null;
  if (!app.player.health) app.player.health = makeHealth();
  return app.player.health;
}

function readout() {
  const p = app.player;
  const health = playerHealth() ?? makeHealth();
  return report(health, {
    ctx: p?.ctx ?? null,
    graph: p?.graph ?? null,
    clock: p ? (p.clockNode ? 'worklet' : 'timer') : 'none',
    playing: !!p?.playing,
    song: p?.song ?? null,
  });
}

const ROWS = [
  ['Context', (r) => r.state],
  ['Clock', (r) => (r.clock === 'worklet' ? 'audio thread' : r.clock === 'timer' ? 'main thread' : 'none')],
  ['Sample rate', (r) => (r.sampleRate ? `${(r.sampleRate / 1000).toFixed(1)} kHz` : '—')],
  ['Base latency', (r) => (r.sampleRate ? `${r.latencyMs} ms` : '—')],
  ['Voices', (r) => `${r.voices.active} / ${r.voices.max}`],
  ['Stolen', (r) => String(r.voices.stolen)],
  ['Ticks', (r) => String(r.ticks)],
  ['Worst tick gap', (r) => `${r.maxGapMs} ms`],
  ['Late notes', (r) => `${r.late}${r.late ? ` (worst ${r.maxLateMs} ms)` : ''}`],
  ['Dropped notes', (r) => String(r.skipped)],
  ['Voice failures', (r) => String(r.voices.dropped)],
  ['Clock stalls', (r) => String(r.stalls)],
  ['Rebuilds', (r) => `${r.recoveries}${r.lastRecovery ? ` (${r.lastRecovery})` : ''}`],
];

export function renderHealth() {
  const host = els.healthBody;
  if (!host) return;
  const r = readout();
  const v = verdict(r);

  if (els.healthVerdict) {
    els.healthVerdict.textContent = v.line;
    els.healthVerdict.dataset.level = v.level;
  }

  host.textContent = '';
  for (const [label, get] of ROWS) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = get(r);
    host.append(dt, dd);
  }
}

export function openHealth() {
  if (!els.healthDialog) return;
  renderHealth();
  if (typeof els.healthDialog.showModal === 'function') els.healthDialog.showModal();
  else els.healthDialog.hidden = false;
  clearInterval(timer);
  timer = setInterval(renderHealth, 500);
}

export function closeHealth() {
  clearInterval(timer);
  timer = null;
}

// The button that turns a dead app back into a playing one, for the case where
// the automatic path did not fire or the listener wants to force it.
export async function rebuildAudio() {
  const p = app.player;
  if (!p) { toast('Nothing to rebuild yet — press play'); return; }
  toast('Rebuilding audio…');
  const ok = await p.recover('manual');
  renderHealth();
  toast(ok ? 'Audio rebuilt' : 'Could not rebuild audio — reload the page');
}

export function resetHealth() {
  if (app.player) app.player.health = makeHealth();
  renderHealth();
  toast('Counters reset');
}
