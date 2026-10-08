// Local control panel: serves the dashboard and starts test runs on demand.
//   npm run serve   ->  http://127.0.0.1:4317
// Binds to localhost only. Products come from tests/<product>/product.json; every submitted
// value is validated against that manifest and never reaches a shell.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile, execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT ?? 4317);
const HOST = '127.0.0.1';
// Debug mode: `npm run serve:debug` (or DEBUG_MODE=1). Logs every request and test run to the console and to
// logs/server-debug.log, passes Playwright's browser-launch logging through, and enables GET /api/debug (diagnostics, no secrets).
const DEBUG = process.env.DEBUG_MODE === '1' || process.argv.includes('--debug');
const DEBUG_LOG = path.join(root, 'logs', 'server-debug.log');
const debugTail = [];
function dbg(...a) {
  if (!DEBUG) return;
  const line = `${new Date().toISOString()} ${a.join(' ')}`;
  console.log('[debug]', line);
  debugTail.push(line); if (debugTail.length > 300) debugTail.shift();
  try { fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true }); fs.appendFileSync(DEBUG_LOG, line + '\n'); } catch { /* console copy is enough */ }
}
function diagnostics() {
  const sh = (cmd, args) => { try { return execFileSync(cmd, args, { cwd: root, timeout: 5000 }).toString().trim(); } catch (e) { return 'unavailable: ' + String(e.message).split('\n')[0]; } };
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  const chromePath = process.platform === 'linux' ? '/opt/google/chrome/chrome' : process.platform === 'darwin' ? '/Applications/Google Chrome.app' : null;
  let installed = []; try { installed = fs.readdirSync(cache); } catch { /* none */ }
  const pw = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@playwright/test/package.json'), 'utf8')).version; } catch { return 'not installed'; } })();
  const chrome = chromePath ? fs.existsSync(chromePath) : null;
  const channel = process.env.BROWSER_CHANNEL ?? (process.platform === 'linux' && !chrome ? 'chromium (bundled)' : 'chrome');
  const bundled = installed.some((d) => /^chromium/.test(d));
  const problems = [];
  if (channel === 'chrome' && !chrome) problems.push('Config asks for Google Chrome but it is not installed. Pull the commit "Fall back to bundled Chromium", or install Chrome.');
  if (/chromium/.test(channel) && !bundled) problems.push('Bundled Chromium is not installed. Run: npx playwright install --with-deps chromium');
  if (pw === 'not installed') problems.push('node_modules is missing. Run: npm ci');
  return {
    time: new Date().toISOString(), commit: sh('git', ['rev-parse', '--short', 'HEAD']), branch: sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']), uncommitted: sh('git', ['status', '--short']).split('\n').filter(Boolean).length,
    platform: `${process.platform} ${process.arch} ${os.release()}`, node: process.version, playwright: pw, cwd: root, host: `${HOST}:${PORT}`,
    browser: { channelUsed: channel, googleChromeInstalled: chrome, playwrightCache: cache, installedBrowsers: installed, bundledChromiumInstalled: bundled },
    envSet: Object.keys(process.env).filter((k) => /^(ENV_URL_|BROWSER_CHANNEL|PLAYWRIGHT_|HOST$|PORT$|VIEWPORT)/.test(k)),
    targets: Object.fromEntries(Object.keys(cfg.environments).map((id) => [id, envUrl(id)])),
    problems, recentLog: debugTail.slice(-60),
  };
}
const PLAYWRIGHT = path.join(root, 'node_modules', '.bin', 'playwright');
const SECRETS_FILE = path.join(root, '.local', 'secrets.json');
const readSecrets = () => { try { return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')); } catch { return {}; } };
function writeSecrets(all) {
  fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.chmodSync(SECRETS_FILE, 0o600);
}
const mask = (v) => (v.length <= 4 ? '\u2022'.repeat(v.length) : '\u2022\u2022\u2022\u2022' + v.slice(-4));
// What the page may know about a saved record: that it exists, and a masked hint. Never the values.
function secretStatus() {
  const all = readSecrets();
  return manifests().filter((m) => m.secretFields).map((m) => {
    const rec = all[m.id];
    return { product: m.id, saved: !!rec, savedAt: rec?.__savedAt ?? null,
      summary: rec ? m.secretFields.map((f) => (f.type === 'password' ? mask(String(rec[f.key] ?? '')) : rec[f.key])).join(' / ') : null };
  });
}

const MAX_RUN_MS = 40 * 60_000;
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'monitor.config.json'), 'utf8'));
const envUrl = (id) => process.env[`ENV_URL_${id.toUpperCase()}`] ?? cfg.environments[id].baseUrl;

// Fail fast if an environment cannot be reached (e.g. the sandbox needs a VPN), instead of timing out mid-run.
async function reachable(id) {
  try { await fetch(envUrl(id), { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000) }); return true; }
  catch { return false; }
}

// ---------- products ----------
function manifests() {
  const dir = path.join(root, 'tests');
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'product.json')))
    .map((d) => JSON.parse(fs.readFileSync(path.join(dir, d.name, 'product.json'), 'utf8')));
}

// ---------- validation ----------
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function checkField(f, raw, errs, ctx) {
  if (f.type === 'select') {
    if (!f.options.includes(raw)) errs.push(`${ctx}${f.label}: choose one of the listed options`);
    return raw;
  }
  if (f.type === 'number') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < f.min || n > f.max) errs.push(`${ctx}${f.label}: whole number from ${f.min} to ${f.max}`);
    return n;
  }
  let s = String(raw ?? '').trim();
  if (f.transform === 'upper') s = s.toUpperCase();
  if (!new RegExp(f.pattern).test(s)) errs.push(`${ctx}${f.label}: format not accepted`);
  return s;
}

function ageFromNric(nric, today = new Date()) {
  const yy = Number(nric.slice(0, 2)), mm = Number(nric.slice(2, 4)), dd = Number(nric.slice(4, 6));
  const year = (yy > today.getFullYear() % 100 ? 1900 : 2000) + yy;
  const dob = new Date(year, mm - 1, dd);
  if (dob.getMonth() !== mm - 1 || dob.getDate() !== dd) return NaN;
  let age = today.getFullYear() - year;
  if (today.getMonth() + 1 < mm || (today.getMonth() + 1 === mm && today.getDate() < dd)) age--;
  return age;
}

function validate(m, body) {
  const errs = [];
  const scenarios = [];
  if (!Array.isArray(body.scenarios) || !body.scenarios.length || body.scenarios.length > m.maxScenarios) {
    errs.push(`Choose between 1 and ${m.maxScenarios} scenarios`);
  } else {
    body.scenarios.forEach((s, i) => {
      const out = {};
      for (const f of m.scenarioFields) {
        const w = f.ignoredWhen; // e.g. ID/plate are ignored when the scenario uses the saved test record
        if (w && String(s?.[w.key] ?? '').startsWith(w.startsWith)) { out[f.key] = ''; continue; }
        out[f.key] = checkField(f, s?.[f.key], errs, `Scenario ${i + 1} - `);
      }
      const req = m.secretsRequiredWhen;
      if (req && String(out[req.key] ?? '').startsWith(req.startsWith) && !readSecrets()[m.id]) {
        errs.push(`Scenario ${i + 1} - save a test record first (Saved test record panel above)`);
      }
      for (const lim of m.limits ?? []) {
        if (out[lim.whenKey] === lim.whenValue && out[lim.field] > lim.max) errs.push(`Scenario ${i + 1} - ${lim.message}`);
      }
      const from = m.scenarioIdFrom ?? ['country', 'purpose']; // which fields name a scenario, e.g. scenario-2-japan-business
      const parts = [`scenario-${i + 1}`, ...from.map((k) => m.scenarioIdShort?.[out[k]] ?? slug(out[k] ?? ''))].filter(Boolean);
      out.id = parts.join('-');
      scenarios.push(out);
    });
  }
  const groups = {};
  for (const f of m.participantFields ?? []) {
    (groups[f.group ?? 'participant'] ??= {})[f.key] = checkField(f, body.participant?.[f.key], errs, '');
  }
  const nric = groups.participant?.nric;
  if (nric && /^[0-9]{12}$/.test(nric)) {
    const age = ageFromNric(nric);
    if (Number.isNaN(age)) errs.push('NRIC: the first six digits are not a valid birth date');
    else if (age < 18 || age > 60) errs.push(`NRIC: participant is ${age}; must be 18-60`);
  }
  return { errs, overrides: { scenarios, ...groups } };
}

// ---------- run control ----------
const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `run-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
let current = null; // { runId, product, planned, state, startedAt, endedAt, exitCode, log[] }

// Rebuilds the dashboard without blocking the server (a comparison with many images can take a few seconds).
function rebuild() {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(root, 'scripts', 'build-dashboard.mjs')], { cwd: root }, (err) => {
      if (err) console.error('dashboard rebuild failed:', err.message);
      resolve();
    });
  });
}

function startRun(m, overrides, envs) {
  const runId = stamp();
  const dir = path.join(root, 'runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'overrides.json');
  fs.writeFileSync(file, JSON.stringify(overrides, null, 2));

  current = {
    runId, product: m.id, envs, planned: overrides.scenarios.map((s) => s.id),
    state: 'running', startedAt: new Date().toISOString(), endedAt: null, exitCode: null, log: [],
  };
  const child = spawn(PLAYWRIGHT, ['test', `tests/${m.id}`], {
    cwd: root,
    env: { ...process.env, ...(DEBUG ? { DEBUG: 'pw:browser' } : {}), RUN_ID: runId, RUN_TRIGGER: 'dashboard', RUN_OVERRIDES: file, TARGET_ENVS: envs.join(','), FORCE_COLOR: '0' },
  });
  dbg('run start', runId, m.id, envs.join(','), 'pid=' + child.pid);
  child.on('error', (e) => dbg('run spawn error', runId, e.message));
  const push = (buf) => {
    if (DEBUG) for (const l of buf.toString().split('\n')) if (l.trim()) dbg('run', runId, l.slice(0, 400));
    for (const line of buf.toString().replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').split('\n')) {
      if (line.trim()) current.log.push(line.slice(0, 300));
    }
    if (current.log.length > 300) current.log.splice(0, current.log.length - 300);
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  const killer = setTimeout(() => child.kill('SIGTERM'), MAX_RUN_MS);
  child.on('close', async (code, sig) => {
    dbg('run end', runId, 'exit=' + code, sig ? 'signal=' + sig : '');
    clearTimeout(killer);
    await rebuild(); // results and comparison are ready before the page is told the run finished
    current.exitCode = code;
    current.state = code === 0 ? 'done' : 'failed';
    current.endedAt = new Date().toISOString();
  });
  return runId;
}

function progress() {
  if (!current) return { state: 'idle' };
  const results = [];
  for (const env of current.envs) {
    const pDir = path.join(root, 'runs', current.runId, env, current.product);
    if (!fs.existsSync(pDir)) continue;
    for (const sc of fs.readdirSync(pDir)) {
      const f = path.join(pDir, sc, 'result.json');
      if (!fs.existsSync(f)) continue;
      const r = JSON.parse(fs.readFileSync(f, 'utf8'));
      results.push({ env, scenario: r.scenario, status: r.status, durationMs: r.durationMs });
    }
  }
  return { ...current, results };
}

// ---------- http ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.log': 'text/plain; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const sendJson = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const hostOk = (h) => h === `${HOST}:${PORT}` || h === `localhost:${PORT}`;

const server = http.createServer((req, res) => {
  // Reject foreign Host headers (DNS rebinding) and cross-site POSTs.
  if (!hostOk(req.headers.host ?? '')) { dbg('REFUSED host', req.headers.host); return sendJson(res, 403, { error: 'forbidden host' }); }
  const url = new URL(req.url, `http://${req.headers.host}`);
  dbg('req', req.method, url.pathname, 'host=' + req.headers.host, 'from=' + req.socket.remoteAddress);

  if (url.pathname === '/api/debug') return DEBUG ? sendJson(res, 200, diagnostics()) : sendJson(res, 404, { error: 'debug mode is off. Start the server with: npm run serve:debug' });
  if (req.method === 'GET' && url.pathname === '/api/products') return sendJson(res, 200, manifests());
  if (req.method === 'GET' && url.pathname === '/api/secrets') return sendJson(res, 200, secretStatus());

  const sm = url.pathname.match(/^\/api\/secrets\/([a-z0-9-]+)$/);
  if (sm && (req.method === 'PUT' || req.method === 'DELETE')) {
    const origin = req.headers.origin;
    if (origin && !hostOk(new URL(origin).host)) return sendJson(res, 403, { error: 'cross-site request refused' });
    const m = manifests().find((x) => x.id === sm[1] && x.secretFields);
    if (!m) return sendJson(res, 404, { errors: ['Unknown product'] });
    if (req.method === 'DELETE') {
      const all = readSecrets(); delete all[m.id]; writeSecrets(all);
      return sendJson(res, 200, secretStatus());
    }
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 4_000) req.destroy(); else chunks.push(c); });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return sendJson(res, 400, { errors: ['Request body is not valid JSON'] }); }
      const errs = []; const rec = {};
      for (const f of m.secretFields) rec[f.key] = checkField(f, body?.[f.key], errs, '');
      if (errs.length) return sendJson(res, 400, { errors: errs });
      const all = readSecrets();
      all[m.id] = { ...rec, __savedAt: new Date().toISOString() };
      writeSecrets(all);
      sendJson(res, 200, secretStatus());
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/envs') {
    return sendJson(res, 200, Object.entries(cfg.environments).map(([id, e]) => ({ id, label: e.label, baseUrl: envUrl(id) })));
  }
  if (req.method === 'GET' && url.pathname === '/api/runs/current') return sendJson(res, 200, progress());

  if (req.method === 'POST' && url.pathname === '/api/runs') {
    const origin = req.headers.origin;
    if (origin && !hostOk(new URL(origin).host)) return sendJson(res, 403, { error: 'cross-site request refused' });
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 64_000) req.destroy(); else chunks.push(c); });
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return sendJson(res, 400, { errors: ['Request body is not valid JSON'] }); }
      const m = manifests().find((x) => x.id === body.product);
      if (!m) return sendJson(res, 400, { errors: ['Unknown product'] });
      if (current?.state === 'running') return sendJson(res, 409, { errors: ['A test run is already in progress'], runId: current.runId });
      const { errs, overrides } = validate(m, body);
      const envs = body.envs ?? ['production'];
      if (!Array.isArray(envs) || !envs.length || envs.some((e) => !cfg.environments[e])) errs.push('Choose a known environment');
      if (errs.length) return sendJson(res, 400, { errors: errs });
      for (const id of envs) {
        if (!(await reachable(id))) {
          return sendJson(res, 400, { errors: [`${cfg.environments[id].label} (${envUrl(id)}) is not reachable from this machine. Check your VPN or network access, then try again.`] });
        }
      }
      sendJson(res, 202, { runId: startRun(m, overrides, envs) });
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/marketing/refresh') {
    const origin = req.headers.origin;
    if (origin && !hostOk(new URL(origin).host)) return sendJson(res, 403, { error: 'cross-site request refused' });
    const q = new URL(req.url, 'http://x').searchParams;
    const args = ['scripts/marketing.mjs', ...(q.get('sample') === '1' ? ['--sample'] : [])];
    execFile(process.execPath, args, { cwd: root, timeout: 90_000 }, (err, out, errOut) => {
      if (err) return sendJson(res, 500, { error: String(errOut || err.message).slice(0, 300) });
      execFile(process.execPath, ['scripts/build-dashboard.mjs'], { cwd: root, timeout: 90_000 }, (e2) => sendJson(res, e2 ? 500 : 200, { ok: !e2, log: out.trim() }));
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') { res.writeHead(302, { location: '/dashboard/index.html' }); return res.end(); }
  if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }

  if (req.method === 'GET') {
    const rel = decodeURIComponent(url.pathname);
    const file = path.normalize(path.join(root, rel));
    const allowed = ['dashboard', 'runs'].some((d) => file.startsWith(path.join(root, d) + path.sep));
    if (!allowed || file.includes('artifact-files') || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(405); res.end();
});

server.listen(PORT, HOST, () => {
  console.log(`IKHLAS Funnel Monitor: http://${HOST}:${PORT}   (Ctrl+C to stop)${DEBUG ? '   DEBUG MODE ON -> /api/debug, logs/server-debug.log' : ''}`);
  dbg('server start', JSON.stringify({ node: process.version, platform: process.platform }));
  rebuild();
});
