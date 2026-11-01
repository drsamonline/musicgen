// Drum synthesis — one recipe per hit, no samples.
import { noiseBuffer } from './instruments.js';

export const DRUM_RECIPES = {
  kick: { body: 1 },
  snare: { body: 1 },
  hat: { body: 0 },
  openhat: { body: 0 },
  clap: { body: 0 },
  tom: { body: 1 },
  rim: { body: 0 },
  shaker: { body: 0 },
  ride: { body: 0 },
  crash: { body: 0 },
  conga: { body: 1 },
  timpani: { body: 1 },
  cowbell: { body: 0 },
};

function decayEnv(param, when, peak, attack, decay) {
  param.setValueAtTime(0.0001, when);
  param.linearRampToValueAtTime(peak, when + attack);
  param.exponentialRampToValueAtTime(0.0001, when + attack + decay);
}

function noiseHit(ctx, dest, when, { peak, type = 'highpass', freq = 6000, q = 0.7, attack = 0.001, decay = 0.06 }) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 1);
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  decayEnv(g.gain, when, peak, attack, decay);
  src.connect(f).connect(g).connect(dest);
  src.start(when);
  src.stop(when + attack + decay + 0.02);
  src.onended = () => { try { src.disconnect(); f.disconnect(); g.disconnect(); } catch { /* noop */ } };
  return when + attack + decay;
}

function toneHit(ctx, dest, when, { peak, from = 150, to = 45, decay = 0.28, attack = 0.001, type = 'sine' }) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, when);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), when + attack + decay * 0.9);
  const g = ctx.createGain();
  decayEnv(g.gain, when, peak, attack, decay);
  osc.connect(g).connect(dest);
  osc.start(when);
  osc.stop(when + attack + decay + 0.02);
  osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch { /* noop */ } };
  return when + attack + decay;
}

// Metallic hat: six detuned squares, the classic 808 recipe, instead of one
// noise burst. Only used when the style asks for a "chip" hat.
function metalHat(ctx, dest, when, vel, decay = 0.05) {
  const freqs = [205.3, 304.4, 369.6, 522.7, 540, 800];
  const g = ctx.createGain();
  decayEnv(g.gain, when, 0.3 * vel, 0.001, decay);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 8000;
  bp.Q.value = 0.8;
  g.connect(bp).connect(dest);
  for (const f of freqs) {
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = f * 6;
    osc.connect(g);
    osc.start(when);
    osc.stop(when + decay + 0.02);
  }
}

export function drumVoice(ctx, dest, { when, kind, vel = 0.8, engine = 'analog', metallic = false }) {
  const v = Math.max(0.05, Math.min(1.2, vel));
  switch (kind) {
    case 'kick':
      toneHit(ctx, dest, when, { peak: 1.0 * v, from: 160, to: 44, decay: 0.3 });
      noiseHit(ctx, dest, when, { peak: 0.28 * v, type: 'highpass', freq: 1800, decay: 0.02 });
      break;
    case 'snare':
      noiseHit(ctx, dest, when, { peak: 0.55 * v, type: 'bandpass', freq: 1900, q: 0.9, decay: 0.16 });
      toneHit(ctx, dest, when, { peak: 0.4 * v, from: 210, to: 170, decay: 0.1 });
      break;
    case 'hat':
      if (metallic || engine === 'chiptune') {
        metalHat(ctx, dest, when, v, 0.05);
      } else {
        noiseHit(ctx, dest, when, { peak: 0.3 * v, type: 'highpass', freq: 7200, decay: 0.045 });
      }
      break;
    case 'openhat':
      noiseHit(ctx, dest, when, { peak: 0.26 * v, type: 'highpass', freq: 6800, decay: 0.22 });
      break;
    case 'clap':
      for (let i = 0; i < 4; i++) {
        noiseHit(ctx, dest, when + i * 0.011, { peak: 0.42 * v, type: 'bandpass', freq: 1200 + i * 180, q: 1.5, decay: 0.08 });
      }
      // body tail so it reads as a clap and not four ticks
      noiseHit(ctx, dest, when + 0.044, { peak: 0.24 * v, type: 'bandpass', freq: 1500, q: 0.9, decay: 0.16 });
      break;
    case 'tom':
      toneHit(ctx, dest, when, { peak: 0.6 * v, from: 190, to: 110, decay: 0.2 });
      break;
    case 'rim':
      noiseHit(ctx, dest, when, { peak: 0.3 * v, type: 'bandpass', freq: 2600, q: 6, decay: 0.03 });
      toneHit(ctx, dest, when, { peak: 0.16 * v, from: 800, to: 700, decay: 0.03 });
      // a second, woodier variant so rim hits are not all identical
      toneHit(ctx, dest, when + 0.004, { peak: 0.1 * v, from: 1450, to: 1350, decay: 0.02, type: 'triangle' });
      break;
    case 'shaker':
      noiseHit(ctx, dest, when, { peak: 0.2 * v, type: 'highpass', freq: 5200, decay: 0.07 });
      break;
    case 'ride':
      noiseHit(ctx, dest, when, { peak: 0.18 * v, type: 'bandpass', freq: 5200, q: 1.1, decay: 0.5 });
      break;
    case 'crash':
      noiseHit(ctx, dest, when, { peak: 0.26 * v, type: 'highpass', freq: 3600, decay: 1.1 });
      break;
    case 'conga':
      toneHit(ctx, dest, when, { peak: 0.5 * v, from: 300, to: 220, decay: 0.16 });
      break;
    case 'timpani':
      toneHit(ctx, dest, when, { peak: 0.55 * v, from: 110, to: 82, decay: 0.6 });
      break;
    case 'cowbell': {
      for (const f of [540, 800]) {
        const osc = ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.value = f;
        const g = ctx.createGain();
        decayEnv(g.gain, when, 0.14 * v, 0.001, 0.18);
        osc.connect(g).connect(dest);
        osc.start(when);
        osc.stop(when + 0.22);
        osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch { /* noop */ } };
      }
      break;
    }
    default:
      noiseHit(ctx, dest, when, { peak: 0.3 * v, type: 'bandpass', freq: 2000, decay: 0.08 });
  }
  return when + 1.2;
}
