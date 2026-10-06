import { expect, type Page } from '@playwright/test';
import type { Entry } from './data';

/** Walks homepage -> category page -> a product's button, and inspects the page it lands on. */
export class EntryPoints {
  constructor(readonly page: Page) {}

  async openHomepage() {
    await this.page.goto('/', { waitUntil: 'load' });
    await this.page.waitForLoadState('networkidle').catch(() => {}); // analytics can keep this busy
  }

  /** Returns true if the category was reached by clicking its homepage link, false if it had to be opened directly. */
  async openCategory(category: string): Promise<boolean> {
    const link = this.page.locator(`a[href$="/category/${category}"]`).filter({ visible: true }).first();
    if (await link.count()) {
      try { await link.click({ timeout: 8_000 }); await expect(this.page).toHaveURL(new RegExp(`/category/${category}`)); return true; } catch { /* fall through */ }
    }
    await this.page.goto(`/category/${category}`, { waitUntil: 'load' });
    return false;
  }

  /** The product's button as shown on the category page. */
  button(entry: Entry) {
    return this.page.locator(`#form_cta_${entry.cta}_quote`);
  }

  /**
   * Clicks the button and returns the page it opens (a new tab, or this tab if it navigates).
   * The click handler can attach late, so it retries a few times rather than trusting one click.
   */
  async openTarget(entry: Entry): Promise<{ target: Page; opensIn: 'new tab' | 'same tab' }> {
    const here = this.page.url();
    let result: { target: Page; opensIn: 'new tab' | 'same tab' } | undefined;
    await expect(async () => {
      const popup = this.page.context().waitForEvent('page', { timeout: 6_000 }).catch(() => null);
      await this.button(entry).click();
      const p = await popup;
      if (p) { result = { target: p, opensIn: 'new tab' }; return; }
      if (this.page.url() !== here) { result = { target: this.page, opensIn: 'same tab' }; return; }
      throw new Error('the button did not open anything yet');
    }).toPass({ timeout: 40_000 });
    await result!.target.waitForLoadState('domcontentloaded').catch(() => {});
    await result!.target.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {});
    return result!;
  }

  /** What the landing page looks like, for the checks and the log. */
  async describe(target: Page) {
    const url = target.url();
    const title = (await target.title().catch(() => '')).trim();
    const text = ((await target.locator('body').innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
    return { url, title, textLength: text.length, browserError: /^chrome-error:/.test(url) || /This site can.t be reached/i.test(text) };
  }

  /** The enquiry form shown by "Talk to Us" products; only checked, never submitted. */
  async enquiryForm(target: Page) {
    return {
      fields: await target.locator('input:visible, textarea:visible').count(),
      submit: target.getByRole('button', { name: /^submit$/i }).filter({ visible: true }).first(),
    };
  }
}
