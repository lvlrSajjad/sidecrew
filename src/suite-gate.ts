// Memory admission control for workload #2a's gate — V1-CHALLENGES §11 item 3, and the defect that cost most of
// Phase 14d's first night (`prompts/phase-14d-retrieval.md`, note of 25 Sep ~05:30).
//
// `planConcurrency` sizes the run by the *worker's* footprint, the only per-process figure this project had
// measured. The gate's own cost is the project's suite, and on project-a one suite is **11 jest workers, ~8.2 GB**.
// Two of those beside two 7B workers and `tsc` swapped a 32 GB machine to 26–30 GB and turned 9 of 11 candidates
// into timeouts — machine failures that read like results. And the "thermal back-off" then fired on the
// swap-slowed token rate and called it heat.
//
// So: **measure one suite's footprint while the baseline runs** (free memory before, minus the lowest free
// memory during), **admit only as many suites at once as that leaves room for**, and **back off by name on
// memory** — pressure above normal, or swap growing — rather than inferring it from token rates. Generation is
// not limited: two workers can keep drafting while one suite runs, which is where concurrency still pays.
import type { MachineSample, VerdictMachine } from "./schemas.js";
import { readMemory } from "./doctor.js";

/** Head-room kept free beside the suites, in GB — the same margin `serve` keeps (ADR-0011). */
export const SUITE_HEADROOM_GB = 2;
/** A suite's measured footprint is inflated by this before dividing, because a candidate's suite can be larger. */
export const SUITE_FOOTPRINT_MARGIN = 1.25;
/** Swap growth, in GB, across one verdict that counts as the machine swapping (ADR-0066's damaging condition). */
export const SWAP_GROWTH_BACKOFF_GB = 2;

/** A counting semaphore over the project's suite, with a capacity that can only be lowered mid-run. */
export class SuiteGate {
  private active = 0;
  private waiting: (() => void)[] = [];

  public constructor(private cap: number) {
    this.cap = Math.max(1, Math.trunc(cap));
  }

  public get capacity(): number {
    return this.cap;
  }

  /** Lower the ceiling (never raise it mid-run: a back-off that undoes itself is how thrashing oscillates). */
  public lower(to: number): boolean {
    const next = Math.max(1, Math.trunc(to));
    if (next >= this.cap) return false;
    this.cap = next;
    return true;
  }

  public async run<T>(job: () => Promise<T>): Promise<T> {
    while (this.active >= this.cap) await new Promise<void>((r) => this.waiting.push(r));
    this.active += 1;
    try {
      return await job();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

/**
 * Run `job` while sampling free memory; the footprint is how far free memory fell below where it started.
 * `null` when memory cannot be read here — then nothing is admitted on a guess, and the caller keeps its plan.
 */
export async function measureFootprint<T>(job: () => Promise<T>, everyMs = 2_000, read = readMemory): Promise<{ result: T; footprint_gb: number | null }> {
  const start = await read();
  if (start === null) return { result: await job(), footprint_gb: null };
  let lowest = start.free_gb;
  let stop = false;
  const sampler = (async () => {
    while (!stop) {
      await new Promise((r) => setTimeout(r, everyMs));
      const m = await read();
      if (m !== null) lowest = Math.min(lowest, m.free_gb);
    }
  })();
  try {
    return { result: await job(), footprint_gb: Math.max(0, start.free_gb - lowest) };
  } finally {
    stop = true;
    await sampler;
  }
}

/** How many suites fit in `freeGb` beside the headroom, at least one — a run always makes progress. */
export const suiteSlots = (freeGb: number, footprintGb: number): number =>
  footprintGb <= 0 ? Number.POSITIVE_INFINITY
    : Math.max(1, Math.floor((freeGb - SUITE_HEADROOM_GB) / (footprintGb * SUITE_FOOTPRINT_MARGIN)));

/** The reason to back off on memory after a verdict, named — or null when the machine stayed comfortable. */
export function memoryBackOffReason(machine: VerdictMachine | null): string | null {
  if (machine === null) return null;
  const worst = (s: MachineSample) => s.pressure;
  const pressure = [worst(machine.before), worst(machine.after)].find((p) => p === "warn" || p === "critical");
  if (pressure !== undefined) return `memory pressure was ${pressure} during a verdict`;
  const before = machine.before.swap_gb;
  const after = machine.after.swap_gb;
  if (before !== null && after !== null && after - before > SWAP_GROWTH_BACKOFF_GB) {
    return `swap grew ${(after - before).toFixed(1)} GB during one verdict — the machine is swapping (ADR-0066)`;
  }
  return null;
}
