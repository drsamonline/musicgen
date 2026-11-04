// Generation: history, the compose call itself, and the three readouts that
// describe a song (meta line, section timeline, screen-reader summary).
import { state, persist, emit } from '../state.js';
import { compose, render, DEFAULT_PRESETS, normalisePresets } from '../core/composer.js';
import { tempoMapOf } from '../audio/engine.js';
import { describeTempo } from '../core/tempo.js';
import { validateSong } from '../core/validate.js';
import { STYLES } from '../presets/styles.js';
import { MOODS } from '../presets/moods.js';
import { els, app, toast, fail } from './ctx.js';
import { drawViz } from './visuals.js';
import { syncControls } from './dials.js';
import { updateMediaSession, play } from './transport.js';

export function snapshot() {
  return JSON.parse(JSON.stringify(state.presets));
}

export function pushHistory() {
  app.history.past.push(snapshot());
  if (app.history.past.length > 50) app.history.past.shift();
  app.history.future.length = 0;
}

export function undo() {
  const prev = app.history.past.pop();
  if (!prev) { toast('Nothing to undo'); return; }
  app.history.future.push(snapshot());
  state.presets = normalisePresets(prev);
  syncControls();
  generate();
  toast('Undone');
}

export function redo() {
  const next = app.history.future.pop();
  if (!next) { toast('Nothing to redo'); return; }
  app.history.past.push(snapshot());
  state.presets = normalisePresets(next);
  syncControls();
  generate();
  toast('Redone');
}

// ------------------------------------------------------------- generate
export function generate({ keepPosition = false, announce = true } = {}) {
  const wasPlaying = app.player?.playing;
  if (wasPlaying) { app.player.pause(); els.play.textContent = '▶'; }
  try {
    const t0 = performance.now();
    // A plan is only good for the presets and seed it came from. If either has
    // moved, the edit is stale and the seed generates the song.
    const source = `${JSON.stringify(state.presets)}|${state.seed}`;
    const usePlan = state.plan && state.planSource === source;
    if (!usePlan) { state.plan = null; state.planSource = null; }
    state.song = usePlan ? render(state.plan) : compose(state.presets, state.seed);
    const ms = Math.round(performance.now() - t0);
    const check = validateSong(state.song);
    renderMeta(ms, check);
    renderSections();
    renderSummary();
    drawViz(keepPosition ? app.player?.position ?? 0 : 0);
    updateMediaSession();
    app.announceNext = announce;
    emit('song');
    if (wasPlaying) play();
  } catch (err) {
    fail('Compose', err);
  }
}

export function renderMeta(ms = null, check = null) {
  const s = state.song;
  if (!s) return;
  els.title.textContent = s.title;
  const tempo = s.tempo ? describeTempo(tempoMapOf(s)) : `${s.bpm} BPM`;
  const bits = [s.key.name, tempo, `${s.bars} bars`, STYLES[s.style]?.name, MOODS[s.mood]?.name];
  els.meta.textContent = bits.join(' · ');
  els.seed.textContent = `#${s.seed.slice(0, 6)}`;
  els.seed.title = `${s.totalNotes} notes${ms != null ? ` · composed in ${ms} ms` : ''}`;
  if (app.announceNext) {
    els.live.textContent = `New song: ${s.title}, ${s.key.name}, ${s.tempo ? describeTempo(tempoMapOf(s)) : `${s.bpm} BPM`}`;
  }
  if (check && !check.ok) console.warn('theory validation', check.issues);
}

export function renderSections() {
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
      if (app.player?.playing) app.player.play(at);
      else { ensurePlayer(); app.player.startPos = at; drawViz(at); }
      if (app.player?.loop) setLoopFor(sec);
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

export function renderSummary() {
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

export function debouncedGenerate() {
  clearTimeout(app.regenTimer);
  app.regenTimer = setTimeout(() => generate({ keepPosition: true, announce: false }), 400);
}
