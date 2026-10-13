import { expect, type Page } from '@playwright/test';
import type { Run } from './fixtures';
import { EntryPoints } from '../catalogue/EntryPoints';
import { byLabel } from '../catalogue/data';
import { entryFor, isDirectEntry } from './entry';

/** Homepage -> category page -> the product's Get Quote button; returns the funnel's page (a new tab). */
export async function openFunnel(page: Page, run: Run, entryLabel: string): Promise<Page> {
  if (isDirectEntry(page)) { await openDirectly(page, run); return page; }
  const entry = byLabel(entryLabel);
  const site = new EntryPoints(page);
  await site.openHomepage();
  await expect(page).toHaveTitle(/IKHLAS/i);
  run.log('PASS', `Homepage loaded: ${page.url()}`);
  await run.shot(page, 'homepage', { fullPage: false });
  await site.openCategory(entry.category);
  run.log('PASS', `Category page: ${page.url()}`);
  const { target } = await site.openTarget(entry);
  run.log('PASS', `Funnel opened: ${target.url()}`);
  return target;
}

/** The text of the page, upper-cased, for "does the Summary show what we entered" checks. */
export async function pageText(page: Page): Promise<string> {
  return ((await page.locator('body').innerText()) ?? '').toUpperCase();
}

export function expectShows(text: string, what: string, value: string) {
  expect(text, `the Summary should show the ${what}`).toContain(value.toUpperCase());
}

/** True on a phone-size screen. Summary content checks are written for the desktop layout, so phone runs stop once the Summary is reached. */
export const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) <= 600;

/** Direct funnel link (partner or agent link): open it as the funnel's first page, no home page or category step. */
export async function openDirectly(page: Page, run: Run): Promise<void> {
  await page.goto(entryFor(page), { waitUntil: 'load' });
  await page.waitForLoadState('networkidle').catch(() => {}); // analytics can keep this busy
  run.log('PASS', `Direct funnel link opened: ${page.url()}`);
  await run.shot(page, 'funnel-landing');
}
