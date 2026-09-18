// How much of this machine one run may use, decided at the instant the run starts.
//
// `max_concurrency_32gb` used to be a field in `models.json`, and ADR-0009 deleted it: a number that
// names a RAM size in its own key is a tier baked into a config file. The replacement is this
// function. Installed RAM picks the tier (`models.ts`); free RAM picks the concurrency, because
// between the two there is Xcode, a simulator and a browser, and on the baseline machine those swing
// free memory by 8 GB (ADR-0008, ADR-0011).
//
// Two numbers come out, and they come out together on purpose. Worker concurrency and Stryker
// concurrency were separate constants at the end of Phase 2 — 2 in `models.json`'s comment and 2 in
// `DEFAULT_STRYKER_CONCURRENCY` — which is two places to be wrong and no relationship between them.
// They multiply: `workers` candidates in flight, each verified by up to `verifier` test processes.
import type { Memory } from "./doctor.js";
import type { ModelEntry } from "./models.js";
import { SERVE_HEADROOM_GB } from "./serve.js";

/**
 * What free RAM is measured in here: one worker's footprint plus the headroom `serve` already demands
 * of itself (ADR-0011's gate). It is a *proxy* for the cost of an in-flight candidate, and the proxy
 * is deliberately conservative — the worker's footprint is the only per-process memory figure this
 * project has actually measured, and a verifier process tree (Stryker forking vitest, or `swift build`)
 * has never been put on a scale. Measuring it is in BACKLOG; inventing a number for it is not.
 */
export const slotGb = (model: ModelEntry): number => model.ram_gb + SERVE_HEADROOM_GB;

/** Two candidates in flight, or one candidate verified by two processes. Phase 2 measured with this. */
export const DEFAULT_VERIFIER_CONCURRENCY = 2;

/**
 * How many `api`-tier candidates are generated at once (ADR-0045 §5: bounded by the rate limit rather
 * than by RAM, and still the run's to pick — ADR-0044 §3).
 *
 * Two, because generation on this tier is an HTTP request that occupies no memory on this machine, and
 * because a number that saturates somebody's rate limit by default is a worse failure than a run that
 * takes longer. `--concurrency` raises it.
 */
export const DEFAULT_API_CONCURRENCY = 2;

/**
 * The api tier's two numbers, and they are bounded by *different things* — which is the whole reason
 * this is not `planConcurrency` with a flag.
 *
 * On the local tier both numbers come out of free RAM, because the worker is resident. On the api tier
 * the worker is a network call and uses none, so the rate limit bounds it. What does **not** change is
 * the gate: verification is 70–80 % of a candidate's cost (VISION.md, measured) and it runs here, on
 * the smallest machine sidecrew supports — by definition, since this tier is what a machine gets when
 * it has under 24 GB installed.
 *
 * So `verifier` is **1**, and it is 1 rather than a computed number for a reason `slotGb`'s docstring
 * already gives: a verifier process tree has never been put on a scale. There is no measured footprint
 * to divide free RAM by, and inventing one to look sophisticated on the machine least able to absorb a
 * wrong guess is the wrong trade. Measuring it is what would let this rise.
 */
export function planApiConcurrency(opts: { mem: Memory | null; requested?: number }): ConcurrencyPlan {
  const ceiling = opts.requested === undefined ? DEFAULT_API_CONCURRENCY : Math.max(1, Math.trunc(opts.requested));
  const workers = ceiling;
  const free_gb = opts.mem?.free_gb ?? 0;

  const reason =
    `api tier: ${workers} candidate${workers === 1 ? "" : "s"} in flight, bounded by the rate limit rather than by RAM ` +
    `(the worker is a network call)${opts.requested === undefined ? "" : " — --concurrency"}; ` +
    "1 test process each, because the gate still runs on this machine and its footprint is unmeasured";

  return { workers, verifier: 1, slots: workers, free_gb, slot_gb: 0, reason };
}

export interface ConcurrencyPlan {
  /** Candidates in flight at once. One in-flight request per worker process (non-negotiable #4). */
  workers: number;
  /** Test processes per verification — Stryker's `concurrency`. Muter has no equivalent. */
  verifier: number;
  /** Worker-sized units of free RAM at the moment this was computed. */
  slots: number;
  free_gb: number;
  slot_gb: number;
  /** One sentence, for `BatchResult` and for the human reading why their run is serial. */
  reason: string;
}

export interface PlanConcurrencyOpts {
  model: ModelEntry;
  /** null when this machine's memory could not be read at all. */
  mem: Memory | null;
  /** Worker processes answering right now. Parallelism comes from several of them, never from batching one (ADR-0003). */
  workersUp: number;
  /** `--concurrency N`. A ceiling, never a floor: it cannot talk the machine into memory it does not have. */
  requested?: number;
}

/**
 * The invariant is `workers × verifier ≤ slots`: what is in flight times what each one forks stays
 * inside what free RAM affords. Everything else here is clamping that to reality.
 *
 * Worked, on the baseline M2 Pro with one 7B worker up and 17.8 GB free: `slotGb` is 6.5, so `slots`
 * is 2; one worker is up, so `workers` is 1 and `verifier` gets the other slot — which is exactly the
 * 2 that Phase 2's `DEFAULT_STRYKER_CONCURRENCY` was measured at, arrived at rather than assumed. With
 * a second worker up, the same machine runs two candidates in flight and verifies each serially.
 */
export function planConcurrency(opts: PlanConcurrencyOpts): ConcurrencyPlan {
  const slot_gb = slotGb(opts.model);
  const free_gb = opts.mem?.free_gb ?? 0;

  // No reading of memory is not permission to assume there is plenty. One of everything, and say why.
  const slots = opts.mem === null ? 1 : Math.max(1, Math.floor(free_gb / slot_gb));

  const ceiling = opts.requested === undefined ? Number.POSITIVE_INFINITY : Math.max(1, Math.trunc(opts.requested));
  // `workersUp` of 0 still yields 1: a batch with no worker is about to fail on the first request with
  // a message that names `sidecrew serve`, and reporting a concurrency of 0 in the result of a run
  // that never ran would be a worse explanation than the one it is going to get.
  const workers = Math.max(1, Math.min(ceiling, Math.max(1, opts.workersUp), slots));
  const verifier = Math.max(1, Math.floor(slots / workers));

  const why = (): string => {
    if (opts.mem === null) return "could not read this machine's memory — running one candidate at a time";
    const budget = `${free_gb.toFixed(1)} GB free ÷ ${slot_gb.toFixed(1)} GB per slot = ${slots}`;
    if (opts.requested !== undefined && workers === ceiling && ceiling <= slots) return `${budget}; --concurrency ${ceiling}`;
    if (opts.requested !== undefined && ceiling > workers) return `${budget}; --concurrency ${ceiling} reduced to ${workers}`;
    if (workers < slots && opts.workersUp <= workers) {
      return `${budget}; ${opts.workersUp} worker${opts.workersUp === 1 ? "" : "s"} up, so ${workers} in flight and ${verifier} test process${verifier === 1 ? "" : "es"} each`;
    }
    return `${budget}; ${workers} in flight × ${verifier} test process${verifier === 1 ? "" : "es"}`;
  };

  return { workers, verifier, slots, free_gb, slot_gb, reason: why() };
}
