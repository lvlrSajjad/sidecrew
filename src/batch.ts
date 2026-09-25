// `sidecrew run` — a whole plan, generated locally and verified, with files as the IPC.
//
// The shape of the loop is the project in miniature: for every function × shape, generate → verify →
// on failure retry once with the error appended → escalate. Everything it learns goes to
// `.sidecrew/runs/<id>/` as one JSON file per task, candidate and verdict, and `result.json` is the
// only thing the MCP tool hands back — Claude sees survivors, never raw worker output
// (CLAUDE.md #3).
//
// Two rules in here are load-bearing and neither is obvious from the loop:
//
//   * **A stale plan does not get to spend a token.** `source_sha` is checked against the module on
//     disk first, because ADR-0013 scopes mutation to a line range and a stale range mutates the
//     wrong lines — the verdict would be about code nobody asked to test.
//   * **Two failures must not consume the single retry.** `stage_reached === "mutation"` is the
//     mutation tool breaking, not the test being bad (ADR-0012); four mutation counts of zero means
//     nothing in that function could be mutated, so no test of it could ever have killed anything
//     (ADR-0005). Both escalate directly.
//
// Phase 7 added three more, each of which is a thing the loop can now notice about itself:
//
//   * **A retry whose prompt is identical to the first attempt is not spent** (ADR-0022). Generation is
//     deterministic, so the second candidate would be the first one again — the retry would be a
//     guaranteed wasted verdict rather than a second chance.
//   * **An escalation is written when it happens** (ADR-0023), to `escalations.jsonl`, so a run that
//     dies still has the record of what its attempts bought.
//   * **A task that throws does not take the run with it.** A worker that goes away or a verifier that
//     crashes is recorded as that task's last attempt and the queue keeps moving; a `VerifierSetupError`
//     or a `PlanError` still stops everything, because those are true of every remaining task too.
import { withIntactProject } from "./integrity.js";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { RESULTS_DIR } from "./bench.js";
import { appendEscalation } from "./escalate.js";
import { run } from "./exec.js";
import { planApiConcurrency, planConcurrency, type ConcurrencyPlan } from "./concurrency.js";
import { baseUrlFor, DEFAULT_PORT, probeWorker, readMemory, type Memory } from "./doctor.js";
import { assertSupportedMachine, apiModel, defaultKey, entry, modelForMachine, tierFor, type ModelEntry } from "./models.js";
import { assertMeasuredUsage, completeApi, resolveApiTier, type ApiTierContext } from "./api-worker.js";
import { buildPrompt, estimateTokens, promptText } from "./prompt.js";
import {
  buildTask,
  buildTasks,
  functionOfTaskId,
  loadPlan,
  PlanError,
  staleFunctions,
  verifyCandidate,
  type LoadedPlan,
} from "./plan.js";
import { BatchResult, Candidate, type Escalation, type Verdict, type WorkerKind, type WorkerTask } from "./schemas.js";
import { validatePlan } from "./validate.js";
import { readRecord, sidecrewDir, type WorkerRecord } from "./serve.js";
import { benchBaseline, ThermalGuard, type BackOff } from "./throttle.js";
import { complete, decodeTokensPerSecond } from "./worker.js";
import { safeName, truncateError, VerifierSetupError } from "./verifier/shared.js";
import { describeContradiction, findContradiction, type Contradiction } from "./verifier/contradiction.js";

/**
 * One seed for every task in a run. Not per task: the prompt already differs per function × shape, so
 * varying the seed as well would mean a rerun of the same plan could not be compared with the last
 * one, which is the whole reason non-negotiable #4 exists.
 */
export const RUN_SEED = 42;

/**
 * Room for a test file and not much more. Measured shape on the fixture: a candidate is 150–400
 * completion tokens, so this is generous — but a truncated file fails the compile stage and costs a
 * whole verdict, which is far more expensive than the tokens it saves.
 */
export const MAX_TEST_TOKENS = 1200;

/** A worker is allowed to be slow; it is not allowed to hang a run. */
export const GENERATE_TIMEOUT_MS = 180_000;

const EXTENSION: Record<string, string> = { typescript: ".test.ts", swift: ".swift" };

// ── what the worker said, minus what it was told not to say ───────────────────────────────────────

const FENCE = /^```[\w-]*\n([\s\S]*?)\n?```$/;

/**
 * End-of-turn markers, which arrive as *content* rather than as a finish reason.
 *
 * Measured on the first real run: mlx_lm 0.31.3 streamed `<|im_end|>` at the end of every Qwen
 * completion, inside the delta. Six candidates out of six failed the compile stage on it, and the
 * verdicts read exactly like a model that cannot write TypeScript. Left alone, that is a discard rate
 * reporting on a serving detail — the same failure mode `fixtures/ts-fixture/README.md` avoids by
 * choosing a module resolution the model was not told about.
 */
const END_OF_TURN = /(?:<\|im_end\|>|<\|endoftext\|>|<\|eot_id\|>|<\/s>)\s*$/;

/**
 * The prompt says "no markdown fences". A 7B says it anyway, often enough that not stripping them
 * would make the compile stage a measurement of instruction-following rather than of test quality.
 * Only a fence wrapping the *whole* answer is removed: a fence with prose around it means the model
 * answered a different question, and that is a real failure the verifier should see.
 */
export function extractTestSource(text: string): string {
  const clean = text.replace(END_OF_TURN, "").trim();
  const fenced = FENCE.exec(clean);
  return (fenced?.[1] ?? clean).trim();
}

// ── the workers that are up ───────────────────────────────────────────────────────────────────────

export interface WorkerEndpoint {
  port: number;
  baseUrl: string;
  record: WorkerRecord | null;
  /** What goes in the request's `model` field: the snapshot path when pinned, else the repo id. */
  modelArg: string;
  /** What goes in `Candidate.worker.model`: the repo id, which is the thing a reader can look up. */
  model: string;
  revision: string;
}

/**
 * A worker is up and sidecrew has no record of what it loaded. Not a machine problem — a wrong guess
 * here spends a whole run on a model nobody chose, so it is a refusal (ADR-0029).
 */
export class AnonymousWorkerError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AnonymousWorkerError";
  }
}

/**
 * Which workers this run may talk to, one in-flight request each (non-negotiable #4).
 *
 * Parallelism comes from several worker processes, never from several requests to one: a seeded
 * request is excluded from mlx_lm's batch and served alone (ADR-0003), so a second concurrent request
 * to the same port would simply queue while making the timings say otherwise.
 *
 * **What `model` is sent matters far more than it looks** (ADR-0029). mlx_lm reloads whenever the
 * requested name differs from the loaded key — `ModelProvider.load` is `if self.model_key != model_key:
 * self._load(...)` — so a wrong name does not fail, it swaps several GB of weights and answers as a
 * different model. `/v1/models` cannot settle it: mlx_lm serves that endpoint from the Hugging Face
 * cache, so it lists everything *downloaded* rather than the one thing loaded, and on the machine this
 * was found on it listed the 14B first while the 7B was resident.
 *
 * So the record `serve` wrote is the only authority, and where there is none the rule is:
 *
 *   * one entry in the catalogue — safe to use. There is nothing else it could load, so the name cannot
 *     trigger a swap, and a worker somebody else started stays usable.
 *   * several — **refuse**. Any choice is a guess, and the cost of guessing wrong is a run of candidates
 *     attributed to a model that did not write them.
 */
export async function discoverWorkers(ports: number[], dir?: string): Promise<WorkerEndpoint[]> {
  const found = await Promise.all(ports.map(async (port) => {
    const [probe, record] = await Promise.all([probeWorker(port), readRecord(port, dir ?? sidecrewDir())]);
    if (!probe.up) return null;

    if (record === null && probe.available.length !== 1) {
      throw new AnonymousWorkerError(
        `a worker is answering on ${baseUrlFor(port)} but sidecrew has no record of what it loaded, and ` +
        `its catalogue offers ${probe.available.length} models — picking one would be a guess, and mlx_lm ` +
        "answers a wrong guess by swapping in that model's weights rather than by failing.\n" +
        `${probe.available.map((m) => `    ${m}`).join("\n")}\n` +
        "  The record is written by `sidecrew serve` into .sidecrew/ of the directory it ran in. If that is\n" +
        "  a different directory from this one, point at it: SIDECREW_DIR=/path/to/.sidecrew sidecrew run …\n" +
        "  Otherwise stop that worker and start one from here: sidecrew serve",
      );
    }

    // Anonymous but unambiguous: one model in the catalogue cannot be the wrong one. The candidate
    // records an empty revision rather than inventing one.
    const modelArg = record?.model_arg ?? probe.available[0]!;
    return {
      port,
      baseUrl: baseUrlFor(port),
      record,
      modelArg,
      model: record?.repo ?? probe.available[0]!,
      revision: record?.revision ?? "",
    } satisfies WorkerEndpoint;
  }));
  return found.filter((w): w is WorkerEndpoint => w !== null);
}

// ── generation ────────────────────────────────────────────────────────────────────────────────────

export interface GenerateOpts {
  /**
   * The prompt template, already read. Defaults to the shipped `src/prompts/worker.md`.
   *
   * It exists so the ablation can hold everything else — the worker, the seed, the tasks, the verifier
   * — constant and vary only the wording, which is the only way a prompt comparison means anything.
   * Nothing in the pipeline passes it.
   */
  template?: string;
}

export async function generate(task: WorkerTask, worker: WorkerEndpoint, opts: GenerateOpts = {}): Promise<Candidate> {
  const messages = await buildPrompt(task, { template: opts.template });
  const completion = await complete({
    baseUrl: worker.baseUrl,
    model: worker.modelArg,
    messages,
    seed: RUN_SEED,
    maxTokens: MAX_TEST_TOKENS,
    timeoutMs: GENERATE_TIMEOUT_MS,
  });
  const text = extractTestSource(completion.text);

  // Recording an estimate as a measurement would put a fiction into `Candidate.usage` and from there
  // into the go/no-go numbers. Refusing is the option that does not require a contract change (BACKLOG,
  // noticed while reviewing Phase 1), and it fires only on a server that ignored `include_usage`.
  if (completion.usage_estimated) {
    throw new Error(
      `${worker.baseUrl} sent no usage block, so this candidate's token counts would be a guess. ` +
      "sidecrew records measurements, not estimates — is this an mlx_lm.server?",
    );
  }

  // The same rule, for the server that answers the question dishonestly rather than not at all.
  //
  // Asking "did it send usage?" is not the same as asking "is the usage true", and Phase 6 found the
  // gap the hard way: the Apple shim returns `{prompt_tokens: 0, completion_tokens: 0}` for a
  // 600-character test file, which satisfies the check above and lands a zero in `Candidate.usage` as
  // though it had been measured (ADR-0019). A floor is all that is needed, and it is arithmetic rather
  // than a judgement: text that is not empty cannot have cost zero completion tokens. An empty answer
  // reporting zero is left alone — that one is consistent, and it fails the compile stage on its own.
  if (text.length > 0 && completion.usage.completion_tokens === 0) {
    throw new Error(
      `${worker.baseUrl} reported 0 completion tokens for ${text.length} characters of output, ` +
      "so this candidate's token counts are a fiction rather than a measurement. " +
      "sidecrew records measurements, not estimates — is this an mlx_lm.server?",
    );
  }

  return Candidate.parse({
    task_id: task.task_id,
    worker: { kind: "local", model: worker.model, revision: worker.revision, temperature: 0, seed: RUN_SEED },
    test_source: text,
    usage: { prompt_tokens: completion.usage.prompt_tokens, completion_tokens: completion.usage.completion_tokens },
    timing: { ttft_ms: completion.ttft_ms, wall_ms: completion.wall_ms },
  });
}

/**
 * The same task, the same prompt, the same refusals — written by Claude over the API (ADR-0045).
 *
 * A separate function rather than a branch inside `generate` because the two tiers reach opposite
 * guards: `complete` calls `assertLocalTier` and would refuse this host, `completeApi` calls
 * `assertApiTier` and refuses every other one. That is the arrangement ADR-0059 chose, and a shared
 * function with a flag would be one edit away from having neither guard.
 *
 * `seed` is null because the API offers none; `WorkerStamp` requires one only on `local`, so the
 * record says what actually happened rather than inventing a value (ADR-0009).
 */
export async function generateApi(task: WorkerTask, api: ApiTierContext, opts: GenerateOpts = {}): Promise<Candidate> {
  const messages = await buildPrompt(task, { template: opts.template });
  const completion = await completeApi({
    baseUrl: api.baseUrl,
    apiKey: api.apiKey,
    model: api.model,
    messages,
    maxTokens: MAX_TEST_TOKENS,
    timeoutMs: GENERATE_TIMEOUT_MS,
    fetchImpl: api.fetchImpl,
  });
  const text = extractTestSource(completion.text);
  assertMeasuredUsage(completion, text.length);

  return Candidate.parse({
    task_id: task.task_id,
    worker: { kind: "api", model: api.model, revision: "", temperature: 0, seed: null },
    test_source: text,
    usage: { prompt_tokens: completion.usage.prompt_tokens, completion_tokens: completion.usage.completion_tokens },
    timing: { ttft_ms: completion.ttft_ms, wall_ms: completion.wall_ms },
  });
}

/** What the workers billed, summed from the API's own usage fields (ADR-0045 §6, Phase 13 §5.0.2). */
export const billedWorkerTokens = (candidates: { usage: { prompt_tokens: number; completion_tokens: number } }[]): number =>
  candidates.reduce((n, c) => n + c.usage.prompt_tokens + c.usage.completion_tokens, 0);

// ── the retry rule ────────────────────────────────────────────────────────────────────────────────

export interface RetryDecision {
  retry: boolean;
  /** Why, in the words the run log and the escalation both use. */
  reason: string;
}

/**
 * Does this failure deserve the one retry? Two of them do not, and both would look like the test's
 * fault to a loop that only read `survived`.
 */
export function shouldRetry(verdict: Verdict, contradiction: Contradiction | null = null): RetryDecision {
  if (verdict.survived) return { retry: false, reason: "survived" };
  if (verdict.stage_reached === "mutation") {
    return { retry: false, reason: "the mutation tool produced no report — a machine problem, not the candidate's (ADR-0012)" };
  }
  const m = verdict.mutation;
  if (m !== null && m.killed + m.survived + m.timeout + m.no_coverage === 0) {
    return { retry: false, reason: "nothing in that function could be mutated, so no test of it could ever have killed anything (ADR-0005)" };
  }
  // Ordered by what the retry can act on. A candidate that does not compile is usually flagged
  // tautological too — the detector reads text that never got as far as calling anything — and
  // "did not compile" is the sentence that names the thing to fix.
  if (!verdict.compile_ok) return { retry: true, reason: "did not compile" };
  if (!verdict.pass_ok) {
    // ADR-0042. `compiled but did not pass` is true and says nothing a worker can act on; the retry is
    // then spent on a pasted jest failure. Where the file is wrong **on its own terms** the useful
    // sentence is available without running anything, and it is this one. It changes no verdict —
    // `survived` is already false here, and `retry` is the same either way.
    return {
      retry: true,
      reason: contradiction === null ? "compiled but did not pass" : describeContradiction(contradiction),
    };
  }
  if (verdict.tautological) return { retry: true, reason: "tautological — it passes without testing the function" };
  if (m !== null && m.killed > 0) {
    return { retry: true, reason: "killed only mutants that make the function throw or empty its body — assert on the value (ADR-0089)" };
  }
  return { retry: true, reason: "killed no mutant" };
}

// ── what the workers cost while this ran ──────────────────────────────────────────────────────────

/**
 * Peak resident memory of the worker *pool*, sampled.
 *
 * The peak of the sum, not the sum of the peaks: non-negotiable #5 is about what this machine was
 * holding at once, and two workers that peak a minute apart never held that much together. Workers
 * sidecrew did not start have no pid on disk and are simply not counted — a missing number is better
 * than a wrong one, and `BatchResult` carries no way to say "partly measured".
 */
export class PoolRss {
  private peakKb = 0;
  private timer: NodeJS.Timeout | null = null;

  public constructor(private readonly pids: number[], private readonly everyMs = 1_000) {}

  public async sample(): Promise<void> {
    if (this.pids.length === 0) return;
    const r = await run("ps", ["-o", "rss=", "-p", this.pids.join(",")], { timeoutMs: 5_000 });
    const total = r.stdout.split("\n").map((l) => Number(l.trim())).filter((n) => Number.isFinite(n) && n > 0)
      .reduce((a, b) => a + b, 0);
    if (total > this.peakKb) this.peakKb = total;
  }

  public start(): void {
    if (this.timer) return;
    void this.sample();
    this.timer = setInterval(() => { void this.sample(); }, this.everyMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  public get peakMb(): number {
    return Number((this.peakKb / 1024).toFixed(1));
  }
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────────

export interface RunBatchOpts {
  concurrency?: number;
  /** Build the tasks *and the prompts*, write both, report the concurrency — and stop before the first token. */
  dryRun?: boolean;
  /** Ports to look for workers on. Defaults to `SIDECREW_PORTS`, else the one default port. */
  ports?: number[];
  /** Where `runs/<id>/` goes. Defaults to `.sidecrew`. */
  dir?: string;
  /** ADR-0014's override, for a package whose plan does not name a test target. */
  testTarget?: string;
  /** Where `sidecrew bench` wrote its results, for the thermal baseline. Defaults to the repo's. */
  benchDir?: string;
  /**
   * Force a tier instead of reading it off installed RAM (ADR-0045 §4).
   *
   * For tests and for the §5 measurement, which has to run the `api` tier on whatever machine is to
   * hand. It is **not** a user-facing opt-in: a machine's tier is a property of the machine, and the
   * hazard ADR-0009 closed — a 32 GB machine quietly billing — stays closed because the default comes
   * from installed RAM and nothing here consults free RAM.
   */
  workerKind?: WorkerKind;
  /** The resolved api-tier context. Injected by tests; otherwise read from the environment. */
  api?: ApiTierContext;
  /** One line per event, for the CLI. Silent by default, because the MCP server owns stdout. */
  onEvent?: (line: string) => void;
}

export interface Attempt {
  task: WorkerTask;
  candidate: Candidate;
  verdict: Verdict;
}

interface TaskOutcome {
  task_id: string;
  attempts: Attempt[];
  latency_ms: number;
  retried: boolean;
  /** Why this task stopped. `null` once it survived. */
  reason: string | null;
  /** An exception rather than a verdict — a worker that went away, a verifier that crashed. */
  threw: string | null;
}

/** Survived ⇔ the last attempt's verdict says so. An outcome with no attempts at all did not. */
const survivedOutcome = (o: TaskOutcome): boolean => o.attempts.at(-1)?.verdict.survived === true;

/**
 * A setup problem is true of every remaining task, so it stops the run; anything else is this task's.
 *
 * The distinction is the whole of Phase 4's "one failed task fails the whole batch" note. A missing
 * `stryker`, an ambiguous Swift test target or a plan that does not describe the code will fail the next
 * nineteen candidates exactly as it failed this one, and finding that out twenty times is not resilience.
 * A worker that went away mid-run, or a verifier that crashed on one file, is not.
 */
const isFatal = (e: unknown): boolean => e instanceof VerifierSetupError || e instanceof PlanError;

const quantile = (values: number[], q: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[at] ?? 0;
};

/** `2026-09-14T09-31-02Z-strings` — sortable, and it names the module it was about. */
export const runId = (module: string, now = new Date()): string =>
  `${now.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-")}-${safeName(basename(module).replace(/\.[^.]+$/, ""))}`;

export const portsFromEnv = (env: NodeJS.ProcessEnv = process.env): number[] => {
  const raw = env.SIDECREW_PORTS ?? env.SIDECREW_PORT ?? "";
  const ports = raw.split(",").map((p) => Number(p.trim())).filter((p) => Number.isInteger(p) && p > 0);
  return ports.length > 0 ? ports : [DEFAULT_PORT];
};

/** The model whose footprint sizes a slot: what the workers are actually running, else this machine's tier. */
const modelOfRun = (workers: WorkerEndpoint[], mem: Memory | null): ModelEntry => {
  const key = workers.find((w) => w.record)?.record?.model_key;
  if (key !== undefined) {
    try {
      return entry(key);
    } catch {
      // A worker started from a models.json we no longer have. Fall through to this machine's tier.
    }
  }
  return modelForMachine(mem?.total_gb ?? 0) ?? entry(defaultKey());
};

/**
 * Workload #1 over a whole plan — and the project is intact afterwards, checked rather than promised
 * (ADR-0088). The fingerprint is taken before the first token and compared after the last verdict.
 */
export async function runBatch(planPath: string, opts: RunBatchOpts = {}): Promise<BatchResult> {
  const { projectDir } = await loadPlan(planPath);
  return withIntactProject(projectDir, () => runBatchUnchecked(planPath, opts), opts.onEvent);
}

async function runBatchUnchecked(planPath: string, opts: RunBatchOpts): Promise<BatchResult> {
  const say = opts.onEvent ?? (() => {});
  const loaded = await loadPlan(planPath);

  // Before the first token: the structural half of `sidecrew plan`, which is the half that costs nothing
  // (ADR-0029). A missing exemplar, a line range that is not the function it names, a shape no exemplar
  // defines — each of those makes every candidate fail for a reason that is not the candidate's, and the
  // first real run against somebody else's project spent twelve minutes discovering one. Exemplar
  // *verification* is still `sidecrew plan`'s job: it costs a verdict per shape, which is the expensive
  // half and the one a run should not silently pay.
  const structural = await validatePlan(planPath, { verifyExemplars: false, testTarget: opts.testTarget });
  if (!structural.valid) {
    throw new PlanError(
      `${planPath} does not describe something that can be run:\n` +
      structural.errors.map((e) => `  ${e.code} at ${e.where}: ${e.message}`).join("\n") +
      "\n  sidecrew plan <plan> is the full check, including whether the exemplars survive.",
    );
  }

  // Then: a stale plan mutates the wrong lines (ADR-0013).
  const stale = staleFunctions(loaded.plan, loaded.source);
  if (stale.length > 0) {
    throw new PlanError(
      `${planPath} is stale — ${stale.map((s) => s.name).join(", ")} ${stale.length === 1 ? "has" : "have"} changed since it was written. ` +
      "Re-plan the module; a stale line_range mutates the wrong lines and the verdict would be about code nobody asked to test.",
    );
  }

  const dir = opts.dir ?? sidecrewDir();
  const id = runId(loaded.plan.module);
  const runDir = join(dir, "runs", id);
  for (const sub of ["tasks", "candidates", "verdicts", "tests"]) await mkdir(join(runDir, sub), { recursive: true });

  const tasks = buildTasks(loaded);
  for (const task of tasks) await writeJson(join(runDir, "tasks", `${safeName(task.task_id)}.json`), task);

  const mem = await readMemory();

  // **Which tier this machine is, decided by installed RAM and never by free RAM** (ADR-0045 §4).
  // That distinction is the whole safety property: free RAM moves when somebody opens Xcode, and a
  // 32 GB machine that happens to be busy must not quietly start billing. Installed RAM does not move
  // during a workday.
  assertSupportedMachine(mem, opts.workerKind);
  const tier = opts.workerKind ?? tierFor(mem?.total_gb ?? 0).tier;

  // A local worker is looked for only on the tier that has one. Probing localhost on the api tier
  // would be noise, and — worse — finding something there would make the run ambiguous about who
  // wrote the candidate.
  const workers = tier === "local" ? await discoverWorkers(opts.ports ?? portsFromEnv()) : [];
  const api = tier === "api" ? (opts.api ?? resolveApiTier(apiModel().model)) : null;

  const model = modelOfRun(workers, mem);
  const concurrency = tier === "api"
    ? planApiConcurrency({ mem, requested: opts.concurrency })
    : planConcurrency({ model, mem, workersUp: workers.length, requested: opts.concurrency });
  say(`run ${id}: ${tasks.length} task${tasks.length === 1 ? "" : "s"}, ${concurrency.reason}`);
  if (api !== null) {
    say(
      `api tier · ${api.model} — ${tierFor(mem?.total_gb ?? 0).why}. ` +
      "Worker inference is billed to this machine's Anthropic key; the zero-worker-tokens guarantee is a local-tier guarantee (ADR-0045).",
    );
  }

  if (opts.dryRun) {
    // The prompts, not only the tasks. A `WorkerTask` on disk says what the worker will be told; the
    // rendered prompt is what it will actually receive, and the two differ by every conditional in the
    // template — ADR-0021's owner clause appears or does not, and the exemplar is inlined. A dry run that
    // stops before the first token should still show the bytes the token would have been produced from.
    await mkdir(join(runDir, "prompts"), { recursive: true });
    let promptTokens = 0;
    for (const task of tasks) {
      const text = await promptText(task);
      promptTokens += estimateTokens(text);
      await writeFile(join(runDir, "prompts", `${safeName(task.task_id)}.md`), text, "utf8");
    }
    const result = dryRunResult(id, loaded, tasks, workers, model, concurrency, tier, api?.model ?? null);
    await writeJson(join(runDir, "result.json"), result);
    say(
      `--dry-run: wrote ${tasks.length} task${tasks.length === 1 ? "" : "s"} and ${tasks.length} prompt${tasks.length === 1 ? "" : "s"} ` +
      `(~${promptTokens} estimated prompt tokens) to ${runDir} and stopped before the first token`,
    );
    return result;
  }

  if (tier === "local" && workers.length === 0) {
    throw new Error(
      `no worker is answering on ${(opts.ports ?? portsFromEnv()).map(baseUrlFor).join(", ")} — start one with: sidecrew serve`,
    );
  }

  // The api tier has no process to sample and no port to talk to; it still needs slots for the queue
  // loop to hand tasks to. `generate` dispatches on `api` rather than on the slot, so these carry no
  // base URL — an api-tier slot that looked like a local endpoint would be one typo from a request
  // going to the wrong guard.
  const slots: WorkerEndpoint[] = tier === "local"
    ? workers
    : Array.from({ length: concurrency.workers }, () => ({ port: 0, baseUrl: "", record: null, modelArg: api!.model, model: api!.model, revision: "" }));

  const sampler = new PoolRss(slots.slice(0, concurrency.workers).flatMap((w) => (w.record ? [w.record.pid] : [])));
  const outcomes = new Map<string, TaskOutcome>();
  const queue = [...tasks];

  // The thermal guard is only as honest as its baseline (ADR-0025): `sidecrew bench` measured this model
  // on this machine when it was cool, and without that number there is nothing to be 30 % below. No
  // bench, no guard, and the run says which it is rather than leaving the reader to guess.
  //
  // On the api tier there is nothing to throttle: the decode happens in a datacentre, `decode_tok_s`
  // measures somebody else's hardware and a back-off here would be sidecrew slowing itself down in
  // response to a number about a machine it does not own. The guard is off and the run says so.
  const baseline = tier === "local" ? await benchBaseline(model.key, opts.benchDir ?? RESULTS_DIR) : null;
  const thermal = new ThermalGuard({ baseline: tier === "local" ? baseline?.tok_s ?? null : null, concurrency: concurrency.workers });
  say(tier === "api"
    ? "thermal back-off is off on the api tier — decode happens off this machine"
    : baseline === null
      ? `no bench baseline for ${model.key} — thermal back-off is off (sidecrew bench --model ${model.key})`
      : `thermal baseline ${baseline.tok_s} tok/s from ${baseline.source}`);

  sampler.start();

  /** One task, all the way: generate → verify, and once more with the error if that is allowed. */
  const handle = async (task: WorkerTask, worker: WorkerEndpoint): Promise<TaskOutcome> => {
    const startedAt = performance.now();
    const attempts: Attempt[] = [];
    let current = task;
    let reason = "ran out of attempts";
    let threw: string | null = null;

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const candidate = api === null ? await generate(current, worker) : await generateApi(current, api);
        await writeJson(join(runDir, "candidates", `${safeName(current.task_id)}.json`), candidate);

        // Decode rate from the candidate that just arrived, by the same function the bench used.
        if (thermal.observe(decodeTokensPerSecond({ usage: candidate.usage, ...candidate.timing }))) {
          say(`thermal back-off: ${thermal.events.at(-1)!.reason}`);
        }

        const verdict = await verifyCandidate(loaded, candidate, functionOfTaskId(current.task_id), {
          concurrency: concurrency.verifier,
          testTarget: opts.testTarget,
        });
        await writeJson(join(runDir, "verdicts", `${safeName(current.task_id)}.json`), verdict);
        attempts.push({ task: current, candidate, verdict });

        // Read once, from the candidate that just failed, and only when it failed at `pass` — the
        // stage the funnel collapses at, and the only stage where the answer means anything.
        const contradiction = verdict.compile_ok && !verdict.pass_ok
          ? findContradiction(candidate.test_source, functionOfTaskId(current.task_id), {
            projectDir: loaded.projectDir, fileName: loaded.sourceFile,
          })
          : null;
        const decision = shouldRetry(verdict, contradiction);
        reason = decision.reason;
        const willRetry = decision.retry && attempt === 0;
        say(verdict.survived
          ? `${current.task_id}: survived (score ${verdict.mutation?.score.toFixed(2) ?? "—"})`
          : `${current.task_id}: failed at ${verdict.stage_reached} · ${willRetry ? "retrying once" : `escalating — ${decision.reason}`}`);
        if (verdict.survived) { reason = ""; break; }
        if (!decision.retry || attempt === 1) break;

        const name = functionOfTaskId(task.task_id);
        const fn = loaded.plan.functions.find((f) => f.name === name);
        if (fn === undefined) throw new PlanError(`${planPath} plans no function called ${name}`);
        const next = buildTask(loaded, fn, task.shape.kind, {
          attempt: attempt + 1,
          retryOf: task.task_id,
          previousError: truncateError(verdict.error ?? decision.reason),
        });

        // The retry is only worth a verdict if the worker will be told something new (ADR-0022).
        // Generation is deterministic at temperature 0 with a fixed seed, so an identical prompt produces
        // an identical candidate and an identical verdict — the retry would be a guaranteed waste of the
        // most expensive stage in the pipeline. It happens when the verifier had nothing quotable to say.
        if (await promptText(next) === await promptText(current)) {
          reason = `${decision.reason}, and the retry prompt would be byte-identical to the first attempt's — a deterministic worker would return the same candidate (ADR-0022)`;
          say(`${current.task_id}: escalating without spending the retry — ${reason}`);
          break;
        }

        current = next;
        await writeJson(join(runDir, "tasks", `${safeName(current.task_id)}.json`), current);
      }
    } catch (e) {
      if (isFatal(e)) throw e;
      // Not this task's last word in the shape of a Verdict, because there is none — but it is what the
      // escalation carries, and the other nineteen tasks still get to run.
      threw = truncateError(String((e as Error)?.message ?? e));
      reason = `the run threw rather than returning a verdict: ${threw}`;
      say(`${current.task_id}: ${reason}`);
    }

    return {
      task_id: task.task_id,
      attempts,
      latency_ms: performance.now() - startedAt,
      retried: attempts.length > 1,
      reason: reason === "" ? null : reason,
      threw,
    };
  };

  /** One worker, one in-flight request, until the queue is empty (non-negotiable #4). */
  const runner = async (worker: WorkerEndpoint, index: number): Promise<void> => {
    for (;;) {
      // A back-off retires the highest-numbered runner after it finishes what it is holding. Killing an
      // in-flight candidate would throw away a generation that has already been paid for.
      if (index >= thermal.concurrency) {
        say(`worker :${worker.port} standing down — concurrency is now ${thermal.concurrency}`);
        return;
      }
      const task = queue.shift();
      if (task === undefined) return;
      const outcome = await handle(task, worker);
      outcomes.set(task.task_id, outcome);
      if (!survivedOutcome(outcome)) await writeEscalation(runDir, outcome);
    }
  };

  try {
    await Promise.all(slots.slice(0, concurrency.workers).map((w, i) => runner(w, i)));
  } finally {
    sampler.stop();
  }

  if (thermal.events.length > 0) await writeJson(join(runDir, "throttle.json"), backOffRecord(baseline, concurrency.workers, thermal.events));

  const ordered = tasks.map((t) => outcomes.get(t.task_id)).filter((o): o is TaskOutcome => o !== undefined);
  const survivors: BatchResult["survivors"] = [];
  for (const outcome of ordered) {
    const last = outcome.attempts.at(-1);
    if (!survivedOutcome(outcome) || last === undefined) continue;
    const testPath = join(runDir, "tests", `${safeName(outcome.task_id)}${EXTENSION[loaded.plan.language] ?? ".txt"}`);
    await writeFile(testPath, last.candidate.test_source, "utf8");
    survivors.push({ task_id: outcome.task_id, test_path: testPath, mutation_score: last.verdict.mutation?.score ?? 0 });
  }

  const verdicts = ordered.flatMap((o) => o.attempts.map((a) => a.verdict));
  const candidates = ordered.flatMap((o) => o.attempts.map((a) => a.candidate));
  const latencies = ordered.map((o) => o.latency_ms);

  const result = BatchResult.parse({
    run_id: id,
    plan: loaded.planPath,
    config: {
      worker_kind: tier,
      worker_model: api?.model ?? workers[0]!.model,
      concurrency: concurrency.workers,
      retry: 1,
    },
    stats: {
      tasks: tasks.length,
      survived: survivors.length,
      retried: ordered.filter((o) => o.retried).length,
      escalated: ordered.length - survivors.length,
      // The funnel counts *attempts*, not tasks: it is a picture of what the gate rejected and where,
      // and a retry that got further is a fact about the gate worth keeping.
      funnel: {
        compiled: verdicts.filter((v) => v.compile_ok).length,
        passed: verdicts.filter((v) => v.pass_ok).length,
        killed_ge_1: verdicts.filter((v) => (v.mutation?.killed ?? 0) >= 1).length,
        non_tautological: verdicts.filter((v) => !v.tautological).length,
      },
      latency_ms: { median: Math.round(quantile(latencies, 0.5)), p90: Math.round(quantile(latencies, 0.9)) },
      peak_rss_mb: sampler.peakMb,
      // Zero on the local tier because the workers are on localhost, and the schema refuses anything
      // else there. On the api tier it is **what Anthropic billed**, summed from the usage block of
      // every candidate — never an estimate (ADR-0045 §6). `generateApi` refuses a completion whose
      // usage was not measured, so a number that reaches here is one the API reported.
      claude_tokens: {
        planning: loaded.plan.meta.planner_tokens,
        workers: tier === "api" ? billedWorkerTokens(candidates) : 0,
        review: null,
      },
    },
    survivors,
    escalations: ordered
      .filter((o) => !survivedOutcome(o))
      .map((o) => ({ task_id: o.task_id, attempts: attemptErrors(o).map(({ error }) => ({ error })) })),
  });

  await writeJson(join(runDir, "result.json"), result);
  say(`${survivors.length}/${tasks.length} survived · ${result.stats.escalated} escalated · ${join(runDir, "result.json")}`);
  return result;
}

/**
 * A dry run reports what *would* happen: the tasks are real and on disk, and everything measured is
 * zero because nothing ran. It is the cheap way to see a stale plan, a missing exemplar or a
 * concurrency of 1 before spending several minutes finding out.
 */
function dryRunResult(
  id: string,
  loaded: LoadedPlan,
  tasks: WorkerTask[],
  workers: WorkerEndpoint[],
  model: ModelEntry,
  concurrency: ConcurrencyPlan,
  tier: WorkerKind,
  apiModelId: string | null,
): BatchResult {
  return BatchResult.parse({
    run_id: id,
    plan: loaded.planPath,
    config: {
      worker_kind: tier,
      worker_model: apiModelId ?? workers[0]?.model ?? model.repo,
      concurrency: concurrency.workers,
      retry: 1,
    },
    stats: {
      tasks: tasks.length,
      survived: 0,
      retried: 0,
      escalated: 0,
      funnel: { compiled: 0, passed: 0, killed_ge_1: 0, non_tautological: 0 },
      latency_ms: { median: 0, p90: 0 },
      peak_rss_mb: 0,
      claude_tokens: { planning: loaded.plan.meta.planner_tokens, workers: 0, review: null },
    },
    survivors: [],
    escalations: [],
  });
}

/**
 * One attempt → the sentence that explains it, newest last.
 *
 * `verdict.error` when there is one, and the retry rule's reason when there is not — a verdict can fail
 * with nothing quotable (the mutation tool broke, or nothing in the function could be mutated), and an
 * empty string in an escalation is a task Claude cannot act on. A task that threw has no verdict at all
 * and contributes the exception as its last attempt.
 */
const attemptErrors = (o: TaskOutcome): { task_id: string; stage_reached: Verdict["stage_reached"] | null; error: string }[] => {
  const fromVerdicts = o.attempts.map((a) => ({
    task_id: a.task.task_id,
    stage_reached: a.verdict.stage_reached as Verdict["stage_reached"] | null,
    error: truncateError(a.verdict.error ?? shouldRetry(a.verdict).reason),
  }));
  // `null` and not `"compile"`: nothing ran, and naming a stage would read as "it did not compile".
  if (o.threw === null) return fromVerdicts;
  return [...fromVerdicts, { task_id: o.task_id, stage_reached: null, error: o.threw }];
};

/** Append the queue line for a task that gave up (ADR-0023). */
const writeEscalation = async (runDir: string, o: TaskOutcome): Promise<void> => {
  const attempts = attemptErrors(o);
  const escalation: Escalation = {
    task_id: o.task_id,
    reason: o.reason ?? "ran out of attempts",
    // `min(1)` in the contract, and an outcome with no attempts is exactly the case the exception path
    // produces — `attemptErrors` has already appended the exception, so this only fires for an empty
    // outcome that somehow has neither.
    attempts: attempts.length > 0 ? attempts : [{ task_id: o.task_id, stage_reached: null, error: o.reason ?? "no attempt was recorded" }],
    escalated_at: new Date().toISOString(),
  };
  await appendEscalation(runDir, escalation);
};

const backOffRecord = (
  baseline: { tok_s: number; source: string } | null,
  startedAt: number,
  events: BackOff[],
): unknown => ({
  baseline_tok_s: baseline?.tok_s ?? null,
  baseline_source: baseline?.source ?? null,
  concurrency_at_start: startedAt,
  concurrency_at_end: events.at(-1)?.to ?? startedAt,
  events,
});

const writeJson = async (path: string, value: unknown): Promise<void> =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
