// Standard MIDI File reader — enough to lift a human phrase out of a DAW and
// use it as the song's theme. Type 0 and 1, running status, tempo ignored
// (we work in beats, and the app has its own tempo map).

function readVarLen(bytes, pos) {
  let value = 0;
  let p = pos;
  for (let i = 0; i < 4; i++) {
    const b = bytes[p++];
    value = (value << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return [value, p];
}

export function parseMidi(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let pos = 0;
  const str4 = () => String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
  const u32 = () => ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
  const u16 = () => (bytes[pos] << 8) | bytes[pos + 1];

  if (str4() !== 'MThd') throw new Error('not a MIDI file');
  pos += 4;
  const headerLen = u32();
  pos += 4;
  const format = u16();
  pos += 2;
  const trackCount = u16();
  pos += 2;
  let division = u16();
  pos += 2;
  pos += Math.max(0, headerLen - 6);
  if (division & 0x8000) division = 480; // SMPTE timing: fall back to a sane PPQ

  const tracks = [];
  let tempo = 120;

  for (let t = 0; t < trackCount && pos < bytes.length; t++) {
    const id = str4();
    if (id !== 'MTrk') break;
    pos += 4;
    const len = u32();
    pos += 4;
    const end = Math.min(bytes.length, pos + len);

    let tick = 0;
    let running = 0;
    const open = new Map();
    const notes = [];
    let name = '';

    while (pos < end) {
      const [delta, afterDelta] = readVarLen(bytes, pos);
      pos = afterDelta;
      tick += delta;
      let status = bytes[pos];
      if (status < 0x80) {
        status = running; // running status: reuse the last status byte
      } else {
        pos++;
        running = status;
      }
      const type = status & 0xf0;

      if (status === 0xff) {
        const metaType = bytes[pos++];
        const [metaLen, afterLen] = readVarLen(bytes, pos);
        pos = afterLen;
        if (metaType === 0x03) {
          name = String.fromCharCode(...bytes.slice(pos, pos + metaLen));
        } else if (metaType === 0x51 && metaLen === 3) {
          const micros = (bytes[pos] << 16) | (bytes[pos + 1] << 8) | bytes[pos + 2];
          if (micros > 0) tempo = Math.round(60000000 / micros);
        }
        pos += metaLen;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        const [metaLen, afterLen] = readVarLen(bytes, pos);
        pos = afterLen + metaLen;
        continue;
      }

      if (type === 0x90 || type === 0x80) {
        const note = bytes[pos];
        const vel = bytes[pos + 1];
        pos += 2;
        const key = `${status & 0x0f}:${note}`;
        if (type === 0x90 && vel > 0) {
          open.set(key, { tick, vel });
        } else if (open.has(key)) {
          const start = open.get(key);
          open.delete(key);
          notes.push({ start: start.tick, end: tick, p: note, v: start.vel / 127 });
        }
      } else if (type === 0xc0 || type === 0xd0) {
        pos += 1;
      } else {
        pos += 2;
      }
    }

    // close anything still held at the end of the track
    for (const [, start] of open) notes.push({ start: start.tick, end: tick, p: start.p ?? 60, v: start.vel / 127 });

    if (notes.length) {
      notes.sort((a, b) => a.start - b.start || a.p - b.p);
      tracks.push({ name, notes, channel: 0 });
    }
  }

  return { format, division, tempo, tracks };
}

// Reduce a track to a single melodic line. Overlaps are truncated, not
// dropped: dropping is what turns a legato melody into two notes.
function monophonic(notes) {
  const sorted = notes.slice().sort((a, b) => a.start - b.start || b.p - a.p);
  const out = [];
  for (const n of sorted) {
    const prev = out[out.length - 1];
    if (prev && n.start <= prev.start) continue;
    if (prev && n.start < prev.end) {
      // keep the higher of the two at the same onset, else shorten the first
      if (Math.abs(n.start - prev.start) < 1e-6 && n.p > prev.p) {
        out[out.length - 1] = { ...n };
        continue;
      }
      prev.end = Math.max(prev.start + 1, n.start);
    }
    out.push({ ...n });
  }
  return out;
}

// Lift the most melodic track as a theme: notes in beats, capped at two bars.
export function extractTheme(input, { maxBeats = 8, beatsPerBar = 4 } = {}) {
  const parsed = parseMidi(input);
  if (!parsed.tracks.length) throw new Error('no notes in this file');

  // the melody is the highest-register line with enough notes to be a phrase
  const ranked = parsed.tracks
    .map((t) => ({ ...t, line: monophonic(t.notes) }))
    .filter((t) => t.line.length > 2)
    .map((t) => {
      const avg = t.line.reduce((a, n) => a + n.p, 0) / t.line.length;
      // register matters, but a line with three notes is not a phrase
      return { ...t, avg, score: (avg - 60) + Math.min(14, t.line.length * 1.2) };
    })
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) throw new Error('no melodic line found');

  const line = ranked[0].line;
  const ppq = parsed.division || 480;
  const origin = line[0].start;
  const notes = [];
  for (const n of line) {
    const t = (n.start - origin) / ppq;
    if (t >= maxBeats) break;
    const d = Math.max(0.25, (n.end - n.start) / ppq);
    notes.push({ t: Math.round(t * 4) / 4, d: Math.round(Math.min(4, d) * 4) / 4, p: n.p, v: Math.max(0.3, n.v) });
  }
  return {
    notes,
    beats: Math.max(beatsPerBar, Math.ceil((notes[notes.length - 1].t + notes[notes.length - 1].d) / beatsPerBar) * beatsPerBar),
    tempo: parsed.tempo,
    trackName: ranked[0].name,
  };
}
