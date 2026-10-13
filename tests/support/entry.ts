import type { BrowserContext, Page } from '@playwright/test';

// The page a journey starts on. Production and Sandbox start at "/"; a custom target (partner site, agent code)
// starts at the pasted path and query, so the agent code travels with the first request.
const entries = new WeakMap<BrowserContext, string>();
export const setEntry = (context: BrowserContext, entry: string) => entries.set(context, entry || '/');
export const entryFor = (page: Page): string => entries.get(page.context()) ?? '/';

/** A link with its own path (for example /partner/pa/melindungi) is a direct funnel link, not a home page: skip the home and category steps. */
export const isDirectEntry = (page: Page): boolean => entryFor(page).split('?')[0].replace(/\/+$/, '') !== '';
