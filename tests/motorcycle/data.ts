import { loadOverrides } from '../support/overrides';
import { loadSecret } from '../support/secrets';

const ov = loadOverrides();

export const SYNTHETIC = 'Synthetic data';
export const SAVED = 'Saved test record';

/** Company-owned test record saved through the dashboard (never stored in the repo or in results). */
export const RECORD = loadSecret('motorcycle') as { idType: Scenario['idType']; idNumber: string; vehicleNumber: string } | undefined;

export type Scenario = {
  id: string;
  /** SYNTHETIC: made-up ID + plate, the lookup must say "not found". SAVED: use the saved test record (full journey to Summary). */
  source?: string;
  idType: 'NRIC' | 'Passport' | 'Police/Army' | 'Business';
  idNumber: string;
  vehicleNumber: string;
};

const SYNTHETIC_DEFAULTS: Scenario[] = [
  { id: 'scenario-1-nric', idType: 'NRIC', idNumber: '900101105555', vehicleNumber: 'ZZZ9999' },
  { id: 'scenario-2-passport', idType: 'Passport', idNumber: 'B7654321', vehicleNumber: 'ZQK4455' },
];

// When a test record has been saved, the default run also walks the full journey with it.
const DEFAULT_SCENARIOS: Scenario[] = [
  ...SYNTHETIC_DEFAULTS,
  ...(RECORD ? [{ id: 'scenario-3-saved-record', source: SAVED, idType: RECORD.idType, idNumber: '', vehicleNumber: '' } as Scenario] : []),
];

/** Scenarios to run: the dashboard's list when supplied, otherwise the defaults. */
export const SCENARIOS: Scenario[] = (ov.scenarios as Scenario[] | undefined) ?? DEFAULT_SCENARIOS;

export const isSaved = (s: Scenario) => (s.source ?? SYNTHETIC) === SAVED;

/** The ID and plate a scenario actually uses: the saved record's, or the scenario's own synthetic ones. */
export function credentialsOf(s: Scenario) {
  if (isSaved(s)) {
    if (!RECORD) throw new Error('No saved test record. Save one in the dashboard (Run tests > Saved test record) first.');
    return RECORD;
  }
  return { idType: s.idType, idNumber: s.idNumber, vehicleNumber: s.vehicleNumber };
}

/** The motorcycle product's Get Quote button on the category page. */
export const QUOTE_BUTTON_ID = 'form_cta_ikhlas-motorcycle-takaful_quote';
