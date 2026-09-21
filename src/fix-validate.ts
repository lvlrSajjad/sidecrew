// `sidecrew fix --validate` / `sidecrew_fix_plan_validate` — is this change plan one a run may spend
// 262 s of gate per attempt on?
//
// The same split `validate.ts` makes for workload #1, for the same reason: `loadChangePlan` stops at the
// first problem with a sentence, which is right for a run about to do work and wrong for a planner that
// wants the whole list before it edits. So the checks are re-walked in an order that never
// short-circuits, and each failure becomes a `ValidationIssue` with a code a caller can branch on.
//
// What this file adds over that pattern is **refusal**, and it is the reason the phase prompt puts it
// here rather than in the planner's head:
//
//   > The planner must refuse what cannot be survived. Phase 11 nearly measured a task that was
//   > unsatisfiable through no fault of a worker — a pre-existing `tsc` error in a task's own file means
//   > the gate can never pass it (ADR-0050 option C). That is §2's first denominator exclusion, and it
//   > should be enforced in `validateChangePlan` rather than remembered by whoever writes the plan.
//
// A refusal is not a style note. `compile_ok` requires **zero** `tsc` errors in the task's own files
// (ADR-0048), so a task whose files carry an error its ask does not cover is one no worker can pass, at
// any temperature, for any number of attempts. Measured against Phase 11's costs, letting one through
// spends ~9 minutes of wall clock to learn something a `tsc` run already knew.
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { rm } from "node:fs/promises";
import {
  DEFAULT_CHANGE_TIMEOUTS, makeChangeSandbox, toPosix, typecheck, type ChangeTimeouts,
} from "./change.js";
import { isTestArtefact, isToolConfig } from "./confinement.js";
import { estimateTokens } from "./prompt.js";
import { MAX_FIX_TOKENS } from "./fix.js";
import { ChangeValidationReport, ChangePlan, type ChangeShape, type ValidationIssue } from "./schemas.js";

export interface ValidateChangeOpts {
  /**
   * Run a real `tsc` over the project. Default true, and it is what makes the report mean something:
   * the pre-existing-error refusal (ADR-0050 option C) and the "this file is not in the program" check
   * are both impossible without it. False is the fast structural pass and the report says it was used.
   */
  compile?: boolean;
  tsconfig?: string;
  timeouts?: Partial<ChangeTimeouts>;
  sandboxRoot?: string;
  onEvent?: (line: string) => void;
}

const issue = (code: string, message: string, where: string): ValidationIssue => ({ code, message, where });

/** A report that got no further than the file itself. `checked` counts what was checked, so: nothing. */
const stillborn = (plan: string, e: ValidationIssue): ChangeValidationReport => ChangeValidationReport.parse({
  plan,
  valid: false,
  checked: { steps: 0, tasks: 0, files: 0 },
  errors: [e],
  warnings: [],
  refusals: [],
  shapes: {},
  structural_only: true,
});

/**
 * Files a test file by any of this repo's spellings, or a build config. Duplicated from
 * `loadChangePlan` on purpose rather than shared: ADR-0048 says these two rules must not be switchable
 * from the plan, and a rule with one implementation is a rule with one place to get it wrong.
 */
const FORBIDDEN = (file: string): string | null => {
  const base = basename(file);
  // ADR-0081: the predicate is shared for the reason `isToolConfig` below is — the rule stays
  // duplicated, the fact does not. The two spellings that used to sit here disagreed with the gate
  // about `app.e2e-spec.ts`, which is what `nest new` generates.
  if (isTestArtefact(file)) return "a test file or a test directory";
  if (/^(tsconfig|jsconfig)([.-][\w.-]+)?\.json$/.test(base)) return "a TypeScript config";
  if (/^(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.eslintrc.*|\.babelrc.*|\.swcrc)$/.test(base)) return "a build config";
  // ADR-0070. The one predicate both gates share on purpose: the *rule* stays duplicated (ADR-0048
  // says it must not be switchable from a plan, and a rule with one implementation has one place to
  // get it wrong), but "what is a tool config" is a fact about a filename, and two answers to that
  // would be a bug rather than a safeguard. A test asserts the two agree.
  if (isToolConfig(file)) return "a tool config";
  return null;
};

/**
 * Can a worker physically answer this task?
 *
 * A worker returns **whole files** (ADR-0047 §2), so a task is bounded by what the model can reproduce
 * inside its completion ceiling — not by whether it understood the change. Phase 11 found this wall
 * before it found the model's:
 *
 *   > Whole-file rewriting also bounds a task to files a 7B can reproduce inside 8192 tokens, which most
 *   > files in a real service are not.
 *
 * Refusing here turns that into a planner-side constraint with a number attached, instead of a
 * `truncated` candidate and a wasted verdict. The multiplier matches `fixTokenBudget`'s.
 */
export const rewriteCost = (sources: string[]): number =>
  Math.ceil(sources.reduce((n, src) => n + estimateTokens(src), 0) * 1.4) + 256;

export async function validateChangePlan(planPath: string, opts: ValidateChangeOpts = {}): Promise<ChangeValidationReport> {
  const say = opts.onEvent ?? ((): void => {});
  const tsconfig = opts.tsconfig ?? "tsconfig.json";

  if (!existsSync(planPath)) return stillborn(planPath, issue("plan_missing", `${planPath} is not on disk`, planPath));
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(planPath, "utf8")) as unknown;
  } catch (e) {
    return stillborn(planPath, issue("plan_unparsable", `not JSON: ${String((e as Error).message)}`, planPath));
  }

  const parsed = ChangePlan.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return stillborn(planPath, issue(
      "plan_invalid",
      `${detail} — note that ChangePlan is strict, so a \`workers\` field is one of the ways this fails: ` +
      "Opus decides how the work is cut, the machine decides how many pieces are in flight (ADR-0044 §3)",
      planPath,
    ));
  }
  const plan = parsed.data;

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const refusals: ChangeValidationReport["refusals"] = [];
  const shapes: Record<string, number> = {};

  const refuse = (task_id: string, code: string, message: string): void => {
    refusals.push({ task_id, code, message });
    errors.push(issue(code, message, task_id));
  };

  if (plan.language !== "typescript") {
    errors.push(issue("language_unsupported", `workload #2a is TypeScript only today; this plan says ${plan.language}`, planPath));
  }

  const projectDir = resolve(plan.project);
  if (!existsSync(join(projectDir, "package.json"))) {
    return stillborn(planPath, issue("project_missing", `${plan.project} has no package.json`, plan.project));
  }

  // ── structural, and none of it short-circuits ──────────────────────────────────────────────────
  const seen = new Set<string>();
  const allFiles = new Set<string>();
  let tasks = 0;

  for (const step of plan.steps) {
    // Tasks inside a step run in **parallel against one baseline** (ADR-0044 §2), each in its own clone.
    // Two tasks that list the same file are two candidates editing it from the same starting point, and
    // whichever lands second silently loses the other's change at the step boundary. The per-task gate
    // cannot see it; only `combined_regressions` can, and by then the run is over.
    const inStep = new Map<string, string>();
    for (const task of step.tasks) {
      tasks += 1;
      shapes[task.shape] = (shapes[task.shape] ?? 0) + 1;

      if (seen.has(task.task_id)) errors.push(issue("duplicate_task_id", `two tasks called ${task.task_id}`, task.task_id));
      seen.add(task.task_id);

      if (task.files.length > plan.max_group_size) {
        errors.push(issue(
          "group_too_large",
          `lists ${task.files.length} files and max_group_size is ${plan.max_group_size}`,
          task.task_id,
        ));
      }

      for (const file of task.files) {
        const posix = toPosix(file);
        allFiles.add(posix);

        const clash = inStep.get(posix);
        if (clash !== undefined && clash !== task.task_id) {
          errors.push(issue(
            "file_in_two_tasks",
            `${posix} is also in ${clash}, and tasks inside a step run in parallel from one baseline — ` +
            "the second survivor to land would silently drop the first's change (ADR-0044 §2)",
            task.task_id,
          ));
        }
        inStep.set(posix, task.task_id);

        // Name first, and deliberately **not** guarded by existence. `test_file_edited` and
        // `build_config_edited` are rules about what a plan may *ask for*, not about what is on disk, so
        // a plan naming a test file that does not exist is still a plan that tried to switch the gate
        // off. Checking existence first let exactly that through, and only a test caught it.
        const forbidden = FORBIDDEN(posix);
        if (forbidden !== null) {
          errors.push(issue(
            "file_forbidden",
            `${file} is ${forbidden}, and a behaviour-preserving change may never edit one — those are the ` +
            "gate and its configuration (ADR-0046, ADR-0048)",
            task.task_id,
          ));
        }
        if (!existsSync(join(projectDir, file))) {
          errors.push(issue("file_missing", `${file} is not in ${plan.project}`, task.task_id));
        }
      }

      // `dead_code` is the one shape whose ask is a deletion, so a budget of zero makes it unsatisfiable
      // by construction — and a non-zero budget on any other shape re-opens the cheapest way past a
      // type-error gate, which is deleting the line that failed (ADR-0047 §1).
      if (task.shape === "dead_code" && task.max_deleted_lines === 0) {
        refuse(task.task_id, "deletion_budget_zero",
          "a dead_code ask with max_deleted_lines: 0 cannot be satisfied — removing the code is the ask, " +
          "and the gate counts it as deletion_without_replacement");
      }
      if (task.shape !== "dead_code" && task.max_deleted_lines > 0) {
        warnings.push(issue(
          "deletion_budget_on_non_deletion",
          `shape is ${task.shape} but max_deleted_lines is ${task.max_deleted_lines} — deleting the ` +
          "offending line is the cheapest way past a type-error gate, and this re-opens it (ADR-0047 §1)",
          task.task_id,
        ));
      }

      // Whole-file rewriting: can the worker physically return these files? (ADR-0047 §2, Phase 11 §5.)
      const present = task.files.filter((f) => existsSync(join(projectDir, f)));
      if (present.length === task.files.length) {
        const cost = rewriteCost(present.map((f) => readFileSync(join(projectDir, f), "utf8")));
        if (cost > MAX_FIX_TOKENS) {
          refuse(task.task_id, "files_too_large_to_rewrite",
            `rewriting these ${present.length} file(s) needs about ${cost} completion tokens and the ceiling ` +
            `is ${MAX_FIX_TOKENS} — a worker returns whole files (ADR-0047 §2), so this task can only ` +
            "produce a truncated candidate. Split it, or list fewer files");
        }
      }
    }
  }

  if (plan.correction.enabled && plan.correction.max_corrections === 0) {
    warnings.push(issue(
      "correction_budget_empty",
      "correction.enabled is true and max_corrections is 0, so no correction can ever be written — " +
      "the round is on and unable to act (ADR-0044 §4)",
      planPath,
    ));
  }

  // ── the expensive half: what does `tsc` actually say about these files? ────────────────────────
  let structural_only = opts.compile === false;
  if (!structural_only && errors.length === 0) {
    const sandbox = await makeChangeSandbox(projectDir, opts.sandboxRoot);
    try {
      say(`  typechecking ${plan.project} — the pre-existing-error refusal needs a real tsc (ADR-0050)`);
      const timeouts = { ...DEFAULT_CHANGE_TIMEOUTS, ...opts.timeouts };
      // ADR-0063: the same strictness the run will use, or the pre-existing-error refusal (ADR-0050)
      // is computed against a different compiler from the one that will judge the candidate — and a
      // validator that clears a task the gate then fails is worse than no validator.
      const run = await typecheck(sandbox, projectDir, tsconfig, timeouts.compile, plan.compiler_flags);
      const program = run.program;
      const byFile = run.errors.by_file;

      /**
       * ADR-0071 option A: **report the exposure, gate nothing.**
       *
       * `compile_ok` is *zero errors in the task's own files **and** no file anywhere with more than
       * before*, and a plan may never list a test file (ADR-0046 — the tests are the gate). So when a
       * project's `tsc` program includes its tests, a task can be unsatisfiable purely because of the
       * **type change the ask requires**: nothing needs editing, and merely narrowing an exported type
       * makes a file nobody may touch report one more error.
       *
       * Measured on a real service: 24 of 24 compile failures were this, and **22 of them introduced
       * exactly one error into the same app-wide e2e spec** while editing 22 unrelated source files.
       * The project-wide error count went *down*. `validateChangePlan` passed every one of them,
       * because the refusal above is a property of a file *before* the change and this is a property
       * of what the change *does*.
       *
       * This warns and does not refuse, deliberately. Predicting a compiler's output without running
       * the compiler is how `deriveLineRange`'s special cases accumulated, and the one survivor in
       * that run would have been refused by a rule that guessed. A planner who reads *"a spec carrying
       * 165 errors is in your program and you may not touch it"* writes a different plan; that is the
       * whole intent.
       */
      const testsInProgram = [...program]
        .filter((f) => FORBIDDEN(f) !== null)
        .map((f) => ({ file: f, errors: byFile[f] ?? 0 }))
        .sort((a, b) => b.errors - a.errors);
      const errorfulTests = testsInProgram.filter((t) => t.errors > 0);
      if (errorfulTests.length > 0) {
        const worst = errorfulTests[0]!;
        const total = errorfulTests.reduce((n, t) => n + t.errors, 0);
        warnings.push(issue(
          "tests_in_program_carry_errors",
          `${tsconfig} puts ${testsInProgram.length} test file(s) in the program, and ${errorfulTests.length} ` +
          `of them already carry ${total} tsc error(s) — the worst is ${worst.file} with ${worst.errors}. ` +
          "A plan may never list a test file, and `compile_ok` fails if any file anywhere gains an error, " +
          "so a task whose change narrows an exported type can be unsatisfiable through no fault of a " +
          "worker — even while it reduces the project's total. This is a warning, not a refusal: it " +
          "cannot be predicted without running the compiler on the change (ADR-0071). Give the tsconfig " +
          "an `include` that separates source from tests, or prefer tasks whose files those specs do not " +
          "reach.",
          planPath,
        ));
      }

      for (const step of plan.steps) {
        for (const task of step.tasks) {
          // A file `tsc` never compiled cannot be judged by `compile_ok`: it has zero errors because it
          // was never in the program, not because it is clean. Phase 11's `assertInProgram` learned this
          // the expensive way on a monorepo.
          const outside = task.files.map(toPosix).filter((f) => !program.has(f));
          if (outside.length > 0) {
            refuse(task.task_id, "file_outside_program",
              `${outside.join(", ")} is not in the program ${tsconfig} describes, so tsc will never report ` +
              "an error in it and compile_ok would pass vacuously");
          }

          const errorful = task.files.map(toPosix).filter((f) => (byFile[f] ?? 0) > 0);
          if (task.shape === "rename" || task.shape === "unused_import" || task.shape === "dead_code") {
            // These three do not exist to clear an error, so a pre-existing one in the task's own files
            // is a wall: `compile_ok` requires **zero** there, and the ask does not cover it.
            // ADR-0050 option C, and it is the refusal Phase 11 nearly needed.
            for (const f of errorful) {
              refuse(task.task_id, "pre_existing_error",
                `${f} already has ${byFile[f]} tsc error(s) and this ${task.shape} ask does not cover them — ` +
                "compile_ok requires zero errors in the task's own files, so no worker can pass this " +
                "task at any temperature (ADR-0048, ADR-0050 option C)");
            }
          } else if (errorful.length === 0) {
            // The mirror image: a `null_guard` or `api_migration` ask driven by errors that are not there.
            warnings.push(issue(
              "nothing_to_fix",
              `no file in this task has a tsc error, and a ${task.shape} ask usually exists to clear one — ` +
              "if there is genuinely nothing to do, the only candidate that can survive is no_edit_at_all, " +
              "which the gate refuses (Phase 11 §2, exclusion 2)",
              task.task_id,
            ));
          }
        }
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  } else if (!structural_only) {
    structural_only = true;
    warnings.push(issue(
      "compile_skipped",
      "the structural pass found problems, so tsc was not run — fix these and validate again to get the " +
      "pre-existing-error refusal, which is the check that stops a run spending 262 s per attempt on a " +
      "task no worker could pass",
      planPath,
    ));
  }

  return ChangeValidationReport.parse({
    plan: resolve(planPath),
    valid: errors.length === 0,
    checked: { steps: plan.steps.length, tasks, files: allFiles.size },
    errors,
    warnings,
    refusals,
    shapes,
    structural_only,
  });
}

/** Phase 11b §4.4: at least half the tasks must be the harder three or its verdict is withheld. */
export const hardShare = (shapes: Record<string, number>): number => {
  const total = Object.values(shapes).reduce((n, c) => n + c, 0);
  if (total === 0) return 0;
  const hard: ChangeShape[] = ["null_guard", "api_migration", "dead_code"];
  return hard.reduce((n, s) => n + (shapes[s] ?? 0), 0) / total;
};

export const renderChangeReport = (r: ChangeValidationReport): string => {
  const lines: string[] = [];
  lines.push(`${r.plan}: ${r.valid ? "valid" : "INVALID"}`);
  lines.push(`  ${r.checked.steps} step(s), ${r.checked.tasks} task(s), ${r.checked.files} file(s)`);

  const mix = Object.entries(r.shapes).sort(([a], [b]) => a.localeCompare(b));
  if (mix.length > 0) {
    const share = hardShare(r.shapes);
    lines.push(`  shapes: ${mix.map(([k, n]) => `${k} ${n}`).join(", ")}`);
    // Not an error: a plan of renames is a legitimate plan. It is a caveat on what its number can say.
    lines.push(share >= 0.5
      ? `  ${Math.round(share * 100)}% are null_guard/api_migration/dead_code — Phase 11b §4.4 is satisfied`
      : `  only ${Math.round(share * 100)}% are null_guard/api_migration/dead_code; Phase 11b §4.4 ` +
        "withholds its verdict below 50%, because a result on renames alone says only that sidecrew is " +
        "competitive on trivial changes");
  }
  if (r.structural_only) {
    lines.push("  structural pass only — tsc was not run, so the pre-existing-error refusal did not happen");
  }
  for (const e of r.errors) lines.push(`  ERROR ${e.where}: [${e.code}] ${e.message}`);
  for (const w of r.warnings) lines.push(`  warn  ${w.where}: [${w.code}] ${w.message}`);
  if (r.refusals.length > 0) {
    lines.push(`  ${r.refusals.length} task(s) refused as unsatisfiable — drop them; they do not count as planned`);
  }
  return lines.join("\n");
};
