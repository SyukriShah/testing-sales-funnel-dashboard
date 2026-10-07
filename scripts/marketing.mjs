// Pulls genuine-traffic numbers for the dashboard's Marketing tab and writes .local/marketing.json.
//   node scripts/marketing.mjs            -> GA4 Data API + Windsor.ai API (whichever is configured)
//   node scripts/marketing.mjs --sample   -> made-up numbers, only to preview the tab (clearly labelled in the page)
// Read-only. Credentials come from .env.local / the environment, never from marketing.config.json:
//   GA4_CREDENTIALS_FILE=/path/to/service-account.json   (the account needs Viewer on the GA4 property)
//   WINDSOR_API_KEY=...
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'marketing.config.json'), 'utf8'));
const outFile = path.join(root, '.local', 'marketing.json');

const envFile = path.join(root, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env) && m[2] !== '') process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const day = (d) => d.toISOString().slice(0, 10);
const to = new Date(); to.setUTCDate(to.getUTCDate() - 1); // yesterday: today is still incomplete
const from = new Date(to); from.setUTCDate(from.getUTCDate() - (cfg.days - 1));
const range = { from: day(from), to: day(to) };
const scrub = (s) => String(s).replace(/api_key=[^&\s"]+/gi, 'api_key=***').replace(/Bearer\s+[\w.-]+/g, 'Bearer ***').slice(0, 300);

// ---------- GA4 Data API ----------
async function ga4Token(creds) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const claims = b64({ iss: creds.client_email, scope: 'https://www.googleapis.com/auth/analytics.readonly', aud: creds.token_uri ?? 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3000 });
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(creds.private_key, 'base64url');
  const r = await fetch(creds.token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Google sign-in failed: ' + scrub(j.error_description ?? j.error ?? r.status));
  return j.access_token;
}

async function ga4() {
  const g = cfg.ga4;
  const file = process.env[g.credentialsFileEnv];
  if (!g.propertyId) return { status: 'not-configured', message: 'Set ga4.propertyId in marketing.config.json.' };
  if (!file) return { status: 'not-configured', message: `Set ${g.credentialsFileEnv} in .env.local to the service-account JSON file.` };
  const token = await ga4Token(JSON.parse(fs.readFileSync(file, 'utf8')));
  const run = async (body) => {
    const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${g.propertyId}:runReport`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ dateRanges: [{ startDate: range.from, endDate: range.to }], limit: 10000, ...body }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(scrub(j.error?.message ?? r.status));
    return (j.rows ?? []).map((row) => [...row.dimensionValues.map((v) => v.value), ...row.metricValues.map((v) => Number(v.value))]);
  };
  const iso = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  const daily = (await run({ dimensions: [{ name: 'date' }, { name: 'deviceCategory' }], metrics: [{ name: 'sessions' }, { name: 'totalUsers' }] }))
    .map(([d, device, sessions, users]) => ({ date: iso(d), device, sessions, users }));
  const sources = (await run({ dimensions: [{ name: 'sessionSourceMedium' }], metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 15 }))
    .map(([source, sessions, engaged]) => ({ source, sessions, engaged }));
  const notes = [];
  const evFilter = { filter: { fieldName: 'eventName', inListFilter: { values: g.events } } };
  let events;
  try { // the full breakdown needs product / step_name registered as custom dimensions in GA4
    events = (await run({ dimensions: [{ name: 'date' }, { name: 'eventName' }, { name: g.productDimension }, { name: g.stepDimension }, { name: 'deviceCategory' }], metrics: [{ name: 'eventCount' }], dimensionFilter: evFilter }))
      .map(([d, event, product, step, device, count]) => ({ date: iso(d), event, product, step, device, count }));
  } catch (e) {
    notes.push('Events by product and step are not available yet: ' + scrub(e.message) + ' Register product and step_name as custom dimensions in GA4 (Admin > Custom definitions).');
    events = (await run({ dimensions: [{ name: 'date' }, { name: 'eventName' }, { name: 'deviceCategory' }], metrics: [{ name: 'eventCount' }], dimensionFilter: evFilter }))
      .map(([d, event, device, count]) => ({ date: iso(d), event, product: '(not set)', step: '(not set)', device, count }));
  }
  if (!events.length) notes.push('GA4 returned no funnel events yet. The web team still needs to send them (see the event list in the README).');
  return { status: 'ok', message: notes.join(' ') || 'Connected.', daily, sources, events };
}

// ---------- Windsor.ai API ----------
async function windsor() {
  const w = cfg.windsor;
  const key = process.env[w.apiKeyEnv];
  if (!key) return { status: 'not-configured', message: `Set ${w.apiKeyEnv} in .env.local (Windsor.ai > Settings > API key).` };
  const u = new URL(`https://connectors.windsor.ai/${w.connector}`);
  u.search = new URLSearchParams({ api_key: key, date_from: range.from, date_to: range.to, fields: w.fields.join(',') }).toString();
  const r = await fetch(u);
  const txt = await r.text();
  if (!r.ok) throw new Error(scrub(`HTTP ${r.status} ${txt}`));
  const j = JSON.parse(txt);
  const rows = Array.isArray(j) ? j : j.data ?? [];
  const n = (v) => Number(v) || 0;
  const byDate = new Map(); const byCamp = new Map();
  for (const x of rows) {
    const d = byDate.get(x.date) ?? { date: x.date, spend: 0, clicks: 0, impressions: 0 };
    d.spend += n(x.spend); d.clicks += n(x.clicks); d.impressions += n(x.impressions); byDate.set(x.date, d);
    const k = `${x.source ?? ''}|${x.campaign ?? ''}`;
    const c = byCamp.get(k) ?? { source: x.source ?? '', campaign: x.campaign ?? '', spend: 0, clicks: 0, impressions: 0 };
    c.spend += n(x.spend); c.clicks += n(x.clicks); c.impressions += n(x.impressions); byCamp.set(k, c);
  }
  return {
    status: 'ok', message: rows.length ? 'Connected.' : 'Windsor.ai returned no rows for this period. Check that connectors are linked in Windsor.',
    daily: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    campaigns: [...byCamp.values()].sort((a, b) => b.spend - a.spend).slice(0, 25),
  };
}

// ---------- sample data (preview only) ----------
function sample() {
  const products = ['car', 'motorcycle', 'travel', 'home', 'personal-accident', 'health', 'hibah'];
  const days = []; for (let i = 0; i < cfg.days; i++) { const d = new Date(from); d.setUTCDate(d.getUTCDate() + i); days.push(day(d)); }
  const wob = (i, s) => 1 + 0.15 * Math.sin(i * 1.3 + s);
  const daily = days.flatMap((date, i) => [['desktop', 520], ['mobile', 860]].map(([device, b]) => ({ date, device, sessions: Math.round((i > cfg.days - 3 ? b * 0.45 : b) * wob(i, b)), users: Math.round(b * 0.8 * wob(i, b)) })));
  const events = days.flatMap((date, i) => products.flatMap((product, pi) => ['desktop', 'mobile'].flatMap((device) => {
    const base = Math.round((60 - pi * 6) * (device === 'mobile' ? 1.6 : 1) * wob(i, pi));
    return [['funnel_start', base], ['funnel_step', Math.round(base * 2.4)], ['plan_select', Math.round(base * 0.62)], ['summary_view', Math.round(base * (device === 'mobile' ? 0.28 : 0.4))], ['pay_click', Math.round(base * 0.1)]]
      .map(([event, count]) => ({ date, event, product, step: event === 'funnel_step' ? 'participant_details' : '(not set)', device, count }));
  })));
  return {
    sample: true,
    ga4: { status: 'ok', message: 'SAMPLE DATA, not real.', daily, events, sources: [['google / organic', 5200], ['(direct) / (none)', 3900], ['facebook / paid', 2100], ['google / cpc', 1800], ['newsletter / email', 640]].map(([source, sessions]) => ({ source, sessions, engaged: Math.round(sessions * 0.6) })) },
    windsor: { status: 'ok', message: 'SAMPLE DATA, not real.', daily: days.map((date, i) => ({ date, spend: Math.round(900 * wob(i, 2)), clicks: Math.round(1300 * wob(i, 3)), impressions: Math.round(60000 * wob(i, 4)) })),
      campaigns: [['google_ads', 'Travel Raya'], ['facebook', 'Motor renewal'], ['google_ads', 'Basic Term brand'], ['tiktok', 'HIB awareness']].map(([source, campaign], i) => ({ source, campaign, spend: 9000 - i * 1800, clicks: 12000 - i * 2500, impressions: 480000 - i * 90000 })) },
  };
}

const settle = async (fn) => { try { return await fn(); } catch (e) { return { status: 'error', message: scrub(e.message ?? e) }; } };
const out = process.argv.includes('--sample')
  ? sample()
  : { sample: false, ga4: await settle(ga4), windsor: await settle(windsor) };
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), range, ...out }, null, 2), { mode: 0o600 });
for (const k of ['ga4', 'windsor']) console.log(`${k}: ${out[k].status} - ${out[k].message}`);
console.log(`Wrote ${path.relative(root, outFile)}`);
