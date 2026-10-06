import { loadOverrides } from '../support/overrides';
import type { Answer } from '../support/walker';
import { commonAnswers } from '../support/answers';
import { isAuto, newPerson, type Person } from '../support/person';

const ov = loadOverrides();
export type Scenario = { id: string; fullName: string; nric: string };

// "AUTO" = a fresh person for every run.
const DEFAULTS: Scenario[] = [{ id: 'scenario-1', fullName: 'AUTO', nric: 'AUTO' }, { id: 'scenario-2', fullName: 'AUTO', nric: 'AUTO' }];
export const SCENARIOS: Scenario[] = (ov.scenarios as Scenario[] | undefined) ?? DEFAULTS;

export function resolve(s: Scenario): { scenario: Scenario; person: Person } {
  const person = newPerson(`${process.env.RUN_ID ?? Date.now()}-${s.id}-${Math.random()}`, [28, 50]);
  return { scenario: { ...s, fullName: isAuto(s.fullName) ? person.fullName : s.fullName, nric: isAuto(s.nric) ? person.nric : s.nric }, person };
}

/** Home Protect specific answers first (extended as the funnel is walked), then the common set. */
export const answersFor = (s: Scenario, p: Person): Answer[] => [
  { label: /./, kind: 'toggle', hasOption: /^home owner/i, value: /^home owner/i },
  { label: /./, kind: 'toggle', hasOption: /brick/i, value: /brick/i },
  { label: /building material/i, kind: 'dropdown', value: /^full brick/i },
  { label: /date/i, kind: 'date', value: '+14' }, // cover starts in two weeks
  ...commonAnswers(s.fullName, s.nric, p),
];
