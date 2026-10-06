import fs from 'node:fs';

/**
 * Per-run test data supplied by the dashboard's "Run tests" tab (or any caller).
 * RUN_OVERRIDES points at a JSON file; without it every product uses its built-in defaults.
 * Shape is product-defined, e.g. { scenarios: [...], participant: {...}, flight: {...} }.
 */
export function loadOverrides(): Record<string, any> {
  const file = process.env.RUN_OVERRIDES;
  if (!file) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
