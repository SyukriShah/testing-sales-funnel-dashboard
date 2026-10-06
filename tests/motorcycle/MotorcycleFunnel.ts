import { expect, type Page } from '@playwright/test';
import type { Run } from '../support/fixtures';
import { QUOTE_BUTTON_ID } from './data';

/** Page object for the motorcycle funnel entry (go.takaful-ikhlas.com.my/direct/motorcycle). */
export class MotorcycleFunnel {
  constructor(readonly page: Page) {}

  async openHomepage() {
    await this.page.goto('/', { waitUntil: 'load' });
    await this.page.waitForLoadState('networkidle').catch(() => {}); // analytics can keep this busy
  }

  async openCategory() {
    // Matched by destination rather than promo text, so a changed offer badge does not break it.
    await this.page.locator('a[href$="/category/motorcycle-takaful"]').filter({ visible: true }).first().click();
    await expect(this.page).toHaveURL(/\/category\/motorcycle-takaful/);
  }

  /** Clicks Get Quote for the motorcycle product; the funnel opens in a new tab. */
  async openQuote(): Promise<MotorcycleFunnel> {
    // The card's click handler can attach late after the page loads, so retry until the tab opens.
    let popup!: Page;
    await expect(async () => {
      [popup] = await Promise.all([
        this.page.context().waitForEvent('page', { timeout: 6_000 }),
        this.page.locator(`#${QUOTE_BUTTON_ID}`).click(),
      ]);
    }).toPass({ timeout: 45_000 });
    await popup.waitForLoadState('load');
    await expect(popup).toHaveURL(/\/direct\/motorcycle/); // funnel host differs per environment
    return new MotorcycleFunnel(popup);
  }

  idNumber() { return this.page.locator('input:visible').nth(0); }
  vehicleNumber() { return this.page.locator('input:visible').nth(1); }
  getQuote() { return this.page.getByRole('button', { name: 'GET A QUOTE' }); }

  async selectIdType(type: string) {
    // The ID type is a native select; its first visible combobox is the only one on this screen.
    await this.page.locator('select').first().selectOption({ label: type }).catch(async () => {
      await this.page.getByRole('combobox').first().selectOption({ label: type });
    });
  }

  /** The funnel answers a lookup with a modal such as "001 - Data not found ...". Returns its text. */
  async lookupMessage(): Promise<string> {
    const modal = this.page.locator('text=/Data not found|not found|error|unable/i').filter({ visible: true }).first();
    await expect(modal).toBeVisible({ timeout: 30_000 });
    return (await modal.innerText()).replace(/\s+/g, ' ').trim();
  }

  async dismissMessage() {
    await this.page.getByRole('button', { name: 'OK' }).click();
  }

  /** After GET A QUOTE: did the lookup refuse ("not found" modal) or move on to the next page? */
  async lookupOutcome(): Promise<{ kind: 'refused' | 'moved' | 'error'; text: string }> {
    let out: { kind: 'refused' | 'moved' | 'error'; text: string } | undefined;
    await expect(async () => {
      const modal = this.page.locator('text=/Data not found|not found/i').filter({ visible: true }).first();
      const err = this.page.locator('text=/RequestError|Timeout|failed to complete|something went wrong/i').filter({ visible: true }).first();
      if (await err.isVisible().catch(() => false)) { out = { kind: 'error', text: (await err.innerText()).replace(/\s+/g, ' ').trim() }; return; }
      if (await modal.isVisible().catch(() => false)) { out = { kind: 'refused', text: (await modal.innerText()).replace(/\s+/g, ' ').trim() }; return; }
      if (!(await this.idNumber().isVisible().catch(() => false)) || !/\/direct\/motorcycle\/?$/.test(this.page.url())) { out = { kind: 'moved', text: this.page.url() }; return; }
      throw new Error('lookup has not answered yet');
    }).toPass({ timeout: 45_000 });
    return out!;
  }
}
