// TypeScript verifier: tautology → tsc → vitest → StrykerJS, scoped to one function of one file.
//
// Survive ⇔ compiles ∧ passes on the original code ∧ kills ≥ 1 mutant of the function under test ∧
// non-tautological (CLAUDE.md #2). Everything here exists to make each of those four words mean what
// it says, and the two that took measurement to get right are written up in ADR-0004:
//
//   * the candidate runs in a sandbox with the project's **own tests removed**, because a mutant killed
//     by a test that already existed is not evidence about the candidate;
//   * Stryker's incremental cache is confined to that sandbox, because a cache shared between
//     candidates hands one candidate another's kills — measured, not feared.
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { run, type RunResult } from "../exec.js";
import { MAX_ERROR_CHARS, MutationResult, survives, Verdict, type Candidate, type Stage } from "../schemas.js";
import { analyseTautology, mask, type TautologyReport } from "./tautology.js";

/** The machine cannot run the verifier at all. Not a failed candidate — do not retry, fix the setup. */
export class VerifierSetupError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "VerifierSetupError";
  }
}

/** What the candidate was asked to test. Phase 4 fills this from the `TestPlan`; Phase 2 is explicit. */
export interface TsTarget {
  /** Project root: the thing with a package.json, a tsconfig and an installed node_modules. */
  projectDir: string;
  /** Source file under test, relative to `projectDir`. */
  sourceFile: string;
  /** The function under test. The tautology check and the mutation scope are both about this name. */
  functionName: string;
  /**
   * 1-based and inclusive, as `TestPlan.functions[].line_range` records it. Stryker then mutates only
   * those lines, which is what makes "kills ≥ 1 mutant **of the function under test**" checkable
   * rather than merely stated — and, measured on the fixture, what takes the mutation stage from 30 s
   * to 9 s, because the other four functions in the file stop being mutated for nobody.
   *
   * Three values, three meanings: a range is used as given; `null` mutates the whole file on purpose;
   * omitted derives the range from the source, which is what Phase 2 does because there is no planner
   * yet to supply one.
   */
  lineRange?: readonly [number, number] | null;
  /** Where the candidate lands inside the sandbox, relative to `projectDir`. Must match the project's
   *  vitest `include`, or vitest will find no tests and say so. */
  testFile?: string;
  /** Relative to `projectDir`. */
  tsconfig?: string;
}

export interface StageTimeouts {
  compile: number;
  pass: number;
  mutation: number;
}

/** Mutation runs are minutes, not seconds: `exec.ts`'s 60 s default would kill every one of them. */
export const DEFAULT_TIMEOUTS: StageTimeouts = { compile: 120_000, pass: 120_000, mutation: 900_000 };

/**
 * Stryker's own default is `cpus - 1`. On the machine this project is sized around that is eight vitest
 * processes next to a resident 7B worker, which is how non-negotiable #5 gets broken by a default
 * nobody chose. Two is the number Phase 2 measured with; Phase 4's memory-aware concurrency owns it
 * after that.
 */
export const DEFAULT_STRYKER_CONCURRENCY = 2;

export interface VerifyTsOpts {
  target: TsTarget;
  timeouts?: Partial<StageTimeouts>;
  concurrency?: number;
  /** Leave the sandbox on disk and print its path. For debugging a verdict you do not believe. */
  keepSandbox?: boolean;
  /** Where sandboxes are made. Defaults to the OS temp dir, deliberately outside the project. */
  sandboxRoot?: string;
}

/** Anything matching this is a test, and tests are what the sandbox must not inherit. */
export const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Never copied into a sandbox. `node_modules` is symlinked instead of copied; the rest is either
 * generated output or a cache that would make the run less reproducible than the copy it came from.
 * `__snapshots__` is here for a sharper reason: a snapshot written by somebody else's test run is a
 * recorded answer, and a candidate must not be graded against one.
 */
export const NEVER_COPY = new Set([
  "node_modules", ".git", ".sidecrew", "reports", ".stryker-tmp", "dist", "coverage", ".nyc_output", "__snapshots__",
]);

// ── the Stryker configuration ─────────────────────────────────────────────────────────────────────

/** Where the json reporter writes, named here rather than defaulted because the verifier reads it. */
export const MUTATION_REPORT = "reports/mutation/mutation.json";
/** Written into the sandbox per candidate; the project's own config, if any, is left alone. */
export const STRYKER_CONFIG = "sidecrew.stryker.config.mjs";

export interface StrykerConfigOpts {
  tsconfig?: string;
  concurrency?: number;
  /** Overridden per run by `--mutate`; what is written here is the sane default for a human. */
  mutate?: string[];
  timeoutMs?: number;
}

/**
 * The template. `fixtures/ts-fixture/stryker.config.mjs` is this text with the defaults, and
 * `test/verifier-ts.test.ts` fails if the two ever differ — the fixture is for a human running
 * `npx stryker run` by hand, and a config that drifts from the one the verifier uses would make that
 * debugging session answer a question nobody asked.
 */
export function strykerConfig(opts: StrykerConfigOpts = {}): string {
  const { tsconfig = "tsconfig.json", concurrency = DEFAULT_STRYKER_CONCURRENCY, mutate = ["src/**/*.ts"], timeoutMs = 10_000 } = opts;
  return `// Generated by sidecrew (src/verifier/ts.ts). Scoped to one file — see ADR-0004.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  // The type checker is what keeps mutants that cannot compile out of the denominator: they are noise
  // about TypeScript, not evidence about the test. It only does that with disableTypeChecks off.
  checkers: ["typescript"],
  tsconfigFile: ${JSON.stringify(tsconfig)},
  disableTypeChecks: false,
  coverageAnalysis: "perTest",
  reporters: ["json"],
  jsonReporter: { fileName: ${JSON.stringify(MUTATION_REPORT)} },
  mutate: ${JSON.stringify(mutate)},
  // Safe only because the sandbox is per candidate, so this file is always cold. Pointed at a shared
  // location it silently hands one candidate the kills another candidate earned — measured, ADR-0004.
  incremental: true,
  incrementalFile: "reports/stryker-incremental.json",
  concurrency: ${concurrency},
  // A score is a signal for review, never a pass/fail — ADR-0006. Nothing here may fail the run.
  thresholds: { high: 80, low: 60, break: null },
  timeoutMS: ${timeoutMs},
  logLevel: "warn",
};
`;
}

// ── the mutation report ───────────────────────────────────────────────────────────────────────────

/** Statuses that say something about the test. Everything else is Stryker talking about itself. */
const COUNTED = new Set(["Killed", "Survived", "Timeout", "NoCoverage"]);

interface RawMutant { id?: unknown; status?: unknown }
interface RawReport { files?: Record<string, { mutants?: RawMutant[] }> }

/**
 * Stryker's `mutation.json` → the `MutationResult` in the contract.
 *
 * Two asymmetries, both deliberate. The **score** counts a timeout as a kill and a never-covered mutant
 * as a miss, which is the mutation-testing standard and keeps our numbers comparable with everybody
 * else's. **Survival** requires `killed ≥ 1` with `killed` meaning the `Killed` status alone: a mutant
 * that hung the suite is a mutant nothing asserted about, and one of those is not the evidence
 * CLAUDE.md #2 is asking for.
 */
export function parseMutationReport(report: unknown, sourceFile?: string): MutationResult {
  const files = (report as RawReport | null)?.files ?? {};
  const wanted = sourceFile === undefined ? null : sourceFile.split(sep).join("/");
  const keys = Object.keys(files);
  const matching = wanted === null ? keys : keys.filter((k) => k.split(sep).join("/").endsWith(wanted));
  // A report that names the file differently is still a report about the run we just did; counting
  // nothing would turn a naming difference into "this test killed nothing", which is a lie.
  const selected = matching.length > 0 ? matching : keys;

  const counts: Record<string, number> = { Killed: 0, Survived: 0, Timeout: 0, NoCoverage: 0 };
  const killed_ids: string[] = [];
  for (const key of selected) {
    for (const mutant of files[key]?.mutants ?? []) {
      const status = String(mutant.status);
      if (!COUNTED.has(status)) continue;
      counts[status] = (counts[status] ?? 0) + 1;
      if (status === "Killed") killed_ids.push(String(mutant.id));
    }
  }

  const killed = counts.Killed ?? 0;
  const survived = counts.Survived ?? 0;
  const timeout = counts.Timeout ?? 0;
  const no_coverage = counts.NoCoverage ?? 0;
  const denominator = killed + timeout + survived + no_coverage;
  const score = denominator === 0 ? 0 : (killed + timeout) / denominator;
  return MutationResult.parse({ score, killed, survived, timeout, no_coverage, killed_ids });
}

// ── error text ────────────────────────────────────────────────────────────────────────────────────

const ANSI = /\[[0-9;]*[A-Za-z]/g;

/**
 * What the single retry gets to read. Head-first and capped at the contract's 2 KB: a compiler says
 * what is wrong in its first lines and then repeats itself, and the whole of a Stryker log is not
 * something a 7B model is going to use. Callers put the most actionable sentence first for the same
 * reason — under the cap, order is priority.
 */
export function truncateError(text: string): string {
  const clean = text.replace(ANSI, "").trim();
  if (clean.length <= MAX_ERROR_CHARS) return clean;
  const marker = `\n… truncated at ${MAX_ERROR_CHARS} characters`;
  return clean.slice(0, MAX_ERROR_CHARS - marker.length) + marker;
}

const output = (r: RunResult): string =>
  r.timedOut ? `timed out after ${r.ms} ms\n${r.stdout}\n${r.stderr}` : `${r.stdout}\n${r.stderr}`;

// ── the sandbox ───────────────────────────────────────────────────────────────────────────────────

/**
 * A copy of the project with its own tests left behind and its `node_modules` symlinked.
 *
 * Removing the tests is the part that matters (ADR-0004). Stryker attributes a kill to whatever test
 * killed it, but our verdict is a count, and a project with a real suite would hand every candidate a
 * full set of kills it had nothing to do with. What is left is "your project, with exactly one test in
 * it", which is the only configuration in which `killed ≥ 1` means what CLAUDE.md #2 says it means.
 */
export async function makeSandbox(projectDir: string, root?: string): Promise<string> {
  const sandbox = await mkdtemp(join(root ?? tmpdir(), "sidecrew-ts-"));
  await cp(projectDir, sandbox, {
    recursive: true,
    filter: (src) => {
      const rel = relative(projectDir, src);
      if (rel.length === 0) return true;
      if (rel.split(sep).some((part) => NEVER_COPY.has(part))) return false;
      return !TEST_FILE_PATTERN.test(basename(src));
    },
  });
  // Symlinked rather than copied: a 200 MB copy per candidate would cost more than the mutation run,
  // and the contents are read-only for every stage that follows.
  await symlink(join(projectDir, "node_modules"), join(sandbox, "node_modules"), "dir");
  return sandbox;
}

/** The project's own binary, never a downloaded one: `--no-install` is the fallback's whole point. */
const binary = (projectDir: string, name: string): { cmd: string; args: string[] } => {
  const local = join(projectDir, "node_modules", ".bin", name);
  return existsSync(local) ? { cmd: local, args: [] } : { cmd: "npx", args: ["--no-install", name] };
};

/**
 * `CI` is set for a reason that is not about continuous integration: it stops vitest writing a
 * snapshot file for a snapshot that does not exist yet. Without it, a candidate whose only assertion
 * is `toMatchSnapshot()` records its own answer and passes — the verifier would be blessing the
 * output instead of checking it.
 */
const STAGE_ENV = { CI: "true", NO_COLOR: "1", FORCE_COLOR: "0" } as const;

// ── the verifier ──────────────────────────────────────────────────────────────────────────────────

const safeName = (taskId: string): string => taskId.replace(/[^\w.-]+/g, ".").replace(/^\.+|\.+$/g, "") || "candidate";

const mutateArg = (file: string, range: readonly [number, number] | null): string =>
  range ? `${file.split(sep).join("/")}:${range[0]}-${range[1]}` : file.split(sep).join("/");

/**
 * The first and last line of `export function <name>`, by brace matching over the masked source so a
 * `}` in a string or a comment cannot end it early.
 *
 * A stand-in, and it says so: from Phase 5 the range arrives in the `TestPlan`, which knows it from
 * the module the planner actually read. Until then the verifier has to find the function itself, and
 * finding nothing is an answer — the caller mutates the whole file and pays for it.
 */
export function deriveLineRange(source: string, functionName: string): readonly [number, number] | null {
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const masked = mask(source);
  const declaration = new RegExp(`^[ \\t]*export\\s+(?:async\\s+)?function\\s+${escaped}\\b`, "m").exec(masked);
  if (!declaration) return null;
  const open = masked.indexOf("{", declaration.index);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === "{") depth += 1;
    else if (masked[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        const lineOf = (at: number) => source.slice(0, at).split("\n").length;
        return [lineOf(declaration.index), lineOf(i)];
      }
    }
  }
  return null;
}

/**
 * Verify one candidate against one function. Returns a `Verdict`; throws only when the machine cannot
 * run the pipeline at all, because "your toolchain is missing" and "your test is bad" must never
 * arrive at the retry loop wearing the same clothes.
 */
export async function verifyTs(candidate: Candidate, opts: VerifyTsOpts): Promise<Verdict> {
  const target = opts.target;
  const projectDir = resolve(target.projectDir);
  const tsconfig = target.tsconfig ?? "tsconfig.json";
  const timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
  const testFile = target.testFile ?? `test/${safeName(candidate.task_id)}.test.ts`;

  for (const [what, path] of [["a package.json", "package.json"], ["an installed node_modules — run npm i", "node_modules"], [`${tsconfig}`, tsconfig], [target.sourceFile, target.sourceFile]] as const) {
    if (!existsSync(join(projectDir, path))) throw new VerifierSetupError(`${projectDir} has no ${what}`);
  }

  // Free, and the most useful thing the retry can be told, so it is computed before anything is spawned.
  const tautology = analyseTautology(candidate.test_source, target.functionName);

  const timing_ms: { compile?: number; pass?: number; mutation?: number } = {};
  const problems: string[] = [];
  if (tautology.tautological) problems.push(tautologyMessage(tautology, target.functionName));

  const sandbox = await makeSandbox(projectDir, opts.sandboxRoot);
  let compile_ok = false;
  let pass_ok = false;
  let mutation: MutationResult | null = null;
  let stage_reached: Stage = "compile";

  try {
    const candidatePath = join(sandbox, testFile);
    await mkdir(dirname(candidatePath), { recursive: true });
    await writeFile(candidatePath, candidate.test_source, "utf8");

    const tsc = binary(projectDir, "tsc");
    const compile = await run(tsc.cmd, [...tsc.args, "--noEmit", "-p", tsconfig], {
      cwd: sandbox, timeoutMs: timeouts.compile, env: STAGE_ENV,
    });
    timing_ms.compile = compile.ms;
    compile_ok = compile.code === 0;
    if (!compile_ok) problems.push(`tsc --noEmit failed:\n${output(compile)}`);

    if (compile_ok) {
      stage_reached = "pass";
      const vitest = binary(projectDir, "vitest");
      const passed = await run(vitest.cmd, [...vitest.args, "run", testFile], {
        cwd: sandbox, timeoutMs: timeouts.pass, env: STAGE_ENV,
      });
      timing_ms.pass = passed.ms;
      pass_ok = passed.code === 0;
      if (!pass_ok) problems.push(`vitest run ${testFile} failed:\n${output(passed)}`);
    }

    // Skipped when the verdict is already settled. Mutation is ~90 % of the cost of a candidate, and a
    // test that does not compile, does not pass, or asserts nothing cannot be rescued by running it.
    if (compile_ok && pass_ok && !tautology.tautological) {
      stage_reached = "mutation";
      await writeFile(join(sandbox, STRYKER_CONFIG), strykerConfig({ tsconfig, concurrency: opts.concurrency }), "utf8");
      const stryker = binary(projectDir, "stryker");
      const range = target.lineRange === undefined
        ? deriveLineRange(await readFile(join(projectDir, target.sourceFile), "utf8"), target.functionName)
        : target.lineRange;
      // The config file is a positional argument, and it has to come last: `stryker run --mutate X cfg`.
      const mutated = await run(stryker.cmd, [...stryker.args, "run", "--mutate", mutateArg(target.sourceFile, range), STRYKER_CONFIG], {
        cwd: sandbox, timeoutMs: timeouts.mutation, env: STAGE_ENV,
      });
      timing_ms.mutation = mutated.ms;
      const report = await readReport(join(sandbox, MUTATION_REPORT));
      if (report === null) {
        // The mutation run itself broke. `stage_reached` says so, because escalating this candidate as
        // though its test were at fault would retry a machine problem at the worker's expense.
        problems.push(`stryker produced no ${MUTATION_REPORT}:\n${output(mutated)}`);
      } else {
        stage_reached = "done";
        mutation = parseMutationReport(report, target.sourceFile);
        if (mutation.killed === 0) {
          problems.push(
            `no mutant of ${target.functionName} was killed: ${mutation.survived} survived, ` +
            `${mutation.no_coverage} were never reached, ${mutation.timeout} timed out. ` +
            `The test passes against the original code and against every changed version of it.`,
          );
        }
      }
    }
  } finally {
    if (opts.keepSandbox) process.stderr.write(`sidecrew: sandbox kept at ${sandbox}\n`);
    else await rm(sandbox, { recursive: true, force: true });
  }

  const fields = {
    task_id: candidate.task_id,
    stage_reached,
    compile_ok,
    pass_ok,
    tautological: tautology.tautological,
    mutation,
    error: problems.length > 0 ? truncateError(problems.join("\n\n")) : null,
    timing_ms,
  };
  return Verdict.parse({ ...fields, survived: survives({ ...fields, survived: false }) });
}

const tautologyMessage = (report: TautologyReport, fn: string): string =>
  `tautological — it passes without testing ${fn}:\n` +
  report.findings.map((f) => `  line ${f.line}: ${f.message}`).join("\n");

const readReport = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
};
