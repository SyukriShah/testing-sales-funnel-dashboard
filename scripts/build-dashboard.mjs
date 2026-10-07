// Builds dashboard/index.html from runs/<run>/<env>/<product>/<scenario>/result.json
// (older runs without an <env> level are read as production).
//   node scripts/build-dashboard.mjs              -> dashboard/index.html + data.json (local, served by `npm run serve`)
//   node scripts/build-dashboard.mjs --artifact   -> dashboard/artifact.html + artifact-files/ (for publishing)
// For every run that has results from two environments it also compares them (flow, facts, design),
// writes diff images and runs/<run>/compare/<product>/report.md.
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const root = path.resolve(import.meta.dirname, '..');
const runsDir = path.join(root, 'runs');
const outDir = path.join(root, 'dashboard');
const clientDir = path.join(import.meta.dirname, 'client');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'monitor.config.json'), 'utf8'));
const artifact = process.argv.includes('--artifact');
const recompare = process.argv.includes('--recompare'); // ignore cached comparisons (e.g. after changing thresholds)

const envIds = Object.keys(cfg.environments);
const SKIP = ['report', 'test-results', 'compare'];
const isDir = (p) => fs.existsSync(p) && fs.statSync(p).isDirectory();
const ignored = (url) => cfg.ignoredHttp.some((frag) => url.includes(frag));

// ---------- collect ----------
const runs = new Map(); // runId -> `${env}|${product}` -> results[]
function addScenario(runId, env, product, scDir, rel) {
  const f = path.join(scDir, 'result.json');
  if (!fs.existsSync(f)) return;
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  r.env = r.env ?? env;
  const benignApi = r.httpErrors.filter((e) => ignored(e.url) && e.url.includes('/api/')).length;
  r.api = { total: r.api.total, failed: Math.max(0, r.api.failed - benignApi) };
  r.httpErrors = r.httpErrors.filter((e) => !ignored(e.url));
  r.consoleErrors = r.consoleErrors.filter((e) => !ignored(e));
  r.health = r.status !== 'passed' ? 'fail' : r.httpErrors.length || r.consoleErrors.length ? 'warn' : 'pass';
  r.screenshots = r.screenshots.filter((s) => fs.existsSync(path.join(runsDir, runId, s))); // old runs may have had their screenshots pruned
  r.shotsRel = r.screenshots; // relative to the run folder
  r.screenshots = r.screenshots.map((s) => `../runs/${runId}/${s}`);
  r.logPath = `../runs/${runId}/${rel}/test.log`;
  r.snapshots = r.snapshots ?? {};
  r.facts = r.facts ?? {};
  const key = `${r.env}|${product}`;
  if (!runs.has(runId)) runs.set(runId, new Map());
  if (!runs.get(runId).has(key)) runs.get(runId).set(key, []);
  runs.get(runId).get(key).push(r);
}

for (const runId of isDir(runsDir) ? fs.readdirSync(runsDir).filter((d) => d.startsWith('run-')) : []) {
  for (const entry of fs.readdirSync(path.join(runsDir, runId))) {
    const dir = path.join(runsDir, runId, entry);
    if (!isDir(dir) || SKIP.includes(entry)) continue;
    if (envIds.includes(entry)) {
      // new layout: <env>/<product>/<scenario>
      for (const product of fs.readdirSync(dir)) {
        const pDir = path.join(dir, product);
        if (!isDir(pDir)) continue;
        for (const sc of fs.readdirSync(pDir)) addScenario(runId, entry, product, path.join(pDir, sc), `${entry}/${product}/${sc}`);
      }
    } else {
      // legacy layout: <product>/<scenario>, always production
      for (const sc of fs.readdirSync(dir)) addScenario(runId, 'production', entry, path.join(dir, sc), `${entry}/${sc}`);
    }
  }
}

const runIds = [...runs.keys()].sort(); // run-YYYYMMDD-HHMMSS sorts chronologically

// A result belongs to a product line (Car, Travel, ...). Entry-point scenarios carry their product in the scenario id.
const LINE_IN_ID = /^scenario-\d+-(car|motorcycle|travel|home|personal-accident|health|hibah|savings)-/;
const lineOf = (r, suite) => r.line ?? cfg.suiteLine?.[suite] ?? r.scenario.match(LINE_IN_ID)?.[1] ?? suite;

const products = {}; // keyed by product line
for (const runId of runIds) {
  for (const [key, results] of runs.get(runId)) {
    const [env, suite] = key.split('|');
    results.sort((a, b) => a.scenario.localeCompare(b.scenario, undefined, { numeric: true })); // scenario-2 before scenario-10
    const byLine = new Map();
    for (const r of results) {
      const l = lineOf(r, suite);
      r.line = l;
      (byLine.get(l) ?? byLine.set(l, []).get(l)).push(r);
    }
    for (const [line, rs] of byLine) {
      const p = (products[line] ??= { id: line, name: cfg.lines?.[line] ?? cfg.products[line] ?? line, runs: [] });
      const times = rs.map((r) => Date.parse(r.startedAt));
      const trigger = rs[0].trigger ?? 'scheduled'; // runs recorded before triggers existed
      const overridesFile = path.join(runsDir, runId, 'overrides.json');
      let data = null;
      if (trigger === 'dashboard' && fs.existsSync(overridesFile)) {
        const o = JSON.parse(fs.readFileSync(overridesFile, 'utf8'));
        data = o.participant ? { participant: o.participant, flight: o.flight, bank: o.bank } : null;
      }
      p.runs.push({
        runId, env, suite, suiteName: cfg.suites?.[suite] ?? suite, trigger,
        baseUrl: rs[0].baseUrl ?? cfg.environments[env]?.baseUrl ?? '',
        custom: trigger === 'dashboard' || trigger === 'mobile', // custom-data and phone-size runs are listed but excluded from health stats
        device: trigger === 'mobile' ? 'mobile' : 'desktop',
        data,
        startedAt: new Date(Math.min(...times)).toISOString(),
        durationMs: rs.reduce((a, r) => a + r.durationMs, 0),
        passed: rs.filter((r) => r.status === 'passed').length,
        total: rs.length,
        health: rs.some((r) => r.health === 'fail') ? 'fail' : rs.some((r) => r.health === 'warn') ? 'warn' : 'pass',
        results: rs,
      });
    }
  }
}

// ---------- compare environments ----------
const readPng = (f) => PNG.sync.read(fs.readFileSync(f));
const stripNn = (base) => base.replace(/^\d+-/, '');
const arrDiff = (a = [], b = []) => ({
  onlyA: a.filter((x) => !b.includes(x)),
  onlyB: b.filter((x) => !a.includes(x)),
});

function compareShots(runId, product, scenario, a, b, rel) {
  const byName = (r) => Object.fromEntries(r.shotsRel.map((s) => [stripNn(path.basename(s)), s]));
  const A = byName(a), B = byName(b);
  const names = [...new Set([...Object.keys(A), ...Object.keys(B)])];
  const steps = [];
  for (const name of names) {
    const step = { step: name.replace(/\.png$/, ''), inA: !!A[name], inB: !!B[name], pixelPct: null, sizeMismatch: false, content: [], styles: [], paths: null, images: null, verdict: 'identical' };
    if (A[name] && B[name]) {
      const fa = path.join(runsDir, runId, A[name]), fb = path.join(runsDir, runId, B[name]);
            const base = path.basename(A[name]);
      let pa = readPng(fa), pb = readPng(fb);
      if (pa.width !== pb.width) {
        step.sizeMismatch = true; step.pixelPct = 100; // different widths: layouts cannot be overlaid
      } else {
        if (pa.height !== pb.height) {
          // Full-page captures can differ in height (lazy content). Compare the shared top region and report the height gap separately.
          const h = Math.min(pa.height, pb.height);
          step.heightDiff = Math.abs(pa.height - pb.height);
          step.heightPct = Math.round((step.heightDiff / Math.max(pa.height, pb.height)) * 1000) / 10;
          const crop = (img) => { const o = new PNG({ width: img.width, height: h }); PNG.bitblt(img, o, 0, 0, img.width, h, 0, 0); return o; };
          pa = crop(pa); pb = crop(pb);
        }
        const diff = new PNG({ width: pa.width, height: pa.height });
        const n = pixelmatch(pa.data, pb.data, diff.data, pa.width, pa.height, { threshold: 0.1 });
        step.pixelPct = Math.round((n / (pa.width * pa.height)) * 10000) / 100;
        const diffRel = `compare/${product}/${scenario}/${stripNn(base).replace(/\.png$/, '')}.diff.png`;
        fs.mkdirSync(path.dirname(path.join(runsDir, runId, diffRel)), { recursive: true });
        fs.writeFileSync(path.join(runsDir, runId, diffRel), PNG.sync.write(diff));
        step.images = artifact ? null : { a: `../runs/${runId}/${A[name]}`, b: `../runs/${runId}/${B[name]}`, diff: `../runs/${runId}/${diffRel}` };
      }
      const sa = a.snapshots[path.basename(A[name])], sb = b.snapshots[path.basename(B[name])];
      if (sa && sb) {
        if (sa.path !== sb.path) step.paths = { a: sa.path, b: sb.path };
        for (const k of ['headings', 'labels', 'buttons']) {
          const d = arrDiff(sa[k], sb[k]);
          if (d.onlyA.length || d.onlyB.length) step.content.push({ kind: k, onlyA: d.onlyA, onlyB: d.onlyB });
        }
        if (sa.inputs !== sb.inputs) step.content.push({ kind: 'visible inputs', a: sa.inputs, b: sb.inputs });
        for (const k of new Set([...Object.keys(sa.styles), ...Object.keys(sb.styles)])) {
          if (sa.styles[k] !== sb.styles[k]) step.styles.push({ prop: k, a: sa.styles[k] ?? '(none)', b: sb.styles[k] ?? '(none)' });
        }
      }
      const heightPct = step.heightPct ?? 0;
      const strong = step.pixelPct >= cfg.compare.minorBelowPct || step.styles.length || step.content.length || step.paths || heightPct >= cfg.compare.heightDifferentPct;
      step.verdict = strong ? 'different' : step.pixelPct >= cfg.compare.identicalBelowPct || heightPct >= cfg.compare.heightMinorPct ? 'minor' : 'identical';
    } else {
      step.verdict = 'missing';
    }
    steps.push(step);
  }
  return steps;
}

function factDiffs(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a.facts), ...Object.keys(b.facts)])) {
    const va = a.facts[k], vb = b.facts[k];
    if (JSON.stringify(va) === JSON.stringify(vb)) continue;
    if (k === 'plans offered' && Array.isArray(va) && Array.isArray(vb)) {
      if (va.length !== vb.length) out.push({ key: 'plans offered (count)', a: va.length, b: vb.length });
      for (const pa of va) {
        const pb = vb.find((x) => x.name === pa.name);
        if (!pb) out.push({ key: `plan ${pa.name}`, a: 'offered', b: 'not offered' });
        else if (JSON.stringify(pa.prices) !== JSON.stringify(pb.prices)) out.push({ key: `plan ${pa.name} price`, a: pa.prices.join(' / '), b: pb.prices.join(' / ') });
      }
      for (const pb of vb) if (!va.find((x) => x.name === pb.name)) out.push({ key: `plan ${pb.name}`, a: 'not offered', b: 'offered' });
    } else out.push({ key: k, a: va ?? '(none)', b: vb ?? '(none)' });
  }
  return out;
}

const comparisons = [];
for (const runId of runIds) {
  const byProduct = {};
  for (const [key, results] of runs.get(runId)) {
    const [env, product] = key.split('|');
    (byProduct[product] ??= {})[env] = results;
  }
  for (const [product, perEnv] of Object.entries(byProduct)) {
    const [refEnv, ...others] = envIds.filter((e) => perEnv[e]);
    if (!refEnv || !others.length) continue;
    const otherEnv = others[0];
    // A finished run never changes, so its comparison (and diff images) is computed once and cached.
    const cache = path.join(runsDir, runId, 'compare', product, 'compare.json');
    let comp;
    if (!recompare && fs.existsSync(cache)) {
      comp = JSON.parse(fs.readFileSync(cache, 'utf8'));
    } else {
      const scenarios = [];
      for (const a of perEnv[refEnv]) {
        const b = perEnv[otherEnv].find((x) => x.scenario === a.scenario);
        if (!b) continue;
        const steps = compareShots(runId, product, a.scenario, a, b);
        const facts = factDiffs(a, b);
        const flow = [];
        if (a.status !== b.status) flow.push(`${cfg.environments[refEnv].label} ${a.status}, ${cfg.environments[otherEnv].label} ${b.status}`);
        for (const s of steps) {
          if (s.verdict === 'missing') flow.push(`step "${s.step}" reached only in ${s.inA ? cfg.environments[refEnv].label : cfg.environments[otherEnv].label}`);
          if (s.paths) flow.push(`step "${s.step}" is at ${s.paths.a} vs ${s.paths.b}`);
        }
        if (a.stoppedAt !== b.stoppedAt) flow.push(`ended at "${a.stoppedAt ?? 'failure'}" vs "${b.stoppedAt ?? 'failure'}"`);
        const worstStep = steps.some((s) => s.verdict === 'different') ? 'different' : steps.some((s) => s.verdict === 'minor') ? 'minor' : 'identical';
        const incomplete = a.status !== 'passed' || b.status !== 'passed';
        const overall = incomplete ? 'incomplete' : flow.length || facts.length || worstStep === 'different' ? 'different' : worstStep === 'minor' ? 'minor' : 'identical';
        scenarios.push({ scenario: a.scenario, statusA: a.status, statusB: b.status, errorA: a.error, errorB: b.error, flow, facts, design: steps, designVerdict: worstStep, overall });
      }
      if (!scenarios.length) continue;
      const count = (f) => scenarios.filter(f).length;
      comp = {
        product, productName: cfg.products[product] ?? product, runId,
        startedAt: new Date(Math.min(...perEnv[refEnv].map((r) => Date.parse(r.startedAt)))).toISOString(),
        envA: { id: refEnv, ...cfg.environments[refEnv], baseUrl: perEnv[refEnv][0].baseUrl ?? cfg.environments[refEnv].baseUrl },
        envB: { id: otherEnv, ...cfg.environments[otherEnv], baseUrl: perEnv[otherEnv][0].baseUrl ?? cfg.environments[otherEnv].baseUrl },
        summary: {
          scenarios: scenarios.length,
          identical: count((s) => s.overall === 'identical'),
          minor: count((s) => s.overall === 'minor'),
          different: count((s) => s.overall === 'different'),
          incomplete: count((s) => s.overall === 'incomplete'),
          flowDifferent: count((s) => s.flow.length),
          factsDifferent: count((s) => s.facts.length),
          designDifferent: count((s) => s.designVerdict === 'different'),
          designMinor: count((s) => s.designVerdict === 'minor'),
        },
        scenarios,
        reportPath: `../runs/${runId}/compare/${product}/report.md`,
      };
      fs.mkdirSync(path.dirname(cache), { recursive: true });
      fs.writeFileSync(cache, JSON.stringify(comp));
    }
    if (artifact) for (const sc of comp.scenarios) for (const st of sc.design) st.images = null;
    comparisons.push(comp);

    // written summary report
    const L = [];
    const A = comp.envA.label, B = comp.envB.label;
    L.push(`# ${comp.productName}: ${A} vs ${B}`, '', `Run ${runId}, ${comp.startedAt}`, '', `- ${A}: ${comp.envA.baseUrl}`, `- ${B}: ${comp.envB.baseUrl}`, '');
    L.push(`## Summary`, '', `${comp.summary.scenarios} scenario(s) compared: ${comp.summary.identical} identical, ${comp.summary.minor} minor design differences, ${comp.summary.different} different, ${comp.summary.incomplete} incomplete.`,
      `Flow differences in ${comp.summary.flowDifferent}, data differences (plans, prices, totals) in ${comp.summary.factsDifferent}, design differences in ${comp.summary.designDifferent}.`, '');
    for (const s of comp.scenarios) {
      L.push(`## ${s.scenario}: ${s.overall}`, '');
      if (s.errorA || s.errorB) L.push(`- ${A} error: ${s.errorA ?? 'none'}`, `- ${B} error: ${s.errorB ?? 'none'}`);
      for (const f of s.flow) L.push(`- Flow: ${f}`);
      for (const f of s.facts) L.push(`- Data: ${f.key}: ${A} = ${f.a}; ${B} = ${f.b}`);
      for (const st of s.design) {
        if (st.verdict === 'identical') continue;
        if (st.verdict === 'missing') continue;
        L.push(`- Design, ${st.step}: ${st.pixelPct}% of pixels differ${st.sizeMismatch ? ' (page widths differ)' : ''}${st.heightDiff ? `; page height differs by ${st.heightDiff}px (${st.heightPct}%)` : ''}`);
        for (const c of st.content) L.push(c.kind === 'visible inputs' ? `  - ${c.kind}: ${c.a} vs ${c.b}` : `  - ${c.kind} only in ${A}: ${c.onlyA.join(' | ') || '-'}; only in ${B}: ${c.onlyB.join(' | ') || '-'}`);
        for (const x of st.styles) L.push(`  - style ${x.prop}: ${x.a} vs ${x.b}`);
      }
      L.push('');
    }
    const rf = path.join(runsDir, runId, 'compare', product, 'report.md');
    fs.mkdirSync(path.dirname(rf), { recursive: true });
    fs.writeFileSync(rf, L.join('\n'));
  }
}

for (const p of Object.values(products)) {
  // keep the last N runs per environment and suite
  const keep = [];
  for (const env of envIds) for (const suite of new Set(p.runs.map((r) => r.suite))) keep.push(...p.runs.filter((r) => r.env === env && r.suite === suite).slice(-cfg.historyRuns));
  p.runs = keep.sort((x, y) => x.startedAt.localeCompare(y.startedAt) || x.suite.localeCompare(y.suite));
}
const lineOrder = Object.keys(cfg.lines ?? {});

// ---------- artifact bundling ----------
const published = []; // [publishedPath, sourcePath] for --artifact
for (const p of Object.values(products)) {
  for (const env of envIds) for (const suite of new Set(p.runs.map((r) => r.suite))) {
    const envRuns = p.runs.filter((r) => r.env === env && r.suite === suite);
    const lastRegular = envRuns.map((r) => !r.custom).lastIndexOf(true);
    envRuns.forEach((run, ri) => {
      for (const r of run.results) {
        if (artifact) {
          const latest = ri === envRuns.length - 1 || ri === lastRegular; // only the newest run (and the newest regular run) per environment keeps screenshots
          r.screenshots = latest && !r.sensitive // runs that used a saved test record keep their screenshots local
            ? (run.device === 'mobile' ? (suite === 'catalogue' ? [] : r.shotsRel.slice(-2)) : r.shotsRel).map((rel) => { // phone runs: only the last two screens per scenario, to keep the shared page small
                const pub = `shots/${env}/${suite}${run.device === 'mobile' ? '-phone' : ''}/${r.scenario}/${path.basename(rel)}`; // phone screens get their own folder so they never replace the desktop ones
                published.push([pub, path.join(runsDir, run.runId, rel)]);
                return pub;
              })
            : [];
          r.logPath = null;
        }
        delete r.shotsRel;
        delete r.snapshots; // large, only needed to build the comparison
      }
    });
  }
}

// Marketing tab data (GA4 + Windsor.ai) written by scripts/marketing.mjs. Ad spend and traffic stay local
// unless marketing.config.json sets "shareMarketing": true, so the shared page never carries them by accident.
function loadMarketing() {
  const mc = JSON.parse(fs.readFileSync(path.join(root, 'marketing.config.json'), 'utf8'));
  const f = path.join(root, '.local', 'marketing.json');
  if (artifact && !mc.shareMarketing) return { hidden: true, checks: mc.checks };
  if (!fs.existsSync(f)) return { missing: true, checks: mc.checks };
  return { ...JSON.parse(fs.readFileSync(f, 'utf8')), checks: mc.checks };
}

const data = {
  title: cfg.title,
  generatedAt: new Date().toISOString(),
  slowRunMs: cfg.slowRunMs,
  envs: envIds.map((id) => ({ id, ...cfg.environments[id] })),
  products: Object.values(products).sort((a, b) => (lineOrder.indexOf(a.id) + 1 || 99) - (lineOrder.indexOf(b.id) + 1 || 99)),
  comparisons: comparisons.slice(-20),
  marketing: loadMarketing(),
};

// ---------- page ----------
function html(d) {
  const css = fs.readFileSync(path.join(clientDir, 'style.css'), 'utf8');
  const js = fs.readFileSync(path.join(clientDir, 'app.js'), 'utf8')
    .replace('/*__DATA__*/ null', () => JSON.stringify(d).replace(/</g, '\\u003c'));
  const body = `<div class="wrap">
<header><h1>${d.title}</h1><div class="sub" id="gen"></div></header>
<nav id="tabs" role="tablist"></nav>
<main id="main"></main>
</div>
<div id="drawer-root"></div>
<script>${js}</script>`;
  return artifact
    ? `<title>${d.title}</title>\n<style>${css}</style>\n${body}`
    : `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${d.title}</title>\n<style>${css}</style></head><body>\n${body}</body></html>`;
}

fs.mkdirSync(outDir, { recursive: true });
if (artifact) {
  const files = path.join(outDir, 'artifact-files');
  fs.rmSync(files, { recursive: true, force: true });
  for (const [pub, src] of published) {
    fs.mkdirSync(path.dirname(path.join(files, pub)), { recursive: true });
    fs.copyFileSync(src, path.join(files, pub));
  }
  fs.writeFileSync(path.join(outDir, 'artifact.html'), html(data));
  console.log(`Artifact page: ${path.join(outDir, 'artifact.html')}  (${published.length} screenshot file(s))`);
} else {
  fs.writeFileSync(path.join(outDir, 'data.json'), JSON.stringify(data, null, 2));
  fs.writeFileSync(path.join(outDir, 'index.html'), html(data));
  console.log(`Dashboard: ${path.join(outDir, 'index.html')}  (${data.products.length} product(s), ${runIds.length} run(s), ${comparisons.length} comparison(s))`);
}
