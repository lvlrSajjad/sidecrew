// The one way sidecrew shells out. tsc, vitest, stryker, swift, muter and mlx_lm all arrive here, so the
// timeout and the kill are written once and cannot be forgotten at a call site.
import { spawn } from "node:child_process";

export interface RunOpts {
  cwd?: string;
  /** Wall clock. Reached ⇒ the whole process group is killed and `timedOut` is true. */
  timeoutMs?: number;
  /** Merged over the parent environment. */
  env?: NodeJS.ProcessEnv;
  /** Per-stream cap. A mutation run can print megabytes and none of it is worth holding. */
  maxOutputBytes?: number;
}

export interface RunResult {
  /** null when the child was killed by a signal — a timeout, or a crash. */
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
  /** The signal that ended it, if any. */
  signal: NodeJS.Signals | null;
}

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1 << 20;
/** Grace between asking a process group to stop and making it. */
const SIGKILL_AFTER_MS = 2_000;

const truncated = (chunks: string[], bytes: number, cap: number): string => {
  const text = chunks.join("");
  return bytes > cap ? `${text}\n… truncated at ${cap} bytes` : text;
};

/**
 * Run `cmd args` to completion, a timeout, or a spawn failure — never a hang and never a rejection.
 *
 * The child gets its own process group (`detached`), because the things we run are launchers: `npx`
 * spawns stryker which spawns node workers, `swift test` spawns the built binary. Killing the pid we
 * hold leaves those alive holding the port or the CPU, so the timeout kills the group.
 */
export async function run(cmd: string, args: string[] = [], opts: RunOpts = {}): Promise<RunResult> {
  const { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES } = opts;
  const startedAt = Date.now();

  return new Promise<RunResult>((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    const out: string[] = []; let outBytes = 0;
    const err: string[] = []; let errBytes = 0;
    let timedOut = false;
    let settled = false;

    // Slice rather than skip: a single chunk can be the whole megabyte, so testing the running total
    // before pushing would let one arrival blow through the cap it exists to enforce.
    const collect = (chunks: string[], seen: number, chunk: Buffer): number => {
      const room = maxOutputBytes - seen;
      if (room > 0) chunks.push(chunk.subarray(0, room).toString("utf8"));
      return seen + chunk.byteLength;
    };
    child.stdout.on("data", (c: Buffer) => { outBytes = collect(out, outBytes, c); });
    child.stderr.on("data", (c: Buffer) => { errBytes = collect(err, errBytes, c); });

    // Signalling the negated pid signals the group. It throws once the group is already gone, which is
    // the common case for the SIGKILL follow-up and is not worth reporting.
    const killGroup = (signal: NodeJS.Signals) => {
      try { if (child.pid !== undefined) process.kill(-child.pid, signal); } catch { /* already gone */ }
    };

    let hardKill: NodeJS.Timeout | undefined;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      hardKill = setTimeout(() => killGroup("SIGKILL"), SIGKILL_AFTER_MS);
      hardKill.unref();
    }, timeoutMs) : undefined;
    timer?.unref();

    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardKill);
      resolve({
        code,
        stdout: truncated(out, outBytes, maxOutputBytes),
        stderr: truncated(err, errBytes, maxOutputBytes),
        ms: Date.now() - startedAt,
        timedOut,
        signal,
      });
    };

    // A missing binary is an answer, not an exception: `doctor` asks about tools that are meant to be
    // absent, and every caller already has to read `code`. The reason goes into stderr, where a caller
    // that wants to explain the failure will already be looking.
    child.on("error", (e) => {
      err.push(e.message);
      errBytes += Buffer.byteLength(e.message);
      settle(null, null);
    });
    child.on("close", (code, signal) => settle(code, signal));
  });
}

/** True when the command ran and reported success. */
export const ok = (r: RunResult): boolean => r.code === 0;

/** First non-empty line of the output, which is what version probes actually want. */
export const firstLine = (r: RunResult): string =>
  `${r.stdout}\n${r.stderr}`.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";

/**
 * The python that hosts mlx_lm. `python3` unless `SIDECREW_PYTHON` names another — a venv, a pyenv
 * shim, or the one interpreter on the machine that actually has mlx installed. It lives here because
 * `doctor` probes it and `serve` spawns it, and those two must never disagree about which python
 * they mean.
 */
export const pythonBin = (env: NodeJS.ProcessEnv = process.env): string => env.SIDECREW_PYTHON ?? "python3";

/**
 * How to invoke mlx_lm's OpenAI-compatible server. `-m mlx_lm server`, not `-m mlx_lm.server`: the
 * latter still works in mlx_lm 0.31 but prints a deprecation notice, and the notice would land in the
 * worker log on every single start.
 */
export const MLX_SERVER_MODULE = ["-m", "mlx_lm", "server"] as const;
