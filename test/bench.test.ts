import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { median, refuseToClobber, RssSampler, resultPath, benchPrompt, measureDeterminism, renderBench, BENCH_SEED, SWAP_NOISE_FLOOR_MB, type BenchReport } from "../src/bench.js";
import { startFake, type Fake } from "./fake-worker.js";

let fake: Fake | null = null;
const made: string[] = [];
afterEach(async () => {
  await fake?.close();
  fake = null;
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("median", () => {
  it("takes the middle of an odd sample and the mean of the middle two of an even one", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
  });

  it("returns 0 for nothing, rather than NaN in a results file", () => {
    expect(median([])).toBe(0);
  });
});

describe("resultPath", () => {
  it("names the file by date, as the go/no-go protocol expects", () => {
    expect(resultPath(new Date("2026-09-11T23:30:00Z"), "out")).toBe("out/bench-2026-09-11.json");
  });

  it("lets a tagged run sit beside the canonical one instead of overwriting it", () => {
    expect(resultPath(new Date("2026-09-11T23:30:00Z"), "out", "quiet")).toBe("out/bench-2026-09-11-quiet.json");
  });
});

describe("refuseToClobber", () => {
  it("says nothing about a path that is free", () => {
    expect(() => refuseToClobber("out/bench-2999-01-01.json")).not.toThrow();
  });

  it("refuses to overwrite a measurement, and names the flag rather than the problem", async () => {
    // Phase 6 runs three or four configurations, mostly on one day, and compares them. A forgotten
    // --tag used to mean the second silently replaced the first; the only trace was `created`.
    const dir = await mkdtemp(join(tmpdir(), "sidecrew-bench-"));
    made.push(dir);
    const path = resultPath(new Date("2026-09-11T23:30:00Z"), dir);
    await writeFile(path, "{}", "utf8");
    expect(() => refuseToClobber(path)).toThrow(/--tag <name>/);
    expect(() => refuseToClobber(path, "quiet")).toThrow(/different --tag/);
  });
});

describe("RssSampler", () => {
  it("measures a real process and keeps the maximum", async () => {
    const s = new RssSampler(process.pid);
    await s.sample();
    const first = s.peakMb;
    expect(first).toBeGreaterThan(0);

    // Allocating cannot lower the peak, and nothing may.
    const ballast = Buffer.alloc(64 * 1024 * 1024, 1);
    await s.sample();
    expect(s.peakMb).toBeGreaterThanOrEqual(first);
    expect(ballast.length).toBe(64 * 1024 * 1024);
  });

  it("reports 0 rather than NaN for a pid that is gone", async () => {
    const s = new RssSampler(4_194_300);
    await s.sample();
    expect(s.peakMb).toBe(0);
  });
});

describe("the bench prompt", () => {
  it("is long enough to be the ~400-token prompt the determinism check calls for", async () => {
    const prompt = await benchPrompt();
    // ~4 chars per token on code-ish English; 1200 chars is comfortably over 300 tokens.
    expect(prompt.length).toBeGreaterThan(1200);
  });

  it("asks for prose about code, not for tests — test prompts are Phase 5's", async () => {
    expect(await benchPrompt()).toMatch(/Do not write any code/);
  });
});

describe("measureDeterminism", () => {
  it("calls it identical when every request returns the same bytes", async () => {
    fake = await startFake({ chunks: ["same", " output"] });
    const r = await measureDeterminism(fake.baseUrl, "m", "prompt", 5);

    expect(r.identical).toBe(true);
    expect(r.distinct_outputs).toBe(1);
    expect(r.first_divergence).toBeNull();
    expect(r.requests).toBe(5);
    expect(fake.requests).toHaveLength(5);
  });

  it("sends the same seed and temperature 0 on every request", async () => {
    fake = await startFake();
    await measureDeterminism(fake.baseUrl, "m", "prompt", 3);
    for (const sent of fake.requests) {
      expect(sent.seed).toBe(BENCH_SEED);
      expect(sent.temperature).toBe(0);
    }
  });

  it("issues the requests one at a time, never overlapping", async () => {
    // Serialisation is the claim ADR-0003 rests on: a seeded request is excluded from mlx_lm's batch,
    // and the bench must not quietly reintroduce concurrency behind that.
    let inFlight = 0;
    let maxInFlight = 0;
    fake = await startFake({ firstTokenDelayMs: 40 });
    fake.server.on("request", (_req, res) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      res.on("close", () => { inFlight -= 1; });
    });

    await measureDeterminism(fake.baseUrl, "m", "prompt", 3);
    expect(fake.requests).toHaveLength(3);
    expect(maxInFlight).toBe(1);
  });

  it("reports where the divergence started, and refuses to call it deterministic", async () => {
    // A server whose answer drifts is exactly what ADR-0003 exists to detect.
    let n = 0;
    fake = await startFake();
    fake.server.removeAllListeners("request");
    fake.server.on("request", (req, res) => {
      let body = "";
      req.on("data", (c) => { body += String(c); });
      req.on("end", () => {
        n += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: n < 3 ? "stable" : `drift-${n}` }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });

    const r = await measureDeterminism(fake.baseUrl, "m", "prompt", 5);
    expect(r.identical).toBe(false);
    expect(r.first_divergence).toBe(2);
    // "stable", "stable", then a different string each time: four distinct answers to one prompt.
    expect(r.distinct_outputs).toBe(4);
    expect(r.note).toMatch(/do not trust any survival rate/);
  });
});

describe("renderBench", () => {
  const report: BenchReport = {
    sidecrew: "0.0.1",
    created: "2026-09-11T12:00:00.000Z",
    tag: null,
    machine: { cpu: "Apple M2 Pro", ram_gb: 32, free_gb_at_start: 9, macos: "26.6.2", xcode_open: true, simulator_open: false, node: "v20", mlx_lm: "0.31.3", on_battery: false },
    tier: { min_ram_gb: 24, tier: "local", model: "qwen2.5-coder-7b-4bit", why: "…" },
    config: { seed: 42, max_tokens: 400, requests: 3, prompt_sha: "abc", temperature: 0 },
    models: [{
      key: "qwen2.5-coder-7b-4bit", repo: "r", revision: "a".repeat(40), pinned: true, ram_gb_declared: 5,
      requests: 3, prompt_tokens: 400, completion_tokens: 400, decode_tok_s: 44.2, decode_tok_s_all: [44.2],
      ttft_ms: 210, ttft_ms_all: [210], wall_ms: 9000, peak_rss_mb: 4600, load_ms: 8000,
      swapped_out_mb: 0, trustworthy: true,
      finish_reason: "stop", determinism: null, measured: true,
    }],
    skipped: [{ key: "qwen2.5-coder-14b-4bit", reason: "not enough free RAM" }],
    measured: true,
  };

  it("leads with the machine, because a tok/s without one is not a number anyone can use", () => {
    const out = renderBench(report);
    expect(out).toContain("Apple M2 Pro");
    expect(out).toContain("Xcode open");
  });

  it("shows what was not measured, so a missing row is never mistaken for a zero", () => {
    expect(renderBench(report)).toContain("qwen2.5-coder-14b-4bit: not enough free RAM");
  });

  it("sits between the noise this machine actually produced and the thrashing it actually produced", () => {
    // Both measured on the baseline: 10.8 MB of unrelated background swap during a 14B run that fitted,
    // and 3197 MB during one that did not. The floor has to separate those two and nothing else.
    expect(SWAP_NOISE_FLOOR_MB).toBeGreaterThan(10.8);
    expect(SWAP_NOISE_FLOOR_MB).toBeLessThan(3197);
  });

  it("marks a row that swapped as unusable rather than filing it next to honest numbers", () => {
    // Measured on the baseline machine: the 14B with Xcode open swapped 3.2 GB and reported a *lower*
    // peak RSS than on a quiet machine, so RSS cannot be the thing that flags this.
    const swapped = { ...report, models: [{ ...report.models[0], swapped_out_mb: 3197, trustworthy: false }] };
    expect(renderBench(swapped)).toMatch(/SWAPPED 3197 MB/);
    expect(renderBench(swapped)).toMatch(/do not use these numbers/);
  });

  it("does not cry wolf over a few MB of background swap", () => {
    const noisy = { ...report, models: [{ ...report.models[0], swapped_out_mb: 10.8, trustworthy: true }] };
    expect(renderBench(noisy)).not.toMatch(/SWAPPED/);
  });
});
