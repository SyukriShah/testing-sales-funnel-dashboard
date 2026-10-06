// Keeps disk use in check. Results (result.json, logs) are always kept, so history and trends stay.
//  - screenshots and comparison images of runs older than retention.screenshotDays are deleted
//  - Playwright's debug folders (test-results, report) are kept only for the newest retention.debugRuns runs
//   node scripts/prune.mjs            do it
//   node scripts/prune.mjs --dry-run  list what would be removed
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const runsDir = path.join(root, 'runs');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'monitor.config.json'), 'utf8'));
const days = cfg.retention?.screenshotDays ?? 14;
const debugRuns = cfg.retention?.debugRuns ?? 3;
const dry = process.argv.includes('--dry-run');
const cutoff = Date.now() - days * 86_400_000;

const size = (p) => { let n = 0; for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); n += e.isDirectory() ? size(f) : fs.statSync(f).size; } return n; };
const find = (dir, name, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (!e.isDirectory()) continue; const f = path.join(dir, e.name); if (e.name === name) out.push(f); else find(f, name, out); } return out; };
const stamp = (id) => { const m = id.match(/^run-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null; };

let freed = 0, runs = 0;
const remove = (tgt) => { freed += fs.statSync(tgt).isDirectory() ? size(tgt) : fs.statSync(tgt).size; if (!dry) fs.rmSync(tgt, { recursive: true, force: true }); };
if (fs.existsSync(runsDir)) {
  const ids = fs.readdirSync(runsDir).filter((d) => d.startsWith('run-')).sort();
  ids.forEach((id, i) => {
    const dir = path.join(runsDir, id);
    const targets = [];
    if (i < ids.length - debugRuns) targets.push(...['test-results', 'report'].map((n) => path.join(dir, n)).filter(fs.existsSync));
    // the newest run's images are always kept, however old, so the dashboard is never left without any
    const t = stamp(id);
    if (i < ids.length - 1 && t !== null && t <= cutoff) {
      targets.push(...find(dir, 'screenshots'));
      targets.push(...find(dir, 'compare').flatMap((c) => fs.readdirSync(c, { recursive: true }).filter((f) => /\.png$/.test(String(f))).map((f) => path.join(c, String(f)))));
    }
    if (targets.length) { runs++; targets.filter(fs.existsSync).forEach(remove); }
  });
}
console.log(`${dry ? '[dry run] would free' : 'Freed'} ${(freed / 1e6).toFixed(1)} MB across ${runs} run(s).`);
