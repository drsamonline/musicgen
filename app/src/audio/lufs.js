// ITU-R BS.1770 style loudness measurement (K-weighting + gated mean).
// A compact implementation: enough to hold the −14 LUFS promise honestly.

function kWeightingCoeffs(sampleRate) {
  // Stage 1: high-shelf, stage 2: high-pass (BS.1770-4 tables, rescaled)
  const fs = sampleRate;
  // shelf
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  const shelfB = [
    (Vh + (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - Vh)) / a0,
    (Vh - (Vb * K) / Q + K * K) / a0,
  ];
  const shelfA = [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];

  // high-pass
  const f0h = 38.13547087602444;
  const Qh = 0.5003270373238773;
  const Kh = Math.tan((Math.PI * f0h) / fs);
  const a0h = 1 + Kh / Qh + Kh * Kh;
  const hpB = [1, -2, 1];
  const hpA = [1, (2 * (Kh * Kh - 1)) / a0h, (1 - Kh / Qh + Kh * Kh) / a0h];
  return { shelfB, shelfA, hpB, hpA };
}

function biquad(x, b, a) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xn = x[i];
    const yn = b[0] * xn + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    x2 = x1; x1 = xn; y2 = y1; y1 = yn;
    y[i] = yn;
  }
  return y;
}

// channelData: array of Float32Array (one per channel)
export function integratedLufs(channelData, sampleRate) {
  const { shelfB, shelfA, hpB, hpA } = kWeightingCoeffs(sampleRate);
  const blockLen = Math.round(0.4 * sampleRate);
  const hop = Math.round(0.1 * sampleRate);
  const blockPowers = [];
  const channels = channelData.map((d) => biquad(biquad(d, shelfB, shelfA), hpB, hpA));
  const n = channels[0].length;
  for (let start = 0; start + blockLen <= n; start += hop) {
    let sum = 0;
    for (const ch of channels) {
      let s = 0;
      for (let i = start; i < start + blockLen; i++) s += ch[i] * ch[i];
      sum += s / blockLen;
    }
    blockPowers.push(sum);
  }
  if (!blockPowers.length) return -Infinity;
  const loud = (p) => -0.691 + 10 * Math.log10(Math.max(1e-12, p));
  // absolute gate at -70 LUFS
  let gated = blockPowers.filter((p) => loud(p) > -70);
  if (!gated.length) return -Infinity;
  const mean = gated.reduce((a, b) => a + b, 0) / gated.length;
  const relative = loud(mean) - 10;
  gated = gated.filter((p) => loud(p) > relative);
  if (!gated.length) return -Infinity;
  const mean2 = gated.reduce((a, b) => a + b, 0) / gated.length;
  return loud(mean2);
}

export function truePeak(channelData) {
  let peak = 0;
  for (const ch of channelData) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

export function dbToGain(db) { return Math.pow(10, db / 20); }
