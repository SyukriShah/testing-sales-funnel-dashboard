// Builds a static copy of the dashboard that any web server can host: dashboard/site/index.html + shots/.
// Same content as the shared link (no saved-record screenshots, no Run tests). Usage: npm run export
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
execFileSync('node', [path.join(root, 'scripts/build-dashboard.mjs'), '--artifact'], { stdio: 'inherit' });

const dash = path.join(root, 'dashboard');
const site = path.join(dash, 'site');
fs.rmSync(site, { recursive: true, force: true });
fs.mkdirSync(site, { recursive: true });
const page = fs.readFileSync(path.join(dash, 'artifact.html'), 'utf8');
const doc = /<!doctype/i.test(page) ? page
  : `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>\n${page}\n</body></html>`;
fs.writeFileSync(path.join(site, 'index.html'), doc);
fs.cpSync(path.join(dash, 'artifact-files', 'shots'), path.join(site, 'shots'), { recursive: true });
console.log(`Static site: ${site}  (index.html + shots/). Upload the folder to an internal web server.`);
