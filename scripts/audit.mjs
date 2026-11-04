// Accessibility + quality audit with axe-core, in both themes, plus a few
// app-specific checks axe cannot know about.
//   node scripts/audit.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite, SITE } from './build-site.mjs';

async function loadPuppeteer() {
  try {
    const mod = await import('puppeteer');
    return mod.default ?? mod;
  } catch { /* fall through */ }
  try {
    const mod = await import('/usr/lib/node_modules/puppeteer-core/lib/cjs/puppeteer/puppeteer-core.js');
    return mod.default ?? mod;
  } catch {
    throw new Error('puppeteer not found. Run: npm install --no-save puppeteer axe-core');
  }
}

function launchOptions() {
  const opts = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] };
  if (process.env.CHROME_PATH) opts.executablePath = process.env.CHROME_PATH;
  else if (fs.existsSync('/usr/local/bin/chromium')) opts.executablePath = '/usr/local/bin/chromium';
  return opts;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
buildSite({ quiet: true });
const AXE_PATH = path.join(ROOT, 'node_modules', 'axe-core', 'axe.min.js');
if (!fs.existsSync(AXE_PATH)) {
  console.error('axe-core not installed. Run: npm install --no-save axe-core');
  process.exit(2);
}
const AXE = fs.readFileSync(AXE_PATH, 'utf8');
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
const browser = await puppeteer.launch(launchOptions());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const failures = [];

async function auditPage(name, { url, theme = 'dark', width = 430, height = 932, prepare = null }) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
  await page.evaluateOnNewDocument((t) => {
    try { localStorage.setItem('musicgen.v1', JSON.stringify({ ui: { theme: t } })); } catch { /* noop */ }
  }, theme);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(url, { waitUntil: 'networkidle0' });
  await wait(800);
  if (prepare) { await prepare(page); await wait(400); }

  const axeResults = await page.evaluate(async (axeSrc) => {
    // eslint-disable-next-line no-eval
    new Function(axeSrc)();
    const r = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
    });
    return r.violations.map((v) => ({
      id: v.id, impact: v.impact, help: v.help,
      nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
      count: v.nodes.length,
    }));
  }, AXE);

  // app-specific checks
  const extra = await page.evaluate(() => {
    const issues = [];
    const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length) issues.push(`duplicate ids: ${[...new Set(dupes)].join(', ')}`);

    for (const el of document.querySelectorAll('button')) {
      const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
      if (!label) issues.push(`unlabelled button: ${el.id || el.className}`);
    }
    for (const el of document.querySelectorAll('img')) {
      if (!el.hasAttribute('alt')) issues.push(`image without alt: ${el.src}`);
    }
    for (const el of document.querySelectorAll('canvas')) {
      if (!el.getAttribute('aria-label') && !el.getAttribute('role')) issues.push('canvas without aria-label');
    }
    for (const el of document.querySelectorAll('select, input')) {
      if (!el.id) continue;
      if (!document.querySelector(`label[for="${el.id}"]`) && !el.getAttribute('aria-label')) {
        issues.push(`control without label: #${el.id}`);
      }
    }
    const lang = document.documentElement.lang;
    if (!lang) issues.push('html lang missing');
    return issues;
  });

  results.push({ name, theme, violations: axeResults, extra, errors });
  await page.close();
}

console.log('Auditing…');
await auditPage('studio (dark)', { url: `${base}app/`, theme: 'dark' });
await auditPage('studio (light)', { url: `${base}app/`, theme: 'light' });
await auditPage('studio desktop (dark)', { url: `${base}app/`, theme: 'dark', width: 1200, height: 900 });
await auditPage('landing (dark)', { url: base, theme: 'dark', width: 1440, height: 900 });
// The plan panel is collapsed by default, so opening it is the only way axe
// ever sees the chord chips and the section tools.
await auditPage('studio plan open (dark)', {
  url: `${base}app/`, theme: 'dark', width: 1200, height: 900,
  prepare: (page) => page.evaluate(() => { document.querySelector('details.plan').open = true; }),
});
await auditPage('studio plan open (light)', {
  url: `${base}app/`, theme: 'light',
  prepare: (page) => page.evaluate(() => { document.querySelector('details.plan').open = true; }),
});

await browser.close();
server.close();

for (const r of results) {
  console.log(`\n${r.name}`);
  if (!r.violations.length) console.log('  axe: clean');
  for (const v of r.violations) {
    console.log(`  axe [${v.impact}] ${v.id} ×${v.count} — ${v.help}`);
    for (const n of v.nodes) console.log(`        ${n}`);
    if (['critical', 'serious'].includes(v.impact)) failures.push(`${r.name}: ${v.id}`);
  }
  if (r.extra.length) {
    console.log('  app checks:');
    for (const e of r.extra) console.log(`        ${e}`);
    failures.push(`${r.name}: ${r.extra.length} app-level issue(s)`);
  } else {
    console.log('  app checks: clean');
  }
  if (r.errors.length) {
    console.log('  console errors:');
    for (const e of r.errors.slice(0, 4)) console.log(`        ${e.slice(0, 160)}`);
    failures.push(`${r.name}: console errors`);
  }
}

console.log(`\n${failures.length ? `${failures.length} blocking issue(s)` : 'Audit clean'}`);
if (failures.length) {
  for (const f of failures) console.error(' -', f);
  process.exit(1);
}
