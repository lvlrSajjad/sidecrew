// How much of the machine a run may use. ADR-0009 deleted `max_concurrency_32gb`; this is what
// replaced it, and the thing worth pinning is that it is one calculation rather than two constants.
import { describe, it, expect } from "vitest";
import { DEFAULT_VERIFIER_CONCURRENCY, planConcurrency, slotGb } from "../src/concurrency.js";
import { DEFAULT_STRYKER_CONCURRENCY } from "../src/verifier/ts.js";
import { entry } from "../src/models.js";
import { SERVE_HEADROOM_GB } from "../src/serve.js";

const model = entry("qwen2.5-coder-7b-4bit");
const mem = (free_gb: number) => ({ total_gb: 32, free_gb });

describe("slotGb", () => {
  it("is the model's measured footprint plus the headroom serve already demands of itself", () => {
    expect(slotGb(model)).toBe(model.ram_gb + SERVE_HEADROOM_GB);
  });
});

describe("planConcurrency", () => {
  it("never lets what is in flight times what each one forks exceed what free RAM affords", () => {
    for (const free of [0.5, 4, 6.5, 13, 17.8, 26, 64]) {
      for (const up of [0, 1, 2, 4]) {
        const p = planConcurrency({ model, mem: mem(free), workersUp: up });
        expect(p.workers * p.verifier).toBeLessThanOrEqual(p.slots);
        expect(p.workers).toBeGreaterThanOrEqual(1);
        expect(p.verifier).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("gives the baseline machine with one worker up the concurrency Phase 2 measured with", () => {
    // 17.8 GB free ÷ 6.5 GB = 2 slots; one worker is up, so one candidate in flight and the other
    // slot goes to Stryker — which is the 2 that used to be a constant in two places.
    const p = planConcurrency({ model, mem: mem(17.8), workersUp: 1 });
    expect(p).toMatchObject({ slots: 2, workers: 1, verifier: 2 });
  });

  it("spends the same budget the other way round when a second worker is up", () => {
    expect(planConcurrency({ model, mem: mem(17.8), workersUp: 2 })).toMatchObject({ workers: 2, verifier: 1 });
  });

  it("never schedules more candidates than there are worker processes to run them", () => {
    // One in-flight request per worker process (non-negotiable #4): a second seeded request to the
    // same port is excluded from mlx_lm's batch and simply queues (ADR-0003).
    expect(planConcurrency({ model, mem: mem(64), workersUp: 1 }).workers).toBe(1);
  });

  it("treats --concurrency as a ceiling and not as a floor", () => {
    expect(planConcurrency({ model, mem: mem(64), workersUp: 4, requested: 2 }).workers).toBe(2);
    // Asking for four on a machine with room for one gets one, and the reason says so.
    const squeezed = planConcurrency({ model, mem: mem(7), workersUp: 4, requested: 4 });
    expect(squeezed.workers).toBe(1);
    expect(squeezed.reason).toMatch(/reduced to 1/);
  });

  it("runs one at a time when it cannot read the memory, rather than assuming there is plenty", () => {
    const p = planConcurrency({ model, mem: null, workersUp: 4 });
    expect(p).toMatchObject({ workers: 1, verifier: 1, slots: 1 });
    expect(p.reason).toMatch(/could not read/);
  });

  it("reports a concurrency of 1 rather than 0 when no worker is up", () => {
    // The run is about to fail on the first request with a message naming `sidecrew serve`. A
    // concurrency of 0 in the result of a run that never ran explains less than that message does.
    expect(planConcurrency({ model, mem: mem(17.8), workersUp: 0 }).workers).toBe(1);
  });
});

describe("the verifier's default concurrency", () => {
  it("is the same number as the run's, not a second copy of it", () => {
    expect(DEFAULT_STRYKER_CONCURRENCY).toBe(DEFAULT_VERIFIER_CONCURRENCY);
  });
});
