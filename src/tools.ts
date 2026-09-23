// The tools sidecrew's gate needs, provided by sidecrew — ADR-0088.
//
// Workload #1's gate is "compiles ∧ passes ∧ kills a mutant", and the mutant is Stryker's. Until this
// module, Stryker was loaded out of the **project's** `node_modules`, so the gate worked only on
// projects that had already chosen Stryker. That is a property of the project, not of sidecrew. The
// owner's rule, 23 Sep 2026:
//
//   > We must be project agnostic. If we use it because it is our best option, okay, but after the
//   > job the project must be intact.
//
// So Stryker lives in a **pinned cache owned by sidecrew** (`~/.sidecrew/tools/stryker-<version>`). It
// is installed there only by an explicit `sidecrew tools install`, never silently, and never into a
// project. The project still supplies its own compiler and its own test runner. Those are the project,
// and a verdict is about this project only because they are its own.
//
// **The trap that shaped this, measured by the spike.** npm installs peer dependencies. A plain install
// put `typescript` 7.0.2 and `vitest` 4.1.11 into the cache, and Stryker resolved *those*: the first
// failed loudly, and the second would have produced verdicts from a test runner the project does not
// use. So the cache is installed with peers off, `PROJECT_OWNED` names what may never be in it, and
// every run gets a throwaway APFS clone of the cache in which the project's own tools are symlinked.
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { run } from "./exec.js";
import { removeSandbox, VerifierSetupError, type TestRunner } from "./verifier/shared.js";

/**
 * Pinned, and not to the latest. ADR-0030: `@stryker-mutator/instrumenter@10` loads an ESM-only Babel
 * plugin through `require()` and fails with `ERR_REQUIRE_ESM` on every project. 8.7.1 is the version
 * every measured mutation number in this repository was taken with.
 */
export const STRYKER_VERSION = "8.7.1";

export const STRYKER_PACKAGES = [
  "@stryker-mutator/core",
  "@stryker-mutator/jest-runner",
  "@stryker-mutator/vitest-runner",
  "@stryker-mutator/typescript-checker",
] as const;

/** The runner plugin each test runner needs. */
export const STRYKER_RUNNER_PLUGIN: Record<TestRunner, string> = {
  vitest: "@stryker-mutator/vitest-runner",
  jest: "@stryker-mutator/jest-runner",
};

/**
 * What the cache must **never** contain: the project's compiler and test runners. If one of these is
 * in the cache, Stryker resolves it instead of the project's, and a verdict silently stops being about
 * the project. This is the spike's finding, turned into a refusal.
 */
export const PROJECT_OWNED = ["typescript", "jest", "vitest", "ts-jest"] as const;

/** `SIDECREW_TOOLS_DIR` overrides it for tests and for a machine that wants the cache elsewhere. */
export const toolsDir = (env: NodeJS.ProcessEnv = process.env): string =>
  env.SIDECREW_TOOLS_DIR ?? join(homedir(), ".sidecrew", "tools");

export const strykerDir = (env: NodeJS.ProcessEnv = process.env): string =>
  join(toolsDir(env), `stryker-${STRYKER_VERSION}`);

export interface ToolStatus {
  /** Every pinned package present, at the pinned version, and nothing project-owned in the cache. */
  ok: boolean;
  dir: string;
  version: string;
  /** Pinned packages that are absent or at another version. */
  missing: string[];
  /** `PROJECT_OWNED` packages found in the cache, which make it unusable (see the file comment). */
  leaked: string[];
}

const versionOf = (pkgDir: string): string | null => {
  try {
    return (JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
};

export function strykerStatus(env: NodeJS.ProcessEnv = process.env): ToolStatus {
  const dir = strykerDir(env);
  const modules = join(dir, "node_modules");
  const missing = STRYKER_PACKAGES.filter((p) => versionOf(join(modules, p)) !== STRYKER_VERSION);
  const leaked = PROJECT_OWNED.filter((p) => existsSync(join(modules, p)));
  return { ok: missing.length === 0 && leaked.length === 0, dir, version: STRYKER_VERSION, missing: [...missing], leaked: [...leaked] };
}

/** One sentence for `doctor`, the verifier's refusal and `sidecrew tools`. */
export function toolStatusMessage(s: ToolStatus): string {
  if (s.ok) return `stryker ${s.version} in sidecrew's tool cache (${s.dir})`;
  if (s.leaked.length > 0) {
    return `sidecrew's Stryker cache holds ${s.leaked.join(", ")}, which must come from the project — ` +
      `a verdict would be about the cache's copy instead (ADR-0088). Reinstall: sidecrew tools install --force`;
  }
  return `stryker ${s.version} is not in sidecrew's tool cache (missing ${s.missing.join(", ")}) — ` +
    "run: sidecrew tools install. It downloads ~62 MB from the npm registry into ~/.sidecrew/tools, never into a project (ADR-0088)";
}

export interface InstallOpts {
  env?: NodeJS.ProcessEnv;
  /** Reinstall even if the cache already looks right. */
  force?: boolean;
  onEvent?: (line: string) => void;
}

/**
 * Put the pinned Stryker into sidecrew's cache. **The only function here that downloads**, and only an
 * explicit `sidecrew tools install` calls it — the verifier refuses rather than install (ADR-0088).
 *
 * `legacy-peer-deps` is written to the cache's own `.npmrc`, so a later `npm` run inside it cannot
 * quietly re-add the peers the spike caught.
 */
export async function installStryker(opts: InstallOpts = {}): Promise<ToolStatus> {
  const env = opts.env ?? process.env;
  const say = opts.onEvent ?? (() => {});
  const before = strykerStatus(env);
  if (before.ok && !opts.force) {
    say(`already installed: ${toolStatusMessage(before)}`);
    return before;
  }
  const dir = before.dir;
  if (opts.force) await removeSandbox(dir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), `${JSON.stringify({
    name: "sidecrew-tool-stryker",
    private: true,
    description: "sidecrew-owned tool cache (ADR-0088). Never inside a project.",
  }, null, 2)}\n`, "utf8");
  await writeFile(join(dir, ".npmrc"), "legacy-peer-deps=true\n", "utf8");

  const specs = STRYKER_PACKAGES.map((p) => `${p}@${STRYKER_VERSION}`);
  say(`installing ${specs.join(" ")} into ${dir}`);
  const r = await run("npm", ["install", "--save-exact", "--no-audit", "--no-fund", ...specs], { cwd: dir, timeoutMs: 600_000 });
  if (r.code !== 0) throw new Error(`npm install in ${dir} failed (exit ${r.code}):\n${(r.stderr || r.stdout).slice(-1500)}`);

  const after = strykerStatus(env);
  if (!after.ok) throw new Error(toolStatusMessage(after));
  say(toolStatusMessage(after));
  return after;
}

/** The path an `import "<pkg>"` would load, read from the package's own manifest. */
export function esmEntry(manifest: Record<string, unknown>): string | null {
  const pick = (node: unknown, depth = 0): string | null => {
    if (typeof node === "string") return node;
    if (depth > 4 || node === null || typeof node !== "object") return null;
    const conditions = node as Record<string, unknown>;
    for (const key of ["import", "module", "default"]) {
      if (key in conditions) {
        const found = pick(conditions[key], depth + 1);
        if (found !== null) return found;
      }
    }
    return null;
  };
  const exports_ = manifest.exports;
  const root = typeof exports_ === "object" && exports_ !== null && "." in (exports_ as Record<string, unknown>)
    ? (exports_ as Record<string, unknown>)["."]
    : exports_;
  return pick(root) ?? (typeof manifest.module === "string" ? manifest.module : null)
    ?? (typeof manifest.main === "string" ? manifest.main : null);
}

/** Where the project's own copy of `pkg` lives, or null — resolved as Node would from the project. */
export function projectPackageDir(projectDir: string, pkg: string): string | null {
  try {
    return dirname(createRequire(join(resolve(projectDir), "package.json")).resolve(`${pkg}/package.json`));
  } catch {
    return null;
  }
}

export interface StrykerRun {
  /** The `stryker` executable to spawn. */
  bin: string;
  /** Absolute plugin entries for exactly this runner and the type checker — no glob (ADR-0088 §3). */
  plugins: string[];
  /** The per-run copy, outside the project. Removed by `cleanup`. */
  dir: string;
  cleanup: () => Promise<void>;
}

/**
 * A throwaway Stryker for one run against one project.
 *
 * An APFS clone of the cache (`cp -c`: instant, and it shares blocks), in which the project's
 * `typescript` and runner are **symlinks to the project's own**. Node resolves a package from its real
 * path, so Stryker's `import "typescript"` climbs from the clone and lands on the project's compiler,
 * with no `--preserve-symlinks`, no `NODE_PATH`, and nothing written to the project. The clone is
 * per run because the links are per project, and two runs on two projects must not share one.
 *
 * Refuses, as a setup error, when the cache is missing or leaky, or when the project has no compiler
 * or no runner of its own. Either would make the verdict about something other than the project.
 */
export async function prepareStryker(
  projectDir: string, runner: TestRunner, opts: { env?: NodeJS.ProcessEnv; root?: string } = {},
): Promise<StrykerRun> {
  const status = strykerStatus(opts.env);
  if (!status.ok) throw new VerifierSetupError(toolStatusMessage(status));

  const own: Record<string, string | null> = {};
  for (const pkg of ["typescript", runner] as const) {
    own[pkg] = projectPackageDir(projectDir, pkg);
    if (own[pkg] === null) {
      throw new VerifierSetupError(
        `${projectDir} has no ${pkg} of its own, and Stryker must use the project's ${pkg} — sidecrew does not supply one (ADR-0088)`,
      );
    }
  }
  // The other runner too, if the project has it: harmless, and it keeps the cache's other plugin from
  // resolving nothing if Stryker ever loads it.
  const other: TestRunner = runner === "jest" ? "vitest" : "jest";
  own[other] = projectPackageDir(projectDir, other);

  const dir = await mkdtemp(join(opts.root ?? tmpdir(), "sidecrew-tool-"));
  try {
    const modules = join(dir, "node_modules");
    const cloned = await run("cp", ["-Rc", join(status.dir, "node_modules"), modules], { timeoutMs: 300_000 });
    if (cloned.code !== 0) {
      const copied = await run("cp", ["-R", join(status.dir, "node_modules"), modules], { timeoutMs: 600_000 });
      if (copied.code !== 0) throw new VerifierSetupError(`could not copy sidecrew's Stryker cache into ${dir}: ${copied.stderr.slice(0, 400)}`);
    }
    for (const [pkg, at] of Object.entries(own)) {
      if (at !== null) await symlink(await realpath(at), join(modules, pkg), "dir");
    }

    const plugins: string[] = [];
    for (const pkg of [STRYKER_RUNNER_PLUGIN[runner], "@stryker-mutator/typescript-checker"]) {
      const pkgDir = join(modules, pkg);
      const entry = esmEntry(JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as Record<string, unknown>);
      if (entry === null) throw new VerifierSetupError(`${pkg} in sidecrew's cache has no importable entry`);
      plugins.push(join(pkgDir, entry));
    }
    const bin = join(modules, ".bin", "stryker");
    if (!existsSync(bin)) throw new VerifierSetupError(`sidecrew's Stryker cache has no stryker executable at ${bin}`);
    return { bin, plugins, dir, cleanup: () => removeSandbox(dir) };
  } catch (e) {
    await removeSandbox(dir);
    throw e;
  }
}
