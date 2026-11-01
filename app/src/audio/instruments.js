// Synthesised instruments. Every sound is generated at runtime.
// No samples, no audio files.
//
// Every voice returns { end, out } so the engine's voice pool can fade it out
// when it needs to steal a slot. Nodes are disconnected on a timer in live
// contexts and left to the (discarded) offline context in renders — the old
// code leaked delay lines and noise beds because nothing ever disconnected.

const waveCache = new WeakMap();

export function isOffline(ctx) {
  return typeof ctx.startRendering === 'function';
}

export function pulseWave(ctx, duty, maxHarmonics = 24) {
  let m = waveCache.get(ctx);
  if (!m) { m = new Map(); waveCache.set(ctx, m); }
  const n = Math.max(2, Math.min(24, maxHarmonics));
  const key = `${duty.toFixed(3)}:${n}`;
  if (m.has(key)) return m.get(key);
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let i = 1; i < n; i++) imag[i] = (2 / (i * Math.PI)) * Math.sin(i * Math.PI * duty);
  const w = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  m.set(key, w);
  return w;
}

// Wavetable frames: sine → triangle → saw → square → organ → bell. Each frame
// is a PeriodicWave, and a note morphs from one to the next over its length by
// crossfading two oscillators. This is the real thing, not two detuned saws.
const tableCache = new WeakMap();

function frameWave(ctx, frame, harmonics = 24, limit = 0) {
  let m = tableCache.get(ctx);
  if (!m) { m = new Map(); tableCache.set(ctx, m); }
  const usable = limit ? Math.max(2, Math.min(harmonics, Math.floor(limit / 60))) : harmonics;
  const key = `f${frame}:${usable}`;
  if (m.has(key)) return m.get(key);
  const real = new Float32Array(usable);
  const imag = new Float32Array(usable);
  for (let n = 1; n < usable; n++) {
    let amp = 0;
    if (frame === 0) amp = n === 1 ? 1 : 0;                       // sine
    else if (frame === 1) amp = n % 2 === 1 ? 1 / (n * n) : 0;    // triangle
    else if (frame === 2) amp = 1 / n;                            // saw
    else if (frame === 3) amp = n % 2 === 1 ? 1 / n : 0;          // square
    else if (frame === 4) amp = [1, 0.5, 0.25, 0.15, 0.1][n - 1] || 0; // organ
    else amp = (n % 3 === 1 ? 1 / (n * 1.4) : 0) + (n === 7 ? 0.3 : 0); // bell
    imag[n] = amp;
  }
  const wave = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  m.set(key, wave);
  return wave;
}

export function noiseBuffer(ctx, seconds = 1) {
  let m = waveCache.get(ctx);
  if (!m) { m = new Map(); waveCache.set(ctx, m); }
  const key = `noise:${seconds}`;
  if (m.has(key)) return m.get(key);
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  // deterministic white noise so exports match live playback
  let s = 0x2545f491;
  for (let i = 0; i < len; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    d[i] = (s / 4294967296) * 2 - 1;
  }
  m.set(key, buf);
  return buf;
}

// ---------------------------------------------------------------- helpers
// One timer drains a queue of pending disconnects instead of thousands of
// per-voice setTimeout calls (which is real overhead on a long song).
const pending = [];
let pump = null;

function startPump() {
  if (pump) return;
  pump = setInterval(() => {
    const now = Date.now();
    for (let i = pending.length - 1; i >= 0; i--) {
      const entry = pending[i];
      if (entry.at > now) continue;
      for (const n of entry.nodes) {
        try { n.disconnect(); } catch { /* already gone */ }
      }
      pending.splice(i, 1);
    }
    if (!pending.length) { clearInterval(pump); pump = null; }
  }, 120);
}

function disconnectLater(ctx, nodes, at) {
  if (isOffline(ctx)) return;
  const delay = Math.max(0, (at - ctx.currentTime) * 1000) + 120;
  pending.push({ at: Date.now() + delay, nodes });
  startPump();
}

function env(param, when, dur, spec, peak) {
  const a = Math.max(0.001, spec.attack ?? 0.01);
  const d = Math.max(0.01, spec.decay ?? 0.2);
  const sus = Math.max(0.0005, spec.sustain ?? 0.5);
  const r = Math.max(0.02, spec.release ?? 0.3);
  const held = Math.max(dur, 0.02);
  const off = when + held;
  param.setValueAtTime(0.0001, when);
  param.linearRampToValueAtTime(peak, when + a);
  param.exponentialRampToValueAtTime(Math.max(0.0001, peak * sus), when + a + d);
  param.setValueAtTime(Math.max(0.0001, peak * sus), off);
  param.exponentialRampToValueAtTime(0.0001, off + r);
  return off + r + 0.02;
}

// Filter envelope: the single biggest "this is a synth" lever. Opens the
// filter on the attack and settles back to the sustain cutoff.
function filterEnv(filter, when, dur, spec, baseCutoff, brightness, vel) {
  const amount = spec.filterEnv ?? 0;
  const nyquist = 18000;
  const velTilt = 1 + (spec.velToCutoff ?? 0) * (vel - 0.6);
  const start = Math.min(nyquist, baseCutoff * (1 + amount * 3) * velTilt);
  const target = Math.min(nyquist, baseCutoff * Math.max(0.25, brightness) * velTilt);
  const attack = Math.max(0.001, spec.filterAttack ?? 0.005);
  const decay = Math.max(0.02, spec.filterDecay ?? 0.18);
  filter.frequency.setValueAtTime(Math.max(60, start), when);
  filter.frequency.exponentialRampToValueAtTime(Math.max(60, target), when + attack + decay);
}

const curveCache = new Map();

function saturationCurve(amount) {
  const bucket = Math.round(Math.max(0, Math.min(1, amount)) * 20) / 20;
  const hit = curveCache.get(bucket);
  if (hit) return hit;
  const n = 1024;
  const curve = new Float32Array(n);
  const k = Math.max(0.0001, bucket) * 20;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * (1 + k)) / Math.tanh(1 + k);
  }
  curveCache.set(bucket, curve);
  return curve;
}

function saturator(ctx, amount) {
  const ws = ctx.createWaveShaper();
  ws.curve = saturationCurve(amount);
  ws.oversample = '2x';
  return ws;
}

// Nothing may be synthesised above this: harmonics and FM sidebands that pass
// Nyquist fold back as aliasing, which is exactly the "static" you hear.
export function nyquistLimit(ctx) {
  return (ctx.sampleRate || 44100) * 0.45;
}

function safeHarmonics(ctx, freq, wanted) {
  return safeHarmonicsFor(ctx.sampleRate || 44100, freq, wanted);
}

// Exported so the test suite can assert the rule without an AudioContext.
export function safeHarmonicsFor(sampleRate, freq, wanted) {
  const limit = sampleRate * 0.45;
  return Math.max(1, Math.min(wanted, Math.floor(limit / Math.max(20, freq))));
}

// ---------------------------------------------------------------- voices
export function synthVoice(ctx, dest, opts) {
  const {
    when, dur, freq, vel = 0.7, spec = {}, brightness = 1, glideFrom = null,
  } = opts;

  // portamento: start at the previous pitch and slide, for adjacent notes
  const glide = glideFrom && spec.glide ? Math.max(0.01, spec.glide) : 0;
  const pitchStart = (osc, startFreq) => {
    if (!glide) { osc.frequency.value = startFreq; return; }
    osc.frequency.setValueAtTime(glideFrom, when);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, startFreq), when + glide);
  };

  const engine = spec.engine || 'subtractive';
  const peak = Math.max(0.0005, (spec.gain ?? 0.4) * vel * brightness);
  const nodes = [];
  const out = ctx.createGain();
  out.gain.value = 1;

  let filter = null;
  const cutoff = Math.max(80, (spec.cutoff ?? 3000) * (0.6 + brightness * 0.7));
  if (engine !== 'ks' && engine !== 'noise') {
    filter = ctx.createBiquadFilter();
    filter.type = spec.filterType || 'lowpass';
    filter.Q.value = spec.q ?? 1;
    filterEnv(filter, when, dur, spec, cutoff, brightness, vel);
    filter.connect(out);
  }

  let stopAt = when + dur + 2;

  if (engine === 'fm') {
    const car = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const modGain = ctx.createGain();
    const ratio = Math.min(8, spec.fmRatio ?? 2);
    const limit = nyquistLimit(ctx);
    // the modulator's peak deviation must not push the carrier past Nyquist
    const idx = Math.min((spec.fmIndex ?? 1.5) * freq, Math.max(0, limit - freq) * 0.9);
    pitchStart(car, freq);
    mod.frequency.value = Math.min(limit, freq * ratio);
    modGain.gain.setValueAtTime(idx, when);
    modGain.gain.exponentialRampToValueAtTime(Math.max(1, idx * 0.15), when + Math.max(0.05, dur * 0.8));
    mod.connect(modGain).connect(car.frequency);
    car.connect(filter);
    nodes.push(car, mod, modGain, filter, out);
    stopAt = env(out.gain, when, dur, spec, peak);
    car.start(when); mod.start(when);
    car.stop(stopAt); mod.stop(stopAt);
  } else if (engine === 'chiptune') {
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(pulseWave(ctx, spec.duty ?? 0.5, safeHarmonics(ctx, freq, 24)));
    pitchStart(osc, freq);
    osc.connect(filter);
    nodes.push(osc, filter, out);
    stopAt = env(out.gain, when, dur, spec, peak);
    osc.start(when);
    osc.stop(stopAt);
  } else if (engine === 'additive') {
    const count = safeHarmonics(ctx, freq, Math.min(10, spec.harmonics ?? 8));
    const base = ctx.createGain();
    base.gain.value = 1;
    const oscs = [];
    for (let h = 1; h <= count; h++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq * h;
      g.gain.value = 1 / Math.pow(h, 1.4);
      o.connect(g).connect(base);
      oscs.push(o);
    }
    base.connect(filter);
    nodes.push(base, filter, out, ...oscs);
    stopAt = env(out.gain, when, dur, spec, peak);
    for (const o of oscs) { o.start(when); o.stop(stopAt); }
  } else if (engine === 'wavetable') {
    // two table frames crossfaded over the note: the morph is audible
    const frames = Math.max(2, Math.min(6, spec.frames ?? 4));
    const startFrame = Math.floor((spec.tableStart ?? 1) % frames);
    const endFrame = Math.min(frames - 1, startFrame + 1);
    const a = ctx.createOscillator();
    const b = ctx.createOscillator();
    a.setPeriodicWave(frameWave(ctx, startFrame, 24, nyquistLimit(ctx) / Math.max(1, freq / 60)));
    b.setPeriodicWave(frameWave(ctx, endFrame, 24, nyquistLimit(ctx) / Math.max(1, freq / 60)));
    pitchStart(a, freq);
    pitchStart(b, freq);
    const mix = ctx.createGain();
    mix.gain.value = 0.5;
    const morphA = ctx.createGain();
    const morphB = ctx.createGain();
    morphA.gain.setValueAtTime(1, when);
    morphA.gain.linearRampToValueAtTime(0.25, when + Math.max(0.1, dur * 0.8));
    morphB.gain.setValueAtTime(0, when);
    morphB.gain.linearRampToValueAtTime(0.75, when + Math.max(0.1, dur * 0.8));
    a.connect(morphA).connect(mix);
    b.connect(morphB).connect(mix);
    mix.connect(filter);
    const sweep = ctx.createBiquadFilter();
    sweep.type = 'peaking';
    sweep.frequency.setValueAtTime(cutoff, when);
    sweep.frequency.linearRampToValueAtTime(Math.min(16000, cutoff * 2.2), when + Math.max(0.1, dur * 0.6));
    sweep.gain.value = 4;
    filter.disconnect();
    filter.connect(sweep);
    sweep.connect(out);
    nodes.push(a, b, mix, filter, sweep, out);
    stopAt = env(out.gain, when, dur, spec, peak);
    a.start(when); b.start(when);
    a.stop(stopAt); b.stop(stopAt);
  } else if (engine === 'ks') {
    // Karplus-Strong: noise burst into a damped delay line
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 0.5);
    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = Math.min(0.05, 1 / freq);
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = Math.min(12000, 2000 + (spec.brightness ?? 0.6) * 8000);
    const fb = ctx.createGain();
    fb.gain.value = Math.min(0.98, 0.9 + (spec.damping ?? 0.5) * 0.08);
    const burst = ctx.createGain();
    burst.gain.setValueAtTime(1, when);
    burst.gain.setValueAtTime(0, when + Math.max(0.004, 2 / freq));
    src.connect(burst).connect(delay);
    delay.connect(damp).connect(fb).connect(delay);
    delay.connect(out);
    nodes.push(src, burst, delay, damp, fb, out);
    stopAt = env(out.gain, when, dur, { ...spec, attack: 0.002, sustain: 0.35, release: 0.4 }, peak);
    src.start(when);
    src.stop(when + 0.5);
    // the feedback loop must be closed or it rings forever (it used to)
    try {
      const closeAt = Math.max(when + 0.1, stopAt - 0.15);
      fb.gain.setValueAtTime(fb.gain.value, closeAt);
      fb.gain.linearRampToValueAtTime(0, stopAt);
    } catch { /* noop */ }
  } else if (engine === 'formant') {
    // a saw through three bandpass filters, with vowel formant centres
    const VOWELS = {
      a: [800, 1150, 2900], e: [400, 1700, 2600], i: [300, 2200, 3000],
      o: [450, 800, 2830], u: [325, 700, 2530],
    };
    const vowel = VOWELS[spec.vowel || 'a'] || VOWELS.a;
    const src = ctx.createOscillator();
    src.type = 'sawtooth';
    pitchStart(src, freq);
    const sum = ctx.createGain();
    sum.gain.value = 0.45;
    const nodes2 = [];
    vowel.forEach((centre, i) => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(centre * (spec.formantShift ?? 1), when);
      bp.Q.value = 3 + i * 1.5;
      const g = ctx.createGain();
      g.gain.value = 0.8 / (i + 1.4);
      src.connect(bp).connect(g).connect(sum);
      nodes2.push(bp, g);
    });
    // a little of the dry saw keeps it from sounding like a telephone
    const dry = ctx.createGain();
    dry.gain.value = 0.18;
    src.connect(dry).connect(sum);
    sum.connect(filter);
    nodes.push(src, sum, dry, filter, out, ...nodes2);
    stopAt = env(out.gain, when, dur, spec, peak);
    src.start(when);
    src.stop(stopAt);
  } else if (engine === 'noise') {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 2);
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = Math.max(200, cutoff * 0.5);
    bp.Q.value = spec.q ?? 3;
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.18;
    lfoGain.gain.value = 320;
    lfo.connect(lfoGain).connect(bp.frequency);
    src.connect(bp).connect(out);
    nodes.push(src, bp, lfo, lfoGain, out);
    stopAt = env(out.gain, when, dur, spec, peak);
    src.start(when); lfo.start(when);
    src.stop(stopAt);
    lfo.stop(stopAt);
  } else {
    // subtractive: 2 detuned oscillators + optional sub
    const detune = spec.detune ?? 6;
    const o1 = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    o1.type = spec.wave || 'sawtooth';
    o2.type = spec.wave || 'sawtooth';
    pitchStart(o1, freq);
    pitchStart(o2, freq);
    o1.detune.value = -detune;
    o2.detune.value = detune;
    const mix = ctx.createGain();
    mix.gain.value = 0.5;
    o1.connect(mix);
    o2.connect(mix);
    if (freq < 180 && freq / 2 > 25) {
      const sub = ctx.createOscillator();
      const subGain = ctx.createGain();
      sub.type = 'sine';
      sub.frequency.value = freq / 2;
      subGain.gain.value = 0.35;
      sub.connect(subGain).connect(mix);
      nodes.push(sub, subGain);
      sub.start(when);
      sub.stop(stopAt);
    }
    mix.connect(filter);
    nodes.push(o1, o2, mix, filter, out);
    stopAt = env(out.gain, when, dur, spec, peak);
    o1.start(when); o2.start(when);
    o1.stop(stopAt); o2.stop(stopAt);

    // analogue drift: a slow detune wander so repeated notes are not identical
    const drift = spec.drift ?? 0;
    if (drift > 0 && !isOffline(ctx)) {
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.value = 0.12 + (freq % 1) * 0.2;
      lfoGain.gain.value = drift;
      lfo.connect(lfoGain);
      lfoGain.connect(o1.detune);
      lfoGain.connect(o2.detune);
      lfo.start(when);
      lfo.stop(stopAt);
      nodes.push(lfo, lfoGain);
    }
  }

  if (spec.sat && spec.sat > 0.02 && engine !== 'noise') {
    const sat = saturator(ctx, spec.sat);
    out.disconnect();
    out.connect(sat).connect(dest);
    nodes.push(sat);
  } else {
    out.connect(dest);
  }

  disconnectLater(ctx, nodes, stopAt);
  return { end: stopAt, out };
}
