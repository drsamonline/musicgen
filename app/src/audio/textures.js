// Ambient textures: short synthesised beds that sit under a section.
// Each is a recipe, not a sample — filtered noise, a couple of LFOs and
// occasional events (droplets, crackles, birds). Ideas borrowed from
// ambient-sound-studio (same author), reimplemented for this engine.

import { noiseBuffer } from './instruments.js';

const TEX = {
  rain: { level: 0.5, lp: 5200, hp: 420, droplets: 6, dropDecay: 0.09 },
  wind: { level: 0.55, lp: 1400, hp: 120, lfo: { rate: 0.07, depth: 900 } },
  fire: { level: 0.4, lp: 2200, hp: 90, crackles: 14 },
  vinyl: { level: 0.32, lp: 9000, hp: 700, crackles: 3, hiss: 0.4 },
  crickets: { level: 0.35, lp: 6000, hp: 2600, chirps: 5 },
  ocean: { level: 0.6, lp: 900, hp: 60, lfo: { rate: 0.045, depth: 600 } },
  stream: { level: 0.45, lp: 4200, hp: 500, lfo: { rate: 0.3, depth: 300 } },
  hum: { level: 0.3, lp: 300, hp: 40 },
};

export const TEXTURE_NAMES = Object.keys(TEX);

function rngFor(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// A continuous bed for `dur` seconds. Returns the nodes so the caller can stop it.
export function textureVoice(ctx, dest, { when, dur, kind = 'rain', level = 0.5, seed = 1 }) {
  const spec = TEX[kind] || TEX.rain;
  const rand = rngFor(seed + kind.length * 977);
  const out = ctx.createGain();
  out.gain.value = 0;
  out.connect(dest);

  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 3);
  src.loop = true;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = spec.lp;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = spec.hp;

  src.connect(lp).connect(hp).connect(out);

  const peak = Math.max(0.01, spec.level * level);
  const attack = Math.min(2.5, Math.max(0.4, dur * 0.2));
  const release = Math.min(2.5, Math.max(0.6, dur * 0.25));
  const end = when + dur;
  out.gain.setValueAtTime(0, when);
  out.gain.linearRampToValueAtTime(peak, when + attack);
  out.gain.setValueAtTime(peak, Math.max(when + attack, end - release));
  out.gain.linearRampToValueAtTime(0, end);

  // slow movement, so a long bed is not static
  if (spec.lfo) {
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = spec.lfo.rate;
    depth.gain.value = spec.lfo.depth;
    lfo.connect(depth).connect(lp.frequency);
    lfo.start(when);
    lfo.stop(end + 0.1);
  }

  // sparse events: droplets, crackles, chirps
  const events = (spec.droplets || 0) + (spec.crackles || 0) + (spec.chirps || 0);
  if (events) {
    for (let i = 0; i < events; i++) {
      const at = when + 0.3 + rand() * Math.max(0.1, dur - 0.6);
      const g = ctx.createGain();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1200 + rand() * 3600;
      bp.Q.value = 2 + rand() * 4;
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(peak * (0.5 + rand() * 0.8), at + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, at + (spec.dropDecay || 0.05) + rand() * 0.12);
      const tick = ctx.createBufferSource();
      tick.buffer = noiseBuffer(ctx, 0.2);
      tick.connect(bp).connect(g).connect(out);
      tick.start(at);
      tick.stop(at + 0.3);
    }
  }

  src.start(when);
  src.stop(end + 0.2);
  return { out, stopAt: end + 0.2 };
}
