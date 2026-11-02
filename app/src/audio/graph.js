// The audio graph: per-track chains (drive, tone filter, pan, sends), the FX
// buses, the master chain, group buses and the worklet voice nodes.
import { isOffline } from './instruments.js';
import { createFxBuses } from './fx.js';
import { createMasterChain } from './mastering.js';
import { TECHS } from '../presets/techs.js';

export const TRACK_NAMES = ['drums', 'bass', 'chords', 'lead', 'pad', 'arp', 'bed'];

const WORKLET_MODULES = ['granular.js', 'physical.js', 'clock.js'];
const workletReady = new WeakMap();

// Load the AudioWorklet modules once per context. Anything that fails here
// falls back to native nodes — the app must never depend on a worklet.
export async function prepareWorklets(ctx) {
  if (workletReady.has(ctx)) return workletReady.get(ctx);
  const promise = (async () => {
    if (!ctx.audioWorklet?.addModule) return { granular: false, physical: false, clock: false };
    const base = new URL('./worklets/', import.meta.url);
    const ok = { granular: false, physical: false, clock: false };
    for (const name of WORKLET_MODULES) {
      try {
        await ctx.audioWorklet.addModule(new URL(name, base).href);
        if (name === 'granular.js') ok.granular = true;
        if (name === 'physical.js') ok.physical = true;
        if (name === 'clock.js') ok.clock = true;
      } catch { /* fall back */ }
    }
    return ok;
  })();
  workletReady.set(ctx, promise);
  return promise;
}

const TRACK_PAN = { drums: 0, bass: 0, chords: -0.18, lead: 0.22, pad: 0, arp: -0.32, bed: 0 };
const TRACK_SEND = { drums: 0.12, bass: 0.04, chords: 0.32, lead: 0.4, pad: 0.6, arp: 0.35, bed: 0.8 };
// per-track FX: delay division (in beats), drive, and a tone filter range
const TRACK_FX = {
  drums: { delay: 0.25, drive: 0.02 },
  bass: { delay: 0.25, drive: 0.2 },
  chords: { delay: 0.5, drive: 0.1 },
  lead: { delay: 0.75, drive: 0.12 },
  pad: { delay: 1, drive: 0.05 },
  arp: { delay: 0.5, drive: 0.08 },
  bed: { delay: 1, drive: 0 },
};

// Global per-track trim. The style mix table says how the arranger *thinks*
// about balance; this says what the meters say. Measured with per-track LUFS:
// the drums were 15-18 dB under the bass, which is why the mix sounded like a
// bass solo. These numbers are the correction, not a taste knob.
const TRACK_TRIM = {
  drums: 3.6,
  bass: 0.4,
  chords: 1.5,
  lead: 1.45,
  pad: 1.4,
  arp: 1.35,
  bed: 0.45,
};

// Small per-style instrument tweaks so "Analog" is not one sound forever.
export function applyVariant(spec, variant) {
  if (!spec || !variant) return spec;
  const v = variant % 3;
  if (v === 0) return spec;
  if (v === 1) return { ...spec, cutoff: (spec.cutoff ?? 3000) * 1.6, detune: (spec.detune ?? 6) * 1.8, q: (spec.q ?? 1) * 1.3 };
  return { ...spec, cutoff: (spec.cutoff ?? 3000) * 0.62, detune: Math.max(2, (spec.detune ?? 6) * 0.5), filterEnv: (spec.filterEnv ?? 0.3) * 1.5, sat: (spec.sat ?? 0.15) * 1.4 };
}

export function voiceCap() {
  const cores = globalThis.navigator?.hardwareConcurrency || 4;
  const mem = globalThis.navigator?.deviceMemory || 4;
  if (cores <= 4 || mem <= 2) return 32;
  if (cores <= 8) return 64;
  return 96;
}

// ---------------------------------------------------------------- graph
export function buildGraph(ctx, song) {
  const master = ctx.createGain();
  master.gain.value = 0.32;

  const chain = createMasterChain(ctx, song);

  // mono bass: everything below ~120 Hz is summed to mono before the master
  // chain, which is what stops a wide mix from falling apart on a phone
  if (song.monoBass) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 120;
    lp.Q.value = 0.7;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 120;
    hp.Q.value = 0.7;
    const mono = ctx.createGain();
    try {
      mono.channelCount = 1;
      mono.channelCountMode = 'explicit';
      mono.channelInterpretation = 'speakers';
    } catch { /* old browsers: leave it stereo */ }
    master.connect(lp);
    lp.connect(mono);
    mono.connect(chain.input);
    master.connect(hp);
    hp.connect(chain.input);
  } else {
    master.connect(chain.input);
  }
  // A safety net no preset can bypass: nothing leaves the app above 0 dBFS
  // with a hard edge. This is the difference between "loud" and "static".
  let safety = null;
  if (typeof ctx.createWaveShaper === 'function') {
    safety = ctx.createWaveShaper();
    const n = 2048;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      // unity at low level, soft knee near full scale: a limiter, not a boost
      curve[i] = Math.tanh(x);
    }
    safety.curve = curve;
    safety.oversample = '2x';
    chain.output.connect(safety);
    safety.connect(ctx.destination);
  } else {
    chain.output.connect(ctx.destination);
  }

  let analyser = null;
  if (typeof ctx.createAnalyser === 'function') {
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.75;
    (safety || chain.output).connect(analyser);
  }

  const fx = createFxBuses(ctx, song, master);

  // Group buses: a compressor per family is how a mix holds together, instead
  // of nine tracks fighting at the master.
  const BUS_DEFS = {
    drums: { members: ['drums'], threshold: -20, ratio: 3.5, gain: 1 },
    low: { members: ['bass', 'bed'], threshold: -24, ratio: 2.5, gain: 1 },
    mid: { members: ['chords', 'pad', 'arp'], threshold: -22, ratio: 2.2, gain: 1 },
    lead: { members: ['lead'], threshold: -24, ratio: 3, gain: 1 },
  };
  const buses = {};
  for (const [name, def] of Object.entries(BUS_DEFS)) {
    const g = ctx.createGain();
    g.gain.value = def.gain;
    let node = g;
    if (typeof ctx.createDynamicsCompressor === 'function') {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = def.threshold;
      comp.knee.value = 10;
      comp.ratio.value = def.ratio;
      comp.attack.value = 0.006;
      comp.release.value = 0.16;
      g.connect(comp);
      node = comp;
    }
    node.connect(master);
    buses[name] = { input: g, output: node, members: def.members };
  }
  const busFor = (track) => {
    for (const [, bus] of Object.entries(buses)) if (bus.members.includes(track)) return bus;
    return buses.mid;
  };


  // sidechain bus: chords, pads and arp duck under the kick
  const sidechain = ctx.createGain();
  sidechain.gain.value = 1;
  sidechain.connect(buses.mid.input);

  const tech = TECHS[song.tech] || TECHS.analog;
  const tracks = {};
  for (const name of TRACK_NAMES) {
    const input = ctx.createGain();
    const level = song.mix?.[name] ?? 0.6;
    input.gain.value = Math.max(0, level) * 0.85 * (TRACK_TRIM[name] ?? 1);

    let node = input;
    let panner = null;
    if (typeof ctx.createStereoPanner === 'function') {
      panner = ctx.createStereoPanner();
      panner.pan.value = TRACK_PAN[name] ?? 0;
      input.connect(panner);
      node = panner;
    }

    // per-track tone filter, automated by the tension curve
    let tone = null;
    if (typeof ctx.createBiquadFilter === 'function') {
      tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = 16000;
      tone.Q.value = 0.4;
      node.connect(tone);
      node = tone;
    }

    const duckable = song.sidechain && (name === 'chords' || name === 'pad' || name === 'arp' || name === 'bed');
    if (name === 'drums' && typeof ctx.createDynamicsCompressor === 'function') {
      // a drum bus compressor: keeps the punch, controls the peaks
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -22;
      comp.knee.value = 8;
      comp.ratio.value = 4;
      comp.attack.value = 0.004;
      comp.release.value = 0.14;
      node.connect(comp);
      node = comp;
    }
    node.connect(duckable ? sidechain : busFor(name).input);

    // width: a short, opposite-panned delayed tap — cheap stereo
    if ((name === 'pad' || name === 'chords') && song.width > 0 && typeof ctx.createDelay === 'function') {
      const tap = ctx.createDelay(0.05);
      tap.delayTime.value = 0.011 + (name === 'pad' ? 0.006 : 0);
      const tapGain = ctx.createGain();
      tapGain.gain.value = 0.28 * Math.min(1, song.width);
      node.connect(tap).connect(tapGain);
      if (typeof ctx.createStereoPanner === 'function') {
        const tapPan = ctx.createStereoPanner();
        tapPan.pan.value = (TRACK_PAN[name] ?? 0) + (name === 'pad' ? 0.7 : -0.7);
        tapGain.connect(tapPan).connect(duckable ? sidechain : master);
      } else {
        tapGain.connect(master);
      }
    }

    // per-track FX sends
    const sendRev = ctx.createGain();
    sendRev.gain.value = (TRACK_SEND[name] ?? 0.2) * (0.4 + (song.fx?.reverb ?? 0.4));
    node.connect(sendRev).connect(fx.revIn);

    const sendDel = ctx.createGain();
    sendDel.gain.value = (TRACK_SEND[name] ?? 0.2) * 0.6 * (song.fx?.delay ?? 0.2);
    node.connect(sendDel).connect(fx.delIn);
    // per-track drive
    const drive = TRACK_FX[name]?.drive ?? 0.1;
    if (drive > 0.02 && name !== 'bed') {
      try {
        const ws = ctx.createWaveShaper();
        const n = 1024;
        const curve = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const x = (i / (n - 1)) * 2 - 1;
          curve[i] = Math.tanh(x * (1 + drive * 6));
        }
        ws.curve = curve;
        // compensate so the drive adds colour, not level
        const comp = ctx.createGain();
        comp.gain.value = 1 / (1 + drive * 3.2);
        input.disconnect();
        input.connect(ws).connect(comp).connect(node === tone ? tone : node);
      } catch { /* keep the dry path */ }
    }

    if ((song.fx?.chorus ?? 0) > 0.12 && (name === 'pad' || name === 'chords' || name === 'lead')) {
      const sendCh = ctx.createGain();
      sendCh.gain.value = (song.fx.chorus ?? 0) * 0.5;
      node.connect(sendCh).connect(fx.chorusIn);
    }

    tracks[name] = { input, panner, gain: input, tone, worklet: null };
  }

  // worklet voices: one node per track, created only when the tech asks for it
  for (const name of TRACK_NAMES) {
    const spec = tech.instruments?.[name];
    if (!spec) continue;
    const engine = spec.engine;
    if (engine !== 'granular' && engine !== 'waveguide') continue;
    const proc = engine === 'granular' ? 'granular-voice' : 'physical-voice';
    try {
      const node = new AudioWorkletNode(ctx, proc, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      node.connect(tracks[name].input);
      tracks[name].worklet = { node, engine };
    } catch { /* fall back to native nodes */ }
  }

  return {
    ctx, master, chain, fx, tracks, tech, analyser, sidechain, buses,
    cap: { max: isOffline(ctx) ? 64 : voiceCap(), active: [], stolen: 0, dropped: 0 },
    lastNote: { bass: null, lead: null },
    song,
  };
}
