// ADR-0089: a type-only assertion survived workload #1's gate by killing only the mutant that empties
// the function's body. Option B closes it in the iff; option A flags it before a mutation run is spent.
import { describe, expect, it } from "vitest";
import { shouldRetry } from "../src/batch.js";
import { behaviouralKills, MutationResult, survives, Verdict } from "../src/schemas.js";
import { analyseTautology } from "../src/verifier/tautology.js";
import { bodyMutant, noKillMessage, parseMutationReport } from "../src/verifier/ts.js";

const at = (sl: number, sc: number, el: number, ec: number) => ({ start: { line: sl, column: sc }, end: { line: el, column: ec } });
const mutant = (id: string, mutatorName: string, status: string, location: ReturnType<typeof at>) =>
  ({ id, mutatorName, status, location });

// One function, lines 3–9: its body block, an inner `if` block, and a conditional inside it.
const BODY = mutant("1", "BlockStatement", "Killed", at(3, 40, 9, 1));
const INNER = mutant("2", "BlockStatement", "Survived", at(5, 12, 7, 3));
const COND = mutant("3", "ConditionalExpression", "Survived", at(5, 6, 5, 11));
const report = (...mutants: object[]) => ({ files: { "src/strings.ts": { mutants } } });

describe("bodyMutant — the mutant that removes the whole body (option B)", () => {
  it("is the BlockStatement that contains every other mutant", () => {
    expect(bodyMutant([BODY, INNER, COND])).toBe("1");
  });

  it("is not an inner block, which contains only some", () => {
    expect(bodyMutant([INNER, COND, mutant("4", "StringLiteral", "Killed", at(8, 2, 8, 9))])).toBeNull();
  });

  it("covers an expression-bodied arrow's ArrowFunction mutant", () => {
    const arrow = mutant("7", "ArrowFunction", "Killed", at(2, 20, 2, 60));
    expect(bodyMutant([arrow, mutant("8", "MethodExpression", "Survived", at(2, 30, 2, 50))])).toBe("7");
  });

  it("is a lone BlockStatement — a function whose only mutant is its body gives a test nothing to prove", () => {
    expect(bodyMutant([BODY])).toBe("1");
  });

  it("is null for a whole-file report with two functions' bodies", () => {
    const other = mutant("9", "BlockStatement", "Survived", at(12, 30, 15, 1));
    expect(bodyMutant([BODY, INNER, other])).toBeNull();
  });
});

describe("parseMutationReport records mutators and the body mutant", () => {
  it("names the mutator of every kill, in the order of killed_ids", () => {
    const m = parseMutationReport(report(BODY, INNER, COND, mutant("4", "StringLiteral", "Killed", at(8, 2, 8, 9))), "src/strings.ts");
    expect(m.killed_ids).toEqual(["1", "4"]);
    expect(m.killed_mutators).toEqual(["BlockStatement", "StringLiteral"]);
    expect(m.body_mutant_id).toBe("1");
    expect(behaviouralKills(m)).toBe(1);
  });

  it("counts a body-only kill as no behavioural kill at all", () => {
    const m = parseMutationReport(report(BODY, INNER, COND), "src/strings.ts");
    expect(m.killed).toBe(1);
    expect(behaviouralKills(m)).toBe(0);
  });
});

const verdictWith = (mutation: MutationResult, survived: boolean) => ({
  task_id: "slugify:happy_path:0", stage_reached: "done", survived, compile_ok: true, pass_ok: true,
  tautological: false, mutation, error: survived ? null : "x", timing_ms: {},
});

describe("the iff — survival needs a kill other than the body removal", () => {
  const bodyOnly = MutationResult.parse({ score: 0.33, killed: 1, survived: 2, timeout: 0, no_coverage: 0, killed_ids: ["1"], killed_mutators: ["BlockStatement"], body_mutant_id: "1" });
  const real = MutationResult.parse({ ...bodyOnly, killed: 2, score: 0.5, killed_ids: ["1", "3"], killed_mutators: ["BlockStatement", "ConditionalExpression"] });

  it("does not let a body-only kill serialise as a survivor", () => {
    expect(survives(verdictWith(bodyOnly, true) as never)).toBe(false);
    expect(Verdict.safeParse(verdictWith(bodyOnly, true)).success).toBe(false);
    expect(Verdict.safeParse(verdictWith(bodyOnly, false)).success).toBe(true);
  });

  it("admits a test that killed the body and something else", () => {
    expect(Verdict.safeParse(verdictWith(real, true)).success).toBe(true);
  });

  it("still parses a verdict written before the fields existed, with its old meaning", () => {
    const old = { score: 0.5, killed: 1, survived: 1, timeout: 0, no_coverage: 0, killed_ids: ["1"] };
    const parsed = Verdict.parse(verdictWith(old as MutationResult, true));
    expect(parsed.mutation).toMatchObject({ killed_mutators: [], body_mutant_id: null });
  });

  it("refuses mutator names that do not match the killed ids one for one", () => {
    expect(MutationResult.safeParse({ ...real, killed_mutators: ["BlockStatement"] }).success).toBe(false);
  });

  it("says why, and spends the retry on asserting the value", () => {
    expect(noKillMessage("slugify", bodyOnly, {})).toMatch(/empties its whole body.*ADR-0089/s);
    const v = Verdict.parse(verdictWith(bodyOnly, false));
    expect(shouldRetry(v)).toMatchObject({ retry: true, reason: expect.stringMatching(/empties the whole body/) });
  });
});

describe("option A — a test made only of type or existence checks is tautological", () => {
  const test = (body: string) => `import { slugify } from "../src/strings";\nimport { it, expect } from "vitest";\nit("x", () => { ${body} });\n`;

  it("flags typeof, toBeDefined, toBeInstanceOf and instanceof-is-true", () => {
    for (const body of [
      'expect(typeof slugify("Hello World")).toBe("string");',
      'expect(slugify("a")).toBeDefined();',
      'expect(slugify("a")).toBeInstanceOf(String);',
      'expect(slugify("a") instanceof Object).toBe(true);',
    ]) {
      const r = analyseTautology(test(body), "slugify");
      expect(r.tautological, body).toBe(true);
      expect(r.findings.map((f) => f.code), body).toContain("type_only_assertions");
    }
  });

  it("does not flag a test with at least one assertion on the value", () => {
    const r = analyseTautology(test('const s = slugify("Hello World"); expect(typeof s).toBe("string"); expect(s).toBe("hello-world");'), "slugify");
    expect(r.tautological).toBe(false);
  });
});
