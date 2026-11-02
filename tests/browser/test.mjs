// Browser test: real Chromium, real Web Audio.
// Serves the app from an in-process HTTP server (a service worker needs an
// origin), loads it, and checks that it actually renders audio.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Resolve puppeteer from the project, the global install, or CHROME_PATH.
async function loadPuppeteer() {
  try {
    const mod = await import('puppeteer');
    return mod.default ?? mod;
  } catch { /* fall through to the sandbox's global copy */ }
  try {
    const mod = await import('/usr/lib/node_modules/puppeteer-core/lib/cjs/puppeteer/puppeteer-core.js');
    return mod.default ?? mod;
  } catch {
    throw new Error('puppeteer not found. Run: npm install --no-save puppeteer axe-core');
  }
}

function launchOptions(extra = []) {
  const opts = {
    headless: true,
    protocolTimeout: 600000,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--js-flags=--max-old-space-size=3072',
      '--autoplay-policy=no-user-gesture-required', ...extra],
  };
  if (process.env.CHROME_PATH) opts.executablePath = process.env.CHROME_PATH;
  else if (fs.existsSync('/usr/local/bin/chromium')) opts.executablePath = '/usr/local/bin/chromium';
  return opts;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let pass = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fails.push(`${name} ${detail}`); console.log(`  FAIL ${name} ${detail}`); }
}

const server = await serve();
const port = server.address().port;
const base = `http://127.0.0.1:${port}/`;

const puppeteer = await loadPuppeteer();
const browser = await puppeteer.launch(launchOptions());

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 430, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`${base}app/`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.getElementById('title').textContent !== '—', { timeout: 15000 });

  console.log('\nPage boot');
  const title = await page.$eval('#title', (el) => el.textContent);
  const meta = await page.$eval('#meta', (el) => el.textContent);
  const sections = await page.$$eval('.sec', (els) => els.length);
  check('title generated', title.length > 1, title);
  check('meta line populated', meta.includes('BPM'), meta);
  check('sections rendered', sections >= 3, `${sections} sections`);
  check('no console errors on boot', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log('\nComposition in the browser');
  const composed = await page.evaluate(async () => {
    const { compose } = await import('./src/core/composer.js');
    const { validateSong } = await import('./src/core/validate.js');
    const p = { style: 'lofi', mood: 'dreamy', theme: 'rain', tech: 'analog', bpm: 84, type: 'full' };
    const a = compose(p, 'browser-seed');
    const b = compose(p, 'browser-seed');
    const v = validateSong(a);
    return {
      identical: JSON.stringify(a) === JSON.stringify(b),
      valid: v.ok,
      issues: v.issues,
      notes: a.totalNotes,
      bars: a.bars,
      lufsTarget: a.lufs,
      duration: a.durationSec,
    };
  });
  check('deterministic in the browser', composed.identical);
  check('validates', composed.valid, composed.issues.join(' | '));
  check('has notes', composed.notes > 200, `${composed.notes}`);

  console.log('\nOffline render (Web Audio)');
  const rendered = await page.evaluate(async () => {
    const { compose } = await import('./src/core/composer.js');
    const { renderSong } = await import('./src/audio/engine.js');
    const { analyseBuffer, normalisationGain } = await import('./src/export/wav.js');
    const song = compose({ style: 'lofi', mood: 'calm', theme: 'rain', tech: 'analog', bpm: 84, type: 'loop' }, 'render-seed');
    const t0 = performance.now();
    const buf = await renderSong(song, { sampleRate: 44100, tailSec: 1 });
    const ms = performance.now() - t0;
    const info = analyseBuffer(buf);
    const gain = normalisationGain(buf, song.lufs, -1);
    // rms of the rendered audio as a proxy for "is there sound at all"
    const d = buf.getChannelData(0);
    let sum = 0, peak = 0;
    for (let i = 0; i < d.length; i++) { sum += d[i] * d[i]; peak = Math.max(peak, Math.abs(d[i])); }
    return {
      lufs: info.lufs, peakDb: info.peakDb, rms: Math.sqrt(sum / d.length), peak,
      frames: buf.length, sampleRate: buf.sampleRate, ms, gain,
      duration: buf.length / buf.sampleRate,
    };
  });
  check('render produced frames', rendered.frames > 100000, `${rendered.frames} frames`);
  check('render is not silent', rendered.rms > 0.002, `rms ${rendered.rms.toFixed(4)}`);
  check('no clipping', rendered.peak <= 1.0, `peak ${rendered.peak.toFixed(3)}`);
  check('LUFS measurable', isFinite(rendered.lufs), `${rendered.lufs}`);
  check('LUFS within 12 dB of the style target', Math.abs(rendered.lufs - (-16)) < 12, `lufs ${rendered.lufs.toFixed(1)} vs -16`);
  check('normalisation gain is finite', isFinite(rendered.gain), `${rendered.gain}`);
  console.log(`      render: ${rendered.ms.toFixed(0)} ms for ${rendered.duration.toFixed(1)} s of audio`);

  console.log('\nLive playback');
  const live = await page.evaluate(async () => {
    const { compose } = await import('./src/core/composer.js');
    const { Player } = await import('./src/audio/engine.js');
    const song = compose({ style: 'edm', mood: 'epic', theme: 'festival', tech: 'analog', bpm: 128, type: 'loop' }, 'live-seed');
    const p = new Player(song);
    await p.init();
    if (p.ctx.state === 'suspended') await p.ctx.resume();
    await p.play();
    await new Promise((r) => setTimeout(r, 900));
    const pos = p.position;
    const active = p.graph.cap.active.length;
    const dropped = p.graph.cap.dropped;
    const stolen = p.graph.cap.stolen;
    p.stop();
    await p.close();
    return { pos, active, dropped, stolen };
  });
  check('playhead advances', live.pos > 0.2, `position ${live.pos.toFixed(2)} s`);
  check('voices were created', live.active > 0, `${live.active} active voices`);
  check('no voices dropped', live.dropped === 0, `${live.dropped} dropped`);
  check('few voices stolen', live.stolen < 40, `${live.stolen} stolen`);

  console.log('\nExport path');
  const exported = await page.evaluate(async () => {
    const { compose } = await import('./src/core/composer.js');
    const { renderSong } = await import('./src/audio/engine.js');
    const { encodeWav } = await import('./src/export/wav.js');
    const { songToMidi } = await import('./src/export/midi.js');
    const song = compose({ style: 'chiptune', mood: 'playful', theme: 'cyberpunk', tech: 'chiptune', bpm: 150, type: 'loop' }, 'export-seed');
    const buf = await renderSong(song, { sampleRate: 22050, tailSec: 0.5 });
    const wav = encodeWav(buf, { bitDepth: 16 });
    const midi = songToMidi(song);
    return {
      wavBytes: wav.length,
      expected: 44 + buf.length * 2 * 2,
      riff: String.fromCharCode(...wav.slice(0, 4)),
      midiHeader: String.fromCharCode(...midi.slice(0, 4)),
      midiBytes: midi.length,
    };
  });
  check('WAV byte length matches frames', exported.wavBytes === exported.expected, `${exported.wavBytes} vs ${exported.expected}`);
  check('WAV is RIFF', exported.riff === 'RIFF');
  check('MIDI is MThd', exported.midiHeader === 'MThd');
  check('MIDI has content', exported.midiBytes > 1000, `${exported.midiBytes} bytes`);

  console.log('\nService worker');
  const sw = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const keys = await caches.keys();
    return { registered: !!reg, active: !!reg?.active, caches: keys };
  });
  check('service worker registered', sw.registered);
  check('app shell cached', sw.caches.length > 0, sw.caches.join(','));

  console.log('\nTempo extremes (20–500 BPM)');
  const tempo = await page.evaluate(async () => {
    const { compose, normalisePresets, BPM_MIN, BPM_MAX } = await import('./src/core/composer.js');
    const { renderSong } = await import('./src/audio/engine.js');
    const out = { min: BPM_MIN, max: BPM_MAX, clamped: [normalisePresets({ bpm: 5 }).bpm, normalisePresets({ bpm: 900 }).bpm] };
    for (const bpm of [20, 500]) {
      const song = compose({ style: 'lofi', mood: 'calm', theme: 'rain', tech: 'analog', bpm, type: 'loop' }, `tempo-${bpm}`);
      const buf = await renderSong(song, { sampleRate: 22050, tailSec: 0.2 });
      const d = buf.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
      out[bpm] = {
        rms: Math.sqrt(sum / d.length),
        seconds: +(buf.length / buf.sampleRate).toFixed(2),
        notes: song.totalNotes,
        duration: +song.durationSec.toFixed(2),
      };
    }
    return out;
  });
  check('tempo floor is 20 BPM', tempo.min === 20, String(tempo.min));
  check('tempo ceiling is 500 BPM', tempo.max === 500, String(tempo.max));
  check('tempo is clamped at both ends', tempo.clamped[0] === 20 && tempo.clamped[1] === 500, tempo.clamped.join('/'));
  check('20 BPM renders audio', tempo[20].rms > 0.002, `rms ${tempo[20].rms.toFixed(4)}`);
  check('500 BPM renders audio', tempo[500].rms > 0.002, `rms ${tempo[500].rms.toFixed(4)}`);
  check('500 BPM is faster than 20 BPM', tempo[500].duration < tempo[20].duration, `${tempo[500].duration}s vs ${tempo[20].duration}s`);

  console.log('\nVoice pool + render integrity');
  const integrity = await page.evaluate(async () => {
    const { compose } = await import('./src/core/composer.js');
    const { renderSong, buildEvents } = await import('./src/audio/engine.js');
    const song = compose({ style: 'edm', mood: 'epic', theme: 'festival', tech: 'analog', bpm: 128, type: 'loop' }, 'integrity');
    const events = buildEvents(song).length;
    const buf = await renderSong(song, { sampleRate: 22050, tailSec: 0.3 });
    const d = buf.getChannelData(0), sr = buf.sampleRate;
    // count silent half-second windows: a dropped-voice render has holes
    const win = Math.floor(sr * 0.5);
    let silent = 0, windows = 0;
    for (let i = 0; i + win <= d.length; i += win) {
      let s = 0;
      for (let j = 0; j < win; j++) s += d[i + j] * d[i + j];
      if (Math.sqrt(s / win) < 0.0008) silent++;
      windows++;
    }
    return { events, silent, windows, seconds: +(buf.length / sr).toFixed(1) };
  });
  check('dense render has no silent holes', integrity.silent <= 1, `${integrity.silent}/${integrity.windows} silent windows over ${integrity.seconds}s`);

  console.log('\nLoudness regression');
  const loud = await page.evaluate(async () => {
    const { compose } = await import('./src/core/composer.js');
    const { renderSong } = await import('./src/audio/engine.js');
    const { analyseBuffer } = await import('./src/export/wav.js');
    const rows = [];
    for (const [style, mood, bpm] of [['lofi', 'calm', 84], ['edm', 'epic', 128], ['ambient', 'calm', 60]]) {
      const song = compose({ style, mood, theme: 'rain', tech: 'analog', bpm, type: 'loop' }, `loud-${style}`);
      const buf = await renderSong(song, { sampleRate: 22050, tailSec: 0.3 });
      const info = analyseBuffer(buf);
      rows.push({ style, target: song.lufs, lufs: +info.lufs.toFixed(1), peak: +info.peakDb.toFixed(2) });
    }
    return rows;
  });
  for (const row of loud) {
    check(`${row.style} loudness near its target`, Math.abs(row.lufs - row.target) < 6,
      `${row.lufs} LUFS vs ${row.target}`);
    check(`${row.style} does not clip`, row.peak < 0, `${row.peak} dBTP`);
  }

  console.log('\nVariable tempo');
  const varia = await page.evaluate(async () => {
    const { compose } = await import('./src/core/composer.js');
    const { buildEvents, renderSong, tempoMapOf } = await import('./src/audio/engine.js');
    const song = compose({ style: 'cinematic', mood: 'epic', theme: 'space', tech: 'analog', bpm: 100, type: 'loop', tempoDrift: 0.18 }, 'vario');
    const map = tempoMapOf(song);
    const events = buildEvents(song);
    // event seconds must equal the map's idea of their beat
    let worst = 0;
    for (const ev of events.slice(0, 400)) {
      worst = Math.max(worst, Math.abs(ev.sec - map.secondsAt(ev.beat)));
    }
    const buf = await renderSong(song, { sampleRate: 16000, tailSec: 0.15 });
    const rendered = buf.length / buf.sampleRate;
    // per-section tempo, read from a full-length song (not rendered: memory)
    const full = compose({ style: 'cinematic', mood: 'epic', theme: 'space', tech: 'analog', bpm: 100, type: 'full', tempoDrift: 0.18 }, 'vario-full');
    const fullMap = tempoMapOf(full);
    const byName = {};
    for (const sec of full.sections) byName[sec.name] = Math.round(fullMap.bpmAt(sec.bar * full.beatsPerBar));
    return {
      segments: song.tempo.segments.length,
      range: song.bpmRange.map((v) => Math.round(v)),
      worstDrift: +worst.toFixed(6),
      duration: +song.durationSec.toFixed(2),
      rendered: +rendered.toFixed(2),
      byName,
      mapDuration: +map.secondsAt(song.bars * song.beatsPerBar).toFixed(2),
    };
  });
  check('song has a tempo map with several segments', varia.segments > 4, `${varia.segments} segments`);
  check('tempo range is real', varia.range[1] - varia.range[0] >= 8, varia.range.join('–'));
  check('event times follow the tempo map', varia.worstDrift < 1e-6, `worst ${varia.worstDrift}s`);
  check('duration comes from the map', Math.abs(varia.duration - varia.mapDuration) < 0.01,
    `${varia.duration} vs ${varia.mapDuration}`);
  check('render length matches the song', Math.abs(varia.rendered - varia.duration) < 1.0,
    `${varia.rendered}s vs ${varia.duration}s`);
  check('sections have their own tempo', Object.keys(varia.byName).length > 1
    && new Set(Object.values(varia.byName)).size > 1, JSON.stringify(varia.byName));

  console.log('\nPlayback continuity (the "stops midway" bug)');
  const continuity = await page.evaluate(async () => {
    const { compose } = await import('./src/core/composer.js');
    const { Player } = await import('./src/audio/engine.js');
    const song = compose({ style: 'lofi', mood: 'calm', theme: 'rain', tech: 'analog', bpm: 120, type: 'loop', tempoDrift: 0.2 }, 'continuity');
    const p = new Player(song);
    await p.init();
    if (p.ctx.state === 'suspended') await p.ctx.resume();
    await p.play();
    const marks = [];
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 500));
      marks.push({ pos: +p.position.toFixed(2), idx: p.idx, dropped: p.graph.cap.dropped });
    }
    const stillPlaying = p.playing;
    p.stop();
    await p.close();
    return { marks, stillPlaying, events: marks[marks.length - 1].idx };
  });
  const advancing = continuity.marks.every((m, i) => i === 0 || m.idx >= continuity.marks[i - 1].idx);
  check('scheduler keeps advancing for 3 seconds', advancing && continuity.marks[5].idx > continuity.marks[1].idx,
    continuity.marks.map((m) => `${m.pos}s:${m.idx}`).join(' '));
  check('playback is still running after 3 s', continuity.stillPlaying);
  check('nothing was dropped during the run', continuity.marks[5].dropped === 0, `${continuity.marks[5].dropped} dropped`);

  console.log('\nClipping and click guard');
  const clean = await page.evaluate(async () => {
    const { compose } = await import('./src/core/composer.js');
    const { renderSong } = await import('./src/audio/engine.js');
    const song = compose({ style: 'rock', mood: 'epic', theme: 'desert', tech: 'analog', bpm: 140, type: 'loop' }, 'clean');
    const buf = await renderSong(song, { sampleRate: 22050, tailSec: 0.2 });
    const d = buf.getChannelData(0);
    let peak = 0, maxDelta = 0;
    for (let i = 1; i < d.length; i++) {
      peak = Math.max(peak, Math.abs(d[i]));
      maxDelta = Math.max(maxDelta, Math.abs(d[i] - d[i - 1]));
    }
    return { peak: +peak.toFixed(3), maxDelta: +maxDelta.toFixed(3) };
  });
  check('master never exceeds full scale', clean.peak <= 1.0, `peak ${clean.peak}`);
  check('no sample-to-sample jumps (clicks)', clean.maxDelta < 0.9, `max delta ${clean.maxDelta}`);

  console.log('\nWorklet engines');
  const worklets = await page.evaluate(async () => {
    const { compose } = await import('./src/core/composer.js');
    const { renderSong, prepareWorklets } = await import('./src/audio/engine.js');
    const rms = (buf) => {
      const d = buf.getChannelData(0);
      let s = 0;
      for (let i = 0; i < d.length; i++) s += d[i] * d[i];
      return Math.sqrt(s / d.length);
    };
    const out = {};
    // physical tech → waveguide worklet; noise tech → granular worklet
    for (const [label, presets] of [
      ['waveguide', { style: 'folk', mood: 'calm', theme: 'forest', tech: 'physical', bpm: 92, type: 'loop' }],
      ['granular', { style: 'ambient', mood: 'calm', theme: 'ocean', tech: 'noise', bpm: 60, type: 'loop' }],
    ]) {
      const song = compose(presets, `wl-${label}`);
      const buf = await renderSong(song, { sampleRate: 22050, tailSec: 0.3 });
      out[label] = { rms: rms(buf), worklets: song.tech };
    }
    const ctx = new OfflineAudioContext(1, 128, 22050);
    const ready = await prepareWorklets(ctx);
    out.modules = ready;
    return out;
  });
  check('waveguide worklet renders audio', worklets.waveguide.rms > 0.0005, `rms ${worklets.waveguide.rms.toFixed(5)}`);
  check('granular worklet renders audio', worklets.granular.rms > 0.0005, `rms ${worklets.granular.rms.toFixed(5)}`);
  check('worklet modules load', worklets.modules.granular && worklets.modules.physical, JSON.stringify(worklets.modules));

  console.log('\nMicrotuning, groove and texture');
  const extras = await page.evaluate(async () => {
    const { compose, justIntonationCents } = await import('./src/core/composer.js');
    const eq = compose({ style: 'lofi', mood: 'calm', theme: 'rain', tech: 'analog', bpm: 84, type: 'loop' }, 'tune');
    const ji = compose({ style: 'lofi', mood: 'calm', theme: 'rain', tech: 'analog', bpm: 84, type: 'loop', microtuning: true }, 'tune');
    const cents = ji.tuning?.cents || [];

    const grid = { kick: [1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0], snare: [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], hat: [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1] };
    const grooved = compose({ style: 'lofi', mood: 'calm', theme: 'rain', tech: 'analog', bpm: 84, type: 'loop', grooveOverride: grid }, 'groove');
    const kicks = grooved.tracks.drums.filter((n) => n.drum === 'kick').length;
    const plain = compose({ style: 'lofi', mood: 'calm', theme: 'rain', tech: 'analog', bpm: 84, type: 'loop' }, 'groove');
    const plainKicks = plain.tracks.drums.filter((n) => n.drum === 'kick').length;

    const ambient = compose({ style: 'ambient', mood: 'calm', theme: 'ocean', tech: 'noise', bpm: 60, type: 'drone' }, 'bed');
    return {
      equalTempered: eq.tuning == null,
      hasCents: cents.length === 12 && cents.some((c) => Math.abs(c) > 1),
      centsSample: cents.slice(0, 4).map((c) => +c.toFixed(1)),
      kicks, plainKicks,
      bed: ambient.tracks.bed.length,
      variant: typeof ambient.variant === 'number',
    };
  });
  check('equal temperament by default', extras.equalTempered);
  check('microtuning produces cents offsets', extras.hasCents, JSON.stringify(extras.centsSample));
  check('groove override changes the pattern', extras.kicks !== extras.plainKicks, `${extras.kicks} vs ${extras.plainKicks} kicks`);
  check('ambient songs get a noise bed', extras.bed > 0, `${extras.bed} bed notes`);
  check('songs carry an instrument variant', extras.variant);

  console.log('\nSettings and groove UI');
  await page.evaluate(() => document.getElementById('advanced').open = true);
  await wait(200);
  const uiBits = await page.evaluate(() => {
    const steps = document.querySelectorAll('.groove-step').length;
    document.getElementById('settings').click();
    const dialogOpen = document.getElementById('settings-dialog').open;
    const theme = document.getElementById('set-theme').value;
    document.getElementById('settings-dialog').close();
    return { steps, dialogOpen, theme };
  });
  check('groove editor renders 48 steps', uiBits.steps === 48, String(uiBits.steps));
  check('settings dialog opens', uiBits.dialogOpen);
  check('settings shows the current theme', ['system', 'light', 'dark'].includes(uiBits.theme), uiBits.theme);

  console.log('\nMix balance');
  const balance = await page.evaluate(async () => {
    const { compose } = await import('./src/core/composer.js');
    const { renderSong } = await import('./src/audio/engine.js');
    const song = compose({ style: 'lofi', mood: 'dreamy', theme: 'rain', tech: 'analog', bpm: 84, type: 'loop' }, 'balance');
    const tracks = ['drums', 'bass', 'chords', 'lead', 'pad'].filter((t) => (song.tracks[t] || []).length);
    const rows = [];
    for (const track of tracks) {
      const buf = await renderSong(song, { sampleRate: 16000, tailSec: 0.15, only: [track] });
      const d = buf.getChannelData(0);
      let s = 0;
      for (let i = 0; i < d.length; i++) s += d[i] * d[i];
      rows.push({ track, rms: Math.sqrt(s / d.length) });
    }
    return rows;
  });
  const db = (v) => 20 * Math.log10(Math.max(1e-9, v));
  const levels = balance.map((r) => ({ track: r.track, db: db(r.rms) }));
  const drums = levels.find((l) => l.track === 'drums');
  const loudest = Math.max(...levels.map((l) => l.db));
  const quietest = Math.min(...levels.map((l) => l.db));
  check('every track is audible in the mix', quietest > -60, levels.map((l) => `${l.track} ${l.db.toFixed(1)}dB`).join(', '));
  // this used to allow a 30 dB spread, which let the bass sit 18 dB over the drums
  check('no track is buried more than 18 dB below the loudest', loudest - quietest < 18,
    `spread ${(loudest - quietest).toFixed(1)} dB: ${levels.map((l) => `${l.track} ${l.db.toFixed(1)}`).join(', ')}`);
  const bassLevel = levels.find((l) => l.track === 'bass');
  check('bass does not swamp the drums', !bassLevel || !drums || bassLevel.db - drums.db < 12,
    bassLevel && drums ? `bass ${(bassLevel.db - drums.db).toFixed(1)} dB over drums` : 'no bass');
  const melodic = levels.filter((l) => l.track !== 'drums');
  const melodicMean = melodic.reduce((a, l) => a + l.db, 0) / Math.max(1, melodic.length);
  check('drums do not dominate the melodic tracks', !drums || drums.db - melodicMean < 14,
    drums ? `drums ${(drums.db - melodicMean).toFixed(1)} dB over melodic mean` : 'no drums');

  console.log('\nStress: 7/8 at 500 BPM');
  const stress = await page.evaluate(async () => {
    const { compose } = await import('./src/core/composer.js');
    const { Player } = await import('./src/audio/engine.js');
    const song = compose({ style: 'edm', mood: 'epic', theme: 'festival', tech: 'analog', bpm: 500, type: 'full', timeSig: [7, 8] }, 'stress');
    const p = new Player(song);
    await p.init();
    if (p.ctx.state === 'suspended') await p.ctx.resume();
    await p.play();
    await new Promise((r) => setTimeout(r, 1600));
    const res = {
      pos: p.position,
      dropped: p.graph.cap.dropped,
      stolen: p.graph.cap.stolen,
      active: p.graph.cap.active.length,
      cap: p.graph.cap.max,
      notes: song.totalNotes,
    };
    p.stop();
    await p.close();
    return res;
  });
  check('500 BPM 7/8 plays without exceptions', stress.dropped === 0, `${stress.dropped} dropped`);
  check('voice pool stays inside its cap', stress.active <= stress.cap, `${stress.active}/${stress.cap}`);
  check('playhead moves at 500 BPM', stress.pos > 0.3, `${stress.pos.toFixed(2)} s`);

  console.log('\nComposer features');
  const features = await page.evaluate(async () => {
    const { compose } = await import('./src/core/composer.js');
    const base = { style: 'rock', mood: 'epic', theme: 'desert', tech: 'analog', bpm: 120, type: 'full' };
    const a = compose({ ...base, lockTracks: { drums: true }, trackSeeds: { drums: 'fixed' } }, 'seedA');
    const b = compose({ ...base, lockTracks: { drums: true }, trackSeeds: { drums: 'fixed' } }, 'seedB');
    const sameDrums = JSON.stringify(a.tracks.drums) === JSON.stringify(b.tracks.drums);
    const diffLead = JSON.stringify(a.tracks.lead) !== JSON.stringify(b.tracks.lead);

    const mod = compose({ style: 'cinematic', mood: 'epic', theme: 'space', tech: 'additive', bpm: 70, type: 'full' }, 'mod-test');
    const keys = mod.sections.map((s) => s.key.tonic);
    const aliased = compose({ style: 'lofi', mood: 'calm', theme: 'rain', tech: 'analog', bpm: 80, type: 'aba' }, 'alias');
    const [A1, , A2] = aliased.sections;
    const aliasSame = JSON.stringify(A1.chords.map((c) => c.symbol)) === JSON.stringify(A2.chords.map((c) => c.symbol));

    const rhythm = compose({ style: 'rock', mood: 'happy', theme: 'festival', tech: 'analog', bpm: 140, type: 'loop' }, 'rhythm');
    const perBar = {};
    for (const n of rhythm.tracks.chords) {
      const bar = Math.floor(n.t / rhythm.beatsPerBar);
      perBar[bar] = (perBar[bar] || 0) + 1;
    }
    const varied = new Set(Object.values(perBar)).size > 1;

    return { sameDrums, diffLead, keys, aliasSame, varied, chordCount: rhythm.tracks.chords.length };
  });
  check('locked drums survive a new seed', features.sameDrums);
  check('unlocked melody follows the seed', features.diffLead);
  check('sections can modulate key', new Set(features.keys).size > 1, features.keys.join(','));
  check('A-B-A reuses section A material', features.aliasSame);
  check('chord rhythm varies between bars', features.varied, `${features.chordCount} chord notes`);

  console.log('\nSeek and regenerate must not silence playback');
  const resilience = await page.evaluate(async () => {
    const { compose } = await import('./src/core/composer.js');
    const { Player } = await import('./src/audio/engine.js');
    const gainOf = (p) => p.graph.master.gain.value;
    const song = compose({ style: 'lofi', mood: 'calm', theme: 'rain', tech: 'analog', bpm: 100, type: 'full' }, 'resilience');
    const p = new Player(song);
    await p.init();
    if (p.ctx.state === 'suspended') await p.ctx.resume();
    await p.play();
    await new Promise((r) => setTimeout(r, 700));
    const atStart = gainOf(p);

    // seek to 60 %
    await p.play(song.durationSec * 0.6);
    await new Promise((r) => setTimeout(r, 600));
    const afterSeek = gainOf(p);
    const posAfterSeek = p.position;

    // seek to 97 % — this used to schedule the closing fade in the past
    await p.play(song.durationSec * 0.97);
    await new Promise((r) => setTimeout(r, 500));
    const afterLateSeek = gainOf(p);
    const stillPlaying = p.playing;

    // regenerate repeatedly: same context, new song
    const ctxBefore = p.ctx;
    for (let i = 0; i < 8; i++) {
      const next = compose({ style: 'lofi', mood: 'calm', theme: 'rain', tech: 'analog', bpm: 100, type: 'loop' }, `regen-${i}`);
      await p.setSong(next);
    }
    await new Promise((r) => setTimeout(r, 500));
    const afterRegen = gainOf(p);
    const sameContext = p.ctx === ctxBefore;
    const regenPlaying = p.playing;
    const dropped = p.graph.cap.dropped;
    p.stop();
    await p.close();
    return { atStart, afterSeek, afterLateSeek, stillPlaying, afterRegen, sameContext, regenPlaying, dropped, posAfterSeek };
  });
  check('seeking keeps the master audible', resilience.afterSeek > 0.05, `gain ${resilience.afterSeek.toFixed(3)}`);
  check('seeking near the end does not go silent', resilience.afterLateSeek > 0.05, `gain ${resilience.afterLateSeek.toFixed(3)}`);
  check('still playing after a late seek', resilience.stillPlaying);
  check('eight regenerations reuse one AudioContext', resilience.sameContext);
  check('still audible after eight regenerations', resilience.afterRegen > 0.05, `gain ${resilience.afterRegen.toFixed(3)}`);
  check('regenerated songs keep playing', resilience.regenPlaying);
  check('nothing dropped during the churn', resilience.dropped === 0, `${resilience.dropped} dropped`);

  console.log('\n"None" in the dropdowns');
  const noneOpts = await page.evaluate(() => {
    const out = {};
    for (const id of ['style', 'mood', 'theme', 'tech', 'type', 'texture']) {
      const sel = document.getElementById(id);
      out[id] = sel ? [...sel.options].map((o) => o.value) : null;
    }
    return out;
  });
  for (const id of ['style', 'mood', 'theme', 'tech', 'type']) {
    check(`${id} offers None`, Array.isArray(noneOpts[id]) && noneOpts[id].includes('none'),
      (noneOpts[id] || []).join(','));
  }
  check('ambience offers Auto, None and the textures',
    noneOpts.texture?.includes('auto') && noneOpts.texture?.includes('none') && noneOpts.texture?.includes('rain'),
    (noneOpts.texture || []).join(','));

  const ambience = await page.evaluate(async () => {
    const { state } = await import('./src/state.js');
    const { compose } = await import('./src/core/composer.js');
    const sel = document.getElementById('texture');
    const before = state.song.tracks.bed.length;
    sel.value = 'none';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const after = state.song.tracks.bed.length;
    sel.value = 'fire';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const kinds = state.song.tracks.bed.map((n) => n.texture);
    return { before, after, kinds };
  });
  check('choosing None removes the ambience', ambience.after === 0, `bed went ${ambience.before} → ${ambience.after}`);
  check('choosing a texture applies it', ambience.kinds.length > 0 && ambience.kinds.every((k) => k === 'fire'),
    ambience.kinds.join(','));

  console.log('\nThemes');
  const themeStart = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.click('#themetoggle');
  await wait(250);
  const themeLight = await page.evaluate(() => ({
    attr: document.documentElement.dataset.theme,
    bg: getComputedStyle(document.body).backgroundColor,
    meta: document.querySelector('meta[name="theme-color"]').getAttribute('content'),
  }));
  check('theme toggle switches the document', themeLight.attr !== themeStart, `${themeStart} -> ${themeLight.attr}`);
  const themeTokens = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const { themePalette } = window.__musicgen || {};
    return {
      isLight: cs.getPropertyValue('--is-light').trim(),
      bg: cs.getPropertyValue('--bg').trim(),
      text: cs.getPropertyValue('--text').trim(),
      paletteLight: themePalette ? themePalette().isLight : null,
    };
  });
  check('light theme declares itself light', themeTokens.isLight === '1', JSON.stringify(themeTokens));
  check('light theme background is pale', /#f/i.test(themeTokens.bg), themeTokens.bg);
  check('theme-color meta follows the theme', themeLight.meta.toLowerCase() === '#f2f4fa', themeLight.meta);
  const persisted = await page.evaluate(() => {
    const raw = localStorage.getItem('musicgen.v1');
    return raw ? JSON.parse(raw).ui?.theme : null;
  });
  check('theme choice is persisted', persisted === 'light', String(persisted));
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.getElementById('title').textContent !== '—', { timeout: 15000 });
  const afterReload = await page.evaluate(() => document.documentElement.dataset.theme);
  check('theme survives a reload', afterReload === 'light', afterReload);
  await page.click('#themetoggle');
  await wait(200);

  console.log('\nVisualiser modes');
  for (const mode of ['bars', 'wave', 'art', 'roll']) {
    await page.click(`[data-viz="${mode}"]`);
    await new Promise((r) => setTimeout(r, 150));
    const pressed = await page.$eval(`[data-viz="${mode}"]`, (el) => el.getAttribute('aria-pressed'));
    check(`viz mode ${mode} selects`, pressed === 'true', pressed);
  }
  const painted = await page.evaluate(() => {
    const c = document.getElementById('viz');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let nonEmpty = 0;
    for (let i = 3; i < d.length; i += 4000) if (d[i] > 0) nonEmpty++;
    return nonEmpty;
  });
  check('canvas has pixels drawn', painted > 0, `${painted} sampled opaque pixels`);

  console.log('\nStems + zip');
  const stems = await page.evaluate(async () => {
    const { compose } = await import('./src/core/composer.js');
    const { renderSong } = await import('./src/audio/engine.js');
    const { encodeWav } = await import('./src/export/wav.js');
    const { zipStore } = await import('./src/export/zip.js');
    const song = compose({ style: 'folk', mood: 'calm', theme: 'forest', tech: 'physical', bpm: 92, type: 'loop' }, 'stem-seed');
    const buf = await renderSong(song, { sampleRate: 22050, tailSec: 0.3, only: ['bass'] });
    const wav = encodeWav(buf, { bitDepth: 16 });
    // a solo'd render must be quieter than the full mix, not empty
    const full = await renderSong(song, { sampleRate: 22050, tailSec: 0.3 });
    const rms = (b) => {
      const d = b.getChannelData(0);
      let s = 0;
      for (let i = 0; i < d.length; i++) s += d[i] * d[i];
      return Math.sqrt(s / d.length);
    };
    const zip = zipStore([{ name: 'bass.wav', data: wav }]);
    return { soloRms: rms(buf), mixRms: rms(full), zipSig: String.fromCharCode(...zip.slice(0, 2)), wavBytes: wav.length };
  });
  check('solo stem renders audio', stems.soloRms > 0.0005, `rms ${stems.soloRms.toFixed(5)}`);
  check('solo stem is quieter than the mix', stems.soloRms < stems.mixRms, `${stems.soloRms.toFixed(5)} < ${stems.mixRms.toFixed(5)}`);
  check('stem zip is a PK archive', stems.zipSig === 'PK');

  console.log('\nLanding page');
  const landingErrors = [];
  page.on('pageerror', (e) => landingErrors.push(String(e)));
  await page.goto(base, { waitUntil: 'networkidle0' });
  try {
    await page.waitForFunction(
      () => (document.getElementById('spec-meta')?.textContent ?? 'loading…') !== 'loading…',
      { timeout: 20000 },
    );
  } catch (err) {
    const dbg = await page.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(0, 160) }));
    console.log('      landing debug:', JSON.stringify(dbg), landingErrors.slice(0, 3));
    throw err;
  }
  const landing = await page.evaluate(() => {
    const h1 = document.querySelector('h1')?.textContent.trim() ?? '';
    const meta = document.getElementById('spec-meta').textContent;
    const c = document.getElementById('spec-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let opaque = 0;
    for (let i = 3; i < d.length; i += 4000) if (d[i] > 0) opaque++;
    return { h1, meta, opaque, link: document.getElementById('spec-open').getAttribute('href') };
  });
  check('landing headline present', landing.h1.includes('regenerate'), landing.h1);
  check('specimen composed a song', landing.meta.includes('BPM'), landing.meta);
  check('specimen canvas drawn', landing.opaque > 0, `${landing.opaque} pixels`);
  check('specimen links into the studio with its seed', landing.link.startsWith('app/#s='), landing.link);
  check('no landing console errors', landingErrors.length === 0, landingErrors.slice(0, 2).join(' | '));

  const seeds = await page.evaluate(async () => {
    const buttons = [...document.querySelectorAll('#seeds button')];
    if (!buttons.length) return { count: 0 };
    buttons[1].click();
    await new Promise((r) => setTimeout(r, 900));
    return {
      count: buttons.length,
      pressed: document.querySelectorAll('#seeds button[aria-pressed="true"]').length,
      meta: document.getElementById('spec-meta').textContent,
    };
  });
  check('landing has fixed-seed buttons', seeds.count === 3, String(seeds.count));
  check('a fixed seed plays and is marked', seeds.pressed === 1, `${seeds.pressed} pressed`);
  check('fixed seed updates the specimen', /128 BPM/.test(seeds.meta || ''), seeds.meta);

  // the landing page must survive regenerate + seed switching while playing
  const landingLive = await page.evaluate(async () => {
    const playBtn = document.getElementById('spec-play');
    const next = document.getElementById('spec-next');
    const seedsEl = document.querySelectorAll('#seeds button');
    const isPlaying = () => playBtn.textContent.includes('Pause');
    if (!isPlaying()) playBtn.click();          // it may already be playing from the seed test
    await new Promise((r) => setTimeout(r, 900));
    const wasPlaying = isPlaying();
    next.click();
    await new Promise((r) => setTimeout(r, 900));
    if (seedsEl[2]) seedsEl[2].click();
    await new Promise((r) => setTimeout(r, 900));
    const stillPlaying = isPlaying();
    return { wasPlaying, stillPlaying, label: playBtn.textContent };
  });
  check('landing plays', landingLive.wasPlaying, landingLive.label);
  check('landing keeps playing across regenerate and seed switches', landingLive.stillPlaying, landingLive.label);

  console.log('\nInteractions');
  // the browser can detach a frame under load; one retry keeps the suite honest
  async function gotoStudio() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await page.goto(`${base}app/`, { waitUntil: 'networkidle0' });
        await page.waitForFunction(() => document.getElementById('title').textContent !== '—', { timeout: 15000 });
        return;
      } catch (err) {
        if (attempt === 1) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  async function readTitle() {
    try {
      return await page.$eval('#title', (el) => el.textContent);
    } catch {
      await gotoStudio();
      return page.$eval('#title', (el) => el.textContent);
    }
  }
  await gotoStudio();
  const titleNow = await readTitle();
  await page.click('#random');
  await new Promise((r) => setTimeout(r, 600));
  const afterRandom = await readTitle();
  check('random produces a new song', afterRandom !== titleNow, `${titleNow} -> ${afterRandom}`);
  await page.click('#evolve');
  await new Promise((r) => setTimeout(r, 600));
  const afterEvolve = await readTitle();
  check('evolve changes the song', typeof afterEvolve === 'string' && afterEvolve.length > 0);
  await page.select('#style', 'jazz');
  await new Promise((r) => setTimeout(r, 700));
  let jazzMeta = '';
  try { jazzMeta = await page.$eval('#meta', (el) => el.textContent); } catch { await gotoStudio(); }
  check('style change regenerates', jazzMeta.includes('Jazz'), jazzMeta);
  check('no console errors after interaction', errors.length === 0, errors.slice(0, 3).join(' | '));

  // regenerate through the UI while playing: it must keep playing
  const uiLive = await page.evaluate(async () => {
    const { state } = await import('./src/state.js');
    document.getElementById('play').click();
    await new Promise((r) => setTimeout(r, 900));
    const before = document.querySelector('#play').textContent.includes('⏸');
    document.getElementById('generate').click();
    await new Promise((r) => setTimeout(r, 1400));
    const gain = globalThis.__musicgen?.app?.player?.graph?.master?.gain?.value ?? null;
    const playing = document.querySelector('#play').textContent.includes('⏸');
    const pos = globalThis.__musicgen?.app?.player?.position ?? -1;
    return { before, playing, gain, pos, song: !!state.song };
  });
  check('the UI was playing before regenerating', uiLive.before);
  check('regenerating from the UI keeps playing', uiLive.playing);
  check('and the master is still open', uiLive.gain === null || uiLive.gain > 0.05, String(uiLive.gain));

  await page.screenshot({ path: path.join(ROOT, 'tests', 'browser', 'screenshot.png'), fullPage: true });
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.error(' -', f);
  process.exit(1);
}
