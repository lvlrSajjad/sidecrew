// Thermal back-off. ADR-0025.
//
// The guard's job is to notice a machine that has sagged, and its harder job is to *not* notice one that
// has not: a back-off costs a slot for the rest of the run, so a guard that fires on one slow candidate
// is worse than no guard. Most of these are about the second job.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import {
  benchBaseline,
  median,
  THERMAL_DROP,
  THERMAL_MIN_SAMPLES,
  THERMAL_WINDOW_MS,
  ThermalGuard,
} from "../src/throttle.js";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

const tmp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), "sidecrew-bench-"));
  dirs.push(d);
  return d;
};

/** Feed `n` samples spread evenly over `spanMs`, starting at t0. */
const feed = (guard: ThermalGuard, tokS: number, n: number, spanMs: number, t0 = 1_000_000): boolean[] =>
  Array.from({ length: n }, (_, i) => guard.observe(tokS, t0 + Math.round((i * spanMs) / (n - 1))));

describe("median", () => {
  it("is the middle of an odd list and the mean of the middle two of an even one", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("ThermalGuard", () => {
  it("does nothing without a baseline, and says nothing either", () => {
    // No `sidecrew bench` for this model means there is no number to be 30 % below. Inventing one from
    // the run's own first samples would calibrate against a cold graph compile, which is exactly what
    // the bench's warm-up request exists to exclude.
    const guard = new ThermalGuard({ baseline: null, concurrency: 2 });
    feed(guard, 1, 10, THERMAL_WINDOW_MS * 2);
    expect(guard.concurrency).toBe(2);
    expect(guard.events).toHaveLength(0);
  });

  it("leaves a healthy machine alone", () => {
    const guard = new ThermalGuard({ baseline: 40, concurrency: 2 });
    feed(guard, 39, 10, THERMAL_WINDOW_MS * 2);
    expect(guard.concurrency).toBe(2);
  });

  it("leaves a machine alone at exactly the threshold, because > 30 % means > 30 %", () => {
    const guard = new ThermalGuard({ baseline: 40, concurrency: 2 });
    feed(guard, 40 * (1 - THERMAL_DROP), 10, THERMAL_WINDOW_MS * 2);
    expect(guard.concurrency).toBe(2);
  });

  it("does not fire on one slow candidate", () => {
    // A long prompt, a page fault, the verifier of the previous task still exiting. One sample is not
    // a temperature.
    const guard = new ThermalGuard({ baseline: 40, concurrency: 2 });
    expect(guard.observe(5, 1_000_000)).toBe(false);
    expect(guard.concurrency).toBe(2);
  });

  it("does not fire until the window has actually been two minutes long", () => {
    // Five fast samples inside ten seconds are five samples of ten seconds, not of two minutes. Firing
    // here would take a slot away from a run whose next candidate was about to be normal.
    const guard = new ThermalGuard({ baseline: 40, concurrency: 2 });
    feed(guard, 10, 6, 10_000);
    expect(guard.concurrency).toBe(2);
  });

  it("reduces concurrency by one when the window is slow for the whole two minutes", () => {
    const guard = new ThermalGuard({ baseline: 40, concurrency: 2 });
    const fired = feed(guard, 20, 5, THERMAL_WINDOW_MS);
    expect(fired.filter(Boolean)).toHaveLength(1);
    expect(guard.concurrency).toBe(1);

    const event = guard.events[0]!;
    expect(event).toMatchObject({ from: 2, to: 1, baseline_tok_s: 40, observed_tok_s: 20 });
    // The log line has to be readable by whoever finds a run that took twice as long as the last one.
    expect(event.reason).toMatch(/20.0 tok\/s median over 120s against a bench baseline of 40.0/);
    expect(event.reason).toMatch(/concurrency 2 → 1/);
  });

  it("fires when the samples are spaced the way real candidates are, not only on a tidy grid", () => {
    // The bug this pins: the first implementation asked whether the *retained* window spanned two
    // minutes, and the filter has already dropped everything older than two minutes — so the retained
    // span is whatever the sample spacing happens to make it. At ~25 s per TypeScript candidate the
    // oldest retained sample is 100 s old, the check never passed, and the guard could not fire at all.
    const guard = new ThermalGuard({ baseline: 40, concurrency: 2 });
    const t0 = 1_000_000;
    for (const seconds of [0, 25, 50, 75, 100, 125]) guard.observe(20, t0 + seconds * 1000);
    expect(guard.concurrency).toBe(1);
  });

  it("fires on three samples, which is all a two-minute window of Swift candidates holds", () => {
    // ~40 s per Swift candidate end to end. A higher floor would make the guard TypeScript-only, and
    // Swift is the configuration that spends longest on the machine.
    expect(THERMAL_MIN_SAMPLES).toBe(3);
    const guard = new ThermalGuard({ baseline: 40, concurrency: 2 });
    feed(guard, 20, 3, THERMAL_WINDOW_MS);
    expect(guard.concurrency).toBe(1);
  });

  it("makes the second step down cost another window of evidence", () => {
    const guard = new ThermalGuard({ baseline: 40, concurrency: 3 });
    feed(guard, 20, 5, THERMAL_WINDOW_MS);
    expect(guard.concurrency).toBe(2);
    // The very next sample, however slow, is now sample one of a fresh window.
    expect(guard.observe(1, 2_000_000)).toBe(false);
    expect(guard.concurrency).toBe(2);
    feed(guard, 20, 5, THERMAL_WINDOW_MS, 3_000_000);
    expect(guard.concurrency).toBe(1);
  });

  it("never goes below one, and never goes back up", () => {
    // Recovery is deliberately not implemented: a machine that cooled enough to take the slot back will
    // heat up again on the next sustained stretch, and a guard that oscillates costs more in restarted
    // work than the slot is worth.
    const guard = new ThermalGuard({ baseline: 40, concurrency: 1 });
    feed(guard, 1, 6, THERMAL_WINDOW_MS);
    expect(guard.concurrency).toBe(1);
    expect(guard.events).toHaveLength(0);

    const two = new ThermalGuard({ baseline: 40, concurrency: 2 });
    feed(two, 20, 5, THERMAL_WINDOW_MS);
    feed(two, 400, 5, THERMAL_WINDOW_MS, 5_000_000);
    expect(two.concurrency).toBe(1);
  });

  it("ignores a sample it cannot compute a rate from", () => {
    // `decodeTokensPerSecond` is null for a one-token completion — no decode window to divide by.
    const guard = new ThermalGuard({ baseline: 40, concurrency: 2 });
    for (let i = 0; i < 10; i += 1) guard.observe(null, 1_000_000 + i * 30_000);
    expect(guard.concurrency).toBe(2);
  });
});

describe("benchBaseline", () => {
  const benchFile = (models: unknown[]) => JSON.stringify({ measured: true, models });

  it("takes the most recent results file that has the model", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "bench-2026-09-11.json"), benchFile([{ key: "m", decode_tok_s: 30, trustworthy: true }]));
    await writeFile(join(dir, "bench-2026-09-14.json"), benchFile([{ key: "m", decode_tok_s: 40, trustworthy: true }]));
    expect(await benchBaseline("m", dir)).toMatchObject({ tok_s: 40 });
  });

  it("skips a run the bench itself flagged as untrustworthy", async () => {
    // ADR-0011: a baseline taken while the machine was swapping is low, and a low baseline makes the
    // guard blind to exactly the condition it exists to catch.
    const dir = await tmp();
    await writeFile(join(dir, "bench-2026-09-11.json"), benchFile([{ key: "m", decode_tok_s: 40, trustworthy: true }]));
    await writeFile(join(dir, "bench-2026-09-14.json"), benchFile([{ key: "m", decode_tok_s: 9, trustworthy: false }]));
    expect(await benchBaseline("m", dir)).toMatchObject({ tok_s: 40, source: join(dir, "bench-2026-09-11.json") });
  });

  it("is null for a model nobody has benched, and for a directory that is not there", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "bench-2026-09-14.json"), benchFile([{ key: "other", decode_tok_s: 40, trustworthy: true }]));
    expect(await benchBaseline("m", dir)).toBeNull();
    expect(await benchBaseline("m", join(dir, "nope"))).toBeNull();
  });

  it("reads past a file it cannot parse", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "bench-2026-09-11.json"), benchFile([{ key: "m", decode_tok_s: 40, trustworthy: true }]));
    await writeFile(join(dir, "bench-2026-09-14.json"), "{ truncated");
    expect(await benchBaseline("m", dir)).toMatchObject({ tok_s: 40 });
  });

  it("finds the real repo's own bench files, which is where a run gets its baseline", async () => {
    // Not a fixture: the shipped `experiments/go-no-go/results/` is what `runBatch` reads by default,
    // and a rename of `decode_tok_s` or `trustworthy` in `bench.ts` would silently turn the guard off.
    const baseline = await benchBaseline("qwen2.5-coder-7b-4bit", "experiments/go-no-go/results");
    expect(baseline?.tok_s).toBeGreaterThan(10);
  });
});
