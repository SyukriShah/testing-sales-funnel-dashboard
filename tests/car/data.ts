import { loadOverrides } from '../support/overrides';
import { loadSecret } from '../support/secrets';

const ov = loadOverrides();

export const SYNTHETIC = 'Synthetic data';
export const SAVED = 'Saved test record';

/** Company-owned test record saved through the dashboard (never stored in the repo or in results). */
export const RECORD = loadSecret('car') as { idType: Scenario['idType']; idNumber: string; vehicleNumber: string } | undefined;

export type Scenario = {
  id: string;
  /** SYNTHETIC: made-up ID + plate, the lookup must say "not found". SAVED: use the saved test record (full journey to Summary). */
  source?: string;
  /** Which car product's "Get Quote" button to use on the car category page. */
  product: string;
  idType: 'NRIC' | 'Passport' | 'Police/Army' | 'Business';
  idNumber: string;
  vehicleNumber: string;
};

const SYNTHETIC_DEFAULTS: Scenario[] = [
  { id: 'scenario-1-nric-plus', product: 'IKHLAS Private Car Comprehensive Plus Takaful', idType: 'NRIC', idNumber: '900101105555', vehicleNumber: 'ZZZ9999' },
  { id: 'scenario-2-nric-comprehensive', product: 'IKHLAS Comprehensive Private Car Takaful', idType: 'NRIC', idNumber: '880923145511', vehicleNumber: 'ZQK4821' },
  { id: 'scenario-3-passport-plus', product: 'IKHLAS Private Car Comprehensive Plus Takaful', idType: 'Passport', idNumber: 'A12345678', vehicleNumber: 'XZW1357' },
];

// When a test record has been saved, the default run also walks the full journey with it.
const DEFAULT_SCENARIOS: Scenario[] = [
  ...SYNTHETIC_DEFAULTS,
  ...(RECORD ? [{ id: 'scenario-4-saved-record', source: SAVED, product: 'IKHLAS Private Car Comprehensive Plus Takaful', idType: RECORD.idType, idNumber: '', vehicleNumber: '' } as Scenario] : []),
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

/**
 * The funnel's Get Quote button ids are the product name, lower-cased and hyphenated:
 * "IKHLAS Private Car Comprehensive Plus Takaful" -> form_cta_ikhlas-private-car-comprehensive-plus-takaful_quote
 */
export const quoteButtonId = (product: string) =>
  `form_cta_${product.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}_quote`;
