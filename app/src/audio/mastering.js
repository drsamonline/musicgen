// Master chain: shelf EQ -> glue compressor -> brickwall limiter.
// The same chain is used for live playback and for offline export, so what
// you hear is what you get.

export function createMasterChain(ctx, song = {}) {
  const input = ctx.createGain();
  input.gain.value = 1;

  const rumble = ctx.createBiquadFilter();
  rumble.type = 'highpass';
  rumble.frequency.value = 28;
  rumble.Q.value = 0.7;

  const shelf = ctx.createBiquadFilter();
  shelf.type = 'lowshelf';
  shelf.frequency.value = 110;
  shelf.gain.value = 1.2;

  const air = ctx.createBiquadFilter();
  air.type = 'highshelf';
  air.frequency.value = 9000;
  air.gain.value = -1.5;

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

  input.connect(rumble).connect(shelf).connect(air).connect(glue).connect(limiter).connect(out);
  return { input, output: out, rumble, shelf, air, glue, limiter };
}
