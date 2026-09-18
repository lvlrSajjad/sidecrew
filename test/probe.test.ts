// The probe's classifier, which is the one part of `scripts/probe-mutants.ts` that is a decision rather
// than plumbing.
//
// It is here rather than in the script because ADR-0018 turned it into a rule the planner is held to:
// plan only what comes back `yes`. The three other answers all mean "a candidate for this can never
// survive", and telling them apart is the whole value — `crash_only` in particular looks exactly like
// "the test caught nothing" if you only read `killed`.
import { describe, it, expect } from "vitest";
import { classifyProbe } from "../src/verifier/probe.js";

describe("classifyProbe", () => {
  it("says yes as soon as one mutant died of an assertion", () => {
    expect(classifyProbe({ mutants: 8, killed: 1, survived: 7, timeout: 0 })).toBe("yes");
    expect(classifyProbe({ mutants: 1, killed: 1, survived: 0, timeout: 0 })).toBe("yes");
  });

  it("separates `nothing to kill` from `the test killed nothing`", () => {
    expect(classifyProbe({ mutants: 0, killed: 0, survived: 0, timeout: 0 })).toBe("no_mutants");
    expect(classifyProbe({ mutants: 3, killed: 0, survived: 3, timeout: 0 })).toBe("unknown");
  });

  it("names the Swift-shaped failure: every mutant crashed instead of failing an assertion", () => {
    // Muter's SwapTernary on Machine.nextState force-unwraps nil. The mutant exists, it is detected, it
    // counts towards the score — and it can never count towards survival (ADR-0005 §2, ADR-0012), so no
    // test of that function could ever survive. Reading `killed` alone cannot see the difference.
    expect(classifyProbe({ mutants: 1, killed: 0, survived: 0, timeout: 1 })).toBe("crash_only");
    expect(classifyProbe({ mutants: 2, killed: 0, survived: 0, timeout: 2 })).toBe("crash_only");
  });

  it("does not call it crash_only when something merely survived alongside a crash", () => {
    // A mixture is unresolved, not hopeless: the survivor might be killable by a better test.
    expect(classifyProbe({ mutants: 2, killed: 0, survived: 1, timeout: 1 })).toBe("unknown");
  });
});

describe("classifyProbe and the stage it never reached — ADR-0030", () => {
  const nothing = { mutants: 0, killed: 0, survived: 0, timeout: 0 };

  it("does not call a broken machine a function with no mutants", () => {
    // The bug this is here for, found on a real 577k-line project: `tsc` ran out of heap and Stryker
    // could not load its own plugins, and eleven ordinary array helpers came back
    // "NOT PLANNABLE — no mutants at all". Every count is zero in both cases, so the counts alone cannot
    // tell "nothing to mutate" from "nothing ran" — and the two mean opposite things to a planner.
    expect(classifyProbe(nothing, "compile")).toBe("not_measured");
    expect(classifyProbe(nothing, "pass")).toBe("not_measured");
    // `mutation` is the mutation tool breaking, which is also not a statement about the function
    // (ADR-0012).
    expect(classifyProbe(nothing, "mutation")).toBe("not_measured");
  });

  it("still answers the real question when the stage actually ran", () => {
    expect(classifyProbe(nothing, "done")).toBe("no_mutants");
    expect(classifyProbe({ mutants: 8, killed: 1, survived: 7, timeout: 0 }, "done")).toBe("yes");
  });

  it("defaults to done, so every existing caller keeps its meaning", () => {
    expect(classifyProbe(nothing)).toBe("no_mutants");
  });
});

describe("classifyProbe and an all-NoCoverage result — ADR-0033", () => {
  it("does not call a runner that never ran the test a weak probe", () => {
    // Every mutant present, none reached: the shape of "jest never found the file". It used to reach
    // `unknown` and print "0 mutant(s) survived this probe; weak probe, or equivalent" — a statement
    // about the test, when nothing about the test was exercised.
    expect(classifyProbe({ mutants: 12, killed: 0, survived: 0, timeout: 0, no_coverage: 12 }, "done"))
      .toBe("not_measured");
  });

  it("still calls a genuinely weak probe weak", () => {
    // Some uncovered mutants is an ordinary result: lines a two-assertion test does not reach.
    expect(classifyProbe({ mutants: 12, killed: 0, survived: 9, timeout: 0, no_coverage: 3 }, "done"))
      .toBe("unknown");
  });

  it("is unchanged for callers that do not report no_coverage", () => {
    expect(classifyProbe({ mutants: 3, killed: 0, survived: 3, timeout: 0 }, "done")).toBe("unknown");
    expect(classifyProbe({ mutants: 8, killed: 1, survived: 7, timeout: 0 })).toBe("yes");
  });
});
