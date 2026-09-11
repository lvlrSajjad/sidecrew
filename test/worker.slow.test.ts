// Needs a real toolchain: mlx_lm installed and the default model in the HF cache. SIDECREW_SLOW=1.
//
// The fast tests prove the client speaks the protocol; only this one proves the protocol we implemented
// is the one mlx_lm actually speaks — that `stream_options.include_usage` produces a usage block, that
// a seeded request comes back byte-identical, and that TTFT is a real number and not an artefact of a
// fake that answers instantly.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { complete, decodeTokensPerSecond } from "../src/worker.js";
import { serve, stop, type WorkerRecord } from "../src/serve.js";
import { measureDeterminism, benchPrompt, BENCH_SEED } from "../src/bench.js";
import { baseUrlFor } from "../src/doctor.js";

const PORT = Number(process.env.SIDECREW_SLOW_PORT ?? 8123);
const baseUrl = baseUrlFor(PORT);

let record: WorkerRecord;
let model: string;

beforeAll(async () => {
  record = await serve({ port: PORT, quiet: true, readyTimeoutMs: 900_000 });
  const res = await fetch(`${baseUrl}/models`);
  const body = (await res.json()) as { data?: { id?: string }[] };
  model = body.data?.[0]?.id ?? record.model_arg;
}, 900_000);

afterAll(async () => { await stop({ port: PORT, quiet: true }); });

describe("a real mlx_lm worker", () => {
  it("completes a chat and reports usage the server actually sent", async () => {
    const r = await complete({
      baseUrl,
      model,
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      seed: BENCH_SEED,
      maxTokens: 16,
    });

    expect(r.text.length).toBeGreaterThan(0);
    // The whole reason for streaming with stream_options: if this regresses, Candidate.usage becomes
    // a fiction and the go/no-go token columns stop meaning anything.
    expect(r.usage_estimated).toBe(false);
    expect(r.usage.prompt_tokens).toBeGreaterThan(0);
    expect(r.usage.completion_tokens).toBeGreaterThan(0);
    expect(r.ttft_ms).toBeGreaterThan(0);
    expect(r.wall_ms).toBeGreaterThanOrEqual(r.ttft_ms);
  }, 180_000);

  it("respects max_tokens and says why it stopped", async () => {
    const r = await complete({
      baseUrl,
      model,
      messages: [{ role: "user", content: "Count from 1 to 500, one number per line." }],
      seed: BENCH_SEED,
      maxTokens: 24,
    });
    expect(r.usage.completion_tokens).toBeLessThanOrEqual(24);
    expect(r.finish_reason).toBe("length");
  }, 180_000);

  it("is byte-identical 5/5 at temperature 0 with a fixed seed — ADR-0003", async () => {
    const r = await measureDeterminism(baseUrl, model, await benchPrompt(), 5);
    expect(r.identical).toBe(true);
    expect(r.distinct_outputs).toBe(1);
  }, 900_000);

  it("decodes fast enough to be worth the trouble", async () => {
    const r = await complete({
      baseUrl,
      model,
      messages: [{ role: "user", content: await benchPrompt() }],
      seed: BENCH_SEED,
      maxTokens: 200,
    });
    const rate = decodeTokensPerSecond(r);
    // Not a benchmark — a floor. Anything under this means the machine is swapping or throttled, and
    // `sidecrew bench` is where the real number lives.
    expect(rate).not.toBeNull();
    expect(rate!).toBeGreaterThan(5);
  }, 300_000);
});
