/** Numeric utilities. `percentChange` is the one function here that throws. */

/** `value` pulled into `[min, max]`. Throws `RangeError` when the bounds are inverted. */
export function clamp(value: number, min: number, max: number): number {
  if (min > max) throw new RangeError(`empty range: [${min}, ${max}]`);
  return Math.min(Math.max(value, min), max);
}

/** `value` rounded to `decimals` places, half away from zero. Negative `decimals` rounds to tens, hundreds… */
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const scaled = value * factor;
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return rounded / factor;
}

/** Change from `from` to `to` as a fraction of `from`. Throws `RangeError` when `from` is 0. */
export function percentChange(from: number, to: number): number {
  if (from === 0) throw new RangeError("percent change from zero is undefined");
  return (to - from) / Math.abs(from);
}

/** Greatest common divisor of the magnitudes of `a` and `b`. `gcd(0, 0)` is 0. */
export function gcd(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

/** Arithmetic mean. An empty list has a mean of 0. */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

/** Median of a copy of `values`; the mean of the middle two when the count is even. Empty gives 0. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}
