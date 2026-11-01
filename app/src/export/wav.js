// WAV export: OfflineAudioContext render -> PCM encoder.
import { integratedLufs, truePeak, truePeakOversampled, dbToGain } from '../audio/lufs.js';

export function encodeWav(audioBuffer, { bitDepth = 16, gain = 1 } = {}) {
  const channels = audioBuffer.numberOfChannels;
  const frames = audioBuffer.length;
  const sampleRate = audioBuffer.sampleRate;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true); // 3 = IEEE float
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const data = [];
  for (let c = 0; c < channels; c++) data.push(audioBuffer.getChannelData(c));

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      let s = data[c][i] * gain;
      s = Math.max(-1, Math.min(1, s));
      if (bitDepth === 16) {
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      } else if (bitDepth === 24) {
        const v = Math.round(s * 8388607);
        view.setUint8(offset, v & 0xff);
        view.setUint8(offset + 1, (v >> 8) & 0xff);
        view.setUint8(offset + 2, (v >> 16) & 0xff);
      } else {
        view.setFloat32(offset, s, true);
      }
      offset += bytesPerSample;
    }
  }
  return new Uint8Array(buffer);
}

export function analyseBuffer(audioBuffer) {
  const data = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) data.push(audioBuffer.getChannelData(c));
  return {
    lufs: integratedLufs(data, audioBuffer.sampleRate),
    peakDb: truePeakOversampled(data),
    channels: audioBuffer.numberOfChannels,
    sampleRate: audioBuffer.sampleRate,
    durationSec: audioBuffer.length / audioBuffer.sampleRate,
  };
}

// gain needed to hit the song's loudness target, clamped so we never
// push true peak above -1 dBTP
export function normalisationGain(audioBuffer, targetLufs, ceilingDb = -1) {
  const { lufs, peakDb } = analyseBuffer(audioBuffer);
  if (!isFinite(lufs)) return 1;
  let gain = dbToGain(targetLufs - lufs);
  const peakAfter = peakDb + 20 * Math.log10(gain);
  if (peakAfter > ceilingDb) gain *= dbToGain(ceilingDb - peakAfter);
  return gain;
}

export function download(blobOrBytes, filename) {
  const blob = blobOrBytes instanceof Blob ? blobOrBytes : new Blob([blobOrBytes], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
