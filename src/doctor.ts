// `sidecrew doctor` — one row per capability, each ok / degraded / missing, in simframe's shape.
//
// The point of the split is that almost nothing here is fatal. No Swift toolchain means the Swift
// verifier is unavailable; it does not mean sidecrew is broken. Only node and memory can fail the
// command, because those two decide whether a worker can run at all.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run, ok as exited0, firstLine, pythonBin, MLX_SERVER_MODULE } from "./exec.js";
import { isResolvable, jestConfigEntry, STRYKER_PLUGIN, testDirFor } from "./verifier/shared.js";
import { tsconfigProgramFiles, typeScriptAvailable } from "./verifier/ast.js";
import { CapabilityStatus, type MachineSample, type StatusReport } from "./schemas.js";
import { apiModel, apiTierOptIn, defaultKey, entry, SUPPORTED_MIN_RAM_GB, tierFor, type Tier } from "./models.js";
import { apiKeyFrom, MISSING_KEY_HINT } from "./api-worker.js";

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

/**
 * node, memory and tier gate the command; every other row is a capability, not an error.
 *
 * `tier` joined them in Phase 13 for the same reason the other two are here: it decides whether a
 * worker can run at all. On the local tier it is always `ok`; on the api tier it is `missing` exactly
 * when there is no credential, and a machine there has no local fallback to degrade to.
 */
const FATAL_ROWS = new Set(["node", "memory", "tier"]);

const defaultModel = () => entry(defaultKey());

export const baseUrlFor = (port: number): string => `http://localhost:${port}/v1`;

const nodeCheck = (): Check => {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= MIN_NODE_MAJOR
    ? { name: "node", status: "ok", detail: process.version }
    : { name: "node", status: "missing", detail: `${process.version} — sidecrew needs node ≥ ${MIN_NODE_MAJOR}` };
};

/**
 * The platform, said plainly, because every other check answers a question that presupposes it.
 *
 * Off macOS the failures are quiet rather than loud, which is the worst kind: `readMemory` shells out
 * to `sysctl hw.memsize` and `vm_stat` and returns null, `planConcurrency` reads that as "could not
 * read this machine's memory" and drops to one of everything, and
 * `kern.memorystatus_vm_pressure_level` — the guard ADR-0066 turns on — simply is not there. A user
 * would get a working-looking run sized by a fallback, and no warning that the machine cannot host a
 * worker at all.
 *
 * `degraded` rather than `missing` on a non-Apple Mac or another OS: the TypeScript verifier is
 * portable and the `api` tier needs no local model, so the tool is not useless — it is unmeasured and
 * unsupported, which is a different sentence and the one a reader deserves.
 */
export const platformCheck = (
  platform: string = process.platform,
  arch: string = process.arch,
): Check => {
  if (platform !== "darwin") {
    return {
      name: "platform",
      status: "degraded",
      detail: `${platform}/${arch} — sidecrew is built for macOS on Apple silicon. The local worker is MLX ` +
        "and cannot run here, memory and pressure detection are sysctl/vm_stat, and nothing on this " +
        "platform has been measured. The api tier plus the TypeScript verifier may work; unsupported.",
    };
  }
  if (arch !== "arm64") {
    return {
      name: "platform",
      status: "degraded",
      detail: `darwin/${arch} — MLX needs Apple silicon, so this machine is api tier whatever its RAM says`,
    };
  }
  return { name: "platform", status: "ok", detail: `${platform}/${arch}` };
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

/**
 * Total RAM can fail this machine; free RAM cannot.
 *
 * Free memory is transient — Xcode and a simulator swing it by 8 GB, and closing them fixes it. A
 * diagnostic that goes red because a browser is open is a diagnostic people learn to ignore, and then
 * it is not there for the case it exists for. So a machine that is merely busy is degraded, with the
 * number and the remedy; only a machine that could never fit the default model, or one whose memory we
 * cannot read at all, is a failure. The run itself refuses when there is no room at the moment it asks.
 */
/**
 * Which tier this machine is, and why — ADR-0032's shape: the cause, whose it is, and the exact fix.
 *
 * It is its own row rather than a clause on `memory` because the two answer different questions
 * (ADR-0008, ADR-0009): `memory` is about this moment and moves when somebody opens Xcode; the tier is
 * about the machine and does not. A user who reads "DEGRADED memory" on a 16 GB laptop should not have
 * to infer from it that their worker is Claude and that it is billed.
 *
 * On the api tier a missing credential is **fatal**, and that is the honest reading: the tier exists
 * because the machine has no local alternative, so without a key sidecrew cannot run at all.
 */
export const tierCheck = (mem: Memory | null, env: NodeJS.ProcessEnv = process.env): Check => {
  if (!mem) return { name: "tier", status: "missing", detail: "could not read installed RAM, so the tier is undecidable — sidecrew picks the tier from installed RAM (ADR-0045)" };

  const rule = tierFor(mem.total_gb);
  const installed = `${mem.total_gb.toFixed(1)} GB installed`;

  if (rule.tier === "local") {
    return { name: "tier", status: "ok", detail: `${installed} → local tier · ${rule.model} — ${rule.why}` };
  }

  // ADR-0073: below the floor sidecrew refuses, and says which of the three things is true — how much
  // RAM this machine has, what the floor is, and why the floor exists. ADR-0032's shape: the cause,
  // whose fault it is, and the exact fix. A silent fallback to a tier nobody has measured is what this
  // replaced.
  if (!apiTierOptIn(env)) {
    return {
      name: "tier",
      status: "missing",
      detail:
        `${installed}, and sidecrew needs ${SUPPORTED_MIN_RAM_GB} GB. A 7B worker cannot sit beside a ` +
        "normal working set below that (ADR-0009, measured), and sidecrew will not quietly run as a " +
        "different product instead.\n" +
        "  There is an unsupported escape hatch: SIDECREW_TIER=api runs the worker as Haiku over the " +
        "Anthropic API, billed to your key. Its survival and cost figures have never been measured " +
        "(ADR-0073), so it is not what this tool's numbers describe.",
    };
  }

  const a = apiModel();
  const why = `${installed} → api tier (unsupported, opted in) · ${a.model} — ${rule.why}`;
  if (apiKeyFrom(env) === null) {
    return {
      name: "tier",
      status: "missing",
      detail: `${why}. No API key, so no worker: ${MISSING_KEY_HINT}`,
    };
  }
  return {
    name: "tier",
    status: "ok",
    detail:
      `${why}. Worker inference is billed ($${a.rates_usd_per_mtok.input}/MTok in, $${a.rates_usd_per_mtok.output}/MTok out as of ${a.rates_as_of}); ` +
      "the zero-worker-tokens guarantee is a local-tier guarantee (ADR-0045).",
  };
};

export const memoryCheck = (mem: Memory | null, tier: Tier = "local"): Check => {
  if (!mem) return { name: "memory", status: "missing", detail: "could not read sysctl hw.memsize / vm_stat" };

  // On the api tier there is no local model to size against, and sizing free RAM against one would be
  // `doctor` answering about a worker this machine will never host. What still costs memory here is the
  // **gate** — 70–80 % of a candidate's cost, and it runs locally on either tier — so the row reports
  // what it can honestly say and points at the tier row for the rest.
  if (tier === "api") {
    return {
      name: "memory",
      status: "ok",
      detail: `${mem.total_gb.toFixed(1)} GB total · ${mem.free_gb.toFixed(1)} GB free — no local worker on this tier; this is the verifier's budget (see tier)`,
    };
  }

  const model = defaultModel();
  const need = model.ram_gb + KV_HEADROOM_GB;
  const size = `${mem.total_gb.toFixed(1)} GB total · ${mem.free_gb.toFixed(1)} GB free`;

  if (mem.total_gb < need) {
    return { name: "memory", status: "missing", detail: `${size} — ${model.key} needs ~${need.toFixed(1)} GB and this machine does not have it` };
  }
  if (mem.free_gb < need) {
    return { name: "memory", status: "degraded", detail: `${size} — ${model.key} needs ~${need.toFixed(1)} GB free; close something before a run` };
  }
  if (mem.free_gb < need * 2) {
    return { name: "memory", status: "degraded", detail: `${size} — room for one ${model.key}, not two workers or a 14B` };
  }
  return { name: "memory", status: "ok", detail: size };
};

/**
 * What the kernel thinks of the machine's memory right now, which is not what `vm_stat` free pages say.
 *
 * ADR-0011, from the direction Phase 6 found it: under pressure macOS compresses and evicts, so free
 * pages go *up* and resident sizes go *down* while the machine is thrashing. `free_gb ≥ need` is
 * therefore a necessary check and not a sufficient one — the kernel's own pressure level is the part
 * that knows. `kern.memorystatus_vm_pressure_level` is 1 normal, 2 warn, 4 critical; it is a sysctl read
 * rather than the `memory_pressure` command, which walks the whole VM to print the same conclusion.
 */
export type PressureLevel = "normal" | "warn" | "critical" | "unknown";

const PRESSURE: Record<string, PressureLevel> = { "1": "normal", "2": "warn", "4": "critical" };

export const parsePressureLevel = (raw: string): PressureLevel => PRESSURE[raw.trim()] ?? "unknown";

/** "unknown" on anything that is not macOS, or a sysctl that is not there — never a guess at "normal". */
export const readPressure = async (): Promise<PressureLevel> => {
  const r = await run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { timeoutMs: 5_000 });
  return exited0(r) ? parsePressureLevel(r.stdout) : "unknown";
};

export const readMemory = async (): Promise<Memory | null> => {
  const [size, stat] = await Promise.all([
    run("sysctl", ["-n", "hw.memsize"], { timeoutMs: 5_000 }),
    run("vm_stat", [], { timeoutMs: 5_000 }),
  ]);
  if (!exited0(size) || !exited0(stat)) return null;
  return parseMemory(size.stdout, stat.stdout);
};

/**
 * Pages the compressor is holding, in GB. This is *occupied by compressor* — what compression is
 * costing right now — and not *stored in compressor*, which counts what was put in and says nothing
 * about the footprint.
 */
export const parseCompressed = (vmStat: string): number | null => {
  const pageSize = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1]);
  const pages = Number(/^Pages occupied by compressor:\s+(\d+)\.?/m.exec(vmStat)?.[1] ?? NaN);
  if (!Number.isFinite(pageSize) || !Number.isFinite(pages)) return null;
  return (pages * pageSize) / GIB;
};

/**
 * Swap in use, in GB, from `sysctl vm.swapusage` — the line ADR-0066's amendment identified as the
 * signal that separates a suite the kernel is merely compressing from one it is paging to disk.
 *
 * macOS prints the unit per field (`used = 1365.38M`), so the suffix is parsed rather than assumed: a
 * machine deep enough into swap to print `G` is precisely the one whose number must not be wrong.
 */
export const parseSwapUsage = (raw: string): number | null => {
  const m = /used\s*=\s*([\d.]+)([KMG])/i.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const scale: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };
  return (n * (scale[m[2].toUpperCase()] ?? NaN)) / GIB;
};

/**
 * One reading of the machine, for the record a verdict now carries (ADR-0066 option C).
 *
 * It gates nothing and it must never throw: a verdict that failed to be annotated is still a verdict,
 * and an instrument that can fail a run it was added to observe is worse than no instrument. Every
 * member is independently nullable for that reason.
 */
export const readMachineState = async (): Promise<MachineSample> => {
  const [pressure, stat, swap] = await Promise.all([
    readPressure(),
    run("vm_stat", [], { timeoutMs: 5_000 }),
    run("sysctl", ["-n", "vm.swapusage"], { timeoutMs: 5_000 }),
  ]);
  const mem = await readMemory();
  return {
    pressure,
    free_gb: mem?.free_gb ?? null,
    swap_gb: exited0(swap) ? parseSwapUsage(swap.stdout) : null,
    compressed_gb: exited0(stat) ? parseCompressed(stat.stdout) : null,
  };
};

const mlxCheck = async (): Promise<Check> => {
  const py = pythonBin();
  const r = await run(py, [...MLX_SERVER_MODULE, "--help"], { timeoutMs: 60_000 });
  const how = `${py} ${MLX_SERVER_MODULE.join(" ")}`;
  return exited0(r)
    ? { name: "mlx_lm", status: "ok", detail: `${how} available` }
    : { name: "mlx_lm", status: "missing", detail: `${how} not importable — pip install mlx-lm (SIDECREW_PYTHON picks another interpreter)` };
};

export interface WorkerProbe {
  up: boolean;
  /**
   * Every model `/v1/models` offers — which is NOT the one that is loaded. mlx_lm answers that endpoint
   * from the Hugging Face cache, so a machine with two models downloaded lists both whichever one is
   * resident. Only `.sidecrew/worker-<port>.json`, written by `serve`, knows what is actually serving;
   * `sidecrew status` reads it. Kept as a list so nothing can mistake `[0]` for an answer.
   */
  available: string[];
  detail: string;
}

/** GET /v1/models against a worker that may well not be there. A refused connection is the normal case. */
export const probeWorker = async (port: number, timeoutMs = 2_000): Promise<WorkerProbe> => {
  const base = baseUrlFor(port);
  try {
    const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { up: false, available: [], detail: `${base} answered HTTP ${res.status}` };
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    const ids = (body.data ?? []).map((m) => String(m.id)).filter((id) => id !== "undefined");
    return { up: true, available: ids, detail: `${base} · ${ids.length} model${ids.length === 1 ? "" : "s"} available` };
  } catch {
    return { up: false, available: [], detail: `nothing on ${base} — start one with: sidecrew serve` };
  }
};

const workerCheck = async (port: number): Promise<Check> => {
  const probe = await probeWorker(port);
  return { name: "worker", status: probe.up ? "ok" : "missing", detail: probe.detail };
};

/**
 * `--no-install` is the whole point: this asks what the project already has, and must never download a
 * package to answer a diagnostic.
 *
 * `cwd` is the project being verified, which is not usually the one sidecrew is installed in. Phases 2
 * and 3 both noticed the same lie: `doctor` reported `stryker MISSING` on this repo while the verifier
 * was running Stryker candidates inside `fixtures/ts-fixture`, which has it. Both statements were
 * true, and together they were misleading — the verifier's toolchain belongs to the project it is
 * pointed at (ADR-0004's sandbox symlinks *that* `node_modules`), so the diagnostic has to be pointed
 * at the same place.
 */
const localBinCheck = async (name: string, cwd: string | undefined, args = ["--version"]): Promise<Check> => {
  const project = cwd ?? process.cwd();
  const pkg = NPM_PACKAGE[name] ?? name;
  const where = cwd === undefined ? "this project" : cwd;

  // Resolution first, the binary second (ADR-0029). `npx --no-install` answers "is there a .bin entry
  // reachable from here", which is not the same question in a workspace that hoists — the first real
  // monorepo this was pointed at had every dependency installed at the repo root, resolvable from the
  // workspace, and reported as missing. What matters is whether Node can load it, so ask Node.
  if (!isResolvable(pkg, project)) {
    return { name, status: "missing", detail: `${pkg} is not resolvable from ${where} — npm i -D ${pkg}` };
  }
  const r = await run("npx", ["--no-install", name, ...args], { timeoutMs: 60_000, cwd });
  return exited0(r)
    ? { name, status: "ok", detail: firstLine(r) }
    : {
      // Installed and loadable, but no runnable binary from here — a hoisted workspace whose `.bin` is
      // at the root, usually. The verifier calls the package rather than the shell script, so this is
      // usable; the version simply could not be read.
      name,
      status: "ok",
      detail: `${pkg} resolves from ${where}; no \`${name}\` binary on the path from there, so the version was not read`,
    };
};

const NPM_PACKAGE: Record<string, string> = {
  tsc: "typescript",
  vitest: "vitest",
  jest: "jest",
  stryker: "@stryker-mutator/core",
};

/**
 * Which runners Stryker can actually drive in this project (ADR-0028).
 *
 * `stryker` being installed is not enough: the runner is a separate plugin package, and without the
 * right one a mutation run fails several minutes in with a Stryker error that says nothing about the
 * candidate. `verifyTs` refuses up front for the same reason; this is the pre-flight version, so that
 * `doctor` can say it before a plan is written rather than after a run is started.
 */
const strykerRunnersCheck = (cwd: string | undefined): Check => {
  const root = cwd ?? process.cwd();
  const found = (Object.entries(STRYKER_PLUGIN) as [string, string][])
    .filter(([, pkg]) => isResolvable(pkg, root))
    .map(([runner]) => runner);
  const where = cwd === undefined ? "this project" : cwd;
  return found.length > 0
    ? { name: "stryker-runner", status: "ok", detail: `${found.join(", ")} — ${where} can be mutated under ${found.length === 1 ? "that runner" : "either"}` }
    : {
      name: "stryker-runner",
      status: "missing",
      detail: `neither runner plugin resolves from ${where} — npm i -D ${Object.values(STRYKER_PLUGIN).join(" or ")}`,
    };
};

// ── the pre-flight questions, which are facts about a project's layout ────────────────────────────
//
// Every row below was a run that failed, or worse, a run that quietly succeeded. They are here rather
// than in the verifier because all four are properties of how a project is laid out, which is what
// `doctor` is for, and because each of them costs a candidate — or a whole run — to discover otherwise.
// ADR-0032's message is the template: name the cause, say whose it is, print the exact remedy.

const TSCONFIG = "tsconfig.json";

/** A TypeScript project at all? The four rows below say nothing useful about a Swift or JS one. */
const looksTypeScript = (root: string): boolean => existsSync(join(root, TSCONFIG));

/**
 * Would `tsc` open the candidate sidecrew is about to write? (ADR-0037)
 *
 * The defect this reports is the only one of the six real-world blockers that failed **open**: the
 * compile stage type-checked the project without ever opening the candidate and said `compile ok`
 * about a file with three type errors in it. The gate detects it per candidate now and widens the
 * config, so this row is a warning and not a refusal — but a user whose `include` is wrong should hear
 * it as a sentence before a run rather than infer it from a sandbox they never look at.
 */
export const tsconfigIncludeCheck = (cwd: string | undefined): Check => {
  const root = cwd ?? process.cwd();
  const name = "tsconfig-include";
  if (!looksTypeScript(root)) return { name, status: "ok", detail: `no ${TSCONFIG} in ${root} — nothing to check` };

  const testDir = testDirFor(root);
  const files = tsconfigProgramFiles(join(root, TSCONFIG), root);
  if (files === null) {
    return {
      name,
      status: "degraded",
      detail: `${TSCONFIG} could not be parsed by the compiler, so whether it covers ${testDir}/ is unknown — ` +
        "a candidate written outside every include glob is type-checked by a stage that never opens it (ADR-0037)",
    };
  }

  const where = resolve(root, testDir);
  if (files.some((f) => f.startsWith(`${where}/`))) {
    return { name, status: "ok", detail: `${testDir}/ is in the ${files.length}-file program ${TSCONFIG} builds` };
  }
  const exists = existsSync(where);
  return {
    name,
    status: "degraded",
    detail: exists
      ? `sidecrew writes candidates to ${testDir}/, and no file there is in the ${files.length}-file program ` +
        `${TSCONFIG} builds. Every candidate would be compiled by a stage that never opens it (ADR-0037). ` +
        `sidecrew widens the config per candidate, so this is survivable; the fix is to add "${testDir}" to ` +
        `include in ${TSCONFIG}.`
      : `sidecrew writes candidates to ${testDir}/, which ${root} does not have — so whether ${TSCONFIG} covers ` +
        `them cannot be known until one is written (ADR-0037). If this project keeps its tests somewhere else, ` +
        "that directory is where they should go and sidecrew has not been told about it.",
  };
};

/**
 * Can the ts-jest shim be built on this layout? (ADR-0038)
 *
 * ts-jest type-checks by default, Stryker instruments the source it mutates, so ts-jest type-checks
 * Stryker's instrumentation and the mutation stage dies with a page of errors about `stryMutAct_9fa48`
 * — code nobody wrote, every candidate, in the last and most expensive stage. The shim turns those
 * diagnostics off, and it is built by loading the project's own config through `jest-config`. Where
 * `jest-config` cannot be resolved there is no shim, and a stock project cannot be mutated at all.
 */
export const tsJestCheck = (cwd: string | undefined): Check => {
  const root = cwd ?? process.cwd();
  const name = "ts-jest";
  if (!isResolvable("ts-jest", root)) {
    return { name, status: "ok", detail: `ts-jest does not resolve from ${root} — the shim is not needed here` };
  }
  return jestConfigEntry(root) !== null
    ? { name, status: "ok", detail: "ts-jest is in use and `jest-config` resolves, so the diagnostics shim can be written (ADR-0038)" }
    : {
      name,
      status: "degraded",
      detail: "ts-jest is in use but `jest-config` does not resolve from this project, so the diagnostics shim " +
        "cannot be written. The mutation stage will fail on Stryker's own instrumentation for every candidate " +
        "(ADR-0036). Either install jest so `jest-config` is reachable, or set ts-jest `diagnostics: false` in " +
        "the project's own jest config.",
    };
};

/**
 * Does this project already know it needs more heap than node's default? (ADR-0032)
 *
 * Measured on a 576,606-line project: `tsc --noEmit` dies at ~52 s on a machine with 13 GB free, every
 * candidate, twice — because the retry rule spends an attempt on it. The project's own scripts usually
 * carry the number, and `NODE_OPTIONS` reaches every stage already, so the pre-flight version of this
 * is to read the project's number and say whether this process is carrying it.
 */
const HEAP_FLAG = /--max-old-space-size[= ](\d+)/;

export const heapCheck = (cwd: string | undefined, env: NodeJS.ProcessEnv = process.env): Check => {
  const root = cwd ?? process.cwd();
  const name = "tsc-heap";
  let scripts = "";
  try {
    scripts = JSON.stringify(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {});
  } catch {
    return { name, status: "ok", detail: `no readable package.json in ${root} — nothing to read a heap size out of` };
  }

  const wanted = Number(HEAP_FLAG.exec(scripts)?.[1] ?? 0);
  const have = Number(HEAP_FLAG.exec(env.NODE_OPTIONS ?? "")?.[1] ?? 0);
  if (wanted === 0) return { name, status: "ok", detail: "this project's own scripts ask for no extra heap" };
  if (have >= wanted) return { name, status: "ok", detail: `NODE_OPTIONS carries ${have} MB; the project's scripts ask for ${wanted} MB` };
  return {
    name,
    status: "degraded",
    detail: `this project's own scripts run tsc with --max-old-space-size=${wanted}, and this process ` +
      `${have === 0 ? "has no NODE_OPTIONS" : `carries only ${have} MB`}. A compile stage that runs out of heap ` +
      "reads exactly like a candidate that does not compile, and the retry rule pays for it twice (ADR-0032). " +
      `Run: NODE_OPTIONS=--max-old-space-size=${wanted} sidecrew run <plan>`,
  };
};

/**
 * Does this project's jest suite collect any tests at all?
 *
 * Found in Phase 14: `doctor` reported `jest ok` — jest resolves, jest answers `--version` — on a
 * project whose suite collects **zero tests** under the node it was run with. Every stage after that
 * is meaningless and none of them says so: a `pass` stage that runs no tests does not fail, and a
 * baseline of zero passing tests is a baseline every candidate matches. Resolving a package is not
 * the same question as the suite working, and `--version` cannot tell them apart.
 */
export const jestTestsCheck = async (cwd: string | undefined): Promise<Check> => {
  const root = cwd ?? process.cwd();
  const name = "jest-tests";
  if (!isResolvable("jest", root)) return { name, status: "ok", detail: "jest does not resolve here — not this project's runner" };

  const r = await run("npx", ["--no-install", "jest", "--listTests"], { timeoutMs: 60_000, cwd: root });
  const listed = r.stdout.split("\n").map((l) => l.trim()).filter((l) => /\.(?:[cm]?[jt]sx?)$/.test(l));
  if (listed.length > 0) {
    return { name, status: "ok", detail: `jest collects ${listed.length} test file${listed.length === 1 ? "" : "s"} here` };
  }

  // Three different silences, and calling them all "no tests" would be the confident wrong answer this
  // row exists to stop. Only the middle one is the defect.
  if (r.timedOut) {
    return { name, status: "degraded", detail: `\`jest --listTests\` did not finish in 60 s in ${root}, so whether the suite collects anything is unknown` };
  }
  if (!/no tests found/i.test(`${r.stdout}${r.stderr}`)) {
    return {
      name,
      status: "degraded",
      detail: `\`jest --listTests\` failed in ${root}, so whether the suite collects anything is unknown — ` +
        `${firstLine(r) || "no output"}`,
    };
  }
  return {
    name,
    status: "degraded",
    detail: "jest resolves and answers --version, but `jest --listTests` collects no tests in this project. " +
      "Every stage after the baseline is then meaningless and none of them says so — a run stage that runs no " +
      "tests does not fail, and a baseline of zero passing tests is one every candidate matches. Usually the " +
      `node version, a testMatch that covers nothing, or the wrong directory. Check: cd ${root} && npx jest --listTests`,
  };
};

/**
 * Line ranges from the compiler, or from the scanner it replaced? (ADR-0076)
 *
 * Measured on this repository's own source: the scanner cannot see **34.9 %** of function declarations
 * and gets the range **wrong** for another 1.1 %, always by cutting a body short. Both are invisible in
 * every report — a missed function is one the planner silently drops, and a short range is mutation
 * over part of a function with the verdict saying nothing. A project where `typescript` cannot be
 * resolved gets that rate and has no other way to find out.
 */
export const lineRangeCheck = (cwd: string | undefined): Check => {
  const root = cwd ?? process.cwd();
  const name = "line-ranges";
  if (!looksTypeScript(root)) return { name, status: "ok", detail: `no ${TSCONFIG} in ${root} — nothing to range` };
  return typeScriptAvailable(root)
    ? { name, status: "ok", detail: "from the TypeScript compiler's own tree (ADR-0076)" }
    : {
      name,
      status: "degraded",
      detail: `typescript does not resolve from ${root}, so line ranges come from the regular-expression ` +
        "scanner it replaced. Measured against the compiler on a real TypeScript codebase, that scanner " +
        "cannot see 34.9 % of function declarations and cuts the body short on another 1.1 %, silently in " +
        `both cases (ADR-0076). Fix: npm i -D typescript in ${root}.`,
    };
};

const binCheck = async (name: string, args: string[], hint: string): Promise<Check> => {
  const r = await run(name, args, { timeoutMs: 60_000 });
  return exited0(r) ? { name, status: "ok", detail: firstLine(r) } : { name, status: "missing", detail: hint };
};

export interface DoctorOpts {
  port?: number;
  /** The project being verified. `--project`; defaults to the current directory. */
  cwd?: string;
}

/** Every row, probed for real. Also what `sidecrew_status` reports. */
export async function collect(opts: DoctorOpts = {}): Promise<{ checks: Check[]; memory: Memory | null; port: number }> {
  const port = opts.port ?? DEFAULT_PORT;
  const [memory, mlx, worker, tsc, vitest, jest, stryker, swift, muter, jestTests] = await Promise.all([
    readMemory(),
    mlxCheck(),
    workerCheck(port),
    localBinCheck("tsc", opts.cwd),
    localBinCheck("vitest", opts.cwd),
    localBinCheck("jest", opts.cwd),
    localBinCheck("stryker", opts.cwd),
    binCheck("swift", ["--version"], "no Swift toolchain — the Swift verifier is unavailable"),
    binCheck("muter", ["--version"], "not installed — brew install muter-mutation-testing/formulae/muter"),
    jestTestsCheck(opts.cwd),
  ]);
  // vitest and jest are both "missing" on a project that uses the other one, and that is correct
  // rather than alarming: they are alternatives, and `render` lists a missing capability without
  // failing the command. Only `stryker-runner` reports on the pair as a pair.
  const tier = memory === null ? "local" : tierFor(memory.total_gb).tier;
  return {
    checks: [
      platformCheck(), nodeCheck(), tierCheck(memory), mlx, worker, memoryCheck(memory, tier),
      tsc, vitest, jest, stryker, strykerRunnersCheck(opts.cwd), swift, muter,
      // The pre-flight questions: not "is it installed" but "will it do the thing", which is a
      // different question and the one six real projects failed on.
      lineRangeCheck(opts.cwd), tsconfigIncludeCheck(opts.cwd), tsJestCheck(opts.cwd),
      heapCheck(opts.cwd), jestTests,
    ],
    memory,
    port,
  };
}

const MARK: Record<CapabilityStatus, string> = { ok: "ok      ", degraded: "DEGRADED", missing: "MISSING " };

export const render = (checks: Check[]): string => {
  const lines = checks.map((c) => `${MARK[c.status]} ${c.name.padEnd(16)} ${c.detail}`);
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

/** What `serve` wrote down about the worker it started. `null` for one it did not start. */
export interface WorkerIdentity { model: string | null; revision: string | null }

export const toStatusReport = (
  checks: Check[],
  memory: Memory | null,
  port: number,
  identity: WorkerIdentity = { model: null, revision: null },
): StatusReport => {
  const worker = checks.find((c) => c.name === "worker");
  const up = worker?.status === "ok";
  const capabilities = Object.fromEntries(
    checks.filter((c) => !FATAL_ROWS.has(c.name) && c.name !== "worker").map((c) => [c.name, c.status]),
  );
  return {
    // The identity comes from the worker record, never from `/v1/models`: mlx_lm answers that endpoint
    // out of the Hugging Face cache, so it lists what is downloaded rather than what is loaded. A
    // worker that is up but was started by someone else is honestly unidentified.
    worker: { up, base_url: baseUrlFor(port), model: up ? identity.model : null, revision: up ? identity.revision : null },
    memory: { total_gb: memory?.total_gb ?? 0, free_gb: memory?.free_gb ?? 0 },
    capabilities,
  };
}; 

const flagValue = (argv: string[], flag: string): string | undefined => {
  const inline = argv.find((a) => a.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const next = argv[argv.indexOf(flag) + 1];
  return next && !next.startsWith("--") ? next : undefined;
};

export async function doctor(argv: string[] = []): Promise<void> {
  const port = Number(flagValue(argv, "--port") ?? process.env.SIDECREW_PORT ?? DEFAULT_PORT);
  const { checks, memory } = await collect({
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
    cwd: flagValue(argv, "--project"),
  });

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ok: exitCodeFor(checks) === 0, checks, memory }, null, 2)}\n`);
  } else {
    process.stdout.write(`${render(checks)}\n`);
  }
  process.exitCode = exitCodeFor(checks);
}
