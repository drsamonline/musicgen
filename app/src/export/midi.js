// Standard MIDI File writer (Type 1). Hand-rolled, no dependencies.
// Tracks: 0 = tempo/meta, 1 = drums (ch 10), 2 = bass, 3 = chords, 4 = lead.

const PPQ = 480;

function vlq(n) {
  const bytes = [n & 0x7f];
  n >>= 7;
  while (n > 0) {
    bytes.unshift((n & 0x7f) | 0x80);
    n >>= 7;
  }
  return bytes;
}

function str(s) {
  return [...s].map((c) => c.charCodeAt(0));
}

function u32(n) {
  return [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function u16(n) {
  return [(n >> 8) & 0xff, n & 0xff];
}

const DRUM_MAP = {
  kick: 36, snare: 38, clap: 39, rim: 37, hat: 42, openhat: 46,
  tom: 45, shaker: 70, ride: 51, crash: 49, conga: 64, timpani: 47, cowbell: 56,
};

function trackChunk(name, events) {
  // events: [{tick, bytes}]
  const sorted = events.slice().sort((a, b) => a.tick - b.tick);
  const data = [];
  let last = 0;
  for (const e of sorted) {
    data.push(...vlq(Math.max(0, Math.round(e.tick) - last)));
    data.push(...e.bytes);
    last = Math.round(e.tick);
  }
  data.push(...vlq(0), 0xff, 0x2f, 0x00);
  const head = [...str('MTrk'), ...u32(data.length)];
  return [...head, ...data];
}

function noteEvents(notes, channel, ticksPerBeat, transpose = 0, velocityScale = 1) {
  const evs = [];
  for (const n of notes) {
    const on = Math.round(n.t * ticksPerBeat);
    const off = Math.max(on + 1, Math.round((n.t + Math.max(0.03, n.d)) * ticksPerBeat));
    const pitch = Math.max(0, Math.min(127, Math.round(n.p + transpose)));
    const vel = Math.max(1, Math.min(127, Math.round(n.v * 100 * velocityScale)));
    evs.push({ tick: on, bytes: [0x90 | channel, pitch, vel] });
    evs.push({ tick: off, bytes: [0x80 | channel, pitch, 0] });
  }
  return evs;
}

export function songToMidi(song) {
  const ticksPerBeat = PPQ;
  const chunks = [];

  // track 0: tempo + time signature + name
  const meta = [];
  meta.push({ tick: 0, bytes: [0xff, 0x03, song.title.length, ...str(song.title.slice(0, 60))] });
  const usPerQuarter = Math.round(60000000 / (song.bpm || 100));
  meta.push({
    tick: 0,
    bytes: [0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff],
  });
  meta.push({ tick: 0, bytes: [0xff, 0x58, 0x04, song.timeSig[0], Math.round(Math.log2(song.timeSig[1] || 4)), 24, 8] });
  chunks.push(trackChunk('tempo', meta));

  chunks.push(trackChunk('drums', (song.tracks.drums || []).map((n) => {
    const on = Math.round(n.t * ticksPerBeat);
    const pitch = DRUM_MAP[n.drum] ?? 38;
    return { tick: on, bytes: [0x99, pitch, Math.max(1, Math.min(127, Math.round(n.v * 110)))] };
  }).concat((song.tracks.drums || []).map((n) => ({
    tick: Math.round(n.t * ticksPerBeat) + 20, bytes: [0x89, DRUM_MAP[n.drum] ?? 38, 0],
  })))));

  chunks.push(trackChunk('bass', noteEvents(song.tracks.bass || [], 0, ticksPerBeat)));
  chunks.push(trackChunk('chords', noteEvents(song.tracks.chords || [], 1, ticksPerBeat)));
  chunks.push(trackChunk('lead', noteEvents(song.tracks.lead || [], 2, ticksPerBeat)));
  if ((song.tracks.pad || []).length) chunks.push(trackChunk('pad', noteEvents(song.tracks.pad, 3, ticksPerBeat)));

  const header = [...str('MThd'), ...u32(6), ...u16(1), ...u16(chunks.length), ...u16(PPQ)];
  const bytes = new Uint8Array([...header, ...chunks.flat()]);
  return bytes;
}
