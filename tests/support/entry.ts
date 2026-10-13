import type { BrowserContext, Page } from '@playwright/test';

// The page a journey starts on. Production and Sandbox start at "/"; a custom target (partner site, agent code)
// starts at the pasted path and query, so the agent code travels with the first request.
const entries = new WeakMap<BrowserContext, string>();
export const setEntry = (context: BrowserContext, entry: string) => entries.set(context, entry || '/');
export const entryFor = (page: Page): string => entries.get(page.context()) ?? '/';
