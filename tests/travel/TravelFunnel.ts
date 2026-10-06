import { expect, type Locator, type Page } from '@playwright/test';
import { addDays, cellLabel, slashDate } from '../support/dates';

/** Page object for the IKHLAS Secure Travel funnel (go.takaful-ikhlas.com.my/direct/travel). */
export class TravelFunnel {
  constructor(readonly page: Page) {}

  // ---------- homepage -> travel category -> funnel ----------

  async dismissPopups() {
    const consent = this.page
      .getByRole('button', { name: /accept|agree|allow all|got it|ok/i })
      .or(this.page.getByRole('button', { name: /close|dismiss/i }))
      .first();
    if (await consent.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await consent.click().catch(() => {});
    }
  }

  async openHomepage() {
    await this.page.goto('/', { waitUntil: 'load' });
    await this.page.waitForLoadState('networkidle').catch(() => {}); // analytics can keep this busy
    await this.dismissPopups();
  }

  async openTravelCategory() {
    // The homepage has no "Travel Sales Funnel" item; the Travel tile leads to the travel category.
    // Matched by destination rather than promo text, so a changed offer badge does not break it.
    await this.page.locator('a[href$="/category/travel-takaful"]').filter({ visible: true }).first().click();
    await expect(this.page).toHaveURL(/\/category\/travel-takaful/);
    await this.dismissPopups();
  }

  /** Clicks Get Quote for IKHLAS Secure Travel Takaful; the funnel opens in a new tab. */
  async openSecureTravelQuote(): Promise<TravelFunnel> {
    // The card's click handler can attach late after the page loads, so retry the click
    // until the funnel tab actually opens instead of trusting a single click.
    let popup!: Page;
    await expect(async () => {
      [popup] = await Promise.all([
        this.page.context().waitForEvent('page', { timeout: 6_000 }),
        this.page.locator('#form_cta_ikhlas-secure-travel-takaful_quote').click(),
      ]);
    }).toPass({ timeout: 45_000 });
    await popup.waitForLoadState('load');
    await expect(popup).toHaveURL(/\/direct\/travel/); // funnel host differs per environment
    return new TravelFunnel(popup);
  }

  // ---------- step: trip details ----------

  async chooseSingleReturn() {
    await this.page.getByText('Single Return Trip').click();
    await expect(this.page.getByRole('combobox', { name: 'Please Select Coverage Area' })).toBeVisible();
  }

  async selectDestination(area: string) {
    await this.page.getByRole('combobox', { name: 'Please Select Coverage Area' }).click();
    await this.page.getByRole('option', { name: area, exact: true }).click();
  }

  async selectTravelPeriod(depart: Date, ret: Date) {
    await this.page.getByRole('button', { name: 'Open calendar' }).click();
    await this.pickDay(depart);
    await this.pickDay(ret);
    await expect(this.page.getByRole('textbox', { name: 'Please select travel period' })).toHaveValue(slashDate(depart));
    await expect(this.page.getByRole('textbox', { name: 'Return date' })).toHaveValue(slashDate(ret));
  }

  /** Clicks a day in the open calendar, paging forward if it is in a later month. */
  private async pickDay(d: Date) {
    const cell = this.page.getByRole('gridcell', { name: cellLabel(d), exact: true });
    for (let i = 0; i < 12 && !(await cell.isVisible()); i++) {
      await this.page.getByRole('button', { name: 'Next month' }).click();
    }
    await cell.click();
  }

  async selectTravelType(type: string) {
    await this.page.getByRole('combobox', { name: 'Select Travel Type' }).click();
    await this.page.getByRole('option', { name: type, exact: true }).click();
  }

  async getQuote() {
    await this.page.getByRole('button', { name: 'GET QUOTE' }).click();
    await expect(this.page.getByRole('radiogroup', { name: 'Travel Plan' })).toBeVisible();
  }

  // ---------- step: plan ----------

  plans(): Locator {
    return this.page.getByRole('radiogroup', { name: 'Travel Plan' }).getByRole('radio');
  }

  /** Name and prices of every plan offered, for the environment comparison. */
  async planSummaries(): Promise<{ name: string; prices: string[] }[]> {
    const out: { name: string; prices: string[] }[] = [];
    const all = this.plans();
    for (let i = 0; i < (await all.count()); i++) {
      const lines = (await all.nth(i).innerText()).split('\n').map((l) => l.trim()).filter(Boolean);
      out.push({
        name: lines.find((l) => !/^recommended$/i.test(l)) ?? '',
        prices: lines.filter((l) => /^RM\s?[\d,]+(\.\d+)?$/.test(l)),
      });
    }
    return out;
  }

  /** Selects the n-th plan (1-based). Falls back to the last plan if fewer exist. Returns the plan name. */
  async selectPlan(position: number): Promise<{ name: string; usedFallback: boolean }> {
    const count = await this.plans().count();
    expect(count, 'at least one travel plan should be offered').toBeGreaterThan(0);
    const index = Math.min(position, count) - 1;
    const plan = this.plans().nth(index);
    // The first line can be a "RECOMMENDED" badge (Diamond), so take the first line that is not one.
    const lines = (await plan.innerText()).split('\n').map((l) => l.trim()).filter(Boolean);
    const name = lines.find((l) => !/^recommended$/i.test(l)) ?? '';
    await plan.click();
    return { name, usedFallback: position > count };
  }

  // ---------- generic navigation ----------

  /**
   * Clicks CONTINUE until the URL changes. The first click can be swallowed while an
   * async field check (e.g. the NRIC lookup) is in flight, so retry without re-clicking
   * once the page has moved on.
   */
  async continueTo(url: RegExp) {
    const button = this.page.getByRole('button', { name: 'CONTINUE' });
    await expect(async () => {
      if (!url.test(this.page.url())) await button.click();
      await expect(this.page).toHaveURL(url, { timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
  }

  // ---------- step: add-ons ----------

  async skipAddOns() {
    await expect(this.page).toHaveURL(/\/quote\/add-ons/);
    await expect(this.page.getByRole('heading', { name: 'Additional Coverage' })).toBeVisible();
    await this.continueTo(/\/quote\/participant-details/);
  }

  planDetailsRow(label: string): Locator {
    return this.page.locator('div', { has: this.page.getByText(label, { exact: true }) }).last();
  }

  // ---------- step: participant ----------

  private field(label: string): Locator {
    return this.page.locator('form-input').filter({ hasText: label }).getByRole('textbox');
  }

  async fillParticipant(p: {
    nric: string; fullName: string; email: string; mobile: string;
    addressLine1: string; addressLine2: string; postcode: string;
  }) {
    await expect(this.page).toHaveURL(/\/quote\/participant-details/);
    await this.field('ID Number').fill(p.nric);
    await this.field('Name').fill(p.fullName);
    await this.field('Email').fill(p.email);
    await this.field('Mobile Number').fill(p.mobile);
    await this.field('Line 1').fill(p.addressLine1);
    await this.field('Line 2').fill(p.addressLine2);
    await this.field('Postcode').fill(p.postcode);
    await this.field('Postcode').blur(); // the city/state lookup fires on blur
  }

  /** City and State are read-only and filled by the site from the postcode. */
  async expectAutoFilledAddress(): Promise<{ city: string; state: string }> {
    const city = this.field('City');
    const state = this.page.locator('form-input').filter({ hasText: 'State' }).getByRole('textbox');
    await expect(city).not.toHaveValue('');
    await expect(state).not.toHaveValue('');
    return { city: await city.inputValue(), state: await state.inputValue() };
  }

  // ---------- step: flight details ----------

  async fillFlights(f: { carrier: string; outboundNo: string; returnNo: string }) {
    await expect(this.page).toHaveURL(/\/quote\/flight-details/);
    const carriers = this.page.locator('form-input').filter({ hasText: 'Carrier' }).getByRole('combobox');
    const numbers = this.page.locator('form-input').filter({ hasText: 'Flight number' }).getByRole('textbox');
    await carriers.nth(0).selectOption(f.carrier);
    await numbers.nth(0).fill(f.outboundNo);
    await carriers.nth(1).selectOption(f.carrier);
    await numbers.nth(1).fill(f.returnNo);
  }

  async expectFlightDates(depart: Date, ret: Date) {
    const dates = this.page.getByRole('textbox', { name: 'DD/MM/YYYY' });
    await expect(dates.nth(0)).toHaveValue(slashDate(depart));
    await expect(dates.nth(1)).toHaveValue(slashDate(ret));
  }

  /**
   * Picks the bank and types a dummy account number of a length the site accepts for it.
   * Valid lengths come from the site's own bank list (e.g. RHB = 14, CIMB = 14 or 10).
   * The number is an obvious placeholder (1234...), never a real account.
   */
  async fillAutoCredit(bankName: string): Promise<{ bank: string; accountNo: string }> {
    const res = await this.page.request.get(new URL('/api/v1/refs/banks', this.page.url()).href);
    expect(res.ok(), 'bank list API should respond').toBeTruthy();
    const banks: { key: string; description: string; length: string }[] = (await res.json()).data;
    const bank = banks.find((b) => b.description.trim().toUpperCase() === bankName.trim().toUpperCase());
    expect(bank, `bank "${bankName}" should be in the site's bank list`).toBeTruthy();
    const length = Number(bank!.length.split(',')[0].trim());
    const accountNo = '1234567890'.repeat(3).slice(0, length);

    await this.page.locator('form-input').filter({ hasText: 'Bank Name' }).getByRole('combobox').selectOption({ value: bank!.key });
    await this.page.locator('form-input').filter({ hasText: 'Bank Account Number' }).getByRole('textbox').fill(accountNo);
    return { bank: bank!.description.trim(), accountNo };
  }

  // ---------- step: summary ----------

  payButton(): Locator {
    // The page keeps a second, hidden copy of the panel, so only look at the visible one.
    return this.page.getByRole('button', { name: 'PAY' }).filter({ visible: true }).first();
  }

  /** E-invoice question: radios are custom controls, Yes first and No second. */
  async answerEinvoice(answer: 'Yes' | 'No') {
    // The Summary content can still be loading when the address changes, so retry the click.
    await expect(async () => {
      await this.page.getByRole('radio').nth(answer === 'Yes' ? 0 : 1).check({ force: true, timeout: 5_000 });
    }).toPass({ timeout: 40_000 });
  }

  tinInput(): Locator {
    return this.page.getByPlaceholder('e.g. IG56003500070');
  }

  sstInput(): Locator {
    return this.page.getByPlaceholder('e.g. STN-YYMM-XXXXXXXX');
  }

  /**
   * Ticks one declaration by its tick box, the element just before its text. The text itself
   * contains links (Product Disclosure Sheet, Aqad, PDPA) that open new tabs, so never click the text.
   */
  async tickDeclaration(text: RegExp) {
    await this.page.getByText(text).filter({ visible: true }).first().locator('xpath=preceding-sibling::*[1]').click();
  }

  /** Text of the value shown beside a label in the right-hand price panel, if present. */
  async totalContribution(): Promise<string | undefined> {
    try {
      const value = this.page.getByText('Total contribution', { exact: true }).locator('xpath=following-sibling::*[1]');
      return (await value.first().innerText({ timeout: 3_000 })).trim();
    } catch {
      return undefined;
    }
  }

  autoCreditErrors(): Locator {
    return this.page.getByText(/Bank Type is required|Bank Account Number is required/);
  }
}

export { addDays };
