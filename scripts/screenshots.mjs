// Capture the README + landing-page screenshots. Real Chromium, real Web Audio.
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

async function shoot(name, { url, width, height, dpr = 2, full = false, theme = 'dark', before = null, clipTo = null }) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: dpr });
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: theme === 'light' ? 'light' : 'dark' },
    { name: 'prefers-reduced-motion', value: 'no-preference' },
  ]);
  // pin the theme in stored state so the app does not depend on the media query
  await page.evaluateOnNewDocument((t) => {
    try {
      localStorage.setItem('musicgen.v1', JSON.stringify({ ui: { theme: t, volume: 0.9 } }));
    } catch { /* private mode */ }
  }, theme === 'light' ? 'light' : 'dark');

  await page.goto(url, { waitUntil: 'networkidle0' });
  await wait(900);
  if (before) await before(page);

  let clip;
  if (clipTo) {
    // Grow the viewport to fit the app, then clip to its box. Growing first
    // avoids captureBeyondViewport, which re-composites sticky layers.
    const box = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
    }, clipTo);
    if (box) {
      const needed = Math.ceil(box.height + box.y + 16);
      if (needed > height) {
        await page.setViewport({ width, height: needed, deviceScaleFactor: dpr });
        await wait(400);
      }
      clip = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          x: Math.max(0, r.x - 4),
          y: Math.max(0, r.y - 4),
          width: r.width + 8,
          height: r.height + 8,
        };
      }, clipTo);
    }
  }
  await page.screenshot({
    path: path.join(OUT, name),
    fullPage: full && !clip,
    ...(clip ? { clip } : {}),
  });
  console.log('  wrote', path.join('docs/screenshots', name));
  await page.close();
}

const pickPreset = async (page, { style, mood, theme, bpm }) => {
  await page.select('#style', style);
  await page.select('#mood', mood);
  await page.select('#theme', theme);
  if (bpm) {
    await page.evaluate((v) => {
      const el = document.getElementById('bpm');
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, bpm);
  }
  await wait(900);
};

console.log('Capturing screenshots…');

// --- dark ---------------------------------------------------------------
await shoot('studio-mobile.png', {
  url: `${base}app/`, width: 430, height: 932, dpr: 2, theme: 'dark', clipTo: '#app',
  before: async (page) => {
    await pickPreset(page, { style: 'lofi', mood: 'dreamy', theme: 'rain', bpm: 84 });
    await page.click('#play');
    await wait(1400);
  },
});

await shoot('studio-desktop.png', {
  url: `${base}app/`, width: 1200, height: 900, dpr: 1.5, theme: 'dark', clipTo: '#app',
  before: async (page) => {
    await pickPreset(page, { style: 'edm', mood: 'epic', theme: 'festival', bpm: 128 });
    await page.click('#play');
    await wait(900);
    await page.click('[data-viz="bars"]');
    await wait(700);
  },
});

await shoot('studio-spectrum.png', {
  url: `${base}app/`, width: 430, height: 932, dpr: 2, theme: 'dark', clipTo: '#app',
  before: async (page) => {
    await pickPreset(page, { style: 'chiptune', mood: 'playful', theme: 'cyberpunk', bpm: 150 });
    await page.click('#play');
    await wait(900);
    await page.click('[data-viz="wave"]');
    await wait(700);
  },
});

// --- light --------------------------------------------------------------
await shoot('studio-light-mobile.png', {
  url: `${base}app/`, width: 430, height: 932, dpr: 2, theme: 'light', clipTo: '#app',
  before: async (page) => {
    await pickPreset(page, { style: 'folk', mood: 'hopeful', theme: 'forest', bpm: 96 });
    await page.click('#play');
    await wait(1300);
  },
});

await shoot('studio-light-desktop.png', {
  url: `${base}app/`, width: 1200, height: 900, dpr: 1.5, theme: 'light', clipTo: '#app',
  before: async (page) => {
    await pickPreset(page, { style: 'jazz', mood: 'playful', theme: 'nightdrive', bpm: 132 });
    await page.click('#play');
    await wait(900);
    await page.click('[data-viz="roll"]');
    await wait(600);
  },
});

// --- landing ------------------------------------------------------------
await shoot('landing-desktop.png', { url: base, width: 1440, height: 900, dpr: 1.5 });
await shoot('landing-full.png', { url: base, width: 1440, height: 900, dpr: 1, full: true });
await shoot('landing-mobile.png', { url: base, width: 430, height: 932, dpr: 2 });

// --- cover art, straight out of the export pipeline ---------------------
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
