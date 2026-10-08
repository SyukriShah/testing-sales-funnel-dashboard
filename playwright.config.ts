import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';

// One folder per run: runs/<RUN_ID>/. Set on first load in the main process so
// workers (which re-load this file) inherit the same value through the env.
function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `run-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
process.env.RUN_ID ??= stamp();
const runDir = `runs/${process.env.RUN_ID}`;

// Environments come from monitor.config.json. TARGET_ENVS (comma list) picks which to run:
// default production only; "production,sandbox" runs both for a comparison.
// ENV_URL_<ID> (e.g. ENV_URL_SANDBOX) overrides an environment's base URL.
const cfg = JSON.parse(fs.readFileSync('monitor.config.json', 'utf8'));
const wanted = (process.env.TARGET_ENVS ?? 'production').split(',').map((s) => s.trim()).filter(Boolean);
const envs = wanted.map((id) => {
  const e = cfg.environments[id];
  if (!e) throw new Error(`Unknown environment "${id}". Known: ${Object.keys(cfg.environments).join(', ')}`);
  return { id, baseURL: process.env[`ENV_URL_${id.toUpperCase()}`] ?? e.baseUrl };
});

// VIEWPORT=mobile runs every test in a phone-sized Chrome (Pixel 7); anything else is the desktop browser.
// Google Chrome where it is installed (this Mac); otherwise Playwright's own Chromium (Linux servers, CI, containers).
// Override with BROWSER_CHANNEL=chrome|msedge, or BROWSER_CHANNEL=chromium to force the bundled browser.
const chromeInstalled = process.platform === 'darwin' || process.platform === 'win32' || fs.existsSync('/opt/google/chrome/chrome');
const browserPick = process.env.BROWSER_CHANNEL ?? (chromeInstalled ? 'chrome' : 'chromium');
const channel = browserPick === 'chromium' ? undefined : browserPick;
const device = process.env.VIEWPORT === 'mobile' ? devices['Pixel 7'] : devices['Desktop Chrome'];

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  outputDir: `${runDir}/test-results`,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: `${runDir}/report`, open: 'never' }]],
  use: {
    ...device,
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
    trace: 'off', // our own logs, screenshots and errors do the diagnosing; use `npx playwright test --trace on` when debugging
    screenshot: 'only-on-failure',
  },
  // Uses the locally installed Google Chrome (no browser download needed).
  // One project per environment, same viewport so screenshots can be compared pixel for pixel.
  projects: envs.map((e) => ({
    name: e.id,
    metadata: { env: e.id },
    use: { ...device, channel, baseURL: e.baseURL },
  })),
});
