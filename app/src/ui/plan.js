// The plan panel: the song's decisions, visible and editable.
//
// A generated song is six dials and a seed. This shows what those dials
// actually decided — the key, the sections and their chords — and lets you
// change your mind about the arrangement without leaving the seed behind.
// Every edit re-renders through the same `render()` the generator uses, so an
// edited song is as reproducible as a generated one.
import { state } from '../state.js';
import { plan, render, normalisePlan } from '../core/composer.js';
import {
  moveSection, duplicateSection, removeSection, setSectionBars, cycleChord, planSignature,
} from '../core/plan-edit.js';
import { els, app, toast, fail } from './ctx.js';
import { generate } from './generate.js';

// A plan belongs to the presets and seed that produced it. If either moves,
// the plan is stale and the song should be generated fresh — that is what
// makes "edited" safe to leave lying around in state.
export function sourceOf() {
  return `${JSON.stringify(state.presets)}|${state.seed}`;
}

export function ensurePlan() {
  const src = sourceOf();
  if (!state.plan || state.planSource !== src) {
    state.plan = plan(state.presets, state.seed);
    state.planSource = src;
  }
  return state.plan;
}

export function isEdited() {
  if (!state.plan) return false;
  try {
    return planSignature(state.plan) !== planSignature(plan(state.presets, state.seed));
  } catch {
    return false;
  }
}

function apply(next, message) {
  state.plan = normalisePlan(next);
  state.planSource = sourceOf();
  generate({ keepPosition: true, announce: false });
  renderPlanPanel();
  if (message) toast(message);
}

export function resetPlan() {
  state.plan = null;
  state.planSource = null;
  generate({ keepPosition: true, announce: false });
  renderPlanPanel();
  toast('Back to the seed');
}

export async function copyPlanJson() {
  const text = JSON.stringify(ensurePlan(), null, 2);
  try {
    await navigator.clipboard.writeText(text);
    toast('Plan JSON copied');
  } catch {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'musicgen-plan.json';
    a.click();
    URL.revokeObjectURL(url);
    toast('Plan saved as JSON');
  }
}

// ------------------------------------------------------------- rendering
const NAMES = {
  intro: 'Intro', verse: 'Verse', chorus: 'Chorus', bridge: 'Bridge',
  outro: 'Outro', break: 'Break', loop: 'Loop', drone: 'Drone', A: 'A', B: 'B',
};

function el(tag, props = {}, kids = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'text') node.textContent = v;
    else if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const kid of kids) node.append(kid);
  return node;
}

export function renderPlanPanel() {
  const host = els.planSections;
  if (!host) return;
  const p = ensurePlan();
  const edited = isEdited();

  els.planKey.textContent = `${p.key.name} · ${p.bars} bars`;
  if (els.planEdited) els.planEdited.hidden = !edited;
  if (els.planReset) els.planReset.hidden = !edited;

  host.textContent = '';
  p.sections.forEach((sec, i) => {
    const head = el('div', { class: 'plan-sec-head' }, [
      el('span', { class: 'plan-name', text: NAMES[sec.name] ?? sec.name }),
      el('span', { class: 'plan-bars', text: `${sec.bars} bar${sec.bars === 1 ? '' : 's'}` }),
      el('span', { class: 'plan-key', text: `${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][sec.key.tonic]}` }),
    ]);

    const tools = el('div', { class: 'plan-tools' }, [
      el('button', { class: 'ghost tiny', 'data-act': 'up', 'data-i': i, 'aria-label': `Move ${NAMES[sec.name] ?? sec.name} earlier`, title: 'Move earlier', text: '↑' }),
      el('button', { class: 'ghost tiny', 'data-act': 'down', 'data-i': i, 'aria-label': `Move ${NAMES[sec.name] ?? sec.name} later`, title: 'Move later', text: '↓' }),
      el('button', { class: 'ghost tiny', 'data-act': 'bars-', 'data-i': i, 'aria-label': `Shorten ${NAMES[sec.name] ?? sec.name}`, title: 'Fewer bars', text: '−' }),
      el('button', { class: 'ghost tiny', 'data-act': 'bars+', 'data-i': i, 'aria-label': `Lengthen ${NAMES[sec.name] ?? sec.name}`, title: 'More bars', text: '+' }),
      el('button', { class: 'ghost tiny', 'data-act': 'dup', 'data-i': i, 'aria-label': `Repeat ${NAMES[sec.name] ?? sec.name}`, title: 'Repeat this section', text: '⧉' }),
      el('button', { class: 'ghost tiny', 'data-act': 'del', 'data-i': i, 'aria-label': `Remove ${NAMES[sec.name] ?? sec.name}`, title: 'Remove this section', text: '×' }),
    ]);

    const chords = el('div', { class: 'plan-chords' });
    // one chip per bar, but a four-bar loop repeated over eight bars is four
    // distinct chords shown once each, in order
    const seen = [];
    sec.chords.forEach((c, ci) => {
      const key = `${c.rootPc}:${c.quality}`;
      const count = seen.filter((x) => x === key).length;
      seen.push(key);
      if (count > 0) return;
      const chip = el('button', {
        class: 'chord', 'data-act': 'chord', 'data-i': i, 'data-c': ci,
        title: `${c.symbol} — click to change the chord quality`,
        'aria-label': `Bar ${ci + 1}: ${c.symbol}. Change chord quality`,
        text: c.symbol || `${c.roman || '?'}`,
      });
      chords.append(chip);
    });

    host.append(el('li', { class: 'plan-sec', 'data-i': i }, [head, tools, chords]));
  });
}

// --------------------------------------------------------------- events
export function wirePlan() {
  const host = els.planSections;
  if (!host) return;

  host.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const i = Number(btn.dataset.i);
    const p = ensurePlan();
    try {
      switch (btn.dataset.act) {
        case 'up': apply(moveSection(p, i, Math.max(0, i - 1))); break;
        case 'down': apply(moveSection(p, i, Math.min(p.sections.length - 1, i + 1))); break;
        case 'bars-': apply(setSectionBars(p, i, p.sections[i].bars - 4)); break;
        case 'bars+': apply(setSectionBars(p, i, p.sections[i].bars + 4)); break;
        case 'dup': apply(duplicateSection(p, i), 'Section repeated'); break;
        case 'del': apply(removeSection(p, i), 'Section removed'); break;
        case 'chord': apply(cycleChord(p, i, Number(btn.dataset.c), 1)); break;
        default: break;
      }
    } catch (err) {
      // a refusal (the last section, an empty plan) is a message, not a crash
      if (/a song needs a section/.test(String(err.message))) toast('A song needs at least one section');
      else fail('Plan edit', err);
    }
  });

  els.planReset?.addEventListener('click', resetPlan);
  els.planCopy?.addEventListener('click', copyPlanJson);
}
