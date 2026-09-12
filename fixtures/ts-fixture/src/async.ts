/** The asynchronous corner of the fixture. Deterministic: no timers, no clock, no I/O. */

/** `fn` applied to each item strictly in order, awaiting each before starting the next. */
export async function mapSeries<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => R | Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += 1) out.push(await fn(items[i] as T, i));
  return out;
}

/**
 * The result of the first task that resolves, trying them in order. Rejects with an `AggregateError`
 * carrying every failure when no task resolves — including when there are no tasks.
 */
export async function firstSuccessful<T>(tasks: readonly (() => Promise<T>)[]): Promise<T> {
  const errors: unknown[] = [];
  for (const task of tasks) {
    try {
      return await task();
    } catch (e) {
      errors.push(e);
    }
  }
  throw new AggregateError(errors, `all ${tasks.length} tasks failed`);
}
