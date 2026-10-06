export function addDays(base: Date, days: number): Date {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

/** "15 October 2026", the accessible name of a calendar day cell. */
export function cellLabel(d: Date): string {
  return `${d.getDate()} ${d.toLocaleString('en-GB', { month: 'long' })} ${d.getFullYear()}`;
}

/** "15/10/2026", how the funnel displays dates in inputs. */
export function slashDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}
