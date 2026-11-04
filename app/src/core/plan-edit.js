// Editing a plan.
//
// The plan is the song's decisions, so this is where a person changes their
// mind: move a section, repeat the chorus, shorten the intro, swap a chord.
// Every function here is pure — it takes a plan, returns a new plan, and never
// touches the input — so an edit is a value you can undo, serialise or throw
// away. `render()` does the rest.
//
// Two rules keep an edit honest:
//   * bar numbers are rebased from the section order, never trusted;
//   * a chord edit rewrites the symbol, the pitch classes, the intervals and
//     the voicing together, so a plan can never read "Amaj9" while sounding
//     like Dm.
import { normalisePlan, PLAN_VERSION } from './composer.js';
import { voiceProgression } from './voicing.js';
import { chordPcs, chordSymbol, romanNumeral, scaleOf, CHORD_INTERVALS } from './theory.js';
import { MOODS } from '../presets/moods.js';
import { STYLES, STYLE_EXTRAS } from '../presets/styles.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

function styleOf(presets) {
  return { ...STYLES[presets.style], ...(STYLE_EXTRAS[presets.style] || {}) };
}

// Rebase every bar number from the section order. Voicings are left alone:
// moving a section must move it, not re-voice the whole song.
function reflow(plan) {
  let bar = 0;
  const sections = plan.sections.map((s, i) => {
    const from = Number(s.bar ?? 0);
    const bars = Math.max(1, Math.round(s.bars));
    const chords = s.chords.map((c) => {
      const rootPc = ((c.rootPc ?? 0) | 0) % 12;
      const quality = c.quality ?? 'maj';
      return {
        ...c,
        bar: bar + (Number(c.bar ?? from) - from),
        rootPc,
        quality,
        pcs: chordPcs({ rootPc, quality }),
      };
    });
    const sec = { ...s, index: i, bar, bars, chords };
    bar += bars;
    return sec;
  });
  return {
    ...plan,
    planVersion: PLAN_VERSION,
    sections,
    bars: bar,
    totalBeats: bar * plan.beatsPerBar,
    aliases: sections.map((s, i) => plan.aliases?.[i] ?? i),
  };
}

// Move the section at `from` so that it sits at `to` in the running order.
export function moveSection(plan, from, to) {
  const p = normalisePlan(clone(plan));
  if (from === to) return p;
  if (from < 0 || from >= p.sections.length) throw new Error('moveSection: from out of range');
  if (to < 0 || to >= p.sections.length) throw new Error('moveSection: to out of range');
  const sections = p.sections.slice();
  const [moved] = sections.splice(from, 1);
  sections.splice(to, 0, moved);
  // the alias travels with the section, so a repeated chorus stays the same
  // chorus rather than becoming whatever now sits in that slot
  const aliases = p.aliases.slice();
  const [alias] = aliases.splice(from, 1);
  aliases.splice(to, 0, alias);
  return reflow({ ...p, sections, aliases });
}

// Repeat the section at `index`, immediately after itself.
export function duplicateSection(plan, index) {
  const p = normalisePlan(clone(plan));
  if (index < 0 || index >= p.sections.length) throw new Error('duplicateSection: out of range');
  const sections = p.sections.slice();
  sections.splice(index + 1, 0, clone(p.sections[index]));
  const aliases = p.aliases.slice();
  aliases.splice(index + 1, 0, p.aliases[index]);
  return reflow({ ...p, sections, aliases });
}

// Remove a section. A song needs at least one, so the last one cannot go.
export function removeSection(plan, index) {
  const p = normalisePlan(clone(plan));
  if (p.sections.length <= 1) throw new Error('removeSection: a song needs a section');
  if (index < 0 || index >= p.sections.length) throw new Error('removeSection: out of range');
  const sections = p.sections.slice();
  sections.splice(index, 1);
  const aliases = p.aliases.slice();
  aliases.splice(index, 1);
  return reflow({ ...p, sections, aliases });
}

// Set how many bars a section runs for.
export function setSectionBars(plan, index, bars) {
  const p = normalisePlan(clone(plan));
  if (index < 0 || index >= p.sections.length) throw new Error('setSectionBars: out of range');
  const n = Math.max(1, Math.min(64, Math.round(Number(bars) || 1)));
  const sec = p.sections[index];
  // The chord list has to cover every bar, or the plan claims harmony the
  // audio does not have: a longer section repeats its progression, exactly as
  // render() does when it walks `bar % chords.length`.
  const chords = [];
  for (let i = 0; i < n; i++) {
    const src = sec.chords[i % sec.chords.length];
    chords.push({ ...src, bar: sec.bar + i });
  }
  const sections = p.sections.slice();
  sections[index] = { ...sec, bars: n, chords };
  return reflow({ ...p, sections });
}

// The roman numeral for a chord in a key, or '' when the chord is borrowed
// from outside the scale — better an empty label than a wrong one.
function romanFor(rootPc, quality, key) {
  const scale = scaleOf(key.mode);
  const rel = (((rootPc - key.tonic) % 12) + 12) % 12;
  const degree = scale.indexOf(rel);
  if (degree < 0) return '';
  return romanNumeral({ degree, quality });
}

// Change one chord. `rootPc` and `quality` are enough: the symbol, the pitch
// classes and the intervals are derived, never carried over from before.
export function setChord(plan, sectionIndex, chordIndex, patch = {}) {
  const p = normalisePlan(clone(plan));
  const sec = p.sections[sectionIndex];
  if (!sec) throw new Error('setChord: no such section');
  const chord = sec.chords[chordIndex];
  if (!chord) throw new Error('setChord: no such chord');

  const rootPc = patch.rootPc == null ? chord.rootPc : ((Number(patch.rootPc) % 12) + 12) % 12;
  const quality = patch.quality ?? chord.quality;
  const intervals = CHORD_INTERVALS[quality];
  if (!intervals) throw new Error(`setChord: unknown quality ${quality}`);

  const next = {
    ...chord,
    rootPc,
    quality,
    intervals,
    pcs: chordPcs({ rootPc, quality }),
    symbol: chordSymbol({ rootPc, quality }),
    roman: romanFor(rootPc, quality, sec.key ?? p.key),
  };

  // Re-voice this section only, so the new chord is led into rather than
  // dropped in, and the rest of the song keeps the voicings it had.
  const style = styleOf(p.presets);
  const mood = MOODS[p.presets.mood] ?? {};
  const chords = sec.chords.slice();
  chords[chordIndex] = next;
  const voiced = voiceProgression(
    chords.map((c) => ({ ...c })),
    {
      lo: 52 + (mood.register < 0 ? -4 : 0),
      hi: 76 + (mood.register > 0 ? 4 : 0),
      count: style.voiceCount ?? 4,
      strategy: style.voicing ?? 'close',
    },
  );

  const sections = p.sections.slice();
  sections[sectionIndex] = {
    ...sec,
    chords: voiced.map((c) => ({ ...c, pcs: chordPcs(c) })),
  };
  return reflow({ ...p, sections });
}

// Step a chord's quality through the common ones: the fastest way to try
// "what if this were the relative minor instead".
export function cycleChord(plan, sectionIndex, chordIndex, steps = 1) {
  const p = normalisePlan(clone(plan));
  const chord = p.sections[sectionIndex]?.chords[chordIndex];
  if (!chord) throw new Error('cycleChord: no such chord');
  const order = ['maj', 'min', 'min7', 'maj7', 'dom7', 'dim', 'sus4', 'aug'];
  const at = Math.max(0, order.indexOf(chord.quality));
  const quality = order[(at + steps + order.length * 4) % order.length];
  return setChord(p, sectionIndex, chordIndex, { quality });
}

// A stable description of the musical content, used to tell whether a plan
// still matches the one its seed would generate.
export function planSignature(plan) {
  const p = normalisePlan(clone(plan));
  return p.sections
    .map((s) => `${s.name}:${s.bars}:${s.chords.map((c) => `${c.rootPc}${c.quality}`).join(',')}`)
    .join('|');
}
