// Assemble the published site into _site/.
//
// The repo keeps two trees: `docs/` is the page a visitor lands on, `app/` is
// the studio. They are separate because the studio is also opened straight
// from `app/` while you work on it. GitHub Pages serves one directory, so the
// deploy step — and every test that loads the real thing — is what puts them
// side by side, at `/` and `/app/`.
//
// Nothing here is duplicated in git: _site/ is built, ignored, and rebuilt.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SITE = path.join(ROOT, '_site');

// The published tree must contain these or the deploy is broken in a way a
// green test run would hide.
const REQUIRED = [
  'index.html',
  'landing.css',
  'landing.js',
  'screenshots/studio-desktop.png',
  'play/index.html',
  'app/index.html',
  'app/styles.css',
  'app/sw.js',
  'app/manifest.webmanifest',
  'app/src/main.js',
  'app/icons/icon-192.png',
];

// Every local href/src in every page must resolve inside the published tree.
// A page that links to something one folder up, or to a file that was deleted
// from the root, is the failure this exists to catch — it is invisible until
// someone clicks it on the live site.
function checkLinks() {
  const broken = [];
  const skip = /^(?:[a-z]+:|\/\/|#)/i;

  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : [full];
    });

  for (const file of walk(SITE).filter((f) => f.endsWith('.html'))) {
    const rel = path.relative(SITE, file).split(path.sep).join('/');
    const html = fs.readFileSync(file, 'utf8');
    for (const [, raw] of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
      if (!raw || skip.test(raw)) continue;
      const target = raw.split(/[?#]/)[0];
      if (!target) continue;
      const resolved = target.startsWith('/')
        ? path.join(SITE, target)
        : path.join(path.dirname(file), target);
      const candidate = raw.endsWith('/') || target === '.' ? path.join(resolved, 'index.html') : resolved;
      if (!fs.existsSync(candidate)) broken.push(`${rel} -> ${raw}`);
    }
  }
  return [...new Set(broken)];
}

export function buildSite({ quiet = false } = {}) {
  const say = quiet ? () => {} : (...a) => console.log(...a);

  fs.rmSync(SITE, { recursive: true, force: true });
  fs.mkdirSync(SITE, { recursive: true });

  fs.cpSync(path.join(ROOT, 'docs'), SITE, { recursive: true });
  fs.cpSync(path.join(ROOT, 'app'), path.join(SITE, 'app'), { recursive: true });

  const missing = REQUIRED.filter((rel) => !fs.existsSync(path.join(SITE, rel)));
  if (missing.length) {
    throw new Error(`build-site: the published tree is missing ${missing.join(', ')}`);
  }

  // The landing must reach the studio at a path that exists in the built tree.
  const landing = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
  const cta = [...landing.matchAll(/href="([^"]*app\/[^"]*)"/g)].map((m) => m[1]);
  for (const href of cta) {
    const target = path.join(SITE, href.replace(/[?#].*$/, ''));
    const file = href.endsWith('/') ? path.join(target, 'index.html') : target;
    if (!fs.existsSync(file)) {
      throw new Error(`build-site: the landing links to ${href}, which is not in the built tree`);
    }
  }

  const broken = checkLinks();
  if (broken.length) {
    throw new Error(`build-site: ${broken.length} link(s) point at nothing in the published tree:\n  ${broken.join('\n  ')}`);
  }

  const count = (dir) => fs.readdirSync(dir, { recursive: true }).length;
  say(`site: ${count(SITE)} files -> _site/ (landing at /, studio at /app/, ${cta.length} studio links, ${broken.length} broken)`);
  return SITE;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) buildSite();
