// Audio health: what the engine is actually doing, and what to do when it
// stops doing it.
//
// A browser audio app fails in ways you cannot hear in a screenshot: the
// context gets interrupted when the phone locks, the audio thread stalls while
// `currentTime` stands still, notes arrive later than they were scheduled. All
// three look identical from the outside — "it went quiet" — and none of them
// leave a trace a bug report can carry.
//
// So this module does two things. It keeps cheap counters that the player
// feeds from the hot path (no allocation, no timers, no DOM), and it turns
// them into a verdict a person can read. Everything here is pure data, which
// is why it can be unit-tested without an AudioContext.

// A tick that arrives this late means the main thread (or the audio thread)
// was blocked: audible as a stutter, worth counting.
export const LATE_MS = 20;
// `currentTime` standing still for this long while the transport says we are
// playing is not jitter — the context is dead and needs rebuilding.
export const STALL_MS = 1200;

export function makeHealth() {
  return {
    ticks: 0,
    maxGapMs: 0,
    lastTickWall: 0,
    late: 0,
    maxLateMs: 0,
    skipped: 0,
    stalls: 0,
    recoveries: 0,
    lastRecovery: null,
    lastCtxTime: -1,
    stillSince: 0,
    playingSince: 0,
  };
}

// Called from the scheduler tick. Returns true when the context looks dead.
export function noteTick(h, ctxTime, wallMs) {
  h.ticks++;
  if (h.lastTickWall) {
    const gap = wallMs - h.lastTickWall;
    if (gap > h.maxGapMs) h.maxGapMs = gap;
  }
  h.lastTickWall = wallMs;

  // Has the audio clock moved? A context that is running but frozen is the
  // failure mode `state` never reports.
  const moved = ctxTime > h.lastCtxTime + 0.0005;
  h.lastCtxTime = ctxTime;
  if (moved) {
    h.stillSince = 0;
    return false;
  }
  if (!h.stillSince) h.stillSince = wallMs;
  if (wallMs - h.stillSince < STALL_MS) return false;
  // one report per stall, not one per tick
  h.stillSince = wallMs;
  h.stalls++;
  return true;
}

// A note scheduled after its intended time. Under 20 ms is inaudible; beyond
// that it is a late note, which is what the lookahead exists to prevent.
export function noteEvent(h, lateSec) {
  const ms = lateSec * 1000;
  if (ms < LATE_MS) return;
  h.late++;
  if (ms > h.maxLateMs) h.maxLateMs = ms;
}

// A note too late to play at all, dropped rather than fired in a burst.
export function noteSkip(h) {
  h.skipped++;
}

export function noteRecovery(h, reason) {
  h.recoveries++;
  h.lastRecovery = reason;
  h.stillSince = 0;
  h.lastCtxTime = -1;
}

// The numbers, from whatever is around at the time. Missing pieces report as
// zero rather than throwing: a HUD that breaks when the audio is broken is
// worse than no HUD.
export function report(h, { ctx = null, graph = null, clock = 'none', playing = false, song = null } = {}) {
  const cap = graph?.cap;
  return {
    state: ctx?.state ?? 'none',
    sampleRate: ctx?.sampleRate ?? 0,
    latencyMs: Math.round((ctx?.baseLatency ?? 0) * 1000),
    clock,
    playing: !!playing,
    voices: {
      active: cap?.active?.length ?? 0,
      max: cap?.max ?? 0,
      stolen: cap?.stolen ?? 0,
      dropped: cap?.dropped ?? 0,
    },
    ticks: h.ticks,
    maxGapMs: Math.round(h.maxGapMs),
    late: h.late,
    maxLateMs: Math.round(h.maxLateMs),
    skipped: h.skipped,
    stalls: h.stalls,
    recoveries: h.recoveries,
    lastRecovery: h.lastRecovery,
    notes: song?.totalNotes ?? 0,
  };
}

// One line a person can act on, and a level for the dot.
export function verdict(r) {
  if (r.state === 'closed') {
    return { level: 'bad', line: 'The audio context is closed — rebuild to play again.' };
  }
  if (r.stalls > 0) {
    return { level: 'bad', line: `The audio clock stalled ${r.stalls}× — rebuilt ${r.recoveries}×.` };
  }
  if (r.state === 'suspended' || r.state === 'interrupted') {
    return { level: 'warn', line: 'The browser paused the audio context. Play resumes it.' };
  }
  if (r.skipped > 0 || r.late > 0) {
    return {
      level: 'warn',
      line: `${r.late} late note${r.late === 1 ? '' : 's'}, ${r.skipped} dropped — the thread was busy.`,
    };
  }
  if (r.voices.dropped > 0) {
    return { level: 'warn', line: `${r.voices.dropped} voices could not be built.` };
  }
  if (r.state !== 'running' && r.state !== 'none') {
    return { level: 'warn', line: `The audio context is ${r.state}.` };
  }
  if (r.state === 'none') {
    return { level: 'idle', line: 'No audio yet — press play.' };
  }
  return {
    level: 'ok',
    line: `${r.sampleRate / 1000} kHz · ${r.latencyMs} ms · ${r.voices.active}/${r.voices.max} voices · ${r.ticks} ticks · worst gap ${r.maxGapMs} ms`,
  };
}
