import { test, expect } from '../support/fixtures';
import { Walker } from '../support/walker';
import { openFunnel, pageText, isPhone } from '../support/journey';
import { SCENARIOS, answersFor, resolve } from './data';

/** Direct Hospital Income Benefit: quote journey with a fresh dummy person, up to the Summary page. */
test.describe('Direct Hospital Income Benefit - quote journey', () => {
  for (const planned of SCENARIOS) {
    test(planned.id, async ({ page, run }) => {
      const { scenario: s, person } = resolve(planned);
      run.log('INFO', `${s.fullName}, NRIC ${s.nric}`);
      const funnel = await openFunnel(page, run, 'Health: Direct Hospital Income Benefit');
      // The last page before payment is "Aqad & Declaration" (no PAY button): that is where the walk stops.
      const onAqad = async (p: typeof funnel) => /DECLARATION OF AQAD/i.test((await p.locator('body').innerText().catch(() => '')) ?? '');
      const result = await new Walker(funnel, run, answersFor(s, person), 'hib', onAqad).walk();
      expect(result.reachedSummary).toBe(true);
      if (isPhone(funnel)) { run.log('PASS', 'Phone size: stopping at the Summary page (content checks run on desktop)'); run.stoppedAt('Summary (phone size)'); return; }

      // The plan the funnel is selling, and its price, are shown beside the declarations.
      const text = await pageText(funnel);
      // on a phone the plan details are collapsed, so only the price is checked there
      if ((funnel.viewportSize()?.width ?? 1280) > 600) {
        expect(text).toContain('DAILY ALLOWANCE');
        expect(text).toContain('RM200');
      }
      const price = text.match(/CONTRIBUTION AMOUNT\s*RM\s*([\d,]+\.\d{2})/)?.[1];
      expect(price, 'a contribution amount should be shown').toBeTruthy();
      run.fact('contribution amount', `RM${price}`);

      // Continue (which goes on to payment) must stay disabled until the mandatory declarations are ticked.
      const next = funnel.getByRole('button', { name: /^continue$/i });
      await expect(next).toBeDisabled();
      const tick = async (label: RegExp) => funnel.getByText(label).first().locator('xpath=preceding::input[@type="checkbox"][1] | preceding-sibling::*[1]').first().click({ force: true });
      await tick(/I hereby agree to participate/i);
      await tick(/I have read and agreed to the/i);
      await tick(/I hereby declare and agree/i);
      await expect(next).toBeEnabled();
      run.log('PASS', 'Continue is disabled until the mandatory declarations are ticked, and enabled after');
      await run.shot(funnel, 'declarations-ticked', { mask: false });
      // Continue goes on to payment, so it is deliberately not pressed.
      run.stoppedAt('Aqad & Declaration (Continue to payment not pressed)');
    });
  }
});
