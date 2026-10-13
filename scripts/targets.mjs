// Custom test targets: another URL (new funnel, sandbox build, partner site, same product with a different agent code)
// that is tested with the same dummy data and compared with the latest Production results.
// Stored locally in .local/targets.json (never committed, never put on the shared page: URLs and agent codes stay private).
import fs from 'node:fs';
import path from 'node:path';

const file = (root) => path.join(root, '.local', 'targets.json');

export function loadTargets(root) {
  try { return JSON.parse(fs.readFileSync(file(root), 'utf8')); } catch { return []; }
}
export function saveTargets(root, list) {
  fs.mkdirSync(path.dirname(file(root)), { recursive: true });
  fs.writeFileSync(file(root), JSON.stringify(list, null, 2), { mode: 0o600 });
}

/** pasted URL + optional extra query parameters (agent=ABC123&src=x) -> { baseUrl: origin, entry: path?query } or { error } */
export function parseTarget(urlText, extra = '') {
  let u;
  try { u = new URL(String(urlText).trim()); } catch { return { error: 'That is not a valid web address. Paste the full link, starting with https://' }; }
  if (!/^https?:$/.test(u.protocol)) return { error: 'Only http:// and https:// addresses can be tested.' };
  if (u.username || u.password) return { error: 'Remove the user name and password from the address.' };
  if (String(urlText).length > 400) return { error: 'The address is too long.' };
  const ex = String(extra ?? '').trim().replace(/^[?&]/, '');
  if (ex) {
    if (!/^[\w.~%-]+=[\w.~%+@:/-]*(&[\w.~%-]+=[\w.~%+@:/-]*)*$/.test(ex)) return { error: 'Extra parameters must look like agent=ABC123 (several can be joined with &).' };
    for (const [k, v] of new URLSearchParams(ex)) u.searchParams.set(k, v);
  }
  u.hash = '';
  const entry = (u.pathname || '/') + u.search;
  return { baseUrl: u.origin, entry: entry === '' ? '/' : entry };
}

/** monitor.config.json environments plus the saved targets (each target becomes an environment id like t-partner-a) */
export function allEnvironments(cfg, root) {
  const out = { ...cfg.environments };
  for (const t of loadTargets(root)) {
    const p = parseTarget(t.url, t.extra);
    if (p.error) continue;
    out[t.id] = { label: t.label, baseUrl: p.baseUrl, entry: p.entry, custom: true, note: t.note ?? '' };
  }
  return out;
}
