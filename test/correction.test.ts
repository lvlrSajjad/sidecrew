// The correction round (ADR-0044 §4), and the one property the measurement depends on.
//
// `experiments/correction-round/README.md` §4.0 precondition 2 makes rule 1 a **void run** condition:
// if the thing that writes a correction can reach the candidate, what was measured is not the mechanism
// ADR-0044 decided. So the first test here is about a function signature rather than about behaviour,
// and it is the most important one in the file.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { brief, renderBrief, shouldCorrect } from "../src/correction.js";
import { ChangeVerdict, CorrectionBudget, type ChangeVerdict as Verdict } from "../src/schemas.js";

const SOURCE = fileURLToPath(new URL("../src/correction.ts", import.meta.url));

const base = (over: Partial<Verdict> = {}): Verdict => ChangeVerdict.parse({
  task_id: "totals:0",
  stage_reached: "compile",
  survived: false,
  compile_ok: false,
  tests_ok: false,
  confined: true,
  files_touched: ["src/totals.ts"],
  errors: {
    before: { total: 4, by_file: { "src/totals.ts": 4 } },
    after: { total: 2, by_file: { "src/totals.ts": 2 } },
    introduced: {},
    remaining_in_target: { "src/totals.ts": 2 },
    message: "src/totals.ts(14,10): error TS2345: Argument of type 'string' …",
  },
  tests: null,
  confinement: [],
  observations: [],
  refused: null,
  error: "tsc is not satisfied",
  timing_ms: { compile: 2300 },
  ...over,
});

const budget = (over: Partial<ReturnType<typeof CorrectionBudget.parse>> = {}): ReturnType<typeof CorrectionBudget.parse> =>
  CorrectionBudget.parse({ enabled: true, max_corrections: 5, max_tokens: 0, on_observations: false, ...over });

const nothing = { written: 0, tokens: 0 };

describe("ADR-0044 §4 rule 1 — fed by the gate, never by raw output", () => {
  it("cannot reach a candidate, because a candidate is not in its signature", () => {
    // A type error rather than a promise. The protocol voids the run if this separation is only a
    // convention, so it is checked here — on the **code**, with comments stripped, because the module's
    // own docstring quotes ADR-0044's "Opus does not read the candidate's diff" and a blunter check
    // would fail on the sentence that states the rule.
    const src = readFileSync(SOURCE, "utf8");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .join("\n");

    for (const forbidden of ["ChangeCandidate", ".edits", "unparsed", "contents"]) {
      expect(code, `src/correction.ts reaches for ${forbidden}`).not.toContain(forbidden);
    }
    // And the brief itself carries only what the gate extracted, so a caller cannot smuggle one through.
    const keys = Object.keys(brief(base(), "rename"));
    expect(keys.sort()).toEqual(["findings", "on_observation", "shape", "stage", "task_id"]);
  });

  it("writes findings only from what the gate extracted", () => {
    const b = brief(base({
      confined: false,
      confinement: [{ rule: "suppression_added", file: "src/totals.ts", detail: "line 14: // @ts-ignore" }],
    }), "null_guard");
    // The confinement rule first: it is the most actionable sentence this gate produces, which is the
    // same ordering `shouldRetryChange` uses.
    expect(b.findings[0]).toContain("suppression_added");
    expect(b.findings.join("\n")).toContain("TS2345");
    expect(b.shape).toBe("null_guard");
  });

  it("names regressed tests without quoting the change that broke them", () => {
    const b = brief(base({
      compile_ok: true,
      stage_reached: "tests",
      errors: { ...base().errors, remaining_in_target: {}, message: null },
      tests: { reported: true, ran_before: 12, ran_after: 12, passed_before: 12, passed_after: 12, regressed: ["a.test.ts::adds", "a.test.ts::subtracts"], message: null, first_reading: null },
    }), "rename");
    expect(b.findings.join("\n")).toContain("a.test.ts::adds");
  });

  it("caps the list of regressed tests, because a note is one sentence and not a report", () => {
    const many = Array.from({ length: 25 }, (_, i) => `t.test.ts::case ${i}`);
    const b = brief(base({
      compile_ok: true,
      stage_reached: "tests",
      errors: { ...base().errors, remaining_in_target: {}, message: null },
      tests: { reported: true, ran_before: 30, ran_after: 30, passed_before: 30, passed_after: 30, regressed: many, message: null, first_reading: null },
    }), "rename");
    expect(b.findings.join("\n")).toContain("…");
    expect(b.findings.join("\n")).not.toContain("case 20");
  });
});

describe("shouldCorrect — the three refusals that keep §2.2 honest", () => {
  it("is off by default, because ADR-0044 decided the round gets measured rather than switched on", () => {
    expect(shouldCorrect(base(), CorrectionBudget.parse({}), nothing).write).toBe(false);
  });

  it("does not spend a note on a machine failure", () => {
    // There is nothing for a worker to do differently about a runner that produced no report, and a
    // token spent here is bought against a denominator that should have excluded the task.
    const v = base({
      stage_reached: "tests",
      tests: { reported: false, ran_before: 12, ran_after: 0, passed_before: 12, passed_after: 0, regressed: [], message: "no report", first_reading: null },
    });
    const gate = shouldCorrect(v, budget(), nothing);
    expect(gate.write).toBe(false);
    expect(gate.reason).toMatch(/machine failure/);
  });

  it("does not spend a note on a refusal, which is a plan problem rather than a worker one", () => {
    const v = base({
      stage_reached: "generate",
      confined: true,
      files_touched: [],
      errors: { ...base().errors, remaining_in_target: { "src/totals.ts": 4 } },
      refused: "the fix belongs in a file this task does not list",
    });
    expect(shouldCorrect(v, budget(), nothing).reason).toMatch(/plan problem/);
  });

  it("does not spend a note the gate gave it nothing to write", () => {
    // ADR-0022 already proves a byte-identical retry is a wasted verdict against a deterministic worker,
    // and "try again" is what a note with no findings says.
    const empty = base({
      errors: { before: { total: 0, by_file: {} }, after: { total: 0, by_file: {} }, introduced: {}, remaining_in_target: {}, message: null },
      error: null,
    });
    expect(shouldCorrect(empty, budget(), nothing).write).toBe(false);
  });

  it("stops at the run's budget, and says which limit stopped it", () => {
    expect(shouldCorrect(base(), budget({ max_corrections: 2 }), { written: 2, tokens: 0 }).reason).toMatch(/budget of 2/);
    expect(shouldCorrect(base(), budget({ max_tokens: 500 }), { written: 0, tokens: 500 }).reason).toMatch(/token cap/);
  });

  it("writes one when the gate found something a note can act on", () => {
    expect(shouldCorrect(base(), budget(), nothing).write).toBe(true);
  });
});

describe("the survivor case (ADR-0057)", () => {
  const survivor = (observations: Verdict["observations"]): Verdict => base({
    stage_reached: "done",
    survived: true,
    compile_ok: true,
    tests_ok: true,
    confined: true,
    errors: { ...base().errors, remaining_in_target: {}, message: null },
    tests: { reported: true, ran_before: 12, ran_after: 12, passed_before: 12, passed_after: 12, regressed: [], message: null, first_reading: null },
    observations,
    error: null,
  });

  const cosmetic: Verdict["observations"] = [
    { kind: "comment_lines_removed", file: "src/totals.ts", detail: "7 comment line(s) removed that the ask did not call for" },
  ];

  it("is off separately, because ADR-0044 §4 never contemplated correcting something that passed", () => {
    const gate = shouldCorrect(survivor(cosmetic), budget({ on_observations: false }), nothing);
    expect(gate.write).toBe(false);
    expect(gate.reason).toMatch(/ADR-0057/);
  });

  it("fires when the plan asked for it, on the one behaviour Phase 11 actually counted", () => {
    // 4 of 23 sampled survivors against 0 of 23 — the only measured quality gap between the local tier
    // and the control, and invisible to `survives ⇔ confined ∧ compile_ok ∧ tests_ok`.
    const gate = shouldCorrect(survivor(cosmetic), budget({ on_observations: true }), nothing);
    expect(gate.write).toBe(true);
    const b = brief(survivor(cosmetic), "rename");
    expect(b.on_observation).toBe(true);
    expect(b.findings.join("\n")).toContain("comment_lines_removed");
    expect(renderBrief(b)).toMatch(/leave alone/);
  });

  it("says nothing about a survivor the gate observed nothing on", () => {
    expect(shouldCorrect(survivor([]), budget({ on_observations: true }), nothing).write).toBe(false);
  });
});
