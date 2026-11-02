// Technology presets: which synthesis graph each track uses.
// Every instrument is synthesised at runtime. No samples anywhere.

const base = {
  attack: 0.01, decay: 0.18, sustain: 0.55, release: 0.35,
  cutoff: 3000, q: 1, wave: 'sawtooth', detune: 6, gain: 0.5, sat: 0.15,
  // filter envelope + velocity-to-timbre + analogue drift
  filterEnv: 0.35, filterAttack: 0.004, filterDecay: 0.16, velToCutoff: 0.5, drift: 1.2, glide: 0.045,
};

export const TECHS = {
  // No character at all: sines and a gentle filter, so the notes are the
  // only thing you hear.
  none: {
    id: 'none', name: 'None (clean)',
    instruments: {
      bass: { ...base, engine: 'subtractive', wave: 'sine', attack: 0.01, decay: 0.2, sustain: 0.7, release: 0.25, cutoff: 900, q: 0.7, detune: 0, sat: 0, gain: 0.5 },
      lead: { ...base, engine: 'subtractive', wave: 'sine', attack: 0.012, decay: 0.25, sustain: 0.6, release: 0.35, cutoff: 3200, q: 0.7, detune: 0, sat: 0, gain: 0.34 },
      chords: { ...base, engine: 'subtractive', wave: 'sine', attack: 0.05, decay: 0.4, sustain: 0.6, release: 0.6, cutoff: 2200, q: 0.7, detune: 0, sat: 0, gain: 0.24 },
      pad: { ...base, engine: 'subtractive', wave: 'sine', attack: 0.8, decay: 1, sustain: 0.7, release: 1.6, cutoff: 1600, q: 0.6, detune: 0, sat: 0, gain: 0.2 },
      arp: { ...base, engine: 'subtractive', wave: 'sine', attack: 0.008, decay: 0.14, sustain: 0.4, release: 0.2, cutoff: 3000, q: 0.7, detune: 0, sat: 0, gain: 0.24 },
    },
    drums: { engine: 'analog' },
  },
  analog: {
    id: 'analog', name: 'Analog',
    instruments: {
      bass: { ...base, engine: 'subtractive', wave: 'sawtooth', attack: 0.014, decay: 0.16, sustain: 0.6, release: 0.18, cutoff: 620, q: 5, octave: -12, sat: 0.35, gain: 0.62, filterEnv: 0.55, filterDecay: 0.12, velToCutoff: 0.9, drift: 3 },
      lead: { ...base, engine: 'subtractive', wave: 'sawtooth', attack: 0.02, decay: 0.22, sustain: 0.5, release: 0.3, cutoff: 2600, q: 3, detune: 9, gain: 0.34, filterEnv: 0.45, drift: 5 },
      chords: { ...base, engine: 'subtractive', wave: 'sawtooth', attack: 0.03, decay: 0.3, sustain: 0.5, release: 0.45, cutoff: 1800, q: 1.5, detune: 12, gain: 0.22 },
      pad: { ...base, engine: 'subtractive', wave: 'triangle', attack: 0.6, decay: 0.8, sustain: 0.7, release: 1.6, cutoff: 1200, q: 1, detune: 16, gain: 0.2, filterEnv: 0.18, drift: 6 },
    },
    drums: { engine: 'analog' },
  },
  fm: {
    id: 'fm', name: 'FM',
    instruments: {
      bass: { ...base, engine: 'fm', fmRatio: 1, fmIndex: 2.2, attack: 0.006, decay: 0.2, sustain: 0.4, release: 0.15, cutoff: 900, gain: 0.55 },
      lead: { ...base, engine: 'fm', fmRatio: 2, fmIndex: 1.6, attack: 0.01, decay: 0.3, sustain: 0.3, release: 0.4, cutoff: 3400, gain: 0.3 },
      chords: { ...base, engine: 'fm', fmRatio: 1.5, fmIndex: 0.9, attack: 0.03, decay: 0.35, sustain: 0.4, release: 0.5, cutoff: 2200, gain: 0.2 },
      pad: { ...base, engine: 'fm', fmRatio: 3, fmIndex: 0.5, attack: 0.7, decay: 1, sustain: 0.6, release: 1.8, cutoff: 1600, gain: 0.18 },
    },
    drums: { engine: 'fm' },
  },
  chiptune: {
    id: 'chiptune', name: 'Chiptune',
    instruments: {
      bass: { ...base, engine: 'chiptune', duty: 0.5, attack: 0.001, decay: 0.09, sustain: 0.7, release: 0.06, cutoff: 2000, gain: 0.5, filterEnv: 0, drift: 0, glide: 0 },
      lead: { ...base, engine: 'chiptune', duty: 0.25, attack: 0.001, decay: 0.08, sustain: 0.6, release: 0.05, cutoff: 6000, gain: 0.28, filterEnv: 0, drift: 0, glide: 0 },
      chords: { ...base, engine: 'chiptune', duty: 0.125, attack: 0.001, decay: 0.1, sustain: 0.5, release: 0.08, cutoff: 4000, gain: 0.16, filterEnv: 0, drift: 0 },
      pad: { ...base, engine: 'chiptune', duty: 0.5, attack: 0.05, decay: 0.2, sustain: 0.7, release: 0.3, cutoff: 2500, gain: 0.14, filterEnv: 0, drift: 0 },
    },
    drums: { engine: 'chiptune' },
  },
  additive: {
    id: 'additive', name: 'Additive',
    instruments: {
      bass: { ...base, engine: 'additive', harmonics: 8, attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.2, cutoff: 1500, gain: 0.5 },
      lead: { ...base, engine: 'additive', harmonics: 12, attack: 0.015, decay: 0.25, sustain: 0.45, release: 0.35, cutoff: 5000, gain: 0.26 },
      chords: { ...base, engine: 'additive', harmonics: 10, attack: 0.04, decay: 0.3, sustain: 0.45, release: 0.5, cutoff: 3000, gain: 0.2 },
      pad: { ...base, engine: 'formant', vowel: 'o', formantShift: 1, attack: 0.7, decay: 1, sustain: 0.65, release: 1.6, cutoff: 2400, gain: 0.2 },
    },
    drums: { engine: 'analog' },
  },
  wavetable: {
    id: 'wavetable', name: 'Wavetable',
    instruments: {
      bass: { ...base, engine: 'wavetable', frames: 4, attack: 0.008, decay: 0.18, sustain: 0.55, release: 0.18, cutoff: 800, gain: 0.55 },
      lead: { ...base, engine: 'wavetable', frames: 6, attack: 0.02, decay: 0.25, sustain: 0.5, release: 0.35, cutoff: 3200, gain: 0.3 },
      chords: { ...base, engine: 'wavetable', frames: 5, attack: 0.03, decay: 0.3, sustain: 0.45, release: 0.5, cutoff: 2400, gain: 0.2 },
      pad: { ...base, engine: 'wavetable', frames: 8, attack: 0.6, decay: 0.9, sustain: 0.65, release: 1.7, cutoff: 1500, gain: 0.18 },
    },
    drums: { engine: 'analog' },
  },
  physical: {
    id: 'physical', name: 'Physical',
    instruments: {
      bass: { ...base, engine: 'waveguide', damping: 0.3, brightness: 0.5, attack: 0.001, decay: 0.5, sustain: 0.2, release: 0.2, cutoff: 1600, gain: 0.55 },
      lead: { ...base, engine: 'waveguide', damping: 0.6, brightness: 0.8, attack: 0.001, decay: 0.8, sustain: 0.1, release: 0.5, cutoff: 4000, gain: 0.32 },
      chords: { ...base, engine: 'waveguide', damping: 0.7, brightness: 0.6, attack: 0.001, decay: 0.9, sustain: 0.1, release: 0.6, cutoff: 3000, gain: 0.22 },
      pad: { ...base, engine: 'additive', harmonics: 14, attack: 0.8, decay: 1.2, sustain: 0.6, release: 2, cutoff: 1400, gain: 0.15 },
    },
    drums: { engine: 'analog' },
  },
  noise: {
    id: 'noise', name: 'Noise/Drone',
    instruments: {
      bass: { ...base, engine: 'subtractive', wave: 'sine', attack: 0.3, decay: 0.6, sustain: 0.8, release: 1.2, cutoff: 400, q: 2, gain: 0.5 },
      lead: { ...base, engine: 'additive', harmonics: 6, attack: 0.4, decay: 0.8, sustain: 0.5, release: 1.4, cutoff: 2200, gain: 0.2 },
      chords: { ...base, engine: 'subtractive', wave: 'triangle', attack: 0.5, decay: 0.8, sustain: 0.6, release: 1.4, cutoff: 1200, gain: 0.18 },
      pad: { ...base, engine: 'granular', attack: 1.2, decay: 1.5, sustain: 0.7, release: 2.5, cutoff: 900, q: 3, gain: 0.22 },
    },
    drums: { engine: 'analog' },
  },
};

export const TECH_IDS = Object.keys(TECHS).filter((id) => id !== 'none');
