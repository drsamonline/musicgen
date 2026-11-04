// Live playback: transport, lookahead loop, loop points, master ducking,
// watchdog and worklet clock.
import { buildGraph, voiceCap } from './graph.js';
import { buildEvents, makeScheduler, applyAutomation } from './scheduler.js';
import { scheduleTransitions } from './transitions.js';
import { prepareWorklets } from './worklets.js';
import { makeHealth, noteTick, noteEvent, noteSkip, noteRecovery } from './health.js';

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
    // counters for the health HUD, and the guard that stops two recoveries
    // fighting over one context
    this.health = makeHealth();
    this.recovering = false;
    this.ctxListener = null;
  }

  // Regenerating used to create a whole new Player — and therefore a new
  // AudioContext — which browsers cap at a handful. After a few regenerations
  // the constructor threw and the app went permanently silent. Swapping the
  // song inside the existing context avoids that entirely.
  async setSong(song) {
    const wasPlaying = this.playing;
    const position = this.position;
    this.stop();
    this.song = song;
    this.events = buildEvents(song);
    this.idx = 0;
    this.startPos = 0;
    this.loop = null;
    if (!this.ctx) return;
    try { this.graph?.master?.disconnect(); } catch { /* already gone */ }
    try { this.graph?.chain?.output?.disconnect(); } catch { /* already gone */ }
    this.graph = buildGraph(this.ctx, song);
    this.schedule = makeScheduler(this.graph, song);
    if (wasPlaying) {
      await this.play(Math.min(position, Math.max(0, song.durationSec - 1)));
    }
  }

  async init() {
    if (this.ctx) return;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    this.watchContext();
    this.worklets = await prepareWorklets(this.ctx);
    this.graph = buildGraph(this.ctx, this.song);
    this.schedule = makeScheduler(this.graph, this.song);
    // Prefer the audio-thread clock: setInterval jitters when the main thread
    // is busy, and a jittery scheduler is an audible scheduler.
    if (this.worklets?.clock) {
      try {
        // A worklet node with zero outputs is never pulled by the graph, and
        // `numberOfOutputs: 0` is rejected outright — so give it one output and
        // a silent sink. This is what makes the scheduler immune to main-thread
        // jank: ticks come from the audio thread.
        this.clockNode = new AudioWorkletNode(this.ctx, 'clock-tick', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: { frames: 1024 },
        });
        const sink = this.ctx.createGain();
        sink.gain.value = 0;
        this.clockNode.connect(sink).connect(this.ctx.destination);
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
    scheduleTransitions(this.graph, this.song, this.startCtxTime, this.startPos);
    this.scheduleEdges();
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

  // A song that stops on a non-zero sample clicks. Fade the master over the
  // last 140 ms (and again at every loop wrap), and fade in at the start.
  scheduleEdges() {
    const g = this.graph.master.gain;
    const base = this.baseGain();
    const now = this.ctx.currentTime;
    try {
      g.cancelScheduledValues(now);
      // Always come back up immediately: this is the line that un-silences a
      // seek or a regenerate.
      g.setValueAtTime(base * 0.35, now);
      g.linearRampToValueAtTime(base, now + 0.03);

      const end = this.song.durationSec;
      const fadeStart = this.startCtxTime + Math.max(0, end - this.startPos) - 0.14;
      // Only schedule the closing fade if it is comfortably in the future —
      // a seek near the end used to schedule it in the past and go silent.
      if (fadeStart > now + 0.4) {
        g.setValueAtTime(base, fadeStart);
        g.linearRampToValueAtTime(0.0001, fadeStart + 0.14);
      }
      if (this.loop) {
        const loopEnd = this.startCtxTime + (this.loop.end - this.startPos) - 0.12;
        const loopStart = this.startCtxTime + (this.loop.start - this.startPos) + 0.02;
        if (loopEnd > now + 0.4) {
          g.setValueAtTime(base, loopEnd);
          g.linearRampToValueAtTime(0.0001, loopEnd + 0.1);
          g.setValueAtTime(base, Math.max(loopEnd + 0.11, loopStart));
        }
      }
    } catch { /* automation is best-effort */ }
  }

  baseGain() {
    return (this.userVolume ?? 0.9) * 0.32;
  }

  // Belt and braces: if the master has somehow been left at silence while the
  // transport says it is playing, put it back. Cheap, and it turns a silent
  // app into a blip.
  ensureAudible() {
    if (!this.playing || !this.graph?.master) return;
    const now = this.ctx.currentTime;
    if (this.ctx.currentTime + 0.3 > this.startCtxTime + (this.song.durationSec - this.startPos)) return;
    const g = this.graph.master.gain;
    if (g.value < this.baseGain() * 0.15) {
      try {
        g.cancelScheduledValues(now);
        g.setValueAtTime(this.baseGain() * 0.5, now);
        g.linearRampToValueAtTime(this.baseGain(), now + 0.05);
      } catch { /* noop */ }
    }
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
    // A context that is running but whose clock has stopped is the failure
    // `state` never reports: the transport says playing, nothing is heard.
    if (noteTick(this.health, this.ctx.currentTime, this.lastTick)) {
      this.recover('stalled');
      return;
    }
    this.ensureAudible();
    const now = this.ctx.currentTime - this.startCtxTime; // song time at "now"
    const horizon = now + this.lookahead;

    while (this.idx < this.events.length && this.events[this.idx].sec < horizon) {
      const ev = this.events[this.idx++];
      const when = this.startCtxTime + (ev.sec - this.startPos);
      // a note more than 60 ms late is skipped rather than fired in a burst
      if (when < this.ctx.currentTime - 0.06) { noteSkip(this.health); continue; }
      if (when < this.ctx.currentTime) noteEvent(this.health, this.ctx.currentTime - when);
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
    const target = silent ? 0.0001 : this.baseGain();
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

  // ------------------------------------------------------------ recovery
  // The device can go away under us: iOS interrupts the context when the
  // phone locks, a Bluetooth route can close it, an audio-thread stall can
  // freeze the clock. `state` catches the first two, `noteTick` catches the
  // third, and both land here.
  watchContext() {
    if (!this.ctx || this.ctxListener) return;
    this.ctxListener = () => { this.onContextState(); };
    try {
      this.ctx.addEventListener('statechange', this.ctxListener);
    } catch {
      this.ctx.onstatechange = this.ctxListener;
    }
  }

  detachContext() {
    if (this.ctx && this.ctxListener) {
      try { this.ctx.removeEventListener('statechange', this.ctxListener); } catch { /* older Safari */ }
    }
    this.ctxListener = null;
  }

  async onContextState() {
    const state = this.ctx?.state;
    if (state === 'closed') { await this.recover('closed'); return; }
    if (!this.playing) return;
    // 'interrupted' is Safari's word for "the phone took the audio away"
    if (state === 'suspended' || state === 'interrupted') {
      try {
        await this.ctx.resume();
        if (this.ctx.state !== 'running') await this.recover('resume-failed');
      } catch {
        await this.recover('resume-failed');
      }
    }
  }

  // Rebuild everything the context owned, keeping the song and the position.
  // This is the expensive path, and it is the one that turns a dead app back
  // into a playing one.
  async rebuild({ position = 0, resumePlaying = false } = {}) {
    const old = this.ctx;
    this.playing = false;
    this.stopTimerOnly();
    this.detachContext();
    this.ctx = null;
    this.graph = null;
    this.clockNode = null;
    this.worklets = null;
    this.schedule = null;
    this.idx = 0;
    if (old) {
      try { await old.close(); } catch { /* it may already be gone */ }
    }
    await this.init();
    if (resumePlaying) await this.play(position);
  }

  async recover(reason = 'manual') {
    if (this.recovering) return false;
    this.recovering = true;
    const wasPlaying = this.playing;
    const position = this.position;
    noteRecovery(this.health, reason);
    try {
      await this.rebuild({ position, resumePlaying: wasPlaying });
      return true;
    } catch (err) {
      if (globalThis.console) console.warn('audio recovery failed', err);
      return false;
    } finally {
      this.recovering = false;
    }
  }

  async close() {
    this.stop();
    if (this.ctx) { try { await this.ctx.close(); } catch { /* noop */ } }
    this.ctx = null;
    this.graph = null;
  }
}
