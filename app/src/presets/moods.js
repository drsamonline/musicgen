// Mood presets: mode/scale, register, dynamics, tension bias.
export const MOODS = {
  // Neutral: no emotional bias at all, so the style decides.
  none: {
    id: 'none', name: 'None (neutral)',
    modes: [['ionian', 1], ['aeolian', 1], ['dorian', 1]],
    register: 0, velCurve: 0.6, tensionBias: 0,
    seventhBias: 0, add9Bias: 0, densityBias: 0, brightness: 0.5,
    restChance: 0.25, staccato: 0.25,
  },
  happy: {
    id: 'happy', name: 'Happy',
    modes: [['ionian', 3], ['lydian', 1], ['mixolydian', 1]],
    register: 1, velCurve: 0.75, tensionBias: 0.15,
    seventhBias: -0.2, add9Bias: 0.1, densityBias: 0.15, brightness: 0.75,
    restChance: 0.18, staccato: 0.3,
  },
  sad: {
    id: 'sad', name: 'Sad',
    modes: [['aeolian', 3], ['dorian', 1], ['phrygian', 1]],
    register: -1, velCurve: 0.5, tensionBias: -0.15,
    seventhBias: 0.1, add9Bias: 0.0, densityBias: -0.1, brightness: 0.35,
    restChance: 0.28, staccato: 0.15,
  },
  epic: {
    id: 'epic', name: 'Epic',
    modes: [['ionian', 2], ['aeolian', 2], ['harmonicMinor', 1], ['dorian', 1]],
    register: 2, velCurve: 0.9, tensionBias: 0.4,
    seventhBias: 0.0, add9Bias: 0.2, densityBias: 0.2, brightness: 0.7,
    restChance: 0.15, staccato: 0.25,
  },
  calm: {
    id: 'calm', name: 'Calm',
    modes: [['aeolian', 2], ['dorian', 2], ['ionian', 1], ['majorPent', 1]],
    register: 0, velCurve: 0.4, tensionBias: -0.25,
    seventhBias: 0.2, add9Bias: 0.2, densityBias: -0.3, brightness: 0.4,
    restChance: 0.35, staccato: 0.1,
  },
  dark: {
    id: 'dark', name: 'Dark',
    modes: [['aeolian', 2], ['phrygian', 2], ['locrian', 1], ['harmonicMinor', 1]],
    register: -2, velCurve: 0.55, tensionBias: 0.25,
    seventhBias: 0.15, add9Bias: -0.1, densityBias: -0.1, brightness: 0.25,
    restChance: 0.25, staccato: 0.2,
  },
  dreamy: {
    id: 'dreamy', name: 'Dreamy',
    modes: [['lydian', 2], ['ionian', 2], ['dorian', 1], ['majorPent', 1]],
    register: 1, velCurve: 0.5, tensionBias: -0.1,
    seventhBias: 0.3, add9Bias: 0.35, densityBias: -0.15, brightness: 0.6,
    restChance: 0.3, staccato: 0.1,
  },
  tense: {
    id: 'tense', name: 'Tense',
    modes: [['phrygian', 2], ['locrian', 1], ['harmonicMinor', 2], ['hijaz', 1]],
    register: 0, velCurve: 0.65, tensionBias: 0.5,
    seventhBias: 0.1, add9Bias: -0.15, densityBias: 0.1, brightness: 0.5,
    restChance: 0.2, staccato: 0.4,
  },
  playful: {
    id: 'playful', name: 'Playful',
    modes: [['mixolydian', 2], ['ionian', 2], ['majorPent', 2], ['lydian', 1]],
    register: 2, velCurve: 0.7, tensionBias: 0.2,
    seventhBias: -0.1, add9Bias: 0.15, densityBias: 0.3, brightness: 0.85,
    restChance: 0.2, staccato: 0.45,
  },
  melancholy: {
    id: 'melancholy', name: 'Melancholy',
    modes: [['aeolian', 3], ['dorian', 1], ['minorPent', 2]],
    register: -1, velCurve: 0.45, tensionBias: -0.1,
    seventhBias: 0.25, add9Bias: 0.05, densityBias: -0.2, brightness: 0.3,
    restChance: 0.32, staccato: 0.15,
  },
  hopeful: {
    id: 'hopeful', name: 'Hopeful',
    modes: [['ionian', 2], ['dorian', 2], ['mixolydian', 1], ['majorPent', 1]],
    register: 1, velCurve: 0.65, tensionBias: 0.15,
    seventhBias: 0.0, add9Bias: 0.25, densityBias: 0.05, brightness: 0.65,
    restChance: 0.22, staccato: 0.2,
  },
};

export const MOOD_IDS = Object.keys(MOODS);
