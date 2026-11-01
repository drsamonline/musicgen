// The determinism guarantee deserves enforcement, not a promise in a README.
// Fails if the pure modules reach for ambient randomness, clocks or the DOM.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PURE = [
  'app/src/core/rng.js', 'app/src/core/algorithms.js', 'app/src/core/theory.js',
  'app/src/core/voicing.js', 'app/src/core/motif.js', 'app/src/core/composer.js',
  'app/src/core/validate.js',
];
const BANNED = [
  [/\bMath\.random\s*\(/, 'Math.random()'],
  [/\bDate\.now\s*\(/, 'Date.now()'],
  [/\bnew Date\s*\(/, 'new Date()'],
  [/\bdocument\./, 'document'],
  [/\bwindow\./, 'window'],
  [/\bfetch\s*\(/, 'fetch()'],
  [/\blocalStorage\b/, 'localStorage'],
];
// rng.js is the entropy entry point: it may use crypto, and Math.random as a
// last-resort fallback for generating a NEW seed. The composer itself only
// ever consumes the seeded PRNG, never the seed generator.
const ALLOW = { 'app/src/core/rng.js': [/\bcrypto\b/, /Math\.random/] };

let problems = 0;
for (const rel of PURE) {
  const file = path.join(ROOT, rel);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (/^\s*\/\//.test(line)) return;
    for (const [re, name] of BANNED) {
      if (re.test(line)) {
        const allowed = (ALLOW[rel] || []).some((a) => a.test(line));
        if (!allowed) {
          console.error(`${rel}:${i + 1}  ${name} is not allowed in a pure module`);
          problems++;
        }
      }
    }
  });
}

if (problems) {
  console.error(`\n${problems} determinism violation(s)`);
  process.exit(1);
}
console.log(`determinism lint: ${PURE.length} pure modules clean`);
