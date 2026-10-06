import { test, expect } from '../support/fixtures';
import { MotorcycleFunnel } from './MotorcycleFunnel';
import { Walker } from '../support/walker';
import { commonAnswers } from '../support/answers';
import { newPerson } from '../support/person';
import { SCENARIOS, credentialsOf, isSaved } from './data';

/**
 * IKHLAS Motorcycle Takaful funnel: entry path and vehicle lookup.
 *
 * The funnel is a renewal lookup: it checks the ID + vehicle number against company records.
 * Synthetic data must therefore come back as "Data not found". That proves the page, the form
 * and the lookup service all respond, without touching a real customer's record. If a pair ever
 * matches a record (the page moves on to a quote), the test stops and FAILS rather than carry on
 * with someone's real vehicle. A full journey to Summary needs a company-owned test record.
 */

// A saved test record can be typed into these pages, and traces / failure screenshots would keep a copy
// of it inside the run folder. Our own screenshots are flagged sensitive instead (see run.sensitive()).
test.use({ trace: 'off', screenshot: 'off' });

test.describe('IKHLAS Motorcycle Takaful - entry and vehicle lookup', () => {
  for (const s of SCENARIOS) {
    test(s.id, async ({ page, run }) => {
      const cred = credentialsOf(s);
      const saved = isSaved(s);
      if (saved) run.sensitive(); // screenshots will show the saved record: keep them local
      run.log('INFO', saved
        ? `SAVED test record (${cred.idType} ending ${cred.idNumber.slice(-4)}), full journey`
        : `${cred.idType} ${cred.idNumber}, vehicle ${cred.vehicleNumber} (synthetic)`);

      const home = new MotorcycleFunnel(page);
      await home.openHomepage();
      await expect(page).toHaveTitle(/IKHLAS/i);
      run.log('PASS', `Homepage loaded: ${page.url()}`);
      await run.shot(page, 'homepage');

      await home.openCategory();
      run.log('PASS', `Motorcycle page: ${page.url()}`);
      await run.shot(page, 'category');

      const funnel = await home.openQuote();
      await expect(funnel.page.getByRole('heading', { name: 'Motorcycle Takaful', level: 1 })).toBeVisible();
      run.log('PASS', `Quote funnel opened: ${funnel.page.url()}`);
      await run.shot(funnel.page, 'funnel-landing');

      // The button must stay disabled until both fields are filled.
      await expect(funnel.getQuote()).toBeDisabled();
      await funnel.selectIdType(cred.idType);
      await funnel.idNumber().fill(cred.idNumber);
      await expect(funnel.getQuote()).toBeDisabled();
      await funnel.vehicleNumber().fill(cred.vehicleNumber);
      await funnel.vehicleNumber().blur();
      await expect(funnel.getQuote()).toBeEnabled();
      run.log('PASS', 'Get A Quote enables only once ID type, ID number and vehicle number are given');
      await run.shot(funnel.page, 'lookup-form-filled');

      await funnel.getQuote().click();

      if (saved) {
        // Saved test record: the lookup must find it, then the funnel is walked on to Summary (PAY never pressed).
        let outcome = await funnel.lookupOutcome();
        // the lookup service sometimes times out on its own side ("RequestError: Timeout"): dismiss it and ask again, up to twice
        for (let retry = 1; outcome.kind === 'error' && retry <= 2; retry++) {
          run.log('WARN', `Lookup service error: "${outcome.text.slice(0, 90)}"; retrying (${retry}/2)`);
          await funnel.page.getByRole('button', { name: /^ok$/i }).filter({ visible: true }).first().click().catch(() => {});
          await funnel.page.waitForTimeout(3000);
          await funnel.getQuote().click();
          outcome = await funnel.lookupOutcome();
        }
        expect(outcome.kind, `the lookup service itself failed ("${outcome.text}"); this is the site's backend, not the saved record`).not.toBe('error');
        expect(outcome.kind, `the saved test record was not found by the lookup ("${outcome.text}"); check the ID and plate saved in the dashboard`).toBe('moved');
        run.log('PASS', 'Lookup found the saved record and moved on');
        // Walk the funnel with the shared walker. A real record is already known to the funnel, so only blank fields it asks
        // for (contact details etc.) get dummy values. It stops at the Summary / PAY page and never presses PAY.
        const person = newPerson(`${process.env.RUN_ID ?? Date.now()}-${s.id}`, [28, 50]);
        const answers = commonAnswers(person.fullName, '', person);
        const { pages } = await new Walker(funnel.page, run, answers, 'motorcycle').walk();
        run.log('PASS', `Reached the Summary page after ${pages} page(s)`);
        // the walker only reports success on the Summary page; check the address too (the button wording varies)
        await expect(funnel.page).toHaveURL(/summary/i);
        await expect(funnel.page.getByText(/summary/i).filter({ visible: true }).first()).toBeVisible();
        run.stoppedAt('Summary (PAY not clicked)');
        return;
      }

      const message = await funnel.lookupMessage();
      run.fact('lookup response', message);
      // Safety stop: a quote page means this synthetic pair matched a real record.
      expect(funnel.page.url(), 'synthetic ID + plate must not match a real record').toMatch(/\/direct\/motorcycle\/?$/);
      expect(message).toMatch(/001/);
      expect(message).toMatch(/Data not found/i);
      run.log('PASS', `Lookup service answered as expected: "${message.slice(0, 90)}"`);
      await run.shot(funnel.page, 'lookup-response');

      await funnel.dismissMessage();
      await expect(funnel.getQuote()).toBeVisible();
      run.stoppedAt('Vehicle lookup (synthetic data returns "Data not found")');
    });
  }
});
