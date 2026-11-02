// Live playback: transport, lookahead loop, loop points, master ducking,
// watchdog and worklet clock.
import { buildGraph, voiceCap } from './graph.js';
import { buildEvents, makeScheduler, applyAutomation } from './scheduler.js';
import { prepareWorklets } from './worklets.js';

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
    this.lastTick = 0;
    this.watchdog = null;
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
    this.startWatchdog();
    this.tick();
  }

  setLoop(startSec, endSec) {
    this.loop = startSec == null ? null : { start: startSec, end: endSec };
  }

  // If the timer is throttled (background tab, busy thread) the song would
  // simply stop. The watchdog notices and keeps it alive.
  startWatchdog() {
    this.stopWatchdog();
    this.lastTick = Date.now();
    this.watchdog = setInterval(() => {
      if (!this.playing) return;
      if (Date.now() - this.lastTick > 700) {
        this.lastTick = Date.now();
        try { this.tick(); } catch { /* the next tick will retry */ }
      }
    }, 500);
  }

  stopWatchdog() {
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
  }

  tick() {
    if (!this.playing) return;
    this.lastTick = Date.now();
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
    this.stopWatchdog();
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
