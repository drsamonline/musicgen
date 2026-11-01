// Granular voice: one node per track, note events arrive as messages and are
// rendered as overlapping windowed grains. Deterministic: the grain scatter
// comes from a hash of the note, not Math.random.

function hash(n) {
  let x = (n * 2654435761) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

class GranularProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.grains = [];
    this.port.onmessage = (e) => {
      const d = e.data;
      if (!d || d.type !== 'note') return;
      this.schedule(d);
    };
  }

  schedule({ when, dur, freq, vel = 0.7, density = 40 }) {
    const length = Math.max(0.08, dur);
    const count = Math.max(1, Math.round(length * density));
    const grainDur = Math.min(0.09, Math.max(0.03, length / 2));
    for (let i = 0; i < count; i++) {
      const seed = hash((freq * 1000 + i * 97 + Math.round(when * 1000)) | 0);
      const spread = (seed - 0.5) * 0.5;          // pitch scatter
      const pos = i / count;
      if (this.grains.length > 120) this.grains.shift();
      this.grains.push({
        t0: when + pos * length + (seed - 0.5) * 0.012,
        dur: grainDur * (0.7 + seed * 0.6),
        freq: freq * (1 + spread * 0.02),
        amp: vel * (0.22 + seed * 0.22) * (1 - pos * 0.35),
        pan: (hash(i * 31 + Math.round(freq)) - 0.5) * 1.2,
        phase: 0,
        env: 0,
      });
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out.length) return true;
    const left = out[0];
    const right = out.length > 1 ? out[1] : null;
    const n = left.length;
    const dt = 1 / sampleRate;

    for (let i = 0; i < n; i++) {
      const t = currentTime + i * dt;
      let l = 0;
      let r = 0;
      for (let g = this.grains.length - 1; g >= 0; g--) {
        const grain = this.grains[g];
        if (t < grain.t0) continue;
        const p = (t - grain.t0) / grain.dur;
        if (p >= 1) { this.grains.splice(g, 1); continue; }
        const win = 0.5 - 0.5 * Math.cos(2 * Math.PI * p); // Hann
        grain.phase += (2 * Math.PI * grain.freq) * dt;
        const s = Math.sin(grain.phase) * win * grain.amp;
        l += s * (1 - Math.max(0, grain.pan));
        r += s * (1 + Math.min(0, grain.pan));
      }
      // tanh, not a hard clamp: clamping is what made dense grains crackle
      left[i] = Math.tanh(l * 1.2);
      if (right) right[i] = Math.tanh(r * 1.2);
    }
    return true;
  }
}

registerProcessor('granular-voice', GranularProcessor);
