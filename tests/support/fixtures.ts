import { test as base, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { allSecretValues } from './secrets';

type Level = 'INFO' | 'PASS' | 'WARN' | 'FAIL' | 'SHOT';

/** What a page looked like at one step: structure and computed styles, for flow/design comparison. */
export type Snapshot = {
  path: string;
  title: string;
  headings: string[];
  labels: string[];
  buttons: string[];
  inputs: number;
  styles: Record<string, string>;
};

export type Run = {
  /** runs/<RUN_ID>/<env>/<product>/<test>/ */
  dir: string;
  product: string;
  env: string;
  log: (level: Level, msg: string) => void;
  /** Screenshot + design snapshot for this step. Same step name = same step across environments. */
  shot: (page: Page, name: string, opts?: { fullPage?: boolean; mask?: boolean }) => Promise<void>;
  /** Records a comparable fact (plans offered, totals, ...) shown in the environment comparison. */
  fact: (key: string, value: unknown) => void;
  /** Marks where a journey deliberately stopped (e.g. a gate before payment). */
  stoppedAt: (where: string) => void;
  /** Flags that screenshots show a saved test record: kept locally, left out of the shared dashboard link. */
  sensitive: () => void;
};

const RUN_ID = process.env.RUN_ID ?? 'run-adhoc';
/** Saved test-record values (IDs, plates) must never reach logs or result files. */
const SECRETS = allSecretValues();
const redact = (t: string) => SECRETS.reduce((acc, v) => acc.split(v).join('***'), t);
/** Regions that animate or rotate on their own (hero animation, carousels): painted over in screenshots so they don't read as design differences. */
const MASK: string[] = JSON.parse(fs.readFileSync('monitor.config.json', 'utf8')).screenshotMask ?? [];
const RUN_ROOT = path.resolve('runs', RUN_ID);

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const ts = () => new Date().toISOString();
/** Third-party noise (analytics/tag managers) is not part of the funnel's health. */
const THIRD_PARTY = /google|gtm|doubleclick|facebook|clarity|hotjar|analytics/i;
/** Any takaful-ikhlas.com.my host: www, go, sandbox, ... */
const FIRST_PARTY = /(^|\.)takaful-ikhlas\.com\.my$/;

/** Product = the folder under tests/ that the spec lives in (tests/<product>/x.spec.ts). */
function productOf(file: string): string {
  const rel = path.relative(path.resolve('tests'), file);
  return rel.split(path.sep)[0] ?? 'unknown';
}

/** Structure and a few computed styles of the visible page; runs inside the browser. */
/** Phone-size checks: sideways scrolling, small tap targets, text boxes that make iOS zoom, and missing keyboard hints. Skipped on wide screens. */
async function mobileAudit(page: Page) {
  try {
    return await page.evaluate(() => {
      const vw = window.innerWidth;
      if (vw > 600) return undefined;
      const vis = (e: Element) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const label = (e: Element) => ((e.getAttribute('aria-label') || (e as HTMLInputElement).placeholder || (e as HTMLElement).innerText || e.id || e.getAttribute('name') || '') as string).replace(/\s+/g, ' ').trim().slice(0, 40);
      // links inside a sentence are exempt from the minimum target size (WCAG 2.2 SC 2.5.8)
      const inline = (e: Element) => e.tagName === 'A' && !!e.parentElement && (e.parentElement.innerText?.length ?? 0) > ((e as HTMLElement).innerText?.length ?? 0) + 15 && !/^(LI|NAV|UL)$/.test(e.parentElement.tagName);
      const targets = [...document.querySelectorAll('a[href],button,[role=button],input:not([type=hidden]),select,textarea,[role=checkbox],[role=radio]')].filter((e) => vis(e) && !inline(e));
      const small = targets.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 24 || r.height < 24; }).map(label);
      const tight = targets.filter((e) => { const r = e.getBoundingClientRect(); return (r.width < 44 || r.height < 44) && r.width >= 24 && r.height >= 24; }).length;
      const inputs = [...document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]),textarea')].filter(vis) as HTMLInputElement[];
      const smallText = inputs.filter((i) => parseFloat(getComputedStyle(i).fontSize) < 16).map(label);
      const wantsKeys = /nric|id.?n|identity|kad|mobile|phone|telefon|tel|postcode|poskod|account|akaun|amount|e-?mail|emel/i;
      const noHint = inputs.filter((i) => wantsKeys.test(label(i) + ' ' + (i.name ?? '') + ' ' + i.id) && !i.inputMode && !['tel', 'email', 'number'].includes(i.type)).map(label);
      const noAuto = inputs.filter((i) => /name|nama|e-?mail|emel|mobile|phone|telefon|postcode|poskod|address|alamat/i.test(label(i) + ' ' + i.id) && (!i.autocomplete || i.autocomplete === 'off')).map(label);
      const bars = [...document.querySelectorAll('*')].filter((e) => { const s = getComputedStyle(e); return (s.position === 'fixed' || s.position === 'sticky') && vis(e); })
        .map((e) => e.getBoundingClientRect()).filter((r) => r.width > vw * 0.6 && r.height > 20);
      const barPct = Math.round((Math.max(0, ...bars.map((r) => r.height)) / window.innerHeight) * 100);
      return {
        width: vw,
        overflowX: document.documentElement.scrollWidth > vw + 1,
        overflowBy: Math.max(0, document.documentElement.scrollWidth - vw),
        smallTargets: small.slice(0, 8), smallTargetCount: small.length, tightTargets: tight,
        smallTextInputs: smallText.slice(0, 8),
        inputsWithoutKeyboardHint: noHint.slice(0, 8),
        inputsWithoutAutocomplete: noAuto.slice(0, 8),
        fixedBarPercent: barPct,
        inputCount: inputs.length,
      };
    });
  } catch { return undefined; }
}

async function snapshotOf(page: Page): Promise<Snapshot | undefined> {
  try {
    return await page.evaluate(() => {
      const visible = (el: Element) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        const cs = getComputedStyle(el as HTMLElement);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
      };
      const texts = (sel: string, max: number) =>
        [...document.querySelectorAll(sel)].filter(visible).map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, max);
      const cs = (el: Element | null | undefined, props: string[]) => {
        const out: Record<string, string> = {};
        if (!el) return out;
        const s = getComputedStyle(el as HTMLElement);
        for (const p of props) out[p] = s.getPropertyValue(p);
        return out;
      };
      const flat = (prefix: string, o: Record<string, string>, into: Record<string, string>) => {
        for (const [k, v] of Object.entries(o)) into[`${prefix} ${k}`] = v;
      };
      const styles: Record<string, string> = {};
      flat('body', cs(document.body, ['font-family', 'font-size', 'color', 'background-color']), styles);
      const h = [...document.querySelectorAll('h1,h2')].find(visible);
      flat('heading', cs(h, ['font-family', 'font-size', 'font-weight', 'color']), styles);
      const primary = [...document.querySelectorAll('button')].filter(visible).find((b) => /continue|get quote|pay|start/i.test(b.textContent ?? ''));
      flat('primary button', cs(primary, ['background-color', 'color', 'border-radius', 'font-size', 'font-weight']), styles);
      const link = [...document.querySelectorAll('a')].find(visible);
      flat('link', cs(link, ['color']), styles);
      const labelEls = [...document.querySelectorAll('label, .label, form-input[label]')];
      const labels = labelEls.filter(visible).map((e) => (e.getAttribute('label') ?? e.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 30);
      return {
        path: location.pathname,
        title: document.title,
        headings: texts('h1,h2,h3', 12),
        labels,
        buttons: texts('button', 12),
        inputs: [...document.querySelectorAll('input,select,textarea')].filter(visible).length,
        styles,
      };
    });
  } catch {
    return undefined; // page navigating/closed; the screenshot still stands
  }
}

export const test = base.extend<{ run: Run }>({
  run: async ({ context }, use, testInfo) => {
    const product = productOf(testInfo.file);
    const env = (testInfo.project.metadata?.env as string | undefined) ?? 'production';
    const baseURL = (testInfo.project.use as { baseURL?: string }).baseURL ?? '';
    const name = slug(testInfo.title);
    const dir = path.join(RUN_ROOT, env, product, name);
    fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
    const started = Date.now();

    const steps: { ts: string; level: Level; msg: string }[] = [];
    const screenshots: string[] = [];
    const snapshots: Record<string, Snapshot> = {}; // keyed by screenshot file name
    const facts: Record<string, unknown> = {};
    const mobile: Record<string, unknown> = {}; // phone-size checks per screenshot (only filled when the viewport is narrow)
    const consoleErrors: string[] = [];
    const httpErrors: { method: string; url: string; status: number | string }[] = [];
    const api = { total: 0, failed: 0 };
    let stopped: string | undefined;
    let isSensitive = false;

    const log: Run['log'] = (level, msgRaw) => {
      const msg = redact(msgRaw);
      const line = `${ts()} [${level.padEnd(4)}] ${msg}\n`;
      steps.push({ ts: ts(), level, msg });
      fs.appendFileSync(path.join(dir, 'test.log'), line);
      fs.appendFileSync(path.join(RUN_ROOT, env, product, 'run.log'), `[${name}] ${line}`);
    };

    const firstParty = (u: string) => {
      try { return FIRST_PARTY.test(new URL(u).hostname); } catch { return false; }
    };
    const clean = (u: string) => u.split('?')[0];

    // Console + network health for every page the test opens (including popups).
    const attach = (p: Page) => {
      p.on('console', (m) => {
        if (m.type() !== 'error') return;
        const text = m.text();
        const loc = m.location().url;
        // Browser-reported failures to reach third-party hosts are not funnel faults.
        const mentioned = text.match(/https?:\/\/[^\s'"]+/)?.[0];
        if (THIRD_PARTY.test(text) || THIRD_PARTY.test(loc)) return;
        if (mentioned && !firstParty(mentioned)) return;
        consoleErrors.push(`${clean(loc || p.url())} :: ${text.slice(0, 300)}`);
      });
      p.on('pageerror', (e) => consoleErrors.push(`${p.url()} :: pageerror ${e.message.slice(0, 300)}`));
    };
    context.pages().forEach(attach);
    context.on('page', attach);

    context.on('response', (r) => {
      if (!firstParty(r.url())) return;
      const isApi = /\/api\//.test(r.url());
      if (isApi) api.total++;
      if (r.status() >= 400) {
        if (isApi) api.failed++;
        httpErrors.push({ method: r.request().method(), url: clean(r.url()), status: r.status() });
      }
    });
    context.on('requestfailed', (r) => {
      if (!firstParty(r.url())) return;
      // ERR_ABORTED = the page navigated away mid-load; not a connection fault.
      if (r.failure()?.errorText === 'net::ERR_ABORTED') return;
      if (/\/api\//.test(r.url())) { api.total++; api.failed++; }
      httpErrors.push({ method: r.method(), url: clean(r.url()), status: r.failure()?.errorText ?? 'failed' });
    });

    let n = 0;
    const shot: Run['shot'] = async (page, label, opts) => {
      const base = `${String(++n).padStart(2, '0')}-${slug(label)}.png`;
      const file = path.join(dir, 'screenshots', base);
      // Let async content finish loading and transitions settle, so the same page captures the same way every time.
      await page.waitForLoadState('networkidle', { timeout: 2_000 }).catch(() => {});
      // Always capture the whole page from the top, so scroll position left by earlier clicks never shows up as a difference.
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await page.waitForTimeout(400);
      await page.screenshot({
        path: file, fullPage: opts?.fullPage ?? true, animations: 'disabled', caret: 'hide',
        mask: opts?.mask === false ? [] : MASK.map((sel) => page.locator(sel)), maskColor: '#9aa0a6',
      });
      screenshots.push(path.relative(RUN_ROOT, file));
      const snap = await snapshotOf(page);
      if (snap) snapshots[base] = snap;
      const audit = await mobileAudit(page);
      if (audit) mobile[base] = audit;
      log('SHOT', path.relative(RUN_ROOT, file));
    };

    log('INFO', `START ${testInfo.title} on ${env} (${baseURL})`);
    await use({
      dir, product, env, log, shot,
      fact: (k, v) => { facts[k] = v; },
      stoppedAt: (w) => { stopped = w; },
      sensitive: () => { isSensitive = true; },
    });

    const status = testInfo.status ?? 'failed';
    const error = testInfo.errors[0]?.message?.replace(/\u001b\[[0-9;]*m/g, '').split('\n').slice(0, 6).join('\n');
    log(status === 'passed' ? 'PASS' : 'FAIL', `END ${testInfo.title} (${status})`);

    const body = JSON.stringify(
        {
          runId: RUN_ID,
          env,
          baseUrl: baseURL,
          /** 'dashboard' = started from the Run tests tab with custom data; excluded from health stats */
          trigger: process.env.RUN_TRIGGER ?? 'local',
          product,
          scenario: name,
          title: testInfo.title,
          status,
          startedAt: new Date(started).toISOString(),
          durationMs: Date.now() - started,
          stoppedAt: stopped ?? null,
          error: error ?? null,
          steps,
          screenshots,
          snapshots,
          mobile,
          facts,
          api,
          httpErrors,
          sensitive: isSensitive,
          consoleErrors: consoleErrors.slice(0, 25),
        },
        null,
        2,
      );
    fs.writeFileSync(path.join(dir, 'result.json'), redact(body));
  },
});

export { expect };
