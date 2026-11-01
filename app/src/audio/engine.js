// Audio engine: graph builder, scheduler, live player, offline renderer.
import { synthVoice, isOffline } from './instruments.js';
import { drumVoice } from './drums.js';
import { createFxBuses } from './fx.js';
import { createMasterChain } from './mastering.js';
import { freqOf, pc } from '../core/theory.js';
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
  drums: { delay: 0.25, drive: 0.05 },
  bass: { delay: 0.25, drive: 0.2 },
  chords: { delay: 0.5, drive: 0.1 },
  lead: { delay: 0.75, drive: 0.12 },
  pad: { delay: 1, drive: 0.05 },
  arp: { delay: 0.5, drive: 0.08 },
  bed: { delay: 1, drive: 0 },
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
  chain.output.connect(ctx.destination);

  let analyser = null;
  if (typeof ctx.createAnalyser === 'function') {
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.75;
    chain.output.connect(analyser);
  }

  const fx = createFxBuses(ctx, song, master);

  // sidechain bus: chords, pads and arp duck under the kick
  const sidechain = ctx.createGain();
  sidechain.gain.value = 1;
  sidechain.connect(master);

  const tech = TECHS[song.tech] || TECHS.analog;
  const tracks = {};
  for (const name of TRACK_NAMES) {
    const input = ctx.createGain();
    const level = song.mix?.[name] ?? 0.6;
    input.gain.value = Math.max(0, level) * 0.85;

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
    node.connect(duckable ? sidechain : master);

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
    ctx, master, chain, fx, tracks, tech, analyser, sidechain,
    cap: { max: isOffline(ctx) ? 64 : voiceCap(), active: [], stolen: 0, dropped: 0 },
    lastNote: { bass: null, lead: null },
    song,
  };
}

// ---------------------------------------------------------------- scheduling
export function buildEvents(song, only = null) {
  const spb = 60 / (song.bpm || 100);
  const events = [];
  const list = only ? TRACK_NAMES.filter((t) => only.includes(t)) : TRACK_NAMES;
  for (const track of list) {
    for (const n of song.tracks[track] || []) events.push({ sec: n.t * spb, track, n });
  }
  events.sort((a, b) => a.sec - b.sec || a.track.localeCompare(b.track));
  return events;
}

// Sections are contiguous, so a binary search over precomputed start beats
// beats scanning the list for every note.
function sectionIntensity(song) {
  const spans = song.sections.map((s) => ({
    start: s.bar * song.beatsPerBar,
    end: (s.bar + s.bars) * song.beatsPerBar,
    intensity: s.intensity ?? 0.6,
  }));
  return (beat) => {
    let lo = 0, hi = spans.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (beat < spans[mid].start) hi = mid - 1;
      else if (beat >= spans[mid].end) lo = mid + 1;
      else { found = mid; break; }
    }
    return found >= 0 ? spans[found].intensity : 0.6;
  };
}

function pruneVoices(cap, now) {
  const a = cap.active;
  if (!a.length) return;
  let w = 0;
  for (let i = 0; i < a.length; i++) if (a[i].end > now) a[w++] = a[i];
  a.length = w;
}

function stealQuietest(cap, now, at = now) {
  const a = cap.active;
  let idx = 0;
  let best = Infinity;
  for (let i = 0; i < a.length; i++) {
    if (a[i].vel < best) { best = a[i].vel; idx = i; }
  }
  const victim = a[idx];
  if (victim?.out?.gain) {
    try {
      victim.out.gain.cancelScheduledValues(at);
      victim.out.gain.setTargetAtTime(0.0001, at, 0.01);
    } catch { /* noop */ }
  }
  a.splice(idx, 1);
  cap.stolen++;
}

const BED_SPEC = {
  engine: 'noise', attack: 1.4, decay: 2, sustain: 0.8, release: 2.4,
  cutoff: 900, q: 1.2, gain: 0.16,
};

// Automation envelopes drawn from the tension curve: each section opens the
// track tone filter and the reverb send as it gets more intense.
export function applyAutomation(graph, song, t0 = 0, fromSec = 0) {
  const spb = 60 / (song.bpm || 100);
  const ctx = graph.ctx;
  for (const name of TRACK_NAMES) {
    const t = graph.tracks[name];
    if (!t?.tone) continue;
    for (const sec of song.sections) {
      const start = t0 + sec.bar * song.beatsPerBar * spb - fromSec;
      const end = start + sec.bars * song.beatsPerBar * spb;
      if (end < ctx.currentTime) continue;
      const at = Math.max(start, ctx.currentTime);
      const cutoff = 900 + sec.intensity * 13000;
      try {
        t.tone.frequency.setValueAtTime(Math.max(200, cutoff * 0.8), at);
        t.tone.frequency.linearRampToValueAtTime(Math.min(18000, cutoff), Math.max(at + 0.05, end));
      } catch { /* noop */ }
    }
  }
}

export function makeScheduler(graph, song) {
  const spb = 60 / (song.bpm || 100);
  const intensityAt = sectionIntensity(song);
  const tech = graph.tech;
  const offline = isOffline(graph.ctx);

  const variant = song.variant ?? 0;

  // microtuning: a cents offset per pitch class, if the song carries one
  const tuneFreq = (p) => {
    const cents = song.tuning?.cents?.[pc(p)] ?? 0;
    return freqOf(p) * Math.pow(2, cents / 1200);
  };

  return function scheduleEvent(ev, when) {
    const { track, n } = ev;
    const brightness = 0.55 + intensityAt(n.t) * 0.7;

    // worklet voices take whole notes as messages
    const wnode = graph.tracks[track]?.worklet;
    if (wnode) {
      const spec = track === 'bed' ? BED_SPEC : (tech.instruments[track] || tech.instruments.chords);
      try {
        wnode.node.port.postMessage({
          type: 'note', when, dur: Math.max(0.05, n.d * spb),
          freq: tuneFreq(n.p), vel: n.v,
          damping: spec.damping ?? 0.6, brightness,
        });
        graph.cap.active.push({ end: when + Math.max(0.05, n.d * spb) + 0.6, out: null, vel: n.v });
        return;
      } catch { /* fall through to native synthesis */ }
    }

    if (track === 'drums') {
      drumVoice(graph.ctx, graph.tracks.drums.input, {
        when, kind: n.drum, vel: n.v, engine: tech.drums?.engine || 'analog',
        metallic: (song.metallicHats ?? false) || tech.drums?.engine === 'chiptune',
      });
      if (n.drum === 'kick' && song.sidechain) {
        const g = graph.sidechain.gain;
        try {
          g.setValueAtTime(1, when);
          g.linearRampToValueAtTime(0.55, when + 0.008);
          g.linearRampToValueAtTime(1, when + Math.min(0.3, 0.16 + 30 / (song.bpm || 100)));
        } catch { /* noop */ }
      }
      return;
    }

    const base = track === 'bed' ? BED_SPEC : (tech.instruments[track] || tech.instruments.chords);
    const spec = track === 'bed' ? base : applyVariant(base, variant);

    // Voice pool: prune what has finished, then steal the quietest voice
    // rather than silently dropping the new note. Dropping is what made
    // dense passages lose their melody. In an offline render "now" is the
    // event's own time — the whole song is scheduled in one pass.
    const now = offline ? when : graph.ctx.currentTime;
    pruneVoices(graph.cap, now);
    if (graph.cap.active.length >= graph.cap.max) stealQuietest(graph.cap, now, when);

    // legato: a note that follows closely on a mono-ish track slides into it
    let glideFrom = null;
    if (track === 'bass' || track === 'lead') {
      const prev = graph.lastNote[track];
      const endSec = n.t * spb;
      if (prev && endSec - prev.end < 0.09 && Math.abs(n.p - prev.p) <= 7 && n.p !== prev.p) {
        glideFrom = tuneFreq(prev.p);
      }
      graph.lastNote[track] = { p: n.p, end: endSec + Math.max(0.03, n.d * spb) };
    }

    const voice = synthVoice(graph.ctx, graph.tracks[track].input, {
      when,
      dur: Math.max(0.03, n.d * spb),
      freq: tuneFreq(n.p),
      vel: n.v,
      spec,
      brightness,
      glideFrom,
    });
    if (voice) graph.cap.active.push({ end: voice.end, out: voice.out, vel: n.v });
  };
}

// ---------------------------------------------------------------- live player
export class Player {
  constructor(song) {
    this.song = song;
    this.events = buildEvents(song);
    this.ctx = null;
    this.graph = null;
    this.timer = null;
    this.idx = 0;
    this.startCtxTime = 0;
    this.startPos = 0;
    this.playing = false;
    this.onEnd = null;
    this.onTick = null;
    this.lookahead = 0.2;
    this.intervalMs = 25;
    this.loop = null;
    this.userVolume = 0.9;
  }

  async init() {
    if (this.ctx) return;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    this.worklets = await prepareWorklets(this.ctx);
    this.graph = buildGraph(this.ctx, this.song);
    this.schedule = makeScheduler(this.graph, this.song);
    // Prefer the audio-thread clock: setInterval jitters when the main thread
    // is busy, and a jittery scheduler is an audible scheduler.
    if (this.worklets?.clock) {
      try {
        this.clockNode = new AudioWorkletNode(this.ctx, 'clock-tick', {
          numberOfInputs: 0,
          numberOfOutputs: 0,
          processorOptions: { frames: 1024 },
        });
        this.clockNode.port.onmessage = () => { if (this.playing) this.tick(); };
      } catch { this.clockNode = null; }
    }
  }

  get duration() { return this.song.durationSec; }

  get position() {
    if (!this.ctx || !this.playing) return this.startPos;
    return Math.min(this.duration, this.ctx.currentTime - this.startCtxTime + this.startPos);
  }

  async play(fromSec = null) {
    await this.init();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.duck(false);
    const from = fromSec == null ? this.position : fromSec;
    this.stopTimerOnly();
    this.startPos = from >= this.duration - 0.05 ? 0 : from;
    this.startCtxTime = this.ctx.currentTime + 0.08;
    this.idx = this.events.findIndex((e) => e.sec >= this.startPos);
    if (this.idx < 0) this.idx = this.events.length;
    this.playing = true;
    applyAutomation(this.graph, this.song, this.startCtxTime, this.startPos);
    if (this.clockNode) {
      try { this.clockNode.port.postMessage({ type: 'start' }); } catch { /* noop */ }
    } else {
      this.timer = setInterval(() => this.tick(), this.intervalMs);
    }
    this.tick();
  }

  setLoop(startSec, endSec) {
    this.loop = startSec == null ? null : { start: startSec, end: endSec };
  }

  tick() {
    if (!this.playing) return;
    const now = this.ctx.currentTime - this.startCtxTime; // song time at "now"
    const horizon = now + this.lookahead;

    while (this.idx < this.events.length && this.events[this.idx].sec < horizon) {
      const ev = this.events[this.idx++];
      const when = this.startCtxTime + (ev.sec - this.startPos);
      // a note more than 60 ms late is skipped rather than fired in a burst
      if (when < this.ctx.currentTime - 0.06) continue;
      try {
        this.schedule(ev, Math.max(when, this.ctx.currentTime + 0.004));
      } catch (err) {
        this.graph.cap.dropped++;
        if (globalThis.console) console.warn('voice failed', err);
      }
    }

    if (this.onTick) this.onTick(this.position);

    if (this.loop && now >= this.loop.end) {
      const from = this.loop.start;
      this.startPos = from;
      this.startCtxTime = this.ctx.currentTime + 0.02;
      this.idx = this.events.findIndex((e) => e.sec >= from);
      if (this.idx < 0) this.idx = this.events.length;
      return;
    }

    if (now >= this.duration) {
      this.playing = false;
      this.stopTimerOnly();
      this.startPos = this.duration;
      if (this.onEnd) this.onEnd();
    }
  }

  stopTimerOnly() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.clockNode) {
      try { this.clockNode.port.postMessage({ type: 'stop' }); } catch { /* noop */ }
    }
  }

  pause() {
    const p = this.position;
    this.playing = false;
    this.stopTimerOnly();
    this.startPos = p;
    this.duck(true);
  }

  stop() {
    this.playing = false;
    this.stopTimerOnly();
    this.startPos = 0;
    this.duck(true);
  }

  // Fade the master out (and back in) instead of tearing the graph down.
  // Rebuilding it used to regenerate the reverb IR on every pause.
  duck(silent) {
    if (!this.graph || !this.ctx) return;
    const g = this.graph.master.gain;
    const now = this.ctx.currentTime;
    const target = silent ? 0.0001 : this.userVolume * 0.32;
    try {
      g.cancelScheduledValues(now);
      g.setTargetAtTime(target, now, 0.015);
    } catch { /* noop */ }
  }

  setVolume(v) {
    this.userVolume = Math.max(0, Math.min(1.5, v));
    if (this.graph && this.playing) {
      const g = this.graph.master.gain;
      try { g.setTargetAtTime(this.userVolume * 0.32, this.ctx.currentTime, 0.02); } catch { g.value = this.userVolume * 0.32; }
    }
  }

  async close() {
    this.stop();
    if (this.ctx) { try { await this.ctx.close(); } catch { /* noop */ } }
    this.ctx = null;
    this.graph = null;
  }
}

// ---------------------------------------------------------------- offline
export async function renderSong(song, { sampleRate = 44100, tailSec = 2, onProgress = null, only = null } = {}) {
  const lengthSec = song.durationSec + tailSec;
  const frames = Math.ceil(lengthSec * sampleRate);
  const OfflineCtor = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OfflineCtor) throw new Error('OfflineAudioContext unavailable');
  const ctx = new OfflineCtor(2, frames, sampleRate);
  await prepareWorklets(ctx);
  const graph = buildGraph(ctx, song);
  applyAutomation(graph, song, 0, 0);
  const schedule = makeScheduler(graph, song);
  for (const ev of buildEvents(song, only)) {
    try { schedule(ev, Math.max(0, ev.sec)); } catch { graph.cap.dropped++; }
  }
  if (onProgress) onProgress(0.5);
  const buf = await ctx.startRendering();
  if (onProgress) onProgress(1);
  return buf;
}
