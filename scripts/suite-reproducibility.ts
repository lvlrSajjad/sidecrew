// Is the project's own suite deterministic? — the floor under ADR-0066's `D`
//
//   npx tsx scripts/suite-reproducibility.ts <plan.json> [--runs N] [--out FILE]
//
// **Why this exists.** ADR-0077's counterfactual had `snc-27` fail with **82 regressions** and pass a
// second reading of the **same bytes** with **0**, an hour apart, against baselines reproducing each
// other exactly, with the machine bracketed either side and quiet for both. That is the third
// instance of the gate disagreeing with itself and **the first with memory pressure excluded**
// (ADR-0066 addendum, 21 Sep 2026). `D = 2/19 = 0.105` was measured where pressure was the assumed
// explanation. It is not the explanation here, and nothing else has been offered.
//
// **The cheapest hypothesis nobody has tested: the suite is not deterministic to begin with.** The
// gate compares a candidate's `passed_ids` against a baseline's. If a set of tests flips on its own
// between two runs of the *same tree*, then part of `D` is not the gate mis-judging a change at all —
// it is the instrument, and no amount of care inside `verifyChange` can remove it.
//
// **This measures that floor and nothing else. No change is applied.** One sandbox of the unmodified
// project, cloned fresh per iteration exactly as `verifyChange` clones per task, and the suite run `n`
// times. A test that passes in one run and fails in another is non-deterministic **by the same
// `passed_ids` the gate itself compares** — not by a definition invented here.
//
// ── The reading rule, frozen before the run (`PHASES.md` § exit checks) ───────────────────────────
//
// Let `flaky` = tests seen in every run that passed in some and not others, and `spread` = the
// largest difference in passed-count between any two runs. `spread` is the quantity directly
// comparable to `snc-27`'s 82.
//
//   - **`flaky = 0`** → the suite is reproducible here. `snc-27` is **not** explained by it and the
//     cause is in the gate or the machine. That is a sharper result than a number, and it makes
//     ADR-0077 option B *safer* rather than riskier.
//   - **`0 < spread < 82`** → a floor exists and is smaller than `snc-27`'s flip. Partial
//     explanation; the remainder still needs one.
//   - **`spread >= 82`** → `snc-27` is inside what this suite does unprompted. `D`'s corpus needs
//     re-reading before ADR-0077 option B leans the gate on the suite any harder.
//
// Reported with the per-run counts either way. **No arm of this rule makes the run a failure** — each
// is a finding, which is the point of freezing it before the number exists.
//
// **Counts, never names.** A test id is `<file>::<full name>` (`src/change.ts`, `passed_ids`) and the
// file is the client's tree (CLAUDE.md #7). The payload carries counts and a histogram and no
// identifiers at all.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { DEFAULT_CHANGE_TIMEOUTS, cloneSandbox, makeChangeSandbox, runSuite } from "../src/change.js";
import { readMachineState } from "../src/doctor.js";
import { run } from "../src/exec.js";
import type { TestRunner } from "../src/verifier/shared.js";

const [planPath] = process.argv.slice(2);
if (planPath === undefined) {
  process.stderr.write("usage: suite-reproducibility.ts <plan.json> [--runs N] [--out FILE]\n");
  process.exit(1);
}
const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const runs = Number(arg("--runs") ?? 20);
const outPath = arg("--out")
  ?? `experiments/gate-error-rate/results/suite-reproducibility-${new Date().toISOString().slice(0, 10)}.json`;

const say = (s: string): void => { process.stdout.write(`${s}\n`); };

const plan = JSON.parse(await readFile(planPath, "utf8")) as { project: string; test_framework: string };
const projectDir = plan.project;
const runner = plan.test_framework as TestRunner;

/** The subject of the measurement. SHA and a boolean, never the path (CLAUDE.md #7). */
const provenance = async (dir: string): Promise<{ commit: string | null; clean: boolean | null }> => {
  const head = await run("git", ["-C", dir, "rev-parse", "HEAD"], { timeoutMs: 15_000 });
  const status = await run("git", ["-C", dir, "status", "--porcelain"], { timeoutMs: 30_000 });
  return {
    commit: head.code === 0 ? head.stdout.trim() : null,
    clean: status.code === 0 ? status.stdout.trim().length === 0 : null,
  };
};

const project = await provenance(projectDir);
say(`project: ${project.commit?.slice(0, 10) ?? "unknown"}, tree ${project.clean === null ? "unknown" : project.clean ? "clean" : "DIRTY"}`);
if (project.clean === false) {
  throw new Error("the project's tree is dirty — this measures a tree, and a moving one is not a measurement");
}
say(`runner=${runner}, runs=${runs}`);

const base = await makeChangeSandbox(projectDir);
say("base sandbox made; each run gets its own clone of it, as verifyChange does per task");

interface Run {
  i: number;
  started_at: string;
  ms: number;
  reported: boolean;
  ran: number;
  passed: number;
  failed: number;
  machine: { before: unknown; after: unknown };
}

const rows: Run[] = [];
/** id → how many runs it passed in. Ids live only in memory; the payload gets counts. */
const passedCount = new Map<string, number>();
/** id → how many runs it was seen in at all. A test absent from a report is not evidence (ADR-0053). */
const seenCount = new Map<string, number>();
/** id → its suite file, so distinct suites can be counted without naming one. */
const suiteOf = new Map<string, string>();

try {
  for (let i = 1; i <= runs; i += 1) {
    const machineBefore = await readMachineState();
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    const clone = await cloneSandbox(base);
    let suite;
    try {
      suite = await runSuite(clone, projectDir, runner, DEFAULT_CHANGE_TIMEOUTS.tests);
    } finally {
      await rm(clone, { recursive: true, force: true });
    }
    const ms = Math.round(performance.now() - t0);
    const machineAfter = await readMachineState();

    for (const id of suite.seen_ids) {
      seenCount.set(id, (seenCount.get(id) ?? 0) + 1);
      suiteOf.set(id, id.split("::")[0] ?? id);
    }
    for (const id of suite.passed_ids) passedCount.set(id, (passedCount.get(id) ?? 0) + 1);

    rows.push({
      i, started_at: startedAt, ms,
      reported: suite.reported, ran: suite.ran, passed: suite.passed, failed: suite.failed,
      machine: { before: machineBefore, after: machineAfter },
    });
    const spreadSoFar = Math.max(...rows.map((r) => r.passed)) - Math.min(...rows.map((r) => r.passed));
    say(`[${i}/${runs}] ${suite.passed}/${suite.ran} passing  ${(ms / 1000).toFixed(0)}s` +
        `  spread so far ${spreadSoFar}  ${machineAfter.pressure}`);
  }
} finally {
  await rm(base, { recursive: true, force: true });
}

// ── the reading ───────────────────────────────────────────────────────────────────────────────────

const reported = rows.filter((r) => r.reported);
const passedCounts = reported.map((r) => r.passed);
const spread = passedCounts.length === 0 ? 0 : Math.max(...passedCounts) - Math.min(...passedCounts);

/** Seen in every reported run, and passed in some but not all of them. */
const flaky: string[] = [];
for (const [id, seen] of seenCount) {
  if (seen !== reported.length) continue;
  const p = passedCount.get(id) ?? 0;
  if (p > 0 && p < reported.length) flaky.push(id);
}
const histogram: Record<string, number> = {};
for (const id of flaky) {
  const k = String(passedCount.get(id) ?? 0);
  histogram[k] = (histogram[k] ?? 0) + 1;
}
const flakySuites = new Set(flaky.map((id) => suiteOf.get(id) ?? id)).size;

const verdict = flaky.length === 0
  ? "REPRODUCIBLE — snc-27 is not explained by the suite; the cause is in the gate or the machine"
  : spread >= 82
    ? "snc-27 IS INSIDE what this suite does unprompted — D's corpus needs re-reading before ADR-0077 B"
    : "A FLOOR EXISTS and is smaller than snc-27's flip — partial explanation, the remainder needs one";

const payload = {
  measured: true,
  experiment: "gate-error-rate",
  what: "is the project's own suite deterministic? the floor under D (ADR-0066 addendum)",
  rule: "frozen in this script's header before the run, 22 Sep 2026",
  change_applied: false,
  runs_requested: runs,
  runs_reported: reported.length,
  project: { commit: project.commit, tree_clean: project.clean },
  runner,
  result: {
    passed_min: passedCounts.length ? Math.min(...passedCounts) : null,
    passed_max: passedCounts.length ? Math.max(...passedCounts) : null,
    /** The quantity directly comparable to snc-27's 82. */
    spread,
    flaky_tests: flaky.length,
    flaky_suites: flakySuites,
    /** flaky test → how many of the runs it passed in. Counts only. */
    passed_in_k_runs: histogram,
    always_passed: [...seenCount].filter(([id, s]) => s === reported.length && (passedCount.get(id) ?? 0) === s).length,
    never_passed: [...seenCount].filter(([id, s]) => s === reported.length && (passedCount.get(id) ?? 0) === 0).length,
  },
  verdict,
  per_run: rows,
};

// The refusal every experiment script here carries: no segment of the project's path may appear.
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

say("");
say(`  runs reported        ${reported.length}/${runs}`);
say(`  passed per run       ${payload.result.passed_min}–${payload.result.passed_max}   spread ${spread}`);
say(`  non-deterministic    ${flaky.length} test(s) across ${flakySuites} suite(s)`);
say(`  → ${verdict}`);
say(`  → ${outPath}`);
