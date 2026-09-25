// Memory admission control (src/suite-gate.ts): the 25 Sep night lost 9 of 11 candidates to two project suites
// swapping a 32 GB machine. These pin the pieces that stop that happening again.
import { describe, expect, it } from "vitest";
import { measureFootprint, memoryBackOffReason, SuiteGate, suiteSlots, SUITE_HEADROOM_GB } from "../src/suite-gate.js";

const sample = (pressure: "normal" | "warn" | "critical" | "unknown", swap: number | null) =>
  ({ pressure, free_gb: 10, swap_gb: swap, compressed_gb: 1 });

describe("SuiteGate", () => {
  it("never lets more suites run at once than its capacity", async () => {
    const gate = new SuiteGate(2);
    let live = 0;
    let peak = 0;
    const job = () => gate.run(async () => {
      live += 1; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
    });
    await Promise.all(Array.from({ length: 6 }, job));
    expect(peak).toBe(2);
  });

  it("only ever lowers its capacity, and never below one", () => {
    const gate = new SuiteGate(2);
    expect(gate.lower(3)).toBe(false);
    expect(gate.lower(1)).toBe(true);
    expect(gate.lower(0)).toBe(false);
    expect(gate.capacity).toBe(1);
  });

  it("releases a slot when the job throws", async () => {
    const gate = new SuiteGate(1);
    await expect(gate.run(async () => { throw new Error("suite broke"); })).rejects.toThrow("suite broke");
    await expect(gate.run(async () => 7)).resolves.toBe(7);
  });
});

describe("measureFootprint", () => {
  it("reports how far free memory fell while the job ran", async () => {
    const readings = [20, 18, 12.5, 14, 19];
    let i = 0;
    const read = async () => ({ total_gb: 32, free_gb: readings[Math.min(i++, readings.length - 1)]! });
    const { result, footprint_gb } = await measureFootprint(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return "ok";
    }, 5, read);
    expect(result).toBe("ok");
    expect(footprint_gb).toBeCloseTo(7.5, 5);
  });

  it("admits nothing on a guess when memory cannot be read", async () => {
    expect((await measureFootprint(async () => 1, 5, async () => null)).footprint_gb).toBeNull();
  });
});

describe("suiteSlots", () => {
  it("fits suites into free memory beside the headroom, and always at least one", () => {
    // 25 Sep: ~8.2 GB per project-a suite, ~13 GB free with two 7B workers up → one suite at a time.
    expect(suiteSlots(13, 8.2)).toBe(1);
    expect(suiteSlots(40, 8.2)).toBe(Math.floor((40 - SUITE_HEADROOM_GB) / (8.2 * 1.25)));
    expect(suiteSlots(1, 8.2)).toBe(1);
  });
});

describe("memoryBackOffReason", () => {
  it("names pressure and swap growth, and stays quiet on a comfortable machine", () => {
    expect(memoryBackOffReason({ before: sample("normal", 6), after: sample("warn", 7) })).toMatch(/pressure was warn/);
    expect(memoryBackOffReason({ before: sample("normal", 6), after: sample("normal", 25.8) })).toMatch(/swap grew 19\.8 GB/);
    expect(memoryBackOffReason({ before: sample("normal", 9), after: sample("normal", 10) })).toBeNull();
    expect(memoryBackOffReason(null)).toBeNull();
  });
});
