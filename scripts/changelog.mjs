// Build CHANGELOG.md from the repository's commit history.
//   node scripts/changelog.mjs            (writes CHANGELOG.md)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

// Prefer the real history from the API: this repo is published through the
// connector, so a local clone may only have one commit.
function fromApi() {
  try {
    const raw = execFileSync('gh', ['api', 'repos/drsamonline/musicgen/commits?per_page=100',
      '--jq', '.[] | [.sha, (.commit.author.date | split("T")[0]), (.commit.message | split("\n")[0])] | @tsv'],
    { encoding: 'utf8' }).trim();
    return raw.split('\n').filter(Boolean).map((row) => {
      const [sha, date, message] = row.split('\t');
      return { sha, date, subject: message };
    });
  } catch {
    return null;
  }
}

let lines = fromApi();
if (!lines) {
  try {
    lines = git(['log', '--pretty=format:%H%x09%ad%x09%s', '--date=short'])
      .split('\n').filter(Boolean)
      .map((row) => {
        const [sha, date, subject] = row.split('\t');
        return { sha, date, subject };
      });
  } catch {
    console.error('no history available (no gh, no git) — skipping');
    process.exit(0);
  }
}

const byDate = new Map();
for (const entry of lines) {
  if (!byDate.has(entry.date)) byDate.set(entry.date, []);
  byDate.get(entry.date).push(entry);
}

let out = '# Changelog\n\nGenerated from the commit history by `npm run changelog`.\n';
for (const [date, entries] of byDate) {
  out += `\n## ${date}\n\n`;
  for (const e of entries) out += `- ${e.subject} (\`${e.sha.slice(0, 7)}\`)\n`;
}

fs.writeFileSync(path.join(ROOT, 'CHANGELOG.md'), out);
console.log(`CHANGELOG.md written — ${lines.length} commits across ${byDate.size} days`);
