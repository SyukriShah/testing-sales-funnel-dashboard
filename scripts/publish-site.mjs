// Rebuilds the static site and copies it to where it is hosted.
//   SITE_TARGET=/path/to/web/root        npm run publish:site     (a folder, mounted share or web root)
//   SITE_TARGET=user@host:/var/www/funnel npm run publish:site     (copied with rsync over ssh)
// With no SITE_TARGET it only rebuilds dashboard/site/.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
execFileSync('node', [path.join(root, 'scripts/export-site.mjs')], { stdio: 'inherit' });

const target = process.env.SITE_TARGET;
if (!target) { console.log('SITE_TARGET is not set, so nothing was copied. Static site is in dashboard/site/.'); process.exit(0); }
const site = path.join(root, 'dashboard/site') + '/';
// --delete removes screenshots that are no longer part of the dashboard, so old data does not stay on the server
execFileSync('rsync', ['-a', '--delete', site, target.endsWith('/') ? target : target + '/'], { stdio: 'inherit' });
console.log(`Published to ${target}`);
