// `sidecrew fix` — workload #2a, a whole ChangePlan, generated locally and gated by the project's own
// suite plus `tsc`.
//
// The loop is workload #1's with the gate swapped and one thing added: **steps are ordered** (ADR-0044
// §2). Tasks inside a step are independent and run in parallel; at a step boundary the run applies that
// step's survivors to the sandbox and re-captures the baseline, because step N+1's baseline is the
// project after step N landed. It does not wait for Opus between steps — a decision per step is where
// supervision is cheap and a *wait* per step is where a long job dies overnight.
//
// What is deliberately not here, and why:
//
//   * **no planner.** A `ChangePlan` is written by hand in this phase; the agent that writes one is
//     Phase 12 (ADR-0044 §1–2). Hand-written plans are how the contract gets exercised.
//   * **no correction round.** One mechanical retry carrying the gate's own words (ADR-0022) and then
//     the task escalates. `ChangeTask.correction` and `attempt: 2` exist and nothing fills them; that
//     is Phase 12's, and it is budgeted and measured there rather than built here on a guess.
//   * **no escalation queue and no MCP tool.** `sidecrew escalate` joins a queue back to `WorkerTask`s,
//     which a `ChangeTask` is not, and nothing writes change plans for Claude to hand to a tool yet.
//     Every verdict is on disk as it is produced, so a run that dies still has the record (ADR-0023).
//     `BACKLOG.md` has both against Phase 12.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { RESULTS_DIR } from "./bench.js";
import {
  captureBaseline, assertChangeToolchain, makeChangeSandbox, runSuite, toPosix, typecheck, verifyChange,
  DEFAULT_CHANGE_TIMEOUTS, type CapturedBaseline, type ChangeTimeouts,
} from "./change.js";
import { billedWorkerTokens, discoverWorkers, portsFromEnv, PoolRss, runId, RUN_SEED, type WorkerEndpoint } from "./batch.js";
import { planApiConcurrency, planConcurrency } from "./concurrency.js";
import { baseUrlFor, readMemory, type Memory } from "./doctor.js";
import { diffOf } from "./diff.js";
import { apiModel, defaultKey, entry, modelForMachine, tierFor, type ModelEntry } from "./models.js";
import { assertMeasuredUsage, completeApi, resolveApiTier, type ApiTierContext } from "./api-worker.js";
import { changePromptText, buildChangePrompt, estimateTokens } from "./prompt.js";
import { brief, renderBrief, shouldCorrect, type CorrectionBrief } from "./correction.js";
import { CandidateCache, candidateKey } from "./cache.js";
import { appendChangeEscalation } from "./escalate.js";
import { PlanError } from "./plan.js";
import {
  ChangeCandidate, ChangePlan, ChangeTask, ChangeVerdict, crossesCalendarDay, FixResult,
  type ChangeBaseline, type FileEdit, type PlannedChange,
} from "./schemas.js";
import { sidecrewDir } from "./serve.js";
import { benchBaseline, ThermalGuard } from "./throttle.js";
import { complete, decodeTokensPerSecond } from "./worker.js";
import { isTestRunner, safeName, truncateError, VerifierSetupError, type TestRunner } from "./verifier/shared.js";

/**
 * Whole files cost completion tokens in proportion to the files, so the ceiling is derived from the
 * task rather than fixed (ADR-0047 §2). A truncated answer is a wasted verdict, and the slack is the
 * cheapest insurance there is; the cap is what keeps one large task from holding a worker for an hour.
 */
export const MAX_FIX_TOKENS = 8192;
export const MIN_FIX_TOKENS = 1024;

export const fixTokenBudget = (task: ChangeTask): number => {
  const needed = Math.ceil(task.files.reduce((n, f) => n + estimateTokens(f.source), 0) * 1.4) + 256;
  return Math.max(MIN_FIX_TOKENS, Math.min(MAX_FIX_TOKENS, needed));
};

/** Rewriting several files is minutes of decoding, not seconds. A worker may be slow; it may not hang. */
export const FIX_GENERATE_TIMEOUT_MS = 600_000;

// ── reading the worker's answer ───────────────────────────────────────────────────────────────────

const FILE_MARKER = /^-{2,}\s*FILE:\s*(.+?)\s*-{2,}\s*$/;
/** ADR-0044's "the other direction": a worker that cannot do the task says so instead of guessing. */
const CANNOT_MARKER = /^-{2,}\s*CANNOT:\s*(.+?)\s*-{2,}\s*$/;
const FENCE_OPEN = /^```[\w-]*\s*$/;
const FENCE_CLOSE = /^```\s*$/;
const END_OF_TURN = /(?:<\|im_end\|>|<\|endoftext\|>|<\|eot_id\|>|<\/s>)\s*$/;

/** `./src/a.ts`, `src\a.ts` and `src/a.ts` are the same file; the contract spells it the third way. */
const normalisePath = (path: string): string => toPosix(path.trim()).replace(/^\.\//, "").replace(/^\/+/, "");

/** A section wrapped in a fence the prompt asked it not to use. Strip it; a 7B says it anyway. */
const unfence = (lines: string[]): string[] => {
  const body = [...lines];
  while (body.length > 0 && body[0]!.trim() === "") body.shift();
  while (body.length > 0 && body.at(-1)!.trim() === "") body.pop();
  if (body.length >= 2 && FENCE_OPEN.test(body[0]!) && FENCE_CLOSE.test(body.at(-1)!)) return body.slice(1, -1);
  return body;
};

export interface ParsedEdits {
  edits: FileEdit[];
  /** What could not be read as a file. null when the whole answer was readable. */
  unparsed: string | null;
}

/**
 * Turn one completion into edits.
 *
 * Two forms are accepted and the second is the concession: markers, which is what the prompt asks for,
 * and — **only when the task has exactly one file** — a bare answer, because a model handed one file and
 * asked for one file back very often simply returns it. Accepting that costs nothing (the gate still
 * decides) and refusing it would spend a verdict on a formatting convention.
 *
 * A marker naming a file the task does not list is **kept**, not dropped. It is exactly the
 * `path_outside_task` case the gate exists to catch, and a parser that quietly discarded it would hide
 * the Goodhart signal Phase 11 is counting (ADR-0048).
 *
 * Text before the first marker is ignored: a file's contents can only follow a marker, so anything
 * before one is prose by construction.
 */
/**
 * The worker's refusal, if it gave one — `--- CANNOT: reason ---` and nothing else.
 *
 * Read from the raw completion rather than from `parseEdits`, because a refusal is the *absence* of
 * edits: there is no file to attach it to, and threading a second return value through the parser would
 * make every caller handle a case that only exists here.
 *
 * Deliberately strict about what it accepts. A 7B asked for a marker form produces it, and anything
 * looser — "I cannot", "Sorry, but" — would turn a model's ordinary hedging prose into a refusal and
 * quietly remove tasks from the denominator. A worker has to use the form to be heard.
 */
export function parseRefusal(text: string): string | null {
  for (const line of text.replace(END_OF_TURN, "").split("\n")) {
    const m = CANNOT_MARKER.exec(line.trim());
    if (m) return truncateError(m[1]!);
  }
  return null;
}

export function parseEdits(text: string, task: ChangeTask): ParsedEdits {
  const clean = text.replace(END_OF_TURN, "").trimEnd();
  const lines = clean.split("\n");
  const edits: FileEdit[] = [];
  let path: string | null = null;
  let body: string[] = [];

  const flush = (): void => {
    if (path === null) return;
    edits.push({ path, contents: `${unfence(body).join("\n")}\n` });
    path = null;
    body = [];
  };

  for (const line of lines) {
    const marker = FILE_MARKER.exec(line);
    if (marker) {
      flush();
      path = normalisePath(marker[1]!);
      continue;
    }
    if (path !== null) body.push(line);
  }
  flush();

  if (edits.length > 0) return { edits, unparsed: null };

  // A refusal is not a bare answer, and the fallback below would claim it as one.
  //
  // This is the interaction that made the refusal shape **inert on exactly the tasks everything has
  // been measured on**. `parseEdits` accepts a bare answer for a single-file task, on the reasoning
  // that a model handed one file and asked for one file back very often just returns it. A refusal has
  // no `--- FILE:` marker either, so on a one-file task it fell through to that fallback, `edits.length`
  // was 1, and `generateChange` never consulted `parseRefusal` — the refusal became a candidate that
  // replaced the file with the text `--- CANNOT: … ---`, failed `tsc`, and was counted as a worker
  // failure. Phase 11 measured only single-file tasks (ADR-0058) and Phase 11b reuses those plans, so
  // `refusals` would have been a constant zero rather than an observation.
  if (parseRefusal(clean) !== null) return { edits: [], unparsed: null };

  const only = task.files.length === 1 ? task.files[0] : undefined;
  const bare = unfence(lines).join("\n").trim();
  if (only !== undefined && bare !== "") return { edits: [{ path: only.path, contents: `${bare}\n` }], unparsed: null };

  return {
    edits: [],
    unparsed: truncateError(
      `the answer contained no \`--- FILE: path ---\` marker and the task has ${task.files.length} files, ` +
      `so there is no way to tell which file it is about:\n${clean}`,
    ),
  };
}

/** One task → one candidate, from the worker on this machine. Zero Claude tokens (non-negotiable #1). */
export async function generateChange(task: ChangeTask, worker: WorkerEndpoint): Promise<ChangeCandidate> {
  const messages = await buildChangePrompt(task);
  const completion = await complete({
    baseUrl: worker.baseUrl,
    model: worker.modelArg,
    messages,
    seed: RUN_SEED,
    maxTokens: fixTokenBudget(task),
    timeoutMs: FIX_GENERATE_TIMEOUT_MS,
  });

  // The same refusals `generate` makes, and for the same reason: an estimate recorded as a measurement
  // would put a fiction into the go/no-go numbers (ADR-0019).
  if (completion.usage_estimated) {
    throw new Error(
      `${worker.baseUrl} sent no usage block, so this candidate's token counts would be a guess. ` +
      "sidecrew records measurements, not estimates — is this an mlx_lm.server?",
    );
  }
  if (completion.text.length > 0 && completion.usage.completion_tokens === 0) {
    throw new Error(
      `${worker.baseUrl} reported 0 completion tokens for ${completion.text.length} characters of output, ` +
      "so this candidate's token counts are a fiction rather than a measurement.",
    );
  }

  const { edits, unparsed } = parseEdits(completion.text, task);
  // A refusal only counts when the worker returned *nothing else*. A model that emits both a refusal and
  // a file has not refused; it has hedged, and taking the refusal at face value there would discard a
  // candidate the gate could have judged for free.
  const refusal = edits.length === 0 ? parseRefusal(completion.text) : null;
  return ChangeCandidate.parse({
    task_id: task.task_id,
    worker: { kind: "local", model: worker.model, revision: worker.revision, temperature: 0, seed: RUN_SEED },
    edits,
    unparsed: refusal === null ? unparsed : null,
    refusal,
    // `length` is the server saying it stopped because it ran out, which is the one truncation signal
    // that is a fact rather than an inference.
    truncated: completion.finish_reason === "length",
    usage: { prompt_tokens: completion.usage.prompt_tokens, completion_tokens: completion.usage.completion_tokens },
    timing: { ttft_ms: completion.ttft_ms, wall_ms: completion.wall_ms },
  });
}

/**
 * The same change task, the same prompt, the same gate — written by Claude over the API (ADR-0045).
 *
 * The mirror of `generateApi` for workload #2a, and separate from `generateChange` for the reason
 * ADR-0059 gives: the two tiers reach opposite guards, and one function with a flag would be one edit
 * away from reaching neither.
 *
 * Note what is **not** different: the prompt is `buildChangePrompt`, the refusal shape is the one
 * `parseEdits`/`parseRefusal` already read, and the candidate goes to the same gate. ADR-0045 §5 — the
 * api tier does the same small stuff, and only who wrote the candidate changes.
 */
export async function generateApiChange(task: ChangeTask, api: ApiTierContext): Promise<ChangeCandidate> {
  const messages = await buildChangePrompt(task);
  const completion = await completeApi({
    baseUrl: api.baseUrl,
    apiKey: api.apiKey,
    model: api.model,
    messages,
    maxTokens: fixTokenBudget(task),
    timeoutMs: FIX_GENERATE_TIMEOUT_MS,
    fetchImpl: api.fetchImpl,
  });
  assertMeasuredUsage(completion, completion.text.length);

  const { edits, unparsed } = parseEdits(completion.text, task);
  const refusal = edits.length === 0 ? parseRefusal(completion.text) : null;
  return ChangeCandidate.parse({
    task_id: task.task_id,
    // No seed: the API offers none, and writing one we never sent would make the record say something
    // untrue. `WorkerStamp` requires a seed only on `local` (ADR-0009).
    worker: { kind: "api", model: api.model, revision: "", temperature: 0, seed: null },
    edits,
    unparsed: refusal === null ? unparsed : null,
    refusal,
    truncated: completion.finish_reason === "length",
    usage: { prompt_tokens: completion.usage.prompt_tokens, completion_tokens: completion.usage.completion_tokens },
    timing: { ttft_ms: completion.ttft_ms, wall_ms: completion.wall_ms },
  });
}

// ── the plan ──────────────────────────────────────────────────────────────────────────────────────

export interface LoadedChangePlan {
  plan: ChangePlan;
  planPath: string;
  projectDir: string;
  runner: TestRunner;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Read a plan and refuse everything about it a machine can refuse before a token is spent.
 *
 * Two of these are ADR-0048's and they are not merely advisory: a plan that lists a test file or a build
 * config in a task's `files` does not load. Those two confinement rules must not be switchable from the
 * plan, because the thing that will be writing plans from Phase 12 onwards is a model.
 */
export async function loadChangePlan(planPath: string, tsconfig = "tsconfig.json"): Promise<LoadedChangePlan> {
  if (!existsSync(planPath)) throw new PlanError(`${planPath} is not on disk`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(planPath, "utf8")) as unknown;
  } catch (e) {
    throw new PlanError(`${planPath} is not JSON: ${String((e as Error).message)}`);
  }
  const parsed = ChangePlan.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new PlanError(
      `${planPath} is not a ChangePlan:\n${issues}\n` +
      "  (a plan carrying a `workers` field is one of the ways this fails — Opus decides how the work is " +
      "cut, the machine decides how many pieces are in flight: ADR-0044 §3)",
    );
  }
  const plan = parsed.data;

  if (plan.language !== "typescript") {
    throw new PlanError(`workload #2a is TypeScript only today; this plan says ${plan.language}`);
  }
  if (!isTestRunner(plan.test_framework)) {
    throw new PlanError(`sidecrew fix can drive vitest and jest; this plan says ${plan.test_framework}`);
  }

  const projectDir = resolve(plan.project);
  assertChangeToolchain(projectDir, tsconfig);

  const seen = new Set<string>();
  const problems: string[] = [];
  for (const step of plan.steps) {
    for (const task of step.tasks) {
      if (seen.has(task.task_id)) problems.push(`two tasks called ${task.task_id}`);
      seen.add(task.task_id);
      if (task.files.length > plan.max_group_size) {
        problems.push(`${task.task_id} lists ${task.files.length} files and max_group_size is ${plan.max_group_size}`);
      }
      for (const file of task.files) {
        if (!existsSync(join(projectDir, file))) problems.push(`${task.task_id} lists ${file}, which is not in ${plan.project}`);
      }
      // ADR-0048: checked here as well as in the gate, so the plan cannot switch the rule off.
      const forbidden = task.files.filter((f) =>
        /\.(test|spec)\.[cm]?[jt]sx?$/.test(basename(f))
          || f.split("/").some((p) => p === "__tests__" || p === "__mocks__" || p === "__snapshots__")
          || /^(tsconfig|jsconfig)([.-][\w.-]+)?\.json$/.test(basename(f))
          || /^(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.eslintrc.*|\.babelrc.*|\.swcrc)$/.test(basename(f))
          || /^[\w.-]+\.(config|conf)\.[\w.]+$/.test(basename(f)));
      for (const f of forbidden) {
        problems.push(
          `${task.task_id} lists ${f}, and a behaviour-preserving change may never edit a test file or a ` +
          "build config — those are the gate and its configuration (ADR-0046, ADR-0048)",
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new PlanError(`${planPath} does not describe something that can be run:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  }

  return { plan, planPath: resolve(planPath), projectDir, runner: plan.test_framework as TestRunner };
}

/** Every file any task in a step may touch — what the baseline checks `tsc` actually had. */
const filesOfStep = (step: ChangePlan["steps"][number]): string[] =>
  [...new Set(step.tasks.flatMap((t) => t.files.map(toPosix)))];

/**
 * One `ChangeTask`, with each file's current source and the compiler's own words about it.
 *
 * Read from the **sandbox**, not from the project: in step N+1 the file on disk in the project is still
 * the original, while the file the worker has to edit is the one step N's survivors produced. Reading
 * the wrong one would hand the worker a file it is not editing — the #2a form of the stale-plan mistake
 * ADR-0013 made expensive.
 */
export function buildChangeTask(
  loaded: LoadedChangePlan,
  planned: ChangePlan["steps"][number]["tasks"][number],
  sandbox: string,
  captured: CapturedBaseline,
  extra: { attempt?: number; retryOf?: string | null; previousError?: string | null; correction?: string | null } = {},
): ChangeTask {
  const baseline = captured.baseline;
  const attempt = extra.attempt ?? 0;
  const files = planned.files.map((path) => {
    const source = readFileSync(join(sandbox, path), "utf8");
    return { path: toPosix(path), source, source_sha: sha256(source), errors: baseline.errors.by_file[toPosix(path)] ?? 0 };
  });
  const wanted = new Set(files.map((f) => f.path));
  return {
    task_id: attempt === 0 ? planned.task_id : `${planned.task_id}#${attempt}`,
    language: loaded.plan.language,
    test_framework: loaded.plan.test_framework,
    ask: planned.ask,
    files,
    diagnostics: diagnosticsFor(captured.diagnostics, wanted),
    max_deleted_lines: planned.max_deleted_lines,
    notes: planned.notes ?? null,
    attempt,
    retry_of: extra.retryOf ?? null,
    previous_error: extra.previousError ?? null,
    // ADR-0044 §4, filled by Phase 12. The schema refuses a note on any attempt but 2, and refuses an
    // attempt 2 without one — so "the mechanical retry is tried first and is free" is checked rather
    // than remembered (rule 3).
    correction: extra.correction ?? null,
    shape: planned.shape,
  };
}

/**
 * The compiler's own words about this task's files, and nothing else's.
 *
 * Held on the baseline rather than re-derived, so the worker is shown the same diagnostics the verdict
 * will be scored against. A summary would have been cheaper and would have been ours rather than the
 * compiler's, and `previous_error` already proves that the tool's own sentence is the useful one
 * (ADR-0022).
 */
export const diagnosticsFor = (diagnostics: string, files: Set<string>): string => {
  const lines = diagnostics.split("\n").filter((line) => {
    const at = line.indexOf("(");
    return at > 0 && files.has(toPosix(line.slice(0, at)));
  });
  return truncateError(lines.join("\n"));
};

// ── the retry rule ────────────────────────────────────────────────────────────────────────────────

export interface RetryDecision { retry: boolean; reason: string }

/**
 * Does this failure deserve the one mechanical retry?
 *
 * One does not, and it is the same shape as workload #1's: a runner that produced no report is the
 * machine failing, not the change (ADR-0012). Everything else is retried once with the gate's own words
 * appended, ordered by what the retry can act on — a named confinement rule is the most actionable
 * sentence this gate can produce, so it comes first.
 */
export function shouldRetryChange(verdict: ChangeVerdict): RetryDecision {
  if (verdict.survived) return { retry: false, reason: "survived" };
  // A refusal is an escalation with a reason (ADR-0044), so it does not spend the retry — and it has to
  // be checked **first**. A refusal verdict is `confined` (it edited nothing) and not `compile_ok` (the
  // compiler never ran), so without this it falls through to the `compile_ok` branch and is retried
  // with the reason "tsc is not satisfied" — a stage that never happened. That is ADR-0037's shape
  // again: a verdict wearing another stage's clothes, and the retry would then spend a second
  // generation on a worker that has already said no.
  if (verdict.refused !== null) {
    return { retry: false, reason: `the worker refused this task: ${verdict.refused}` };
  }
  if (verdict.tests !== null && !verdict.tests.reported) {
    return { retry: false, reason: "the test runner produced no report — a machine problem, not the change's (ADR-0012)" };
  }
  if (!verdict.confined) {
    return { retry: true, reason: `the change was not confined: ${verdict.confinement.map((b) => b.rule).join(", ")}` };
  }
  if (!verdict.compile_ok) return { retry: true, reason: "tsc is not satisfied" };
  if (!verdict.tests_ok) return { retry: true, reason: "a test that passed before now fails" };
  return { retry: true, reason: "did not survive" };
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────────

export interface RunFixOpts {
  concurrency?: number;
  /** Capture the first step's baseline, write its tasks and prompts, and stop before the first token. */
  dryRun?: boolean;
  ports?: number[];
  dir?: string;
  benchDir?: string;
  tsconfig?: string;
  timeouts?: Partial<ChangeTimeouts>;
  sandboxRoot?: string;
  keepSandbox?: boolean;
  onEvent?: (line: string) => void;
  /**
   * Where a candidate comes from. Default: the local worker over `http://localhost/v1`.
   *
   * The go/no-go's C3 arm substitutes the Haiku agent here, so that **the only thing that differs
   * between configurations is which model wrote the candidate** — the steps, the baseline capture, the
   * gate, the retry rule and the step boundary are the production ones rather than a copy of them in a
   * script. Phase 6's harness makes the same point about `shouldRetry` and it is the reason its numbers
   * are comparable (`experiments/go-no-go/README.md`).
   */
  generate?: (task: ChangeTask, worker: WorkerEndpoint) => Promise<ChangeCandidate>;
  /**
   * Force a tier instead of reading it off installed RAM (ADR-0045 §4). `api` is the tier that may
   * spend Claude tokens.
   *
   * For tests, for the go/no-go harness, and for the §5 measurement, which has to run the `api` tier
   * on whatever machine is to hand. Not a user-facing opt-in: the hazard ADR-0009 closed — a 32 GB
   * machine quietly billing — stays closed because the *default* is installed RAM and nothing on this
   * path consults free RAM.
   */
  workerKind?: "local" | "api";
  workerModel?: string;
  /** The resolved api-tier context. Injected by tests; otherwise read from the environment. */
  api?: ApiTierContext;
  /**
   * Continue a run that stopped — a closed lid, a Ctrl-C after forty minutes, a machine that rebooted.
   *
   * Unattended mode is the product shape `VISION.md` describes: *Opus files a stepped plan, walks away,
   * and reads a step report.* A #2a run is hours long at 262 s of gate per candidate, so surviving being
   * left alone is a requirement rather than a nicety (`BACKLOG.md` § *The edge ideas*, item 4).
   *
   * The data was always there — ADR-0023 writes one file per task **as it is produced**, precisely so a
   * run that dies still has the record. What was missing is the join: this reads the verdicts already on
   * disk and does not spend a worker on a task that has one.
   *
   * **It preserves verdicts, including wrong ones — so a run discarded for environmental reasons must be
   * restarted, not resumed.** Measured on 18 Sep 2026 during Phase 11b: a byte-identical candidate
   * produced `tests_ok: false` with 155 named regressions on a machine that was swapping, and
   * `survived` on a rerun of the same bytes. A gate under memory pressure fails **closed**, and the
   * false negative is indistinguishable from a real defect — it names specific tests and reads exactly
   * like a regression `tsc` cannot see. Such a verdict is perfectly *terminal*, so resume would reuse
   * it without hesitating, and a run half-taken under load would carry an invisible seam.
   */
  resume?: string;
  /**
   * Memoise task → candidate (ADR-0065). **Off by default and it stays that way for experiments**: a
   * measurement of what the workers do cannot be served from a record of what they did last time, and a
   * cached run's `generate_ms` is not a measurement.
   */
  cache?: boolean;
  /** Where cached candidates live. Default `<dir>/cache/candidates`. */
  cacheDir?: string;
  /**
   * Claude tokens the workers spent — an **override**, for the subagent arm whose candidates do not
   * come from `completeApi`. Left unset, an api-tier run sums what the API billed. Must stay 0 on
   * `local`, and the schema refuses anything else.
   */
  workerTokens?: number;
  /**
   * Who writes a correction (ADR-0044 §4 option B). Absent means the round cannot run whatever the
   * plan's budget says, which is the honest default for a library: **this function does not call a
   * model.** Opus — the session driving the run — supplies the writer, so a `fix` run on the local tier
   * never spends Claude tokens from inside sidecrew, and what it does spend is reported rather than
   * estimated.
   *
   * It is handed a `CorrectionBrief` and nothing else. The candidate is not in the signature, which is
   * how ADR-0044 §4 rule 1 stops being a promise (`src/correction.ts`).
   */
  correct?: (brief: CorrectionBrief) => Promise<{ note: string; tokens: number }>;
}

interface Attempt { task: ChangeTask; candidate: ChangeCandidate; verdict: ChangeVerdict }

interface TaskOutcome {
  task_id: string;
  blocking: boolean;
  /** True when this came off disk rather than from a worker on this invocation. */
  resumed?: boolean;
  attempts: Attempt[];
  latency_ms: number;
  generate_ms: number;
  gate_ms: number;
  retried: boolean;
  reason: string | null;
  threw: string | null;
}

const survivedOutcome = (o: TaskOutcome): boolean => o.attempts.at(-1)?.verdict.survived === true;

/**
 * A task this run already answered, rebuilt from `.sidecrew/runs/<id>/` — the resume half of unattended
 * mode (`BACKLOG.md` § *The edge ideas*, item 4).
 *
 * Reads the verdicts ADR-0023 wrote as the run went, newest attempt last, and returns null when the
 * task has none. **A task is only "done" when its last attempt is terminal**: survived, or a failure the
 * retry rule declines to retry, or the second attempt, or a correction. A task caught mid-flight — one
 * attempt on disk that the retry rule *would* have retried — is deliberately **not** resumed, because
 * resuming it would silently spend its retry budget differently from a run that never stopped.
 *
 * The candidate is read too, because the step boundary needs its edits to land a survivor. A verdict
 * without its candidate is treated as unfinished for that reason rather than reported as a survivor
 * whose change cannot be applied.
 */
async function resumeOutcome(runDir: string, planned: PlannedChange): Promise<TaskOutcome | null> {
  const attempts: Attempt[] = [];
  for (const id of [planned.task_id, `${planned.task_id}#1`, `${planned.task_id}#2`]) {
    const name = safeName(id);
    const [task, candidate, verdict] = await Promise.all([
      readRunJson(join(runDir, "tasks", `${name}.json`), ChangeTask),
      readRunJson(join(runDir, "candidates", `${name}.json`), ChangeCandidate),
      readRunJson(join(runDir, "verdicts", `${name}.json`), ChangeVerdict),
    ]);
    if (task === null || candidate === null || verdict === null) break;
    attempts.push({ task, candidate, verdict });
  }
  if (attempts.length === 0) return null;

  const last = attempts.at(-1)!;
  const decision = shouldRetryChange(last.verdict);
  const terminal = last.verdict.survived || !decision.retry || last.task.attempt >= 1;
  if (!terminal) return null;

  return {
    task_id: planned.task_id,
    blocking: planned.blocking,
    attempts,
    // Timings belong to the run that produced them. A resumed task contributes none, so the spreads
    // below describe work this invocation actually did rather than an average across two machines.
    latency_ms: 0,
    generate_ms: 0,
    gate_ms: 0,
    retried: attempts.length > 1,
    reason: last.verdict.survived ? null : decision.reason,
    threw: null,
    resumed: true,
  };
}

/** One task's JSON, parsed against its schema, or null when it is absent or unreadable. */
async function readRunJson<T extends z.ZodTypeAny>(path: string, schema: T): Promise<z.infer<T> | null> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8"))) as z.infer<T>;
  } catch {
    // A half-written file is what a killed run leaves behind, and it is the case this exists for.
    return null;
  }
}

/**
 * Was this the machine's failure rather than the worker's? (ADR-0012, ADR-0056.)
 *
 * Phase 11 is why this exists: project-b's twelfth task was lost to `ENOTEMPTY` during sandbox teardown
 * and landed in `escalated`, where it is indistinguishable from *the worker could not do this*. The
 * report had to carry `11/12` and `11/11` side by side because nothing in the contract could say which
 * — so a reader had to make a judgement the run already knew the answer to.
 *
 * Two forms: the task threw rather than returning a verdict, or the runner produced no parseable report.
 * Neither spends the retry, and neither belongs in a survival rate's denominator.
 */
const isMachineFailure = (o: TaskOutcome): boolean =>
  o.threw !== null || o.attempts.some((a) => a.verdict.tests !== null && !a.verdict.tests.reported);

const isFatal = (e: unknown): boolean => e instanceof VerifierSetupError || e instanceof PlanError;

const quantile = (values: number[], q: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[at] ?? 0;
};

const spread = (values: number[]): { median: number; p90: number } => ({
  median: Math.round(quantile(values, 0.5)),
  p90: Math.round(quantile(values, 0.9)),
});

const modelOfRun = (workers: WorkerEndpoint[], mem: Memory | null): ModelEntry => {
  const key = workers.find((w) => w.record)?.record?.model_key;
  if (key !== undefined) {
    try {
      return entry(key);
    } catch { /* a worker started from a models.json we no longer have */ }
  }
  return modelForMachine(mem?.total_gb ?? 0) ?? entry(defaultKey());
};

const writeJson = async (path: string, value: unknown): Promise<void> =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");

export async function runFix(planPath: string, opts: RunFixOpts = {}): Promise<FixResult> {
  const say = opts.onEvent ?? (() => {});
  // ADR-0069 option A. Once per run rather than once per verdict, because the condition is not a
  // property of one candidate: the moment the clock crosses the boundary the baseline encodes, every
  // verdict taken afterwards inherits the same regression. The first one to notice is the one worth
  // interrupting for — and it warns rather than stops, which is the whole of the decision.
  let staleBaselineWarned = false;
  const tsconfig = opts.tsconfig ?? "tsconfig.json";
  const loaded = await loadChangePlan(planPath, tsconfig);
  const { plan, projectDir, runner } = loaded;
  // ADR-0063, read once. Every `tsc` in this run — the baseline, each verdict, and the combined check
  // at the end — must use the same flags, because `compile_ok` compares an error count before against
  // one after and two compiler configurations do not produce comparable counts. A local binding rather
  // than four reads of `plan.compiler_flags` so a call site cannot quietly be the one that differs.
  const compilerFlags = plan.compiler_flags;


  const dir = opts.dir ?? sidecrewDir();
  // A resumed run keeps its id, so `.sidecrew/runs/<id>/` stays one run rather than becoming two halves
  // nobody can join. Every writer below is already idempotent per task id.
  const id = opts.resume ?? runId(plan.project);
  const runDir = join(dir, "runs", id);
  if (opts.resume !== undefined && !existsSync(runDir)) {
    throw new PlanError(`no run ${opts.resume} under ${join(dir, "runs")} — nothing to resume`);
  }
  for (const sub of ["tasks", "candidates", "verdicts", "diffs", "baselines", "corrections"]) {
    await mkdir(join(runDir, sub), { recursive: true });
  }

  const mem = await readMemory();

  // Installed RAM, never free RAM (ADR-0045 §4) — see `runBatch` for why that distinction is the
  // safety property rather than a detail. An injected `generate` keeps whatever kind it declares,
  // because the go/no-go harness owns that arm.
  const tier = opts.workerKind ?? (opts.generate !== undefined ? "local" : tierFor(mem?.total_gb ?? 0).tier);
  const api = tier === "api" && opts.generate === undefined && !opts.dryRun
    ? (opts.api ?? resolveApiTier(apiModel().model))
    : null;

  const workers = opts.dryRun || opts.generate !== undefined || tier === "api"
    ? ([] as WorkerEndpoint[])
    : await discoverWorkers(opts.ports ?? portsFromEnv());

  const model = modelOfRun(workers, mem);
  const concurrency = tier === "api"
    ? planApiConcurrency({ mem, requested: opts.concurrency })
    : planConcurrency({ model, mem, workersUp: Math.max(workers.length, 1), requested: opts.concurrency });
  const allTasks = plan.steps.reduce((n, s) => n + s.tasks.length, 0);
  say(`fix ${id}: ${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"}, ${allTasks} task${allTasks === 1 ? "" : "s"}, ${concurrency.reason}`);
  if (api !== null) {
    say(
      `api tier · ${api.model} — ${tierFor(mem?.total_gb ?? 0).why}. ` +
      "Worker inference is billed to this machine's Anthropic key; the zero-worker-tokens guarantee is a local-tier guarantee (ADR-0045).",
    );
  }

  if (!opts.dryRun && opts.generate === undefined && tier === "local" && workers.length === 0) {
    throw new Error(
      `no worker is answering on ${(opts.ports ?? portsFromEnv()).map(baseUrlFor).join(", ")} — start one with: sidecrew serve`,
    );
  }

  // The injected generator has no process to sample and no port to talk to; it still needs a slot for
  // the queue loop below to hand it tasks. One slot, because the agent arm is driven one task at a time.
  //
  // The api tier gets the same treatment for the same reason, one slot per in-flight candidate. Its
  // slots carry no base URL: dispatch is on `api`, and a slot that looked like a local endpoint would
  // be one typo from a request reaching the wrong guard (ADR-0059).
  const slots: WorkerEndpoint[] = opts.generate !== undefined
    ? [{ port: 0, baseUrl: "", record: null, modelArg: "", model: opts.workerModel ?? "agent", revision: "" }]
    : api !== null
      ? Array.from({ length: concurrency.workers }, () => ({ port: 0, baseUrl: "", record: null, modelArg: api.model, model: api.model, revision: "" }))
      : workers;
  const sampler = new PoolRss(workers.slice(0, concurrency.workers).flatMap((w) => (w.record ? [w.record.pid] : [])));
  // No thermal guard on the api tier: decode happens off this machine, so `decode_tok_s` would be a
  // measurement of somebody else's hardware and a back-off would be sidecrew throttling itself in
  // response to it (ADR-0025's baseline is a local-tier baseline).
  const baselineTok = tier === "api" ? null : await benchBaseline(model.key, opts.benchDir ?? RESULTS_DIR);
  const thermal = new ThermalGuard({ baseline: baselineTok?.tok_s ?? null, concurrency: concurrency.workers });

  /**
   * Who writes a candidate this run, resolved once.
   *
   * Three sources and one call site each side of it, so the correction round cannot end up asking a
   * different writer than the first attempt did — which would make `corrections.survived` a number
   * about two models.
   */
  const generateBase: (task: ChangeTask, worker: WorkerEndpoint) => Promise<ChangeCandidate> =
    opts.generate ?? (api !== null ? ((task) => generateApiChange(task, api)) : generateChange);

  // ADR-0065. The cache sits **here**, around the generator, rather than inside it: the decision to
  // serve a recorded answer instead of asking a worker is a property of the run, and burying it in
  // `generateChange` would hide it from the one reader who has to know — whoever quotes `generate_ms`.
  //
  // Local tier only, and that is a correctness condition rather than a policy: the `api` tier has no
  // seed (ADR-0045 §5), so its output is not reproducible and a "hit" would be a coincidence.
  const cacheOn = opts.cache === true && tier === "local" && opts.generate === undefined;
  const cache = cacheOn ? new CandidateCache({ dir: opts.cacheDir ?? join(dir, "cache", "candidates") }) : null;
  if (opts.cache === true && !cacheOn) {
    say("cache requested but not used: it is local-tier only, and an injected generator owns its own answers (ADR-0065)");
  }

  const generateOne = async (task: ChangeTask, worker: WorkerEndpoint): Promise<ChangeCandidate> => {
    if (cache === null) return generateBase(task, worker);
    const key = candidateKey({
      prompt: await changePromptText(task),
      model: worker.model,
      revision: worker.revision,
      seed: RUN_SEED,
      temperature: 0,
      maxTokens: fixTokenBudget(task),
    });
    const hit = await cache.read(key, task);
    if (hit !== null) {
      say(`${task.task_id}: candidate served from cache — its generate time is not a measurement (ADR-0065)`);
      return hit;
    }
    const fresh = await generateBase(task, worker);
    await cache.write(key, fresh);
    return fresh;
  };

  const sandbox = await makeChangeSandbox(projectDir, opts.sandboxRoot);
  const outcomes: TaskOutcome[] = [];
  const stepRows: FixResult["steps"] = [];
  const survivors: FixResult["survivors"] = [];
  let first: ChangeBaseline | null = null;
  let after: { errors: number; tests_ran: number; tests_passed: number } | null = null;
  let combined: string[] = [];
  let stopped: string | null = null;
  // Run-level, not step-level: ADR-0044 §4 says "a per-run budget", and a budget that reset every step
  // would let a ten-step plan spend ten times what the plan asked for.
  const spent = { written: 0, survived: 0, on_observations: 0, tokens: 0 };
  let budgetExhausted: string | null = null;

  try {
    for (const [index, step] of plan.steps.entries()) {
      // The baseline is captured once per step, in the sandbox the change will happen in (ADR-0046),
      // and re-captured here because step N+1's baseline is the project after step N landed.
      say(`step ${index + 1}/${plan.steps.length} "${step.name}": capturing the baseline`);
      const captured = await captureBaseline(sandbox, {
        projectDir, runner, tsconfig, timeouts: opts.timeouts, files: filesOfStep(step), compilerFlags,
      });
      const baseline = captured.baseline;
      await writeJson(join(runDir, "baselines", `${index}.json`), baseline);
      first ??= baseline;
      after ??= { errors: baseline.errors.total, tests_ran: baseline.tests.ran, tests_passed: baseline.tests.passed };
      say(
        `  baseline: ${baseline.errors.total} tsc error${baseline.errors.total === 1 ? "" : "s"}, ` +
        `${baseline.tests.passed}/${baseline.tests.ran} tests passing ` +
        `(${Math.round(baseline.timing_ms.compile)} ms tsc, ${Math.round(baseline.timing_ms.tests)} ms suite)`,
      );

      if (opts.dryRun) {
        await mkdir(join(runDir, "prompts"), { recursive: true });
        let promptTokens = 0;
        for (const planned of step.tasks) {
          const task = buildChangeTask(loaded, planned, sandbox, captured);
          await writeJson(join(runDir, "tasks", `${safeName(task.task_id)}.json`), task);
          const text = await changePromptText(task);
          promptTokens += estimateTokens(text);
          await writeFile(join(runDir, "prompts", `${safeName(task.task_id)}.md`), text, "utf8");
        }
        say(
          `--dry-run: captured the first step's baseline, wrote ${step.tasks.length} task(s) and prompt(s) ` +
          `(~${promptTokens} estimated prompt tokens) to ${runDir}, and stopped before the first token. ` +
          "The baseline is not skipped on purpose: a tsconfig that does not cover the plan's files, or a " +
          "suite that collects nothing, is how this workload fails before the model is ever involved.",
        );
        break;
      }

      // Resume: anything this run already answered comes off disk and is not generated again. The
      // baseline above is still re-captured rather than read back, and that is deliberate — the sandbox
      // is rebuilt from scratch on a resume, so re-deriving the baseline from it is what makes the
      // reused verdicts and the new ones comparable. It costs one `tsc` and one suite per step; correct
      // is worth more than fast on a path whose whole purpose is surviving an interruption.
      const stepOutcomes: TaskOutcome[] = [];
      const pendingTasks: typeof step.tasks = [];
      for (const planned of step.tasks) {
        const done = opts.resume === undefined ? null : await resumeOutcome(runDir, planned);
        if (done === null) pendingTasks.push(planned);
        else stepOutcomes.push(done);
      }
      if (opts.resume !== undefined) {
        const reused = stepOutcomes.length;
        say(reused === 0
          ? `  resuming: nothing on disk for this step, running all ${step.tasks.length} task(s)`
          : `  resuming: ${reused}/${step.tasks.length} task(s) already answered, running ${pendingTasks.length}`);
      }

      const queue = pendingTasks.map((planned) => ({ planned, task: buildChangeTask(loaded, planned, sandbox, captured) }));

      const handle = async (planned: typeof queue[number]["planned"], task: ChangeTask, worker: WorkerEndpoint): Promise<TaskOutcome> => {
        const startedAt = performance.now();
        const attempts: Attempt[] = [];
        let generate_ms = 0;
        let gate_ms = 0;
        let current = task;
        let reason = "ran out of attempts";
        let threw: string | null = null;

        try {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            // **Written before the worker is asked**, and for three readers rather than for tidiness:
            // `sidecrew fix-escalate` joins its queue back to `tasks/<id>.json` and silently drops an
            // item it cannot join; `--resume` needs it to know the task was started; and a run that
            // dies mid-generation should still say what it was asked.
            //
            // Until now only *retries* and corrections wrote one, so a first-attempt escalation had no
            // task on disk and vanished from its own queue. Found by the resume test rather than by the
            // escalation path, which returned a short batch and looked correct doing it.
            await writeJson(join(runDir, "tasks", `${safeName(current.task_id)}.json`), current);
            const candidate = await generateOne(current, worker);
            generate_ms += candidate.timing.wall_ms;
            await writeJson(join(runDir, "candidates", `${safeName(current.task_id)}.json`), candidate);
            if (thermal.observe(decodeTokensPerSecond({ usage: candidate.usage, ...candidate.timing }))) {
              say(`thermal back-off: ${thermal.events.at(-1)!.reason}`);
            }

            const gateStart = performance.now();
            const verdict = await verifyChange(current, candidate, {
              sandbox, baseline, projectDir, runner, tsconfig, compilerFlags,
              timeouts: opts.timeouts, sandboxRoot: opts.sandboxRoot, keepSandbox: opts.keepSandbox,
            });
            gate_ms += performance.now() - gateStart;
            await writeJson(join(runDir, "verdicts", `${safeName(current.task_id)}.json`), verdict);
            if (!staleBaselineWarned && crossesCalendarDay(verdict) === true) {
              staleBaselineWarned = true;
              say(
                `warning: this step's baseline was captured on ${verdict.baseline_captured_at} and ` +
                `${current.task_id} was verified on ${verdict.verified_at} — a different calendar day. ` +
                "A test that asserts on today's date passed at capture and fails now, and every verdict " +
                "from here on inherits it as a regression. ADR-0069: re-capture the baseline and restart " +
                "the step; a run discarded for environmental reasons is restarted, never resumed.",
              );
            }
            await writeFile(join(runDir, "diffs", `${safeName(current.task_id)}.diff`), diffFor(current, candidate), "utf8");
            attempts.push({ task: current, candidate, verdict });

            const decision = shouldRetryChange(verdict);
            reason = decision.reason;
            const willRetry = decision.retry && attempt === 0;
            say(verdict.survived
              ? `${current.task_id}: survived (${verdict.files_touched.join(", ")})`
              : `${current.task_id}: failed at ${verdict.stage_reached} · ${willRetry ? "retrying once" : `escalating — ${decision.reason}`}`);

            // ── the correction round (ADR-0044 §4) ───────────────────────────────────────────────
            //
            // Placed **after** the mechanical retry has been spent, never instead of it: rule 3, and
            // the reason is the measurement. ADR-0022's retry carries the compiler's own words for
            // free, so §2.2's question is "what does an Opus note buy *over* that" — and a note
            // written earlier would answer a different, much easier question.
            //
            // The survivor case (ADR-0057) is the exception, and it is the only one: a candidate that
            // passed has no failure to retry, so its correction rides on the first attempt that
            // carries an observation.
            const corrigible = verdict.survived || attempt === 1;
            if (corrigible && opts.correct !== undefined && current.attempt < 2) {
              const gate = shouldCorrect(verdict, plan.correction, spent);
              if (gate.write) {
                const b = brief(verdict, planned.shape);
                const written = await opts.correct(b);
                spent.written += 1;
                spent.tokens += written.tokens;
                if (verdict.survived) spent.on_observations += 1;
                await writeFile(
                  join(runDir, "corrections", `${safeName(current.task_id)}.md`),
                  `${renderBrief(b)}\n\n---\n\n${written.note}\n`,
                  "utf8",
                );
                say(`${current.task_id}: corrected (${written.tokens} Opus tokens) — ${gate.reason}`);

                const corrected = buildChangeTask(loaded, planned, sandbox, captured, {
                  attempt: 2,
                  retryOf: task.task_id,
                  previousError: truncateError(verdict.error ?? decision.reason),
                  correction: truncateError(written.note),
                });
                await writeJson(join(runDir, "tasks", `${safeName(corrected.task_id)}.json`), corrected);
                const c2 = await generateOne(corrected, worker);
                generate_ms += c2.timing.wall_ms;
                await writeJson(join(runDir, "candidates", `${safeName(corrected.task_id)}.json`), c2);

                const g2 = performance.now();
                const v2 = await verifyChange(corrected, c2, {
                  sandbox, baseline, projectDir, runner, tsconfig, compilerFlags,
                  timeouts: opts.timeouts, sandboxRoot: opts.sandboxRoot, keepSandbox: opts.keepSandbox,
                });
                gate_ms += performance.now() - g2;
                await writeJson(join(runDir, "verdicts", `${safeName(corrected.task_id)}.json`), v2);
                await writeFile(join(runDir, "diffs", `${safeName(corrected.task_id)}.diff`), diffFor(corrected, c2), "utf8");
                attempts.push({ task: corrected, candidate: c2, verdict: v2 });
                if (v2.survived) spent.survived += 1;
                reason = v2.survived ? "" : `the correction did not survive either: ${shouldRetryChange(v2).reason}`;
                say(`${corrected.task_id}: ${v2.survived ? "survived after correction" : `still failed at ${v2.stage_reached}`}`);
                break;
              }
              if (budgetExhausted === null && /budget|cap/.test(gate.reason)) budgetExhausted = gate.reason;
            }

            if (verdict.survived) { reason = ""; break; }
            if (!decision.retry || attempt === 1) break;

            const next = buildChangeTask(loaded, planned, sandbox, captured, {
              attempt: attempt + 1,
              retryOf: task.task_id,
              previousError: truncateError(verdict.error ?? decision.reason),
            });
            // ADR-0022: a retry whose prompt is byte-identical is a guaranteed wasted verdict, because
            // the worker is deterministic. It happens when the gate had nothing quotable to say.
            if (await changePromptText(next) === await changePromptText(current)) {
              reason = `${decision.reason}, and the retry prompt would be byte-identical to the first attempt's — a deterministic worker would return the same candidate (ADR-0022)`;
              say(`${current.task_id}: escalating without spending the retry — ${reason}`);
              break;
            }
            current = next;
            await writeJson(join(runDir, "tasks", `${safeName(current.task_id)}.json`), current);
          }
        } catch (e) {
          if (isFatal(e)) throw e;
          threw = truncateError(String((e as Error)?.message ?? e));
          reason = `the run threw rather than returning a verdict: ${threw}`;
          say(`${current.task_id}: ${reason}`);
        }

        return {
          task_id: task.task_id,
          blocking: planned.blocking,
          attempts,
          latency_ms: performance.now() - startedAt,
          generate_ms,
          gate_ms,
          retried: attempts.length > 1,
          reason: reason === "" ? null : reason,
          threw,
        };
      };

      sampler.start();
      try {
        const pending = [...queue];
        const runner_ = async (worker: WorkerEndpoint, slot: number): Promise<void> => {
          for (;;) {
            if (slot >= thermal.concurrency) {
              say(`worker :${worker.port} standing down — concurrency is now ${thermal.concurrency}`);
              return;
            }
            const next = pending.shift();
            if (next === undefined) return;
            stepOutcomes.push(await handle(next.planned, next.task, worker));
          }
        };
        await Promise.all(slots.slice(0, opts.generate === undefined ? concurrency.workers : 1).map((w, i) => runner_(w, i)));
      } finally {
        sampler.stop();
      }

      // The step boundary: survivors land in the sandbox, so the next step's baseline is the project
      // after this one (ADR-0044 §2). The run does not wait for Opus here — a decision per step is
      // where supervision is cheap and a wait per step is where a long job dies overnight.
      for (const planned of step.tasks) {
        const outcome = stepOutcomes.find((o) => o.task_id === planned.task_id);
        if (outcome === undefined) continue;
        outcomes.push(outcome);
        const lastAttempt = outcome.attempts.at(-1);

        // Appended as the task gives up, never derived from result.json at the end (ADR-0023). A `fix`
        // run is 262 s of gate per attempt and hours long, so "the run finished" is exactly the
        // assumption that fails — and the attempts are spent either way.
        // `!outcome.resumed`: a reused escalation was appended when it first gave up (ADR-0023), and
        // appending it again would put the same task in the queue twice — which `sidecrew fix-escalate`
        // would faithfully report as two failures.
        if (!survivedOutcome(outcome) && outcome.resumed !== true) {
          await appendChangeEscalation(runDir, {
            task_id: outcome.task_id,
            shape: planned.shape,
            reason: outcome.reason ?? "ran out of attempts",
            machine_failure: isMachineFailure(outcome),
            refused: outcome.attempts.find((a) => a.verdict.refused !== null)?.verdict.refused ?? null,
            attempts: outcome.attempts.length > 0
              ? outcome.attempts.map((a) => ({
                task_id: a.task.task_id,
                attempt: a.task.attempt,
                stage_reached: a.verdict.stage_reached,
                confinement: a.verdict.confinement.map((b) => b.rule),
                regressed: a.verdict.tests?.regressed.slice(0, 20) ?? [],
                error: truncateError(a.verdict.error ?? shouldRetryChange(a.verdict).reason),
              }))
              // A task that threw produced no verdict, so there is no stage to name. Calling it
              // `compile` would read as "it did not compile", which is a different problem.
              : [{
                task_id: outcome.task_id,
                attempt: 0,
                stage_reached: null,
                confinement: [],
                regressed: [],
                error: truncateError(outcome.threw ?? outcome.reason ?? "no verdict was produced"),
              }],
            escalated_at: new Date().toISOString(),
          });
        }

        if (!survivedOutcome(outcome) || lastAttempt === undefined) continue;
        for (const edit of lastAttempt.candidate.edits) {
          await writeFile(join(sandbox, edit.path), edit.contents, "utf8");
        }
        const diffPath = join(runDir, "diffs", `${safeName(lastAttempt.task.task_id)}.diff`);
        const fixed = Object.entries(lastAttempt.verdict.errors.before.by_file)
          .filter(([f]) => lastAttempt.task.files.some((tf) => tf.path === f))
          .reduce((n, [, count]) => n + count, 0);
        survivors.push({
          task_id: outcome.task_id,
          files: lastAttempt.verdict.files_touched.length > 0 ? lastAttempt.verdict.files_touched : lastAttempt.task.files.map((f) => f.path),
          diff_path: diffPath,
          errors_fixed: fixed,
        });
      }

      const survivedHere = stepOutcomes.filter(survivedOutcome).length;
      stepRows.push({
        name: step.name,
        tasks: step.tasks.length,
        survived: survivedHere,
        escalated: stepOutcomes.length - survivedHere,
        errors_before: baseline.errors.total,
        // Filled by the next baseline, or by the final one below.
        errors_after: baseline.errors.total,
      });

      const blocked = stepOutcomes.filter((o) => o.blocking && !survivedOutcome(o));
      if (blocked.length > 0) {
        stopped = `step "${step.name}" left ${blocked.length} blocking task(s) unfinished: ${blocked.map((o) => o.task_id).join(", ")}`;
        say(`stopping: ${stopped} — later steps would build on a project this step did not finish (ADR-0044 §2)`);
        break;
      }
    }

    // The run's last act, and it checks something no individual verdict can. Every candidate was
    // verified **alone**, against its own step's baseline, in a sandbox holding only its own change —
    // so two survivors that are each fine and together are not would pass every per-task gate there
    // is. One `tsc` and one suite run, with everything applied, is what closes that.
    if (!opts.dryRun && first !== null) {
      const timeouts = { ...DEFAULT_CHANGE_TIMEOUTS, ...opts.timeouts };
      const final = await typecheck(sandbox, projectDir, tsconfig, timeouts.compile, compilerFlags);
      for (let i = 0; i < stepRows.length; i += 1) {
        stepRows[i]!.errors_after = i + 1 < stepRows.length ? stepRows[i + 1]!.errors_before : final.errors.total;
      }
      const suite = await runSuite(sandbox, projectDir, runner, timeouts.tests);
      const passingNow = new Set(suite.passed_ids);
      combined = first.tests.passed_ids.filter((id) => !passingNow.has(id));
      after = { errors: final.errors.total, tests_ran: suite.ran, tests_passed: suite.passed };
      say(
        combined.length === 0
          ? `  all survivors applied together: ${final.errors.total} tsc errors, ${suite.passed}/${suite.ran} tests passing`
          : `  WARNING: ${combined.length} test(s) pass individually and fail with every survivor applied — ` +
            "this is a hole in the gate, not a bad change. See combined-regressions.txt",
      );
      if (combined.length > 0) {
        await writeFile(join(runDir, "combined-regressions.txt"), `${combined.join("\n")}\n`, "utf8");
      }
    }
  } finally {
    if (opts.keepSandbox) process.stderr.write(`sidecrew: step sandbox kept at ${sandbox}\n`);
    else await rm(sandbox, { recursive: true, force: true });
  }

  const verdicts = outcomes.flatMap((o) => o.attempts.map((a) => a.verdict));
  const candidates = outcomes.flatMap((o) => o.attempts.map((a) => a.candidate));
  const breaks: Record<string, number> = {};
  for (const v of verdicts) {
    for (const b of v.confinement) breaks[b.rule] = (breaks[b.rule] ?? 0) + 1;
  }

  const result = FixResult.parse({
    run_id: id,
    plan: loaded.planPath,
    config: {
      worker_kind: tier,
      worker_model: opts.workerModel ?? api?.model ?? workers[0]?.model ?? model.repo,
      concurrency: opts.generate === undefined ? concurrency.workers : 1,
      retry: 1,
    },
    project: {
      errors_before: first?.errors.total ?? 0,
      errors_after: after?.errors ?? 0,
      tests_ran: after?.tests_ran ?? 0,
      tests_passed: after?.tests_passed ?? 0,
      combined_regressions: combined.length,
    },
    steps: stepRows,
    stats: {
      tasks: outcomes.length,
      survived: survivors.length,
      retried: outcomes.filter((o) => o.retried).length,
      escalated: outcomes.length - survivors.length,
      funnel: {
        answered: candidates.length,
        edits_parsed: candidates.filter((c) => c.edits.length > 0).length,
        confined: verdicts.filter((v) => v.confined).length,
        applied: verdicts.filter((v) => v.stage_reached !== "generate" && v.stage_reached !== "confinement").length,
        compiled: verdicts.filter((v) => v.compile_ok).length,
        suite_green: verdicts.filter((v) => v.tests_ok).length,
      },
      edit_parse_failed: candidates.filter((c) => c.unparsed !== null).length,
      edit_truncated: candidates.filter((c) => c.truncated).length,
      machine_failures: outcomes.filter(isMachineFailure).length,
      cache: { enabled: cacheOn, hits: cache?.hits ?? 0, writes: cache?.writes ?? 0 },
      refusals: outcomes.filter((o) => o.attempts.some((a) => a.verdict.refused !== null)).length,
      corrections: { ...spent, budget_exhausted: budgetExhausted },
      confinement_breaks: breaks,
      latency_ms: spread(outcomes.map((o) => o.latency_ms)),
      generate_ms: spread(outcomes.map((o) => o.generate_ms)),
      gate_ms: spread(outcomes.map((o) => o.gate_ms)),
      peak_rss_mb: sampler.peakMb,
      // Zero on the local tier because the workers are on localhost, and the schema refuses anything
      // else there. An injected `api` generator reports what it actually spent.
      //
      // Corrections are added to `planning` because they **are** Opus tokens, and they are the one
      // legitimate way a `fix` run spends them on the local tier. Hiding them would make §2.2 price a
      // correction against a cost the result does not show; the schema refuses a result where they
      // exceed `planning`, so the two cannot drift.
      //
      // On the api tier the default is **what Anthropic billed**, summed from every candidate's own
      // usage block (ADR-0045 §6) rather than from a caller's arithmetic. `generateApiChange` refuses a
      // completion whose usage was not measured, so a number that reaches here is one the API reported
      // — which is what Phase 13 §5.0.2 requires, and a run that cannot say it is void.
      //
      // `opts.workerTokens` stays as an override for the one arm that genuinely cannot thread it: the
      // subagent harness, whose candidates do not come from `completeApi` at all.
      claude_tokens: {
        planning: plan.meta.planner_tokens + spent.tokens,
        workers: opts.workerTokens ?? (tier === "api" ? billedWorkerTokens(candidates) : 0),
        review: null,
      },
    },
    survivors,
    escalations: outcomes
      .filter((o) => !survivedOutcome(o))
      .map((o) => ({
        task_id: o.task_id,
        attempts: [
          ...o.attempts.map((a) => ({ error: truncateError(a.verdict.error ?? shouldRetryChange(a.verdict).reason) })),
          ...(o.threw === null ? [] : [{ error: o.threw }]),
        ],
      })),
  });

  await writeJson(join(runDir, "result.json"), result);
  if (stopped !== null) await writeFile(join(runDir, "stopped.txt"), `${stopped}\n`, "utf8");
  if (!opts.dryRun) {
    say(`${survivors.length}/${outcomes.length} survived · ${result.project.errors_before} → ${result.project.errors_after} tsc errors · ${join(runDir, "result.json")}`);
  }
  return result;
}

/** The unified diff of what a candidate would do. The artefact a reviewer reads; nothing gates on it. */
export const diffFor = (task: ChangeTask, candidate: ChangeCandidate): string =>
  diffOf(candidate.edits.map((e) => ({
    path: e.path,
    before: task.files.find((f) => f.path === e.path)?.source ?? "",
    after: e.contents,
  })));

