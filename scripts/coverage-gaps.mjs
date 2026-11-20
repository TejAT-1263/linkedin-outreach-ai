// Print the lines of a browser-tested file that no e2e run executed. Usage: node scripts/coverage-gaps.mjs popup/write.js
import { readdirSync, readFileSync } from 'node:fs';
const target = process.argv[2];
let src; let cov;
for (const f of readdirSync('coverage').filter(f => f.startsWith('e2e-'))) {
  for (const e of JSON.parse(readFileSync(`coverage/${f}`, 'utf8'))) {
    if (e.url !== target) continue;
    const p = new Uint8Array(e.source.length);
    for (const fn of e.functions) for (const r of fn.ranges) p.fill(r.count > 0 ? 1 : 0, r.startOffset, r.endOffset);
    if (!cov) { src = e.source; cov = p; } else for (let i = 0; i < p.length; i++) cov[i] ||= p[i];
  }
}
let off = 0;
src.split('\n').forEach((line, i) => {
  const seg = cov.slice(off, off + line.length);
  if (line.trim() && !line.trim().startsWith('//') && [...line].some((c, j) => !/\s/.test(c) && !seg[j])) console.log(String(i + 1).padStart(4), line.slice(0, 120));
  off += line.length + 1;
});
