// Build a Chrome Web Store–ready zip of extension/ into dist/, after validating the manifest.
import { readFileSync, mkdirSync, existsSync, rmSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ext = path.join(root, 'extension');
const manifest = JSON.parse(readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
if (manifest.version !== pkg.version) fail(`manifest version ${manifest.version} ≠ package.json ${pkg.version}`);

// Every file the manifest references must exist.
const refs = [
  manifest.background.service_worker, manifest.action.default_popup,
  ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
  ...manifest.content_scripts.flatMap(c => c.js)
];
for (const r of refs) if (!existsSync(path.join(ext, r))) fail(`manifest references missing file: ${r}`);

const walk = (d) => readdirSync(d).flatMap(f => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(ext).map(f => path.relative(ext, f)).filter(f => !/(^|\/)\.|\.map$/.test(f));

mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', `linkedin-outreach-ai-v${manifest.version}.zip`);
rmSync(out, { force: true });
execFileSync('zip', ['-q', '-X', out, ...files], { cwd: ext });
console.log(`✓ ${path.relative(root, out)} (${files.length} files, ${(statSync(out).size / 1024).toFixed(1)} KB)`);
