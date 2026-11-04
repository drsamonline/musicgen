// Visual regression for the studio shell: fixed viewport, fixed seed, pixel diff
// against a committed baseline.
//   node scripts/visual.mjs            → compare
//   node scripts/visual.mjs --update   → rewrite the baselines
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite, SITE } from './build-site.mjs';

async function loadPuppeteer() {
  try { const m = await import('puppeteer'); return m.default ?? m; } catch { /* fall through */ }
  const m = await import('/usr/lib/node_modules/puppeteer-core/lib/cjs/puppeteer/puppeteer-core.js');
  return m.default ?? m;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
buildSite({ quiet: true });
const BASE = path.join(ROOT, 'tests', 'visual');
const UPDATE = process.argv.includes('--update');
fs.mkdirSync(BASE, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let file = path.join(SITE, decodeURIComponent(url.pathname));
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

const CASES = [
  { name: 'studio-dark-mobile', width: 430, height: 932, theme: 'dark' },
  { name: 'studio-light-mobile', width: 430, height: 932, theme: 'light' },
  { name: 'studio-dark-desktop', width: 1100, height: 800, theme: 'dark' },
];

let failures = 0;
for (const c of CASES) {
  const page = await browser.newPage();
  await page.setViewport({ width: c.width, height: c.height, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: c.theme },
    { name: 'prefers-reduced-motion', value: 'reduce' },
  ]);
  await page.evaluateOnNewDocument((theme) => {
    try {
      localStorage.setItem('musicgen.v1', JSON.stringify({
        presets: { style: 'lofi', mood: 'dreamy', theme: 'rain', tech: 'analog', bpm: 84, type: 'loop' },
        seed: 'visual-baseline',
        ui: { theme, seenIntro: true, vizMode: 'roll' },
      }));
    } catch { /* private mode */ }
  }, c.theme);
  await page.goto(`${base}app/`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 900));
  const shot = path.join(BASE, `${c.name}.png`);
  const shotBytes = await page.screenshot({ encoding: 'binary' });
  // puppeteer returns a Uint8Array here; pngjs wants a Buffer
  const current = Buffer.isBuffer(shotBytes) ? shotBytes : Buffer.from(shotBytes);
  await page.close();

  if (UPDATE || !fs.existsSync(shot)) {
    fs.writeFileSync(shot, current);
    console.log(`  baseline written: ${c.name}`);
    continue;
  }

  const expected = fs.readFileSync(shot);
  // PNG bytes differ for any reason; compare decoded pixels instead
  const { PNG } = await import('pngjs').catch(() => ({ PNG: null }));
  if (!PNG) {
    const same = Buffer.compare(expected, current) === 0;
    console.log(`  ${same ? 'ok  ' : 'DIFF'} ${c.name} (byte comparison — install pngjs for pixel diffs)`);
    if (!same) failures++;
    continue;
  }
  const a = PNG.sync.read(expected);
  const b = PNG.sync.read(current);
  // Compare luma on a coarse grid: layout and theme regressions show up,
  // font antialiasing and GPU differences do not. A pixel-exact test that
  // fails on every machine is not a test.
  const STEP = 8;
  let diff = 0;
  let samples = 0;
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  for (let y = 0; y < h; y += STEP) {
    for (let x = 0; x < w; x += STEP) {
      const ia = (a.width * y + x) << 2;
      const ib = (b.width * y + x) << 2;
      const la = 0.299 * a.data[ia] + 0.587 * a.data[ia + 1] + 0.114 * a.data[ia + 2];
      const lb = 0.299 * b.data[ib] + 0.587 * b.data[ib + 1] + 0.114 * b.data[ib + 2];
      if (Math.abs(la - lb) > 12) diff++;
      samples++;
    }
  }
  const ratio = diff / Math.max(1, samples);
  const ok = ratio < 0.05;
  console.log(`  ${ok ? 'ok  ' : 'DIFF'} ${c.name} — ${(ratio * 100).toFixed(2)}% of samples differ`);
  if (!ok) failures++;
}

await browser.close();
server.close();
if (failures) {
  console.error(`\n${failures} visual case(s) changed. Re-run with --update if the change is intended.`);
  process.exit(1);
}
console.log('\nvisual regression: unchanged');
