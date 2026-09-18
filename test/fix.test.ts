// `sidecrew fix` without a worker or a toolchain: reading the worker's answer, refusing a plan, the
// retry rule, and the diff.
//
// The `loadChangePlan` block is where two decisions stop being sentences in a document. ADR-0044 §3
// says there is no `workers` field — a `strict` schema is what makes that a refusal. ADR-0048 says the
// `test_file_edited` and `build_config_edited` rules must not be switchable from the plan — refusing
// such a plan at load is what makes that true of the planner as well as of the worker.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import { diffOf, unifiedDiff } from "../src/diff.js";
import { fixTokenBudget, loadChangePlan, MAX_FIX_TOKENS, MIN_FIX_TOKENS, parseEdits, parseRefusal, shouldRetryChange } from "../src/fix.js";
import { PlanError } from "../src/plan.js";
import { estimateTokens } from "../src/prompt.js";
import { ChangePlan, ChangeTask, ChangeVerdict } from "../src/schemas.js";

const FIXTURE_PLAN = "fixtures/fix-fixture/plans/fix-type-errors.json";
const scratch: string[] = [];

afterAll(async () => { for (const d of scratch) await rm(d, { recursive: true, force: true }); });

const planWith = async (mutate: (plan: Record<string, unknown>) => void): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "sidecrew-plan-"));
  scratch.push(dir);
  const plan = JSON.parse(readFileSync(FIXTURE_PLAN, "utf8")) as Record<string, unknown>;
  // The project path is relative to the cwd, and vitest runs from the repo root.
  mutate(plan);
  const path = join(dir, "change_plan.json");
  await writeFile(path, JSON.stringify(plan, null, 2), "utf8");
  return path;
};

const task = (paths: string[]): ChangeTask => ChangeTask.parse({
  task_id: "t",
  language: "typescript",
  test_framework: "vitest",
  ask: "Fix every TypeScript error in these files without changing what the code does.",
  files: paths.map((path) => ({ path, source: "export const a = 1;\n", source_sha: "sha", errors: 1 })),
  diagnostics: "",
  max_deleted_lines: 0,
  notes: null,
  attempt: 0,
  retry_of: null,
  previous_error: null,
  correction: null,
  shape: "rename",
});

describe("parseEdits", () => {
  it("reads the form the prompt asks for", () => {
    const { edits, unparsed } = parseEdits(
      "--- FILE: src/a.ts ---\nexport const a = 2;\n--- FILE: src/b.ts ---\nexport const b = 3;",
      task(["src/a.ts", "src/b.ts"]),
    );
    expect(unparsed).toBeNull();
    expect(edits).toEqual([
      { path: "src/a.ts", contents: "export const a = 2;\n" },
      { path: "src/b.ts", contents: "export const b = 3;\n" },
    ]);
  });

  it("ignores prose before the first marker, because a file's contents can only follow one", () => {
    const { edits } = parseEdits(
      "Sure! Here is the fixed file:\n\n--- FILE: src/a.ts ---\nexport const a = 2;\n",
      task(["src/a.ts"]),
    );
    expect(edits).toEqual([{ path: "src/a.ts", contents: "export const a = 2;\n" }]);
  });

  it("strips a fence the prompt asked it not to use, because a 7B says it anyway", () => {
    const { edits } = parseEdits(
      "--- FILE: src/a.ts ---\n```ts\nexport const a = 2;\n```\n",
      task(["src/a.ts"]),
    );
    expect(edits[0]?.contents).toBe("export const a = 2;\n");
  });

  it("strips the end-of-turn marker mlx_lm streams as content", () => {
    // Phase 4's `<|im_end|>`: six candidates of six failed the compile stage on it, and the verdicts
    // read exactly like a model that cannot write TypeScript.
    const { edits } = parseEdits("--- FILE: src/a.ts ---\nexport const a = 2;\n<|im_end|>", task(["src/a.ts"]));
    expect(edits[0]?.contents).toBe("export const a = 2;\n");
  });

  it("accepts a bare answer for a single-file task, and only for one", () => {
    const one = parseEdits("export const a = 2;\n", task(["src/a.ts"]));
    expect(one.unparsed).toBeNull();
    expect(one.edits).toEqual([{ path: "src/a.ts", contents: "export const a = 2;\n" }]);

    const two = parseEdits("export const a = 2;\n", task(["src/a.ts", "src/b.ts"]));
    expect(two.edits).toEqual([]);
    expect(two.unparsed).toMatch(/no `--- FILE: path ---` marker/);
  });

  it("does not let the bare-answer fallback swallow a refusal on a single-file task", () => {
    // The interaction that made the refusal shape inert on exactly the tasks everything has been
    // measured on. Phase 11 ran only single-file tasks (ADR-0058) and Phase 11b reuses those plans, so
    // without this `refusals` is a constant zero rather than an observation — and the refusal text was
    // being written into the user's file as its new contents.
    const refusal = "--- CANNOT: the fix belongs in a file this task does not list ---";
    for (const n of [1, 2]) {
      const { edits } = parseEdits(refusal, task(Array.from({ length: n }, (_, i) => `src/f${i}.ts`)));
      expect(edits, `${n} file(s)`).toEqual([]);
      expect(parseRefusal(refusal)).toContain("does not list");
    }
    // …and the fallback still does its job for an answer that is actually a file.
    expect(parseEdits("export const a = 2;", task(["src/a.ts"])).edits).toHaveLength(1);
  });

  it("keeps a file the task does not list, so the gate can refuse it by name", () => {
    // Dropping it here would hide the `path_outside_task` signal the Phase 11 funnel is counting.
    const { edits } = parseEdits("--- FILE: ./src/elsewhere.ts ---\nexport const x = 1;\n", task(["src/a.ts"]));
    expect(edits).toEqual([{ path: "src/elsewhere.ts", contents: "export const x = 1;\n" }]);
  });

  it("normalises a path so `./src/a.ts` and `src/a.ts` are one file", () => {
    const { edits } = parseEdits("--- FILE: ./src/a.ts ---\nexport const a = 2;\n", task(["src/a.ts"]));
    expect(edits[0]?.path).toBe("src/a.ts");
  });
});

describe("fixTokenBudget", () => {
  const ofSize = (chars: number): ChangeTask => ChangeTask.parse({
    ...task(["src/a.ts"]),
    files: [{ path: "src/a.ts", source: "x".repeat(chars), source_sha: "s", errors: 1 }],
  });

  it("scales with the files, because whole-file edits cost tokens in proportion to them", () => {
    // A tiny file still gets room to answer in; a middling one gets its own size plus slack, because a
    // truncated answer is a whole wasted verdict; a huge one is capped, because one task must not hold
    // a worker for an hour.
    expect(fixTokenBudget(task(["src/a.ts"]))).toBe(MIN_FIX_TOKENS);
    expect(fixTokenBudget(ofSize(8_000))).toBeGreaterThan(estimateTokens("x".repeat(8_000)));
    expect(fixTokenBudget(ofSize(8_000))).toBeLessThan(MAX_FIX_TOKENS);
    expect(fixTokenBudget(ofSize(60_000))).toBe(MAX_FIX_TOKENS);
  });
});

describe("shouldRetryChange", () => {
  const base = {
    task_id: "t", stage_reached: "done", survived: true, compile_ok: true, tests_ok: true, confined: true,
    files_touched: [], errors: { before: { total: 0, by_file: {} }, after: { total: 0, by_file: {} }, introduced: {}, remaining_in_target: {}, message: null },
    tests: { reported: true, ran_before: 1, ran_after: 1, passed_before: 1, passed_after: 1, regressed: [], message: null },
    confinement: [], error: null, timing_ms: {},
  };
  const v = (over: Record<string, unknown>): ReturnType<typeof ChangeVerdict.parse> =>
    ChangeVerdict.parse({ ...base, ...over });

  it("does not spend the retry on a worker that said it cannot do the task", () => {
    // Caught by the Phase 11 session reading the contract rather than the code, and it was a real bug:
    // a refusal verdict is `confined` (it edited nothing) and not `compile_ok` (the compiler never
    // ran), so it fell through to the compile branch and was retried with the reason "tsc is not
    // satisfied" — naming a stage that never happened. ADR-0037's shape: a verdict wearing another
    // stage's clothes. It also meant a refusal cost a second generation, which is the opposite of what
    // ADR-0044's refusal shape is for, and it double-counted the task in `stats.refusals` against a
    // denominator that had it reaching the gate.
    const refused = v({
      survived: false, compile_ok: false, tests_ok: false, confined: true, stage_reached: "generate",
      tests: null, refused: "the fix belongs in a file this task does not list",
      error: "the worker refused this task",
    });
    const decision = shouldRetryChange(refused);
    expect(decision.retry).toBe(false);
    expect(decision.reason).toContain("refused");
    expect(decision.reason).not.toContain("tsc");
  });

  it("does not retry a survivor", () => {
    expect(shouldRetryChange(v({})).retry).toBe(false);
  });

  it("does not spend the retry on a runner that produced no report", () => {
    // The 2a form of ADR-0012: a machine problem retried at the worker's expense is an attempt bought
    // and nothing learnt.
    const d = shouldRetryChange(v({
      survived: false, tests_ok: false, stage_reached: "tests",
      tests: { reported: false, ran_before: 1, ran_after: 0, passed_before: 1, passed_after: 0, regressed: [], message: "boom" },
    }));
    expect(d.retry).toBe(false);
    expect(d.reason).toMatch(/machine problem/);
  });

  it("retries a confinement break, and names the rules — the most actionable sentence this gate has", () => {
    const d = shouldRetryChange(v({
      survived: false, confined: false, compile_ok: false, tests_ok: false, stage_reached: "confinement",
      tests: null,
      confinement: [{ rule: "suppression_added", file: "src/a.ts", detail: "line 1: // @ts-ignore" }],
    }));
    expect(d.retry).toBe(true);
    expect(d.reason).toContain("suppression_added");
  });

  it("retries a compile failure and a regression, in that order of usefulness", () => {
    const errors = { ...base.errors, remaining_in_target: { "src/a.ts": 1 } };
    expect(shouldRetryChange(v({ survived: false, compile_ok: false, tests_ok: false, stage_reached: "compile", tests: null, errors })))
      .toEqual({ retry: true, reason: "tsc is not satisfied" });
    expect(shouldRetryChange(v({
      survived: false, tests_ok: false, stage_reached: "tests",
      tests: { reported: true, ran_before: 1, ran_after: 1, passed_before: 1, passed_after: 1, regressed: ["test/a.test.ts::x"], message: "x" },
    }))).toEqual({ retry: true, reason: "a test that passed before now fails" });
  });
});

describe("loadChangePlan", () => {
  it("loads the fixture's plan", async () => {
    const loaded = await loadChangePlan(FIXTURE_PLAN);
    expect(loaded.plan.steps.map((s) => s.name)).toEqual(["guard the rate lookup", "default the optional fields"]);
    expect(loaded.runner).toBe("vitest");
    // Defaults are real values on the loaded plan, not implied ones.
    expect(loaded.plan.max_group_size).toBe(10);
    expect(loaded.plan.steps[0]?.tasks[0]?.max_deleted_lines).toBe(0);
  });

  it("refuses a plan with a `workers` field — ADR-0044 §3, enforced rather than stated", async () => {
    const path = await planWith((plan) => { (plan.steps as Record<string, unknown>[])[0]!.workers = 3; });
    await expect(loadChangePlan(path)).rejects.toThrow(PlanError);
    await expect(loadChangePlan(path)).rejects.toThrow(/workers/);
  });

  it("refuses a task that lists a test file or a build config", async () => {
    // The gate refuses the *edit* anyway (ADR-0048). This refuses the *plan*, because from Phase 12
    // the thing writing plans is a model and a rule it can switch off is a rule it can be argued out of.
    for (const file of ["test/rates.test.ts", "tsconfig.json", "package.json", "vitest.config.ts"]) {
      const path = await planWith((plan) => {
        ((plan.steps as Record<string, unknown>[])[0]!.tasks as Record<string, unknown>[])[0]!.files = [file];
      });
      await expect(loadChangePlan(path), file).rejects.toThrow(/may never edit a test file or a build config/);
    }
  });

  it("refuses a group bigger than the plan's own ceiling", async () => {
    const path = await planWith((plan) => {
      plan.max_group_size = 1;
      ((plan.steps as Record<string, unknown>[])[0]!.tasks as Record<string, unknown>[])[0]!.files = ["src/rates.ts", "src/money.ts"];
    });
    await expect(loadChangePlan(path)).rejects.toThrow(/max_group_size is 1/);
  });

  it("refuses a file that is not in the project, and two tasks with one name", async () => {
    const missing = await planWith((plan) => {
      ((plan.steps as Record<string, unknown>[])[0]!.tasks as Record<string, unknown>[])[0]!.files = ["src/nope.ts"];
    });
    await expect(loadChangePlan(missing)).rejects.toThrow(/which is not in/);

    const duplicate = await planWith((plan) => {
      const steps = plan.steps as Record<string, unknown>[];
      (steps[1]!.tasks as Record<string, unknown>[])[0]!.task_id = "rates";
    });
    await expect(loadChangePlan(duplicate)).rejects.toThrow(/two tasks called rates/);
  });

  it("refuses a language or a runner it cannot drive, where the reason lives", async () => {
    const swift = await planWith((plan) => { plan.language = "swift"; });
    await expect(loadChangePlan(swift)).rejects.toThrow(/TypeScript only/);
    const mocha = await planWith((plan) => { plan.test_framework = "mocha"; });
    await expect(loadChangePlan(mocha)).rejects.toThrow(/vitest and jest/);
  });

  it("is the same schema the spec pins", () => {
    expect(() => ChangePlan.parse(JSON.parse(readFileSync(FIXTURE_PLAN, "utf8")))).not.toThrow();
  });
});

describe("the diff — the artefact, not the gate", () => {
  it("writes a unified diff of a one-line change", () => {
    const before = ["a", "b", "c", "d", "e"].join("\n");
    const after = ["a", "b", "C", "d", "e"].join("\n");
    const diff = unifiedDiff("src/a.ts", before, after);
    expect(diff).toContain("--- a/src/a.ts");
    expect(diff).toContain("+++ b/src/a.ts");
    expect(diff).toContain("-c");
    expect(diff).toContain("+C");
    expect(diff).toMatch(/@@ -1,5 \+1,5 @@/);
  });

  it("says nothing about a file that did not change", () => {
    expect(unifiedDiff("src/a.ts", "same\n", "same\n")).toBe("");
    expect(diffOf([{ path: "src/a.ts", before: "same\n", after: "same\n" }])).toBe("");
  });

  it("keeps a large file cheap by diffing only what differs", () => {
    // The realistic shape of a 2a change is a few lines altered in a few hundred, so the common prefix
    // and suffix are trimmed before any table is built.
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    const before = lines.join("\n");
    const after = [...lines.slice(0, 2500), "changed", ...lines.slice(2501)].join("\n");
    const started = performance.now();
    const diff = unifiedDiff("big.ts", before, after);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(diff).toContain("+changed");
    expect(diff.split("\n").length).toBeLessThan(20);
  });
});
