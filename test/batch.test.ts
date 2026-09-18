// The batch loop's decisions, without a model and without a toolchain: what counts as the worker's
// answer, which failures may spend the single retry, and where a run's files go.
//
// The loop itself is `test/batch.slow.test.ts`.
import { rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import {
  AnonymousWorkerError,
  discoverWorkers,
  extractTestSource,
  generate,
  MAX_TEST_TOKENS,
  portsFromEnv,
  RUN_SEED,
  runBatch,
  runId,
  shouldRetry,
} from "../src/batch.js";
import { ESCALATIONS_FILE, readEscalations } from "../src/escalate.js";
import { buildTasks, loadPlan } from "../src/plan.js";
import { Verdict, type MutationResult } from "../src/schemas.js";
import { startFake, deadPort, type Fake } from "./fake-worker.js";

const FIXTURE_PLAN = "fixtures/ts-fixture/plans/strings/test_plan.json";

const fakes: Fake[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const fake = async (...args: Parameters<typeof startFake>): Promise<Fake> => {
  const f = await startFake(...args);
  fakes.push(f);
  return f;
};

const endpoint = (f: Fake) => ({
  port: f.port,
  baseUrl: f.baseUrl,
  record: null,
  modelArg: "fake-model",
  model: "fake-model",
  revision: "",
});

describe("extractTestSource", () => {
  it("leaves a plain answer alone", () => {
    expect(extractTestSource('import { it } from "vitest";\n')).toBe('import { it } from "vitest";');
  });

  it("unwraps a fence that is the whole answer, because the prompt asking for none is not enough", () => {
    expect(extractTestSource('```ts\nconst a = 1;\n```')).toBe("const a = 1;");
    expect(extractTestSource('```\nconst a = 1;\n```\n')).toBe("const a = 1;");
  });

  it("strips the end-of-turn marker mlx_lm streams as content", () => {
    // Measured on the first real run: every Qwen completion ended `<|im_end|>` *inside* the delta, and
    // six candidates out of six failed the compile stage on it while looking like a bad model.
    expect(extractTestSource("```ts\nconst a = 1;\n```<|im_end|>")).toBe("const a = 1;");
    expect(extractTestSource("const a = 1;<|endoftext|>")).toBe("const a = 1;");
  });

  it("leaves a fence with prose around it, because that is a real failure the verifier should see", () => {
    const answered = "Here is the test:\n```ts\nconst a = 1;\n```\nHope that helps.";
    expect(extractTestSource(answered)).toBe(answered);
  });
});

// A Verdict is an iff (`survived` must agree with its own fields), so failures are built from a
// failing base rather than by flipping one field on a survivor.
const verdict = (over: Partial<Verdict> & { mutation?: MutationResult | null }): Verdict => Verdict.parse({
  task_id: "f:happy_path:0",
  stage_reached: "done",
  survived: false,
  compile_ok: true,
  pass_ok: true,
  tautological: false,
  mutation: { score: 0, killed: 0, survived: 2, timeout: 0, no_coverage: 0, killed_ids: [] },
  error: "…",
  timing_ms: {},
  ...over,
});

describe("shouldRetry", () => {
  it("retries a candidate that did not compile", () => {
    const d = shouldRetry(verdict({ stage_reached: "compile", compile_ok: false, pass_ok: false, mutation: null }));
    expect(d).toMatchObject({ retry: true, reason: "did not compile" });
  });

  it("retries a candidate that compiled but did not pass", () => {
    expect(shouldRetry(verdict({ stage_reached: "pass", pass_ok: false, mutation: null }))).toMatchObject({ retry: true });
  });

  it("retries a candidate that killed nothing when there was something to kill", () => {
    expect(shouldRetry(verdict({}))).toMatchObject({ retry: true, reason: "killed no mutant" });
  });

  it("retries a tautology, because the finding names exactly what to fix", () => {
    const d = shouldRetry(verdict({ stage_reached: "pass", tautological: true, mutation: null }));
    expect(d.retry).toBe(true);
  });

  it("does not spend the retry on a mutation tool that broke (ADR-0012)", () => {
    // `stage_reached: "mutation"` means the stage ran and produced no report. The test may be perfect.
    const d = shouldRetry(verdict({ stage_reached: "mutation", mutation: null }));
    expect(d.retry).toBe(false);
    expect(d.reason).toMatch(/machine problem/);
  });

  it("does not spend the retry when nothing in the function could be mutated (ADR-0005)", () => {
    // All four counts zero: no test of that function could ever have killed anything, so rewriting the
    // test rewrites something that was never the problem.
    const d = shouldRetry(verdict({ mutation: { score: 0, killed: 0, survived: 0, timeout: 0, no_coverage: 0, killed_ids: [] } }));
    expect(d.retry).toBe(false);
    expect(d.reason).toMatch(/could be mutated/);
  });

  it("says survived rather than proposing a retry for one", () => {
    const survivor = verdict({
      survived: true,
      mutation: { score: 1, killed: 3, survived: 0, timeout: 0, no_coverage: 0, killed_ids: ["1", "2", "3"] },
      error: null,
    });
    expect(shouldRetry(survivor)).toMatchObject({ retry: false, reason: "survived" });
  });
});

describe("runId", () => {
  it("sorts by time and names the module it was about", () => {
    expect(runId("fixtures/ts-fixture/src/strings.ts", new Date("2026-09-14T10:24:26.512Z")))
      .toBe("2026-09-14T10-24-26Z-strings");
  });
});

describe("portsFromEnv", () => {
  it("defaults to the one port, and reads a list when there is one", () => {
    expect(portsFromEnv({})).toEqual([8000]);
    expect(portsFromEnv({ SIDECREW_PORTS: "8000,8001" })).toEqual([8000, 8001]);
    expect(portsFromEnv({ SIDECREW_PORT: "9000" })).toEqual([9000]);
    expect(portsFromEnv({ SIDECREW_PORTS: "nonsense" })).toEqual([8000]);
  });
});

describe("discoverWorkers", () => {
  it("returns only the ports that answer", async () => {
    const up = await fake();
    const down = await deadPort();
    const found = await discoverWorkers([up.port, down]);
    expect(found.map((w) => w.port)).toEqual([up.port]);
    expect(found[0]?.baseUrl).toBe(`http://localhost:${up.port}/v1`);
  });

  it("identifies a worker sidecrew did not start from the endpoint, without inventing a revision", async () => {
    // Anonymous but unambiguous: one model in the catalogue cannot be the wrong one.
    const up = await fake({ modelId: "somebody-elses-model" });
    const [worker] = await discoverWorkers([up.port], "nowhere");
    expect(worker).toMatchObject({ model: "somebody-elses-model", revision: "", record: null });
  });

  it("refuses an anonymous worker whose catalogue offers a choice — ADR-0029", async () => {
    // The bug this is here for, found on a real project: `/v1/models` is served from the Hugging Face
    // cache, so it lists what is *downloaded*, not what is loaded — and it listed a 14B first while a 7B
    // was resident. mlx_lm answers a wrong `model` by swapping that model's weights in, so the run was
    // generated by a 14B nobody asked for, on a machine doctor had said had no room for one, and every
    // candidate recorded it as the model with an empty revision.
    const up = await fake({ modelIds: ["big-model", "small-model"] });
    await expect(discoverWorkers([up.port], "nowhere")).rejects.toThrow(AnonymousWorkerError);
    await expect(discoverWorkers([up.port], "nowhere")).rejects.toThrow(/would be a guess/);
    // The message has to name the way out, because the cause is invisible: two directories.
    await expect(discoverWorkers([up.port], "nowhere")).rejects.toThrow(/SIDECREW_DIR=/);
  });
});

describe("generate", () => {
  it("records the tier, the seed and the temperature the contract insists on", async () => {
    const f = await fake({ chunks: ["const ", "a = 1;"] });
    const task = buildTasks(await loadPlan(FIXTURE_PLAN))[0]!;

    const candidate = await generate(task, endpoint(f));
    expect(candidate.worker).toMatchObject({ kind: "local", temperature: 0, seed: RUN_SEED });
    expect(candidate.test_source).toBe("const a = 1;");
    expect(candidate.usage.prompt_tokens).toBe(11);
    expect(f.requests[0]).toMatchObject({ temperature: 0, seed: RUN_SEED, max_tokens: MAX_TEST_TOKENS, stream: true });
  });

  it("refuses a server that sent no usage block rather than recording zeros as counts", async () => {
    // BACKLOG, noticed while reviewing Phase 1: a guess in `Candidate.usage` becomes a guess in the
    // go/no-go numbers, and the contract has no way to say "estimated".
    const f = await fake({ omitUsage: true });
    const task = buildTasks(await loadPlan(FIXTURE_PLAN))[0]!;
    await expect(generate(task, endpoint(f))).rejects.toThrow(/no usage block/);
  });

  it("refuses a server that reports zero completion tokens for output it actually sent", async () => {
    // ADR-0019. The check above asks "did it send usage?", which the Apple shim answers yes to while
    // reporting {0, 0} for a 600-character test file — a fiction that reaches `Candidate.usage`
    // looking exactly like a measurement. Phase 6 found it; this is the floor.
    const f = await fake({ chunks: ["const ", "a = 1;"], zeroUsage: true });
    const task = buildTasks(await loadPlan(FIXTURE_PLAN))[0]!;
    await expect(generate(task, endpoint(f))).rejects.toThrow(/0 completion tokens for 12 characters/);
  });

  it("accepts zero completion tokens when the server genuinely sent nothing", async () => {
    // Consistent, not a lie: an empty answer costing zero tokens is arithmetic. It fails the compile
    // stage on its own merits, and rejecting it here would turn a verdict into an exception.
    const f = await fake({ chunks: [], zeroUsage: true });
    const task = buildTasks(await loadPlan(FIXTURE_PLAN))[0]!;
    const candidate = await generate(task, endpoint(f));
    expect(candidate.test_source).toBe("");
    expect(candidate.usage.completion_tokens).toBe(0);
  });
});

describe("runBatch --dry-run", () => {
  it("writes every task and stops before the first token", async () => {
    const dir = `.sidecrew-test-${process.pid}`;
    dirs.push(dir);
    const result = await runBatch(FIXTURE_PLAN, { dryRun: true, dir, ports: [await deadPort()] });

    expect(result.stats.tasks).toBeGreaterThan(0);
    expect(result.stats).toMatchObject({ survived: 0, retried: 0, escalated: 0, peak_rss_mb: 0 });
    expect(result.config.worker_kind).toBe("local");
    expect(result.stats.claude_tokens.workers).toBe(0);

    const written = readFileSync(join(dir, "runs", result.run_id, "tasks", "commonPrefix.boundary.0.json"), "utf8");
    expect(JSON.parse(written)).toMatchObject({ task_id: "commonPrefix:boundary:0", retry_of: null });
  });

  it("renders every prompt too, because the task is not the bytes the worker receives", async () => {
    // A `WorkerTask` says what the worker will be told; the prompt is what it actually gets, and the two
    // differ by every conditional in the template — ADR-0021's owner clause appears or it does not, and
    // the exemplar is inlined. "Prompts built, nothing sent" is the point of the flag.
    const dir = `.sidecrew-test-prompts-${process.pid}`;
    dirs.push(dir);
    const result = await runBatch(FIXTURE_PLAN, { dryRun: true, dir, ports: [await deadPort()] });

    const prompt = readFileSync(join(dir, "runs", result.run_id, "prompts", "commonPrefix.boundary.0.md"), "utf8");
    expect(prompt).not.toMatch(/\{\{/);
    expect(prompt).toContain("Test shape: boundary");
    expect(prompt).toContain("commonPrefix");
    // Nothing was sent, so nothing was spent — and the first attempt carries no failure history.
    expect(prompt).not.toMatch(/previous attempt/i);
    expect(result.stats.latency_ms.median).toBe(0);
  });

  it("says how many estimated prompt tokens the run would have cost", async () => {
    const dir = `.sidecrew-test-tokens-${process.pid}`;
    dirs.push(dir);
    const lines: string[] = [];
    await runBatch(FIXTURE_PLAN, { dryRun: true, dir, ports: [await deadPort()], onEvent: (l) => lines.push(l) });
    expect(lines.join("\n")).toMatch(/~\d+ estimated prompt tokens/);
  });

  it("refuses a stale plan before it spends a token", async () => {
    const dir = `.sidecrew-test-stale-${process.pid}`;
    dirs.push(dir);
    // Next to the real plan, because exemplars are resolved against the plan's own directory.
    const planPath = `fixtures/ts-fixture/plans/strings/stale_plan_${process.pid}.json`;
    dirs.push(planPath);
    const raw = JSON.parse(readFileSync(FIXTURE_PLAN, "utf8")) as { functions: { source_sha: string }[] };
    raw.functions[0]!.source_sha = "0".repeat(64);
    await writeFile(planPath, JSON.stringify(raw), "utf8");

    await expect(runBatch(planPath, { dryRun: true, dir })).rejects.toThrow(/is stale — truncate/);
  });
});

describe("a task that throws", () => {
  it("is escalated rather than taking the other tasks with it", async () => {
    // Phase 4's note: a `Promise.all` rejection used to stop the run with nothing in `result.json`, and
    // the per-task files on disk were all that was left of forty minutes. A worker answering HTTP 500 is
    // the transient version of that — real, and not the candidate's fault.
    const dir = `.sidecrew-test-throw-${process.pid}`;
    dirs.push(dir);
    const f = await fake({ httpError: { status: 500, body: "Exceeded model context window size" } });

    const result = await runBatch(FIXTURE_PLAN, { dir, ports: [f.port] });

    expect(result.stats.tasks).toBeGreaterThan(0);
    expect(result.stats.survived).toBe(0);
    expect(result.stats.escalated).toBe(result.stats.tasks);
    // Every task ran: the first exception did not cancel the queue.
    expect(result.escalations).toHaveLength(result.stats.tasks);
    expect(result.escalations[0]?.attempts[0]?.error).toMatch(/HTTP 500/);
  }, 60_000);

  it("writes the queue as it goes, so a run that dies still has one", async () => {
    // ADR-0023. `escalations.jsonl` is appended when a task gives up; `result.json` is written at the end.
    const dir = `.sidecrew-test-queue-${process.pid}`;
    dirs.push(dir);
    const f = await fake({ httpError: { status: 500, body: "nope" } });

    const result = await runBatch(FIXTURE_PLAN, { dir, ports: [f.port] });
    const runDir = join(dir, "runs", result.run_id);
    expect(existsSync(join(runDir, ESCALATIONS_FILE))).toBe(true);

    const queued = await readEscalations(runDir);
    expect(queued.map((e) => e.task_id).sort()).toEqual(result.escalations.map((e) => e.task_id).sort());
    // Enough for Claude to act on: what stopped it, and the words the failure used.
    expect(queued[0]?.reason).toMatch(/threw rather than returning a verdict/);
    expect(queued[0]?.attempts.at(-1)?.error).toMatch(/HTTP 500/);
    // No stage ran, so no stage is named. `"compile"` here would read as "it did not compile", which is
    // a different problem with a different fix.
    expect(queued[0]?.attempts.at(-1)?.stage_reached).toBeNull();
    expect(() => new Date(queued[0]!.escalated_at).toISOString()).not.toThrow();
  }, 60_000);
});
