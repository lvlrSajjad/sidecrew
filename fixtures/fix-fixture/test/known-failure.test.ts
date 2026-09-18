import { describe, it, expect } from "vitest";
import { roundTo } from "../src/money";

/**
 * **This test fails, on purpose, and must keep failing.**
 *
 * A project with pre-existing failures is the normal case — project-a has 23 suites failing on a
 * missing DB env — so the workload-#2a gate compares against a baseline rather than demanding green
 * (ADR-0046, ADR-0048). A fixture whose suite is entirely green could not tell the two rules apart, and
 * the difference between them is the whole reason the baseline exists.
 *
 * `roundTo` rounds half away from zero via `Math.round`, which is the behaviour the rest of the suite
 * pins. Banker's rounding is what somebody once wanted and nobody implemented.
 */
describe("roundTo (known failure)", () => {
  it("rounds half to even", () => {
    expect(roundTo(2.5, 0)).toBe(2);
  });
});
