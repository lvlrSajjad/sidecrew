// Real probes against whatever this machine actually has. SIDECREW_SLOW=1 to run.
import { describe, it, expect } from "vitest";
import { collect, exitCodeFor, toStatusReport } from "../src/doctor.js";
import { CapabilityStatus, StatusReport } from "../src/schemas.js";

describe("collect", () => {
  it("reports every row doctor promises, each ok / degraded / missing", async () => {
    const { checks, memory, port } = await collect();
    // `jest` and `stryker-runner` joined this list in Phase 9 (ADR-0028) and the expectation was never
    // updated, so this test has been failing on every machine since. `stryker-runner` in particular is
    // the row that exists *because* a missing runner plugin kills the mutation stage minutes in with an
    // error about Stryker rather than about the test — the exact thing doctor is for.
    expect(checks.map((c) => c.name)).toEqual(
      ["node", "mlx_lm", "worker", "memory", "tsc", "vitest", "jest", "stryker", "stryker-runner", "swift", "muter"],
    );
    for (const c of checks) {
      expect(CapabilityStatus.parse(c.status)).toBe(c.status);
      expect(c.detail.length, `${c.name} says nothing`).toBeGreaterThan(0);
    }
    // This repo has typescript and vitest in devDependencies, so those two must be found.
    expect(checks.find((c) => c.name === "tsc")?.status).toBe("ok");
    expect(checks.find((c) => c.name === "vitest")?.status).toBe("ok");
    // The suite is running, so node is fine; only memory can legitimately fail this machine.
    expect(checks.find((c) => c.name === "node")?.status).toBe("ok");
    expect(exitCodeFor(checks)).toBe(checks.find((c) => c.name === "memory")?.status === "missing" ? 1 : 0);
    expect(StatusReport.safeParse(toStatusReport(checks, memory, port)).success).toBe(true);
  }, 180_000);
});
