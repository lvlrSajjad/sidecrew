// The whole loop, for real: a live worker generates, Stryker mutates, and a `BatchResult` comes back.
// SIDECREW_SLOW=1 to include. Needs `sidecrew serve` and `npm i` in fixtures/ts-fixture.
import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import { discoverWorkers, portsFromEnv, runBatch } from "../src/batch.js";
import { readEscalations } from "../src/escalate.js";
import { loadPlan } from "../src/plan.js";
import { BatchResult } from "../src/schemas.js";

const PLAN = "fixtures/ts-fixture/plans/strings/test_plan.json";
const DIR = `.sidecrew-slow-${process.pid}`;

afterAll(async () => { await rm(DIR, { recursive: true, force: true }); });

describe("runBatch on the fixture", () => {
  it("needs a worker, and says so rather than failing obscurely", async () => {
    const workers = await discoverWorkers(portsFromEnv());
    expect(workers.length, "start one with: sidecrew serve").toBeGreaterThan(0);
  });

  it(
    "generates, verifies and returns only what survived",
    { timeout: 30 * 60_000 },
    async () => {
      const result = await runBatch(PLAN, { dir: DIR });

      // It came back through the schema, so `claude_tokens.workers` is 0 by construction on this tier
      // and no survivor is claiming a survival its own verdict does not support.
      expect(() => BatchResult.parse(result)).not.toThrow();
      expect(result.config.worker_kind).toBe("local");
      expect(result.stats.claude_tokens.workers).toBe(0);
      // From the plan rather than hard-coded: the plan is the planner's to change, and a number here
      // that has to be edited every time it does is a test about a constant, not about the run.
      const plan = await loadPlan(PLAN);
      expect(result.stats.tasks).toBe(plan.plan.functions.reduce((n, f) => n + f.shapes.length, 0));
      expect(result.stats.survived + result.stats.escalated).toBe(result.stats.tasks);

      // Files are the IPC: every artefact the pipeline produced is on disk under the run id.
      const runDir = join(DIR, "runs", result.run_id);
      expect(existsSync(join(runDir, "result.json"))).toBe(true);
      for (const survivor of result.survivors) {
        expect(existsSync(survivor.test_path)).toBe(true);
        const verdict = JSON.parse(await readFile(join(runDir, "verdicts", `${survivor.task_id.replace(/:/g, ".")}.json`), "utf8")) as { survived: boolean };
        expect(verdict.survived).toBe(true);
      }

      // The point of the whole thing: a survivor killed a mutant of its own function.
      for (const survivor of result.survivors) expect(survivor.mutation_score).toBeGreaterThan(0);

      // The queue is written as the run goes and `result.json` at the end, so on a run that finished the
      // two have to say the same thing (ADR-0023). A disagreement means one of them is not being written
      // where it is claimed to be, which only shows up on the run that dies — too late to find out then.
      const queued = await readEscalations(runDir);
      expect(queued.map((e) => e.task_id).sort()).toEqual(result.escalations.map((e) => e.task_id).sort());
      for (const e of queued) expect(e.attempts.length).toBeGreaterThan(0);
    },
  );
});
