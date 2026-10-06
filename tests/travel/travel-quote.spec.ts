import { test, expect } from '../support/fixtures';
import { isPhone } from '../support/journey';
import { TravelFunnel, addDays } from './TravelFunnel';
import {
  BANK, COVERAGE_AREA_BY_COUNTRY, EINVOICE, FLIGHT, PARTICIPANT, SCENARIOS, TRAVEL_TYPE,
  ageFromNric, genderFromNric,
} from './data';

/**
 * IKHLAS Secure Travel Takaful quote journey.
 * Each scenario is independent and logs/screenshots into runs/<RUN_ID>/<product>/<scenario>/.
 *
 * Scope: Add Ons, Participant Details, Flight Details (including the mandatory Auto Credit
 * bank step, filled with a placeholder account number sized to the chosen bank) and Summary,
 * where the e-invoice question and the declarations are exercised. The journey stops there: PAY is enabled but never clicked, and
 * Payment Details is never opened.
 */

test.describe('IKHLAS Secure Travel Takaful - quote journey', () => {
  test('participant test data is a Malaysian adult aged 18-60', () => {
    const age = ageFromNric(PARTICIPANT.nric);
    expect(age).toBeGreaterThanOrEqual(18);
    expect(age).toBeLessThanOrEqual(60);
    expect(PARTICIPANT.nric).toMatch(/^\d{12}$/);
    expect(['Male', 'Female']).toContain(genderFromNric(PARTICIPANT.nric));
  });

  for (const s of SCENARIOS) {
    test(s.id, async ({ page, run }) => {
      const today = new Date();
      const depart = addDays(today, s.departInDays);
      const ret = addDays(depart, s.tripLengthDays);
      const area = COVERAGE_AREA_BY_COUNTRY[s.country];
      if (!area) throw new Error(`No coverage area mapped for destination "${s.country}"`);
      run.log('INFO', `${s.country} (${area}), ${s.purpose} -> travel type "${TRAVEL_TYPE}"; ${depart.toDateString()} to ${ret.toDateString()}; plan #${s.planPosition}`);
      run.log('WARN', `Funnel has no country or Leisure/Business field; "${s.country}" maps to coverage area "${area}" and "${s.purpose}" to "${TRAVEL_TYPE}"`);

      // 1-3. Homepage
      const home = new TravelFunnel(page);
      await home.openHomepage();
      await expect(page).toHaveTitle(/IKHLAS/i);
      run.log('PASS', `Homepage loaded: ${page.url()}`);
      await run.shot(page, 'homepage');

      // Travel category
      await home.openTravelCategory();
      run.log('PASS', `Travel page: ${page.url()}`);
      await run.shot(page, 'travel-category');

      // Get Quote -> funnel (new tab)
      const funnel = await home.openSecureTravelQuote();
      run.log('PASS', `Quote funnel opened: ${funnel.page.url()}`);
      await expect(funnel.page.getByRole('heading', { name: 'Secure Travel', level: 1, exact: true }).first()).toBeVisible(); // the page has several level-1 headings that contain these words
      await run.shot(funnel.page, 'funnel-landing');

      // Trip details
      await funnel.chooseSingleReturn();
      await funnel.selectDestination(area);
      await funnel.selectTravelPeriod(depart, ret);
      await funnel.selectTravelType(TRAVEL_TYPE);
      await run.shot(funnel.page, 'trip-details');
      await funnel.getQuote();

      // Plan
      const count = await funnel.plans().count();
      run.log('INFO', `${count} plans offered`);
      run.fact('plans offered', await funnel.planSummaries());
      const plan = await funnel.selectPlan(s.planPosition);
      if (plan.usedFallback) run.log('WARN', `Plan #${s.planPosition} not available; used last plan "${plan.name}"`);
      run.log('PASS', `Selected plan: ${plan.name}`);
      await run.shot(funnel.page, 'plans');
      await funnel.continueTo(/\/quote\/add-ons/);

      // Add ons (plan details recap must match what was chosen)
      // .first(): for Domestic the area name also appears as the plan name
      await expect(funnel.page.getByText(area, { exact: true }).first()).toBeVisible();
      await expect(funnel.page.getByText('Individual', { exact: true }).first()).toBeVisible();
      await expect(funnel.page.getByText(new RegExp(plan.name, 'i')).first()).toBeVisible();
      run.log('PASS', 'Add Ons: plan details recap matches selection');
      await run.shot(funnel.page, 'add-ons');
      await funnel.skipAddOns();

      // Participant
      await funnel.fillParticipant(PARTICIPANT);
      const addr = await funnel.expectAutoFilledAddress();
      run.log('PASS', `Participant details filled; postcode ${PARTICIPANT.postcode} auto-filled city/state (${addr.city}, ${addr.state})`);
      await run.shot(funnel.page, 'participant-details');
      await funnel.continueTo(/\/quote\/flight-details/);

      // Flight details
      await funnel.fillFlights(FLIGHT);
      await funnel.expectFlightDates(depart, ret);
      run.log('PASS', 'Flight details filled; dates carried over from trip details');

      // Auto Credit is mandatory: Continue must be blocked until a bank and account number are given.
      await funnel.page.getByRole('button', { name: 'CONTINUE' }).click();
      await expect(funnel.autoCreditErrors().first()).toBeVisible();
      run.log('PASS', 'Auto Credit required: empty bank/account number blocks Continue');

      const credit = await funnel.fillAutoCredit(BANK.name);
      run.log('INFO', `Auto Credit: ${credit.bank}, dummy account no. of ${credit.accountNo.length} digits (length taken from the site's bank list)`);
      await run.shot(funnel.page, 'flight-details');
      await funnel.continueTo(/\/quote\/summary/);
      run.log('PASS', `Summary reached: ${funnel.page.url()}`);
      if (isPhone(funnel.page)) { run.log('PASS', 'Phone size: stopping at the Summary page (content checks run on desktop)'); await run.shot(funnel.page, 'summary'); run.stoppedAt('Summary (phone size)'); return; }

      // Summary must echo back exactly what was entered.
      const ci = (t: string) => new RegExp(`^\\s*${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
      const on = funnel.page;
      await expect(on.getByRole('heading', { name: 'Summary', level: 1 })).toBeVisible();
      await expect(on.getByText(area, { exact: true }).first()).toBeVisible();
      await expect(on.getByText(ci(plan.name)).first()).toBeVisible();
      await expect(on.getByText(ci(PARTICIPANT.fullName)).first()).toBeVisible();
      await expect(on.getByText(PARTICIPANT.nric, { exact: true })).toBeVisible();
      await expect(on.getByText(PARTICIPANT.email, { exact: true })).toBeVisible();
      await expect(on.getByText(`60${PARTICIPANT.mobile.replace(/^0/, '')}`, { exact: true })).toBeVisible(); // site stores +60 form
      await expect(on.getByText(ci(PARTICIPANT.addressLine1))).toBeVisible();
      await expect(on.getByText(PARTICIPANT.postcode, { exact: true })).toBeVisible();
      await expect(on.getByText(FLIGHT.outboundNo, { exact: true })).toBeVisible();
      await expect(on.getByText(FLIGHT.returnNo, { exact: true })).toBeVisible();
      await expect(on.getByText(ci(credit.bank)).first()).toBeVisible();
      await expect(on.getByText(credit.accountNo, { exact: true })).toBeVisible();
      const total = await funnel.totalContribution();
      run.fact('total contribution', total);
      run.fact('destination shown on summary', area);
      expect(total, 'Summary should show a total contribution').toMatch(/RM\s?\d/);
      await expect(funnel.payButton()).toBeDisabled(); // nothing ticked yet
      run.log('PASS', `Summary matches entered data; total contribution ${total}; PAY disabled until declarations are ticked`);
      await run.shot(on, 'summary');

      // E-invoice (LHDN) question
      await funnel.answerEinvoice(s.einvoice);
      if (s.einvoice === 'Yes') {
        // TIN is required (min 10 chars); SST is optional.
        await expect(funnel.tinInput()).toBeVisible();
        await expect(funnel.sstInput()).toBeVisible();
        await funnel.tinInput().focus();
        await funnel.tinInput().blur();
        await expect(on.getByText('Please enter your TIN number')).toBeVisible();
        await funnel.tinInput().fill('abc');
        await funnel.tinInput().blur();
        await expect(on.getByText('TIN number must not be less than 10 characters.')).toBeVisible();
        await funnel.tinInput().fill(EINVOICE.tin);
        if (EINVOICE.sst) await funnel.sstInput().fill(EINVOICE.sst);
        await funnel.tinInput().blur();
        await expect(on.getByText(/TIN number must not be less|Please enter your TIN number/)).toHaveCount(0);
        run.log('PASS', 'E-invoice Yes: TIN required and length-checked, accepted a valid TIN');
      } else {
        await expect(funnel.tinInput()).toHaveCount(0);
        run.log('PASS', 'E-invoice No: TIN/SST fields stay hidden');
      }

      // Declarations: both mandatory ticks are needed before PAY is enabled. PAY is never clicked.
      await funnel.tickDeclaration(/I hereby confirm that I have read/);
      await expect(funnel.payButton()).toBeDisabled();
      await funnel.tickDeclaration(/I hereby consent to the processing/);
      await expect(funnel.payButton()).toBeEnabled();
      if (s.marketing === 'Yes') {
        await funnel.tickDeclaration(/I expressly agree to receive/);
        await expect(funnel.payButton()).toBeEnabled(); // the optional tick must not change this
      }
      expect(on.url()).toMatch(/\/quote\/summary/); // ticking must not navigate anywhere
      expect(on.context().pages().length, 'no extra tab (e.g. PDS) should have opened').toBe(2);
      run.log('PASS', `Declarations: PAY stays disabled with one tick, enabled after both mandatory ticks${s.marketing === 'Yes' ? ' (optional marketing tick also set)' : ''}`);
      await run.shot(on, 'summary-ready-to-pay');

      // Stop here: PAY is enabled but NOT clicked, so Payment Details is never opened.
      run.stoppedAt('Summary (declarations ticked, PAY enabled but not clicked)');
    });
  }
});
