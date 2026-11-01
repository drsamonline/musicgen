// Synthesised instruments. Every sound is generated at runtime.
// No samples, no audio files.

const waveCache = new WeakMap();

export function pulseWave(ctx, duty) {
  let m = waveCache.get(ctx);
  if (!m) { m = new Map(); waveCache.set(ctx, m); }
  const key = duty.toFixed(3);
  if (m.has(key)) return m.get(key);
  const n = 24;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    imag[i] = (2 / (i * Math.PI)) * Math.sin(i * Math.PI * duty);
  }
  const w = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  m.set(key, w);
  return w;
}

export function noiseBuffer(ctx, seconds = 1) {
  let m = waveCache.get(ctx);
  if (!m) { m = new Map(); waveCache.set(ctx, m); }
  if (m.has('noise')) return m.get('noise');
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  // deterministic white noise so exports match live playback
  let s = 0x2545f491;
  for (let i = 0; i < len; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    d[i] = (s / 4294967296) * 2 - 1;
  }
  m.set('noise', buf);
  return buf;
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

// The saturation curve is identical for a given amount, so build it once and
// share the Float32Array between every voice. (This used to allocate 1024
// floats per note, which dominated the cost of dense sections.)
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

function cleanup(nodes, stopAt, ctx) {
  const src = nodes[0];
  if (!src) return;
  src.onended = () => {
    for (const n of nodes) { try { n.disconnect(); } catch { /* already gone */ } }
  };
  try { src.stop(stopAt); } catch { /* already stopped */ }
}

// ---------------------------------------------------------------- voices
export function synthVoice(ctx, dest, { when, dur, freq, vel = 0.7, spec = {}, brightness = 1, cap = { max: 48, active: 0 } }) {
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
    filter.frequency.setValueAtTime(Math.min(18000, cutoff), when);
    filter.Q.value = spec.q ?? 1;
  }

  if (filter) filter.connect(out);
  let stopAt = when + dur + 2;

  if (engine === 'fm') {
    const car = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const modGain = ctx.createGain();
    const idx = (spec.fmIndex ?? 1.5) * freq;
    car.frequency.value = freq;
    mod.frequency.value = freq * (spec.fmRatio ?? 2);
    modGain.gain.setValueAtTime(idx, when);
    modGain.gain.exponentialRampToValueAtTime(Math.max(1, idx * 0.15), when + Math.max(0.05, dur * 0.8));
    mod.connect(modGain).connect(car.frequency);
    car.connect(filter);
    nodes.push(car, mod, modGain, filter, out);
    stopAt = env(out.gain, when, dur, spec, peak);
    car.start(when); mod.start(when);
    cleanup([car], stopAt, ctx);
    cleanup([mod], stopAt, ctx);
  } else if (engine === 'chiptune') {
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(pulseWave(ctx, spec.duty ?? 0.5));
    osc.frequency.value = freq;
    osc.connect(filter);
    nodes.push(osc, filter, out);
    stopAt = env(out.gain, when, dur, spec, peak);
    osc.start(when);
    cleanup([osc], stopAt, ctx);
  } else if (engine === 'additive') {
    const count = Math.min(10, spec.harmonics ?? 8);
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
      o.start(when);
      oscs.push(o);
    }
    base.connect(filter);
    nodes.push(base, filter, out, ...oscs);
    stopAt = env(out.gain, when, dur, spec, peak);
    cleanup(oscs, stopAt, ctx);
  } else if (engine === 'wavetable') {
    // two detuned oscillators crossfaded — the table morph, cheaply
    const a = ctx.createOscillator();
    const b = ctx.createOscillator();
    a.type = 'sawtooth';
    b.type = 'square';
    a.frequency.value = freq;
    b.frequency.value = freq * 1.003;
    const mix = ctx.createGain();
    mix.gain.value = 0.5;
    a.connect(mix);
    b.connect(mix);
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
    cleanup([a], stopAt, ctx);
    cleanup([b], stopAt, ctx);
  } else if (engine === 'ks') {
    // Karplus-Strong: noise burst into a damped delay line
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 0.5);
    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = 1 / freq;
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
    cleanup([src], when + 0.5, ctx);
    try { fb.gain.setValueAtTime(fb.gain.value, stopAt - 0.2); fb.gain.linearRampToValueAtTime(0, stopAt); } catch { /* noop */ }
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
    cleanup([src], stopAt, ctx);
    cleanup([lfo], stopAt, ctx);
  } else {
    // subtractive: 2 detuned oscillators + optional sub
    const detune = spec.detune ?? 6;
    const o1 = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    o1.type = spec.wave || 'sawtooth';
    o2.type = spec.wave || 'sawtooth';
    o1.frequency.value = freq;
    o2.frequency.value = freq;
    o1.detune.value = -detune;
    o2.detune.value = detune;
    const mix = ctx.createGain();
    mix.gain.value = 0.5;
    o1.connect(mix);
    o2.connect(mix);
    if (freq < 180) {
      const sub = ctx.createOscillator();
      const subGain = ctx.createGain();
      sub.type = 'sine';
      sub.frequency.value = freq / 2;
      subGain.gain.value = 0.35;
      sub.connect(subGain).connect(mix);
      sub.start(when);
      nodes.push(sub, subGain);
      cleanup([sub], when + dur + 1, ctx);
    }
    mix.connect(filter);
    nodes.push(o1, o2, mix, filter, out);
    stopAt = env(out.gain, when, dur, spec, peak);
    o1.start(when); o2.start(when);
    cleanup([o1], stopAt, ctx);
    cleanup([o2], stopAt, ctx);
  }

  if (spec.sat && spec.sat > 0.02 && engine !== 'noise') {
    const sat = saturator(ctx, spec.sat);
    out.disconnect();
    out.connect(sat).connect(dest);
    nodes.push(sat);
  } else {
    out.connect(dest);
  }
  cap.active++;
  const t = stopAt;
  setTimeoutSafe(() => { cap.active = Math.max(0, cap.active - 1); }, (t - (ctx.currentTime || 0)) * 1000);
  return stopAt;
}

// setTimeout in the browser, no-op in an OfflineAudioContext render
function setTimeoutSafe(fn, ms) {
  if (typeof globalThis.setTimeout === 'function') globalThis.setTimeout(fn, Math.max(0, ms));
}
