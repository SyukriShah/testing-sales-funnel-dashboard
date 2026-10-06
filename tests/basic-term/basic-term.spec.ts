import { test, expect } from '../support/fixtures';
import { Walker } from '../support/walker';
import { isPhone } from '../support/journey';
import { EntryPoints } from '../catalogue/EntryPoints';
import { byLabel } from '../catalogue/data';
import { SCENARIOS, answersFor, resolve } from './data';

/**
 * IKHLAS Basic Term Takaful: quote journey with dummy data up to the Summary page.
 * The walker answers each page from the scenario's data and presses Get a Quote / Continue;
 * it never presses PAY, and the test fails if the funnel ever moves on to payment.
 */
test.describe('IKHLAS Basic Term Takaful - quote journey', () => {
  for (const planned of SCENARIOS) {
    test(planned.id, async ({ page, run }) => {
      const { scenario: s, person } = resolve(planned); // fresh dummy person per run
      run.log('INFO', `${s.fullName}, NRIC ${s.nric}, ${s.incomeStatus}, ${s.occupation}, RM${s.income}/month`);
      const entry = byLabel('Hibah: Basic Term');
      const site = new EntryPoints(page);
      await site.openHomepage();
      await expect(page).toHaveTitle(/IKHLAS/i);
      run.log('PASS', `Homepage loaded: ${page.url()}`);
      await run.shot(page, 'homepage', { fullPage: false });

      await site.openCategory(entry.category);
      run.log('PASS', `Category page: ${page.url()}`);
      const { target } = await site.openTarget(entry);
      run.log('PASS', `Funnel opened: ${target.url()}`);
      await expect(target.getByRole('heading', { name: /^(IKHLAS )?Basic Term Takaful$/ }).first()).toBeVisible();

      const result = await new Walker(target, run, answersFor(s, person), 'basic-term').walk();
      expect(result.reachedSummary).toBe(true);
      if (isPhone(target)) { run.log('PASS', 'Phone size: stopping at the Summary page (content checks run on desktop)'); run.stoppedAt('Summary (phone size)'); return; }

      // Summary Details must echo back what was entered, and show the plan and a price.
      expect(target.url()).toMatch(/\/quote\/summary-detail/);
      const text = ((await target.locator('body').innerText()) ?? '').toUpperCase();
      for (const [what, value] of [
        ['full name', s.fullName], ['ID number', s.nric], ['email', person.email], ['mobile (+60)', '60' + person.mobile.slice(1)],
        ['mailing address', person.addressLine1], ['postcode', person.postcode], ['employer', 'DUMMY ENTERPRISE SDN BHD'], ['bank account', '123456789012'],
      ] as const) {
        expect(text, `Summary should show the ${what}`).toContain(value.toUpperCase());
      }
      expect(text).toContain('RM50,000'); // sum covered
      expect(text).toMatch(/10 YEARS/);
      const total = text.match(/TOTAL CONTRIBUTION\s*RM\s*([\d,]+\.\d{2})/)?.[1];
      expect(total, 'Summary should show a total contribution').toBeTruthy();
      run.fact('total contribution', `RM${total}`);
      run.fact('sum covered', 'RM50,000 / 10 years / monthly');
      run.log('PASS', `Summary Details matches what was entered; total contribution RM${total}`);

      // The funnel's own Continue button here goes on to Payment Details, so it is deliberately not pressed.
      run.stoppedAt('Summary Details (Continue to Payment not pressed)');
    });
  }
});
