// Sends alerts when a funnel starts failing, recovers, or differs between environments.
//   node scripts/alert.mjs                evaluate the latest runs and send what is due
//   node scripts/alert.mjs --test         send a test message to every enabled channel
//   node scripts/alert.mjs --dry-run      show what would be sent, send nothing, keep state unchanged
// Options: --config <file> --data <file> --state <file>
// Channels and rules live in alerts.config.json; secrets (webhook URLs, SMTP password) come from the
// environment or .env.local, never from the config file.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const abs = (p) => (path.isAbsolute(p) ? p : path.join(root, p));

// .env.local: KEY=VALUE lines; real environment variables win.
const envFile = path.join(root, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env) && m[2] !== '') process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const cfg = JSON.parse(fs.readFileSync(abs(opt('--config', 'alerts.config.json')), 'utf8'));
const dataFile = abs(opt('--data', 'dashboard/data.json'));
const stateFile = abs(opt('--state', 'alerts/state.json'));
const logFile = path.join(path.dirname(stateFile), 'log.jsonl');
const dry = flag('--dry-run');
const rules = cfg.rules;

const hoursSince = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 3_600_000 : Infinity);
// Headline of an error only (Playwright appends long call logs after it).
const firstLine = (s) => (String(s ?? '').replace(/\u001b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim()).find(Boolean) ?? '').slice(0, 140);
const envLabel = (id) => id[0].toUpperCase() + id.slice(1);

// ---------- build messages ----------
function failureLines(run) {
  return run.results.filter((r) => r.status !== 'passed').map((r) => {
    const lastOk = [...r.steps].reverse().find((s) => s.level === 'PASS' && !/^END /.test(s.msg));
    return `${r.scenario}: ${firstLine(r.error) || r.status}${lastOk ? ` (last good step: ${lastOk.msg.slice(0, 70)})` : ''}`;
  });
}

function evaluate(data, state) {
  const messages = [];
  const next = structuredClone(state);
  const links = [cfg.dashboardUrl, cfg.sharedDashboardUrl].filter(Boolean);

  for (const p of data.products) {
    for (const env of rules.environments) {
      const envRuns = p.runs.filter((r) => r.env === env && !(rules.ignoreDashboardRuns && r.custom));
      for (const suite of [...new Set(envRuns.map((r) => r.suite))]) {
      const runs = envRuns.filter((r) => r.suite === suite);
      const last = runs.at(-1);
      const key = `${env}|${p.id}|${suite}`;
      const prev = state[key];
      if (prev?.lastRunId === last.runId) continue; // this run was already evaluated

      const status = last.health; // pass | warn | fail
      const failed = last.results.filter((r) => r.status !== 'passed').length;
      let kind = null;
      if (status === 'fail' && rules.failing && (!prev || prev.status !== 'fail' || hoursSince(prev.lastAlertAt) >= rules.repeatEveryHours)) kind = 'failing';
      else if (status === 'warn' && rules.degraded && prev?.status === 'pass') kind = 'degraded';
      else if (status !== 'fail' && prev?.status === 'fail' && rules.recovered) kind = 'recovered';

      if (kind) {
        const where = `${p.name} (${last.suiteName}) on ${envLabel(env)}`;
        const base = { kind, product: p.id, env, runId: last.runId, links };
        if (kind === 'failing') {
          messages.push({ ...base, severity: 'critical', title: `FAILING: ${where}`,
            lines: [`${failed} of ${last.total} scenario(s) failed in ${last.runId}.`, ...failureLines(last),
              prev?.status === 'fail' ? `Still failing since ${prev.since}.` : 'This is a new failure.'] });
        } else if (kind === 'degraded') {
          messages.push({ ...base, severity: 'warning', title: `DEGRADED: ${where}`,
            lines: [`All scenarios passed in ${last.runId}, but first-party errors were logged.`,
              ...last.results.filter((r) => r.health === 'warn').map((r) => `${r.scenario}: ${r.httpErrors.length} HTTP, ${r.consoleErrors.length} console error(s)`)] });
        } else {
          messages.push({ ...base, severity: 'ok', title: `RECOVERED: ${where}`,
            lines: [`${last.passed} of ${last.total} scenario(s) passed in ${last.runId}${status === 'warn' ? ' (some first-party errors logged)' : ''}.`,
              prev ? `Was failing since ${prev.since}.` : ''].filter(Boolean) });
        }
      }
      next[key] = {
        status,
        since: prev?.status === status ? prev.since : last.startedAt,
        lastAlertAt: kind ? new Date().toISOString() : prev?.lastAlertAt ?? null,
        lastRunId: last.runId,
      };
      }
    }
  }

  // Environment comparison (production vs sandbox) from a normal run; custom-data runs are ignored.
  if (rules.environmentDifferences) {
    const latestByProduct = new Map();
    for (const c of data.comparisons ?? []) latestByProduct.set(c.product, c);
    for (const [product, c] of latestByProduct) {
      const key = `compare|${product}`;
      if (state[key]?.lastRunId === c.runId) continue;
      const p = data.products.find((x) => x.id === product);
      const custom = p?.runs.some((r) => r.runId === c.runId && r.custom);
      next[key] = { lastRunId: c.runId, lastAlertAt: state[key]?.lastAlertAt ?? null };
      if (custom) continue;
      const bad = c.summary.different + c.summary.incomplete;
      if (!bad) continue;
      const lines = [`${bad} of ${c.summary.scenarios} scenario(s) differ or did not complete (${c.envA.label} vs ${c.envB.label}, ${c.runId}).`,
        `Flow differences: ${c.summary.flowDifferent}, data differences: ${c.summary.factsDifferent}, design differences: ${c.summary.designDifferent}.`];
      for (const s of c.scenarios.filter((x) => x.overall === 'different' || x.overall === 'incomplete').slice(0, 5)) {
        const why = s.overall === 'incomplete' ? `did not complete (${c.envA.label} ${s.statusA}, ${c.envB.label} ${s.statusB})` : [...s.flow, ...s.facts.map((f) => `${f.key}: ${f.a} vs ${f.b}`)][0] ?? 'design differs';
        lines.push(`${s.scenario}: ${why}`);
      }
      messages.push({ kind: 'difference', product, env: 'compare', runId: c.runId, severity: 'warning', links: [...links, c.reportPath].filter(Boolean),
        title: `ENVIRONMENTS DIFFER: ${c.productName}`, lines });
      next[key].lastAlertAt = new Date().toISOString();
    }
  }
  return { messages, next };
}

// ---------- channels ----------
const bodyText = (m) => [m.title, '', ...m.lines, '', ...m.links.map((l) => l)].join('\n');
const post = async (url, payload) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
};
const envUrl = (c, name) => {
  const v = process.env[c.urlEnv];
  if (!v) throw new Error(`${c.urlEnv} is not set (add it to .env.local)`);
  return v;
};

const senders = {
  // Banners sent through osascript are attributed to Script Editor and are dropped silently unless it is allowed in
  // System Settings > Notifications. So critical alerts (and tests) also open a dialog window, which needs no permission.
  macos: async (m, c) => {
    if (process.platform !== 'darwin') throw new Error('macOS notifications only work on macOS');
    const text = `${m.lines[0] ?? ''}`.slice(0, 200);
    if (c.notification !== false) {
      await new Promise((resolve, reject) => execFile('osascript', ['-e', `display notification ${JSON.stringify(text)} with title ${JSON.stringify(m.title)} sound name "Basso"`], (e) => (e ? reject(e) : resolve())));
    }
    const mode = c.dialog ?? 'critical'; // critical | always | never
    if (mode === 'always' || (mode === 'critical' && (m.severity === 'critical' || m.kind === 'test'))) {
      const detail = m.lines.slice(0, 4).join('\n').slice(0, 600);
      const kind = m.severity === 'critical' ? 'critical' : 'informational';
      // Detached so a dialog nobody answers never holds up the alert run; gives up after 10 minutes.
      const child = spawn('osascript', ['-e', `display alert ${JSON.stringify(m.title)} message ${JSON.stringify(detail)} as ${kind} giving up after 600`], { detached: true, stdio: 'ignore' });
      child.unref();
    }
  },
  slack: async (m, c) => post(envUrl(c), { text: `*${m.title}*\n${m.lines.map((l) => `• ${l}`).join('\n')}\n${m.links.join('\n')}` }),
  teams: async (m, c) => post(envUrl(c), {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
        body: [
          { type: 'TextBlock', text: m.title, weight: 'Bolder', size: 'Medium', wrap: true, color: m.severity === 'critical' ? 'Attention' : m.severity === 'ok' ? 'Good' : 'Warning' },
          ...m.lines.map((l) => ({ type: 'TextBlock', text: l, wrap: true, spacing: 'Small' })),
        ],
        actions: m.links.filter((l) => /^https?:/.test(l)).map((l) => ({ type: 'Action.OpenUrl', title: 'Open dashboard', url: l })).slice(0, 2),
      },
    }],
  }),
  webhook: async (m, c) => post(envUrl(c), { title: m.title, kind: m.kind, severity: m.severity, product: m.product, environment: m.env, runId: m.runId, lines: m.lines, links: m.links, text: bodyText(m) }),
  email: async (m, c) => {
    if (!c.to?.length) throw new Error('alerts.config.json: channels.email.to is empty');
    const host = process.env[c.smtp.hostEnv];
    if (!host) throw new Error(`${c.smtp.hostEnv} is not set (add it to .env.local)`);
    const { default: nodemailer } = await import('nodemailer');
    const t = nodemailer.createTransport({ host, port: Number(process.env[c.smtp.portEnv] ?? 587), secure: !!c.smtp.secure,
      auth: process.env[c.smtp.userEnv] ? { user: process.env[c.smtp.userEnv], pass: process.env[c.smtp.passEnv] } : undefined });
    await t.sendMail({ from: c.from, to: c.to.join(','), subject: `[Funnel monitor] ${m.title}`, text: bodyText(m) });
  },
};

async function deliver(m) {
  const results = [];
  for (const [name, c] of Object.entries(cfg.channels)) {
    if (!c.enabled) continue;
    if (dry) { results.push({ channel: name, ok: true, dry: true }); continue; }
    try { await senders[name](m, c); results.push({ channel: name, ok: true }); }
    catch (e) { results.push({ channel: name, ok: false, error: e.message }); }
  }
  return results;
}

// ---------- readiness ----------
function missingConfig(name, c) {
  const miss = [];
  if (['teams', 'slack', 'webhook'].includes(name) && !process.env[c.urlEnv]) miss.push(`${c.urlEnv} (webhook URL) in .env.local`);
  if (name === 'email') {
    if (!c.to?.length) miss.push('recipients: channels.email.to in alerts.config.json');
    if (!c.from || /example\.com$/.test(c.from)) miss.push('sender address: channels.email.from in alerts.config.json');
    if (!process.env[c.smtp.hostEnv]) miss.push(`${c.smtp.hostEnv} (SMTP server) in .env.local`);
  }
  return miss;
}

if (flag('--check')) {
  let notReady = 0;
  for (const [name, c] of Object.entries(cfg.channels)) {
    if (!c.enabled) { console.log(`${name.padEnd(8)} off`); continue; }
    const miss = missingConfig(name, c);
    if (miss.length) notReady++;
    console.log(`${name.padEnd(8)} ${miss.length ? 'NOT READY, missing: ' + miss.join('; ') : 'ready'}`);
  }
  process.exit(notReady ? 1 : 0);
}

// ---------- main ----------
const enabled = Object.entries(cfg.channels).filter(([, c]) => c.enabled).map(([n]) => n);
if (!enabled.length) console.log('No alert channels are enabled in alerts.config.json.');

let messages, next = null;
if (flag('--test')) {
  messages = [{ kind: 'test', severity: 'ok', env: 'test', product: 'test', runId: '-', links: [cfg.dashboardUrl].filter(Boolean),
    title: 'TEST: funnel monitor alerts are working', lines: ['This is a test message. No funnel problem was detected.'] }];
} else {
  if (!fs.existsSync(dataFile)) { console.error(`No dashboard data at ${dataFile}. Run: npm run dashboard`); process.exit(1); }
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  ({ messages, next } = evaluate(data, state));
}

let failures = 0;
for (const m of messages) {
  const results = await deliver(m);
  console.log(`${dry ? '[dry run] ' : ''}${m.title}\n  ${m.lines.join('\n  ')}\n  -> ${results.map((r) => `${r.channel}:${r.ok ? (r.dry ? 'would send' : 'sent') : 'FAILED (' + r.error + ')'}`).join(', ') || 'no channel enabled'}`);
  failures += results.filter((r) => !r.ok).length;
  if (!dry) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), kind: m.kind, title: m.title, runId: m.runId, results }) + '\n');
  }
}
if (!messages.length) console.log('No alerts due.');
if (next && !dry) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(next, null, 2));
}
process.exit(failures ? 2 : 0);
