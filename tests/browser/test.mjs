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
  const mod = await import('/usr/lib/node_modules/puppeteer-core/lib/cjs/puppeteer/puppeteer-core.js');
  return mod.default ?? mod;
}

function launchOptions(extra = []) {
  const opts = {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', ...extra],
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
    const active = p.graph.cap.active;
    p.stop();
    await p.close();
    return { pos, active, state: 'ok' };
  });
  check('playhead advances', live.pos > 0.2, `position ${live.pos.toFixed(2)} s`);
  check('voices were created', live.active > 0, `${live.active} active voices`);

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

  console.log('\nInteractions');
  await page.goto(`${base}app/`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.getElementById('title').textContent !== '—', { timeout: 15000 });
  const titleNow = await page.$eval('#title', (el) => el.textContent);
  await page.click('#random');
  await new Promise((r) => setTimeout(r, 600));
  const afterRandom = await page.$eval('#title', (el) => el.textContent);
  check('random produces a new song', afterRandom !== titleNow, `${titleNow} -> ${afterRandom}`);
  await page.click('#evolve');
  await new Promise((r) => setTimeout(r, 600));
  const afterEvolve = await page.$eval('#title', (el) => el.textContent);
  check('evolve changes the song', typeof afterEvolve === 'string' && afterEvolve.length > 0);
  await page.select('#style', 'jazz');
  await new Promise((r) => setTimeout(r, 700));
  const jazzMeta = await page.$eval('#meta', (el) => el.textContent);
  check('style change regenerates', jazzMeta.includes('Jazz'), jazzMeta);
  check('no console errors after interaction', errors.length === 0, errors.slice(0, 3).join(' | '));

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
