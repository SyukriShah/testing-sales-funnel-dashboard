import fs from 'node:fs';
import path from 'node:path';

/**
 * Per-product saved test records (company-owned IDs/vehicles), entered through the dashboard's
 * Run tests tab and kept only in .local/secrets.json (git-ignored, mode 600).
 */
const FILE = path.resolve('.local', 'secrets.json');

function readAll(): Record<string, Record<string, string>> {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

export function loadSecret(product: string): Record<string, string> | undefined {
  const s = readAll()[product];
  return s && Object.keys(s).length ? s : undefined;
}

/** Every saved value, so logs, errors and results can be scrubbed of them. */
export function allSecretValues(): string[] {
  const labels = /^(NRIC|Passport|Police\/Army|Business)$/i; // ID type names are not secret and appear in normal logs
  return Object.values(readAll()).flatMap((o) => Object.values(o)).filter((v) => typeof v === 'string' && v.length >= 3 && !labels.test(v));
}
