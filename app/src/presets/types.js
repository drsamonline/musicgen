// Song types: structure generators.
export const TYPES = {
  loop: {
    id: 'loop', name: 'Loop',
    form: [['loop', 8]], loopStart: 0,
  },
  full: {
    id: 'full', name: 'Full song',
    form: [
      ['intro', 4], ['verse', 8], ['chorus', 8], ['verse', 8],
      ['chorus', 8], ['bridge', 4], ['chorus', 8], ['outro', 4],
    ],
  },
  drone: {
    id: 'drone', name: 'Drone',
    form: [['drone', 16]],
  },
  beat: {
    id: 'beat', name: 'Beat only',
    form: [['loop', 4], ['break', 4], ['loop', 8]],
  },
  melody: {
    id: 'melody', name: 'Melody only',
    form: [['intro', 4], ['verse', 8], ['bridge', 4]],
  },
  endless: {
    id: 'endless', name: 'Endless',
    form: [
      ['intro', 4], ['verse', 8], ['chorus', 8], ['verse', 8],
      ['chorus', 8], ['bridge', 8], ['chorus', 8], ['outro', 8],
    ],
  },
  intro: {
    id: 'intro', name: 'Intro only',
    form: [['intro', 8]],
  },
  aba: {
    id: 'aba', name: 'A-B-A',
    form: [['A', 8], ['B', 8], ['A', 8]],
  },
};

export const TYPE_IDS = Object.keys(TYPES);

// which tracks each section type carries
export const SECTION_TRACKS = {
  intro: ['pad', 'lead', 'chords'],
  verse: ['drums', 'bass', 'chords', 'lead'],
  chorus: ['drums', 'bass', 'chords', 'lead', 'pad'],
  bridge: ['pad', 'chords', 'lead', 'bass'],
  outro: ['pad', 'chords', 'bass'],
  loop: ['drums', 'bass', 'chords', 'lead'],
  break: ['chords', 'pad', 'lead'],
  drone: ['pad', 'chords'],
  A: ['drums', 'bass', 'chords', 'lead'],
  B: ['drums', 'bass', 'chords', 'lead', 'pad'],
};

// types that restrict which tracks exist at all
export const TYPE_TRACK_MASK = {
  beat: ['drums', 'bass', 'chords'],
  melody: ['lead', 'chords', 'pad'],
  drone: ['pad', 'chords'],
};

export const SECTION_INTENSITY = {
  intro: 0.3, verse: 0.55, chorus: 0.85, bridge: 0.45,
  outro: 0.35, loop: 0.7, break: 0.4, drone: 0.3, A: 0.65, B: 0.8,
};
