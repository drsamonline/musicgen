// Shared UI context: the DOM map, the mutable singletons and the small
// helpers every other UI module needs. Nothing here renders anything.

export const $ = (id) => document.getElementById(id);

export const els = {
  play: $('play'), mute: $('mute'), themeToggle: $('themetoggle'), generate: $('generate'),
  random: $('random'), evolve: $('evolve'), mutate: $('mutate'), menu: $('menu'),
  ab: $('ab'), loop: $('loop'),
  title: $('title'), meta: $('meta'), seed: $('seed'), offline: $('offline'),
  viz: $('viz'), progressbar: $('progressbar'),
  style: $('style'), mood: $('mood'), theme: $('theme'), bpm: $('bpm'), texture: $('texture'),
  bpmout: $('bpmout'), type: $('type'), tech: $('tech'),
  timesig: $('timesig'), tempodrift: $('tempodrift'), tempodriftout: $('tempodriftout'),
  intensity: $('intensity'), intensityout: $('intensityout'),
  swing: $('swing'), swingout: $('swingout'), chaos: $('chaos'), chaosout: $('chaosout'),
  arp: $('arp'), lockdrums: $('lockdrums'), locklead: $('locklead'),
  microtuning: $('microtuning'), settings: $('settings'), settingsDialog: $('settings-dialog'),
  setTheme: $('set-theme'), setVolume: $('set-volume'), setVolumeOut: $('set-volumeout'),
  setTarget: $('set-target'), grooveGrid: $('groovegrid'), groovereset: $('groovereset'),
  volume: $('volume'), volumeout: $('volumeout'), reset: $('reset'),
  sections: $('sections'), summary: $('summary'), toast: $('toast'), live: $('live'), notice: $('notice'),
  sheet: $('menu-sheet'), help: $('help'), library: $('library'),
  libraryList: $('library-list'), searchlib: $('searchlib'), fileinput: $('fileinput'),
  midiinput: $('midiinput'), exporttarget: $('exporttarget'),
  planSections: $('plan-sections'), planKey: $('plan-key'), planEdited: $('plan-edited'),
  planReset: $('plan-reset'), planCopy: $('plan-copy'),
};

// Everything that changes at runtime lives here, so modules can share it
// without a framework and without circular `let` bindings.
// `window.__musicgen` is a deliberate debug handle: it lets the test harness
// (and a curious listener with devtools) inspect the live player.
export const app = {
  player: null,
  rafId: null,
  regenTimer: null,
  artClock: 0,
  wakeLock: null,
  artUrl: null,
  vizMode: 'roll',
  view: null,
  lastLufs: null,
  deferredInstall: null,
  announceNext: true,
  history: { past: [], future: [] },
};

export const VIZ_MODES = ['roll', 'bars', 'wave', 'art'];
export const THEME_MODES = ['system', 'light', 'dark'];
export const THEME_GLYPH = { system: '◐', light: '☀', dark: '☾' };

let toastTimer = null;
export function toast(msg) {
  if (!els.toast) return;
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2600);
}

export function notice(msg) {
  if (!els.notice) return;
  els.notice.textContent = msg;
  els.notice.hidden = !msg;
}

export function fail(what, err) {
  console.error(`[musicgen] ${what}`, err);
  toast(`${what} failed — ${err?.message || err}`);
}

export function slug(s) {
  return String(s || 'song').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'song';
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
