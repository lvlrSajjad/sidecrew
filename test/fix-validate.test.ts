// `validateChangePlan` — the checks that stop a run spending 262 s of gate per attempt on a task no
// worker could have passed.
//
// The structural half is tested here. The `compile: true` half needs a real `tsc` over a real project
// and lives in `fix-validate.slow.test.ts`, because the refusal it produces (ADR-0050 option C) is only
// meaningful against a compiler's actual output.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import { hardShare, rewriteCost, validateChangePlan } from "../src/fix-validate.js";
import { MAX_FIX_TOKENS } from "../src/fix.js";

const FIXTURE_PLAN = "fixtures/fix-fixture/plans/fix-type-errors.json";
const scratch: string[] = [];

afterAll(async () => { for (const d of scratch) await rm(d, { recursive: true, force: true }); });

const planWith = async (mutate: (plan: Record<string, unknown>) => void): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "sidecrew-validate-"));
  scratch.push(dir);
  const plan = JSON.parse(readFileSync(FIXTURE_PLAN, "utf8")) as Record<string, unknown>;
  mutate(plan);
  const path = join(dir, "change_plan.json");
  await writeFile(path, JSON.stringify(plan, null, 2), "utf8");
  return path;
};

type Task = Record<string, unknown>;
const tasksOf = (plan: Record<string, unknown>): Task[] =>
  (plan.steps as Record<string, unknown>[]).flatMap((s) => s.tasks as Task[]);

const codes = (list: { code: string }[]): string[] => list.map((e) => e.code);

describe("validateChangePlan — structural", () => {
  it("passes the fixture plan and counts what it checked", async () => {
    const r = await validateChangePlan(FIXTURE_PLAN, { compile: false });
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.checked).toEqual({ steps: 2, tasks: 3, files: 3 });
    expect(r.structural_only).toBe(true);
  });

  it("reports the shape mix, because Phase 11b §4.4 withholds its verdict without it", async () => {
    const r = await validateChangePlan(FIXTURE_PLAN, { compile: false });
    expect(r.shapes).toEqual({ null_guard: 3 });
    expect(hardShare(r.shapes)).toBe(1);
    // Every rate in this repository is for renames and unused imports, so a planner that only emits
    // those has to be visible as one rather than read as a general result.
    expect(hardShare({ rename: 9, null_guard: 1 })).toBeCloseTo(0.1);
    expect(hardShare({})).toBe(0);
  });

  it("refuses a task whose files are too large for a worker to return whole", async () => {
    // ADR-0047 §2 chose whole-file rewriting, and Phase 11 hit its wall before it hit the model's:
    // most files in a real service cannot be reproduced inside 8192 tokens. Refusing here turns a
    // truncated candidate and a wasted verdict into a planner-side constraint with a number on it.
    const dir = await mkdtemp(join(tmpdir(), "sidecrew-big-"));
    scratch.push(dir);
    const huge = join(dir, "huge.ts");
    await writeFile(huge, `export const x = "${"a".repeat(MAX_FIX_TOKENS * 6)}";\n`, "utf8");
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "big" }), "utf8");

    const path = await planWith((plan) => {
      plan.project = dir;
      plan.steps = [{ name: "s", tasks: [{ ...tasksOf(plan)[0]!, task_id: "big", files: ["huge.ts"] }] }];
    });
    const r = await validateChangePlan(path, { compile: false });
    expect(codes(r.refusals)).toEqual(["files_too_large_to_rewrite"]);
    expect(r.valid).toBe(false);
    expect(r.refusals[0]!.message).toMatch(/whole files/);
  });

  it("refuses a dead_code ask with no deletion budget, which is unsatisfiable by construction", async () => {
    const path = await planWith((plan) => {
      tasksOf(plan)[0]!.shape = "dead_code";
      tasksOf(plan)[0]!.max_deleted_lines = 0;
    });
    const r = await validateChangePlan(path, { compile: false });
    expect(codes(r.refusals)).toContain("deletion_budget_zero");
  });

  it("warns when a non-deletion ask carries a deletion budget, reopening the cheapest cheap pass", async () => {
    const path = await planWith((plan) => { tasksOf(plan)[0]!.max_deleted_lines = 5; });
    const r = await validateChangePlan(path, { compile: false });
    expect(codes(r.warnings)).toContain("deletion_budget_on_non_deletion");
    // A warning, not an error: it is a judgement the planner is allowed to make, with its reason shown.
    expect(r.valid).toBe(true);
  });

  it("refuses two tasks in one step that share a file", async () => {
    // Tasks in a step run in parallel from one baseline, each in its own clone. Two candidates editing
    // the same file both survive, and whichever lands second at the step boundary silently drops the
    // first's change — invisible to every per-task verdict.
    const path = await planWith((plan) => {
      plan.steps = [{
        name: "clash",
        tasks: [
          { ...tasksOf(plan)[0]!, task_id: "a", files: ["src/rates.ts"] },
          { ...tasksOf(plan)[0]!, task_id: "b", files: ["src/rates.ts"] },
        ],
      }];
    });
    const r = await validateChangePlan(path, { compile: false });
    expect(codes(r.errors)).toContain("file_in_two_tasks");
  });

  it("allows the same file in two different steps, because a step boundary re-captures the baseline", async () => {
    const path = await planWith((plan) => {
      plan.steps = [
        { name: "one", tasks: [{ ...tasksOf(plan)[0]!, task_id: "a", files: ["src/rates.ts"] }] },
        { name: "two", tasks: [{ ...tasksOf(plan)[0]!, task_id: "b", files: ["src/rates.ts"] }] },
      ];
    });
    const r = await validateChangePlan(path, { compile: false });
    expect(codes(r.errors)).not.toContain("file_in_two_tasks");
  });

  it("reports every problem rather than the first, which is the whole reason this is not loadChangePlan", async () => {
    const path = await planWith((plan) => {
      plan.max_group_size = 1;
      plan.steps = [{
        name: "s",
        tasks: [
          { ...tasksOf(plan)[0]!, task_id: "dup", files: ["src/rates.ts", "src/cart.ts"] },
          { ...tasksOf(plan)[0]!, task_id: "dup", files: ["nope.ts"] },
        ],
      }];
    });
    const r = await validateChangePlan(path, { compile: false });
    expect(codes(r.errors)).toEqual(expect.arrayContaining(["group_too_large", "duplicate_task_id", "file_missing"]));
  });

  it("refuses a plan that lists a test file or a build config, the two rules a plan may not switch off", async () => {
    for (const file of ["src/rates.test.ts", "tsconfig.json", "__tests__/x.ts", "vitest.config.ts"]) {
      const path = await planWith((plan) => { tasksOf(plan)[0]!.files = [file]; });
      const r = await validateChangePlan(path, { compile: false });
      expect(codes(r.errors), file).toContain("file_forbidden");
    }
  });

  it("names the `workers` field when a plan carries one, because that is the likely mistake", async () => {
    const path = await planWith((plan) => { plan.workers = 3; });
    const r = await validateChangePlan(path, { compile: false });
    expect(r.valid).toBe(false);
    expect(r.errors[0]!.message).toMatch(/workers/);
  });

  it("warns about a correction round that is on and cannot act", async () => {
    const path = await planWith((plan) => {
      plan.correction = { enabled: true, max_corrections: 0, max_tokens: 0, on_observations: false };
    });
    const r = await validateChangePlan(path, { compile: false });
    expect(codes(r.warnings)).toContain("correction_budget_empty");
  });

  it("says so when it never reached the file, rather than reporting a plan it did not read", async () => {
    const r = await validateChangePlan("/nowhere/change_plan.json", { compile: false });
    expect(r.valid).toBe(false);
    expect(r.checked).toEqual({ steps: 0, tasks: 0, files: 0 });
    expect(codes(r.errors)).toEqual(["plan_missing"]);
  });
});

describe("rewriteCost", () => {
  it("tracks the budget the run actually gives a worker", async () => {
    // If these two drift, the validator refuses tasks the run would have answered, or admits ones it
    // cannot — and the second shows up as a truncation rate that reads as a model failure.
    expect(rewriteCost([""])).toBeLessThan(rewriteCost(["export const a = 1;\n".repeat(50)]));
    expect(rewriteCost(["a", "b"])).toBeGreaterThan(rewriteCost(["a"]));
  });
});
