// `sidecrew bench` — the measurements that replace research §A's estimates.
//
// Everything written here is labelled `"measured": true` and carries the machine it came from, because
// a tok/s without a machine is not a number anyone can use, and the go/no-go rule compares across runs.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, ok as exited0, firstLine, pythonBin } from "./exec.js";
import { DEFAULT_PORT, baseUrlFor, readMemory, type Memory } from "./doctor.js";
import { entries, entry, short, tierFor, type ModelEntry } from "./models.js";
import { currentGate, readRecord, serve, stop } from "./serve.js";
import { complete, decodeTokensPerSecond, type Completion } from "./worker.js";

export const RESULTS_DIR = "experiments/go-no-go/results";

/** Fixed for every bench run: change these and old numbers stop being comparable. */
export const BENCH_SEED = 42;
export const BENCH_MAX_TOKENS = 400;
/** One throwaway request per model. The first generation pays for graph compilation and page faults. */
export const WARMUP_TOKENS = 16;
export const MEASURED_REQUESTS = 3;
export const DETERMINISM_REQUESTS = 5;
const RSS_SAMPLE_MS = 400;

/**
 * Swap below this is the machine breathing, not the model thrashing.
 *
 * `vm_stat` counts system-wide swapouts, so a run picks up whatever every other process did meanwhile.
 * Two measurements set the scale: a 14B that genuinely did not fit swapped **3197 MB**, and a 14B that
 * fitted comfortably still showed **10.8 MB** of unrelated background activity. Flagging the second
 * would make the warning fire on noise, and a warning that fires on noise is one people learn to
 * ignore — the same reasoning ADR-0008 applied to `doctor`. The exact figure is always recorded;
 * this threshold only decides whether the row is called untrustworthy.
 */
export const SWAP_NOISE_FLOOR_MB = 100;

const promptPath = fileURLToPath(new URL("./prompts/bench.md", import.meta.url));

export const benchPrompt = async (): Promise<string> => readFile(promptPath, "utf8");

// ── the machine ───────────────────────────────────────────────────────────────────────────────────

export interface MachineInfo {
  cpu: string;
  ram_gb: number;
  free_gb_at_start: number;
  macos: string;
  /** Research §E: Xcode and a simulator are the working set this project is sized around, so a bench
   *  taken on a quiet machine is a different measurement and has to say so. */
  xcode_open: boolean;
  simulator_open: boolean;
  node: string;
  mlx_lm: string;
  on_battery: boolean;
}

const sysctl = async (name: string): Promise<string> => {
  const r = await run("sysctl", ["-n", name], { timeoutMs: 5_000 });
  return exited0(r) ? r.stdout.trim() : "";
};

const processRunning = async (pattern: string): Promise<boolean> =>
  exited0(await run("pgrep", ["-x", pattern], { timeoutMs: 5_000 }));

const mlxVersion = async (): Promise<string> => {
  const r = await run(pythonBin(), ["-c", "import mlx_lm; print(mlx_lm.__version__)"], { timeoutMs: 60_000 });
  return exited0(r) ? firstLine(r) : "unknown";
};

export const machineInfo = async (mem: Memory | null): Promise<MachineInfo> => {
  const [cpu, macos, xcode, simulator, mlx, power] = await Promise.all([
    sysctl("machdep.cpu.brand_string"),
    run("sw_vers", ["-productVersion"], { timeoutMs: 5_000 }).then((r) => firstLine(r)),
    processRunning("Xcode"),
    processRunning("Simulator"),
    mlxVersion(),
    run("pmset", ["-g", "batt"], { timeoutMs: 5_000 }),
  ]);
  return {
    cpu,
    ram_gb: Number((mem?.total_gb ?? 0).toFixed(1)),
    free_gb_at_start: Number((mem?.free_gb ?? 0).toFixed(1)),
    macos,
    xcode_open: xcode,
    simulator_open: simulator,
    node: process.version,
    mlx_lm: mlx,
    on_battery: /Battery Power/.test(power.stdout),
  };
};

// ── peak RSS ──────────────────────────────────────────────────────────────────────────────────────

/**
 * `ps -o rss=` over the life of the run, keeping the maximum.
 *
 * RSS understates nothing that matters here: MLX allocates the weights as resident unified memory in
 * this very process, so the number moves from ~30 MB to the size of the model as it loads. Sampling
 * rather than reading once is the point — the peak is during generation, not at rest.
 */
export class RssSampler {
  private peakKb = 0;
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly pid: number, private readonly everyMs = RSS_SAMPLE_MS) {}

  async sample(): Promise<void> {
    const r = await run("ps", ["-o", "rss=", "-p", String(this.pid)], { timeoutMs: 5_000 });
    const kb = Number(r.stdout.trim());
    if (Number.isFinite(kb) && kb > this.peakKb) this.peakKb = kb;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sample(); }, this.everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get peakMb(): number {
    return Number((this.peakKb / 1024).toFixed(1));
  }
}

// ── swap ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Pages the kernel wrote to disk while we were measuring.
 *
 * Peak RSS cannot detect the condition that invalidates peak RSS. Measured on this machine: the 14B
 * with Xcode and a simulator open reported a *lower* peak RSS (4364 MB) than the same model on a quiet
 * machine (6947 MB), because macOS was compressing and evicting its pages — while swapping out 3.2 GB.
 * A run that swaps is not a slower version of a run that does not; research §E has performance
 * collapsing, and non-negotiable #5 says never. So the bench records it and says so, and a number taken
 * over a swapping run is labelled rather than quietly filed next to honest ones.
 *
 * Reading it is a delta, because the counters are cumulative since boot.
 */
export const swapouts = async (): Promise<number> => {
  const r = await run("vm_stat", [], { timeoutMs: 5_000 });
  const pages = Number(/^Swapouts:\s+(\d+)\.?/m.exec(r.stdout)?.[1] ?? NaN);
  return Number.isFinite(pages) ? pages : NaN;
};

/** macOS reports vm_stat in 16 KiB pages on Apple silicon; read the size rather than assume it. */
export const pageSizeBytes = async (): Promise<number> => {
  const r = await run("vm_stat", [], { timeoutMs: 5_000 });
  const size = Number(/page size of (\d+) bytes/.exec(r.stdout)?.[1] ?? NaN);
  return Number.isFinite(size) ? size : 16384;
};

// ── determinism ───────────────────────────────────────────────────────────────────────────────────

export interface DeterminismResult {
  requests: number;
  identical: boolean;
  /** One entry per distinct output. Length 1 is the answer we want. */
  distinct_outputs: number;
  /** Index of the first request that differed from the first, or null. */
  first_divergence: number | null;
  bytes: number;
  seed: number;
  note: string;
}

/**
 * The same prompt N times at temperature 0 with a fixed seed, one request in flight at a time.
 *
 * Serial on purpose, and not only to avoid contention: mlx_lm decides batchability as
 * `is_batchable and args.seed is None`, so a seeded request is already excluded from a batch. Sending
 * them serially means the result says something about the model rather than about our own scheduling.
 * ADR-0003.
 */
export const measureDeterminism = async (
  baseUrl: string,
  model: string,
  prompt: string,
  requests = DETERMINISM_REQUESTS,
): Promise<DeterminismResult> => {
  const outputs: string[] = [];
  for (let i = 0; i < requests; i += 1) {
    const c = await complete({ baseUrl, model, messages: [{ role: "user", content: prompt }], seed: BENCH_SEED, maxTokens: BENCH_MAX_TOKENS });
    outputs.push(c.text);
  }
  const first = outputs[0];
  const firstDivergence = outputs.findIndex((o) => o !== first);
  const distinct = new Set(outputs).size;
  return {
    requests,
    identical: distinct === 1,
    distinct_outputs: distinct,
    first_divergence: firstDivergence === -1 ? null : firstDivergence,
    bytes: Buffer.byteLength(first ?? ""),
    seed: BENCH_SEED,
    note: distinct === 1
      ? "byte-identical across every request, one in flight at a time (ADR-0003)"
      : "outputs diverged — see ADR-0003; do not trust any survival rate taken on this configuration",
  };
};

// ── one model ─────────────────────────────────────────────────────────────────────────────────────

export interface ModelBench {
  key: string;
  repo: string;
  revision: string;
  pinned: boolean;
  ram_gb_declared: number;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  /** Median over the measured requests. */
  decode_tok_s: number | null;
  decode_tok_s_all: (number | null)[];
  ttft_ms: number;
  ttft_ms_all: number[];
  wall_ms: number;
  peak_rss_mb: number;
  /** MB the kernel wrote to disk, system-wide, during this model's measurement. Always recorded. */
  swapped_out_mb: number;
  /** False once that passes `SWAP_NOISE_FLOOR_MB`: the numbers then describe a machine under duress. */
  trustworthy: boolean;
  load_ms: number;
  finish_reason: string | null;
  determinism: DeterminismResult | null;
  measured: true;
}

export const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export interface BenchOneOpts {
  model: ModelEntry;
  port: number;
  prompt: string;
  determinism: boolean;
  requests?: number;
  quiet?: boolean;
  force?: boolean;
  allowUnpinned?: boolean;
}

/** Start the model, warm it, measure it, stop it. Owns the worker it starts, and always stops it. */
export const benchOne = async (opts: BenchOneOpts): Promise<ModelBench> => {
  const { model, port, prompt } = opts;
  const say = (s: string) => { if (!opts.quiet) process.stdout.write(`${s}\n`); };
  const baseUrl = baseUrlFor(port);

  say(`\n── ${model.key} ──`);
  const [swapBefore, pageSize] = await Promise.all([swapouts(), pageSizeBytes()]);
  const loadStart = Date.now();
  const record = await serve({ modelKey: model.key, port, quiet: opts.quiet, force: opts.force, allowUnpinned: opts.allowUnpinned });
  const load_ms = Date.now() - loadStart;

  const sampler = new RssSampler(record.pid);
  await sampler.sample();
  sampler.start();

  try {
    const servedId = servedModelId(record);

    await complete({ baseUrl, model: servedId, messages: [{ role: "user", content: "Reply with the single word: ready" }], seed: BENCH_SEED, maxTokens: WARMUP_TOKENS });

    const runs: Completion[] = [];
    for (let i = 0; i < (opts.requests ?? MEASURED_REQUESTS); i += 1) {
      const c = await complete({ baseUrl, model: servedId, messages: [{ role: "user", content: prompt }], seed: BENCH_SEED, maxTokens: BENCH_MAX_TOKENS });
      runs.push(c);
      say(`  run ${i + 1}: ${c.usage.completion_tokens} tok · ttft ${c.ttft_ms.toFixed(0)} ms · ${(decodeTokensPerSecond(c) ?? 0).toFixed(1)} tok/s decode`);
    }

    const determinism = opts.determinism ? await measureDeterminism(baseUrl, servedId, prompt) : null;
    if (determinism) say(`  determinism: ${determinism.identical ? "5/5 byte-identical" : `DIVERGED at request ${determinism.first_divergence}`}`);

    const rates = runs.map(decodeTokensPerSecond);
    const usable = rates.filter((r): r is number => r !== null);

    const swapAfter = await swapouts();
    const swapped_out_mb = Number.isFinite(swapAfter) && Number.isFinite(swapBefore)
      ? Number((Math.max(0, swapAfter - swapBefore) * pageSize / 1024 ** 2).toFixed(1))
      : 0;
    const thrashed = swapped_out_mb >= SWAP_NOISE_FLOOR_MB;
    if (thrashed) {
      say(`  WARNING: ${swapped_out_mb} MB swapped out during this model — these numbers describe a machine under duress, not ${model.key}`);
    } else if (swapped_out_mb > 0) {
      say(`  (${swapped_out_mb} MB swapped out system-wide — below the ${SWAP_NOISE_FLOOR_MB} MB noise floor, recorded but not held against this run)`);
    }

    return {
      key: model.key,
      repo: model.repo,
      revision: record.revision,
      pinned: record.pinned,
      ram_gb_declared: model.ram_gb,
      requests: runs.length,
      prompt_tokens: median(runs.map((r) => r.usage.prompt_tokens)),
      completion_tokens: median(runs.map((r) => r.usage.completion_tokens)),
      decode_tok_s: usable.length ? Number(median(usable).toFixed(1)) : null,
      decode_tok_s_all: rates.map((r) => (r === null ? null : Number(r.toFixed(1)))),
      ttft_ms: Number(median(runs.map((r) => r.ttft_ms)).toFixed(0)),
      ttft_ms_all: runs.map((r) => Number(r.ttft_ms.toFixed(0))),
      wall_ms: Number(median(runs.map((r) => r.wall_ms)).toFixed(0)),
      peak_rss_mb: sampler.peakMb,
      swapped_out_mb,
      trustworthy: !thrashed,
      load_ms,
      finish_reason: runs.at(-1)?.finish_reason ?? null,
      determinism,
      measured: true,
    };
  } finally {
    sampler.stop();
    await stop({ port, quiet: opts.quiet });
  }
};

/**
 * What a completion request must put in `model`: exactly the string we passed to `--model`.
 *
 * Not what `/v1/models` reports. That endpoint is a catalogue of every mlx-lm model in the Hugging Face
 * cache, not a statement about what is loaded — with two models downloaded it lists both, in cache
 * order. And mlx_lm reloads whenever the requested name differs from the loaded key
 * (`ModelProvider.load`: `if self.model_key != model_key: self._load(...)`), so guessing wrong does not
 * fail loudly, it quietly swaps several GB of weights in the middle of a measurement and reports the
 * other model's speed.
 */
const servedModelId = (record: { model_arg: string }): string => record.model_arg;

// ── the command ───────────────────────────────────────────────────────────────────────────────────

export interface BenchReport {
  sidecrew: string;
  created: string;
  /** Free text naming the conditions, when a run was taken deliberately under some of them. */
  tag: string | null;
  machine: MachineInfo;
  tier: ReturnType<typeof tierFor>;
  config: { seed: number; max_tokens: number; requests: number; prompt_sha: string; temperature: 0 };
  models: ModelBench[];
  skipped: { key: string; reason: string }[];
  measured: true;
}

/**
 * `bench-<date>.json`, or `bench-<date>-<tag>.json` when a run needs to sit beside another.
 *
 * The plain name is the canonical run. A tag exists because the interesting comparison is the same
 * machine under two working sets — quiet, and with Xcode and a simulator resident — and a second run
 * on the same day would otherwise overwrite the first with no trace that it had.
 */
export const resultPath = (date = new Date(), dir = RESULTS_DIR, tag?: string): string =>
  join(dir, `bench-${date.toISOString().slice(0, 10)}${tag ? `-${tag}` : ""}.json`);

/**
 * A measurement is not allowed to overwrite a measurement.
 *
 * `--tag` has existed since Phase 1 and is how two runs sit beside each other, but it was a flag
 * somebody had to remember: forget it and the second run of the day silently replaces the first, with
 * the file's own `created` field the only evidence anything was lost. Phase 6 runs three or four
 * configurations, most of them on one day, and its decision rule compares them — so the cost of
 * forgetting went from "redo a run" to "compare a number against itself".
 *
 * Refusing is the whole fix, and the message names the flag rather than explaining the problem.
 */
export const refuseToClobber = (path: string, tag?: string): void => {
  if (!existsSync(path)) return;
  throw new Error(
    `${path} already exists and a measurement does not overwrite a measurement. ` +
    (tag === undefined
      ? "Pass --tag <name> to put this run beside it — one tag per configuration."
      : `Pass a different --tag; this one (${tag}) has already been used today.`),
  );
};

const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(digest).toString("hex").slice(0, 16);
};

export interface BenchOpts {
  port?: number;
  modelKey?: string;
  /** `--determinism`: run only the 5×-identical check, and do not write a results file. */
  determinismOnly?: boolean;
  requests?: number;
  outDir?: string;
  force?: boolean;
  /** ADR-0027: bench a model whose cached weights are not the pinned commit. The report records it. */
  allowUnpinned?: boolean;
  /** Distinguishes a run from another on the same date — e.g. the working set it was taken under. */
  tag?: string;
}

export async function bench(opts: BenchOpts = {}): Promise<BenchReport> {
  const port = opts.port ?? DEFAULT_PORT;
  const mem = await readMemory();
  const prompt = await benchPrompt();
  const machine = await machineInfo(mem);

  if (machine.on_battery) {
    process.stdout.write("warning: on battery — macOS throttles sustained work, and these numbers will read low.\n");
  }

  // `entry` rather than a filter, so a typo gets the same "known keys: …" that `serve` gives.
  const wanted = opts.modelKey ? [entry(opts.modelKey)] : entries();

  const results: ModelBench[] = [];
  const skipped: { key: string; reason: string }[] = [];

  for (const model of wanted) {
    // Free RAM is re-read per model: the previous model has just been stopped and its pages returned,
    // and asking once at the start would judge the 14B against memory the 7B was still holding.
    const gate = await currentGate(model);
    if (!gate.ok && !opts.force) {
      skipped.push({ key: model.key, reason: gate.reason });
      process.stdout.write(`skipping ${model.key}: ${gate.reason}\n`);
      continue;
    }
    try {
      results.push(await benchOne({ model, port, prompt, determinism: true, requests: opts.requests, force: opts.force, allowUnpinned: opts.allowUnpinned }));
    } catch (e) {
      skipped.push({ key: model.key, reason: String((e as Error).message) });
      process.stdout.write(`${model.key} failed: ${String((e as Error).message)}\n`);
      await stop({ port, quiet: true });
    }
  }

  const report: BenchReport = {
    sidecrew: process.env.npm_package_version ?? "0.0.1",
    created: new Date().toISOString(),
    tag: opts.tag ?? null,
    machine,
    tier: tierFor(mem?.total_gb ?? 0),
    config: {
      seed: BENCH_SEED,
      max_tokens: BENCH_MAX_TOKENS,
      requests: opts.requests ?? MEASURED_REQUESTS,
      prompt_sha: await sha256(prompt),
      temperature: 0,
    },
    models: results,
    skipped,
    measured: true,
  };

  const dir = opts.outDir ?? RESULTS_DIR;
  await mkdir(dir, { recursive: true });
  const path = resultPath(new Date(), dir, opts.tag);
  refuseToClobber(path, opts.tag);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\n${renderBench(report)}\n\nwrote ${path}\n`);
  return report;
}

/**
 * `sidecrew bench --determinism` on its own: the 5× check against whatever is already serving, or a
 * worker started for the purpose. It writes no results file — it answers yes or no.
 */
export async function benchDeterminism(opts: BenchOpts = {}): Promise<DeterminismResult> {
  const port = opts.port ?? DEFAULT_PORT;
  const prompt = await benchPrompt();
  const baseUrl = baseUrlFor(port);

  const existing = await readRecord(port);
  const started = existing === null;
  const record = existing ?? await serve({ modelKey: opts.modelKey, port, allowUnpinned: opts.allowUnpinned });
  const model = servedModelId(record);

  try {
    const result = await measureDeterminism(baseUrl, model, prompt);
    const where = `${record.model_key} @ ${short(record.revision)}`;
    process.stdout.write(
      `${result.identical ? "IDENTICAL" : "DIVERGED "} ${result.requests}/${result.requests} requests · ${where}\n` +
      `  ${result.distinct_outputs} distinct output${result.distinct_outputs === 1 ? "" : "s"} of ${result.bytes} bytes, seed ${result.seed}, temperature 0\n` +
      `  ${result.note}\n`,
    );
    return result;
  } finally {
    if (started) await stop({ port, quiet: true });
  }
}

export const renderBench = (r: BenchReport): string => {
  const head = `${r.machine.cpu} · ${r.machine.ram_gb} GB · macOS ${r.machine.macos} · mlx_lm ${r.machine.mlx_lm}` +
    `\nXcode ${r.machine.xcode_open ? "open" : "closed"}, Simulator ${r.machine.simulator_open ? "open" : "closed"}, ${r.machine.on_battery ? "on battery" : "on mains"}`;
  const rows = r.models.map((m) =>
    `  ${m.key.padEnd(24)} ${String(m.decode_tok_s ?? "—").padStart(6)} tok/s  ttft ${String(m.ttft_ms).padStart(5)} ms  peak RSS ${String(m.peak_rss_mb).padStart(7)} MB  ` +
    `${m.determinism?.identical ? "deterministic" : m.determinism ? "DIVERGED" : ""}` +
    `${m.trustworthy ? "" : `  ⚠ SWAPPED ${m.swapped_out_mb} MB — do not use these numbers`}`);
  const skips = r.skipped.map((s) => `  ${s.key}: ${s.reason}`);
  return [head, "", ...rows, ...(skips.length ? ["", "not measured:", ...skips] : [])].join("\n");
};
