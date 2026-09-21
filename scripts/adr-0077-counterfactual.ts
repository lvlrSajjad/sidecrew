// ADR-0077 option D — would probe 1's clean-target tasks survive the suite, if test-file *type*
// errors were observations rather than failures?
//
//   npx tsx scripts/adr-0077-counterfactual.ts <run-dir> <plan.json> [--out FILE] [--limit N]
//
// The project directory is read from the plan's own `project` field rather than passed on the command
// line, for the reason `editing-ceiling-probe1.sh` gives about the plan: it is the client's path, and
// the fewer places it has to be typed the fewer places it can be pasted into something tracked.
//
// **The rule, frozen in ADR-0077 before any number existed.** Re-gate probe 1's **15 clean-target
// tasks** — target file compiled clean, every introduced error outside it — with test-file type errors
// demoted to observations, and count how many survive the project's suite. The candidates are already
// on disk, so there is no worker and no generation: this is the verify stage, replayed.
//
// **`changeSurvives` is not modified and `verifyChange` is not called.** ADR-0077's first constraint
// is that the production gate stays what ADR-0046 and ADR-0048 made it — a measurement that edits the
// gate to get a better number is the thing this project exists to be the opposite of. So the rule
// below is *this harness's*, written out here where a reader can see it, and the gate is untouched.
//
// **It cannot be a replay of `verifyChange`'s output either**, which is what made this more than an
// afternoon. `verifyChange` short-circuits: the suite is skipped when `compile_ok` is false
// (`src/change.ts`, *"Skipped when the verdict is already settled"*), and for all 15 of these
// `compile_ok` was already false from the test-file errors. **The suite therefore never ran, and there
// is no suite result on disk to re-read.** This harness has to drive apply → compile → suite itself.
//
// **What is deliberately reused rather than re-derived.** The sandbox, the baseline, `typecheck`,
// `runSuite`, `safeName` and `isTestArtefact` are the production functions. The standing hazard is
// specific: a harness that re-derived a filename instead of using the writer's function reported
// `n₂ = 0` with a plausible reason and a confident, wrong INCONCLUSIVE. `isTestArtefact` matters most
// — the whole argument is *"the errors land in files the gate forbids editing"*, which is only true if
// "test file" here means exactly what the gate means by it.
//
// **The denominator is 15, and it is reported beside the 30.** This is a conditional number about a
// subset chosen after seeing failures, which is exactly the adjustment §4.0 precondition 4 forbids
// doing quietly. Nothing in the output is called a survival rate.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  DEFAULT_CHANGE_TIMEOUTS, captureBaseline, cloneSandbox, makeChangeSandbox, runSuite, typecheck,
} from "../src/change.js";
import { checkConfinement, isTestArtefact } from "../src/confinement.js";
import { readMachineState } from "../src/doctor.js";
import { ChangeCandidate, ChangeTask, type ErrorCounts } from "../src/schemas.js";
import { safeName } from "../src/verifier/shared.js";
import type { TestRunner } from "../src/verifier/shared.js";

const [runDir, planPath] = process.argv.slice(2);
if (runDir === undefined || planPath === undefined) {
  process.stderr.write("usage: adr-0077-counterfactual.ts <run-dir> <plan.json> [--out FILE] [--limit N]\n");
  process.exit(1);
}
const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const limit = Number(arg("--limit") ?? 0) || Infinity;
/**
 * One task, re-evaluated on its own. The gate's own error rate is `D = 2/19` (ADR-0066), so a single
 * failing observation is exactly the one that should not be reported without a second reading.
 */
const only = arg("--only");
const outPath = arg("--out")
  ?? `experiments/editing-ceiling/results/adr-0077-counterfactual-${new Date().toISOString().slice(0, 10)}.json`;

const say = (s: string): void => { process.stdout.write(`${s}\n`); };

// ── the subset, taken from the published classification and re-derived as a check ─────────────────

/**
 * The 15 are `unsatisfiable_breakdown.target_was_fixed_correctly` in the tracked classification, and
 * the ids are on its rows as `target_clean`. They are read from that file rather than recomputed,
 * because it is the artefact ADR-0077 names — and then recomputed anyway from the verdicts, because a
 * subset that two independent readings disagree about is not a subset anybody should measure on.
 */
const CLASSIFIED = "experiments/editing-ceiling/results/probe1-14b-classified.json";
interface ClassifiedRow { task_id: string; target_clean?: boolean }
const classified = JSON.parse(await readFile(CLASSIFIED, "utf8")) as {
  N: number;
  unsatisfiable_breakdown: { total: number; target_was_fixed_correctly: number };
  per_task: Record<string, ClassifiedRow[]>;
};
const declaredIds = classified.per_task.unsatisfiable_adr_0071
  .filter((r) => r.target_clean === true)
  .map((r) => r.task_id)
  .sort();
if (declaredIds.length !== classified.unsatisfiable_breakdown.target_was_fixed_correctly) {
  throw new Error(
    `${CLASSIFIED} says ${classified.unsatisfiable_breakdown.target_was_fixed_correctly} tasks had the ` +
    `target fixed correctly and ${declaredIds.length} rows carry target_clean. Refusing to guess which is right.`,
  );
}
say(`subset: ${declaredIds.length} of ${classified.N} — ${declaredIds.join(", ")}`);

/** The retry convention `safeName` produces: `snc-02#1` is written as `snc-02.1.json`. */
const attemptsOf = (dir: string, taskId: string): string[] => {
  const base = safeName(taskId);
  const names = [`${base}.json`, ...Array.from({ length: 10 }, (_, i) => `${base}.${i}.json`)];
  return names.filter((n) => existsSync(join(dir, n))).sort();
};

interface Loaded { task_id: string; task: ChangeTask; candidate: ChangeCandidate; attempts: number }
const loaded: Loaded[] = [];
for (const id of declaredIds) {
  // The last attempt is the one the task was judged on; earlier ones are the free mechanical retry.
  // The classifier took `cands[-1]` and this has to mean the same thing to be comparable.
  const verdicts = attemptsOf(join(runDir, "verdicts"), id);
  if (verdicts.length === 0) throw new Error(`no verdict on disk for ${id} — the run directory is not probe 1's`);
  const name = verdicts.at(-1)!;
  const task = ChangeTask.parse(JSON.parse(await readFile(join(runDir, "tasks", name), "utf8")));
  const candidate = ChangeCandidate.parse(JSON.parse(await readFile(join(runDir, "candidates", name), "utf8")));
  // Re-derivation, against the same fields the classifier read. A disagreement here means the run
  // directory and the classification are not about the same run, and every number below would be
  // about neither.
  const v = JSON.parse(await readFile(join(runDir, "verdicts", name), "utf8")) as {
    survived: boolean; errors?: { remaining_in_target?: Record<string, number>; introduced?: Record<string, number> };
  };
  const own = new Set(task.files.map((f) => f.path));
  const remaining = Object.keys(v.errors?.remaining_in_target ?? {}).length;
  const inside = Object.keys(v.errors?.introduced ?? {}).filter((f) => own.has(f)).length;
  const outside = Object.keys(v.errors?.introduced ?? {}).filter((f) => !own.has(f)).length;
  if (v.survived || remaining > 0 || inside > 0 || outside === 0) {
    throw new Error(
      `${id} does not re-derive as clean-target-unsatisfiable from its own verdict ` +
      `(survived=${v.survived} remaining=${remaining} inside=${inside} outside=${outside}). ` +
      `The classification and this run directory disagree; refusing to measure on a subset nobody can reproduce.`,
    );
  }
  loaded.push({ task_id: id, task, candidate, attempts: verdicts.length });
}
say(`re-derived all ${loaded.length} from their own verdicts: ok`);

const selected = only === undefined ? loaded : loaded.filter((e) => e.task_id === only);
if (only !== undefined && selected.length === 0) throw new Error(`--only ${only} is not one of the ${loaded.length}`);
const corpus = selected.slice(0, limit === Infinity ? undefined : limit);

// ── the plan supplies the strictness the whole experiment is about ────────────────────────────────

const plan = JSON.parse(await readFile(planPath, "utf8")) as {
  project: string; test_framework: string; compiler_flags?: string[]; steps: { tasks: { task_id: string }[] }[];
};
const projectDir = plan.project;
const runner = plan.test_framework as TestRunner;
const compilerFlags = plan.compiler_flags ?? [];
const declaredN = plan.steps.reduce((a, s) => a + s.tasks.length, 0);
if (compilerFlags.length === 0) {
  throw new Error("the plan carries no compiler_flags — probe 1 ran under --strictNullChecks (ADR-0063) and this would be a different experiment");
}
if (declaredN !== classified.N) {
  throw new Error(`the plan declares ${declaredN} tasks and the classification says ${classified.N}`);
}
say(`plan: ${declaredN} declared tasks, runner=${runner}, flags=${compilerFlags.join(" ")}`);

// ── this harness's rule, written out rather than borrowed ─────────────────────────────────────────

/** Errors in the files the task was allowed to touch. */
const pick = (counts: ErrorCounts, files: string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const f of files) { const n = counts.by_file[f] ?? 0; if (n > 0) out[f] = n; }
  return out;
};
/** Files anywhere with more errors after than before, and by how many. */
const introducedBy = (before: ErrorCounts, after: ErrorCounts): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [file, n] of Object.entries(after.by_file)) {
    const was = before.by_file[file] ?? 0;
    if (n > was) out[file] = n - was;
  }
  return out;
};

// ── one baseline, then one evaluation per candidate ───────────────────────────────────────────────

const timeouts = DEFAULT_CHANGE_TIMEOUTS;
const tsconfig = "tsconfig.json";
const machineAtStart = await readMachineState();
say(`machine at start: pressure=${machineAtStart.pressure} free=${machineAtStart.free_gb?.toFixed(1)} swap=${machineAtStart.swap_gb?.toFixed(1)}`);

const sandbox = await makeChangeSandbox(projectDir);
const t0 = performance.now();
const allFiles = [...new Set(corpus.flatMap((e) => e.task.files.map((f) => f.path)))];
const { baseline } = await captureBaseline(sandbox, { projectDir, runner, tsconfig, files: allFiles, compilerFlags });
const before = baseline.errors;
say(`baseline: ${baseline.tests.passed}/${baseline.tests.ran} passing, ${before.total} tsc error(s), ` +
    `${((performance.now() - t0) / 1000).toFixed(0)}s, captured_at ${baseline.captured_at}`);

interface Row {
  task_id: string;
  attempts: number;
  confined: boolean;
  /** The production rule: nothing left in the target, nothing introduced anywhere. */
  compile_ok_production: boolean;
  /** This harness's rule: nothing left in the target, nothing introduced in a **non-test** file. */
  compile_ok_counterfactual: boolean;
  remaining_in_target: number;
  introduced_total: number;
  /** Demoted to an observation by the counterfactual rule. */
  introduced_in_test_files: number;
  /** Not demoted — these still fail, under either rule. */
  introduced_in_non_test_files: number;
  test_file_count: number;
  non_test_file_count: number;
  reached_suite: boolean;
  tests_ok: boolean | null;
  regressed: number | null;
  /** How many distinct suite files the regressed tests came from. Counts, never names (CLAUDE.md #7). */
  regressed_suites: number | null;
  ran_before: number | null;
  ran_after: number | null;
  passed_before: number | null;
  passed_after: number | null;
  survived_counterfactual: boolean;
  ms: number;
  /**
   * ADR-0066 measured a byte-identical candidate producing 155 named regressions on a swapping
   * machine. A run that reaches the suite has to bracket each verdict, not sample the machine once at
   * the start and call that the conditions — which is what this harness did on its first pass.
   */
  machine: { before: unknown; after: unknown };
}

const rows: Row[] = [];
for (const [i, e] of corpus.entries()) {
  const start = performance.now();
  const machineBefore = await readMachineState();
  const own = e.task.files.map((f) => f.path);
  // Confinement is the production check, unchanged — the counterfactual is about the *compile* clause
  // only. A candidate that edited a test file was never in this subset, and this asserts it.
  const confined = checkConfinement(e.task, e.candidate).length === 0;

  const clone = await cloneSandbox(sandbox);
  let row: Row;
  try {
    for (const edit of e.candidate.edits) {
      await mkdir(dirname(join(clone, edit.path)), { recursive: true });
      await writeFile(join(clone, edit.path), edit.contents, "utf8");
    }
    const tsc = await typecheck(clone, projectDir, tsconfig, timeouts.compile, compilerFlags);
    const after = tsc.errors;
    const remaining = pick(after, own);
    const introduced = introducedBy(before, after);
    const testFiles = Object.entries(introduced).filter(([f]) => isTestArtefact(f));
    const nonTestFiles = Object.entries(introduced).filter(([f]) => !isTestArtefact(f));

    const compileProduction = Object.keys(remaining).length === 0 && Object.keys(introduced).length === 0;
    // **The counterfactual rule.** Errors in files the gate forbids a candidate from editing are
    // observations; everything else is unchanged.
    const compileCounterfactual = Object.keys(remaining).length === 0 && nonTestFiles.length === 0;

    let tests_ok: boolean | null = null;
    let regressed: number | null = null;
    let regressedSuites: number | null = null;
    let ranAfter: number | null = null;
    let passedAfter: number | null = null;
    if (confined && compileCounterfactual) {
      const suite = await runSuite(clone, projectDir, runner, timeouts.tests);
      const passedNow = new Set(suite.passed_ids);
      const seenNow = new Set(suite.seen_ids);
      // The production tests_ok, verbatim (ADR-0053 on vanished ids, ADR-0067 on the count clauses).
      // Only the compile clause is counterfactual; weakening this one too would measure nothing.
      const reg = baseline.tests.passed_ids.filter((id) => !passedNow.has(id) && seenNow.has(id));
      regressed = reg.length;
      // ADR-0074's reading: which suites regressed is the only structure anyone has found in these.
      // The count of distinct suites is that structure without the client's file names.
      regressedSuites = new Set(reg.map((id) => id.split(" ")[0])).size;
      ranAfter = suite.ran;
      passedAfter = suite.passed;
      tests_ok = suite.reported
        && reg.length === 0
        && suite.ran >= baseline.tests.ran
        && suite.ran > 0
        && suite.passed >= baseline.tests.passed;
    }

    row = {
      task_id: e.task_id,
      attempts: e.attempts,
      confined,
      compile_ok_production: compileProduction,
      compile_ok_counterfactual: compileCounterfactual,
      remaining_in_target: Object.values(remaining).reduce((a, b) => a + b, 0),
      introduced_total: Object.values(introduced).reduce((a, b) => a + b, 0),
      introduced_in_test_files: testFiles.reduce((a, [, n]) => a + n, 0),
      introduced_in_non_test_files: nonTestFiles.reduce((a, [, n]) => a + n, 0),
      // Counts, never names: the file names are the client's tree (CLAUDE.md #7).
      test_file_count: testFiles.length,
      non_test_file_count: nonTestFiles.length,
      reached_suite: tests_ok !== null,
      tests_ok,
      regressed,
      regressed_suites: regressedSuites,
      ran_before: tests_ok === null ? null : baseline.tests.ran,
      ran_after: ranAfter,
      passed_before: tests_ok === null ? null : baseline.tests.passed,
      passed_after: passedAfter,
      survived_counterfactual: confined && compileCounterfactual && tests_ok === true,
      ms: Math.round(performance.now() - start),
      machine: { before: machineBefore, after: await readMachineState() },
    };
  } finally {
    await rm(clone, { recursive: true, force: true });
  }

  rows.push(row);
  const mark = row.survived_counterfactual ? "  ** SURVIVES **"
    : row.reached_suite ? `  reached the suite, ${row.regressed} regression(s)`
    : "  did not reach the suite";
  say(`[${i + 1}/${corpus.length}] ${row.task_id} compile'=${row.compile_ok_counterfactual}` +
      ` demoted=${row.introduced_in_test_files} kept=${row.introduced_in_non_test_files}` +
      ` ${(row.ms / 1000).toFixed(0)}s${mark}`);
}

// ── the result ────────────────────────────────────────────────────────────────────────────────────

const reachedSuite = rows.filter((r) => r.reached_suite).length;
const survived = rows.filter((r) => r.survived_counterfactual).length;
const allIntroducedWereTests = rows.every((r) => r.non_test_file_count === 0);

const payload = {
  measured: true,
  experiment: "editing-ceiling",
  what: "ADR-0077 option D — the counterfactual: would the clean-target tasks survive the suite if test-file type errors were observations?",
  rule: "ADR-0077, option D, frozen 20 Sep 2026 before any number existed",
  gate_modified: false,
  note: "changeSurvives and verifyChange are untouched. This harness applies its own compile rule to a "
      + "replayed verify; the tests_ok clause is the production one, verbatim. The result is a "
      + "COUNTERFACTUAL, not a survival rate.",
  denominator: {
    n: rows.length,
    of_declared: classified.N,
    note: "A conditional number about a subset chosen after seeing failures. S14 = 2/30 is the rule's "
        + "number and is not recomputed here (§4.0 precondition 4).",
  },
  counterfactual: {
    reached_the_suite: reachedSuite,
    survived: survived,
    did_not_reach_the_suite: rows.length - reachedSuite,
  },
  cross_check: {
    every_introduced_error_was_in_a_test_file: allIntroducedWereTests,
    note: "ADR-0077 read 21 of 21 off the reference verdicts. This is the same claim re-measured on "
        + "this subset, from a fresh typecheck rather than from the recorded verdict.",
  },
  baseline: {
    captured_at: baseline.captured_at,
    ran: baseline.tests.ran,
    passed: baseline.tests.passed,
    tsc_errors: before.total,
  },
  compiler_flags: compilerFlags,
  runner,
  machine_at_start: machineAtStart,
  per_task: rows,
};

// The same refusal `editing-ceiling-classify.py` carries: the project directory's name segments must
// not appear anywhere in what is about to be written to a tracked path.
const blob = JSON.stringify(payload).toLowerCase();
const generic = new Set(["users", "coding", "home", "src", "repos", "projects", "documents", "work", "dev", ""]);
const leaked = [...new Set(projectDir.replace(/\\/g, "/").split("/")
  .filter((seg) => !generic.has(seg.toLowerCase()) && seg.length > 2 && blob.includes(seg.toLowerCase())))];
if (leaked.length > 0) {
  process.stderr.write(`REFUSING to write: ${leaked.length} client path segment(s) in the payload\n`);
  process.exit(2);
}

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
await rm(sandbox, { recursive: true, force: true });

say("");
say(`  reached the suite      ${reachedSuite}/${rows.length}`);
say(`  survived              ${survived}/${rows.length}   (counterfactual, beside S₁₄ = 2/${classified.N})`);
say(`  every introduced error was in a test file: ${allIntroducedWereTests}`);
say(`  → ${outPath}`);
say(`  reference run: ${basename(runDir).replace(/^(\d{4}-\d{2}-\d{2}T[\d-]+Z)-.*$/, "$1")} (suffix dropped — it is the project's name)`);
