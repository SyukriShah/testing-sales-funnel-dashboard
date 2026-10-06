import fs from 'node:fs';
import path from 'node:path';
import { loadOverrides } from '../support/overrides';

export type Entry = {
  label: string;
  /** category page slug, e.g. "car-takaful" */
  category: string;
  /** the button's id is form_cta_<cta>_quote */
  cta: string;
  /** funnel: "Get Quote", opens an online funnel. enquiry: "Talk to Us", opens a product page with an enquiry form. */
  kind: 'funnel' | 'enquiry';
  /** pathname the entry page must have (funnels). Omitted where the funnel lives on another host. */
  expectPath?: string;
  note?: string;
};

const ENTRIES: Entry[] = JSON.parse(fs.readFileSync(path.resolve('tests/catalogue/entries.json'), 'utf8'));
export const byLabel = (label: string): Entry => {
  const e = ENTRIES.find((x) => x.label === label);
  if (!e) throw new Error(`Unknown product entry "${label}"`);
  return e;
};

export type Scenario = { id: string; entry: string };

const DEFAULTS: Scenario[] = ENTRIES.map((e, i) => ({ id: `scenario-${i + 1}-${e.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`, entry: e.label }));

/** Scenarios to run: the dashboard's list when supplied, otherwise every product. */
export const SCENARIOS: Scenario[] = (loadOverrides().scenarios as Scenario[] | undefined) ?? DEFAULTS;
