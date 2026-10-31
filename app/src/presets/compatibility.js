// Compatibility engine: which combinations are musically sane.
// Random samples through this, which is the difference between
// "generative" and "broken".
import { STYLES } from './styles.js';
import { MOODS } from './moods.js';
import { THEMES } from './themes.js';
import { TECH_IDS } from './techs.js';

// style -> { moods: {id: weight}, techs: {id: weight}, themes: [ids] }
const TABLE = {
  lofi: {
    moods: { melancholy: 3, calm: 2, dreamy: 2, sad: 2, hopeful: 1, happy: 1 },
    techs: { analog: 3, wavetable: 2, fm: 1, additive: 1 },
    themes: ['rain', 'nightdrive', 'winter', 'forest', 'space'],
  },
  cinematic: {
    moods: { epic: 3, tense: 2, dark: 2, sad: 2, hopeful: 1, dreamy: 1 },
    techs: { physical: 3, additive: 2, noise: 2, analog: 1 },
    themes: ['space', 'winter', 'desert', 'medieval', 'ocean'],
  },
  edm: {
    moods: { happy: 2, epic: 3, playful: 2, tense: 1, hopeful: 1 },
    techs: { analog: 3, wavetable: 3, fm: 1, additive: 1 },
    themes: ['festival', 'cyberpunk', 'nightdrive', 'space'],
  },
  ambient: {
    moods: { calm: 3, dreamy: 3, sad: 1, melancholy: 2, hopeful: 1 },
    techs: { noise: 3, additive: 2, physical: 2, analog: 1 },
    themes: ['space', 'ocean', 'forest', 'winter', 'rain'],
  },
  jazz: {
    moods: { happy: 2, playful: 2, melancholy: 2, hopeful: 2, tense: 1, calm: 1 },
    techs: { analog: 3, physical: 3, fm: 1 },
    themes: ['nightdrive', 'rain', 'medieval'],
  },
  chiptune: {
    moods: { happy: 3, playful: 3, epic: 2, hopeful: 1, tense: 1 },
    techs: { chiptune: 6, fm: 1 },
    themes: ['cyberpunk', 'festival', 'space', 'forest'],
  },
  trap: {
    moods: { dark: 3, tense: 2, epic: 2, melancholy: 1 },
    techs: { analog: 2, fm: 3, wavetable: 2, chiptune: 1 },
    themes: ['nightdrive', 'cyberpunk', 'rain'],
  },
  rock: {
    moods: { epic: 3, happy: 2, tense: 2, hopeful: 2, dark: 1 },
    techs: { analog: 4, wavetable: 2, physical: 1 },
    themes: ['desert', 'nightdrive', 'festival', 'winter'],
  },
  folk: {
    moods: { hopeful: 3, calm: 2, happy: 2, melancholy: 2, sad: 1 },
    techs: { physical: 5, analog: 2, additive: 1 },
    themes: ['forest', 'winter', 'medieval', 'ocean'],
  },
  classical: {
    moods: { epic: 2, sad: 2, hopeful: 2, calm: 2, tense: 1, melancholy: 1 },
    techs: { physical: 3, additive: 3, analog: 1 },
    themes: ['medieval', 'winter', 'space'],
  },
  world: {
    moods: { playful: 3, happy: 2, epic: 2, tense: 1, hopeful: 1 },
    techs: { physical: 3, analog: 2, fm: 2, additive: 1 },
    themes: ['desert', 'festival', 'forest'],
  },
};

export function allowedMoods(styleId) {
  return Object.keys(TABLE[styleId]?.moods ?? {});
}
export function allowedTechs(styleId) {
  return Object.keys(TABLE[styleId]?.techs ?? {});
}
export function allowedThemes(styleId) {
  return TABLE[styleId]?.themes ?? Object.keys({ space: 1 });
}

export function moodWeights(styleId) {
  const m = TABLE[styleId]?.moods ?? {};
  const ids = Object.keys(m);
  return ids.map((id) => m[id]);
}
export function techWeights(styleId) {
  const t = TABLE[styleId]?.techs ?? {};
  const ids = Object.keys(t);
  return ids.map((id) => t[id]);
}

// Sample a full preset set through the compatibility table.
// `chaos` in [0,1] — the chance of ignoring the table entirely.
export function randomPresets(rng, { chaos = 0.15, bpmRange = [40, 200], locks = {} } = {}) {
  const styleIds = Object.keys(STYLES);
  const style = locks.style ? null : rng.pick(styleIds);
  const styleId = style ?? locks.styleValue ?? 'lofi';
  const bypass = rng.chance(chaos);
  const s = STYLES[styleId];

  const mood = locks.mood
    ? null
    : bypass
      ? rng.pick(Object.keys(MOODS))
      : rng.weighted(Object.keys(TABLE[styleId].moods), moodWeights(styleId));

  const tech = locks.tech
    ? null
    : bypass
      ? rng.pick(TECH_IDS)
      : rng.weighted(Object.keys(TABLE[styleId].techs), techWeights(styleId));

  const theme = locks.theme
    ? null
    : rng.pick(bypass ? Object.keys({ space: 1, ocean: 1, rain: 1, cyberpunk: 1, medieval: 1, forest: 1, nightdrive: 1, festival: 1, desert: 1, winter: 1 }) : allowedThemes(styleId));

  const lo = Math.max(bpmRange[0], s.bpm[0]);
  const hi = Math.min(bpmRange[1], s.bpm[1]);

  return {
    style: styleId,
    mood,
    tech,
    theme,
    bpm: Math.round(rng.range(lo, hi)),
  };
}
