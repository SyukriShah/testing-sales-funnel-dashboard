import { loadOverrides } from '../support/overrides';
import type { Answer } from '../support/walker';
import { isAuto, newPerson, type Person } from '../support/person';

const ov = loadOverrides();

export type Scenario = { id: string; fullName: string; nric: string };

// "AUTO" = a fresh person for every run.
const DEFAULTS: Scenario[] = [
  { id: 'scenario-1', fullName: 'AUTO', nric: 'AUTO' },
  { id: 'scenario-2', fullName: 'AUTO', nric: 'AUTO' },
];
export const SCENARIOS: Scenario[] = (ov.scenarios as Scenario[] | undefined) ?? DEFAULTS;

export function resolve(s: Scenario): { scenario: Scenario; person: Person } {
  const person = newPerson(`${process.env.RUN_ID ?? Date.now()}-${s.id}-${Math.random()}`, [25, 45]);
  return { scenario: { ...s, fullName: isAuto(s.fullName) ? person.fullName : s.fullName, nric: isAuto(s.nric) ? person.nric : s.nric }, person };
}

/** What the Hospital Income Benefit funnel asks, and the answers. Extended as the funnel is walked. */
export const answersFor = (s: Scenario, p: Person): Answer[] => [
  { label: /full name/i, kind: 'text', value: s.fullName },
  { label: /^nric|ic number|identity/i, kind: 'text', value: s.nric },
  { label: /monthly income/i, kind: 'text', value: '5000' },
  { label: /mobile/i, kind: 'text', value: '60' + p.mobile.slice(1) }, // this funnel wants the country code
  { label: /e-?mail/i, kind: 'text', value: p.email },
  { label: /height/i, kind: 'text', value: '170' },
  { label: /weight/i, kind: 'text', value: '65' },
  { label: /^line 1$|address line 1/i, kind: 'text', value: p.addressLine1 },
  { label: /employer/i, kind: 'text', value: 'DUMMY ENTERPRISE SDN BHD' },
  { label: /postcode|50450/i, kind: 'text', value: p.postcode },
  { label: /marital/i, kind: 'dropdown', value: /^single$/i },
  { label: /occupation/i, kind: 'combobox', value: 'accountant' },
  { label: /smok/i, kind: 'dropdown', value: /^no/i },
  { label: /smoking|smoke/i, kind: 'toggle', value: /^no$/i }, // the smoker pills
  { label: /bank name/i, kind: 'combobox', value: 'maybank' },
  { label: /bank name/i, kind: 'native-select', value: /^maybank berhad/i },
  { label: /bank account|account number/i, kind: 'text', value: '123456789012' }, // Maybank accounts are 12 digits
  { label: /./, kind: 'toggle', value: /^no$/i }, // health / lifestyle questions: No
  { label: /./, kind: 'radio', value: /^no$/i },
];
