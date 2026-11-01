// Waveguide (Karplus-Strong) with fractional delay, one-pole damping and a
// seeded excitation burst. One node per track; notes arrive as messages.

function seedNoise(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
}

class PhysicalProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = [];
    this.port.onmessage = (e) => {
      const d = e.data;
      if (!d || d.type !== 'note') return;
      this.pluck(d);
    };
  }

  pluck({ when, dur, freq, vel = 0.7, damping = 0.6, brightness = 0.6 }) {
    const len = Math.max(2, Math.round(sampleRate / Math.max(20, freq)));
    const buffer = new Float32Array(len);
    const rand = seedNoise((Math.round(freq * 100) + Math.round(when * 1000)) | 0);
    for (let i = 0; i < len; i++) buffer[i] = rand() * (0.6 + brightness * 0.4);
    this.voices.push({
      buffer,
      index: 0,
      t0: when,
      dur: Math.max(0.1, dur + 0.25),
      amp: Math.min(1.6, vel * 1.6),  // the engine applies a level boost on top
      release: 0.06,
      damp: Math.min(0.995, 0.85 + damping * 0.14),
      lp: 0,
      brightness,
    });
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out.length) return true;
    const left = out[0];
    const n = left.length;
    const dt = 1 / sampleRate;

    for (let i = 0; i < n; i++) {
      const t = currentTime + i * dt;
      let sum = 0;
      for (let v = this.voices.length - 1; v >= 0; v--) {
        const voice = this.voices[v];
        if (t < voice.t0) continue;
        const age = t - voice.t0;
        if (age > voice.dur) { this.voices.splice(v, 1); continue; }
        // fade the last 60 ms so a note never ends on a discontinuity
        const tail = Math.min(1, (voice.dur - age) / voice.release);
        const buf = voice.buffer;
        const cur = buf[voice.index];
        const next = buf[(voice.index + 1) % buf.length];
        // a gentler one-pole: the old coefficient left it sounding like noise
        const filtered = voice.lp + (cur - voice.lp) * (0.12 + voice.brightness * 0.3);
        voice.lp = filtered;
        buf[voice.index] = filtered * voice.damp;
        voice.index = (voice.index + 1) % buf.length;
        // linear interpolation between the two samples for fractional pitch
        sum += (cur * 0.5 + next * 0.5) * voice.amp * tail;
      }
      // soft clip: a hard clamp here was the click everyone could hear
      left[i] = Math.tanh(sum * 0.9);
      if (out.length > 1) out[1][i] = left[i];
    }
    return true;
  }
}

registerProcessor('physical-voice', PhysicalProcessor);
