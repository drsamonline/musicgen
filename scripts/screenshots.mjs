// Capture the README screenshots. Real Chromium, real Web Audio, dark theme.
//   node scripts/screenshots.mjs
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};

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
const browser = await puppeteer.launch(launchOptions(['--force-color-profile=srgb']));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(name, { url, width, height, dpr = 2, full = false, before = null }) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: dpr });
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: 'dark' },
    { name: 'prefers-reduced-motion', value: 'no-preference' },
  ]);
  await page.goto(url, { waitUntil: 'networkidle0' });
  await wait(900);
  if (before) await before(page);
  await page.screenshot({ path: path.join(OUT, name), fullPage: full });
  console.log('  wrote', path.join('docs/screenshots', name));
  await page.close();
}

console.log('Capturing screenshots…');

// studio, mobile — a fresh song, playing, piano roll visible
await shoot('studio-mobile.png', {
  url: `${base}app/`,
  width: 430, height: 932, dpr: 2,
  before: async (page) => {
    await page.select('#style', 'lofi');
    await page.select('#mood', 'dreamy');
    await page.select('#theme', 'rain');
    await wait(800);
    await page.click('#play');
    await wait(1400);
  },
});

// studio, desktop — art visualiser, advanced panel open
await shoot('studio-desktop.png', {
  url: `${base}app/`,
  width: 1100, height: 900, dpr: 1.5,
  before: async (page) => {
    await page.select('#style', 'edm');
    await page.select('#mood', 'epic');
    await page.select('#theme', 'festival');
    await wait(900);
    await page.click('#play');
    await wait(900);
    await page.click('[data-viz="bars"]');
    await wait(700);
  },
});

// studio, spectrum view
await shoot('studio-spectrum.png', {
  url: `${base}app/`,
  width: 430, height: 932, dpr: 2,
  before: async (page) => {
    await page.select('#style', 'chiptune');
    await page.select('#mood', 'playful');
    await page.select('#theme', 'cyberpunk');
    await wait(900);
    await page.click('#play');
    await wait(900);
    await page.click('[data-viz="wave"]');
    await wait(700);
  },
});

// landing, desktop hero
await shoot('landing-desktop.png', {
  url: base, width: 1440, height: 900, dpr: 1.5,
});

// landing, full page
await shoot('landing-full.png', {
  url: base, width: 1440, height: 900, dpr: 1, full: true,
});

// landing, mobile
await shoot('landing-mobile.png', {
  url: base, width: 430, height: 932, dpr: 2,
});

// cover art, straight out of the export pipeline
{
  const page = await browser.newPage();
  await page.setViewport({ width: 600, height: 600, deviceScaleFactor: 1 });
  await page.goto(`${base}app/`, { waitUntil: 'networkidle0' });
  await wait(600);
  const dataUrl = await page.evaluate(async () => {
    const { compose } = await import('./src/core/composer.js');
    const { drawArtwork } = await import('./src/export/artwork.js');
    const song = compose({ style: 'lofi', mood: 'dreamy', theme: 'rain', tech: 'analog', bpm: 84, type: 'loop' }, 'coverart01');
    const canvas = document.createElement('canvas');
    drawArtwork(canvas, song, 1024);
    return canvas.toDataURL('image/png');
  });
  fs.writeFileSync(path.join(OUT, 'cover-art.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('  wrote docs/screenshots/cover-art.png');
  await page.close();
}

await browser.close();
server.close();
console.log('Done.');
