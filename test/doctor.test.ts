import { describe, it, expect } from "vitest";
import {
  type Check, exitCodeFor, parseMemory, probeWorker, render, toStatusReport, baseUrlFor,
} from "../src/doctor.js";
import { StatusReport } from "../src/schemas.js";

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    41558.
Pages active:                                 515088.
Pages inactive:                               506991.
Pages speculative:                              7534.
Pages throttled:                                   0.
Pages wired down:                             471215.
Pages purgeable:                               23924.
"Translation faults":                       92600265.
`;

describe("parseMemory", () => {
  it("counts the pages the kernel can hand over without swapping", () => {
    const mem = parseMemory("34359738368\n", VM_STAT);
    // free + inactive + speculative + purgeable = 580007 pages × 16 KiB.
    expect(mem?.total_gb).toBeCloseTo(32, 3);
    expect(mem?.free_gb).toBeCloseTo((41558 + 506991 + 7534 + 23924) * 16384 / 1024 ** 3, 3);
  });

  it("does not count active or wired pages as free", () => {
    const mem = parseMemory("34359738368\n", VM_STAT)!;
    expect(mem.free_gb).toBeLessThan(mem.total_gb / 2);
  });

  it("returns null rather than a guess when either probe is unreadable", () => {
    expect(parseMemory("", VM_STAT)).toBeNull();
    expect(parseMemory("34359738368", "not vm_stat output")).toBeNull();
    expect(parseMemory("34359738368", "(page size of 16384 bytes)\nPages free: 10.\n")).toBeNull();
  });
});

const check = (name: string, status: Check["status"]): Check => ({ name, status, detail: `${name} detail` });

describe("exitCodeFor", () => {
  it("fails on node or memory and on nothing else", () => {
    expect(exitCodeFor([check("node", "missing")])).toBe(1);
    expect(exitCodeFor([check("memory", "missing")])).toBe(1);
    expect(exitCodeFor([check("mlx_lm", "missing"), check("swift", "missing"), check("stryker", "missing")])).toBe(0);
  });

  it("treats degraded memory as a smaller machine, not a broken one", () => {
    expect(exitCodeFor([check("memory", "degraded")])).toBe(0);
  });
});

describe("render", () => {
  const rows = [check("node", "ok"), check("memory", "degraded"), check("muter", "missing")];

  it("puts one padded row per capability first", () => {
    const lines = render(rows).split("\n");
    expect(lines[0]).toMatch(/^ok\s+node\s+node detail$/);
    expect(lines[1]).toMatch(/^DEGRADED memory\s+/);
    expect(lines[2]).toMatch(/^MISSING\s+muter\s+/);
  });

  it("summarises what is unavailable without calling it a failure", () => {
    expect(render(rows)).toContain("2 capabilities unavailable");
    expect(render(rows)).not.toContain("No worker can run");
  });

  it("says plainly when node or memory is what is wrong", () => {
    expect(render([check("memory", "missing")])).toContain("No worker can run on this machine yet");
  });

  it("agrees with itself about singular capabilities", () => {
    expect(render([check("muter", "missing")])).toContain("1 capability unavailable");
  });
});

describe("toStatusReport", () => {
  it("produces something that satisfies the StatusReport contract", () => {
    const checks = [check("node", "ok"), check("worker", "ok"), check("memory", "ok"), check("stryker", "missing")];
    const report = toStatusReport(checks, { total_gb: 32, free_gb: 9.1 }, 8000);
    expect(StatusReport.parse(report)).toEqual(report);
    expect(report.worker.up).toBe(true);
    expect(report.worker.base_url).toBe(baseUrlFor(8000));
    // node and memory are their own fields, not capability rows.
    expect(Object.keys(report.capabilities)).toEqual(["stryker"]);
  });
});

describe("probeWorker", () => {
  it("reports a closed port as down with the command that opens it", async () => {
    // Port 1 is privileged and unbound; the connection is refused rather than hanging.
    const probe = await probeWorker(1, 500);
    expect(probe.up).toBe(false);
    expect(probe.model).toBeNull();
    expect(probe.detail).toContain("sidecrew serve");
  });
});
