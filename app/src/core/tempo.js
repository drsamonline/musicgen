// Tempo that moves. A song is a list of tempo segments, each starting at a
// beat with its own BPM; everything that converts beats to seconds goes
// through this map, so a rubato phrase or a ritardando outro stays coherent
// across the composer, the scheduler, the loop points and the export.

export const DEFAULT_DRIFT = 0.08;

// segments: [{ beat, bpm }] sorted by beat, first must start at beat 0
export function makeTempoMap(segments, { base = 100, drift = DEFAULT_DRIFT } = {}) {
  const clean = segments
    .map((s) => ({ beat: Math.max(0, s.beat), bpm: clampBpm(s.bpm) }))
    .sort((a, b) => a.beat - b.beat);
  if (!clean.length || clean[0].beat > 0) clean.unshift({ beat: 0, bpm: clampBpm(base) });

  // cumulative seconds at the start of each segment
  const starts = new Array(clean.length);
  starts[0] = 0;
  for (let i = 1; i < clean.length; i++) {
    const span = clean[i].beat - clean[i - 1].beat;
    starts[i] = starts[i - 1] + (span * 60) / clean[i - 1].bpm;
  }

  function secondsAt(beat) {
    const b = Math.max(0, beat);
    let lo = 0;
    let hi = clean.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (clean[mid].beat <= b) lo = mid;
      else hi = mid - 1;
    }
    return starts[lo] + ((b - clean[lo].beat) * 60) / clean[lo].bpm;
  }

  function beatAt(seconds) {
    const s = Math.max(0, seconds);
    let lo = 0;
    let hi = clean.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    return clean[lo].beat + ((s - starts[lo]) * clean[lo].bpm) / 60;
  }

  function bpmAt(beat) {
    const b = Math.max(0, beat);
    let lo = 0;
    for (let i = 0; i < clean.length; i++) if (clean[i].beat <= b) lo = i;
    return clean[lo].bpm;
  }

  const bpms = clean.map((s) => s.bpm);
  return {
    segments: clean,
    base,
    drift,
    min: Math.min(...bpms),
    max: Math.max(...bpms),
    secondsAt,
    beatAt,
    bpmAt,
    durationOf: (beats) => secondsAt(beats),
  };
}

export function clampBpm(bpm) {
  return Math.max(20, Math.min(500, Math.round(bpm * 100) / 100));
}

// A flat map, for tests and for songs that really do not move.
export function flatTempo(bpm) {
  return makeTempoMap([{ beat: 0, bpm }], { base: bpm, drift: 0 });
}

export function describeTempo(map) {
  const lo = Math.round(map.min);
  const hi = Math.round(map.max);
  return lo === hi ? `${lo} BPM` : `${lo}–${hi} BPM`;
}
