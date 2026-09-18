// The CLI subcommands that drive the pipeline: `generate`, `verify`, `plan`, `run`, `fix`, `escalate`, `review`.
//
// They exist for the same reason `doctor` does — so that a human can do one step by hand and read the
// answer. The MCP tools and these share every function below `cli.ts`; nothing here is a second
// implementation of anything.
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { discoverWorkers, generate, portsFromEnv, runBatch } from "./batch.js";
import { escalationBatch, renderEscalationBatch, resolveRunDir, runLanguage } from "./escalate.js";
import { renderChangeReport, validateChangePlan } from "./fix-validate.js";
import { findOrphanSandboxes, sweepOrphanSandboxes, type Orphan } from "./change.js";
import { renderRunReport, runReport } from "./report.js";
import { runFix } from "./fix.js";
import type { RunReport } from "./report.js";
import { buildTask, functionOfTaskId, loadPlan, PlanError, verifyCandidate } from "./plan.js";
import { buildReviewQueue, renderReviewQueue } from "./review.js";
import {
  BatchResult, Candidate, ShapeKind, WorkerTask,
  type ChangeValidationReport, type EscalationBatch, type FixResult, type ReviewQueue,
  type ValidationReport, type Verdict,
} from "./schemas.js";
import { renderReport, validatePlan } from "./validate.js";

const out = (s: string): void => { process.stdout.write(`${s}\n`); };
const json = (value: unknown): void => out(JSON.stringify(value, null, 2));

export interface GenerateOpts {
  planPath?: string;
  taskPath?: string;
  functionName?: string;
  shape?: string;
  outPath?: string;
  json?: boolean;
}

/**
 * One candidate, from a plan plus a function and a shape, or from a `WorkerTask` on disk.
 *
 * It prints the `Candidate` rather than the test, because the candidate is the record: the model, the
 * revision, the seed and the token counts are what make a survival rate mean anything later.
 * `--out` writes the test source itself, for the case where you want to look at it.
 */
export async function generateCommand(opts: GenerateOpts): Promise<void> {
  let task: WorkerTask;
  if (opts.taskPath !== undefined) {
    task = WorkerTask.parse(JSON.parse(await readFile(opts.taskPath, "utf8")));
  } else {
    if (opts.planPath === undefined || opts.functionName === undefined || opts.shape === undefined) {
      throw new Error("sidecrew generate needs either a task.json or --plan P --function F --shape S");
    }
    const loaded = await loadPlan(opts.planPath);
    const fn = loaded.plan.functions.find((f) => f.name === opts.functionName);
    if (fn === undefined) throw new PlanError(`${opts.planPath} plans no function called ${opts.functionName}`);
    task = buildTask(loaded, fn, ShapeKind.parse(opts.shape));
  }

  const workers = await discoverWorkers(portsFromEnv());
  const worker = workers[0];
  if (worker === undefined) throw new Error("no local worker is answering — start one with: sidecrew serve");

  const candidate = await generate(task, worker);
  if (opts.outPath !== undefined) {
    await writeFile(opts.outPath, candidate.test_source, "utf8");
    out(`wrote ${opts.outPath}`);
  }
  json(candidate);
}

export interface VerifyOpts {
  testFile: string;
  planPath: string;
  functionName?: string;
  taskId?: string;
  testTarget?: string;
  keepSandbox?: boolean;
  json?: boolean;
}

/**
 * A file on disk, verified against a plan.
 *
 * The `Candidate` it builds is in-memory and is never written anywhere: a file a human wrote has no
 * worker, no seed and no token counts, and a record saying otherwise would be a lie in the one place
 * this project cannot afford one. The verifiers read `task_id` and `test_source` and nothing else.
 */
export async function verifyCommand(opts: VerifyOpts): Promise<Verdict> {
  const loaded = await loadPlan(opts.planPath);
  const source = await readFile(opts.testFile, "utf8");
  const id = opts.taskId ?? `${opts.functionName ?? basename(opts.testFile).split(".")[0]}:manual:0`;
  const candidate = Candidate.parse({
    task_id: id,
    worker: { kind: "local", model: `file:${basename(opts.testFile)}`, revision: "", temperature: 0, seed: 0 },
    test_source: source,
    usage: { prompt_tokens: 0, completion_tokens: 0 },
    timing: { ttft_ms: 0, wall_ms: 0 },
  });

  const verdict = await verifyCandidate(loaded, candidate, opts.functionName ?? functionOfTaskId(id), {
    testTarget: opts.testTarget,
    keepSandbox: opts.keepSandbox,
  });

  if (opts.json) json(verdict);
  else out(renderVerdict(verdict));
  return verdict;
}

export const renderVerdict = (v: Verdict): string => {
  const lines = [
    `${v.survived ? "SURVIVED" : "failed  "} ${v.task_id} · reached ${v.stage_reached}`,
    `  compile ${v.compile_ok ? "ok" : "no"} · pass ${v.pass_ok ? "ok" : "no"} · tautological ${v.tautological ? "yes" : "no"}`,
  ];
  if (v.mutation) {
    const m = v.mutation;
    lines.push(`  mutants: ${m.killed} killed · ${m.survived} survived · ${m.timeout} timed out · ${m.no_coverage} never reached · score ${m.score.toFixed(2)}`);
  }
  const ms = Object.entries(v.timing_ms).map(([k, n]) => `${k} ${Math.round(n as number)} ms`);
  if (ms.length) lines.push(`  ${ms.join(" · ")}`);
  if (v.error) lines.push(v.error.split("\n").map((l) => `  ${l}`).join("\n"));
  return lines.join("\n");
};

export interface PlanOpts {
  planPath: string;
  /** Skip verifying the exemplars — the structural half only. */
  quick?: boolean;
  testTarget?: string;
  concurrency?: number;
  json?: boolean;
}

/**
 * A plan, checked before anything spends a token on it.
 *
 * There is no CLI that *writes* a plan and there is not meant to be: writing one means reading a
 * module and deciding what is worth asking about it, which is the one part of this pipeline that is
 * Opus's (`claude/agents/test-planner.md`). This is the other half of that loop — the planner writes,
 * this says whether what it wrote holds up, and the exit code is what the loop reads.
 */
export async function planCommand(opts: PlanOpts): Promise<ValidationReport> {
  const report = await validatePlan(opts.planPath, {
    verifyExemplars: !opts.quick,
    testTarget: opts.testTarget,
    concurrency: opts.concurrency,
    // Verifying an exemplar is seconds on TypeScript and tens of seconds on Swift, so a plan with six
    // shapes is a minute of silence without this. stderr, for the same reason `run` uses it.
    onEvent: opts.json ? undefined : (line) => process.stderr.write(`${line}\n`),
  });
  if (opts.json) json(report);
  else out(renderReport(report));
  return report;
}

export interface RunOpts {
  planPath: string;
  concurrency?: number;
  dryRun?: boolean;
  testTarget?: string;
  json?: boolean;
}

export async function runCommand(opts: RunOpts): Promise<void> {
  const result = await runBatch(opts.planPath, {
    concurrency: opts.concurrency,
    dryRun: opts.dryRun,
    testTarget: opts.testTarget,
    // Progress on stderr: `--json` on stdout has to stay machine-readable, and a run is minutes long.
    onEvent: (line) => process.stderr.write(`${line}\n`),
  });

  if (opts.json) {
    json(result);
    return;
  }
  const s = result.stats;
  out([
    `run ${result.run_id}`,
    `  ${s.survived}/${s.tasks} survived · ${s.retried} retried · ${s.escalated} escalated`,
    `  funnel: compiled ${s.funnel.compiled} → passed ${s.funnel.passed} → killed ≥1 ${s.funnel.killed_ge_1} → non-tautological ${s.funnel.non_tautological}`,
    `  latency: ${Math.round(s.latency_ms.median)} ms median · ${Math.round(s.latency_ms.p90)} ms p90 · worker RSS ${s.peak_rss_mb} MB resident`,
    `  claude tokens: planning ${s.claude_tokens.planning} · workers ${s.claude_tokens.workers} · review ${s.claude_tokens.review ?? "not reviewed"}`,
    ...result.survivors.map((v) => `  survived  ${v.task_id}  score ${v.mutation_score.toFixed(2)}  ${v.test_path}`),
    ...result.escalations.map((e) => `  escalated ${e.task_id}  ${e.attempts.length} attempt${e.attempts.length === 1 ? "" : "s"}`),
  ].join("\n"));
}

// ── workload #2a (Phase 10) ───────────────────────────────────────────────────────────────────────

export interface FixCommandOpts {
  planPath: string;
  concurrency?: number;
  dryRun?: boolean;
  keepSandbox?: boolean;
  json?: boolean;
  /** Continue the run with this id instead of starting one (unattended mode, `BACKLOG.md` item 4). */
  resume?: string;
  /** Memoise task → candidate (ADR-0065). Off by default; experiments must leave it off. */
  cache?: boolean;
}

/**
 * `sidecrew fix` — a whole `ChangePlan`, gated by the project's own suite plus `tsc`.
 *
 * The prose form leads with the two numbers that say whether the job moved: how many tasks survived,
 * and what happened to the project's error count. A survival rate on its own would be the workload-#1
 * habit applied to a workload whose point is convergence — "4/10 survived" says nothing about whether
 * the codebase compiles now.
 */
/**
 * `sidecrew fix --validate` — the same check `sidecrew_fix_plan_validate` runs.
 *
 * Kept beside `fixCommand` rather than folded into it: validation refuses tasks and a run spends
 * tokens, and a flag that silently turned one into the other is how a planner ends up believing a plan
 * was checked when it was only loaded.
 */
export async function fixValidateCommand(opts: {
  planPath: string; compile?: boolean; json?: boolean;
}): Promise<ChangeValidationReport> {
  const report = await validateChangePlan(opts.planPath, {
    compile: opts.compile,
    onEvent: (line) => process.stderr.write(`${line}\n`),
  });
  if (opts.json) json(report);
  else out(renderChangeReport(report));
  return report;
}

/**
 * `sidecrew fix --report [RUN_ID]` — what to read first, after a run nobody watched.
 *
 * The other half of unattended mode. It reads a finished run off disk and spends nothing: no worker, no
 * gate, no tokens. Its whole value is the **ordering**, which is the judgement `FixResult` does not
 * carry (`src/report.ts`).
 */
export async function fixReportCommand(opts: { runId?: string; dir?: string; json?: boolean }): Promise<RunReport> {
  const report = await runReport(opts.runId, { dir: opts.dir });
  if (opts.json) json(report);
  else out(renderRunReport(report));
  return report;
}

/**
 * `sidecrew fix --sweep` — remove sandboxes an interrupted run left behind.
 *
 * Explicit, never automatic, and never recent: two runs share a machine routinely and a live step
 * sandbox is written only at step boundaries, so recency cannot tell "in use" from "idle"
 * (`findOrphanSandboxes`). Phase 11b lost about 4.5 GB to nine of these in one afternoon.
 */
export async function fixSweepCommand(opts: { olderThanHours?: number; dryRun?: boolean; json?: boolean }): Promise<Orphan[]> {
  const hours = opts.olderThanHours ?? 12;
  const found = await findOrphanSandboxes(hours);
  const gb = (b: number): string => `${(b / 1_073_741_824).toFixed(2)} GB`;
  const total = found.reduce((n, o) => n + o.bytes, 0);

  if (found.length === 0) {
    if (opts.json) json([]);
    else out(`no sandboxes older than ${hours}h — nothing to sweep`);
    return [];
  }
  if (opts.dryRun) {
    if (opts.json) json(found);
    else {
      out(`${found.length} orphaned sandbox(es), ${gb(total)}, older than ${hours}h — none removed (--dry-run):`);
      for (const o of found) out(`  ${gb(o.bytes).padStart(9)}  ${Math.round(o.ageHours)}h  ${o.path}`);
    }
    return found;
  }

  const removed = await sweepOrphanSandboxes(found);
  if (opts.json) json(removed);
  else out(`removed ${removed.length} orphaned sandbox(es), ${gb(removed.reduce((n, o) => n + o.bytes, 0))}`);
  return removed;
}

export async function fixCommand(opts: FixCommandOpts): Promise<FixResult> {
  const result = await runFix(opts.planPath, {
    concurrency: opts.concurrency,
    dryRun: opts.dryRun,
    keepSandbox: opts.keepSandbox,
    resume: opts.resume,
    cache: opts.cache,
    onEvent: (line) => process.stderr.write(`${line}\n`),
  });

  if (opts.json) {
    json(result);
    return result;
  }
  if (opts.dryRun) {
    // Every number below would be zero or the baseline's, and "3 → 3 tsc errors with every survivor
    // applied" on a run that produced no survivors is a sentence that reads as a finding.
    out(`fix ${result.run_id} (--dry-run): baseline ${result.project.errors_before} tsc errors · ` +
      `${result.project.tests_passed}/${result.project.tests_ran} tests passing · nothing was generated`);
    return result;
  }
  const s = result.stats;
  const f = s.funnel;
  const breaks = Object.entries(s.confinement_breaks).sort((a, b) => b[1] - a[1]);
  out([
    `fix ${result.run_id}`,
    `  ${s.survived}/${s.tasks} survived · ${s.retried} retried · ${s.escalated} escalated`,
    `  project: ${result.project.errors_before} → ${result.project.errors_after} tsc errors · ` +
      `${result.project.tests_passed}/${result.project.tests_ran} tests passing with every survivor applied`,
    `  funnel: answered ${f.answered} → edits parsed ${f.edits_parsed} → confined ${f.confined} → ` +
      `applied ${f.applied} → compiled ${f.compiled} → suite green ${f.suite_green}`,
    ...(s.edit_parse_failed + s.edit_truncated > 0
      ? [`  edit format: ${s.edit_parse_failed} unreadable · ${s.edit_truncated} truncated ` +
         "(a quarter of attempts here means the number is about the format, not the model — ADR-0047 §2)"]
      : []),
    ...(breaks.length > 0 ? [`  confinement: ${breaks.map(([rule, n]) => `${rule} ×${n}`).join(" · ")}`] : []),
    `  latency: ${Math.round(s.latency_ms.median)} ms median · generate ${Math.round(s.generate_ms.median)} ms · gate ${Math.round(s.gate_ms.median)} ms`,
    `  claude tokens: planning ${s.claude_tokens.planning} · workers ${s.claude_tokens.workers} · review ${s.claude_tokens.review ?? "not reviewed"}`,
    ...result.steps.map((st) => `  step "${st.name}": ${st.survived}/${st.tasks} · ${st.errors_before} → ${st.errors_after} errors`),
    ...result.survivors.map((v) => `  survived  ${v.task_id}  ${v.files.join(", ")}  ${v.diff_path}`),
    ...result.escalations.map((e) => `  escalated ${e.task_id}  ${e.attempts.length} attempt${e.attempts.length === 1 ? "" : "s"}`),
    ...(result.project.combined_regressions > 0
      ? [`  WARNING: ${result.project.combined_regressions} test(s) pass individually and fail with every ` +
         "survivor applied — a hole in the gate, not a bad change"]
      : []),
  ].join("\n"));
  return result;
}

// ── the two queues Claude reads (Phase 7) ─────────────────────────────────────────────────────────

export interface EscalateCommandOpts {
  runId?: string;
  dir?: string;
  model?: string;
  json?: boolean;
}

/**
 * `sidecrew escalate` — the queue, assembled, printed, and not sent anywhere.
 *
 * It does not call Claude, and that is the design rather than a gap. sidecrew has no Anthropic client
 * (ADR-0001: it is the local tier, and the one thing it must never grow is a way to spend tokens by
 * accident), so what it can honestly do is build the batch. `/sidecrew escalate` in the skill is what
 * hands it to Sonnet; `--json` is what that reads.
 */
export async function escalateCommand(opts: EscalateCommandOpts): Promise<EscalationBatch> {
  const batch = await escalationBatch(opts.runId, { dir: opts.dir, model: opts.model });
  if (opts.json) json(batch);
  else out(renderEscalationBatch(batch));
  return batch;
}

export interface ReviewCommandOpts {
  runId?: string;
  dir?: string;
  threshold?: number;
  auditFraction?: number;
  maxBatchTokens?: number;
  json?: boolean;
}

/**
 * `sidecrew review` — which survivors Claude reads, and in what batches.
 *
 * Same shape as `escalate`: it assembles, it does not send. The language comes off the run's own tasks
 * because the threshold is per language (ADR-0024) and the plan may have moved since the run.
 */
export async function reviewCommand(opts: ReviewCommandOpts): Promise<ReviewQueue> {
  const queue = await reviewQueueFor(opts);
  if (opts.json) json(queue);
  else out(renderReviewQueue(queue));
  return queue;
}

/**
 * The same thing without the printing, for the MCP server — whose stdout *is* the transport, so a
 * command that writes a report to it does not produce a chatty tool, it produces a broken one.
 */
export async function reviewQueueFor(opts: ReviewCommandOpts): Promise<ReviewQueue> {
  const { path } = await resolveRunDir(opts.runId, opts.dir);
  const resultPath = join(path, "result.json");
  let result: BatchResult;
  try {
    result = BatchResult.parse(JSON.parse(await readFile(resultPath, "utf8")));
  } catch (e) {
    throw new Error(`${resultPath} is not a BatchResult — has that run finished? (${String((e as Error).message)})`);
  }
  const language = await runLanguage(path);
  if (language === null) throw new Error(`${path} has no readable tasks, so the review threshold has no language to be per (ADR-0024)`);

  return buildReviewQueue(result, language, {
    threshold: opts.threshold,
    auditFraction: opts.auditFraction,
    maxBatchTokens: opts.maxBatchTokens,
  });
}
