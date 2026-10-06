import { loadOverrides } from '../support/overrides';
import type { Answer } from '../support/walker';
import { commonAnswers, malayAnswers } from '../support/answers';
import { isAuto, newPerson, type Person } from '../support/person';

const ov = loadOverrides();
export type Scenario = { id: string; plan: string; fullName: string; nric: string };

const PLANS = ['Melindungi', 'Bekerja', 'Membantu', 'Merawat', 'Permata', 'Perdana'];
// "AUTO" = a fresh person for every run.
const DEFAULTS: Scenario[] = PLANS.map((plan, i) => ({ id: `scenario-${i + 1}-${plan.toLowerCase()}`, plan, fullName: 'AUTO', nric: 'AUTO' }));
export const SCENARIOS: Scenario[] = (ov.scenarios as Scenario[] | undefined) ?? DEFAULTS;

/** The catalogue entry (button on the Personal Accident category page) for a plan. */
export const entryLabel = (plan: string) => `Personal Accident: ${plan}`;

export function resolve(s: Scenario): { scenario: Scenario; person: Person } {
  const person = newPerson(`${process.env.RUN_ID ?? Date.now()}-${s.id}-${Math.random()}`, [25, 45]);
  return { scenario: { ...s, fullName: isAuto(s.fullName) ? person.fullName : s.fullName, nric: isAuto(s.nric) ? person.nric : s.nric }, person };
}

/** Personal Accident specific answers first (extended as the funnel is walked), then the common set. */
export const answersFor = (s: Scenario, p: Person): Answer[] => [
  { label: /mobile number/i, kind: 'text', value: '60' + p.mobile.slice(1) }, // the English-labelled plans want 11 digits
  ...malayAnswers(s.fullName, s.nric, p),
  ...commonAnswers(s.fullName, s.nric, p, { mobileWithCountryCode: false }),
];
