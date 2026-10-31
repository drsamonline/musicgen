// Audio engine: graph builder, scheduler, live player, offline renderer.
import { synthVoice } from './instruments.js';
import { drumVoice } from './drums.js';
import { createFxBuses } from './fx.js';
import { createMasterChain } from './mastering.js';
import { freqOf } from '../core/theory.js';
import { TECHS } from '../presets/techs.js';

export const TRACK_NAMES = ['drums', 'bass', 'chords', 'lead', 'pad', 'arp'];

const TRACK_PAN = { drums: 0, bass: 0, chords: -0.18, lead: 0.22, pad: 0, arp: -0.32 };
const TRACK_SEND = { drums: 0.12, bass: 0.04, chords: 0.32, lead: 0.4, pad: 0.6, arp: 0.35 };

export function voiceCap() {
  const cores = globalThis.navigator?.hardwareConcurrency || 4;
  const mem = globalThis.navigator?.deviceMemory || 4;
  if (cores <= 4 || mem <= 2) return 24;
  return 48;
}

export function buildGraph(ctx, song) {
  const master = ctx.createGain();
  master.gain.value = 0.55;
  const chain = createMasterChain(ctx, song);
  master.connect(chain.input);
  chain.output.connect(ctx.destination);

  let analyser = null;
  if (typeof ctx.createAnalyser === 'function') {
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.75;
    chain.output.connect(analyser);
  }

  const fx = createFxBuses(ctx, song, master);

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
    node.connect(master);

    // per-track FX sends
    const sendRev = ctx.createGain();
    sendRev.gain.value = (TRACK_SEND[name] ?? 0.2) * (0.4 + (song.fx?.reverb ?? 0.4));
    node.connect(sendRev).connect(fx.revIn);

    const sendDel = ctx.createGain();
    sendDel.gain.value = (TRACK_SEND[name] ?? 0.2) * 0.6 * (song.fx?.delay ?? 0.2);
    node.connect(sendDel).connect(fx.delIn);

    if ((song.fx?.chorus ?? 0) > 0.12 && (name === 'pad' || name === 'chords' || name === 'lead')) {
      const sendCh = ctx.createGain();
      sendCh.gain.value = (song.fx.chorus ?? 0) * 0.5;
      node.connect(sendCh).connect(fx.chorusIn);
    }

    tracks[name] = { input, panner, gain: input };
  }

  return {
    ctx, master, chain, fx, tracks, tech, analyser,
    cap: { max: voiceCap(), active: 0 },
    song,
  };
}

// ------------------------------------------------------------- scheduling
export function buildEvents(song, only = null) {
  const spb = 60 / (song.bpm || 100);
  const events = [];
  const list = only ? TRACK_NAMES.filter((t) => only.includes(t)) : TRACK_NAMES;
  for (const track of list) {
    const notes = song.tracks[track] || [];
    for (const n of notes) {
      events.push({ sec: n.t * spb, track, n });
    }
  }
  events.sort((a, b) => a.sec - b.sec || a.track.localeCompare(b.track));
  return events;
}

function sectionIntensity(song) {
  return (beat) => {
    for (const s of song.sections) {
      const start = s.bar * song.beatsPerBar;
      if (beat >= start - 0.01 && beat < start + s.bars * song.beatsPerBar) return s.intensity ?? 0.6;
    }
    return 0.6;
  };
}

export function makeScheduler(graph, song) {
  const spb = 60 / (song.bpm || 100);
  const intensityAt = sectionIntensity(song);
  const tech = graph.tech;

  return function scheduleEvent(ev, when) {
    const { track, n } = ev;
    const brightness = 0.55 + intensityAt(n.t) * 0.7;
    if (track === 'drums') {
      drumVoice(graph.ctx, graph.tracks.drums.input, {
        when, kind: n.drum, vel: n.v, engine: tech.drums?.engine || 'analog',
      });
      return;
    }
    const spec = tech.instruments[track] || tech.instruments.chords;
    if (graph.cap.active >= graph.cap.max) {
      // voice stealing: only quiet notes are dropped
      if (n.v > 0.72) { /* let it through */ } else return;
    }
    synthVoice(graph.ctx, graph.tracks[track].input, {
      when,
      dur: Math.max(0.03, n.d * spb),
      freq: freqOf(n.p),
      vel: n.v,
      spec,
      brightness,
      cap: graph.cap,
    });
  };
}

// ------------------------------------------------------------- live player
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
    this.lookahead = 0.12;
    this.intervalMs = 25;
  }

  async init() {
    if (this.ctx) return;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    this.graph = buildGraph(this.ctx, this.song);
    this.schedule = makeScheduler(this.graph, this.song);
  }

  get duration() { return this.song.durationSec; }

  get position() {
    if (!this.ctx) return this.startPos;
    if (!this.playing) return this.startPos;
    return Math.min(this.duration, this.ctx.currentTime - this.startCtxTime + this.startPos);
  }

  async play(fromSec = null) {
    await this.init();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const from = fromSec == null ? this.position : fromSec;
    this.stopTimerOnly();
    this.startPos = from >= this.duration - 0.05 ? 0 : from;
    this.startCtxTime = this.ctx.currentTime + 0.08;
    this.idx = this.events.findIndex((e) => e.sec >= this.startPos);
    if (this.idx < 0) this.idx = this.events.length;
    this.playing = true;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick();
  }

  tick() {
    if (!this.playing) return;
    const now = this.ctx.currentTime - this.startCtxTime; // song-time at ctx "now"
    const horizon = now + this.lookahead;
    while (this.idx < this.events.length && this.events[this.idx].sec < horizon) {
      const ev = this.events[this.idx++];
      const when = this.startCtxTime + (ev.sec - this.startPos);
      if (when < this.ctx.currentTime - 0.05) continue;
      try {
        this.schedule(ev, Math.max(when, this.ctx.currentTime + 0.005));
      } catch (err) {
        // a single failed voice must never stop playback
        if (globalThis.console) console.warn('voice failed', err);
      }
    }
    if (this.onTick) this.onTick(this.position);
    if (now >= this.duration) {
      this.playing = false;
      this.stopTimerOnly();
      this.startPos = this.duration;
      if (this.onEnd) this.onEnd();
    }
  }

  stopTimerOnly() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  pause() {
    const p = this.position;
    this.playing = false;
    this.stopTimerOnly();
    this.startPos = p;
    this.teardownGraph();
  }

  stop() {
    this.playing = false;
    this.stopTimerOnly();
    this.startPos = 0;
    this.teardownGraph();
  }

  teardownGraph() {
    if (this.graph && this.ctx) {
      // rebuild the graph so no stale voices keep ringing
      try { this.graph.master.disconnect(); } catch { /* noop */ }
      this.graph = buildGraph(this.ctx, this.song);
      this.schedule = makeScheduler(this.graph, this.song);
    }
  }

  setVolume(v) {
    if (this.graph) this.graph.master.gain.value = Math.max(0, Math.min(1.5, v));
  }

  async close() {
    this.stop();
    if (this.ctx) { try { await this.ctx.close(); } catch { /* noop */ } }
    this.ctx = null;
    this.graph = null;
  }
}

// ------------------------------------------------------------- offline
export async function renderSong(song, { sampleRate = 44100, tailSec = 2, onProgress = null, only = null } = {}) {
  const lengthSec = song.durationSec + tailSec;
  const frames = Math.ceil(lengthSec * sampleRate);
  const OfflineCtor = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OfflineCtor) throw new Error('OfflineAudioContext unavailable');
  const ctx = new OfflineCtor(2, frames, sampleRate);
  const graph = buildGraph(ctx, song);
  const schedule = makeScheduler(graph, song);
  for (const ev of buildEvents(song, only)) {
    try { schedule(ev, Math.max(0, ev.sec)); } catch { /* skip a bad voice */ }
  }
  if (onProgress) onProgress(0.5);
  const buf = await ctx.startRendering();
  if (onProgress) onProgress(1);
  return buf;
}
