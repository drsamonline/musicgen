// Master chain: shelf EQ -> glue compressor -> brickwall limiter.
// The same chain is used for live playback and for offline export, so what
// you hear is what you get.

// A little tonal shaping per style: the difference between "a mix" and
// "a lo-fi mix" is mostly two shelves.
const STYLE_EQ = {
  lofi: { low: 2.2, lowF: 190, high: -3.5, highF: 6800, mid: 1.2, midF: 900 },
  cinematic: { low: 1.2, lowF: 90, high: -1.0, highF: 9000, mid: -0.8, midF: 400 },
  edm: { low: 1.8, lowF: 110, high: 2.0, highF: 9500, mid: -1.5, midF: 500 },
  ambient: { low: 0.6, lowF: 80, high: -2.0, highF: 7500, mid: 0 },
  jazz: { low: 0.8, lowF: 120, high: -0.5, highF: 8000, mid: -1.2, midF: 450 },
  chiptune: { low: -0.8, lowF: 140, high: 1.6, highF: 7000, mid: 0 },
  trap: { low: 2.4, lowF: 70, high: 0.8, highF: 9000, mid: -1.0, midF: 600 },
  rock: { low: 0.6, lowF: 110, high: 1.2, highF: 8000, mid: -0.6, midF: 700 },
  folk: { low: 0.4, lowF: 120, high: -0.6, highF: 8000, mid: 0.6, midF: 1200 },
  classical: { low: 0.2, lowF: 100, high: -0.4, highF: 9000, mid: 0 },
  world: { low: 1.0, lowF: 100, high: 0.4, highF: 8500, mid: 0 },
};

export function createMasterChain(ctx, song = {}) {
  const input = ctx.createGain();
  input.gain.value = 1;

  const rumble = ctx.createBiquadFilter();
  rumble.type = 'highpass';
  rumble.frequency.value = 28;
  rumble.Q.value = 0.7;

  const eq = STYLE_EQ[song.style] || STYLE_EQ.lofi;

  const shelf = ctx.createBiquadFilter();
  shelf.type = 'lowshelf';
  shelf.frequency.value = eq.lowF ?? 110;
  shelf.gain.value = eq.low ?? 1.2;

  const air = ctx.createBiquadFilter();
  air.type = 'highshelf';
  air.frequency.value = eq.highF ?? 9000;
  air.gain.value = eq.high ?? -1.5;

  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  mid.frequency.value = eq.midF ?? 700;
  mid.Q.value = 0.9;
  mid.gain.value = eq.mid ?? 0;

  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -18;
  glue.knee.value = 12;
  glue.ratio.value = 2;
  glue.attack.value = 0.02;
  glue.release.value = 0.28;

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;

  const out = ctx.createGain();
  out.gain.value = 1;

  input.connect(rumble).connect(shelf).connect(mid).connect(air).connect(glue).connect(limiter).connect(out);
  return { input, output: out, rumble, shelf, mid, air, glue, limiter };
}
