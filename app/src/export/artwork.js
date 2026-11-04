// Share URLs + procedural cover art.
import { Rng } from '../core/rng.js';
import { COMPOSER_VERSION } from '../core/composer.js';

const SHORT = ['s', 'm', 't', 'h', 'b', 'y', 'k', 'i', 'w', 'a', 'p', 'c', 'd'];

export function encodeState(presets, seed) {
  const compact = {
    s: presets.style, m: presets.mood, t: presets.theme, h: presets.tech,
    b: presets.bpm, y: presets.type, k: presets.timeSig?.join('x'),
    i: presets.intensityBias || 0, w: presets.swing ?? null,
    a: presets.arp ? 1 : 0, p: seed, v: COMPOSER_VERSION,
  };
  const json = JSON.stringify(compact);
  const b64 = btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return b64;
}

export function decodeState(str) {
  try {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(escape(atob(b64)));
    return decodeCompact(JSON.parse(json));
  } catch {
    return null;
  }
}

// Async because a plan-carrying link may be deflated. Everything else resolves
// on the first tick.
export async function decodeShare(str) {
  if (!str) return null;
  if (str[0] !== PLAN_MARK) return decodeState(str);
  try {
    const kind = str[1];
    const bytes = fromB64(str.slice(2));
    const json = kind === 'z' ? await inflate(bytes) : new TextDecoder().decode(bytes);
    const c = JSON.parse(json);
    const decoded = decodeCompact(c);
    if (!decoded) return null;
    if (c.pl) decoded.plan = c.pl;
    return decoded;
  } catch {
    return null;
  }
}

function decodeCompact(c) {
  try {
    const [bars, unit] = String(c.k || '4x4').split('x').map(Number);
    return {
      presets: {
        style: c.s, mood: c.m, theme: c.t, tech: c.h,
        bpm: Number(c.b), type: c.y,
        timeSig: [bars || 4, unit || 4],
        intensityBias: Number(c.i) || 0,
        swing: c.w == null ? null : Number(c.w),
        arp: !!c.a,
      },
      seed: String(c.p || ''),
      composerVersion: c.v == null ? null : Number(c.v),
    };
  } catch {
    return null;
  }
}

export function shareUrl(presets, seed) {
  const base = `${location.origin}${location.pathname}`;
  return `${base}#s=${encodeState(presets, seed)}`;
}

// ------------------------------------------------------- sharing a plan
//
// A generated song is six dials and a seed. An *edited* song is more than
// that, so its link has to carry the plan itself or it would quietly hand the
// recipient a different song. The plan is JSON; deflate-raw takes ~9 KB of it
// to about 1.5 KB, which fits a URL fragment comfortably.
//
// Links written before this existed carry no marker and decode exactly as they
// always did, so nothing already shared breaks.
const PLAN_MARK = '~';

function toB64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64(str) {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deflate(str) {
  if (typeof CompressionStream !== 'function') return null;
  try {
    const stream = new Blob([new TextEncoder().encode(str)])
      .stream()
      .pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

async function inflate(bytes) {
  if (typeof DecompressionStream !== 'function') throw new Error('no DecompressionStream');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

// Encode a song *including* an edited plan. `plan` may be null, in which case
// this is byte-identical to encodeState().
export async function encodeShare(presets, seed, plan) {
  if (!plan) return encodeState(presets, seed);
  const compact = JSON.parse(JSON.stringify({ presets, seed }));
  const body = JSON.stringify({
    s: compact.presets.style, m: compact.presets.mood, t: compact.presets.theme,
    h: compact.presets.tech, b: compact.presets.bpm, y: compact.presets.type,
    k: compact.presets.timeSig?.join('x'), p: String(seed),
    v: COMPOSER_VERSION, pl: plan,
  });
  const packed = await deflate(body);
  if (!packed) return `${PLAN_MARK}j${toB64(new TextEncoder().encode(body))}`;
  return `${PLAN_MARK}z${toB64(packed)}`;
}

export async function shareUrlFor(presets, seed, plan) {
  const base = `${location.origin}${location.pathname}`;
  return `${base}#s=${await encodeShare(presets, seed, plan)}`;
}

// --------------------------------------------------------------- artwork
export function drawArtwork(canvas, song, size = 512) {
  const ctx = canvas.getContext('2d');
  canvas.width = size;
  canvas.height = size;
  const palette = song.palette || ['#0b1026', '#1b2a5e', '#5f7bd9', '#c9d6ff'];
  const rng = new Rng(song.seed + '|art');

  const g = ctx.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, palette[0]);
  g.addColorStop(0.55, palette[1]);
  g.addColorStop(1, palette[2]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  // seeded generative pattern: rings + bars driven by the song data
  const notes = song.tracks.lead || [];
  const n = Math.min(140, notes.length);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const note = notes[Math.floor((i / n) * notes.length)];
    const r = 20 + ((note.p - 40) / 60) * size * 0.55;
    const a = rng.range(0, Math.PI * 2);
    ctx.beginPath();
    ctx.arc(size / 2 + Math.cos(a) * r * 0.18, size / 2 + Math.sin(a) * r * 0.18, r * 0.5, 0, Math.PI * 2);
    ctx.strokeStyle = hexAlpha(palette[3] || '#ffffff', 0.05 + note.v * 0.09);
    ctx.lineWidth = 1 + note.v * 2.5;
    ctx.stroke();
  }

  // waveform ribbon from the drum pattern
  const drums = song.tracks.drums || [];
  ctx.globalCompositeOperation = 'source-over';
  ctx.beginPath();
  const total = song.bars * song.beatsPerBar;
  for (let x = 0; x < size; x++) {
    const beat = (x / size) * total;
    let energy = 0;
    for (const d of drums) {
      const dist = Math.abs(d.t - beat);
      if (dist < 1.2) energy += d.v * (1 - dist / 1.2) * (d.drum === 'kick' ? 1 : 0.55);
    }
    const y = size / 2 - Math.min(1, energy) * size * 0.22;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = hexAlpha(palette[3] || '#ffffff', 0.85);
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // title
  ctx.fillStyle = hexAlpha(palette[3] || '#ffffff', 0.95);
  ctx.font = `600 ${Math.round(size * 0.052)}px system-ui, -apple-system, Segoe UI, sans-serif`;
  ctx.fillText(song.title.slice(0, 26), size * 0.07, size * 0.9);
  ctx.font = `400 ${Math.round(size * 0.032)}px system-ui, -apple-system, Segoe UI, sans-serif`;
  ctx.fillStyle = hexAlpha(palette[3] || '#ffffff', 0.6);
  ctx.fillText(`${song.key.name} · ${song.bpm} BPM · ${song.seed.slice(0, 6)}`, size * 0.07, size * 0.94);

  return canvas;
}

function hexAlpha(hex, a) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
