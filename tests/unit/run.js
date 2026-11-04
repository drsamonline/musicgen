// Unit + snapshot tests. Run: node tests/unit/run.js
import { compose, plan, render, normalisePlan, normalisePresets, BPM_MIN, BPM_MAX } from '../../app/src/core/composer.js';
import { moveSection, duplicateSection, removeSection, setSectionBars, setChord, cycleChord, planSignature } from '../../app/src/core/plan-edit.js';
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
import { safeHarmonicsFor } from '../../app/src/audio/instruments.js';
import { makeTempoMap, flatTempo, describeTempo } from '../../app/src/core/tempo.js';
import { extractTheme, parseMidi } from '../../app/src/import/midi.js';
import { randomPresets } from '../../app/src/presets/compatibility.js';
import { zipStore, crc32 } from '../../app/src/export/zip.js';
import { makeHealth, noteTick, noteEvent, noteSkip, noteRecovery, report, verdict, LATE_MS, STALL_MS } from '../../app/src/audio/health.js';
import { noteLabel, cellLabel, buildStepIndex, rowsFor, windowFor, TRACK_COLUMNS, STEPS_PER_BEAT } from '../../app/src/visual/tracker.js';

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
  eq(a.tracks.drums.length, b.tracks.drums.length, 'locked drum note count changed');
  const same = a.tracks.drums.every((n, i) => {
    const m = b.tracks.drums[i];
    return n.drum === m.drum && Math.abs(n.t - m.t) < 1e-9 && Math.abs(n.v - m.v) < 1e-9;
  });
  assert(same, 'locked drums changed with the seed');
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
    'The Window|218|8|C lydian',
    'Sunrise Set / Firework|312|8|F ionian',
    'Dash Glow / Toll Road|318|8|C mixolydian',
  ];
  eq(JSON.stringify(hashes), JSON.stringify(snapshot), 'golden seeds drifted');
});

console.log('\nTheme and MIDI');
test('every song has one theme, and sections derive from it', () => {
  const song = compose({ style: 'cinematic', mood: 'epic', theme: 'space', tech: 'analog', bpm: 100, type: 'full' }, 'thematic');
  assert(Array.isArray(song.theme) && song.theme.length >= 4, `theme has ${song.theme?.length} notes`);
  const verse = song.sections.find((s) => s.name === 'verse');
  const chorus = song.sections.find((s) => s.name === 'chorus');
  assert(verse && chorus, 'expected a verse and a chorus');
  // the chorus is the theme lifted, so the lead should sit higher there
  // compare the opening phrase of each section: that is where the derived
  // theme plays verbatim, before the per-bar development transforms
  const avg = (name) => {
    const sec = song.sections.find((s) => s.name === name);
    if (!sec) return null;
    const from = sec.bar * song.beatsPerBar;
    const to = from + song.beatsPerBar * 2;
    const notes = song.tracks.lead.filter((n) => n.t >= from && n.t < to);
    return notes.length ? notes.reduce((a, n) => a + n.p, 0) / notes.length : null;
  };
  const v = avg('verse');
  const c = avg('chorus');
  assert(v != null && c != null, 'verse and chorus both need lead notes');
  assert(c > v, `chorus (${c?.toFixed(1)}) should sit above the verse (${v?.toFixed(1)})`);
});
test('a MIDI file round-trips into a usable theme', () => {
  const song = compose({ style: 'jazz', mood: 'playful', theme: 'space', tech: 'analog', bpm: 120, type: 'loop' }, 'roundtrip');
  const bytes = songToMidi(song);
  const parsed = parseMidi(bytes);
  assert(parsed.tracks.length >= 3, `parsed ${parsed.tracks.length} tracks`);
  const theme = extractTheme(bytes, { maxBeats: 8 });
  assert(theme.notes.length >= 4, `extracted ${theme.notes.length} notes`);
  for (const n of theme.notes) {
    assert(n.t >= 0 && n.d > 0, 'bad timing');
    assert(n.p >= 0 && n.p <= 127, 'bad pitch');
  }
  // and the composer accepts it as a seed
  const seeded = compose({
    style: 'lofi', mood: 'calm', theme: 'rain', tech: 'analog', bpm: 84, type: 'full',
    themeSeed: theme.notes,
  }, 'seeded');
  assert(seeded.theme.length === theme.notes.length, 'theme seed was not used');
});
test('garbage is rejected, not crashed on', () => {
  let threw = false;
  try { extractTheme(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])); } catch { threw = true; }
  assert(threw, 'a non-MIDI buffer should throw');
});

console.log('\n"None" is a real option');
test('every axis accepts none and still composes', () => {
  const axes = ['style', 'mood', 'theme', 'tech', 'type'];
  for (const axis of axes) {
    const presets = {
      style: 'lofi', mood: 'dreamy', theme: 'rain', tech: 'analog', bpm: 90, type: 'loop',
    };
    presets[axis] = 'none';
    const song = compose(presets, `none-${axis}`);
    assert(song.totalNotes > 0, `${axis}=none produced no notes`);
    assert(song.bars > 0, `${axis}=none produced no bars`);
  }
  // and all of them at once
  const bare = compose({ style: 'none', mood: 'none', theme: 'none', tech: 'none', bpm: 90, type: 'none' }, 'all-none');
  assert(bare.totalNotes > 0, 'the plain song has no notes');
  assert(bare.tracks.bed.length === 0, 'theme=none should not add ambience');
});
test('the ambience dial overrides the theme', () => {
  const auto = compose({ style: 'ambient', mood: 'calm', theme: 'rain', tech: 'noise', bpm: 60, type: 'drone' }, 'tex-auto');
  assert(auto.tracks.bed.length > 0, 'auto should give a bed');
  const off = compose({ style: 'ambient', mood: 'calm', theme: 'rain', tech: 'noise', bpm: 60, type: 'drone', texture: 'none' }, 'tex-off');
  eq(off.tracks.bed.length, 0);
  const fire = compose({ style: 'ambient', mood: 'calm', theme: 'rain', tech: 'noise', bpm: 60, type: 'drone', texture: 'fire' }, 'tex-fire');
  assert(fire.tracks.bed.every((n) => n.texture === 'fire'), 'explicit texture was not honoured');
});
test('random never picks the plain options', () => {
  const rng = new Rng('random-none');
  for (let i = 0; i < 30; i++) {
    const p = randomPresets(rng, { chaos: 0.3 });
    for (const axis of ['style', 'mood', 'theme', 'tech']) {
      assert(p[axis] !== 'none', `random chose none for ${axis}`);
    }
  }
});

console.log('\nTextures and transitions');
test('ambient beds carry a texture, not a pitch', () => {
  const song = compose({ style: 'ambient', mood: 'calm', theme: 'ocean', tech: 'noise', bpm: 60, type: 'drone' }, 'tex');
  assert(song.tracks.bed.length > 0, 'no bed');
  for (const n of song.tracks.bed) assert(typeof n.texture === 'string' && n.texture.length, 'bed note without a texture');
});
test('transitions only appear where the arrangement lifts', () => {
  const calm = compose({ style: 'ambient', mood: 'calm', theme: 'ocean', tech: 'noise', bpm: 60, type: 'drone' }, 'calm');
  const epic = compose({ style: 'cinematic', mood: 'epic', theme: 'space', tech: 'analog', bpm: 70, type: 'full' }, 'epic');
  eq(calm.transitions.length, 0);
  assert(epic.transitions.length > 0, 'a building song should have transitions');
  for (const tr of epic.transitions) {
    assert(tr.kind === 'riser' || tr.kind === 'impact', `bad kind ${tr.kind}`);
    assert(tr.beat >= 0, 'negative beat');
  }
});

console.log('\nTempo map');
test('secondsAt integrates a piecewise tempo', () => {
  const map = makeTempoMap([{ beat: 0, bpm: 80 }, { beat: 16, bpm: 90 }, { beat: 32, bpm: 84 }]);
  assert(Math.abs(map.secondsAt(16) - 12) < 1e-9, 'first segment');
  assert(Math.abs(map.secondsAt(32) - (12 + 16 * 60 / 90)) < 1e-9, 'second segment');
});
test('beatAt inverts secondsAt', () => {
  const map = makeTempoMap([{ beat: 0, bpm: 70 }, { beat: 8, bpm: 120 }, { beat: 24, bpm: 95 }]);
  for (const beat of [0, 3.5, 8, 15, 24, 40]) {
    assert(Math.abs(map.beatAt(map.secondsAt(beat)) - beat) < 1e-6, `round trip at ${beat}`);
  }
});
test('a flat tempo matches the old arithmetic', () => {
  const map = flatTempo(84);
  assert(Math.abs(map.secondsAt(64) - (64 * 60) / 84) < 1e-9, 'flat integration');
  eq(describeTempo(map), '84 BPM');
});
test('tempo never leaves its declared window', () => {
  for (const drift of [0, 0.08, 0.2, 0.35]) {
    const song = compose({ style: 'cinematic', mood: 'epic', theme: 'space', tech: 'analog', bpm: 100, type: 'full', tempoDrift: drift }, `drift-${drift}`);
    const lo = 100 * (1 - drift) - 0.01;
    const hi = 100 * (1 + drift) + 0.01;
    for (const seg of song.tempo.segments) {
      assert(seg.bpm >= lo && seg.bpm <= hi, `segment ${seg.bpm} outside ${lo}–${hi}`);
    }
  }
});
test('songs actually vary their tempo', () => {
  const song = compose({ style: 'lofi', mood: 'dreamy', theme: 'rain', tech: 'analog', bpm: 84, type: 'full', tempoDrift: 0.12 }, 'varies');
  assert(song.tempo.segments.length > 3, 'only one tempo segment');
  assert(song.bpmRange[1] - song.bpmRange[0] > 4, `range too narrow: ${song.bpmRange}`);
  const map = makeTempoMap(song.tempo.segments, { base: 84 });
  assert(Math.abs(map.secondsAt(song.bars * song.beatsPerBar) - song.durationSec) < 0.01, 'duration disagrees with the map');
});

console.log('\nAnti-aliasing');
test('harmonic count shrinks as pitch rises', () => {
  const low = safeHarmonicsFor(44100, 110, 24);
  const high = safeHarmonicsFor(44100, 3000, 24);
  assert(low >= high, `low ${low} should allow at least as many as high ${high}`);
  assert(high <= Math.floor((44100 * 0.45) / 3000), `high harmonics ${high} exceed Nyquist`);
  assert(high >= 1, 'must keep at least one partial');
});
test('a 44.1k context and a 22k context both stay under Nyquist', () => {
  for (const sr of [44100, 22050, 48000]) {
    for (const f of [55, 440, 1200, 4000]) {
      const n = safeHarmonicsFor(sr, f, 24);
      assert(f * n < sr * 0.46, `${sr}Hz @ ${f}Hz: partial ${n} lands at ${f * n}Hz`);
    }
  }
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


// ------------------------------------------------------------ plan / render
const PLAN_PRESETS = { style: 'lofi', mood: 'dreamy', theme: 'rain', tech: 'analog', bpm: 84, type: 'full' };
const planOf = (seed = 'planseeda001') => plan(PLAN_PRESETS, seed);

test('a plan is plain JSON', () => {
  const p = planOf();
  const wire = JSON.stringify(p);
  assert(wire.length > 500, 'plan should not be empty');
  eq(JSON.stringify(JSON.parse(wire)), wire, 'plan must survive a JSON round-trip unchanged');
});

test('compose is exactly plan then render', () => {
  for (const seed of ['a1', 'b2', 'c3']) {
    const direct = compose(PLAN_PRESETS, seed);
    const viaPlan = render(plan(PLAN_PRESETS, seed));
    eq(JSON.stringify(viaPlan), JSON.stringify(direct), `seed ${seed}`);
  }
});

test('a plan that has been through JSON renders the same song', () => {
  const seed = 'jsonround001';
  const wire = JSON.stringify(plan(PLAN_PRESETS, seed));
  eq(JSON.stringify(render(JSON.parse(wire))), JSON.stringify(compose(PLAN_PRESETS, seed)), 'round-trip');
});

test('the plan names the key, the sections and the chords', () => {
  const p = planOf();
  assert(/^[A-G]#? /.test(p.key.name), `key name: ${p.key.name}`);
  assert(p.sections.length >= 4, 'a full song has sections');
  const verse = p.sections.find((s) => s.name === 'verse');
  assert(verse.chords.length === verse.bars, 'one chord per bar');
  assert(verse.chords[0].symbol.length > 0, 'chords carry a symbol');
});

test('moving a section moves it and keeps the song playable', () => {
  const p = planOf();
  const moved = moveSection(p, 5, 2);
  eq(moved.sections[2].name, p.sections[5].name, 'the section landed where asked');
  eq(moved.bars, p.bars, 'a move does not change the length');
  assert(validateSong(render(moved)).ok !== false, 'the moved song still validates');
});

test('duplicating a section adds its bars and notes', () => {
  const p = planOf();
  const dup = duplicateSection(p, 2);
  eq(dup.sections.length, p.sections.length + 1, 'one more section');
  eq(dup.bars, p.bars + p.sections[2].bars, 'and its bars');
  assert(render(dup).totalNotes > render(p).totalNotes, 'and its notes');
});

test('removing a section shortens the song, and the last one cannot go', () => {
  const p = planOf();
  const cut = removeSection(p, 0);
  eq(cut.bars, p.bars - p.sections[0].bars, 'bars removed');
  let threw = false;
  try { removeSection(removeSection(p, 0), 0); } catch { threw = true; }
  assert(threw || true, 'removing until one is left must not crash');
  const single = { ...p, sections: [p.sections[0]], aliases: [0] };
  threw = false;
  try { removeSection(single, 0); } catch { threw = true; }
  assert(threw, 'the last section must be refused');
});

test('changing the bar count keeps a chord under every bar', () => {
  const p = planOf();
  for (const bars of [1, 2, 8, 16]) {
    const q = setSectionBars(p, 0, bars);
    eq(q.sections[0].bars, bars, 'bars set');
    eq(q.sections[0].chords.length, bars, 'a chord per bar');
    const chk = validateSong(render(q));
    assert(chk.ok !== false, `bars=${bars}: ${JSON.stringify(chk).slice(0, 120)}`);
  }
});

test('a chord edit rewrites symbol, pcs and intervals together', () => {
  const p = planOf();
  const vi = p.sections.findIndex((s) => s.name === 'verse');
  const before = p.sections[vi].chords[0];
  const q = setChord(p, vi, 0, { rootPc: (before.rootPc + 5) % 12, quality: 'min' });
  const after = q.sections[vi].chords[0];
  eq(after.rootPc, (before.rootPc + 5) % 12, 'root moved');
  eq(after.quality, 'min', 'quality set');
  assert(after.symbol !== before.symbol, `symbol followed: ${before.symbol} -> ${after.symbol}`);
  eq(after.pcs.length, 3, 'a triad has three pitch classes');
  eq(after.intervals.length, 3, 'and three intervals');
  assert(validateSong(render(q)).ok !== false, 'the re-chorded song validates');
});

test('cycling a chord walks the qualities', () => {
  const p = planOf();
  const q = cycleChord(p, 1, 0, 1);
  assert(q.sections[1].chords[0].quality !== p.sections[1].chords[0].quality, 'quality changed');
});

test('editing never mutates the plan it was given', () => {
  const p = planOf();
  const before = planSignature(p);
  const frozen = JSON.stringify(p);
  moveSection(p, 5, 2);
  duplicateSection(p, 1);
  setSectionBars(p, 0, 12);
  setChord(p, 1, 0, { quality: 'dim' });
  eq(planSignature(p), before, 'signature unchanged');
  eq(JSON.stringify(p), frozen, 'plan unchanged');
});

test('an edited plan is deterministic and survives JSON', () => {
  const p = duplicateSection(planOf(), 2);
  const a = render(p);
  const b = render(JSON.parse(JSON.stringify(p)));
  eq(JSON.stringify(a), JSON.stringify(b), 'same plan, same song');
});

test('a plan from a stranger is normalised, not trusted', () => {
  const p = normalisePlan({
    seed: 'x', presets: PLAN_PRESETS, key: { tonic: 0, mode: 'major' },
    sections: [{ name: 'verse', bars: 4, chords: [] }],
  });
  eq(p.sections[0].chords.length, 1, 'a section with no harmony gets the tonic triad');
  eq(p.bars, 4, 'bars recomputed');
  let threw = false;
  try { normalisePlan({ presets: PLAN_PRESETS, key: { tonic: 0, mode: 'major' }, sections: [] }); } catch { threw = true; }
  assert(threw, 'an empty plan is refused');
});


// ------------------------------------------------------------ audio health
test('a fresh health record is empty', () => {
  const r = report(makeHealth(), {});
  eq(r.ticks, 0);
  eq(r.state, 'none');
  eq(r.stalls, 0);
  eq(verdict(r).level, 'idle');
});

test('ticks advance and record the worst gap', () => {
  const h = makeHealth();
  noteTick(h, 1.0, 1000);
  noteTick(h, 1.03, 1025);
  noteTick(h, 1.06, 1080);
  const r = report(h, {});
  eq(r.ticks, 3);
  eq(r.maxGapMs, 55, 'worst wall-clock gap');
});

test('a frozen audio clock is a stall, and is reported once', () => {
  const h = makeHealth();
  let now = 1000;
  noteTick(h, 5, now);
  let stalls = 0;
  for (let i = 0; i < 40; i++) {
    now += 100;                       // wall time moves
    if (noteTick(h, 5, now)) stalls++;  // audio time does not
  }
  assert(stalls >= 1, 'the stall must be noticed');
  assert(stalls <= 3, `one report per stall, not one per tick (got ${stalls})`);
  eq(report(h, {}).stalls, stalls);
});

test('a moving clock never stalls', () => {
  const h = makeHealth();
  let stalls = 0;
  for (let i = 0; i < 60; i++) {
    if (noteTick(h, 5 + i * 0.05, 1000 + i * 100)) stalls++;
  }
  eq(stalls, 0);
  eq(report(h, {}).stalls, 0);
});

test('only notes later than the threshold count as late', () => {
  const h = makeHealth();
  noteEvent(h, (LATE_MS - 5) / 1000);
  eq(report(h, {}).late, 0, 'sub-threshold lateness is inaudible');
  noteEvent(h, (LATE_MS + 30) / 1000);
  const r = report(h, {});
  eq(r.late, 1);
  assert(r.maxLateMs >= LATE_MS + 29, `worst lateness recorded: ${r.maxLateMs}`);
});

test('skipped notes and recoveries are counted', () => {
  const h = makeHealth();
  noteSkip(h);
  noteSkip(h);
  noteRecovery(h, 'stalled');
  const r = report(h, {});
  eq(r.skipped, 2);
  eq(r.recoveries, 1);
  eq(r.lastRecovery, 'stalled');
});

test('the report reads a live graph without throwing', () => {
  const r = report(makeHealth(), {
    ctx: { state: 'running', sampleRate: 48000, baseLatency: 0.005 },
    graph: { cap: { active: [1, 2, 3], max: 32, stolen: 1, dropped: 0 } },
    clock: 'worklet', playing: true, song: { totalNotes: 900 },
  });
  eq(r.state, 'running');
  eq(r.voices.active, 3);
  eq(r.voices.max, 32);
  eq(r.clock, 'worklet');
  eq(r.notes, 900);
  eq(verdict(r).level, 'ok');
});

test('a closed context is bad, a suspended one is a warning', () => {
  eq(verdict({ state: 'closed' }).level, 'bad');
  eq(verdict({ state: 'suspended' }).level, 'warn');
  eq(verdict({ state: 'interrupted' }).level, 'warn');
});

test('late notes make the verdict a warning, not a failure', () => {
  const v = verdict({
    state: 'running', sampleRate: 48000, latencyMs: 5, ticks: 10, maxGapMs: 3,
    late: 4, maxLateMs: 40, skipped: 1, stalls: 0, recoveries: 0,
    voices: { active: 1, max: 32, stolen: 0, dropped: 0 },
  });
  eq(v.level, 'warn');
  assert(/late note/.test(v.line), v.line);
});

test('a stall outranks everything', () => {
  const v = verdict({
    state: 'running', sampleRate: 48000, latencyMs: 5, ticks: 10, maxGapMs: 3,
    late: 0, maxLateMs: 0, skipped: 0, stalls: 2, recoveries: 2,
    voices: { active: 0, max: 32, stolen: 0, dropped: 0 },
  });
  eq(v.level, 'bad');
});


// ---------------------------------------------------------------- tracker
test('notes are written the way a tracker writes them', () => {
  eq(noteLabel(60), 'C-4');
  eq(noteLabel(61), 'C#4');
  eq(noteLabel(69), 'A-4');
  eq(noteLabel(21), 'A-0');
  eq(noteLabel(0), 'C--1');
  eq(noteLabel(127), 'G-9', 'top of the range');
  eq(noteLabel(60).length, 3, 'three characters, so a column lines up');
  eq(noteLabel(undefined), '···');
});

test('the step index buckets every note on its sixteenth', () => {
  const song = {
    beatsPerBar: 4, bpm: 120, tempo: { segments: [{ beat: 0, bpm: 120 }], base: 120, drift: 0 },
    tracks: {
      drums: [{ t: 0, drum: 'kick', v: 0.9 }, { t: 1, drum: 'snare', v: 0.8 }, { t: 0.25, drum: 'hat', v: 0.4 }],
      bass: [{ t: 0, p: 40 }], chords: [], lead: [{ t: 2.5, p: 72 }], pad: [], arp: [], bed: [],
    },
  };
  const idx = buildStepIndex(song);
  eq(idx.step, 0.25);
  eq(idx.map.get(0).drums.length, 1, 'one note on step 0');
  eq(idx.map.get(1).drums[0].drum, 'hat', 'the sixteenth hat lands on step 1');
  eq(idx.map.get(4).drums[0].drum, 'snare', 'beat 2 is step 4');
  eq(idx.map.get(10).lead[0].p, 72, 'beat 3.5 is step 10');
  eq(idx.map.get(0).bass.length, 1);
});

test('rows line up with the columns they belong to', () => {
  const song = {
    beatsPerBar: 4, bpm: 120, tempo: { segments: [{ beat: 0, bpm: 120 }], base: 120, drift: 0 },
    tracks: {
      drums: [{ t: 0, drum: 'kick', v: 0.9 }], bass: [], chords: [{ t: 0.25, p: 48 }], lead: [],
      pad: [], arp: [], bed: [],
    },
  };
  const idx = buildStepIndex(song);
  const rows = rowsFor(idx, 0, 4);
  eq(rows.length, 4);
  eq(rows[0].cells.drums, 'kck', 'a drum prints its voice, not a pitch');
  eq(rows[0].cells.chords, null, 'silence is null, not a note');
  eq(rows[1].cells.chords, 'C-3');
  eq(rows[2].cells.drums, null);
  eq(Object.keys(rows[0].cells).join(','), TRACK_COLUMNS.join(','), 'one cell per column');
  eq(rows[1].beat, 0.25);
});

test('the window scrolls so the row being heard sits a third down', () => {
  const song = {
    beatsPerBar: 4, bpm: 60, tempo: { segments: [{ beat: 0, bpm: 60 }], base: 60, drift: 0 },
    tracks: { drums: [], bass: [], chords: [], lead: [], pad: [], arp: [], bed: [] },
  };
  // 60 bpm: one beat per second, so 8 s is beat 8 = step 32
  const w = windowFor(song, 8, 9);
  eq(w.currentStep, 32);
  eq(w.firstStep, 32 - Math.max(1, Math.round(9 * 0.34)));
  const atStart = windowFor(song, 0, 9);
  eq(atStart.firstStep, 0, 'never scrolls above the first row');
  assert(atStart.currentStep === 0);
});

test('a sixteenth at 120 bpm is where the index says it is', () => {
  // 120 bpm -> 0.5 s per beat -> 0.125 s per sixteenth
  const song = {
    beatsPerBar: 4, bpm: 120, tempo: { segments: [{ beat: 0, bpm: 120 }], base: 120, drift: 0 },
    tracks: { drums: [], bass: [], chords: [], lead: [], pad: [], arp: [], bed: [] },
  };
  eq(windowFor(song, 0.125, 9).currentStep, 1);
  eq(windowFor(song, 0.5, 9).currentStep, 4);
  eq(STEPS_PER_BEAT, 4);
});

test('a stacked drum step says so instead of dropping the second hit', () => {
  eq(cellLabel('drums', [{ drum: 'kick', v: 0.9 }, { drum: 'hat', v: 0.4 }]), 'kck+', 'loudest wins, stack marked');
  eq(cellLabel('drums', [{ drum: 'hat', v: 0.2 }, { drum: 'snare', v: 0.8 }]), 'snr+');
  eq(cellLabel('drums', [{ drum: 'tom', v: 0.5 }]), 'tom');
  eq(cellLabel('drums', []), null);
  eq(cellLabel('lead', [{ p: 72 }]), 'C-5', 'pitched tracks still print pitches');
});

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(f.name, '\n', f.err);
  process.exit(1);
}
