// A candidate that is wrong on its own terms — ADR-0042.
//
// The thing under test is not really "does it find contradictions". It is **what it refuses to call
// one**: this sentence is what the single retry is spent on, and a detector that fires on a repeated
// test or on a stateful function replaces one useless sentence with a confidently wrong one. So the
// negative cases below outnumber the positive ones, deliberately.
import { describe, it, expect } from "vitest";
import { findContradiction, describeContradiction } from "../src/verifier/contradiction.js";
import { shouldRetry } from "../src/batch.js";
import { Verdict } from "../src/schemas.js";

const found = (source: string, fn: string) => findContradiction(source, fn);

describe("what is a contradiction", () => {
  it("finds two different results asserted for the same written-out call", () => {
    // Reduced from `arrayDifference:boundary:1` on project-b, which asserted contradictory results for
    // the same call twice over and repeated one test four times character-for-character.
    const source = [
      'import { arrayDifference } from "../src/array";',
      'describe("arrayDifference", () => {',
      '  it("removes the second array\'s members", () => {',
      "    expect(arrayDifference([1, 2], [2])).toEqual([1]);",
      "  });",
      '  it("returns the first array when nothing matches", () => {',
      "    expect(arrayDifference([1, 2], [2])).toEqual([1, 2]);",
      "  });",
      "});",
      "",
    ].join("\n");

    const c = found(source, "arrayDifference");
    expect(c).not.toBeNull();
    expect(c!.call).toBe("arrayDifference([1, 2], [2])");
    expect(c!.expected).toEqual(["[1]", "[1, 2]"]);
    expect(c!.lines).toEqual([4, 7]);
  });

  it("sees through a static method call, which is the idiom on a real Nest codebase", () => {
    const source = 'it("a", () => { expect(Util.isValid("x")).toBe(true); });\n'
      + 'it("b", () => { expect(Util.isValid("x")).toBe(false); });\n';
    expect(found(source, "isValid")?.expected).toEqual(["true", "false"]);
  });

  it("sees through an await", () => {
    const source = 'it("a", async () => { expect(await load("x")).toEqual({ n: 1 }); });\n'
      + 'it("b", async () => { expect(await load("x")).toEqual({ n: 2 }); });\n';
    expect(found(source, "load")?.expected).toEqual(["{ n: 1 }", "{ n: 2 }"]);
  });

  it("says the useful sentence, with both values and both lines in it", () => {
    const source = 'expect(f(1)).toBe(2);\nexpect(f(1)).toBe(3);\n';
    const said = describeContradiction(found(source, "f")!);
    expect(said).toContain("self-contradictory");
    expect(said).toContain("f(1)");
    expect(said).toContain("line 1");
    expect(said).toContain("line 2");
  });
});

describe("what is not a contradiction", () => {
  const notOne: [string, string, string][] = [
    [
      "the same test written twice",
      "f",
      'expect(f(1)).toBe(2);\nexpect(f(1)).toBe(2);\n',
    ],
    [
      "different arguments",
      "f",
      'expect(f(1)).toBe(2);\nexpect(f(2)).toBe(3);\n',
    ],
    [
      // The narrowing that matters most. `x` may have been reassigned and a `beforeEach` may have
      // rebuilt the world between the two, so this says nothing at all about the file.
      "an argument that is read from somewhere",
      "f",
      'expect(f(x)).toBe(2);\nexpect(f(x)).toBe(3);\n',
    ],
    [
      // `toBe` and `toEqual` ask different questions; a value can fail one and satisfy the other.
      "two different matchers",
      "f",
      'expect(f(1)).toBe(2);\nexpect(f(1)).toEqual(3);\n',
    ],
    [
      "a negated assertion, which asserts the opposite",
      "f",
      'expect(f(1)).toBe(2);\nexpect(f(1)).not.toBe(3);\n',
    ],
    [
      "assertions about some other function",
      "g",
      'expect(f(1)).toBe(2);\nexpect(f(1)).toBe(3);\n',
    ],
    [
      "a matcher that asserts a relation rather than a value",
      "f",
      'expect(f(1)).toBeGreaterThan(2);\nexpect(f(1)).toBeGreaterThan(3);\n',
    ],
    [
      "an expectation that is itself computed",
      "f",
      'expect(f(1)).toBe(double(1));\nexpect(f(1)).toBe(3);\n',
    ],
  ];

  for (const [label, fn, source] of notOne) {
    it(`is silent about ${label}`, () => {
      expect(found(source, fn), label).toBeNull();
    });
  }

  it("does not treat formatting as a difference", () => {
    const source = "expect(f( 1 , 2 )).toEqual([ 1 ]);\nexpect(f(1, 2)).toEqual([1]);\n";
    expect(found(source, "f")).toBeNull();
  });
});

// ── what it is allowed to change, which is one sentence ────────────────────────────────────────────

describe("shouldRetry, with a contradiction in hand — ADR-0042 option 1", () => {
  // Parsed, not cast: a Verdict is an iff, and a test that casts past it is asserting against a shape
  // rather than against the contract (`prompts/phase-14-handoff.md` §4.2).
  const failedAtPass = Verdict.parse({
    task_id: "f:boundary:0",
    stage_reached: "pass",
    survived: false,
    compile_ok: true,
    pass_ok: false,
    tautological: false,
    mutation: null,
    error: "expected 1 to be 2",
    timing_ms: { compile: 900, pass: 1_200 },
  });

  it("replaces `compiled but did not pass` with the sentence a worker can act on", () => {
    const c = found("expect(f(1)).toBe(2);\nexpect(f(1)).toBe(3);\n", "f")!;
    expect(shouldRetry(failedAtPass, c).reason).toContain("self-contradictory");
  });

  it("changes nothing else — same decision, and the old sentence when there is no contradiction", () => {
    const c = found("expect(f(1)).toBe(2);\nexpect(f(1)).toBe(3);\n", "f")!;
    expect(shouldRetry(failedAtPass, c).retry).toBe(shouldRetry(failedAtPass).retry);
    expect(shouldRetry(failedAtPass).reason).toBe("compiled but did not pass");
  });

  it("never speaks about a candidate that survived", () => {
    const survivor = Verdict.parse({
      ...failedAtPass,
      stage_reached: "done",
      survived: true,
      pass_ok: true,
      mutation: { score: 1, killed: 2, survived: 0, timeout: 0, no_coverage: 0, killed_ids: ["1", "2"] },
      error: null,
    });
    const c = found("expect(f(1)).toBe(2);\nexpect(f(1)).toBe(3);\n", "f")!;
    expect(shouldRetry(survivor, c).reason).toBe("survived");
  });
});
