// `sidecrew doctor` — one row per capability, each ok / degraded / missing, in simframe's shape.
//
// The point of the split is that almost nothing here is fatal. No Swift toolchain means the Swift
// verifier is unavailable; it does not mean sidecrew is broken. Only node and memory can fail the
// command, because those two decide whether a worker can run at all.
import { run, ok as exited0, firstLine } from "./exec.js";
import { CapabilityStatus, type StatusReport } from "./schemas.js";
import models from "./models.json" with { type: "json" };

export interface Check {
  name: string;
  status: CapabilityStatus;
  detail: string;
}

export const DEFAULT_PORT = 8000;
export const MIN_NODE_MAJOR = 20;
/** Weights are not the whole footprint: the KV cache and the runtime want their own room. */
const KV_HEADROOM_GB = 1.5;
const GIB = 1024 ** 3;

/** node and memory gate the command; every other row is a capability, not an error. */
const FATAL_ROWS = new Set(["node", "memory"]);

const defaultModel = () => {
  const key = models.default as keyof typeof models.models;
  return { key, ...models.models[key] };
};

export const baseUrlFor = (port: number): string => `http://localhost:${port}/v1`;

const nodeCheck = (): Check => {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= MIN_NODE_MAJOR
    ? { name: "node", status: "ok", detail: process.version }
    : { name: "node", status: "missing", detail: `${process.version} — sidecrew needs node ≥ ${MIN_NODE_MAJOR}` };
};

export interface Memory { total_gb: number; free_gb: number }

/**
 * macOS reports memory in pages, and "free" alone is close to meaningless — the OS keeps very little
 * of it. What a model can actually claim is free plus the pages the kernel will hand over without
 * swapping: inactive, speculative and purgeable.
 */
export const parseMemory = (memsize: string, vmStat: string): Memory | null => {
  const total = Number(memsize.trim());
  const pageSize = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1]);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(pageSize)) return null;

  const pages = (label: string): number =>
    Number(new RegExp(`^${label}:\\s+(\\d+)\\.?`, "m").exec(vmStat)?.[1] ?? NaN);
  const reclaimable = ["Pages free", "Pages inactive", "Pages speculative", "Pages purgeable"].map(pages);
  if (reclaimable.some((p) => !Number.isFinite(p))) return null;

  const free = reclaimable.reduce((a, b) => a + b, 0) * pageSize;
  return { total_gb: total / GIB, free_gb: free / GIB };
};

const memoryCheck = (mem: Memory | null): Check => {
  if (!mem) return { name: "memory", status: "missing", detail: "could not read sysctl hw.memsize / vm_stat" };
  const model = defaultModel();
  const need = model.ram_gb + KV_HEADROOM_GB;
  const size = `${mem.total_gb.toFixed(1)} GB total · ${mem.free_gb.toFixed(1)} GB free`;

  if (mem.free_gb < need) {
    return { name: "memory", status: "missing", detail: `${size} — ${model.key} needs ~${need.toFixed(1)} GB; close something` };
  }
  if (mem.free_gb < need * 2) {
    return { name: "memory", status: "degraded", detail: `${size} — room for one ${model.key}, not two workers or a 14B` };
  }
  return { name: "memory", status: "ok", detail: size };
};

export const readMemory = async (): Promise<Memory | null> => {
  const [size, stat] = await Promise.all([
    run("sysctl", ["-n", "hw.memsize"], { timeoutMs: 5_000 }),
    run("vm_stat", [], { timeoutMs: 5_000 }),
  ]);
  if (!exited0(size) || !exited0(stat)) return null;
  return parseMemory(size.stdout, stat.stdout);
};

const mlxCheck = async (): Promise<Check> => {
  const r = await run("python3", ["-m", "mlx_lm.server", "--help"], { timeoutMs: 30_000 });
  return exited0(r)
    ? { name: "mlx_lm", status: "ok", detail: "python3 -m mlx_lm.server available" }
    : { name: "mlx_lm", status: "missing", detail: "python3 -m mlx_lm.server not importable — pip install mlx-lm" };
};

export interface WorkerProbe { up: boolean; model: string | null; detail: string }

/** GET /v1/models against a worker that may well not be there. A refused connection is the normal case. */
export const probeWorker = async (port: number, timeoutMs = 2_000): Promise<WorkerProbe> => {
  const base = baseUrlFor(port);
  try {
    const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { up: false, model: null, detail: `${base} answered HTTP ${res.status}` };
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    const ids = (body.data ?? []).map((m) => String(m.id)).filter((id) => id !== "undefined");
    return { up: true, model: ids[0] ?? null, detail: `${base} · ${ids.length ? ids.join(", ") : "no model loaded"}` };
  } catch {
    return { up: false, model: null, detail: `nothing on ${base} — start one with: sidecrew serve` };
  }
};

const workerCheck = async (port: number): Promise<Check> => {
  const probe = await probeWorker(port);
  return { name: "worker", status: probe.up ? "ok" : "missing", detail: probe.detail };
};

/**
 * `--no-install` is the whole point: this asks what the project in cwd already has, and must never
 * download a package to answer a diagnostic.
 */
const localBinCheck = async (name: string, args = ["--version"]): Promise<Check> => {
  const r = await run("npx", ["--no-install", name, ...args], { timeoutMs: 60_000 });
  return exited0(r)
    ? { name, status: "ok", detail: firstLine(r) }
    : { name, status: "missing", detail: `not in this project's node_modules — npm i -D ${NPM_PACKAGE[name] ?? name}` };
};

const NPM_PACKAGE: Record<string, string> = {
  tsc: "typescript",
  vitest: "vitest",
  stryker: "@stryker-mutator/core",
};

const binCheck = async (name: string, args: string[], hint: string): Promise<Check> => {
  const r = await run(name, args, { timeoutMs: 60_000 });
  return exited0(r) ? { name, status: "ok", detail: firstLine(r) } : { name, status: "missing", detail: hint };
};

export interface DoctorOpts { port?: number; cwd?: string }

/** Every row, probed for real. Also what `sidecrew status` will render in Phase 4. */
export async function collect(opts: DoctorOpts = {}): Promise<{ checks: Check[]; memory: Memory | null; port: number }> {
  const port = opts.port ?? DEFAULT_PORT;
  const [memory, mlx, worker, tsc, vitest, stryker, swift, muter] = await Promise.all([
    readMemory(),
    mlxCheck(),
    workerCheck(port),
    localBinCheck("tsc"),
    localBinCheck("vitest"),
    localBinCheck("stryker"),
    binCheck("swift", ["--version"], "no Swift toolchain — the Swift verifier is unavailable"),
    binCheck("muter", ["--version"], "not installed — brew install muter-mutation-testing/formulae/muter"),
  ]);
  return { checks: [nodeCheck(), mlx, worker, memoryCheck(memory), tsc, vitest, stryker, swift, muter], memory, port };
}

const MARK: Record<CapabilityStatus, string> = { ok: "ok      ", degraded: "DEGRADED", missing: "MISSING " };

export const render = (checks: Check[]): string => {
  const lines = checks.map((c) => `${MARK[c.status]} ${c.name.padEnd(10)} ${c.detail}`);
  const degraded = checks.filter((c) => c.status === "degraded" || (c.status === "missing" && !FATAL_ROWS.has(c.name)));
  const fatal = checks.filter((c) => c.status === "missing" && FATAL_ROWS.has(c.name));

  if (degraded.length) {
    const noun = degraded.length === 1 ? "capability" : "capabilities";
    lines.push("", `${degraded.length} ${noun} unavailable. sidecrew still works, with less of it:`);
    for (const c of degraded) lines.push(`  - ${c.name}: ${c.detail}`);
  }
  if (fatal.length) {
    lines.push("", "No worker can run on this machine yet:");
    for (const c of fatal) lines.push(`  - ${c.name}: ${c.detail}`);
  }
  return lines.join("\n");
};

/** Non-zero only when node or memory is missing: a degraded capability is not a broken install. */
export const exitCodeFor = (checks: Check[]): number =>
  checks.some((c) => FATAL_ROWS.has(c.name) && c.status === "missing") ? 1 : 0;

export const toStatusReport = (checks: Check[], memory: Memory | null, port: number): StatusReport => {
  const worker = checks.find((c) => c.name === "worker");
  const capabilities = Object.fromEntries(
    checks.filter((c) => !FATAL_ROWS.has(c.name) && c.name !== "worker").map((c) => [c.name, c.status]),
  );
  return {
    worker: { up: worker?.status === "ok", base_url: baseUrlFor(port), model: null, revision: null },
    memory: { total_gb: memory?.total_gb ?? 0, free_gb: memory?.free_gb ?? 0 },
    capabilities,
  };
}; 

export async function doctor(argv: string[] = []): Promise<void> {
  const portArg = argv.find((a) => a.startsWith("--port"));
  const port = Number(portArg?.split("=")[1] ?? argv[argv.indexOf("--port") + 1] ?? process.env.SIDECREW_PORT ?? DEFAULT_PORT);
  const { checks, memory } = await collect({ port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT });

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ok: exitCodeFor(checks) === 0, checks, memory }, null, 2)}\n`);
  } else {
    process.stdout.write(`${render(checks)}\n`);
  }
  process.exitCode = exitCodeFor(checks);
}
