/** Array utilities. Every function returns a new array and never mutates its input. */

/** `xs` split into runs of `size`; the last run is short when it does not divide evenly. */
export function chunk<T>(xs: readonly T[], size: number): T[][] {
  if (size < 1) throw new RangeError(`chunk size must be at least 1, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** `xs` with later duplicates dropped, first occurrence wins. SameValueZero equality. */
export function unique<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

/** Pairs up to the length of the shorter input. */
export function zip<A, B>(as: readonly A[], bs: readonly B[]): Array<[A, B]> {
  const out: Array<[A, B]> = [];
  const limit = Math.min(as.length, bs.length);
  for (let i = 0; i < limit; i += 1) out.push([as[i] as A, bs[i] as B]);
  return out;
}

/** `xs` rotated left by `by` positions; negative rotates right. An empty array is returned as-is. */
export function rotate<T>(xs: readonly T[], by: number): T[] {
  if (xs.length === 0) return [];
  const offset = ((by % xs.length) + xs.length) % xs.length;
  return [...xs.slice(offset), ...xs.slice(0, offset)];
}

/** The longest leading run of `xs` for which `predicate` holds. */
export function takeWhile<T>(xs: readonly T[], predicate: (item: T, index: number) => boolean): T[] {
  const out: T[] = [];
  for (let i = 0; i < xs.length; i += 1) {
    const item = xs[i] as T;
    if (!predicate(item, i)) break;
    out.push(item);
  }
  return out;
}
