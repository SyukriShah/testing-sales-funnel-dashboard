import { expect, type Page } from '@playwright/test';
import type { Run } from './fixtures';
import { EntryPoints } from '../catalogue/EntryPoints';
import { byLabel } from '../catalogue/data';

/** Homepage -> category page -> the product's Get Quote button; returns the funnel's page (a new tab). */
export async function openFunnel(page: Page, run: Run, entryLabel: string): Promise<Page> {
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
