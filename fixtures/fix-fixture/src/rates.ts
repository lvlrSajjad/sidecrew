import { roundTo } from "./money";

/**
 * Planted error #1 — **TS2538**, `undefined` used as an index type.
 *
 * At runtime this is already correct: `rates[undefined]` is `undefined` and `?? 0` catches it, which is
 * exactly the behaviour `test/rates.test.ts` pins. Only the types are wrong, which is what makes it a
 * behaviour-preserving fix rather than a bug fix — see the fixture README.
 */
export function rateFor(rates: Record<string, number>, code: string | undefined): number {
  return rates[code] ?? 0;
}

export function convert(amount: number, rates: Record<string, number>, code: string | undefined): number {
  return roundTo(amount * rateFor(rates, code), 2);
}
