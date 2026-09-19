// The gate's own error rate — replay candidates the gate has already judged, and count disagreements.
//
//   npx tsx scripts/gate-replay.ts <reference-run-dir> <project-dir> <label> [--limit N] [--out FILE]
//
// Protocol and the frozen rule: `experiments/gate-error-rate/README.md`. Read §4 before changing a
// line of this file; several things that look like details here are clauses of it.
//
// **Why this does not call `runFix`.** `runFix` takes a plan, and the plan this corpus came from is
// gitignored and was not kept (CLAUDE.md #7). It does not need to: every `ChangeTask` and every
// `ChangeCandidate` was written to the run directory as the run went (ADR-0023), so the corpus is
// complete without it — *the run is the record, not the verdict*. What this script drives is exactly
// the production gate, `verifyChange`, which is the function `runFix` itself calls. Re-deriving the
// plan would add a reconstruction between the corpus and the gate, and a replay is worth nothing if
// anything between the two is not the original.
//
// **One baseline for the whole corpus, and it is checked rather than assumed.** The reference run had
// two steps, so in principle a step-1 candidate could depend on step 0's survivors having landed. It
// does not here: the two steps' file sets are **disjoint**, which this script asserts at startup and
// refuses to run without. A replay against a baseline that does not describe the world the candidate
// assumed is not a replay, it is a different experiment with the same name.
import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";
import { performance } from "node:perf_hooks";
import { captureBaseline, makeChangeSandbox, verifyChange } from "../src/change.js";
import { readMachineState } from "../src/doctor.js";
import { ChangeCandidate, ChangeTask, crossesCalendarDay, swapGrowthGb, type ChangeVerdict } from "../src/schemas.js";
import type { TestRunner } from "../src/verifier/shared.js";

const [refRun, projectDir, label] = process.argv.slice(2);
if (refRun === undefined || projectDir === undefined || label === undefined) {
  process.stderr.write("usage: gate-replay.ts <reference-run-dir> <project-dir> <label> [--limit N] [--out FILE]\n");
  process.exit(1);
}
const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const limit = Number(arg("--limit") ?? 0) || Infinity;
const outPath = arg("--out") ?? `experiments/gate-error-rate/results/replay-${label}-${new Date().toISOString().slice(0, 10)}.json`;
const runner: TestRunner = (arg("--runner") ?? "jest") as TestRunner;
const tsconfig = arg("--tsconfig") ?? "tsconfig.json";

const say = (s: string): void => { process.stdout.write(`${s}\n`); };

/**
 * A candidate's identity, over its edits alone.
 *
 * Path and contents, sorted by path, with separators — so two candidates hash equal **iff** they would
 * write the same bytes to the same files. Everything else on a `ChangeCandidate` (timings, usage, the
 * worker that produced it) is provenance rather than content, and a replay is about content.
 */
const editsSha = (c: ChangeCandidate): string => {
  const h = createHash("sha256");
  for (const e of [...c.edits].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(e.path); h.update("\0"); h.update(e.contents); h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
};

interface Reference { task_id: string; survived: boolean; stage_reached: string; regressed: number }

/**
 * The reference verdicts, read as **raw JSON** rather than parsed.
 *
 * §3 confound 2: these predate ADR-0067, so they carry no `passed_before` / `passed_after` and do not
 * satisfy the current `ChangeVerdict` refinement. Re-parsing them would either fail or require
 * inventing the two missing fields, and inventing a field to make an old record satisfy a new gate is
 * how a number quietly stops meaning what its label says. `survived` is the only field §4.1 compares
 * and it has been present throughout.
 */
const readReference = async (dir: string, name: string): Promise<Reference> => {
  const v = JSON.parse(await readFile(join(dir, "verdicts", name), "utf8")) as Record<string, unknown>;
  const tests = v.tests as { regressed?: string[] } | null;
  return {
    task_id: v.task_id as string,
    survived: v.survived as boolean,
    stage_reached: v.stage_reached as string,
    regressed: tests?.regressed?.length ?? 0,
  };
};

// ── assemble the corpus ───────────────────────────────────────────────────────────────────────────

const verdictNames = (await readdir(join(refRun, "verdicts"))).filter((f) => f.endsWith(".json")).sort();
type Entry = { name: string; task: ChangeTask; candidate: ChangeCandidate; sha: string; ref: Reference };
const entries: Entry[] = [];
for (const name of verdictNames) {
  const task = ChangeTask.parse(JSON.parse(await readFile(join(refRun, "tasks", name), "utf8")));
  const candidate = ChangeCandidate.parse(JSON.parse(await readFile(join(refRun, "candidates", name), "utf8")));
  const ref = await readReference(refRun, name);
  // §4.2 exclusion 1: a reference that stopped at `generate` never reached the gate, so there is no
  // evaluation to disagree with.
  if (ref.stage_reached === "generate") { say(`skip ${ref.task_id}: reference stopped at generate`); continue; }
  entries.push({ name: basename(name, ".json"), task, candidate, sha: editsSha(candidate), ref });
}

/**
 * Group the reference's evaluations by content. The retry means some candidates were evaluated twice,
 * and §2 of the protocol is exactly those pairs: where two reference evaluations of identical bytes
 * disagree with each other, the disagreement is already measured and the replay is a third opinion
 * rather than the second.
 */
const byS = new Map<string, Entry[]>();
for (const e of entries) byS.set(e.sha, [...(byS.get(e.sha) ?? []), e]);
const corpus = [...byS.values()].map((g) => g[0]).slice(0, limit === Infinity ? undefined : limit);

say(`corpus: ${entries.length} reference evaluations → ${byS.size} distinct candidates` +
    `${corpus.length < byS.size ? ` (replaying ${corpus.length}, --limit)` : ""}`);

// The disjointness §4 depends on, asserted rather than trusted.
const stepOf = (id: string): string => id.split("-")[0];
const filesByStep = new Map<string, Set<string>>();
for (const e of entries) {
  const s = stepOf(e.task.task_id);
  const set = filesByStep.get(s) ?? new Set<string>();
  for (const f of e.task.files) set.add(f.path);
  filesByStep.set(s, set);
}
const steps = [...filesByStep.entries()];
for (let i = 0; i < steps.length; i += 1) {
  for (let j = i + 1; j < steps.length; j += 1) {
    const overlap = [...steps[i][1]].filter((f) => steps[j][1].has(f));
    if (overlap.length > 0) {
      throw new Error(
        `groups ${steps[i][0]} and ${steps[j][0]} share ${overlap.length} file(s), so one pristine ` +
        "baseline cannot serve both — a later candidate assumed an earlier one had landed. " +
        "Replay each group against its own baseline instead (experiments/gate-error-rate/README.md §4).",
      );
    }
  }
}
say(`file-set disjointness across ${steps.length} groups: ok`);

// ── one baseline, then one evaluation per candidate ───────────────────────────────────────────────

const machineAtStart = await readMachineState();
say(`machine at start: pressure=${machineAtStart.pressure} free=${machineAtStart.free_gb?.toFixed(1)} ` +
    `swap=${machineAtStart.swap_gb?.toFixed(1)} compressed=${machineAtStart.compressed_gb?.toFixed(1)}`);

const sandbox = await makeChangeSandbox(projectDir);
say(`sandbox: ${sandbox}`);
const t0 = performance.now();
const { baseline } = await captureBaseline(sandbox, { projectDir, runner, tsconfig });
say(`baseline: ${baseline.tests.passed}/${baseline.tests.ran} passing, ${baseline.errors.total} tsc error(s), ` +
    `${((performance.now() - t0) / 1000).toFixed(0)}s, captured_at ${baseline.captured_at}`);

interface Pair {
  task_id: string; edits_sha: string;
  reference: { survived: boolean; stage_reached: string; regressed: number; evaluations: number; self_consistent: boolean };
  replay: { survived: boolean; stage_reached: string; regressed: number; ms: number };
  disagreement: "none" | "strict" | "lenient";
  crossed_calendar_day: boolean | null;
  swap_growth_gb: number | null;
}

const pairs: Pair[] = [];
for (const [i, e] of corpus.entries()) {
  const group = byS.get(e.sha)!;
  const refSurvived = group.map((g) => g.ref.survived);
  const selfConsistent = new Set(refSurvived).size === 1;
  const start = performance.now();
  let verdict: ChangeVerdict;
  try {
    verdict = await verifyChange(e.task, e.candidate, { sandbox, baseline, projectDir, runner, tsconfig });
  } catch (err) {
    // §4.2 exclusion 2: the gate could not run at all. Never the gate's disagreement, and never
    // silently a failure either — it is named in the result with its reason.
    say(`  ${e.task.task_id}: EXCLUDED — the gate could not run: ${(err as Error).message.slice(0, 200)}`);
    continue;
  }
  const ms = performance.now() - start;
  // With an inconsistent reference the candidate is already a measured disagreement (§2); the
  // majority of the reference evaluations is what the replay is compared against, and the
  // inconsistency travels with the row so no reader has to take the collapse on trust.
  const refValue = refSurvived.filter(Boolean).length > refSurvived.length / 2;
  const disagreement = verdict.survived === refValue ? "none" : (refValue ? "strict" : "lenient");
  pairs.push({
    task_id: e.task.task_id,
    edits_sha: e.sha,
    reference: {
      survived: refValue, stage_reached: e.ref.stage_reached, regressed: e.ref.regressed,
      evaluations: group.length, self_consistent: selfConsistent,
    },
    replay: {
      survived: verdict.survived, stage_reached: verdict.stage_reached,
      regressed: verdict.tests?.regressed.length ?? 0, ms: Math.round(ms),
    },
    disagreement,
    crossed_calendar_day: crossesCalendarDay(verdict),
    swap_growth_gb: swapGrowthGb(verdict.machine),
  });
  const mark = disagreement === "none" ? "  ok" : `  ** ${disagreement.toUpperCase()} DISAGREEMENT **`;
  say(`[${i + 1}/${corpus.length}] ${e.task.task_id} sha=${e.sha} ref=${refValue} replay=${verdict.survived}` +
      ` ${(ms / 1000).toFixed(0)}s${mark}`);
}

const disagreements = pairs.filter((p) => p.disagreement !== "none");
const D = pairs.length === 0 ? null : disagreements.length / pairs.length;
const verdictFor = (d: number | null): string =>
  d === null ? "VOID — no pairs" : d <= 0.02 ? "ACCEPTABLE" : d <= 0.10 ? "MATERIAL" : "UNACCEPTABLE";

const result = {
  measured: true,
  experiment: "gate-error-rate",
  label,
  rule: "experiments/gate-error-rate/README.md §4, frozen 2026-09-19",
  reference_run: basename(refRun),
  baseline: { captured_at: baseline.captured_at, ran: baseline.tests.ran, passed: baseline.tests.passed, tsc_errors: baseline.errors.total },
  machine_at_start: machineAtStart,
  machine_at_end: await readMachineState(),
  pairs: pairs.length,
  disagreements: disagreements.length,
  strict: disagreements.filter((p) => p.disagreement === "strict").length,
  lenient: disagreements.filter((p) => p.disagreement === "lenient").length,
  reference_self_inconsistent: pairs.filter((p) => !p.reference.self_consistent).map((p) => p.task_id),
  D,
  verdict: verdictFor(D),
  rows: pairs,
};
await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
say(`\nD = ${disagreements.length}/${pairs.length}${D === null ? "" : ` = ${D.toFixed(3)}`} — ${result.verdict}`);
say(`  strict (a false negative now): ${result.strict} · lenient (the reference was one): ${result.lenient}`);
say(`written: ${outPath}`);
