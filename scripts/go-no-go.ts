// The go/no-go experiment (Phase 6). Protocol: `experiments/go-no-go/README.md`, frozen before the run.
//
//   npx tsx scripts/go-no-go.ts --config c2  --fixture ts
//   npx tsx scripts/go-no-go.ts --config c1  --fixture swift
//   npx tsx scripts/go-no-go.ts --config c3  --fixture ts --emit-tasks   # hand these to the agent
//   npx tsx scripts/go-no-go.ts --config c3  --fixture ts --verify       # verify what it wrote
//   npx tsx scripts/go-no-go.ts --report                                 # merge partials → results JSON
//
// One question: does a local 7B behind the verifier reach Haiku's survival rate at zero worker tokens?
// Everything here exists to make the three configurations differ in **one** thing — which model wrote
// the candidate — and nothing else.
//
// Held constant across configurations, deliberately:
//
//   * **The tasks.** The same `WorkerTask`s, built once per fixture from the Phase 5 plans. Not
//     rebuilt per configuration: `buildTasks` is deterministic, but a plan re-read between two
//     configurations is a plan that could have changed between them.
//   * **The prompt.** `src/prompts/worker.md`, the shipped one, for every configuration including the
//     agent — `claude/agents/haiku-worker.md` says "you will be given a WorkerTask", and the fair
//     comparison hands Haiku the same rendered prompt the 7B gets rather than a better one.
//   * **The verifier, at concurrency 1.** A Stryker run that shares cores with itself differently
//     between configurations would put noise straight into the column being read.
//   * **The retry policy.** One retry with the error appended, and `shouldRetry`'s two exemptions
//     (ADR-0012, ADR-0005) — the production rule from `src/batch.ts`, not a copy of it.
//   * **One in-flight request.** Non-negotiable #4, and the only way the latency numbers mean anything.
//
// The funnel is reported over **tasks**, at each task's final attempt, because `survivors / tasks` is
// the decision rule's S(x) and a funnel counted over attempts does not add up to it. `attempts` is
// reported separately, for the same reason `BatchResult` counts it that way.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { discoverWorkers, extractTestSource, generate, PoolRss, RUN_SEED, MAX_TEST_TOKENS, GENERATE_TIMEOUT_MS, shouldRetry, type WorkerEndpoint } from "../src/batch.js";
import { readMemory } from "../src/doctor.js";
import { buildPrompt } from "../src/prompt.js";
import { buildTask, buildTasks, functionOfTaskId, loadPlan, staleFunctions, verifyCandidate, type LoadedPlan } from "../src/plan.js";
import { assertLocalTier, complete, type Completion, type Message } from "../src/worker.js";
import { run } from "../src/exec.js";
import { safeName, truncateError } from "../src/verifier/shared.js";
import { Candidate, type Verdict, type WorkerTask } from "../src/schemas.js";

const RESULTS = "experiments/go-no-go/results";

/** The eight cells the protocol defines. Anything else in `partials/` is a tagged re-measurement. */
const FROZEN_CELL = /^(c1|c2|c2b|c3)-(ts|swift)\.json$/;
/** Where C3's handshake lives: tasks out, candidates in. Not under `.sidecrew/`, because it is kept. */
const C3_DIR = "experiments/go-no-go/c3";
/** Raw worker output, one file per configuration × task × attempt. Never shown to Claude as review. */
const CANDIDATES = "experiments/go-no-go/candidates";

const FIXTURES = {
  ts: {
    language: "typescript",
    plans: ["strings", "numbers", "arrays", "async"].map((m) => `fixtures/ts-fixture/plans/${m}/test_plan.json`),
    ext: ".test.ts",
  },
  swift: {
    language: "swift",
    plans: ["Strings", "Numbers", "Arrays", "Machine", "Async"].map((m) => `fixtures/swift-fixture/plans/${m}/test_plan.json`),
    ext: ".swift",
  },
} as const;
type FixtureId = keyof typeof FIXTURES;

const CONFIGS = {
  c1: { label: "Apple Foundation Models (~3B, on-device)", kind: "http", port: 8001, model: "apple-on-device" },
  c2: { label: "Qwen2.5-Coder-7B-Instruct-4bit", kind: "http", port: 8000, model: null },
  c2b: { label: "Qwen2.5-Coder-14B-Instruct-4bit", kind: "http", port: 8000, model: null },
  c3: { label: "Claude Haiku via the haiku-worker agent", kind: "agent", port: null, model: null },
} as const;
type ConfigId = keyof typeof CONFIGS;

// ── cli ───────────────────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const has = (name: string): boolean => argv.includes(name);
const say = (line: string): void => { process.stderr.write(`${line}\n`); };

const quantile = (values: number[], q: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0;
};

/**
 * What the machine was doing while the numbers were taken.
 *
 * `peak_rss_mb` on its own is not a memory measurement on a machine under pressure — ADR-0011: macOS
 * compresses and pages out, and RSS *falls* while the machine thrashes. So the swap counter is read
 * either side of every run, and what was open is recorded rather than assumed. The protocol asks for
 * Xcode and a simulator to be open; whether they were is a field here, not a claim in the report.
 */
interface MachineState { free_gb: number | null; swap_used_mb: number | null; xcode_open: boolean; simulator_open: boolean }

async function machineState(): Promise<MachineState> {
  const mem = await readMemory();
  let swap: number | null = null;
  try {
    const r = await run("sysctl", ["-n", "vm.swapusage"], { timeoutMs: 5_000 });
    const used = /used\s*=\s*([\d.]+)M/.exec(r.stdout);
    swap = used ? Number(used[1]) : null;
  } catch {
    swap = null;
  }
  const running = async (pattern: string): Promise<boolean> => {
    try {
      const r = await run("pgrep", ["-f", pattern], { timeoutMs: 5_000 });
      return r.stdout.trim().length > 0;
    } catch {
      return false;
    }
  };
  return {
    free_gb: mem?.free_gb ?? null,
    swap_used_mb: swap,
    xcode_open: await running("/Applications/Xcode.app/Contents/MacOS/Xcode"),
    simulator_open: await running("Simulator.app/Contents/MacOS/Simulator"),
  };
}

const version = async (cmd: string, args: string[]): Promise<string> => {
  try {
    const r = await run(cmd, args, { timeoutMs: 20_000 });
    return `${r.stdout}${r.stderr}`.trim().split("\n")[0] ?? "";
  } catch {
    return "unknown";
  }
};

// ── the inputs, built once ────────────────────────────────────────────────────────────────────────

interface Loaded {
  plans: LoadedPlan[];
  tasks: { task: WorkerTask; plan: LoadedPlan }[];
}

async function loadFixture(id: FixtureId): Promise<Loaded> {
  const plans: LoadedPlan[] = [];
  const tasks: { task: WorkerTask; plan: LoadedPlan }[] = [];
  for (const path of FIXTURES[id].plans) {
    const plan = await loadPlan(path);
    // The same check `sidecrew run` makes before the first token: a stale line_range mutates the wrong
    // lines and the verdict would be about code nobody asked to test (ADR-0013).
    const stale = staleFunctions(plan.plan, plan.source);
    if (stale.length > 0) throw new Error(`${path} is stale: ${stale.map((s) => s.name).join(", ")}`);
    plans.push(plan);
    for (const task of buildTasks(plan)) tasks.push({ task, plan });
  }
  return { plans, tasks };
}

// ── generation ────────────────────────────────────────────────────────────────────────────────────

interface Generated {
  candidate: Candidate;
  generate_ms: number;
  /** False when the server sent no usage block, so the token counts are not measurements. */
  usage_measured: boolean;
  /** Set when generation failed outright — a context overflow, a refusal, a dead shim. */
  error?: string;
}

/**
 * C1's generation path, and the two places it differs from the shipped one. Both differences are the
 * shim's, not the model's, and neither touches the prompt, the seed, the temperature or max_tokens.
 *
 * **1. It does not stream.** `src/worker.ts` streams, for TTFT. Measured against
 * `@meridius-labs/apple-on-device-ai` 1.6.2: its streaming endpoint emits no content deltas at all —
 * one `{"delta":{},"finish_reason":"stop"}` frame and `[DONE]`, raw bytes in the results file — so
 * every C1 candidate came back as the empty string and the determinism check passed 3/3 on nothing.
 * The same prompt on the same shim's non-streaming endpoint returns a complete test file. A worker
 * that returns nothing is not a measurement of Apple Foundation Models, so C1 asks for the whole
 * answer at once. The cost is that **C1 has no TTFT**: `ttft_ms` equals `wall_ms` and says so.
 *
 * **2. It tolerates a missing usage block.** `generate` refuses one, because recording an estimate as
 * a measurement would put a fiction into `Candidate.usage`. This shim is worse than absent: it sends
 * `{prompt_tokens: 0, completion_tokens: 0}`, a fiction that sails straight past that guard. So zeros
 * are treated as "not measured" here, and C1's token columns are null rather than zero.
 */
async function generateTolerant(task: WorkerTask, worker: WorkerEndpoint): Promise<Generated> {
  const t0 = performance.now();
  const messages = await buildPrompt(task);
  const completion = await completeUnstreamed(worker, messages);
  const candidate = Candidate.parse({
    task_id: task.task_id,
    // `seed` records what was *sent*. The shim accepts the field and Apple's API has no seed to pass
    // it to; C1's determinism is therefore measured (`--determinism`) rather than assumed.
    worker: { kind: "local", model: worker.model, revision: worker.revision, temperature: 0, seed: RUN_SEED },
    test_source: extractTestSource(completion.text),
    usage: { prompt_tokens: completion.usage.prompt_tokens, completion_tokens: completion.usage.completion_tokens },
    timing: { ttft_ms: completion.ttft_ms, wall_ms: completion.wall_ms },
  });
  return {
    candidate,
    generate_ms: performance.now() - t0,
    // A shim that reports 0/0 for a 400-token answer has not measured anything.
    usage_measured: !completion.usage_estimated && completion.usage.completion_tokens > 0,
  };
}

/**
 * One chat completion, asked for whole. Only C1 uses it, and only because that shim cannot stream.
 *
 * Deliberately not a branch inside `src/worker.ts`: the shipped client streams because TTFT is a
 * number the project reports, and growing a production code path to accommodate an experiment's
 * third-party shim would put the shim's bug in the product. `assertLocalTier` is still the gate — the
 * zero-worker-tokens guarantee does not get a side door for an experiment.
 */
async function completeUnstreamed(worker: WorkerEndpoint, messages: Message[]): Promise<Completion> {
  assertLocalTier(worker.baseUrl);
  const startedAt = performance.now();
  const res = await fetch(`${worker.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: worker.modelArg,
      messages,
      temperature: 0,
      seed: RUN_SEED,
      max_tokens: MAX_TEST_TOKENS,
    }),
    signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`worker returned HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 512)}`);
  }
  const body = (await res.json()) as {
    choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  };
  const wall_ms = performance.now() - startedAt;
  const choice = body.choices?.[0];
  const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    text,
    usage: { prompt_tokens: n(body.usage?.prompt_tokens), completion_tokens: n(body.usage?.completion_tokens) },
    usage_estimated: body.usage === undefined,
    wall_ms,
    // There is no first-token event in a non-streamed answer, and inventing one would be a number
    // about our own parser rather than about the worker.
    ttft_ms: wall_ms,
    finish_reason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
  };
}

async function generateProduction(task: WorkerTask, worker: WorkerEndpoint): Promise<Generated> {
  const t0 = performance.now();
  const candidate = await generate(task, worker);
  return { candidate, generate_ms: performance.now() - t0, usage_measured: true };
}

// ── outcomes ──────────────────────────────────────────────────────────────────────────────────────

interface AttemptRecord {
  task_id: string;
  attempt: number;
  survived: boolean;
  stage_reached: string;
  compile_ok: boolean;
  pass_ok: boolean;
  tautological: boolean;
  killed: number;
  mutation_score: number | null;
  mutants: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  generate_ms: number;
  verify_ms: number;
  error: string | null;
}

interface TaskRecord {
  task_id: string;
  function: string;
  shape: string;
  survived: boolean;
  retried: boolean;
  escalated: boolean;
  escalation_reason: string | null;
  latency_ms: number;
  attempts: AttemptRecord[];
}

const summarise = (records: TaskRecord[]): Record<string, unknown> => {
  const finals = records.map((r) => r.attempts.at(-1)).filter((a): a is AttemptRecord => a !== undefined);
  const survivors = records.filter((r) => r.survived);
  const latencies = records.map((r) => r.latency_ms);
  const gen = records.flatMap((r) => r.attempts.map((a) => a.generate_ms));
  const ver = records.flatMap((r) => r.attempts.map((a) => a.verify_ms));
  const scores = survivors.map((r) => r.attempts.at(-1)?.mutation_score ?? 0);
  const completion = records.flatMap((r) => r.attempts.map((a) => a.completion_tokens)).filter((n): n is number => n !== null);

  return {
    tasks: records.length,
    survived: survivors.length,
    survival_rate: records.length === 0 ? 0 : Number((survivors.length / records.length).toFixed(3)),
    // Over tasks, at each task's final attempt — so the last column is the survivor count.
    funnel: {
      tasks: records.length,
      compiled: finals.filter((a) => a.compile_ok).length,
      passed: finals.filter((a) => a.pass_ok).length,
      killed_ge_1: finals.filter((a) => a.killed >= 1).length,
      non_tautological: finals.filter((a) => a.killed >= 1 && !a.tautological).length,
    },
    attempts: records.reduce((n, r) => n + r.attempts.length, 0),
    retried: records.filter((r) => r.retried).length,
    escalated: records.filter((r) => r.escalated).length,
    latency_ms: { median: Math.round(quantile(latencies, 0.5)), p90: Math.round(quantile(latencies, 0.9)) },
    generate_ms: { median: Math.round(quantile(gen, 0.5)), p90: Math.round(quantile(gen, 0.9)) },
    verify_ms: { median: Math.round(quantile(ver, 0.5)), p90: Math.round(quantile(ver, 0.9)) },
    median_mutation_score_of_survivors: survivors.length === 0 ? null : Number(quantile(scores, 0.5).toFixed(3)),
    median_completion_tokens: completion.length === 0 ? null : quantile(completion, 0.5),
    failure_stages: finals.filter((a) => !a.survived).reduce<Record<string, number>>((acc, a) => {
      const key = a.error?.startsWith("GENERATION FAILED") ? "generation" : a.stage_reached;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
  };
};

/**
 * End to end for one task: generation plus verification, summed over every attempt it took.
 *
 * Summed rather than wall-clocked, and the same definition for all three configurations — C3's
 * generation happens in a subagent before the verifier ever runs, so a wall clock taken around the
 * verify pass would report C3 as the *fastest* configuration by leaving its generation out entirely.
 * That is the number the decision rule's L(x) reads, so it is defined once here and not per branch.
 */
const recordOf = (task: WorkerTask, attempts: AttemptRecord[]): TaskRecord => {
  const last = attempts.at(-1)!;
  const latency = attempts.reduce((n, a) => n + a.generate_ms + a.verify_ms, 0);
  return {
    task_id: task.task_id,
    function: functionOfTaskId(task.task_id),
    shape: task.shape.kind,
    survived: last.survived,
    retried: attempts.length > 1,
    escalated: !last.survived,
    escalation_reason: last.survived ? null : shouldRetryReason(last),
    latency_ms: Math.round(latency),
    attempts,
  };
};

const shouldRetryReason = (a: AttemptRecord): string =>
  a.error?.startsWith("GENERATION FAILED") ? "generation failed" : `failed at ${a.stage_reached}`;

const attemptOf = (
  task: WorkerTask,
  attempt: number,
  g: Generated | null,
  verdict: Verdict | null,
  verify_ms: number,
  error: string | null,
): AttemptRecord => ({
  task_id: task.task_id,
  attempt,
  survived: verdict?.survived ?? false,
  stage_reached: verdict?.stage_reached ?? "compile",
  compile_ok: verdict?.compile_ok ?? false,
  pass_ok: verdict?.pass_ok ?? false,
  tautological: verdict?.tautological ?? false,
  killed: verdict?.mutation?.killed ?? 0,
  mutation_score: verdict?.mutation?.score ?? null,
  mutants: verdict?.mutation
    ? verdict.mutation.killed + verdict.mutation.survived + verdict.mutation.timeout + verdict.mutation.no_coverage
    : 0,
  prompt_tokens: g?.usage_measured ? g.candidate.usage.prompt_tokens : null,
  completion_tokens: g?.usage_measured ? g.candidate.usage.completion_tokens : null,
  generate_ms: Math.round(g?.generate_ms ?? 0),
  verify_ms: Math.round(verify_ms),
  error: error ?? truncateError(verdict?.error ?? "") ?? null,
});

// ── the http configurations (C1, C2, C2b) ─────────────────────────────────────────────────────────

async function runHttp(config: ConfigId, fixture: FixtureId): Promise<void> {
  const spec = CONFIGS[config];
  const { plans, tasks } = await loadFixture(fixture);
  say(`${config} · ${fixture}: ${tasks.length} tasks over ${plans.length} plans`);

  let worker: WorkerEndpoint;
  if (config === "c1") {
    // The shim is not a sidecrew worker and has no record on disk; it is described rather than probed.
    worker = {
      port: spec.port!, baseUrl: `http://127.0.0.1:${spec.port}/v1`, record: null,
      modelArg: spec.model!, model: "apple-on-device (Apple Foundation Models)", revision: "",
    };
  } else {
    const found = await discoverWorkers([spec.port!]);
    const w = found[0];
    if (w === undefined) throw new Error(`no worker on port ${spec.port} — start one with: sidecrew serve`);
    worker = w;
  }
  say(`worker ${worker.model} @ ${worker.revision.slice(0, 12) || "unpinned"} on ${worker.baseUrl}`);

  // Tagged here too, and for the same reason the partial is: the raw candidates are the frozen run's
  // evidence, and a re-measurement that overwrites them leaves a results file describing output nobody
  // can look at any more. (Found the hard way — the first tagged run clobbered them.)
  const runTag = flag("--tag");
  const dir = join(CANDIDATES, `${config}-${fixture}${runTag === undefined ? "" : `-${runTag}`}`);
  await mkdir(dir, { recursive: true });
  const before = await machineState();
  const sampler = new PoolRss(worker.record ? [worker.record.pid] : []);
  sampler.start();

  const records: TaskRecord[] = [];
  for (const { task, plan } of tasks) {
    const attempts: AttemptRecord[] = [];
    let current = task;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let g: Generated | null = null;
      let verdict: Verdict | null = null;
      let verify_ms = 0;
      let error: string | null = null;

      try {
        g = config === "c1" ? await generateTolerant(current, worker) : await generateProduction(current, worker);
        await writeFile(join(dir, `${safeName(current.task_id)}${FIXTURES[fixture].ext}`), g.candidate.test_source, "utf8");
      } catch (e) {
        // A worker that cannot answer is a failure of the configuration, not a crash of the experiment
        // — C1 is expected to hit exactly this on context, and the protocol says log it, not work
        // around it.
        error = `GENERATION FAILED: ${truncateError(String((e as Error).message ?? e))}`;
      }

      if (g !== null) {
        const t = performance.now();
        try {
          verdict = await verifyCandidate(plan, g.candidate, functionOfTaskId(current.task_id), { concurrency: 1 });
        } catch (e) {
          error = `VERIFIER FAILED: ${truncateError(String((e as Error).message ?? e))}`;
        }
        verify_ms = performance.now() - t;
      }

      attempts.push(attemptOf(current, attempt, g, verdict, verify_ms, error));
      const last = attempts.at(-1)!;
      say(`  ${last.survived ? "survived" : `failed  ${error ? "generation" : last.stage_reached}`.padEnd(8)}  ${current.task_id}`);

      if (verdict?.survived) break;
      // A generation failure gets the retry (the transport, or the context, may not fail twice);
      // a verdict decides for itself, by the production rule.
      const retry = verdict === null ? { retry: error?.startsWith("VERIFIER FAILED") !== true, reason: "generation failed" } : shouldRetry(verdict);
      if (!retry.retry || attempt === 1) break;

      const fn = plan.plan.functions.find((f) => f.name === functionOfTaskId(task.task_id));
      if (fn === undefined) throw new Error(`plan has no function ${functionOfTaskId(task.task_id)}`);
      current = buildTask(plan, fn, task.shape.kind, {
        attempt: attempt + 1,
        retryOf: task.task_id,
        previousError: truncateError(verdict?.error ?? error ?? retry.reason),
      });
    }

    records.push(recordOf(task, attempts));
  }
  sampler.stop();

  await writePartial(config, fixture, records, {
    worker: { model: worker.model, revision: worker.revision, base_url: worker.baseUrl },
    // Sampled from the worker process only. On C1 there is no worker process to sample: the shim is a
    // node server and Apple's model runs in a system daemon, so the number would be about the wrong
    // process — null says that, 0 would not.
    peak_worker_rss_mb: worker.record ? sampler.peakMb : null,
    machine_before: before,
    machine_after: await machineState(),
  });
}

// ── C3: the agent handshake ───────────────────────────────────────────────────────────────────────
//
// The agent is not a process this script can call, so C3 runs in two halves with files between them —
// which is what the rest of the pipeline does anyway (CLAUDE.md: files are the IPC where possible).
// `--emit-tasks` writes the rendered prompt and the task; the agent writes a candidate next to it;
// `--verify` grades them and, for the failures the production rule says deserve it, emits the retry
// task with the error already in the prompt.

const c3dir = (fixture: FixtureId, sub: string): string => join(C3_DIR, fixture, sub);

async function emitTasks(fixture: FixtureId, retryOf?: TaskRecord[]): Promise<void> {
  const { tasks, plans } = await loadFixture(fixture);
  await mkdir(c3dir(fixture, "tasks"), { recursive: true });
  await mkdir(c3dir(fixture, "prompts"), { recursive: true });
  await mkdir(c3dir(fixture, "candidates"), { recursive: true });

  const wanted: WorkerTask[] = [];
  if (retryOf === undefined) {
    wanted.push(...tasks.map((t) => t.task));
  } else {
    for (const rec of retryOf) {
      const found = tasks.find((t) => t.task.task_id === rec.task_id);
      if (found === undefined) continue;
      const fn = found.plan.plan.functions.find((f) => f.name === rec.function);
      if (fn === undefined) continue;
      wanted.push(buildTask(found.plan, fn, found.task.shape.kind, {
        attempt: 1,
        retryOf: rec.task_id,
        previousError: rec.attempts.at(-1)?.error ?? "failed",
      }));
    }
  }

  for (const task of wanted) {
    await writeFile(join(c3dir(fixture, "tasks"), `${safeName(task.task_id)}.json`), `${JSON.stringify(task, null, 2)}\n`, "utf8");
    const messages = await buildPrompt(task);
    await writeFile(join(c3dir(fixture, "prompts"), `${safeName(task.task_id)}.md`), messages[0]!.content, "utf8");
  }
  say(`${wanted.length} task${wanted.length === 1 ? "" : "s"} → ${c3dir(fixture, "prompts")}`);
  say(`the agent writes its file to ${c3dir(fixture, "candidates")}/<task-id>${FIXTURES[fixture].ext}`);
  void plans;
}

/**
 * What the harness reported for one agent invocation.
 *
 * `agent_tokens` is the Agent tool's own `subagent_tokens` — one number, no prompt/completion split
 * and no cache breakdown, so it cannot be put in `Candidate.usage` without inventing the halves. It is
 * summed into `claude_tokens.workers` instead, where a total is the honest shape, and the per-candidate
 * token columns stay null for C3 rather than carrying a guess.
 */
interface AgentTiming { task_id: string; generate_ms: number; agent_tokens?: number; prompt_tokens?: number; completion_tokens?: number }

/**
 * Verify whatever the agent has written. Returns the tasks whose failure earns the one retry, so the
 * caller can emit those and come back.
 */
async function verifyC3(fixture: FixtureId): Promise<void> {
  const { tasks, plans } = await loadFixture(fixture);
  void plans;
  const ext = FIXTURES[fixture].ext;
  const timingPath = join(C3_DIR, fixture, "timings.json");
  const timings: AgentTiming[] = existsSync(timingPath)
    ? (JSON.parse(await readFile(timingPath, "utf8")) as AgentTiming[])
    : [];
  const timingOf = (id: string): AgentTiming | undefined => timings.find((t) => t.task_id === id);

  const present = new Set(await readdir(c3dir(fixture, "candidates")).catch(() => []));
  const records: TaskRecord[] = [];
  const needRetry: TaskRecord[] = [];

  for (const { task, plan } of tasks) {
    const attempts: AttemptRecord[] = [];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const id = attempt === 0 ? task.task_id : `${functionOfTaskId(task.task_id)}:${task.shape.kind}:1`;
      const file = `${safeName(id)}${ext}`;
      if (!present.has(file)) break;

      const source = extractTestSource(await readFile(join(c3dir(fixture, "candidates"), file), "utf8"));
      const t = timingOf(id);
      const candidate = Candidate.parse({
        task_id: id,
        // `api`: the tokens were spent at Anthropic, which is what ADR-0009's tier means and what
        // `BatchResult`'s refinement is there to keep honest. No seed exists on that tier.
        worker: { kind: "api", model: "claude-haiku-4-5", revision: "", temperature: 0, seed: null },
        test_source: source,
        usage: { prompt_tokens: t?.prompt_tokens ?? 0, completion_tokens: t?.completion_tokens ?? 0 },
        timing: { ttft_ms: 0, wall_ms: t?.generate_ms ?? 0 },
      });

      const v0 = performance.now();
      let verdict: Verdict | null = null;
      let error: string | null = null;
      try {
        verdict = await verifyCandidate(plan, candidate, functionOfTaskId(task.task_id), { concurrency: 1 });
      } catch (e) {
        error = `VERIFIER FAILED: ${truncateError(String((e as Error).message ?? e))}`;
      }
      const verify_ms = performance.now() - v0;

      attempts.push({
        ...attemptOf(task, attempt, { candidate, generate_ms: t?.generate_ms ?? 0, usage_measured: t?.completion_tokens !== undefined }, verdict, verify_ms, error),
        task_id: id,
      });
      say(`  ${verdict?.survived ? "survived" : `failed  ${verdict?.stage_reached ?? "?"}`.padEnd(8)}  ${id}`);
      if (verdict?.survived || attempt === 1) break;
      if (verdict === null || !shouldRetry(verdict).retry) break;
    }

    if (attempts.length === 0) {
      say(`  MISSING   ${task.task_id}`);
      continue;
    }
    const record = recordOf(task, attempts);
    records.push(record);
    const last = attempts.at(-1)!;
    if (!last.survived && attempts.length === 1 && !present.has(`${safeName(`${record.function}:${record.shape}:1`)}${ext}`)) {
      needRetry.push(record);
    }
  }

  await writePartial("c3", fixture, records, {
    worker: { model: "claude-haiku-4-5", revision: "", base_url: "haiku-worker agent (Claude Code subagent)" },
    peak_worker_rss_mb: null,
    machine_after: await machineState(),
    claude_tokens_workers: timings.reduce((n, t) => n + (t.agent_tokens ?? 0), 0),
    agent_invocations: timings.length,
  });

  if (needRetry.length > 0) {
    await emitTasks(fixture, needRetry);
    say(`\n${needRetry.length} task${needRetry.length === 1 ? "" : "s"} earned the retry — prompts written; rerun --verify once the agent has answered them`);
  }
}

// ── partials, and the report ──────────────────────────────────────────────────────────────────────

async function writePartial(
  config: ConfigId,
  fixture: FixtureId,
  records: TaskRecord[],
  extra: Record<string, unknown>,
): Promise<void> {
  await mkdir(join(RESULTS, "partials"), { recursive: true });
  const mem = await readMemory();
  const { plans } = await loadFixture(fixture);
  const body = {
    measured: true,
    config,
    config_label: CONFIGS[config].label,
    fixture,
    language: FIXTURES[fixture].language,
    measured_at: new Date().toISOString(),
    free_gb_at_start: mem?.free_gb ?? null,
    ...extra,
    ...summarise(records),
    claude_tokens: {
      // Shared by construction: the same plans, the same `meta.planner_tokens`, for every
      // configuration. The README says why this number is an upper bound and not comparable between
      // the two fixtures.
      planning: plans.reduce((n, p) => n + p.plan.meta.planner_tokens, 0),
      workers: (extra.claude_tokens_workers as number | undefined) ?? (config === "c3" ? null : 0),
      review: null,
    },
    records,
  };
  // A tag keeps a re-measurement beside the frozen record instead of on top of it: `--report` and
  // `--recompute` read only the untagged cells, so a follow-up run (a prompt change, a second machine)
  // cannot quietly rewrite the verdict the experiment was frozen to produce.
  const tag = flag("--tag");
  const path = join(RESULTS, "partials", `${config}-${fixture}${tag === undefined ? "" : `-${tag}`}.json`);
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  const s = summarise(records) as { survived: number; tasks: number; funnel: Record<string, number>; latency_ms: { median: number } };
  say(`\n${config}/${fixture}: ${s.survived}/${s.tasks} survived · compiled ${s.funnel.compiled} → passed ${s.funnel.passed} → killed≥1 ${s.funnel.killed_ge_1} → non-taut ${s.funnel.non_tautological} · ${s.latency_ms.median} ms median`);
  say(`wrote ${path}`);
}

/**
 * Re-derive every partial's summary from the attempts it already holds.
 *
 * Not a rerun. A partial records `generate_ms` and `verify_ms` per attempt — those are measurements,
 * taken once — so when the *definition* of an aggregate changes (it did: end-to-end latency is now the
 * sum of a task's attempts rather than a wall clock taken around the verify pass, which left C3's
 * generation out of C3's latency), the fix is arithmetic on numbers already measured. Re-running the
 * verifier to get the same survival with noisier timings would be the less accurate option, not the
 * more rigorous one.
 */
async function recompute(): Promise<void> {
  const dir = join(RESULTS, "partials");
  for (const file of (await readdir(dir)).filter((f) => FROZEN_CELL.test(f))) {
    const path = join(dir, file);
    const body = JSON.parse(await readFile(path, "utf8")) as { records: TaskRecord[] } & Record<string, unknown>;
    const records = body.records.map((r) => ({
      ...r,
      latency_ms: Math.round(r.attempts.reduce((n, a) => n + a.generate_ms + a.verify_ms, 0)),
    }));
    const { records: _drop, ...rest } = body;
    await writeFile(path, `${JSON.stringify({ ...rest, ...summarise(records), records }, null, 2)}\n`, "utf8");
    const s = summarise(records) as { survived: number; tasks: number; latency_ms: { median: number } };
    say(`${file}: ${s.survived}/${s.tasks} · ${s.latency_ms.median} ms median end to end`);
  }
}

async function report(): Promise<void> {
  const dir = join(RESULTS, "partials");
  const files = (await readdir(dir)).filter((f) => FROZEN_CELL.test(f)).sort();
  const partials = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), "utf8")) as Record<string, unknown>));
  const mem = await readMemory();

  const rate = (config: string, fixture: string): number | null => {
    const p = partials.find((x) => x.config === config && x.fixture === fixture);
    return p === undefined ? null : (p.survival_rate as number);
  };
  const latency = (config: string, fixture: string): number | null => {
    const p = partials.find((x) => x.config === config && x.fixture === fixture);
    return p === undefined ? null : ((p.latency_ms as { median: number }).median);
  };

  const score = (config: string, fixture: string): number | null => {
    const p = partials.find((x) => x.config === config && x.fixture === fixture);
    return p === undefined ? null : (p.median_mutation_score_of_survivors as number | null);
  };

  // The rule, applied per fixture and never averaged across them (ADR-0018).
  //
  // The fourth cell — in the band, with the 14B failing to rescue it — is the README's dated amendment
  // and ADR-0020: **conditional go**, guarded by the mutation score of the survivors. Survival rate
  // alone scores a test that agrees with the bug above one that catches it, which is not a hypothetical
  // (C3's `truncate:boundary`, 2026-09-14). The guard is "not below the control", so the band cell can
  // still come out a no-go on a run where the local tier is both rarer and blunter.
  const decision = (["ts", "swift"] as const).map((fixture) => {
    const s2 = rate("c2", fixture);
    const s3 = rate("c3", fixture);
    const s2b = rate("c2b", fixture);
    const l2 = latency("c2", fixture);
    const l3 = latency("c3", fixture);
    const m2 = score("c2", fixture);
    const m3 = score("c3", fixture);
    if (s2 === null || s3 === null) return { fixture, verdict: "not measured" as const };
    const ratio = s3 === 0 ? null : Number((s2 / s3).toFixed(3));
    const latency_ok = l2 !== null && l3 !== null ? l2 <= l3 : null;
    // Unknown scores do not fail the guard — they leave it unevaluated, and the verdict says so.
    const score_ok = m2 !== null && m3 !== null ? m2 >= m3 : null;
    let verdict: string;
    if (s2 >= 0.9 * s3 && latency_ok === true) verdict = "go";
    else if (s2 >= 0.9 * s3) verdict = "accuracy clears the bar; latency does not";
    else if (s2 >= 0.75 * s3) {
      if (s2b !== null && s2b >= 0.9 * s3) verdict = "go-with-14b";
      else if (score_ok === false) verdict = "no-go (revisit): in the band and blunter than the control";
      else if (score_ok === null) verdict = "conditional go (mutation-score guard not evaluated)";
      else verdict = "conditional go";
    } else verdict = "no-go (revisit)";
    return {
      fixture, s_c2: s2, s_c3: s3, s_c2b: s2b, ratio,
      l_c2_ms: l2, l_c3_ms: l3, latency_ok,
      mutation_score_c2: m2, mutation_score_c3: m3, score_ok,
      verdict,
    };
  });

  const result = {
    measured: true,
    experiment: "go-no-go",
    protocol: "experiments/go-no-go/README.md",
    date: new Date().toISOString(),
    machine: {
      host: hostname(),
      total_gb: mem?.total_gb ?? null,
      free_gb_at_report: mem?.free_gb ?? null,
      macos: await version("sw_vers", ["-productVersion"]),
      node: process.version,
      mlx_lm: await version("python3", ["-c", "import mlx_lm; print(mlx_lm.__version__)"]),
      swift: await version("swift", ["--version"]),
      muter: await version("muter", ["--version"]),
    },
    held_constant: [
      "the same WorkerTasks per fixture, built once from the Phase 5 plans",
      "the shipped worker prompt (src/prompts/worker.md) for every configuration, the agent included",
      "verifier concurrency 1, one worker, one in-flight request",
      "one retry with the error appended, and shouldRetry's two exemptions (ADR-0012, ADR-0005)",
      "temperature 0; seed 42 wherever a seed exists",
    ],
    decision,
    configs: partials,
  };

  const date = new Date().toISOString().slice(0, 10);
  const path = `${RESULTS}/go-no-go-${date}.json`;
  if (existsSync(path) && !has("--force")) {
    throw new Error(`${path} already exists — pass --force to overwrite (sidecrew bench refuses for the same reason)`);
  }
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  say(`wrote ${path}`);
  for (const d of decision) say(`${d.fixture}: ${JSON.stringify(d)}`);
}

// ── determinism, for the configurations that claim it ─────────────────────────────────────────────

async function determinism(config: ConfigId, fixture: FixtureId, times = 3): Promise<void> {
  const { tasks } = await loadFixture(fixture);
  const task = tasks[0]!.task;
  const worker: WorkerEndpoint = config === "c1"
    ? { port: 8001, baseUrl: "http://127.0.0.1:8001/v1", record: null, modelArg: "apple-on-device", model: "apple-on-device", revision: "" }
    : (await discoverWorkers([CONFIGS[config].port!]))[0]!;
  const outputs: string[] = [];
  for (let i = 0; i < times; i += 1) {
    const g = await generateTolerant(task, worker);
    outputs.push(g.candidate.test_source);
    say(`  ${i + 1}: ${g.candidate.test_source.length} chars, ${Math.round(g.generate_ms)} ms`);
  }
  const identical = outputs.every((o) => o === outputs[0]);
  say(`${config}: ${identical ? `${times}/${times} byte-identical` : "NOT deterministic"} on ${task.task_id}`);
  await mkdir(join(RESULTS, "partials"), { recursive: true });
  await writeFile(
    join(RESULTS, "partials", `determinism-${config}.json`),
    `${JSON.stringify({ measured: true, config, task_id: task.task_id, runs: times, identical, lengths: outputs.map((o) => o.length) }, null, 2)}\n`,
    "utf8",
  );
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (has("--recompute")) return recompute();
  if (has("--report")) return report();
  const config = (flag("--config") ?? "") as ConfigId;
  const fixture = (flag("--fixture") ?? "") as FixtureId;
  if (!(config in CONFIGS)) throw new Error(`--config must be one of ${Object.keys(CONFIGS).join(", ")}`);
  if (!(fixture in FIXTURES)) throw new Error(`--fixture must be one of ${Object.keys(FIXTURES).join(", ")}`);
  if (has("--determinism")) return determinism(config, fixture, Number(flag("--determinism") ?? 3) || 3);
  if (config === "c3") return has("--emit-tasks") ? emitTasks(fixture) : verifyC3(fixture);
  return runHttp(config, fixture);
}

main().catch((e) => {
  process.stderr.write(`${String((e as Error)?.stack ?? e)}\n`);
  process.exit(1);
});
