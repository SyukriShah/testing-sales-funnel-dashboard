import { loadOverrides } from '../support/overrides';
import type { Answer } from '../support/walker';
import { isAuto, newPerson, type Person } from '../support/person';

const ov = loadOverrides();

export type Scenario = {
  id: string;
  fullName: string;
  nric: string;
  smoker: string;
  incomeStatus: string;
  occupation: string;
  income: number;
};

// "AUTO" = a fresh person is generated for every run (the quotation service refuses to quote the same person twice).
const DEFAULTS: Scenario[] = [
  { id: 'scenario-1', fullName: 'AUTO', nric: 'AUTO', smoker: "No, I don't smoke", incomeStatus: 'Income Earner', occupation: 'engineer', income: 5000 },
  { id: 'scenario-2', fullName: 'AUTO', nric: 'AUTO', smoker: "No, I don't smoke", incomeStatus: 'Income Earner', occupation: 'accountant', income: 3800 },
];

export const SCENARIOS: Scenario[] = (ov.scenarios as Scenario[] | undefined) ?? DEFAULTS;

/**
 * The scenario with any AUTO values filled in, plus a freshly generated person for the contact, address
 * and bank details the funnel asks for later. A new person every run (age 25-45).
 */
export function resolve(s: Scenario): { scenario: Scenario; person: Person } {
  const person = newPerson(`${process.env.RUN_ID ?? Date.now()}-${s.id}-${Math.random()}`, [25, 45]);
  return { scenario: { ...s, fullName: isAuto(s.fullName) ? person.fullName : s.fullName, nric: isAuto(s.nric) ? person.nric : s.nric }, person };
}

/** What the Basic Term funnel asks, and the answer for this scenario. Order does not matter. */
export const answersFor = (s: Scenario, p: Person): Answer[] => [
  { label: /full name/i, kind: 'text', value: s.fullName },
  { label: /^nric$/i, kind: 'text', value: s.nric },
  { label: /gender/i, skip: true }, // filled by the site from the NRIC
  { label: /smoker/i, value: new RegExp(s.smoker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 14), 'i') },
  { label: /income status/i, kind: 'toggle', value: s.incomeStatus },
  { label: /occupation/i, kind: 'combobox', value: s.occupation },
  { label: /net monthly income/i, kind: 'text', value: String(s.income) },
  { label: /employer.*malaysia/i, value: 'Yes' },
  { label: /coverage term/i, value: '10 Years' },
  { label: /payment mode/i, value: /^monthly$/i },
  // Takaful participant details (mobile has a +60 prefix already, so no leading 0)
  { label: /mobile/i, kind: 'text', value: p.mobile.slice(1) },
  { label: /e-?mail/i, kind: 'text', value: p.email },
  { label: /marital/i, kind: 'dropdown', value: /^single$/i },
  { label: /address line 1/i, kind: 'text', section: /mailing/i, value: p.addressLine1 },
  { label: /postcode|50450/i, kind: 'text', section: /mailing/i, value: p.postcode },
  { label: /name of employer/i, kind: 'text', value: 'DUMMY ENTERPRISE SDN BHD' },
  { label: /address line 1/i, kind: 'text', section: /employer/i, value: p.addressLine2 + ' ' + p.addressLine1 },
  { label: /postcode|50450/i, kind: 'text', section: /employer/i, value: p.postcode },
  { label: /bank name/i, kind: 'combobox', value: 'maybank' },
  { label: /bank account/i, kind: 'text', value: '123456789012' },
  { label: /./, kind: 'radio', value: /^no$/i }, // e-invoice (LHDN) and MSIC questions: No
  // Lifestyle & health details
  { label: /\bcm\b/i, kind: 'text', viaContext: true, value: '170' },
  { label: /\bkg\b/i, kind: 'text', viaContext: true, value: '65' },
  { label: /./, kind: 'toggle', value: /^no$/i }, // every health / lifestyle question: No
];
