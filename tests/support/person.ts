/**
 * Fresh dummy Malaysian participants. Funnels that save a quotation (Basic Term returns "409 Conflict"
 * for a person it has already quoted) cannot reuse one fixed person, so tests ask for a new one per run.
 * Deterministic for a given seed (run id + scenario), random between runs.
 */
export type Person = {
  fullName: string;
  nric: string;
  gender: 'Male' | 'Female';
  age: number;
  email: string;
  mobile: string;
  addressLine1: string;
  addressLine2: string;
  postcode: string;
};

function rng(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = (h ^= h >>> 16) >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const MALE = ['AHMAD', 'MUHAMMAD', 'MOHD', 'AIMAN', 'FARHAN', 'HAFIZ', 'IZZAT', 'DANIEL', 'HAKIM', 'IRFAN', 'SYAFIQ', 'ZAFRAN'];
const FEMALE = ['NUR', 'SITI', 'AISYAH', 'NURUL', 'FARAH', 'HANIS', 'IZZATI', 'SYAZWANI', 'AMIRAH', 'BALQIS'];
const SECOND = ['ADAM', 'AMIR', 'HAZIQ', 'DANISH', 'ARIF', 'IKMAL', 'FATIN', 'AINA', 'NABILA', 'SOFEA', 'QISTINA', 'AFIQ'];
const FATHER = ['AZLAN', 'RAZAK', 'HASSAN', 'ISMAIL', 'KAMARUDDIN', 'ROSLI', 'SULAIMAN', 'YUSOF', 'ZAKARIA', 'OSMAN'];
const STREET = ['Jalan Mawar', 'Jalan Melati', 'Jalan Kenanga', 'Jalan Seroja', 'Jalan Cempaka', 'Jalan Dahlia'];
const TAMAN = ['Taman Mawar', 'Taman Melati', 'Taman Bunga Raya', 'Taman Sri Indah', 'Taman Harmoni', 'Taman Desa'];
const POSTCODE = ['43000', '47500', '40000', '50450', '80000', '10000', '30000', '75000'];
const pad = (n: number, l = 2) => String(n).padStart(l, '0');

export function newPerson(seed: string, ageRange: [number, number] = [25, 45], today = new Date()): Person {
  const r = rng(seed);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
  const int = (n: number) => Math.floor(r() * n);
  const male = r() < 0.5;
  const age = ageRange[0] + int(ageRange[1] - ageRange[0]); // the real age is `age` or one less, never above the range
  const first = pick(male ? MALE : FEMALE), second = pick(SECOND), father = pick(FATHER);
  const dob = new Date(today.getFullYear() - age, int(12), 1 + int(28));
  const last = pick(male ? [1, 3, 5, 7, 9] : [0, 2, 4, 6, 8]);
  const nric = pad(dob.getFullYear() % 100) + pad(dob.getMonth() + 1) + pad(dob.getDate()) + pad(1 + int(16)) + pad(int(1000), 3) + last;
  return {
    fullName: `${first} ${second} ${male ? 'BIN' : 'BINTI'} ${father}`,
    nric,
    gender: male ? 'Male' : 'Female',
    age,
    email: `${first.toLowerCase()}.${father.toLowerCase()}${100 + int(900)}@example.com`,
    mobile: '01' + pick([1, 2, 3, 4, 6, 7, 9]) + pad(int(10_000_000), 7),
    addressLine1: `No. ${1 + int(60)} ${pick(STREET)} ${1 + int(9)}`,
    addressLine2: pick(TAMAN),
    postcode: pick(POSTCODE),
  };
}

/** "AUTO" (or blank) in a scenario means: generate this value fresh for the run. */
export const isAuto = (v: string | undefined) => !v || /^auto$/i.test(v.trim());
