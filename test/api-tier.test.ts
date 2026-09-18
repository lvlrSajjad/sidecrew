// The api tier as the rest of the pipeline sees it: the schema guarantee, the tier row `doctor`
// prints, the concurrency the run picks, and the two generators (ADR-0009, ADR-0045, ADR-0059..0061).
import { describe, expect, it } from "vitest";
import { BatchResult, ChangeTask, FixResult, WorkerTask } from "../src/schemas.js";
import { tierCheck, memoryCheck } from "../src/doctor.js";
import { planApiConcurrency, DEFAULT_API_CONCURRENCY } from "../src/concurrency.js";
import { apiCostUsd, apiModel, tierFor } from "../src/models.js";
import { generateApi, billedWorkerTokens } from "../src/batch.js";
import { generateApiChange } from "../src/fix.js";
import type { ApiTierContext } from "../src/api-worker.js";

// ── the pin ───────────────────────────────────────────────────────────────────────────────────────

describe("the pinned api model — ADR-0060", () => {
  it("is a full model id, and it is the id the tier rule names", () => {
    const a = apiModel();
    expect(a.model).toBe("claude-haiku-4-5");
    expect(tierFor(16).model).toBe(a.model);
  });

  it("carries the rates and the date they were true, because $(api) is computed from them", () => {
    const a = apiModel();
    expect(a.rates_usd_per_mtok.input).toBeGreaterThan(0);
    expect(a.rates_usd_per_mtok.output).toBeGreaterThan(0);
    expect(a.rates_as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("prices a run from its billed tokens", () => {
    // 1M in and 1M out at the recorded rates is exactly input + output.
    const a = apiModel();
    const cost = apiCostUsd({ prompt_tokens: 1e6, completion_tokens: 1e6 });
    expect(cost).toBeCloseTo(a.rates_usd_per_mtok.input + a.rates_usd_per_mtok.output, 6);
    expect(apiCostUsd({ prompt_tokens: 0, completion_tokens: 0 })).toBe(0);
  });
});

// ── the guarantee, both ways ──────────────────────────────────────────────────────────────────────

const batch = (over: Record<string, unknown> = {}, stats: Record<string, unknown> = {}): unknown => ({
  run_id: "r", plan: "p",
  config: { worker_kind: "local", worker_model: "m", concurrency: 1, retry: 1, ...over },
  stats: {
    tasks: 1, survived: 1, retried: 0, escalated: 0,
    funnel: { compiled: 1, passed: 1, killed_ge_1: 1, non_tautological: 1 },
    latency_ms: { median: 1, p90: 1 }, peak_rss_mb: 0,
    claude_tokens: { planning: 0, workers: 0, review: null },
    ...stats,
  },
  survivors: [], escalations: [],
});

describe("the zero-worker-tokens guarantee is conditional, and now checked from both sides", () => {
  it("still refuses a local run that spent worker tokens — the refinement that IS the guarantee", () => {
    expect(() => BatchResult.parse(batch({}, { claude_tokens: { planning: 0, workers: 5, review: null } })))
      .toThrow(/local worker cannot spend Claude tokens/);
  });

  it("allows an api run that spent them", () => {
    expect(() => BatchResult.parse(batch({ worker_kind: "api" }, { claude_tokens: { planning: 0, workers: 5, review: null } })))
      .not.toThrow();
  });

  /**
   * Phase 13 §5.0.2 voids a run whose worker tokens are not what Anthropic billed. A free-looking api
   * run is exactly what a broken accounting path produces, and before this it serialised happily.
   */
  it("refuses an api run that produced outcomes and claims they were free", () => {
    expect(() => BatchResult.parse(batch({ worker_kind: "api" }, { survived: 1, escalated: 0 })))
      .toThrow(/cannot have cost 0 worker tokens/);
  });

  it("does not object to an api dry run, which produced nothing and therefore bought nothing", () => {
    expect(() => BatchResult.parse(batch({ worker_kind: "api" }, { tasks: 3, survived: 0, escalated: 0 })))
      .not.toThrow();
  });
});

const fixResult = (over: Record<string, unknown> = {}, stats: Record<string, unknown> = {}): unknown => ({
  run_id: "r", plan: "p",
  config: { worker_kind: "local", worker_model: "m", concurrency: 1, retry: 1, ...over },
  project: { errors_before: 0, errors_after: 0, tests_ran: 1, tests_passed: 1, combined_regressions: 0 },
  steps: [],
  stats: {
    tasks: 1, survived: 1, retried: 0, escalated: 0,
    funnel: { answered: 1, edits_parsed: 1, confined: 1, applied: 1, compiled: 1, suite_green: 1 },
    edit_parse_failed: 0, edit_truncated: 0,
    confinement_breaks: {},
    latency_ms: { median: 1, p90: 1 }, generate_ms: { median: 1, p90: 1 }, gate_ms: { median: 1, p90: 1 },
    peak_rss_mb: 0,
    claude_tokens: { planning: 0, workers: 0, review: null },
    ...stats,
  },
  survivors: [], escalations: [],
});

describe("FixResult carries the same rule", () => {
  it("refuses a local run that spent worker tokens", () => {
    expect(() => FixResult.parse(fixResult({}, { claude_tokens: { planning: 0, workers: 3, review: null } })))
      .toThrow(/local worker cannot spend Claude tokens/);
  });

  it("refuses an api run that answered and claims it was free", () => {
    expect(() => FixResult.parse(fixResult({ worker_kind: "api" })))
      .toThrow(/cannot have cost 0 worker tokens/);
  });

  it("allows an api run that answered nothing — a dry run buys nothing", () => {
    expect(() => FixResult.parse(fixResult({ worker_kind: "api" }, {
      funnel: { answered: 0, edits_parsed: 0, confined: 0, applied: 0, compiled: 0, suite_green: 0 },
    }))).not.toThrow();
  });
});

describe("billedWorkerTokens", () => {
  it("sums prompt and completion across every candidate, which is what a bill is", () => {
    expect(billedWorkerTokens([
      { usage: { prompt_tokens: 10, completion_tokens: 1 } },
      { usage: { prompt_tokens: 20, completion_tokens: 2 } },
    ])).toBe(33);
    expect(billedWorkerTokens([])).toBe(0);
  });
});

// ── doctor ────────────────────────────────────────────────────────────────────────────────────────

describe("doctor names the tier and why — ADR-0032's shape", () => {
  it("says local, with the model, on a machine that can host one", () => {
    const c = tierCheck({ total_gb: 32, free_gb: 12 }, {});
    expect(c.status).toBe("ok");
    expect(c.detail).toMatch(/local tier/);
    expect(c.detail).toMatch(/qwen2\.5-coder-7b-4bit/);
    expect(c.detail).toMatch(/32\.0 GB installed/);
  });

  it("says api, names the model, and says it is billed", () => {
    const c = tierCheck({ total_gb: 16, free_gb: 4 }, { ANTHROPIC_API_KEY: "k" });
    expect(c.status).toBe("ok");
    expect(c.detail).toMatch(/api tier · claude-haiku-4-5/);
    expect(c.detail).toMatch(/billed/);
    // The headline is labelled where a user reads it, not only in an ADR.
    expect(c.detail).toMatch(/local-tier guarantee/);
  });

  it("is fatal on an api machine with no key — there is no local fallback to degrade to", () => {
    const c = tierCheck({ total_gb: 16, free_gb: 4 }, {});
    expect(c.status).toBe("missing");
    expect(c.detail).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("does not size an api machine's memory against a model it will never host", () => {
    // The old row would measure free RAM against the 7B's footprint on a machine that cannot run it.
    const local = memoryCheck({ total_gb: 32, free_gb: 3 }, "local");
    expect(local.detail).toMatch(/qwen2\.5-coder-7b-4bit/);

    const api = memoryCheck({ total_gb: 16, free_gb: 3 }, "api");
    expect(api.detail).not.toMatch(/qwen/);
    expect(api.detail).toMatch(/no local worker on this tier/);
  });
});

// ── concurrency ───────────────────────────────────────────────────────────────────────────────────

describe("api-tier concurrency is bounded by the rate limit, not by RAM (ADR-0045 §5)", () => {
  it("does not shrink when the machine is busy — the worker uses none of this machine's memory", () => {
    const busy = planApiConcurrency({ mem: { total_gb: 16, free_gb: 0.5 } });
    const idle = planApiConcurrency({ mem: { total_gb: 16, free_gb: 12 } });
    expect(busy.workers).toBe(DEFAULT_API_CONCURRENCY);
    expect(idle.workers).toBe(DEFAULT_API_CONCURRENCY);
  });

  it("is still the run's to pick (ADR-0044 §3)", () => {
    expect(planApiConcurrency({ mem: null, requested: 5 }).workers).toBe(5);
    expect(planApiConcurrency({ mem: null, requested: 0 }).workers).toBe(1);
  });

  it("holds the verifier at one process, because the gate still runs here and is unmeasured", () => {
    expect(planApiConcurrency({ mem: { total_gb: 16, free_gb: 12 } }).verifier).toBe(1);
  });

  it("explains itself", () => {
    expect(planApiConcurrency({ mem: null }).reason).toMatch(/rate limit/);
  });
});

// ── the generators ────────────────────────────────────────────────────────────────────────────────

const api = (body: unknown): ApiTierContext => ({
  model: "claude-haiku-4-5",
  apiKey: "k",
  baseUrl: "https://api.anthropic.com",
  fetchImpl: (async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
    text: async () => "",
  })) as unknown as typeof fetch,
});

const answer = (text: string, input = 50, output = 9): unknown => ({
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  usage: { input_tokens: input, output_tokens: output },
});

const workerTask = (): WorkerTask => WorkerTask.parse({
  task_id: "f:boundary:0",
  language: "typescript",
  test_framework: "vitest",
  function: {
    name: "f",
    signature: "f(x: number): number",
    source: "export function f(x: number): number { return x; }",
    source_sha: "9f2c",
  },
  imports_hint: 'import { f } from "../src/a";',
  shape: { kind: "boundary", rules: "Empty input, one element." },
  exemplar_source: 'import { describe } from "vitest";',
  retry_of: null,
  previous_error: null,
});

const changeTask = (paths: string[] = ["src/a.ts"]): ChangeTask => ChangeTask.parse({
  task_id: "c1",
  language: "typescript",
  test_framework: "vitest",
  ask: "Rename f to g without changing what the code does.",
  files: paths.map((path) => ({ path, source: "export const f = 1;\n", source_sha: "sha", errors: 1 })),
  diagnostics: "",
  max_deleted_lines: 0,
  notes: null,
  attempt: 0,
  retry_of: null,
  previous_error: null,
  correction: null,
  shape: "rename",
});

describe("generateApi — workload #1 on the api tier", () => {
  it("stamps the tier, the pinned model, temperature 0 and NO seed", async () => {
    const c = await generateApi(workerTask(), api(answer("```ts\nimport {f} from './a';\n```")));
    expect(c.worker.kind).toBe("api");
    expect(c.worker.model).toBe("claude-haiku-4-5");
    expect(c.worker.temperature).toBe(0);
    // ADR-0009: the API offers no seed, and writing one we never sent would make the record lie.
    expect(c.worker.seed).toBeNull();
    // A hosted id is not a commit, and an empty revision says so rather than inventing one.
    expect(c.worker.revision).toBe("");
  });

  it("records the API's own usage, which is what the tier's price is made of", async () => {
    const c = await generateApi(workerTask(), api(answer("x", 123, 45)));
    expect(c.usage).toEqual({ prompt_tokens: 123, completion_tokens: 45 });
  });

  it("refuses a candidate whose usage was not measured (ADR-0019, Phase 13 §5.0.2)", async () => {
    const noUsage = { content: [{ type: "text", text: "something" }], stop_reason: "end_turn" };
    await expect(generateApi(workerTask(), api(noUsage))).rejects.toThrow(/measurements, not estimates/);
  });

  it("refuses output that claims to have cost zero completion tokens", async () => {
    await expect(generateApi(workerTask(), api(answer("some real output", 10, 0))))
      .rejects.toThrow(/0 completion tokens/);
  });
});

describe("generateApiChange — workload #2a on the api tier", () => {
  it("parses the same edit format the local tier uses — only who wrote it changed", async () => {
    const text = "--- FILE: src/a.ts ---\nexport const g = 1;\n";
    const c = await generateApiChange(changeTask(), api(answer(text)));
    expect(c.worker.kind).toBe("api");
    expect(c.worker.seed).toBeNull();
    expect(c.edits).toEqual([{ path: "src/a.ts", contents: "export const g = 1;\n" }]);
    expect(c.refusal).toBeNull();
  });

  it("reads Phase 12's refusal shape on a multi-file task", async () => {
    const two = changeTask(["src/a.ts", "src/b.ts"]);
    const c = await generateApiChange(two, api(answer("--- CANNOT: the symbol is not in these files ---")));
    expect(c.refusal).toMatch(/not in these files/);
    expect(c.edits).toEqual([]);
  });

  /**
   * **ADR-0062, now decided (option B) — this test was inverted when the fix landed.**
   *
   * It was written to assert the *defect*: on a single-file task `parseEdits`' bare-answer fallback
   * claimed any non-empty text as the file's new contents, so `edits.length` was never 0, `parseRefusal`
   * was never consulted, and a refusal became a candidate that replaced the file with the refusal text.
   * Phase 11 measured only single-file tasks, so the refusal shape was inert in exactly the
   * configuration everything has been measured in.
   *
   * The original said *"when ADR-0062 is decided, this test should start failing — that is the point of
   * it"*. It did, on the merge, which is the test doing its job; it now pins the fixed behaviour
   * instead. Kept on the api path as well as the local one because both tiers derive `refusal` from
   * `edits.length === 0`, so a regression in the parser would break them together and should be caught
   * on both.
   */
  it("reads a refusal on a single-file task — ADR-0062 option B", async () => {
    const c = await generateApiChange(changeTask(), api(answer("--- CANNOT: the symbol is not in these files ---")));
    expect(c.refusal).toMatch(/not in these files/);
    expect(c.edits).toEqual([]);
  });

  it("marks truncation from the API's own stop reason", async () => {
    const body = {
      content: [{ type: "text", text: "--- FILE: src/a.ts ---\nexport const g" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 5, output_tokens: 5 },
    };
    const c = await generateApiChange(changeTask(), api(body));
    expect(c.truncated).toBe(true);
  });
});
