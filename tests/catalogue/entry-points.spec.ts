import { test, expect } from '../support/fixtures';
import { EntryPoints } from './EntryPoints';
import { SCENARIOS, byLabel } from './data';

/**
 * Entry-point check for every product on the site (no data is entered, nothing is submitted).
 *  - the category page shows the product's button, with the expected wording
 *  - clicking it opens something that loads (not a browser error page)
 *  - online funnels land on the expected funnel path; enquiry products show their form
 */
test.describe('All products - entry points', () => {
  for (const s of SCENARIOS) {
    test(s.id, async ({ page, run }) => {
      const entry = byLabel(s.entry);
      run.log('INFO', `${entry.label} (${entry.kind === 'funnel' ? 'Get Quote' : 'Talk to Us'})${entry.note ? '; ' + entry.note : ''}`);

      const site = new EntryPoints(page);
      await site.openHomepage();
      await expect(page).toHaveTitle(/IKHLAS/i);
      run.log('PASS', `Homepage loaded: ${page.url()}`);
      await run.shot(page, 'homepage', { fullPage: false });

      const clicked = await site.openCategory(entry.category);
      if (!clicked) run.log('WARN', `Category link not clickable on the homepage; opened ${entry.category} directly`);
      const button = site.button(entry);
      await expect(button, `the category page should list ${entry.label}`).toBeVisible();
      await expect(button).toBeEnabled();
      const wording = (await button.innerText()).trim();
      expect(wording.toLowerCase(), 'button wording').toBe(entry.kind === 'funnel' ? 'get quote' : 'talk to us');
      run.log('PASS', `Category page lists the product with a "${wording}" button`);
      await run.shot(page, 'category', { fullPage: false });

      const { target, opensIn } = await site.openTarget(entry);
      const seen = await site.describe(target);
      run.fact('opens in', opensIn);
      run.fact('entry page path', new URL(seen.url.startsWith('http') ? seen.url : 'http://x/').pathname);
      run.fact('entry page title', seen.title);
      await run.shot(target, 'entry-page', { fullPage: false });

      expect(seen.browserError, `the entry page did not load (browser error page; title "${seen.title}")`).toBe(false);
      expect(seen.textLength, 'the entry page should have content').toBeGreaterThan(150);
      expect(seen.title, 'the entry page needs a title').not.toBe('');
      expect(seen.title, 'the entry page looks like an error page').not.toMatch(/404|not found|error/i);
      run.log('PASS', `Entry page loaded (${opensIn}): ${seen.url}`);

      if (entry.kind === 'funnel') {
        if (entry.expectPath) expect(new URL(seen.url).pathname, 'funnel path').toMatch(new RegExp(entry.expectPath));
        run.log('PASS', entry.expectPath ? `Landed on the expected funnel path ${new URL(seen.url).pathname}` : `Landed on ${new URL(seen.url).host}`);
        run.stoppedAt('Funnel entry page loaded (no data entered)');
      } else {
        const form = await site.enquiryForm(target);
        expect(form.fields, 'enquiry form fields').toBeGreaterThanOrEqual(4);
        await expect(form.submit, 'enquiry form Submit button').toBeVisible();
        run.log('PASS', `Enquiry form is shown (${form.fields} fields, Submit button); nothing submitted`);
        run.stoppedAt('Enquiry form visible (not submitted)');
      }
    });
  }
});
