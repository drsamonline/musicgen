// Startup budget + offline promise checks.
//   node scripts/budget.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'app');

const BUDGET_KB = 200;
const problems = [];

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'screenshots') continue;
      walk(full, base, out);
    } else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

// src paths are app-relative ('src/core/…'); the sw lists them that way too
const SRC = walk(path.join(APP, 'src')).map((rel) => `src/${rel}`);

// 1. shell size, gzipped
const shell = ['index.html', 'styles.css', 'sw.js', 'manifest.webmanifest'].concat(SRC);
let raw = 0;
const parts = [];
for (const rel of shell) {
  const buf = fs.readFileSync(path.join(APP, rel));
  raw += buf.length;
  parts.push(buf);
}
const gz = zlib.gzipSync(Buffer.concat(parts), { level: 9 }).length;
console.log(`shell: ${(raw / 1024).toFixed(0)} KB raw, ${(gz / 1024).toFixed(1)} KB gzipped, ${shell.length} files`);
if (gz / 1024 > BUDGET_KB) problems.push(`shell is ${(gz / 1024).toFixed(1)} KB gzipped (budget ${BUDGET_KB})`);

// 2. service worker precache must match the real files
const sw = fs.readFileSync(path.join(APP, 'sw.js'), 'utf8');
const listed = [...sw.matchAll(/'([^']+\.(?:js|css|html|png|webmanifest))'/g)].map((m) => m[1]);
const actual = new Set(['index.html', 'styles.css', 'manifest.webmanifest'].concat(SRC));
for (const rel of listed) {
  if (rel === './' || rel === 'index.html') continue;
  if (!actual.has(rel) && !fs.existsSync(path.join(APP, rel))) problems.push(`sw.js precaches a missing file: ${rel}`);
}
for (const rel of actual) {
  if (rel === 'sw.js') continue;
  if (!listed.includes(rel)) problems.push(`sw.js does not precache: ${rel}`);
}

// 3. no outbound requests anywhere in the app
const textFiles = ['index.html', 'styles.css', 'sw.js', 'manifest.webmanifest'].concat(SRC);
for (const rel of textFiles) {
  const body = fs.readFileSync(path.join(APP, rel), 'utf8');
  const hits = body.match(/https?:\/\/(?!localhost|127\.0\.0\.1)[a-z0-9.-]+/gi) || [];
  for (const hit of hits) problems.push(`${rel} references an external URL: ${hit}`);
}

// 4. the app must not import from outside itself
for (const rel of SRC) {
  const body = fs.readFileSync(path.join(APP, rel), 'utf8');
  if (/from ['"]https?:/.test(body)) problems.push(`${rel} imports over the network`);
}

if (problems.length) {
  console.error('\nbudget check failed:');
  for (const p of problems) console.error(' -', p);
  process.exit(1);
}
console.log('budget: OK — shell within budget, precache complete, no external requests');
