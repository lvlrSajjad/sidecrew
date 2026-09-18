// Thermal back-off: when the machine sags, run fewer candidates at once (research §E, ADR-0025).
//
// A sustained batch on a laptop M2 Pro throttles. The failure it produces is not an error — every
// candidate still generates, still verifies, still survives or does not — it is a run that takes twice as
// long and a `latency_ms` column that describes a hot machine rather than a model. Non-negotiable #5 is
// about memory; this is the other resource that degrades silently.
//
// Three choices here, and the first is the one that keeps this honest:
//
//   * **The baseline is measured, or the guard is off.** `sidecrew bench` writes `decode_tok_s` per model
//     with the machine it came from. Without one there is nothing to be 30 % below, and inventing a
//     baseline from the first few tasks of the run would make the guard fire on a cold graph compile —
//     which is exactly what the bench's warm-up request exists to exclude. No bench, no guard, and the
//     run says so in one line rather than pretending.
//   * **Decode rate, not wall clock.** A task's wall time includes the verifier, which is 90 % of it on
//     TypeScript and is bound by Stryker rather than by the GPU. `(completion_tokens - 1) / decode_ms` is
//     the same quantity the bench measured, taken from the same field.
//   * **Two minutes of it, then one step.** One slow candidate is a long prompt or a page fault. The guard
//     has to have been watching for a whole window before it may act, and a back-off resets that clock, so
//     the second step costs another two minutes of evidence rather than arriving on the next sample.
//
// What it measures, stated precisely, because the looser phrasing promises more than it delivers: the
// **median of the trailing two-minute window**, once the guard has been watching for at least that long.
// Not "every sample for two minutes" — one fast candidate in the middle of a sag should not reset
// anything — so a machine that sags from a standing start trips it after roughly *one* window of sag
// rather than two, which is when half the window is slow. That is the standard shape of a rolling alarm
// and it is what the tests pin.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** More than this far below the bench baseline is a sag rather than variance. Research §E's rule. */
export const THERMAL_DROP = 0.3;

/** How long it has to stay there. */
export const THERMAL_WINDOW_MS = 120_000;

/**
 * Samples needed before a window counts.
 *
 * Three, because a Swift candidate takes ~40 s end to end and a two-minute window therefore holds
 * exactly three. A higher floor would make the guard TypeScript-only, and Swift is the configuration that
 * spends longest on the machine.
 */
export const THERMAL_MIN_SAMPLES = 3;

export interface ThermalSample {
  at: number;
  tok_s: number;
}

export interface BackOff {
  at: string;
  from: number;
  to: number;
  baseline_tok_s: number;
  observed_tok_s: number;
  samples: number;
  window_ms: number;
  reason: string;
}

export const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : ((s[mid - 1]! + s[mid]!) / 2);
};

export interface ThermalOpts {
  /** tok/s this model reached on this machine when it was cool. null disables the guard. */
  baseline: number | null;
  /** Where to start. Never raised — this only ever takes slots away. */
  concurrency: number;
  windowMs?: number;
  drop?: number;
  minSamples?: number;
}

/**
 * A rolling window of decode rates, and the one action it is allowed to take.
 *
 * Concurrency only ever goes down, and never below 1. Recovery is deliberately not implemented: a
 * machine that cooled off enough to take the slot back is a machine whose next sustained stretch will
 * heat it again, and a guard that oscillates costs more in restarted work than the slot was worth. The
 * next run re-reads free RAM and starts from the top.
 */
export class ThermalGuard {
  private samples: ThermalSample[] = [];
  /** When this guard last started collecting — at the first sample, and again after every back-off. */
  private firstAt: number | null = null;
  private current: number;
  private readonly backOffs: BackOff[] = [];

  public constructor(private readonly opts: ThermalOpts) {
    this.current = Math.max(1, opts.concurrency);
  }

  public get concurrency(): number {
    return this.current;
  }

  public get events(): BackOff[] {
    return [...this.backOffs];
  }

  /** True when this sample caused a back-off, so the caller can log the event it just produced. */
  public observe(tok_s: number | null, at = Date.now()): boolean {
    if (this.opts.baseline === null || tok_s === null || !Number.isFinite(tok_s) || tok_s <= 0) return false;

    const windowMs = this.opts.windowMs ?? THERMAL_WINDOW_MS;
    this.firstAt ??= at;
    this.samples.push({ at, tok_s });
    this.samples = this.samples.filter((s) => at - s.at <= windowMs);

    // Two conditions, and they are not the same one twice. `samples` is the trailing window and is what
    // the median is taken over; `firstAt` is how long this guard has been watching, and is what stops it
    // firing before it has had a window's worth of machine to look at. Asking only "does the retained
    // window span two minutes" does not work: the filter drops everything older than the window, so a
    // sample two minutes and one second ago is gone and the retained span is whatever the sample spacing
    // happens to make it. At ~25 s per TypeScript candidate that is 100 s, and the guard never fires.
    const observedFor = at - this.firstAt;
    if (this.samples.length < (this.opts.minSamples ?? THERMAL_MIN_SAMPLES) || observedFor < windowMs) return false;

    const floor = this.opts.baseline * (1 - (this.opts.drop ?? THERMAL_DROP));
    const observed = median(this.samples.map((s) => s.tok_s));
    if (observed >= floor) return false;
    if (this.current <= 1) return false;

    const from = this.current;
    this.current = from - 1;
    this.backOffs.push({
      at: new Date(at).toISOString(),
      from,
      to: this.current,
      baseline_tok_s: Number(this.opts.baseline.toFixed(1)),
      observed_tok_s: Number(observed.toFixed(1)),
      samples: this.samples.length,
      window_ms: windowMs,
      reason:
        `${observed.toFixed(1)} tok/s median over ${Math.round(windowMs / 1000)}s against a bench baseline of ` +
        `${this.opts.baseline.toFixed(1)} — more than ${Math.round((this.opts.drop ?? THERMAL_DROP) * 100)} % down, ` +
        `so concurrency ${from} → ${this.current} (research §E)`,
    });
    // A fresh window, so the next step down costs another two minutes of evidence rather than arriving
    // on the very next sample.
    this.samples = [];
    this.firstAt = null;
    return true;
  }
}

// ── the baseline ──────────────────────────────────────────────────────────────────────────────────

export interface Baseline {
  tok_s: number;
  /** The results file it came from, so a number in a log can be looked up. */
  source: string;
}

interface BenchFileShape {
  created?: unknown;
  models?: { key?: unknown; decode_tok_s?: unknown; trustworthy?: unknown }[];
}

/**
 * The most recent trustworthy `decode_tok_s` for a model key, from `experiments/go-no-go/results/`.
 *
 * `trustworthy` is `bench`'s own flag for a run that swapped past the noise floor (ADR-0011): a baseline
 * taken while the machine was thrashing is low, and a low baseline makes the thermal guard blind to
 * exactly the condition it exists to catch. Files are read newest-first by name, which sorts by date
 * because that is how `bench` names them.
 */
export async function benchBaseline(modelKey: string, dir: string): Promise<Baseline | null> {
  const names = (await readdir(dir).catch(() => [] as string[]))
    .filter((n) => n.startsWith("bench-") && n.endsWith(".json"))
    .sort()
    .reverse();

  for (const name of names) {
    let parsed: BenchFileShape;
    try {
      parsed = JSON.parse(await readFile(join(dir, name), "utf8")) as BenchFileShape;
    } catch {
      continue;
    }
    for (const m of parsed.models ?? []) {
      if (m.key !== modelKey || m.trustworthy === false) continue;
      if (typeof m.decode_tok_s === "number" && m.decode_tok_s > 0) return { tok_s: m.decode_tok_s, source: join(dir, name) };
    }
  }
  return null;
}
