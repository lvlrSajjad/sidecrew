// Does an M2 Pro actually sag under a sustained sidecrew workload, and does the guard notice?
// `npm run measure:thermal -- [--minutes 20] [--model KEY] [--concurrency 2] [--tag NAME]`
//
// ADR-0025 shipped a thermal back-off that had never fired, because the machine did not sag during any
// run this project had done. "Untested against the thing it exists for" is a fair thing to write in a
// phase note and a bad thing to leave in a published package, so this is the experiment that closes it.
//
// It measures **two different claims**, and keeping them apart is the whole design:
//
//   1. *Does the machine sag?* Decode rate per request over a long sustained soak, against the bench
//      baseline for the same model on the same machine. This is a fact about an M2 Pro and research §E's
//      thermal-throttling risk, and it is the one nobody has measured.
//   2. *Does the guard react correctly to what the machine did?* A real `ThermalGuard` consumes the real
//      samples as they arrive — not a replay, not a fixture. Whatever it does here, it did to this
//      machine's actual behaviour.
//
// A null result is a result and is reported as one. If the machine holds its rate for twenty minutes,
// the honest output is "research §E's risk did not reproduce on this machine under these conditions",
// and the guard not firing is then the **correct** behaviour rather than an untested one — which is a
// different and much weaker statement than "the guard works", and the report says so in as many words.
//
// Why the workload is the bench prompt rather than a real plan: a `sidecrew run` spends ~90 % of its wall
// clock in the verifier (Stryker forking vitest), which loads the CPU rather than the GPU and would
// leave the worker idle for most of the soak. The thing being asked to sag is the model, so the soak
// keeps it generating continuously — a harsher test than any real run, and deliberately so.
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  benchPrompt,
  BENCH_MAX_TOKENS,
  BENCH_SEED,
  machineInfo,
  median,
  pageSizeBytes,
  SWAP_NOISE_FLOOR_MB,
  swapouts,
  type MachineInfo,
} from "../src/bench.js";
import { baseUrlFor, DEFAULT_PORT, readMemory, readPressure, type PressureLevel } from "../src/doctor.js";
import { defaultKey, entry, short } from "../src/models.js";
import { readRecord, serve, stop } from "../src/serve.js";
import { benchBaseline, THERMAL_DROP, THERMAL_WINDOW_MS, ThermalGuard, type BackOff } from "../src/throttle.js";
import { complete, decodeTokensPerSecond } from "../src/worker.js";

const RESULTS_DIR = "experiments/thermal/results";

/** Long enough for a laptop to heat-soak. Twenty minutes is ten two-minute windows of evidence. */
const DEFAULT_MINUTES = 20;

/**
 * The concurrency the guard is given to spend.
 *
 * Two, and it is a *hypothetical* on a one-worker soak: the guard's only action is to retire a worker
 * slot, and a run that started at 1 has nothing to give up (`planConcurrency` on this machine with one
 * worker up returns 1). Giving it 2 is what makes "would it have fired" answerable at all, and the
 * result labels it rather than implying a two-worker run happened.
 */
const DEFAULT_CONCURRENCY = 2;

interface Sample {
  /** Seconds since the first measured request. */
  t_s: number;
  decode_tok_s: number | null;
  ttft_ms: number;
  wall_ms: number;
  completion_tokens: number;
  pressure: PressureLevel;
  free_gb: number;
}

interface ThermalReport {
  created: string;
  tag: string | null;
  minutes_requested: number;
  minutes_measured: number;
  machine_before: MachineInfo;
  machine_after: MachineInfo;
  model: { key: string; repo: string; revision: string; pinned: boolean };
  baseline: { tok_s: number; source: string } | null;
  guard: {
    concurrency_at_start: number;
    concurrency_at_end: number;
    drop: number;
    window_ms: number;
    /** The floor the median had to go below: baseline × (1 − drop). */
    floor_tok_s: number | null;
    fired: boolean;
    events: BackOff[];
  };
  observed: {
    requests: number;
    decode_tok_s_first_minute: number | null;
    decode_tok_s_last_minute: number | null;
    decode_tok_s_median: number | null;
    decode_tok_s_min: number | null;
    /** Worst two-minute window, which is the quantity the guard actually tests. */
    worst_window_median_tok_s: number | null;
    /** That window as a fraction of the baseline. Below 1 − drop is a back-off. */
    worst_window_vs_baseline: number | null;
    swapped_out_mb: number;
    trustworthy: boolean;
    pressure_levels: Record<string, number>;
  };
  samples: Sample[];
  verdict: string;
  measured: true;
}

const flag = (name: string): string | undefined => {
  const argv = process.argv.slice(2);
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const next = argv[argv.indexOf(`--${name}`) + 1];
  return next && !next.startsWith("--") ? next : undefined;
};

const num = (name: string, fallback: number): number => {
  const raw = Number(flag(name) ?? NaN);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

/** The median of the worst `windowMs` of samples — what the guard tests, computed over the whole soak. */
const worstWindow = (samples: Sample[], windowMs: number): number | null => {
  const usable = samples.filter((s): s is Sample & { decode_tok_s: number } => s.decode_tok_s !== null);
  let worst: number | null = null;
  for (let i = 0; i < usable.length; i += 1) {
    const end = usable[i]!.t_s * 1000;
    const window = usable.filter((s) => end - s.t_s * 1000 <= windowMs && s.t_s * 1000 <= end);
    // The same two conditions the guard applies, so this column and the guard cannot disagree about
    // what a window is: enough samples, and enough elapsed time for them to be a window.
    if (window.length < 3 || end - window[0]!.t_s * 1000 < windowMs * 0.8) continue;
    const m = median(window.map((s) => s.decode_tok_s));
    if (worst === null || m < worst) worst = m;
  }
  return worst === null ? null : Number(worst.toFixed(1));
};

const meanOfMinute = (samples: Sample[], from: number, to: number): number | null => {
  const inRange = samples.filter((s) => s.t_s >= from && s.t_s < to && s.decode_tok_s !== null);
  return inRange.length === 0 ? null : Number(median(inRange.map((s) => s.decode_tok_s!)).toFixed(1));
};

async function main(): Promise<void> {
  const minutes = num("minutes", DEFAULT_MINUTES);
  const concurrency = num("concurrency", DEFAULT_CONCURRENCY);
  const tag = flag("tag");
  const key = flag("model") ?? defaultKey();
  const model = entry(key);
  const port = DEFAULT_PORT;

  await mkdir(RESULTS_DIR, { recursive: true });
  const path = join(RESULTS_DIR, `thermal-${new Date().toISOString().slice(0, 10)}${tag ? `-${tag}` : ""}.json`);
  // Same rule as `bench`: a measurement does not overwrite a measurement.
  if (existsSync(path)) throw new Error(`${path} already exists — pass --tag <name> to put this run beside it`);

  const existing = await readRecord(port);
  const started = existing === null;
  const record = existing ?? await serve({ modelKey: key, port });
  if (record.model_key !== key) {
    throw new Error(`:${port} is serving ${record.model_key}, not ${key} — stop it first, or pass --model ${record.model_key}`);
  }

  const baseline = await benchBaseline(key, "experiments/go-no-go/results");
  const guard = new ThermalGuard({ baseline: baseline?.tok_s ?? null, concurrency });
  const floor = baseline === null ? null : Number((baseline.tok_s * (1 - THERMAL_DROP)).toFixed(1));

  const prompt = await benchPrompt();
  const baseUrl = baseUrlFor(port);
  const machine_before = await machineInfo(await readMemory());

  process.stdout.write(
    `thermal soak: ${minutes} min · ${key} @ ${short(record.revision)} · ` +
    `${machine_before.on_battery ? "on battery" : "on mains"}, Xcode ${machine_before.xcode_open ? "open" : "closed"}\n` +
    (baseline === null
      ? "  no bench baseline — the guard is off and this run can only report what the machine did\n"
      : `  baseline ${baseline.tok_s} tok/s (${baseline.source}); a back-off needs a 2-min median under ${floor}\n`) +
    `  guard starts at concurrency ${concurrency}${concurrency > 1 ? "" : " — it has no slot to give up, so it cannot fire"}\n`,
  );

  const [swapBefore, pageSize] = await Promise.all([swapouts(), pageSizeBytes()]);

  // One warm-up, excluded, for the same reason `bench` has one: the first generation on a fresh worker
  // pays for graph compilation, and charging that to the soak would make minute one look like a sag.
  await complete({ baseUrl, model: record.model_arg, messages: [{ role: "user", content: "Reply with the single word: ready" }], seed: BENCH_SEED, maxTokens: 16 });

  const samples: Sample[] = [];
  const startedAt = Date.now();
  const deadline = startedAt + minutes * 60_000;
  let announcedAt = 0;

  while (Date.now() < deadline) {
    const c = await complete({
      baseUrl,
      model: record.model_arg,
      messages: [{ role: "user", content: prompt }],
      seed: BENCH_SEED,
      maxTokens: BENCH_MAX_TOKENS,
    });
    const at = Date.now();
    const rate = decodeTokensPerSecond(c);
    const [pressure, mem] = await Promise.all([readPressure(), readMemory()]);

    samples.push({
      t_s: Number(((at - startedAt) / 1000).toFixed(1)),
      decode_tok_s: rate === null ? null : Number(rate.toFixed(1)),
      ttft_ms: Number(c.ttft_ms.toFixed(0)),
      wall_ms: Number(c.wall_ms.toFixed(0)),
      completion_tokens: c.usage.completion_tokens,
      pressure,
      free_gb: Number((mem?.free_gb ?? 0).toFixed(1)),
    });

    // The real guard, on the real samples, at the real times. Not a replay.
    if (guard.observe(rate, at)) process.stdout.write(`  BACK-OFF: ${guard.events.at(-1)!.reason}\n`);

    if (at - announcedAt >= 60_000) {
      announcedAt = at;
      const lastMinute = samples.filter((s) => s.t_s >= (at - startedAt) / 1000 - 60);
      process.stdout.write(
        `  ${Math.round((at - startedAt) / 60_000)} min · ${samples.length} requests · ` +
        `${median(lastMinute.flatMap((s) => (s.decode_tok_s === null ? [] : [s.decode_tok_s]))).toFixed(1)} tok/s median this minute · ` +
        `concurrency ${guard.concurrency}\n`,
      );
    }
  }

  const swapAfter = await swapouts();
  const swapped_out_mb = Number.isFinite(swapAfter) && Number.isFinite(swapBefore)
    ? Number((Math.max(0, swapAfter - swapBefore) * pageSize / 1024 ** 2).toFixed(1))
    : 0;
  const machine_after = await machineInfo(await readMemory());

  const rates = samples.flatMap((s) => (s.decode_tok_s === null ? [] : [s.decode_tok_s]));
  const measuredFor = (Date.now() - startedAt) / 60_000;
  const worst = worstWindow(samples, THERMAL_WINDOW_MS);

  const pressure_levels: Record<string, number> = {};
  for (const s of samples) pressure_levels[s.pressure] = (pressure_levels[s.pressure] ?? 0) + 1;

  const verdict = ((): string => {
    if (baseline === null) return "no bench baseline, so the guard was off — this run says only what the machine did";
    if (guard.events.length > 0) {
      return `the machine sagged and the guard acted: ${guard.events.length} back-off(s), concurrency ${concurrency} → ${guard.concurrency}`;
    }
    if (worst === null) return "not enough usable samples to form a two-minute window";
    const ratio = worst / baseline.tok_s;
    return ratio >= 1 - THERMAL_DROP
      ? `the machine did not sag: the worst two-minute median was ${worst} tok/s, ${(ratio * 100).toFixed(0)} % of the ${baseline.tok_s} tok/s baseline, and the guard correctly did nothing. ` +
        "This does NOT show the guard works — it shows it did not fire on a machine that gave it no reason to."
      : `the worst two-minute median was ${worst} tok/s (${(ratio * 100).toFixed(0)} % of baseline) and the guard did not fire — investigate`;
  })();

  const report: ThermalReport = {
    created: new Date().toISOString(),
    tag: tag ?? null,
    minutes_requested: minutes,
    minutes_measured: Number(measuredFor.toFixed(1)),
    machine_before,
    machine_after,
    model: { key, repo: record.repo, revision: record.revision, pinned: record.pinned },
    baseline,
    guard: {
      concurrency_at_start: concurrency,
      concurrency_at_end: guard.concurrency,
      drop: THERMAL_DROP,
      window_ms: THERMAL_WINDOW_MS,
      floor_tok_s: floor,
      fired: guard.events.length > 0,
      events: guard.events,
    },
    observed: {
      requests: samples.length,
      decode_tok_s_first_minute: meanOfMinute(samples, 0, 60),
      decode_tok_s_last_minute: meanOfMinute(samples, measuredFor * 60 - 60, Number.POSITIVE_INFINITY),
      decode_tok_s_median: rates.length ? Number(median(rates).toFixed(1)) : null,
      decode_tok_s_min: rates.length ? Math.min(...rates) : null,
      worst_window_median_tok_s: worst,
      worst_window_vs_baseline: worst === null || baseline === null ? null : Number((worst / baseline.tok_s).toFixed(3)),
      swapped_out_mb,
      trustworthy: swapped_out_mb < SWAP_NOISE_FLOOR_MB,
      pressure_levels,
    },
    samples,
    verdict,
    measured: true,
  };

  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\n${verdict}\n\nwrote ${path}\n`);

  if (started) await stop({ port, quiet: true });
}

main().catch((e) => { console.error(String((e as Error)?.message ?? e)); process.exit(1); });
