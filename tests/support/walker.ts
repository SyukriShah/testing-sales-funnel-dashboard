import { expect, type Page } from '@playwright/test';
import type { Run } from './fixtures';

/**
 * Adaptive walker for the GO direct funnels. Many of them reveal fields as you answer, so instead
 * of one fixed script per page it repeats: look at the page, fill every unfilled control from a
 * table of answers, press the next button, until the Summary page (the one with the PAY button).
 *
 * Safety: it only ever presses next-style buttons, never anything that looks like paying, and it
 * stops with a message naming exactly what it could not answer.
 */

export type Answer = {
  /** matched against the control's label text */
  label: RegExp;
  /** text to type, option/button to pick (regex matches its text), or undefined to leave the control alone */
  value?: string | RegExp;
  /** true: never touch this control (optional field) */
  skip?: boolean;
  /** only for this kind of control (e.g. a catch-all "No" for Yes/No toggles) */
  kind?: 'text' | 'dropdown' | 'toggle' | 'search' | 'native-select' | 'combobox' | 'radio' | 'date';
  /** only for a choice group that offers an option matching this (identifies the right question precisely) */
  hasOption?: RegExp;
  /** also match against the text around the control (for unlabelled boxes, e.g. the unit "CM" / "KG" beside a number box) */
  viaContext?: boolean;
  /** only inside the page section whose heading matches (e.g. "Mailing Address" vs "Employer Address") */
  section?: RegExp;
};

type Control = {
  id: number;
  kind: 'text' | 'dropdown' | 'toggle' | 'search' | 'native-select' | 'combobox' | 'radio' | 'date';
  label: string;
  value: string;
  options: string[];
  needs: boolean;
  /** a plain-looking group of short options (no pointer cursor, no role): only acted on if a specific answer names it */
  weak?: boolean;
  /** the text of the block the control sits in (the question, the unit next to a box), used when the label alone is not enough */
  ctx: string;
  /** the heading of the page section the control is in */
  section: string;
  /** the nearest preceding sentence-length text (for Yes/No choices, the question being asked) */
  question: string;
  placeholder: string;
};

export type WalkResult = { pages: number; reachedSummary: boolean };

// ---- runs inside the browser: finds the page's fillable controls and tags them with data-wk ----
const SCAN = () => {
  // markers from an earlier scan would match first and point at the wrong element
  document.querySelectorAll('[data-wk],[data-wk-g],[data-wk-i]').forEach((e) => { e.removeAttribute('data-wk'); e.removeAttribute('data-wk-g'); e.removeAttribute('data-wk-i'); });
  const vis = (e: Element) => {
    const r = (e as HTMLElement).getBoundingClientRect();
    const s = getComputedStyle(e as HTMLElement);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  const clean = (t: string) => t.replace(/\s+/g, ' ').trim();
  const labelOf = (el: Element): string => {
    const fi = el.closest('form-input');
    if (fi?.getAttribute('label')) return clean(fi.getAttribute('label')!);
    let p: Element | null = el;
    for (let i = 0; i < 6 && p; i++) {
      p = p.parentElement;
      if (!p) break;
      const l = [...p.children].find((c) => c !== el && !c.contains(el) && before(c, el) && clean((c as HTMLElement).innerText || '') !== '' && clean((c as HTMLElement).innerText).length < 90 && !c.querySelector('input,select,form-dropdown,button'));
      if (l) return clean((l as HTMLElement).innerText).split('\n')[0];
    }
    return clean((el as HTMLInputElement).placeholder || el.getAttribute('aria-label') || '');
  };
  const out: Control[] = [];
  let n = 0;
  const ctxOf = (el: Element) => clean((el.parentElement as HTMLElement | null)?.innerText ?? '').slice(0, 260);
  // Section titles are not always heading tags, so also take any short, large-type text (field labels are small).
  const headings = [...document.querySelectorAll('*')].filter((e) => {
    if (!vis(e) || e.querySelector('input,select,textarea,form-input,form-dropdown,button')) return false;
    const own = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent ?? '').join('').trim();
    const t = clean((e as HTMLElement).innerText ?? '');
    return own.length >= 3 && t.length <= 50 && parseFloat(getComputedStyle(e as HTMLElement).fontSize) >= 17;
  });
  const sectionOf = (el: Element) => {
    let last = '';
    for (const h of headings) { if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) last = clean((h as HTMLElement).innerText); else break; }
    return last;
  };
  const questionOf = (el: Element) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let last = '';
    for (let node = w.nextNode(); node; node = w.nextNode()) {
      if (el.contains(node)) break;
      if (!(el.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING)) break;
      const t = clean(node.textContent ?? '');
      if (t.length >= 20 && node.parentElement && vis(node.parentElement)) last = t;
    }
    return last.slice(0, 220);
  };
  const add = (el: Element, c: Omit<Control, 'id' | 'ctx' | 'section' | 'placeholder' | 'question'> & { placeholder?: string }) => {
    el.setAttribute('data-wk', String(++n));
    out.push({ id: n, ctx: ctxOf(el), section: sectionOf(el), question: questionOf(el), placeholder: c.placeholder ?? (el as HTMLInputElement).placeholder ?? '', ...c });
  };

  // text-like inputs (the searchable occupation field is handled as 'search')
  for (const el of document.querySelectorAll('input')) {
    const i = el as HTMLInputElement;
    if (!vis(i) || i.readOnly || i.disabled || ['checkbox', 'radio', 'hidden', 'button', 'submit'].includes(i.type)) continue;
    const invalid = i.classList.contains('ng-invalid') || !!i.closest('form-input')?.querySelector('.ng-invalid');
    const isSearch = /search/i.test(i.placeholder);
    add(i, { kind: isSearch ? 'search' : 'text', label: labelOf(i), value: i.value, options: [], needs: i.value === '' && (invalid || isSearch) });
  }
  // native selects
  for (const el of document.querySelectorAll('select')) {
    const s = el as HTMLSelectElement;
    if (!vis(s) || s.disabled) continue;
    add(s, { kind: 'native-select', label: labelOf(s), value: s.selectedOptions[0]?.text.trim() ?? '', options: [...s.options].map((o) => o.text.trim()), needs: s.selectedIndex <= 0 });
  }
  // custom dropdowns
  for (const el of document.querySelectorAll('form-dropdown')) {
    if (!vis(el)) continue;
    const shown = clean((el as HTMLElement).innerText).split('\n')[0];
    const empty = /please select|select an option|^select\b|^choose/i.test(shown);
    add(el, { kind: 'dropdown', label: labelOf(el), value: empty ? '' : shown, options: [], needs: empty });
  }
  // radio groups (e.g. the e-invoice Yes / No): grouped by name, or by the element that holds them
  const groups = new Map<string, HTMLInputElement[]>();
  const allEls = [...document.querySelectorAll('*')];
  for (const el of document.querySelectorAll('input[type=radio]')) {
    const r = el as HTMLInputElement;
    const box = r.closest('label,div') ?? r;
    if (!vis(box) || r.disabled) continue;
    let key = r.name;
    if (!key) {
      // no name: the group is the nearest ancestor that holds two or more radios
      let a: Element | null = r.parentElement;
      for (let i = 0; i < 5 && a && a.querySelectorAll('input[type=radio]').length < 2; i++) a = a.parentElement;
      key = `grp-${allEls.indexOf(a ?? r)}`;
    }
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const [key, rs] of groups) {
    const gid = ++n;
    const texts = rs.map((r, i) => {
      r.setAttribute('data-wk-g', String(gid)); r.setAttribute('data-wk-i', String(i));
      // the option's text can sit in a label, around the radio, or next to it
      const cands = [
        r.id ? (document.querySelector(`label[for="${CSS.escape(r.id)}"]`) as HTMLElement | null)?.innerText : '',
        (r.closest('label') as HTMLElement | null)?.innerText,
        (r.parentElement as HTMLElement | null)?.innerText,
        (r.nextElementSibling as HTMLElement | null)?.innerText,
        (r.parentElement?.nextElementSibling as HTMLElement | null)?.innerText,
        r.nextSibling?.textContent,
      ].map((t) => clean(t ?? '')).filter((t) => t && t.length < 30);
      return cands[0] ?? '';
    });
    const holder = rs[0].parentElement?.parentElement ?? rs[0];
    out.push({ id: gid, kind: 'radio', label: labelOf(holder), value: rs.some((r) => r.checked) ? 'checked' : '', options: texts, needs: !rs.some((r) => r.checked),
      ctx: clean((holder.parentElement as HTMLElement | null)?.innerText ?? '').slice(0, 260), section: sectionOf(rs[0]), question: questionOf(rs[0]), placeholder: key });
  }
  // plain dropdowns built from a wrapper with a chevron icon (no custom tag): acted on only when a rule names them
  for (const icon of document.querySelectorAll('lucide-angular')) {
    if (!icon.querySelector('path[d="m6 9 6 6 6-6"]') || !vis(icon) || icon.closest('form-dropdown,form-combobox,select')) continue;
    const wrap = icon.closest('div.relative') as HTMLElement | null;
    if (!wrap || !vis(wrap) || wrap.querySelector('input')) continue;
    const shown = clean((wrap.querySelector('span') as HTMLElement | null)?.innerText ?? '');
    add(wrap, { kind: 'dropdown', label: labelOf(wrap), value: shown, options: [], needs: true, weak: true });
  }
  // date pickers shown as a box that says "Select date" (not an input); chosen from a calendar
  for (const el of document.querySelectorAll('*')) {
    if (el.children.length > 0 || !vis(el)) continue;
    if (/^(select|choose|pick) (a )?date$|^dd\/mm\/yyyy$/i.test(clean((el as HTMLElement).innerText ?? ''))) {
      add(el, { kind: 'date', label: labelOf(el), value: '', options: [], needs: true });
    }
  }
  // searchable comboboxes: a closed box that opens a search field and a list (e.g. Occupation)
  for (const el of document.querySelectorAll('form-combobox')) {
    if (!vis(el)) continue;
    const shown = clean((el.querySelector('.select') as HTMLElement | null)?.innerText ?? '');
    const ph = clean(el.getAttribute('selectplaceholder') ?? '');
    const empty = shown === '' || shown === ph || /^search|^select/i.test(shown);
    add(el, { kind: 'combobox', label: labelOf(el), value: empty ? '' : shown, options: [], needs: empty });
  }
  // button-style choice groups: a container of 2-4 short clickable options (Yes / No, Income Earner / Non-Income Earner, pills, cards...)
  const ACTION = /^(back|continue|next|cancel|submit|get (a )?quote|skip.*|edit|close|login|select plan|subscribe)$/i;
  type Cand = { el: Element; kids: Element[]; texts: string[]; clickable: boolean };
  const cands: Cand[] = [];
  for (const el of document.querySelectorAll('div,ul,span,fieldset')) {
    const kids = [...el.children].filter((k) => !['HR', 'BR', 'SCRIPT', 'STYLE'].includes(k.tagName)); // dividers are not options
    if (kids.length < 2 || kids.length > 4 || el.closest('nav,header,footer')) continue;
    const texts = kids.map((k) => clean((k as HTMLElement).innerText ?? ''));
    const shortText = kids.every((k, i) => vis(k) && texts[i].length > 0 && texts[i].length < 90 && !k.querySelector('input,select,textarea'));
    if (!shortText) continue;
    const clickable = kids.every((k) => getComputedStyle(k as HTMLElement).cursor === 'pointer' || k.tagName === 'BUTTON' || ['button', 'radio', 'tab'].includes(k.getAttribute('role') ?? ''));
    const plainLeaves = kids.every((k) => k.children.length === 0);
    if (!clickable && !plainLeaves) continue;
    if (texts.some((t) => ACTION.test(t))) continue; // action bars (Back / Continue) are not questions
    if (kids.some((k) => k.tagName === 'A' || k.querySelector('a')) || texts.some((t) => /disclaimer|privacy|terms|sitemap|brochure|pidm/i.test(t))) continue; // link lists
    cands.push({ el, kids, texts, clickable });
  }
  // A group sitting inside one option of another group (an option card's title + subtitle) is not a question of its own.
  const real = cands.filter((c) => !cands.some((o) => o !== c && o.kids.some((k) => k !== c.el && k.contains(c.el))));
  for (const c of real) {
    // The boxes' styling differs even when nothing is chosen, so "answered" is tracked by the walker, not guessed here.
    add(c.el, { kind: 'toggle', label: labelOf(c.el), value: '', options: c.texts, needs: true, weak: !c.clickable });
  }
  return out;
};

const NEXT = /^(get (a )?quote|continue|next|proceed|confirm|calculate|select plan|choose plan|langgan|subscribe|buy now|seterusnya|teruskan|simpan (&|dan) teruskan|save (&|and) (next|continue)|skip( nomination)?)$/i;
const PAYISH = /(^|\s)(pay|pay now|bayar|checkout|make payment|purchase|place order)(\s|$)/i;

export class Walker {
  /** toggles already answered on the current path (label + choices), so they are not pressed twice */
  private answeredToggles = new Set<string>();
  private togglePath = '';

  constructor(
    readonly page: Page,
    readonly run: Run,
    readonly answers: Answer[],
    readonly slug = 'walk',
    /** funnels whose last page before payment has no PAY button say here how to recognise it */
    readonly stopAt?: (page: Page) => Promise<boolean>,
  ) {}

  private answerFor(c: Control): Answer | undefined {
    return this.answers.find((a) =>
      (!a.kind || a.kind === c.kind) &&
      (!a.section || a.section.test(c.section)) &&
      (!a.hasOption || c.options.some((o) => a.hasOption!.test(o))) &&
      (a.label.test(c.label) || a.label.test(c.placeholder) ||
        // a choice is identified by the question asked; a text box only by its own label unless the answer opts in
        ((c.kind === 'toggle' || c.kind === 'radio' || a.viaContext) && (a.label.test(c.ctx) || a.label.test(c.question)))));
  }

  private async openedOptions(wk: number): Promise<string[]> {
    return this.page.locator(`[data-wk="${wk}"]`).evaluate((el) =>
      [...el.querySelectorAll('span,li,div')].filter((n) => n.children.length === 0 && (n as HTMLElement).innerText?.trim()).map((n) => (n as HTMLElement).innerText.trim()));
  }

  private async clickText(scope: string, match: string | RegExp): Promise<boolean> {
    const rx = typeof match === 'string' ? new RegExp(`^\\s*${match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') : match;
    return this.page.locator(scope).evaluate((root, src) => {
      const re = new RegExp(src.source, src.flags);
      const nodes = [...root.querySelectorAll('span,li,div,button')].filter((n) => n.children.length === 0 && re.test((n as HTMLElement).innerText?.trim() ?? ''));
      const node = nodes[0] as HTMLElement | undefined;
      if (!node) return false;
      (node.closest('[role=option],li,button') ?? node).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      (node as HTMLElement).click();
      return true;
    }, { source: rx.source, flags: rx.flags });
  }

  /** Waits out loading overlays ("Hang tight, we're preparing your plan") so a page is read only once it has settled. */
  async settle() {
    await this.page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {});
    await this.page.waitForFunction(() => !/hang tight|please wait|preparing your|loading\.\.\.|processing/i.test(document.body.innerText), null, { timeout: 25_000 }).catch(() => {});
    await this.page.waitForTimeout(500);
  }

  /** Visible validation messages ("Mobile Number should be numeric...", "Sila isi...") that explain why a button is disabled. */
  async validationMessages(): Promise<string[]> {
    return this.page.evaluate(() => {
      const vis = (e: Element) => { const r = (e as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const re = /required|wajib|sila |please (enter|select|provide|fill)|invalid|tidak sah|should be|must be|mesti|cannot|not valid|format/i;
      return [...new Set([...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && vis(e)).map((e) => (e as HTMLElement).innerText?.replace(/\s+/g, ' ').trim() ?? '').filter((t) => t.length > 8 && t.length < 140 && re.test(t)))].slice(0, 6);
    });
  }

  /** After pressing next: wait until the page differs from what it was (new URL or different controls), up to `ms`. */
  async waitForChange(before: string, ms = 30_000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      await this.page.waitForTimeout(700);
      const now = new URL(this.page.url()).pathname + '|' + (await this.describeControls().catch(() => before));
      if (now !== before) return true;
    }
    return false;
  }

  /** One line per control the page currently shows, for the log: label [kind] needs-answer. */
  async describeControls(): Promise<string> {
    const controls = (await this.page.evaluate(SCAN)) as Control[];
    return controls.map((c) => `${c.section ? c.section.slice(0, 18) + ' > ' : ''}${(/^\d+\.?$/.test(c.label) || !c.label ? (c.question || c.ctx).slice(0, 45) : c.kind === 'toggle' && c.question ? c.question.slice(0, 45) : c.label) || '?'}${c.placeholder && c.kind === 'text' ? ' (' + c.placeholder.slice(0, 18) + ')' : ''} [${c.kind}${c.weak ? ', weak' : ''}${c.needs ? ', needs answer' : ''}${c.kind === 'toggle' ? ': ' + c.options.map((o) => o.slice(0, 22)).join(' | ') : ''}]`).join('; ');
  }

  /** Fills every unfilled control it has an answer for. Returns what it did and what it had no answer for. */
  async fill(): Promise<{ done: string[]; unknown: string[] }> {
    const controls = (await this.page.evaluate(SCAN)) as Control[];
    const done: string[] = [];
    const unknown: string[] = [];
    for (const c of controls) {
      if (!c.needs) continue;
      if (c.kind === 'dropdown' && c.weak && this.answeredToggles.has(`dd|${c.label}`)) continue;
      if (c.kind === 'toggle') {
        const path = new URL(this.page.url()).pathname;
        if (path !== this.togglePath) { this.answeredToggles.clear(); this.togglePath = path; }
        if (this.answeredToggles.has(`${c.label}|${c.question.slice(0, 100)}|${c.options.join('/')}`)) continue;
      }
      const a = this.answerFor(c);
      if (a?.skip) continue;
      if (c.weak && (!a || (a.label.source === '.' && !a.hasOption))) continue; // not clearly a control: leave it alone unless named
      if (!a || a.value === undefined) { unknown.push(`${c.label || '(unlabelled)'} [${c.kind}]`); continue; }
      const sel = c.kind === 'radio' ? `[data-wk-g="${c.id}"]` : `[data-wk="${c.id}"]`;
      const loc = this.page.locator(sel).first();
      try {
        if (c.kind === 'text') {
          // the marker can land on a wrapper (custom form-input element); fill the real field inside it
          const field = (await loc.evaluate((el) => /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || (el as HTMLElement).isContentEditable)) ? loc : loc.locator('input:not([type=hidden]),textarea').first();
          await field.fill(String(a.value));
          await field.blur();
        } else if (c.kind === 'native-select') {
          const wanted = typeof a.value === 'string' ? a.value : (c.options.find((o) => (a.value as RegExp).test(o)) ?? c.options[1]);
          await loc.selectOption({ label: wanted });
        } else if (c.kind === 'dropdown') {
          await loc.click();
          await this.page.waitForTimeout(350);
          const ok = await this.clickText(c.weak ? 'body' : sel, a.value); // plain dropdowns open their list outside their own box
          if (!ok) throw new Error(`option "${a.value}" not offered (offered: ${(await this.openedOptions(c.id)).slice(0, 6).join(' | ')})`);
          if (c.weak) this.answeredToggles.add(`dd|${c.label}`);
        } else if (c.kind === 'toggle') {
          const ok = await this.clickText(sel, a.value);
          if (!ok) throw new Error(`choice "${a.value}" not offered (offered: ${c.options.join(' | ')})`);
          this.answeredToggles.add(`${c.label}|${c.question.slice(0, 100)}|${c.options.join('/')}`);
        } else if (c.kind === 'date') {
          const days = Number(String(a.value).replace('+', '')) || 14;
          const target = new Date(Date.now() + days * 86_400_000);
          await loc.click();
          await this.page.waitForTimeout(700);
          const want = `${target.toLocaleString('en-GB', { month: 'long' })} ${target.getFullYear()}`;
          for (let i = 0; i < 6; i++) {
            const header = this.page.getByRole('button', { name: /^[A-Za-z]+ \d{4}$/ }).first();
            if (((await header.innerText()) ?? '').trim().toLowerCase() === want.toLowerCase()) break;
            await header.evaluate((h) => (h.nextElementSibling as HTMLElement | null)?.click()); // the arrow after the month name
            await this.page.waitForTimeout(400);
          }
          const day = String(target.getDate());
          const clicked = await this.page.getByRole('button', { name: /^[A-Za-z]+ \d{4}$/ }).first().evaluate((h, d) => {
            let box: Element | null = h.parentElement;
            for (let i = 0; i < 6 && box && box.querySelectorAll('*').length < 40; i++) box = box.parentElement; // the calendar popup
            const cell = [...(box?.querySelectorAll('*') ?? [])].find((e) => e.children.length === 0 && (e as HTMLElement).innerText?.trim() === d && !/disabled|muted|other/i.test(e.className.toString() + (e.parentElement?.className.toString() ?? '')));
            if (!cell) return false;
            ((cell.closest('button,td,div[class*="day"]') ?? cell) as HTMLElement).click();
            return true;
          }, day);
          if (!clicked) throw new Error(`could not pick ${day} ${want} in the calendar`);
        } else if (c.kind === 'radio') {
          const wanted = typeof a.value === 'string' ? new RegExp(`^${a.value}$`, 'i') : a.value;
          const idx = c.options.findIndex((o) => wanted.test(o));
          if (idx < 0) throw new Error(`choice "${a.value}" not offered (offered: ${c.options.join(' | ')})`);
          await this.page.locator(`[data-wk-g="${c.id}"][data-wk-i="${idx}"]`).evaluate((r) => { ((r.closest('label') as HTMLElement | null) ?? (r as HTMLElement)).click(); (r as HTMLInputElement).checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); });
        } else if (c.kind === 'combobox') {
          await loc.locator('.select').first().click();
          await this.page.waitForTimeout(400);
          const pickFirst = () => loc.evaluate((el) => {
            const li = [...el.querySelectorAll('li')].find((n) => (n as HTMLElement).innerText?.trim() && (n as HTMLElement).offsetParent !== null);
            if (!li) return false;
            li.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            (li as HTMLElement).click();
            return true;
          });
          await loc.locator('input').first().fill(String(a.value));
          await this.page.waitForTimeout(1200);
          // a keyword with no match falls back to the first entry of the full list, so a missing keyword does not fail the journey
          if (!(await pickFirst())) {
            await loc.locator('input').first().fill('');
            await this.page.waitForTimeout(900);
            if (!(await pickFirst())) throw new Error(`no match for "${a.value}" and the list is empty`);
            this.run.log('WARN', `  "${a.value}" matched nothing in ${c.label}; used the first entry instead`);
          }
        } else if (c.kind === 'search') {
          await loc.click();
          await loc.fill(String(a.value));
          await this.page.waitForTimeout(1200);
          // the first suggestion below the box
          const picked = await loc.evaluate((el) => {
            const root = el.closest('form-dropdown,form-input,div[class*="relative"]') ?? el.parentElement!;
            const item = [...root.querySelectorAll('li,[role=option],div,span')].find((n) => n !== el && n.children.length === 0 && (n as HTMLElement).innerText?.trim() && !n.contains(el) && (n as HTMLElement).innerText.trim().length < 80 && !/search|select occupation/i.test((n as HTMLElement).innerText));
            if (!item) return false;
            (item.closest('li,[role=option]') ?? item).dispatchEvent(new MouseEvent('click', { bubbles: true }));
            (item as HTMLElement).click();
            return true;
          });
          if (!picked) throw new Error(`no suggestion for "${a.value}"`);
        }
        done.push(`${c.label}: ${typeof a.value === 'string' ? a.value : a.value.source}`);
        await this.page.waitForTimeout(250);
      } catch (e) {
        const html = await loc.evaluate((el) => el.outerHTML.slice(0, 300)).catch(() => '(gone)');
        this.run.log('WARN', `  could not answer ${c.label} [${c.kind}]: ${(e as Error).message.split('\n')[0]} ${(e as Error).message.split('\n').slice(1, 6).join(' ').slice(0, 300)} ${html}`);
        unknown.push(`${c.label} [${c.kind}] could not be answered: ${(e as Error).message.split('\n')[0]}`);
      }
    }
    return { done, unknown };
  }

  async isSummary(): Promise<boolean> {
    if (/summary/i.test(this.page.url())) return true;
    if (this.stopAt && (await this.stopAt(this.page))) return true;
    return (await this.page.getByRole('button', { name: /^pay( now)?$/i }).filter({ visible: true }).count()) > 0;
  }

  /**
   * Presses the first enabled next-style button, waiting up to `waitMs` for one to become enabled
   * (fields such as the postcode lookup validate a moment after they are filled). Returns its text, or undefined.
   */
  async next(waitMs = 7_000): Promise<string | undefined> {
    const start = Date.now();
    do {
      const buttons = this.page.getByRole('button').filter({ visible: true });
      const found: { b: ReturnType<typeof buttons.nth>; text: string }[] = [];
      for (let i = 0; i < (await buttons.count()); i++) {
        const b = buttons.nth(i);
        const text = ((await b.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
        if (!NEXT.test(text) || PAYISH.test(text)) continue;
        if (!(await b.isEnabled())) continue;
        found.push({ b, text });
      }
      // a confirmation popup ("Continue without it?") sits above the page's own Continue button: answer it first
      found.sort((x, y) => Number(/^proceed$/i.test(y.text)) - Number(/^proceed$/i.test(x.text)));
      if (found.length) { await found[0].b.click(); return found[0].text; }
      // some funnels use a styled link or box instead of a <button>: look for a next-style label on any element
      const label = await this.page.evaluate(({ src, pay }) => {
        const re = new RegExp(src, 'i'), payRe = new RegExp(pay, 'i');
        document.querySelectorAll('[data-wk-next]').forEach((e) => e.removeAttribute('data-wk-next'));
        const el = [...document.querySelectorAll('a,div,span,li')].find((e) => {
          const r = (e as HTMLElement).getBoundingClientRect();
          const t = ((e as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim();
          return e.children.length === 0 && r.width > 0 && r.height > 0 && re.test(t) && !payRe.test(t) && !/disabled/i.test(e.className.toString() + (e.parentElement?.className.toString() ?? '')) && e.getAttribute('aria-disabled') !== 'true';
        });
        if (!el) return null;
        el.setAttribute('data-wk-next', '1');
        return ((el as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim();
      }, { src: NEXT.source, pay: PAYISH.source });
      if (label) { await this.page.locator('[data-wk-next="1"]').first().click(); return label; }
      await this.page.waitForTimeout(500);
    } while (Date.now() - start < waitMs);
    return undefined;
  }

  async walk(maxPages = 16): Promise<WalkResult> {
    let stalls = 0;
    let lastPrint = '';
    let same = 0;
    for (let n = 1; n <= maxPages; n++) {
      await this.settle();
      const where = new URL(this.page.url()).pathname;
      const heading = (await this.page.locator('h1:visible, h2:visible').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 60);
      if (/payment|checkout/i.test(where)) throw new Error(`Went past the Summary page onto ${where}; the walk must stop before payment`);
      if (await this.isSummary()) {
        this.run.log('PASS', `Page ${n}: Summary reached (${where})`);
        await this.run.shot(this.page, `${this.slug}-${n}-summary`, { mask: false });
        return { pages: n, reachedSummary: true };
      }
      this.run.log('INFO', `Page ${n}: ${where} | ${heading}`);

      // fill, then fill again: answering one control often reveals the next
      let allDone: string[] = [];
      let unknown: string[] = [];
      for (let pass = 0; pass < 6; pass++) {
        const r = await this.fill();
        allDone = allDone.concat(r.done);
        unknown = r.unknown;
        if (!r.done.length) break;
        await this.page.waitForTimeout(500);
      }
      allDone.forEach((d) => this.run.log('INFO', `  filled ${d}`));
      const controlsNow = await this.describeControls();
      this.run.log('INFO', `  controls: ${controlsNow || '(none)'}`);
      // pressing the button again changes nothing: stop and say what is unanswered
      const print = where + '|' + controlsNow;
      same = print === lastPrint && !allDone.length ? same + 1 : 0;
      lastPrint = print;
      if (same >= 2) {
        const msgs = await this.validationMessages();
        throw new Error(`Stopped on ${where} (${heading}): the page does not move on.${msgs.length ? ` The page says: ${msgs.join(' | ')}.` : ''} Controls: ${controlsNow || 'none'}.${unknown.length ? ` No answer for: ${unknown.join('; ')}.` : ''}`);
      }
      await this.run.shot(this.page, `${this.slug}-${n}-${where.split('/').filter(Boolean).pop() ?? 'page'}`, { mask: false });

      const pressed = await this.next();
      if (pressed) {
        this.run.log('INFO', `  pressed "${pressed}"`);
        stalls = 0;
        const moved = await this.waitForChange(print);
        if (!moved) this.run.log('WARN', '  the page did not change after pressing it');
        await this.settle();
      } else {
        stalls++;
        if (stalls >= 2) {
          const msgs = await this.validationMessages();
          throw new Error(`Stopped on ${where} (${heading}): no enabled next button.${msgs.length ? ` The page says: ${msgs.join(' | ')}.` : ''}${unknown.length ? ` Needs an answer this test does not have: ${unknown.join('; ')}.` : ' Nothing left to fill.'}`);
        }
        await this.page.waitForTimeout(1000);
      }
    }
    throw new Error(`Did not reach the Summary page within ${maxPages} pages`);
  }
}

export { expect };
