/**
 * A lookup by name — the way a DI container resolves a string token or `this[name]` dispatches a call.
 *
 * Nothing imports `rateFor` from here, so a reference count, `tsc` and the suite all miss this use. It
 * exists for the `reflective_reference` control (`controls/reflective_reference.json`): renaming or
 * deleting `rateFor` must be refused even though every static check would pass it.
 */
export const RATE_HANDLERS: Record<string, string> = { default: "rateFor" };
