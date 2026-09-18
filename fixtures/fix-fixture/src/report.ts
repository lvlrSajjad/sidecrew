import { subtotal, type Line } from "./money";

/**
 * Planted error #3 — **TS2345**, a `string` where `toFixed` wants a `number`.
 *
 * The obvious fix — retype `places` as `number` — moves the error into `test/report.test.ts`, which
 * calls this with `"2"`. That is deliberate: the gate refuses a change that introduces an error
 * anywhere else, so this task can only be survived by a fix that stays inside the file (ADR-0048).
 */
export function renderTotal(lines: Line[], places: string): string {
  return `Total: ${subtotal(lines).toFixed(places)}`;
}
