import type { BrowserContext, Page } from '@playwright/test';

// The page a journey starts on. Production and Sandbox start at "/"; a custom target (partner site, agent code)
// starts at the pasted path and query, so the agent code travels with the first request.
const entries = new WeakMap<BrowserContext, string>();
export const setEntry = (context: BrowserContext, entry: string) => entries.set(context, entry || '/');
export const entryFor = (page: Page): string => entries.get(page.context()) ?? '/';

/** A link with its own path (for example /partner/pa/melindungi) is a direct funnel link, not a home page: skip the home and category steps. */
export const isDirectEntry = (page: Page): boolean => entryFor(page).split('?')[0].replace(/\/+$/, '') !== '';

/** Opens the entry page. A server error (5xx) is retried twice, a few seconds apart, so a one-second blip is not reported as an outage;
 *  a page that keeps answering 5xx still fails the test. */
export async function openEntry(page: Page): Promise<void> {
  const url = entryFor(page);
  for (let attempt = 1; ; attempt++) {
    const res = await page.goto(url, { waitUntil: 'load' });
    if (!res || res.status() < 500 || attempt === 3) return;
    await page.waitForTimeout(attempt * 4_000);
  }
}
