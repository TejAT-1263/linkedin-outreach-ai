// Merge V8 coverage from the e2e runs (coverage/e2e-*.json) and print per-file byte coverage for popup code.
// V8 block coverage: nested ranges override their parents, so we paint bytes in order and union across runs.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../coverage');
if (!existsSync(dir)) { console.error('No coverage/ yet — run the e2e suites first.'); process.exit(1); }
const files = new Map();
for (const f of readdirSync(dir).filter(f => /^e2e-.*\.json$/.test(f))) {
  for (const entry of JSON.parse(readFileSync(path.join(dir, f), 'utf8'))) {
    const painted = new Uint8Array(entry.source.length);
    for (const fn of entry.functions) for (const r of fn.ranges) painted.fill(r.count > 0 ? 1 : 0, r.startOffset, r.endOffset);
    const prev = files.get(entry.url);
    if (!prev) files.set(entry.url, { source: entry.source, covered: painted });
    else for (let i = 0; i < painted.length; i++) prev.covered[i] ||= painted[i];
  }
}
const min = Number(process.argv[2] || 0);
let worst = 100;
console.log('popup code exercised in real Chrome by the e2e suites (byte coverage, comments & whitespace excluded):');
// background/ and shared/ are measured by the unit suite (100% lines); here we gate the UI.
for (const [url, { source, covered }] of [...files].filter(([u]) => u.startsWith('popup/')).sort()) {
  // Ignore whitespace and comments when counting.
  const code = source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length));
  let total = 0, hit = 0;
  for (let i = 0; i < code.length; i++) if (!/\s/.test(code[i])) { total++; hit += covered[i]; }
  const pct = total ? (100 * hit) / total : 100;
  worst = Math.min(worst, pct);
  console.log(`  ${url.padEnd(28)} ${pct.toFixed(1).padStart(5)}%`);
}
if (min && worst < min) { console.error(`✗ coverage below ${min}%`); process.exit(1); }
