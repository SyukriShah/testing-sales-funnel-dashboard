import { test, expect } from '../support/fixtures';
import { Walker } from '../support/walker';
import { openFunnel } from '../support/journey';
import { SCENARIOS, answersFor, resolve } from './data';

/** IKHLAS Home Protect: quote journey with a fresh dummy person, up to the page before payment. */
test.describe('IKHLAS Home Protect - quote journey', () => {
  for (const planned of SCENARIOS) {
    test(planned.id, async ({ page, run }) => {
      const { scenario: s, person } = resolve(planned);
      run.log('INFO', `${s.fullName}, NRIC ${s.nric}`);
      const funnel = await openFunnel(page, run, 'Home: Home Protect');
      const result = await new Walker(funnel, run, answersFor(s, person), 'home').walk();
      expect(result.reachedSummary).toBe(true);
      run.stoppedAt('Summary (payment not pressed)');
    });
  }
});
