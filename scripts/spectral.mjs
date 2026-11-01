// Spectral tilt report for a handful of golden seeds: octave-band energy in dB.
// A dev tool for "does this style actually sound like itself?".
//   node scripts/spectral.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function loadPuppeteer() {
  try { const m = await import('puppeteer'); return m.default ?? m; } catch { /* fall through */ }
  const m = await import('/usr/lib/node_modules/puppeteer-core/lib/cjs/puppeteer/puppeteer-core.js');
  return m.default ?? m;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const puppeteer = await loadPuppeteer();
const opts = { headless: true, protocolTimeout: 600000, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.CHROME_PATH) opts.executablePath = process.env.CHROME_PATH;
else if (fs.existsSync('/usr/local/bin/chromium')) opts.executablePath = '/usr/local/bin/chromium';
const browser = await puppeteer.launch(opts);
const page = await browser.newPage();
await page.goto(`${base}app/`, { waitUntil: 'networkidle0' });

const rows = await page.evaluate(async () => {
  const { compose } = await import('./src/core/composer.js');
  const { renderSong } = await import('./src/audio/engine.js');
  const bands = [[20, 60], [60, 120], [120, 250], [250, 500], [500, 1000], [1000, 2000], [2000, 4000], [4000, 8000], [8000, 16000]];
  const out = [];
  for (const [style, bpm] of [['lofi', 84], ['edm', 128], ['ambient', 60], ['jazz', 132]]) {
    const song = compose({ style, mood: 'calm', theme: 'rain', tech: 'analog', bpm, type: 'loop' }, `spec-${style}`);
    const buf = await renderSong(song, { sampleRate: 22050, tailSec: 0.2 });
    const d = buf.getChannelData(0);
    const sr = buf.sampleRate;
    // Goertzel per band centre, averaged across the band
    const goertzel = (freq) => {
      const w = (2 * Math.PI * freq) / sr;
      const c = 2 * Math.cos(w);
      let s0 = 0, s1 = 0, s2 = 0;
      for (let i = 0; i < d.length; i += 2) { s0 = d[i] + c * s1 - s2; s2 = s1; s1 = s0; }
      return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / d.length;
    };
    const energy = bands.map(([lo, hi]) => {
      let acc = 0, n = 0;
      for (let f = lo; f < hi; f *= 1.25) { acc += goertzel(f); n++; }
      const e = acc / n;
      return 20 * Math.log10(Math.max(1e-9, e));
    });
    out.push({ style, bands: energy.map((v) => +v.toFixed(1)) });
  }
  return out;
});

await browser.close();
server.close();

const header = ['20-60', '60-120', '120-250', '250-500', '0.5-1k', '1-2k', '2-4k', '4-8k', '8-16k'];
console.log(`\nSpectral tilt (dB, unnormalised)\n`);
console.log(['style'.padEnd(10), ...header.map((h) => h.padStart(8))].join(''));
for (const row of rows) {
  console.log([row.style.padEnd(10), ...row.bands.map((v) => String(v).padStart(8))].join(''));
}
console.log('');
