// Section transitions: a riser into a lift, a soft impact on the downbeat.
// The idea comes from eon-commando's noise sweeps; this is the same primitive
// used musically instead of as a game sound effect.

import { noiseBuffer } from './instruments.js';

function sweep(ctx, dest, { when, dur = 1.4, from = 300, to = 7000, peak = 0.18, q = 1.2 }) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, Math.max(1, dur + 0.2));
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = q;
  bp.frequency.setValueAtTime(from, when);
  bp.frequency.exponentialRampToValueAtTime(to, when + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(peak, when + dur * 0.85);
  g.gain.linearRampToValueAtTime(0.0001, when + dur + 0.05);
  src.connect(bp).connect(g).connect(dest);
  src.start(when);
  src.stop(when + dur + 0.1);
}

function impact(ctx, dest, { when, peak = 0.3 }) {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(120, when);
  osc.frequency.exponentialRampToValueAtTime(38, when + 0.5);
  const g = ctx.createGain();
  g.gain.setValueAtTime(peak, when);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.6);
  osc.connect(g).connect(dest);
  osc.start(when);
  osc.stop(when + 0.65);

  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 0.5);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2400;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(peak * 0.5, when);
  ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.35);
  src.connect(lp).connect(ng).connect(dest);
  src.start(when);
  src.stop(when + 0.4);
}

// song.transitions: [{ beat, kind: 'riser' | 'impact', gain }]
export function scheduleTransitions(graph, song, t0 = 0, fromSec = 0) {
  const list = song.transitions || [];
  if (!list.length) return;
  const map = graph.__tempoMap;
  const ctx = graph.ctx;
  const dest = graph.buses?.mid?.input || graph.master;
  for (const tr of list) {
    const beat = tr.beat;
    const at = t0 + (map ? map.secondsAt(beat) : (beat * 60) / (song.bpm || 100)) - fromSec;
    if (at < ctx.currentTime - 0.5) continue;
    const when = Math.max(ctx.currentTime + 0.01, at);
    try {
      if (tr.kind === 'riser') {
        sweep(ctx, dest, { when: when - 1.4, dur: 1.4, peak: 0.12 * (tr.gain ?? 1) });
      } else {
        impact(ctx, dest, { when, peak: 0.22 * (tr.gain ?? 1) });
      }
    } catch { /* a transition is decoration; never let it break playback */ }
  }
}
