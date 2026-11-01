// FX buses: generated convolution reverb, tempo-synced delay, chorus.

export function makeReverbIR(ctx, seconds = 2.2, decay = 2.4, seed = 1) {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  let s = seed >>> 0 || 1;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const white = (s / 4294967296) * 2 - 1;
      const t = i / len;
      // slight early-reflection bump then exponential tail
      const envl = Math.pow(1 - t, decay) * (t < 0.02 ? 0.6 + t * 20 : 1);
      d[i] = white * envl * 0.55;
    }
  }
  return buf;
}

// IRs are expensive to synthesise (a second or more of seeded noise), so build
// one per (context, length) and reuse it — including across graph rebuilds.
const irCache = new WeakMap();

function cachedIR(ctx, seconds, decay, seed) {
  let m = irCache.get(ctx);
  if (!m) { m = new Map(); irCache.set(ctx, m); }
  const key = seconds.toFixed(2);
  if (m.has(key)) return m.get(key);
  const buf = makeReverbIR(ctx, seconds, decay, seed);
  m.set(key, buf);
  return buf;
}

export function createFxBuses(ctx, song, destination) {
  const fx = song.fx || {};
  const irSeconds = 1.2 + (fx.reverb ?? 0.4) * 3.4;
  const convolver = ctx.createConvolver();
  convolver.buffer = cachedIR(ctx, irSeconds, 2.2, 7);
  const revIn = ctx.createGain();
  const revOut = ctx.createGain();
  revOut.gain.value = 0.9;
  revIn.connect(convolver).connect(revOut).connect(destination);

  // tempo-synced delay (dotted eighth)
  const beat = 60 / (song.bpm || 100);
  const delay = ctx.createDelay(4);
  // dotted eighth, clamped: at 20 BPM that is 2.25 s
  delay.delayTime.value = Math.max(0.05, Math.min(3.9, beat * 0.75));
  const fb = ctx.createGain();
  fb.gain.value = 0.32;
  const dampen = ctx.createBiquadFilter();
  dampen.type = 'lowpass';
  dampen.frequency.value = 2600;
  const delIn = ctx.createGain();
  const delOut = ctx.createGain();
  delOut.gain.value = 0.8;
  delIn.connect(delay);
  delay.connect(dampen).connect(fb).connect(delay);
  delay.connect(delOut).connect(destination);

  // chorus (delay + LFO), only used by some styles
  const chorusIn = ctx.createGain();
  const chorusDelay = ctx.createDelay(0.1);
  chorusDelay.delayTime.value = 0.018;
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  lfo.frequency.value = 0.32;
  lfoGain.gain.value = 0.004;
  lfo.connect(lfoGain).connect(chorusDelay.delayTime);
  const chorusOut = ctx.createGain();
  chorusOut.gain.value = 0.6;
  chorusIn.connect(chorusDelay).connect(chorusOut).connect(destination);
  if (typeof lfo.start === 'function') {
    try { lfo.start(0); } catch { /* already started */ }
  }

  return {
    revIn, delIn, chorusIn,
    levels: {
      reverb: fx.reverb ?? 0.35,
      delay: fx.delay ?? 0.2,
      chorus: fx.chorus ?? 0.1,
    },
  };
}
