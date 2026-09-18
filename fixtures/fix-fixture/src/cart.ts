import { roundTo, subtotal, type Line } from "./money";

export interface Cart {
  lines: Line[];
  /** A fraction between 0 and 1. Absent means no discount. */
  discount?: number;
}

/**
 * Planted error #2 — **TS18048**, `cart.discount` is possibly `undefined`.
 *
 * Every test passes a discount, so the suite is green at the baseline and the arithmetic below is
 * already what the tests pin. The fix is a default, not a change of behaviour.
 */
export function discounted(cart: Cart): number {
  const gross = subtotal(cart.lines);
  return roundTo(gross - gross * cart.discount, 2);
}
