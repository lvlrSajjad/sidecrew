// `sidecrew serve` / `stop` / `status` — the lifecycle of a local worker process.
//
// This is the one place that deliberately does not go through `src/exec.ts`. `run()` exists for
// commands that end, and holds the process until they do; a worker is the opposite — it must outlive
// the CLI that started it, so `serve` spawns it detached, hands the pid to a file and returns. Every
// other shell-out in sidecrew still goes through exec.ts.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rm, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { MLX_SERVER_MODULE, pythonBin, run, ok as exited0 } from "./exec.js";
import { DEFAULT_PORT, baseUrlFor, probeWorker, readMemory, readPressure, type Memory, type PressureLevel } from "./doctor.js";
import { apiModel, defaultKey, entry, resolveForServe, short, tierFor, type ModelEntry } from "./models.js";
import { complete } from "./worker.js";

/**
 * Free RAM a worker needs on top of the weights, and why it is stricter than `doctor`'s 1.5 GB.
 *
 * `doctor` describes a machine and should not cry wolf, so it uses the KV cache headroom alone.
 * `serve` commits: it is about to load several GB and hold them, and a worker that starts into swap
 * does not merely run slowly — research §E has performance collapsing, which would silently poison
 * every tok/s and survival number measured afterwards. So serve asks for 2 GB and refuses below it.
 */
export const SERVE_HEADROOM_GB = 2;

/** How long a worker gets to stop politely before it is made to. */
const STOP_GRACE_MS = 5_000;

/** A 14B first load off a cold cache is minutes, and a download is longer still. */
export const DEFAULT_READY_TIMEOUT_MS = 600_000;
const POLL_MS = 500;

export const SIDECREW_DIR = ".sidecrew";

/**
 * Which `.sidecrew` a command should read worker state from (ADR-0029).
 *
 * `serve` writes `worker-<port>.{json,pid,log}` relative to the directory it was run in, and every other
 * command used to read them relative to *its* directory. Run `sidecrew serve` in one place and
 * `sidecrew run` in another and the second finds no record — which used to mean it guessed, and the guess
 * was wrong in the way that costs the most (see `discoverWorkers`).
 *
 * Three sources, in order: `SIDECREW_DIR` when set — the only thing that works when the two directories
 * are in different trees, which is the normal case for a tool run against somebody else's repo; then the
 * nearest existing `.sidecrew` at or above the current directory, which covers running from a workspace
 * of the project you served from; then `.sidecrew` here, which is where a fresh `serve` creates one.
 */
export function sidecrewDir(from = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  if (env.SIDECREW_DIR) return env.SIDECREW_DIR;
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, SIDECREW_DIR))) return join(dir, SIDECREW_DIR);
    const up = dirname(dir);
    if (up === dir) return SIDECREW_DIR;
    dir = up;
  }
}

export interface WorkerFiles { pid: string; log: string; record: string }

export const workerFiles = (port: number, dir = sidecrewDir()): WorkerFiles => ({
  pid: join(dir, `worker-${port}.pid`),
  log: join(dir, `worker-${port}.log`),
  record: join(dir, `worker-${port}.json`),
});

/**
 * What we know about a worker that the port alone cannot tell us.
 *
 * `/v1/models` cannot be asked: mlx_lm answers it from the Hugging Face cache, so it lists every model
 * that is downloaded rather than the one that is loaded. Nothing over HTTP knows which models.json key
 * was started, which commit it resolved to, or what string a completion must send in `model` to avoid
 * triggering a reload — and `status` has to answer all three. Files are the IPC (CLAUDE.md), so the
 * record sits next to the pid and the log.
 */
export interface WorkerRecord {
  pid: number;
  port: number;
  model_key: string;
  repo: string;
  /** The commit actually serving, empty if we could not pin one. */
  revision: string;
  /** What went to `--model`: a cache snapshot path when pinned, else the repo id. */
  model_arg: string;
  pinned: boolean;
  started: string;
}

// ── the memory gate ───────────────────────────────────────────────────────────────────────────────

export interface MemoryGate { ok: boolean; need_gb: number; reason: string }

/**
 * May this model start right now? Free RAM, not installed RAM — ADR-0008's distinction, on the side
 * where the answer has to still be true a second later.
 *
 * Two conditions, and the second was added in Phase 7 because the first is not sufficient (ADR-0026).
 * `free_gb` comes from `vm_stat`'s reclaimable pages, and under memory pressure macOS compresses and
 * evicts — so the number goes *up* while the machine gets worse, which is ADR-0011's finding from the
 * other direction and exactly what Phase 6 observed when `ps` reported 205 MB for a 7B. The kernel's own
 * pressure level is the part that knows, and a worker must not start into `warn` or `critical` however
 * much free memory is being reported: non-negotiable #5 says never swap, not "swap a little".
 */
export const memoryGate = (m: ModelEntry, mem: Memory | null, pressure: PressureLevel = "unknown"): MemoryGate => {
  const need = m.ram_gb + SERVE_HEADROOM_GB;
  if (!mem) return { ok: false, need_gb: need, reason: "could not read this machine's memory — pass --force to start anyway" };

  if (mem.free_gb >= need) {
    if (pressure === "warn" || pressure === "critical") {
      return {
        ok: false,
        need_gb: need,
        reason:
          `${mem.free_gb.toFixed(1)} GB looks free but the kernel reports memory pressure ${pressure} — ` +
          "under pressure macOS compresses pages, so vm_stat's free count rises while the machine thrashes (ADR-0011). " +
          "Close something and let it settle, wait with --wait, or pass --force.",
      };
    }
    return { ok: true, need_gb: need, reason: `${mem.free_gb.toFixed(1)} GB free ≥ ${need.toFixed(1)} GB needed${pressure === "normal" ? ", pressure normal" : ""}` };
  }

  const tier = tierFor(mem.total_gb);
  // On the api tier this is not advice about freeing memory: the machine is not supposed to host a
  // worker at all, so the fix is "don't run serve", not "close Xcode" (ADR-0045 §4, ADR-0032's shape).
  const advice = tier.tier === "api"
    ? `this machine is the api tier · ${apiModel().model} (${tier.why}) — it does not host a local worker, ` +
      "so there is nothing to serve here: run `sidecrew run` or `sidecrew fix` directly and the worker is Claude over the API (ADR-0045)"
    : "close Xcode, a simulator or a browser, wait with --wait, or pass --force";
  return {
    ok: false,
    need_gb: need,
    reason: `${m.key} needs ~${need.toFixed(1)} GB free (${m.ram_gb} GB of weights + ${SERVE_HEADROOM_GB} GB headroom) and this machine has ${mem.free_gb.toFixed(1)} GB — ${advice}`,
  };
};

/** Ask the machine, both halves, at one instant. */
export const currentGate = async (m: ModelEntry): Promise<MemoryGate> => {
  const [mem, pressure] = await Promise.all([readMemory(), readPressure()]);
  return memoryGate(m, mem, pressure);
};

/** How often the queue asks again. Free RAM moves when an app quits, not when a loop spins. */
export const MEMORY_POLL_MS = 3_000;

export interface QueueOpts {
  /** How long to wait for room. 0 — the default — is the old behaviour: ask once and refuse. */
  waitMs?: number;
  pollMs?: number;
  onWait?: (waitedMs: number, gate: MemoryGate) => void;
}

/**
 * The queue half of the memory guard: wait for room rather than refuse (Phase 7, item 4).
 *
 * "Otherwise queue" is what turns the gate from a wall into a scheduler. A user who has just been told
 * to close Xcode does close Xcode, and a `serve` that refused a second earlier makes them type the
 * command again; a run script that hits the gate has no hands to close anything with and simply fails.
 * Waiting is the same rule applied repeatedly — it never starts a worker into less memory than the gate
 * demands, so the guarantee is unchanged and only the failure mode is kinder.
 */
export async function awaitMemory(m: ModelEntry, opts: QueueOpts = {}): Promise<MemoryGate> {
  const deadline = Date.now() + (opts.waitMs ?? 0);
  const startedAt = Date.now();
  for (;;) {
    const gate = await currentGate(m);
    if (gate.ok || Date.now() >= deadline) return gate;
    opts.onWait?.(Date.now() - startedAt, gate);
    await new Promise((r) => setTimeout(r, opts.pollMs ?? MEMORY_POLL_MS));
  }
}

// ── starting ──────────────────────────────────────────────────────────────────────────────────────

export const serveArgs = (modelArg: string, port: number): string[] =>
  [...MLX_SERVER_MODULE, "--model", modelArg, "--port", String(port), "--log-level", "INFO"];

/**
 * Can this worker actually generate? One token, which is the only question that matters.
 *
 * Measured on the baseline machine: `/v1/models` answered 1.9 s before the 14B could complete anything,
 * with the weights already in the page cache — mlx_lm serves that endpoint by listing the Hugging Face
 * cache, so it says nothing about what is loaded. Off a cold cache the gap is the whole load. A `serve`
 * that returned on the endpoint alone would hand Phase 4 a worker to schedule against that cannot yet
 * answer, and would charge the wait to whichever request arrived first.
 */
const canGenerate = async (port: number, model: string, timeoutMs: number): Promise<boolean> => {
  try {
    await complete({
      baseUrl: baseUrlFor(port),
      model,
      messages: [{ role: "user", content: "hi" }],
      seed: 1,
      maxTokens: 1,
      timeoutMs,
    });
    return true;
  } catch {
    return false;
  }
};

/** Poll until the worker can generate, the deadline passes, or the child dies under us. */
const waitForReady = async (
  port: number,
  pid: number,
  model: string,
  deadline: number,
  onTick?: (waitedMs: number) => void,
): Promise<void> => {
  const startedAt = Date.now();
  let answering = false;
  for (;;) {
    // The endpoint first, because it is cheap and it is what tells us the process is listening at all;
    // then the generation, which is what "ready" means.
    if (!answering) answering = (await probeWorker(port, 1_500)).up;
    if (answering && await canGenerate(port, model, 30_000)) return;

    if (!alive(pid)) throw new Error("the worker process exited before it answered — see the log");
    if (Date.now() > deadline) {
      throw new Error(
        answering
          ? `worker on ${baseUrlFor(port)} is listening but could not generate within ${Math.round((deadline - startedAt) / 1000)}s — the model may still be loading, or failed to; see the log`
          : `worker did not answer on ${baseUrlFor(port)} within ${Math.round((deadline - startedAt) / 1000)}s — see the log`,
      );
    }
    onTick?.(Date.now() - startedAt);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
};

/**
 * Signal the worker's whole process group, falling back to the pid alone.
 *
 * The group, not the pid: mlx_lm is a python process that may have spawned its own, and leaving one
 * behind means the port stays busy and the weights stay resident.
 */
export const killGroup = (pid: number, sig: NodeJS.Signals): void => {
  try {
    process.kill(-pid, sig);
  } catch {
    try { process.kill(pid, sig); } catch { /* already gone */ }
  }
};

/**
 * Is this pid still the worker we wrote down, or has the number been handed to somebody else?
 *
 * `stop` signals a whole process *group* by a pid read off disk. A stale pidfile — sidecrew killed, the
 * machine rebooted, the file left behind — plus macOS recycling pids means that group could be anything
 * the user is running. The blast radius of getting this wrong is somebody else's work, so it is worth a
 * `ps` to confirm the process is the one we started before signalling it.
 */
export const isOurWorker = async (pid: number): Promise<boolean> => {
  const r = await run("ps", ["-o", "command=", "-p", String(pid)], { timeoutMs: 5_000 });
  if (!exited0(r)) return false;
  const cmd = r.stdout.trim();
  return cmd.includes("mlx_lm") || cmd.includes("sidecrew-worker");
};

/** Signal 0 asks the kernel whether we could signal it, without doing so. */
export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export interface ServeOpts {
  modelKey?: string;
  port?: number;
  force?: boolean;
  dir?: string;
  readyTimeoutMs?: number;
  quiet?: boolean;
  /**
   * Start a worker whose weights are not the pinned revision (ADR-0027).
   *
   * The default is to refuse. Two survival rates taken on two revisions of the same repo are not
   * comparable, and nothing downstream can tell — `Candidate.worker.revision` records what ran, so the
   * evidence is there, but only for whoever thinks to look. This makes the refusal the thing that
   * happens instead.
   */
  allowUnpinned?: boolean;
  /** Wait this long for the memory gate to open before refusing. 0 asks once. */
  waitMs?: number;
}

export async function serve(opts: ServeOpts = {}): Promise<WorkerRecord> {
  const port = opts.port ?? DEFAULT_PORT;
  const dir = opts.dir ?? sidecrewDir();
  const key = opts.modelKey ?? defaultKey();
  const model = entry(key);
  const say = (s: string) => { if (!opts.quiet) process.stdout.write(`${s}\n`); };

  // Starting a second worker on a busy port would fail deep inside python, so ask first and, if one is
  // already serving what was asked for, say so and stop — `serve` is then safe to call from a script.
  const existing = await probeWorker(port, 1_000);
  if (existing.up) {
    const prior = await readRecord(port, dir);
    if (prior && prior.model_key !== key) {
      throw new Error(`port ${port} already serves ${prior.model_key} — stop it first (sidecrew stop --port ${port}) or use another port`);
    }
    if (prior) {
      say(`already serving on :${port} — ${prior.repo}`);
      return prior;
    }
    // Something is answering that we did not start, so there is no record to return and no pid to
    // manage. Spawning anyway would put a second mlx_lm on a bound port, where it dies in python with
    // an address-in-use traceback that says nothing about the actual situation.
    throw new Error(
      `something is already serving on :${port} and sidecrew did not start it — stop it yourself, or use another port with --port`,
    );
  }

  const resolved = await resolveForServe(model);
  // The pin is refused rather than warned about (ADR-0027). A warning printed above several minutes of
  // model loading is a warning nobody reads, and what it is warning about is that every number this
  // worker produces is incomparable with every number the last one did (non-negotiable #4).
  if (!resolved.pinned && !opts.allowUnpinned) {
    throw new Error(
      `${resolved.warning ?? `${key} is not running its pinned revision`}\n` +
      `  refusing to start: a survival rate taken on one revision cannot be compared with one taken on another (non-negotiable #4).\n` +
      `  sidecrew models --pin ${key}   # pin whatever is in the cache, and commit it\n` +
      "  --allow-unpinned               # start anyway; the candidate records the revision it actually ran",
    );
  }
  if (resolved.warning) say(`warning: ${resolved.warning}`);
  if (!resolved.pinned) say(`--allow-unpinned: this worker is not reproducible against ${short(model.revision)}`);

  let announcedWait = false;
  const gate = await awaitMemory(model, {
    waitMs: opts.waitMs,
    onWait: (_waited, g) => {
      if (announcedWait) return;
      announcedWait = true;
      say(`waiting for room (${Math.round((opts.waitMs ?? 0) / 1000)}s at most): ${g.reason}`);
    },
  });
  if (!gate.ok && !opts.force) throw new Error(gate.reason);
  if (!gate.ok) say(`--force: starting anyway. ${gate.reason}`);
  if (announcedWait && gate.ok) say(`room now: ${gate.reason}`);

  await mkdir(dir, { recursive: true });
  const files = workerFiles(port, dir);

  // Append, so restarting a worker does not throw away the log that explains why the last one died.
  const logFd = await open(files.log, "a");
  const child = spawn(pythonBin(), serveArgs(resolved.model, port), {
    stdio: ["ignore", logFd.fd, logFd.fd],
    detached: true,
  });
  if (child.pid === undefined) {
    await logFd.close();
    throw new Error(`could not start ${pythonBin()} — is python3 on PATH? (SIDECREW_PYTHON overrides it)`);
  }
  // Let the CLI exit without waiting on the worker, and stop holding an fd the child now owns.
  child.unref();
  await logFd.close();

  const record: WorkerRecord = {
    pid: child.pid,
    port,
    model_key: key,
    repo: model.repo,
    revision: resolved.revision,
    model_arg: resolved.model,
    pinned: resolved.pinned,
    started: new Date().toISOString(),
  };
  await writeFile(files.pid, `${child.pid}\n`);
  await writeFile(files.record, `${JSON.stringify(record, null, 2)}\n`);

  say(`starting ${key} (pid ${child.pid}, log ${files.log})`);
  let announced = false;
  try {
    await waitForReady(port, child.pid, resolved.model, Date.now() + (opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS), (waited) => {
      if (!announced && waited > 10_000) {
        announced = true;
        say("  still loading — a first run downloads the weights, and a 14B takes a while to load");
      }
    });
  } catch (e) {
    // Kill before forgetting. A worker that never became ready is still a process holding the port and
    // several GB of weights, and removing its pidfile first would leave it running with nothing left to
    // find it by — `sidecrew stop` reads that file. Order matters more than it looks.
    killGroup(child.pid, "SIGTERM");
    const deadline = Date.now() + STOP_GRACE_MS;
    while (alive(child.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    if (alive(child.pid)) killGroup(child.pid, "SIGKILL");

    await rm(files.pid, { force: true });
    await rm(files.record, { force: true });
    throw new Error(`${String((e as Error).message)}\n  tail -n 40 ${files.log}`);
  }

  say(`ready  ${model.repo}`);
  say(`       revision ${short(record.revision)}${record.pinned ? " (pinned)" : " (UNPINNED)"}`);
  say(`       ${baseUrlFor(port)}`);
  return record;
}

// ── stopping ──────────────────────────────────────────────────────────────────────────────────────

export const readRecord = async (port: number, dir = sidecrewDir()): Promise<WorkerRecord | null> => {
  try {
    return JSON.parse(await readFile(workerFiles(port, dir).record, "utf8")) as WorkerRecord;
  } catch {
    return null;
  }
};

export const readPid = async (port: number, dir = sidecrewDir()): Promise<number | null> => {
  const raw = await readFile(workerFiles(port, dir).pid, "utf8").catch(() => "");
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
};

export interface StopOpts { port?: number; dir?: string; quiet?: boolean }

export async function stop(opts: StopOpts = {}): Promise<boolean> {
  const port = opts.port ?? DEFAULT_PORT;
  const dir = opts.dir ?? sidecrewDir();
  const files = workerFiles(port, dir);
  const say = (s: string) => { if (!opts.quiet) process.stdout.write(`${s}\n`); };

  const pid = await readPid(port, dir);
  if (pid === null) {
    const probe = await probeWorker(port, 1_000);
    say(probe.up
      ? `something is serving on :${port} but sidecrew did not start it — no ${files.pid} to act on`
      : `no worker on :${port}`);
    return false;
  }
  if (!alive(pid)) {
    await rm(files.pid, { force: true });
    await rm(files.record, { force: true });
    say(`worker ${pid} was already gone — cleaned up ${files.pid}`);
    return false;
  }
  if (!await isOurWorker(pid)) {
    // Refuse rather than guess. Deleting the stale file is safe and is what unblocks the user; killing
    // whatever inherited the pid is not.
    await rm(files.pid, { force: true });
    await rm(files.record, { force: true });
    say(`pid ${pid} in ${files.pid} is not an mlx_lm worker any more — the file was stale, and has been removed. Nothing was killed.`);
    return false;
  }

  killGroup(pid, "SIGTERM");
  const deadline = Date.now() + STOP_GRACE_MS;
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (alive(pid)) {
    killGroup(pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 200));
  }

  await rm(files.pid, { force: true });
  await rm(files.record, { force: true });
  say(`stopped worker ${pid} on :${port}`);
  return true;
}

// ── status ────────────────────────────────────────────────────────────────────────────────────────

export interface StatusOpts { port?: number; dir?: string; json?: boolean }

export async function status(opts: StatusOpts = {}): Promise<void> {
  const port = opts.port ?? DEFAULT_PORT;
  const [probe, record, mem] = await Promise.all([probeWorker(port), readRecord(port, opts.dir), readMemory()]);

  // The record describes what we started; the probe describes what is answering. Reporting the record
  // for a worker that has since died would be a lie of exactly the kind `status` exists to prevent.
  const up = probe.up;
  const report = {
    worker: {
      up,
      base_url: baseUrlFor(port),
      // The record, never the probe: `/v1/models` lists what is downloaded, not what is loaded. A
      // worker sidecrew did not start is up, and honestly unidentified.
      model: up ? record?.repo ?? null : null,
      revision: up ? record?.revision || null : null,
    },
    memory: { total_gb: mem?.total_gb ?? 0, free_gb: mem?.free_gb ?? 0 },
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ...report, record: up ? record : null }, null, 2)}\n`);
    return;
  }

  const lines = [
    up ? `worker   up on ${report.worker.base_url}` : `worker   down (${report.worker.base_url})`,
  ];
  if (up) {
    lines.push(`model    ${report.worker.model ?? "unknown"}`);
    lines.push(`revision ${short(report.worker.revision ?? "")}${record?.pinned ? " (pinned)" : record ? " (UNPINNED)" : " (not started by sidecrew)"}`);
    if (record) lines.push(`pid      ${record.pid}, up since ${record.started}`);
  } else {
    lines.push("         start one with: sidecrew serve");
  }
  if (mem) {
    const tier = tierFor(mem.total_gb);
    lines.push(`memory   ${mem.total_gb.toFixed(1)} GB installed · ${mem.free_gb.toFixed(1)} GB free → ${tier.tier} tier`);
    if (tier.tier === "api") {
      lines.push(`         ${tier.why}`);
      lines.push(`         worker is ${apiModel().model} over the Anthropic API and is billed — zero-worker-tokens is a local-tier guarantee (ADR-0045)`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}
