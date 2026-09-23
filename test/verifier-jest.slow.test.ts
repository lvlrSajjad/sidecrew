// The Jest runner, for real: Stryker's jest-runner mutating the fixture. ADR-0028.
// SIDECREW_SLOW=1 to include. Needs `npm install` in fixtures/jest-fixture, for the project's own jest, and `sidecrew tools install` (ADR-0088).
//
// The fast tests cover the command and the config; what only a real run can answer is whether Stryker
// can drive Jest at all on this project shape — which is the question the whole ADR exists for, and
// which failed the first time it was asked (ts-jest type-checking Stryker's own instrumentation).
import { describe, it, expect } from "vitest";
import { verifyTs } from "../src/verifier/ts.js";
import type { Candidate } from "../src/schemas.js";
import { readFileSync } from "node:fs";

const FIXTURE = "fixtures/jest-fixture";

const candidate = (task_id: string, file: string): Candidate => ({
  task_id,
  worker: { kind: "local", model: `file:${file}`, revision: "", temperature: 0, seed: 0 },
  test_source: readFileSync(`${FIXTURE}/${file}`, "utf8"),
  usage: { prompt_tokens: 0, completion_tokens: 0 },
  timing: { ttft_ms: 0, wall_ms: 0 },
});

describe("verifyTs with the jest runner", () => {
  it(
    "survives a real test — compiled, passed, killed a mutant of the function under test",
    { timeout: 10 * 60_000 },
    async () => {
      const verdict = await verifyTs(candidate("commonPrefix:boundary:0", "legitimate/boundary.test.ts"), {
        target: { projectDir: FIXTURE, sourceFile: "src/strings.ts", functionName: "commonPrefix", runner: "jest" },
        concurrency: 1,
      });
      expect(verdict.compile_ok, verdict.error ?? "").toBe(true);
      expect(verdict.pass_ok, verdict.error ?? "").toBe(true);
      expect(verdict.tautological).toBe(false);
      expect(verdict.stage_reached).toBe("done");
      // The point: Stryker drove jest and something died.
      expect(verdict.mutation?.killed ?? 0).toBeGreaterThan(0);
      expect(verdict.survived).toBe(true);
    },
  );

  it(
    "mutates a project whose ts-jest type-checks, without changing the project — ADR-0036",
    { timeout: 10 * 60_000 },
    async () => {
      // `jest.diagnostics-on.config.js` is ts-jest at its own default, which is what a stock NestJS
      // project has. Before the shim this produced no mutation report at all: ts-jest type-checked
      // Stryker's instrumentation and the dry run died on `Cannot assign to 'stryMutAct_9fa48'`.
      const verdict = await verifyTs(candidate("commonPrefix:boundary:0", "legitimate/boundary.test.ts"), {
        target: {
          projectDir: FIXTURE, sourceFile: "src/strings.ts", functionName: "commonPrefix",
          runner: "jest", jestConfig: "jest.diagnostics-on.config.js",
        },
        concurrency: 1,
      });
      expect(verdict.stage_reached, verdict.error ?? "").toBe("done");
      expect(verdict.survived).toBe(true);
      // The claim is not "it runs" but "it runs and decides the same thing". Turning ts-jest's
      // diagnostics off removes a third type check; `tsc --noEmit` and Stryker's checker both remain.
      expect(verdict.mutation).toMatchObject({ score: 0.7, killed: 5, survived: 3, timeout: 2, no_coverage: 0 });
      expect(verdict.mutation?.killed_ids).toEqual(["2", "6", "7", "8", "10"]);
    },
  );

  it(
    "fails a tautology before the mutation stage costs anything",
    { timeout: 10 * 60_000 },
    async () => {
      const verdict = await verifyTs(candidate("commonPrefix:boundary:0", "legitimate/tautological.test.ts"), {
        target: { projectDir: FIXTURE, sourceFile: "src/strings.ts", functionName: "commonPrefix", runner: "jest" },
        concurrency: 1,
      });
      expect(verdict.tautological).toBe(true);
      expect(verdict.survived).toBe(false);
      // Short-circuited: the detector runs first and for free, so the expensive stage never ran.
      expect(verdict.timing_ms.mutation).toBeUndefined();
    },
  );

  it("refuses a project with no runner of its own, as a setup error rather than a verdict", async () => {
    // "your toolchain is missing" and "your test is bad" must never reach the retry loop wearing the
    // same clothes. ts-fixture runs vitest and has no jest. The runner *plugin* is sidecrew's own now
    // (ADR-0088), so what is missing is the project's jest, and that is what the refusal names.
    await expect(verifyTs(candidate("commonPrefix:boundary:0", "legitimate/boundary.test.ts"), {
      target: { projectDir: "fixtures/ts-fixture", sourceFile: "src/strings.ts", functionName: "commonPrefix", runner: "jest" },
    })).rejects.toThrow(/no jest of its own/);
  });
});
