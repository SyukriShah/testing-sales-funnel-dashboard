import type { Answer } from './walker';
import type { Person } from './person';

/**
 * The questions nearly every GO direct funnel asks, with this run's generated person. Products put their own,
 * more specific answers first (the first matching answer wins) and append this set.
 */
export function commonAnswers(fullName: string, nric: string, p: Person, opts: { mobileWithCountryCode?: boolean } = {}): Answer[] {
  return [
    { label: /full name|^name$/i, kind: 'text', value: fullName },
    { label: /^nric|ic number|identity|id number/i, kind: 'text', value: nric },
    { label: /gender/i, skip: true },
    { label: /mobile|phone/i, kind: 'text', value: opts.mobileWithCountryCode ? '60' + p.mobile.slice(1) : p.mobile.slice(1) },
    { label: /e-?mail/i, kind: 'text', value: p.email },
    { label: /^line 1$|address line 1|address 1|^address$/i, kind: 'text', value: p.addressLine1 },
    { label: /^line 2$|address line 2|address 2/i, skip: true },
    { label: /^line 3$/i, skip: true },
    { label: /postcode|50450/i, kind: 'text', value: p.postcode },
    { label: /employer/i, kind: 'text', value: 'DUMMY ENTERPRISE SDN BHD' },
    { label: /marital/i, kind: 'dropdown', value: /^single$/i },
    { label: /occupation/i, kind: 'combobox', value: 'accountant' },
    { label: /bank name/i, kind: 'combobox', value: 'maybank' },
    { label: /bank name/i, kind: 'native-select', value: /^maybank berhad/i },
    { label: /bank account|account number/i, kind: 'text', value: '123456789012' }, // Maybank accounts are 12 digits
    { label: /./, kind: 'toggle', value: /^no$/i },
    { label: /./, kind: 'radio', value: /^no$/i },
  ];
}

/** The same questions as `commonAnswers` for funnels shown in Bahasa Malaysia (e.g. Personal Accident). */
export function malayAnswers(fullName: string, nric: string, p: Person): Answer[] {
  return [
    { label: /kad pengenalan|no\.? ?kp/i, kind: 'text', value: nric },
    { label: /^nama$/i, kind: 'text', value: fullName },
    { label: /emel/i, kind: 'text', value: p.email },
    { label: /telefon|no\.? ?tel/i, kind: 'text', value: p.mobile },
    { label: /alamat 1/i, kind: 'text', value: p.addressLine1 },
    { label: /alamat 2|alamat 3/i, skip: true },
    { label: /poskod/i, kind: 'text', value: p.postcode },
    { label: /majikan/i, kind: 'text', value: 'DUMMY ENTERPRISE SDN BHD' },
    { label: /nombor akaun/i, kind: 'text', value: '123456789012' },
    { label: /nama bank/i, kind: 'native-select', value: /^maybank berhad/i },
    { label: /nama bank/i, kind: 'combobox', value: 'maybank' },
    { label: /taraf perkahwinan/i, kind: 'dropdown', value: /bujang|single/i },
    { label: /pekerjaan/i, kind: 'combobox', value: 'accountant' },
  ];
}
