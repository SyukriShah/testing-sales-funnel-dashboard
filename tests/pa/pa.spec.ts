import { test, expect } from '../support/fixtures';
import { Walker } from '../support/walker';
import { openFunnel } from '../support/journey';
import { SCENARIOS, answersFor, entryLabel, resolve } from './data';

/** IKHLAS Personal Accident: quote journey for a plan with a fresh dummy person, up to the page before payment. */
test.describe('IKHLAS Personal Accident - quote journey', () => {
  for (const planned of SCENARIOS) {
    test(planned.id, async ({ page, run }) => {
      const { scenario: s, person } = resolve(planned);
      run.log('INFO', `Plan ${s.plan}; ${s.fullName}, NRIC ${s.nric}`);
      const funnel = await openFunnel(page, run, entryLabel(s.plan));
      const result = await new Walker(funnel, run, answersFor(s, person), 'pa').walk();
      expect(result.reachedSummary).toBe(true);
      run.stoppedAt('Summary (payment not pressed)');
    });
  }
});
