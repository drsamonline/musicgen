// Unit + snapshot tests. Run: node tests/unit/run.js
import { compose, normalisePresets, BPM_MIN, BPM_MAX } from '../../app/src/core/composer.js';
import { validateSong } from '../../app/src/core/validate.js';
import { euclid, wolfram, lsystemGrid, buildMarkov, markovNext } from '../../app/src/core/algorithms.js';
import { Rng, mulberry32, hashString } from '../../app/src/core/rng.js';
import { STYLE_IDS } from '../../app/src/presets/styles.js';
import { MOOD_IDS } from '../../app/src/presets/moods.js';
import { THEME_IDS } from '../../app/src/presets/themes.js';
import { TECH_IDS } from '../../app/src/presets/techs.js';
import { TYPE_IDS } from '../../app/src/presets/types.js';
import { encodeWav, analyseBuffer } from '../../app/src/export/wav.js';
import { songToMidi } from '../../app/src/export/midi.js';
import { integratedLufs } from '../../app/src/audio/lufs.js';
import { encodeState, decodeState } from '../../app/src/export/artwork.js';
import { zipStore, crc32 } from '../../app/src/export/zip.js';

let pass = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}: ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}: ${a} !== ${b}`);
}

console.log('\nPRNG');
test('mulberry32 is deterministic', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 50; i++) eq(a(), b(), `call ${i}`);
});
test('different seeds diverge', () => {
  const a = mulberry32(1), b = mulberry32(2);
  assert(a() !== b(), 'seeds 1 and 2 produced the same first value');
});
test('distribution is roughly uniform', () => {
  const r = mulberry32(7);
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 20000; i++) buckets[Math.floor(r() * 10)]++;
  for (const b of buckets) assert(b > 1700 && b < 2300, `bucket out of range: ${b}`);
});
test('fork streams are independent and stable', () => {
  const a = new Rng('abc').fork('drums').float();
  const b = new Rng('abc').fork('drums').float();
  const c = new Rng('abc').fork('bass').float();
  eq(a, b, 'fork not stable');
  assert(a !== c, 'fork streams collided');
});

console.log('\nAlgorithms');
test('euclid(3,8) matches the classic pattern', () => {
  eq(euclid(3, 8).join(''), '10010010');
});
test('euclid is rotation-closed', () => {
  for (let r = 0; r < 8; r++) eq(euclid(3, 8, r).reduce((a, b) => a + b, 0), 3, `rotation ${r}`);
});
test('euclid(0,n) and euclid(n,n) behave', () => {
  eq(euclid(0, 8).reduce((a, b) => a + b, 0), 0);
  eq(euclid(8, 8).reduce((a, b) => a + b, 0), 8);
});
test('markov chain produces in-corpus successors', () => {
  const table = buildMarkov([['a', 'b', 'c', 'a', 'b', 'd']], 2);
  const rng = new Rng('m');
  for (let i = 0; i < 50; i++) {
    const nxt = markovNext(table, ['a', 'b'], rng);
    assert(['c', 'd'].includes(nxt), `unexpected successor ${nxt}`);
  }
});
test('wolfram rule 90 is deterministic', () => {
  const a = wolfram(90, 16, null, new Rng('w'));
  const b = wolfram(90, 16, null, new Rng('w'));
  eq(JSON.stringify(a), JSON.stringify(b));
});
test('lsystem expands', () => {
  const g = lsystemGrid('X', { X: 'XfX', f: 'ff' }, 2, 16);
  eq(g.length, 16);
  assert(g.some((x) => x === 1), 'no hits in grid');
});

console.log('\nComposer determinism');
test('same (presets, seed) is byte-identical over 100 runs', () => {
  const presets = { style: 'edm', mood: 'epic', theme: 'festival', tech: 'wavetable', bpm: 126, type: 'full' };
  const first = JSON.stringify(compose(presets, 'det-seed'));
  for (let i = 0; i < 100; i++) {
    eq(JSON.stringify(compose(presets, 'det-seed')), first, `run ${i}`);
  }
});
test('different seeds differ', () => {
  const p = { style: 'lofi', mood: 'calm', theme: 'rain', tech: 'analog', bpm: 80, type: 'full' };
  assert(JSON.stringify(compose(p, 'one')) !== JSON.stringify(compose(p, 'two')), 'seeds produced identical songs');
});
test('presets are echoed back into the song', () => {
  const s = compose({ style: 'jazz', mood: 'playful', theme: 'nightdrive', tech: 'physical', bpm: 120, type: 'aba' }, 'echo');
  eq(s.presets.style, 'jazz');
  eq(s.presets.bpm, 120);
  assert(s.bars > 0, 'no bars');
});

console.log('\nTheory validation');
test('the whole style x mood matrix passes the validator', () => {
  const bad = [];
  for (const style of STYLE_IDS) {
    for (const mood of MOOD_IDS) {
      for (const seed of ['a', 'b']) {
        const song = compose({ style, mood, theme: 'space', tech: 'analog', bpm: 100, type: 'full' }, seed + style + mood);
        const res = validateSong(song);
        if (!res.ok) bad.push(`${style}/${mood}/${seed}: ${res.issues[0]}`);
      }
    }
  }
  assert(bad.length === 0, `${bad.length} failures, e.g. ${bad.slice(0, 3).join(' | ')}`);
});
test('every theme, tech, type and time signature composes and validates', () => {
  const bad = [];
  for (const theme of THEME_IDS) {
    for (const tech of TECH_IDS) {
      const s = compose({ style: 'cinematic', mood: 'epic', theme, tech, bpm: 70, type: 'aba' }, `t-${theme}-${tech}`);
      if (!validateSong(s).ok) bad.push(`${theme}/${tech}`);
    }
  }
  for (const type of TYPE_IDS) {
    for (const ts of [[4, 4], [3, 4], [6, 8], [5, 4], [7, 8]]) {
      const s = compose({ style: 'world', mood: 'playful', theme: 'desert', tech: 'physical', bpm: 110, type, timeSig: ts }, `ts-${type}-${ts.join('')}`);
      const r = validateSong(s);
      if (!r.ok) bad.push(`${type}/${ts.join('/')}: ${r.issues[0]}`);
    }
  }
  assert(bad.length === 0, `${bad.length} failures, e.g. ${bad.slice(0, 3).join(' | ')}`);
});
test('random seeds are not garbage (>=90% valid)', () => {
  let ok = 0;
  const n = 100;
  for (let i = 0; i < n; i++) {
    const rng = new Rng(`rand-${i}`);
    const s = compose({
      style: STYLE_IDS[rng.int(STYLE_IDS.length)],
      mood: MOOD_IDS[rng.int(MOOD_IDS.length)],
      theme: THEME_IDS[rng.int(THEME_IDS.length)],
      tech: TECH_IDS[rng.int(TECH_IDS.length)],
      bpm: 60 + rng.int(80),
      type: TYPE_IDS[rng.int(TYPE_IDS.length)],
    }, `r${i}`);
    if (validateSong(s).ok) ok++;
  }
  assert(ok / n >= 0.9, `only ${ok}/${n} valid`);
});

console.log('\nComposer features (v2)');
test('tempo is clamped to 20–500 BPM', () => {
  eq(BPM_MIN, 20);
  eq(BPM_MAX, 500);
  eq(normalisePresets({ bpm: 1 }).bpm, 20);
  eq(normalisePresets({ bpm: 9000 }).bpm, 500);
});
test('songs compose and validate at 20 and 500 BPM', () => {
  for (const bpm of [20, 500]) {
    const song = compose({ style: 'edm', mood: 'epic', theme: 'festival', tech: 'analog', bpm, type: 'full' }, `bpm-${bpm}`);
    eq(song.bpm, bpm);
    const res = validateSong(song);
    assert(res.ok, `${bpm} BPM: ${res.issues[0]}`);
    assert(song.durationSec > 0, 'no duration');
  }
});
test('a locked track ignores the song seed', () => {
  const base = { style: 'rock', mood: 'epic', theme: 'desert', tech: 'analog', bpm: 120, type: 'full' };
  const locked = { ...base, lockTracks: { drums: true }, trackSeeds: { drums: 'fixed' } };
  const a = compose(locked, 'one');
  const b = compose(locked, 'two');
  eq(JSON.stringify(a.tracks.drums), JSON.stringify(b.tracks.drums), 'drums changed');
  assert(JSON.stringify(a.tracks.lead) !== JSON.stringify(b.tracks.lead), 'lead did not change');
});
test('sections can modulate, and the validator follows the new key', () => {
  let modulated = 0;
  for (let i = 0; i < 20; i++) {
    const song = compose({ style: 'cinematic', mood: 'epic', theme: 'space', tech: 'additive', bpm: 70, type: 'full' }, `mod${i}`);
    const keys = new Set(song.sections.map((s) => s.key.tonic));
    if (keys.size > 1) {
      modulated++;
      assert(validateSong(song).ok, 'modulated song failed validation');
    }
  }
  assert(modulated > 0, 'no song ever modulated');
});
test('A-B-A reuses the A section material', () => {
  const song = compose({ style: 'lofi', mood: 'calm', theme: 'rain', tech: 'analog', bpm: 80, type: 'aba' }, 'alias');
  const [a1, , a2] = song.sections;
  eq(a1.chords.map((c) => c.symbol).join(' '), a2.chords.map((c) => c.symbol).join(' '));
});
test('golden seeds are stable', () => {
  const seeds = [
    ['lofi', 'dreamy', 'rain', 84],
    ['edm', 'epic', 'festival', 128],
    ['jazz', 'playful', 'nightdrive', 132],
  ];
  const hashes = seeds.map(([style, mood, theme, bpm]) => {
    const song = compose({ style, mood, theme, tech: 'analog', bpm, type: 'loop' }, `golden-${style}`);
    return `${song.title}|${song.totalNotes}|${song.bars}|${song.key.name}`;
  });
  // A change here is a deliberate composer change — update the snapshot on purpose.
  const snapshot = [
    'The Window|227|8|C lydian',
    'Sunrise Set / Firework|332|8|F ionian',
    'Dash Glow / Toll Road|331|8|C mixolydian',
  ];
  eq(JSON.stringify(hashes), JSON.stringify(snapshot), 'golden seeds drifted');
});

console.log('\nProperty checks');
test('random preset/seed pairs stay inside the invariants', () => {
  const rng = new Rng('properties');
  let valid = 0;
  const N = 40;
  for (let i = 0; i < N; i++) {
    const presets = {
      style: STYLE_IDS[rng.int(STYLE_IDS.length)],
      mood: MOOD_IDS[rng.int(MOOD_IDS.length)],
      theme: THEME_IDS[rng.int(THEME_IDS.length)],
      tech: TECH_IDS[rng.int(TECH_IDS.length)],
      bpm: 20 + rng.int(481),
      type: TYPE_IDS[rng.int(TYPE_IDS.length)],
      timeSig: [[4, 4], [3, 4], [6, 8], [5, 4], [7, 8]][rng.int(5)],
    };
    const seed = `p${i}`;
    const song = compose(presets, seed);
    assert(song.durationSec > 0 && Number.isFinite(song.durationSec), 'bad duration');
    assert(song.bars > 0, 'no bars');
    for (const [track, notes] of Object.entries(song.tracks)) {
      for (const n of notes) {
        assert(Number.isFinite(n.t) && Number.isFinite(n.v), `${track}: non-finite note`);
        if (track !== 'drums') assert(n.p >= 21 && n.p <= 108, `${track}: pitch ${n.p} out of range`);
      }
    }
    eq(JSON.stringify(compose(presets, seed)), JSON.stringify(song), 'not deterministic');
    if (validateSong(song).ok) valid++;
  }
  assert(valid / N >= 0.9, `only ${valid}/${N} valid`);
});
test('chord voicings never exceed the instrument range', () => {
  const rng = new Rng('ranges');
  for (let i = 0; i < 20; i++) {
    const song = compose({ style: 'jazz', mood: MOOD_IDS[rng.int(MOOD_IDS.length)], theme: 'space', tech: 'analog', bpm: 120, type: 'full' }, `r${i}`);
    for (const sec of song.sections) {
      for (const ch of sec.chords) {
        for (const p of ch.voicing) assert(p >= 40 && p <= 92, `voicing pitch ${p} out of range`);
      }
    }
  }
});

console.log('\nExport');
test('WAV header and length are correct', () => {
  const frames = 1000;
  const fake = {
    numberOfChannels: 2,
    length: frames,
    sampleRate: 44100,
    getChannelData: () => new Float32Array(frames).map((_, i) => Math.sin(i / 10) * 0.5),
  };
  const bytes = encodeWav(fake, { bitDepth: 16 });
  eq(bytes.length, 44 + frames * 2 * 2, 'byte length');
  eq(String.fromCharCode(...bytes.slice(0, 4)), 'RIFF');
  eq(String.fromCharCode(...bytes.slice(8, 12)), 'WAVE');
});
test('WAV normalisation analysis runs', () => {
  const frames = 44100;
  const fake = {
    numberOfChannels: 1, length: frames, sampleRate: 44100,
    getChannelData: () => new Float32Array(frames).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / 44100) * 0.1),
  };
  const info = analyseBuffer(fake);
  assert(isFinite(info.lufs), 'lufs not finite');
  assert(info.peakDb < 0, 'peak should be below full scale');
});
test('MIDI file has a valid header and tracks', () => {
  const song = compose({ style: 'lofi', mood: 'calm', theme: 'rain', tech: 'analog', bpm: 84, type: 'loop' }, 'midi-test');
  const bytes = songToMidi(song);
  eq(String.fromCharCode(...bytes.slice(0, 4)), 'MThd');
  const nTracks = (bytes[10] << 8) | bytes[11];
  assert(nTracks >= 4, `only ${nTracks} tracks`);
  const hasEndOfTrack = bytes.includes(0x2f);
  assert(hasEndOfTrack, 'no end-of-track event');
});
test('share state round-trips', () => {
  const presets = { style: 'trap', mood: 'dark', theme: 'cyberpunk', tech: 'fm', bpm: 140, type: 'full', timeSig: [7, 8], intensityBias: 0.2, swing: 0.1, arp: true };
  const encoded = encodeState(presets, 'seed123');
  const decoded = decodeState(encoded);
  eq(decoded.presets.style, 'trap');
  eq(decoded.presets.bpm, 140);
  eq(decoded.presets.timeSig.join('x'), '7x8');
  eq(decoded.seed, 'seed123');
  assert(encoded.length < 160, `share string too long: ${encoded.length}`);
});
test('zip writer produces a valid store-only archive', () => {
  const enc = new TextEncoder();
  const files = [
    { name: 'a.txt', data: enc.encode('hello stems') },
    { name: 'b.bin', data: new Uint8Array([1, 2, 3, 4, 5]) },
  ];
  const zip = zipStore(files);
  eq(String.fromCharCode(...zip.slice(0, 2)), 'PK', 'zip signature');
  const total = files.reduce((a, f) => a + f.data.length, 0);
  assert(zip.length > total, 'archive smaller than its payload');
  eq(crc32(enc.encode('hello stems')), 0xfc7366a8, 'crc32 of a known string');
});
test('garbage share strings are rejected, not applied', () => {
  eq(decodeState('not-base64-!!!'), null);
  eq(decodeState(btoa('{"broken":')), null);
});

console.log('\nLoudness');
test('LUFS of a -20 dBFS 1 kHz sine is in a sane range', () => {
  const sr = 48000;
  const n = sr * 3;
  const d = new Float32Array(n);
  const amp = Math.pow(10, -20 / 20);
  for (let i = 0; i < n; i++) d[i] = Math.sin((2 * Math.PI * 1000 * i) / sr) * amp;
  const lufs = integratedLufs([d, d], sr);
  assert(lufs > -26 && lufs < -17, `unexpected LUFS ${lufs}`);
});
test('silence reads as -Infinity', () => {
  const sr = 48000;
  const d = new Float32Array(sr);
  assert(integratedLufs([d], sr) === -Infinity, 'silence should be -Infinity');
});

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(f.name, '\n', f.err);
  process.exit(1);
}
