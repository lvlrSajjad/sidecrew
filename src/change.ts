// The workload-#2a gate: baseline → change → re-verify, against the project's own suite plus `tsc`.
//
//   survives ⇔ confined ∧ compile_ok ∧ tests_ok        (CLAUDE.md #2's second-workload form, ADR-0048)
//
// Free, exact, and already written by the user — which is the whole argument for ADR-0031 option A. The
// work here is not running the tools; it is making each of those three words able to prove itself,
// because ADR-0037 is the most expensive thing six trials bought: the compile stage could report
// `compile ok` on a candidate it never opened, and did.
//
// So, three things this module refuses to assume:
//
//   * **the suite actually ran.** A suite that collected zero tests is not a green suite. The runner's
//     own JSON report is parsed, the number of tests is compared with the baseline's, and a drop is a
//     refusal. A runner that produced no report at all is a *machine* problem and says so.
//   * **the baseline is real.** Captured before the change, in the same sandbox, in the same way. A
//     project with pre-existing failures is normal, so the rule is "every test that passed **before**
//     still passes", never "everything is green".
//   * **`tsc` had the files.** ADR-0037's question asked of this workload: a task file the tsconfig
//     does not cover reports zero errors, and `compile_ok` would pass vacuously. `--listFiles` is free
//     and settles it, at baseline for the whole plan and again per candidate.
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync, realpathSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { run } from "./exec.js";
import { readMachineState } from "./doctor.js";
import { checkConfinement, confinementMessage, observe } from "./confinement.js";
import {
  ChangeBaseline, ChangeVerdict, changeSurvives,
  type ChangeCandidate, type ChangeStage, type ChangeTask, type ConfinementBreach, type ErrorCounts,
} from "./schemas.js";
import { binary, skipFromSandbox, stageEnv, stripFileList } from "./verifier/ts.js";
import {
  looksLikeOom, output, resolveNodeModules, truncateError, VerifierSetupError, type TestRunner,
} from "./verifier/shared.js";

/** Paths in every contract here are posix and relative to the project root. One spelling, everywhere. */
export const toPosix = (path: string): string => path.split(sep).join("/");

export interface ChangeTimeouts {
  compile: number;
  /** The whole suite, not one file: minutes on a real project. Measured per run rather than assumed. */
  tests: number;
}

export const DEFAULT_CHANGE_TIMEOUTS: ChangeTimeouts = { compile: 300_000, tests: 900_000 };

/** Where `tsc` reports an error that belongs to no file — `TS18003`, a bad flag, a config error. */
export const PROJECT_SCOPE = "(project)";

// ── the sandbox that keeps the tests (ADR-0046) ───────────────────────────────────────────────────

/**
 * A copy of the project **with its tests**, which is the exact opposite of ADR-0004 and for the exact
 * same reason.
 *
 * ADR-0004's rule is "the sandbox contains nothing that could satisfy the gate except the candidate".
 * In workload #1 a pre-existing test is the confound — it earns kills the candidate did not — so it is
 * deleted. Here the suite **is** the gate, so it is kept, and the candidate is forbidden from touching
 * it instead (`test_file_edited`, ADR-0048). Same rule, opposite consequence, because the gate is a
 * different object.
 */
export async function makeChangeSandbox(projectDir: string, root?: string): Promise<string> {
  const from = resolve(projectDir);
  const sandbox = await mkdtemp(join(root ?? tmpdir(), "sidecrew-fix-"));
  await cp(from, sandbox, {
    recursive: true,
    filter: (src) => {
      const rel = relative(from, src);
      return rel.length === 0 || !skipFromSandbox(rel);
    },
  });
  // Symlinked for the same reason ADR-0004 symlinks it: the stages only read it. ADR-0034's clone
  // upgrade is a `tsc` TS2883 treatment and is not reached here, because #2a never type-checks a file
  // that was not already in the project's own program.
  const modules = resolveNodeModules(from);
  if (modules !== null) await symlink(modules, join(sandbox, "node_modules"), "dir");
  return sandbox;
}

/**
 * A per-task copy of the step's sandbox, so tasks inside a step stay parallel (ADR-0044 §2, §3).
 *
 * `cp -Rc` is the APFS clone ADR-0034 already uses for `node_modules`: it shares blocks, so this is
 * cheap in space and close to cheap in time, and it copies the `node_modules` symlink as a symlink
 * rather than following it. Anywhere the clone is unavailable this is a plain recursive copy, which is
 * slower and correct.
 */
export async function cloneSandbox(from: string, root?: string): Promise<string> {
  const to = await mkdtemp(join(root ?? tmpdir(), "sidecrew-task-"));
  if (process.platform === "darwin") {
    const cloned = await run("cp", ["-Rc", `${from}/.`, to], { timeoutMs: 300_000 });
    if (cloned.code === 0) return to;
  }
  await cp(from, to, { recursive: true, verbatimSymlinks: true });
  return to;
}

// ── `tsc`, and proving it had the files ───────────────────────────────────────────────────────────

const ERROR_LINE = /^(?:\x1b\[\d+m)?(.+?)\((\d+),(\d+)\):\s+(?:\x1b\[\d+m)?error\s+TS\d+/;
const FILELESS_ERROR = /^\s*error\s+TS\d+/;

/**
 * Both names the sandbox answers to.
 *
 * On macOS `mkdtemp(tmpdir())` hands back `/var/folders/…`, which is a symlink to `/private/var/folders/…`,
 * and `tsc` prints the resolved one. Comparing against the path we were given then makes every file in
 * the program look like it is outside the sandbox — and the consequence is the worst one available:
 * `assertInProgram` would refuse a project whose files `tsc` had in front of it the whole time, which
 * reads exactly like the ADR-0037 failure it exists to catch.
 */
const sandboxNames = (sandbox: string): string[] => {
  const given = resolve(sandbox);
  try {
    const real = realpathSync(given);
    return real === given ? [given] : [given, real];
  } catch {
    return [given];
  }
};

/** `path` relative to whichever name of the sandbox it is actually under, or null when it is under none. */
const relativise = (path: string, names: string[]): string | null => {
  for (const base of names) {
    const rel = relative(base, path);
    if (rel !== "" && !rel.startsWith("..")) return toPosix(rel);
  }
  return null;
};

/**
 * Count `tsc`'s errors, per file, from its own output.
 *
 * `--pretty false` is what makes this a parse rather than a guess: pretty mode wraps paths in colour
 * and splits the diagnostic over several lines. An error with no file — a bad flag, `TS18003 no inputs
 * were found` — lands under `(project)`, so that a change which introduces one is still caught by
 * `errors.introduced` rather than falling out of the accounting.
 */
export function parseTscErrors(text: string, sandbox: string): ErrorCounts {
  const names = sandboxNames(sandbox);
  const by_file: Record<string, number> = {};
  let total = 0;
  for (const raw of stripFileList(text).split("\n")) {
    const line = raw.trimEnd();
    const m = ERROR_LINE.exec(line);
    if (m) {
      const file = isAbsolute(m[1]!) ? relativise(m[1]!, names) ?? toPosix(m[1]!) : toPosix(m[1]!);
      by_file[file] = (by_file[file] ?? 0) + 1;
      total += 1;
      continue;
    }
    if (FILELESS_ERROR.test(line)) {
      by_file[PROJECT_SCOPE] = (by_file[PROJECT_SCOPE] ?? 0) + 1;
      total += 1;
    }
  }
  return { total, by_file };
}

/** Which files `--listFiles` says were in the program, as posix paths relative to the sandbox. */
export function programFiles(text: string, sandbox: string): Set<string> {
  const names = sandboxNames(sandbox);
  const files = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || !isAbsolute(line)) continue;
    const rel = relativise(line, names);
    if (rel !== null) files.add(rel);
  }
  return files;
}

export interface TscRun {
  errors: ErrorCounts;
  /** Every file `tsc` actually had in the program (ADR-0037). */
  program: Set<string>;
  message: string;
  ms: number;
}

/**
 * `tsc --noEmit --pretty false --listFiles`, in the sandbox, with the project's own compiler.
 *
 * `--listFiles` costs nothing — the same invocation, with the program's file list on stdout — and it is
 * the only thing that can tell "this file has no errors" from "this file was never looked at".
 */
export async function typecheck(
  sandbox: string, projectDir: string, tsconfig: string, timeoutMs: number,
  /**
   * ADR-0063's strictness flags, appended to the project's own configuration. Empty is the ordinary
   * case. They are an allowlist in `schemas.ts` — bare boolean switches only — so nothing here can
   * re-point the program or turn emit back on, which are the two ways a flag list would stop
   * `compile_ok` meaning what it says.
   */
  flags: readonly string[] = [],
): Promise<TscRun> {
  // Resolved, and it is not tidiness. `binary` builds `<projectDir>/node_modules/.bin/tsc`, and the
  // command runs with `cwd` inside the *sandbox* — so a relative project path resolves against the
  // sandbox, the spawn fails with ENOENT, and `run` hands back an empty stdout rather than throwing.
  // See the guard below for what that used to mean.
  const tsc = binary(resolve(projectDir), "tsc");
  // `-p` first, then the flags: tsc lets a later command-line switch override the project file, which
  // is the whole mechanism ADR-0063 depends on.
  const argv = [...tsc.args, "--noEmit", "--pretty", "false", "--listFiles", "-p", tsconfig, ...flags];
  const r = await run(tsc.cmd, argv, { cwd: sandbox, timeoutMs, env: stageEnv() });
  const text = output(r);
  if (looksLikeOom(text)) {
    // A machine limit wearing a compiler error's clothes (ADR-0032). Thrown, so the retry rule never
    // spends an attempt on it and the message names the fix rather than the file.
    throw new VerifierSetupError(
      `tsc --noEmit ran out of memory on ${projectDir}, which is a limit on this machine rather than ` +
      "anything about the change.\n" +
      "  Give it more heap and run again — sidecrew passes the environment through:\n" +
      "    NODE_OPTIONS=--max-old-space-size=8192 sidecrew fix <plan>\n" +
      "  A large project usually already knows the number it needs; look for NODE_OPTIONS in its own " +
      "typecheck script.",
    );
  }
  const program = programFiles(r.stdout, sandbox);

  /**
   * **A `tsc` that never ran reports zero errors**, and zero errors is what `compile_ok` is looking for.
   *
   * Found by the first real run of this gate, which is now four for four on that (Phase 9's note): the
   * project path was relative, the binary could not be spawned, `run` returned an empty stdout because
   * it never throws, and `parseTscErrors` read that as a clean compile. It is ADR-0037 exactly —
   * `compile ok` on something the compiler never opened — in a gate written to be paranoid about it.
   *
   * `--listFiles` is what makes it detectable: **every** successful invocation lists at least the
   * TypeScript lib files, so an empty program cannot be a real one. Thrown rather than returned, so the
   * retry rule never spends an attempt on a machine problem.
   */
  if (program.size === 0) {
    throw new VerifierSetupError(
      `tsc produced no file list at all under ${tsconfig}, which means it did not run — not that the ` +
      "project is clean.\n" +
      `  command: ${tsc.cmd} ${argv.join(" ")}\n` +
      `  in: ${sandbox}\n` +
      `  exit ${r.code === null ? `signal ${r.signal ?? "?"}` : r.code}${r.timedOut ? " (timed out)" : ""}\n` +
      `  ${text.trim().slice(0, 600) || "(no output)"}`,
    );
  }

  return { errors: parseTscErrors(text, sandbox), program, message: stripFileList(text), ms: r.ms };
}

/**
 * ADR-0037's question, asked of this gate: did `tsc` look at the files whose error count we are about
 * to call zero?
 *
 * A task file outside the tsconfig's `include` reports no errors forever, and `compile_ok` would pass
 * vacuously on every candidate of that project. Checked at baseline for the whole plan, so a run
 * refuses before it spends a token, and again per candidate, so a verdict cannot be quietly wrong.
 */
export function assertInProgram(files: string[], program: Set<string>, tsconfig: string): void {
  const missing = files.filter((f) => !program.has(toPosix(f)));
  if (missing.length === 0) return;
  throw new VerifierSetupError(
    `tsc did not have ${missing.join(", ")} in the program under ${tsconfig}, so "zero errors in this file" ` +
    "would mean \"tsc never looked at it\".\n" +
    "  The compile half of the gate cannot be relied on for these files — see ADR-0037.\n" +
    `  Usually the tsconfig's \`include\` does not cover them. Point sidecrew at the tsconfig that does.`,
  );
}

// ── the suite, and proving it ran ─────────────────────────────────────────────────────────────────

export interface SuiteRun {
  /** False when the runner produced no parseable report: a machine problem, and it does not spend the retry. */
  reported: boolean;
  ran: number;
  passed: number;
  failed: number;
  /** `<file>::<full name>` for every test that passed. */
  passed_ids: string[];
  /**
   * Every id the report mentioned, whatever its status.
   *
   * Needed to tell "this test failed" from "this id is not in the report at all", which are different
   * facts and only the first is a regression (ADR-0053).
   */
  seen_ids: string[];
  message: string;
  ms: number;
}

interface RawAssertion { fullName?: unknown; title?: unknown; status?: unknown }
interface RawSuite { name?: unknown; assertionResults?: RawAssertion[] }
interface RawReport {
  numTotalTests?: unknown;
  numPassedTests?: unknown;
  numFailedTests?: unknown;
  testResults?: RawSuite[];
}

const int = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0);

/**
 * Jest's JSON report, which is also vitest's — the vitest json reporter emits jest's shape on purpose,
 * so one parser drives both runners exactly as `runArgs` does for workload #1 (ADR-0028).
 *
 * The id is `<file>::<full name>` rather than the full name alone: two files may each have a test
 * called "returns zero", and a rule that says "every test that passed before still passes" cannot be
 * satisfied by a *different* test of the same name.
 */
export function parseTestReport(report: unknown, sandbox: string): Omit<SuiteRun, "message" | "ms" | "reported"> {
  const names = sandboxNames(sandbox);
  const r = (report ?? {}) as RawReport;
  const passed_ids: string[] = [];
  const seen_ids: string[] = [];
  for (const suite of r.testResults ?? []) {
    const name = typeof suite.name === "string" ? suite.name : "";
    const file = isAbsolute(name) ? relativise(name, names) ?? toPosix(name) : toPosix(name);
    for (const a of suite.assertionResults ?? []) {
      const full = typeof a.fullName === "string" && a.fullName !== "" ? a.fullName
        : typeof a.title === "string" ? a.title : "";
      seen_ids.push(`${file}::${full}`);
      if (a.status !== "passed") continue;
      passed_ids.push(`${file}::${full}`);
    }
  }
  return { ran: int(r.numTotalTests), passed: int(r.numPassedTests), failed: int(r.numFailedTests), passed_ids, seen_ids };
}

/** How each runner is asked for the whole suite and a machine-readable report of it. */
export const suiteArgs = (runner: TestRunner, reportPath: string, cacheDir?: string): string[] =>
  runner === "jest"
    ? ["--ci", "--json", `--outputFile=${reportPath}`, ...(cacheDir === undefined ? [] : [`--cacheDirectory=${cacheDir}`])]
    : ["run", "--reporter=json", `--outputFile=${reportPath}`];

/**
 * Where the runner keeps its cache: **inside the sandbox**, so it is created with the sandbox,
 * shared with nothing, and swept with it (ADR-0055).
 *
 * jest's default cache directory is global, so every sandbox of every run writes to one place. A
 * 12-task plan makes 24 differently-rooted sandboxes, and measured on a real React project the shared
 * cache reached 3.8 GB and whole test files stopped loading — 0 of 12 candidates survived, none of
 * them for a reason a candidate caused. Clearing it, with no other change, turned that into 11 of 12.
 *
 * This is ADR-0052 one layer out: there the *launcher's* environment reached into the project's
 * toolchain, here one run of the toolchain reaches into the next through state on disk. A stage has
 * to be isolated in every dimension it can carry state — environment, filesystem, and cache.
 *
 * The cost is a cold cache per candidate, which on a large suite is real and is worth paying: the
 * alternative is a gate that starts refusing everything once a run is long enough, at a length that
 * is a property of the machine rather than of the project.
 *
 * vitest is not given one: its cache lives under the project's own `node_modules/.vite` by default,
 * which the sandbox already isolates by construction.
 */
export const sandboxCacheDir = (sandbox: string): string => join(sandbox, ".sidecrew-runner-cache");

/**
 * Run the project's own suite and read its report.
 *
 * The exit code is deliberately **not** the answer. A project with pre-existing failures exits non-zero
 * every time (project-a has 23 suites failing on missing DB env), so the report is what is compared
 * against the baseline. What the exit code cannot tell us either way is whether anything ran at all —
 * which is what `reported` and `ran` are for.
 */
export async function runSuite(
  sandbox: string, projectDir: string, runner: TestRunner, timeoutMs: number,
): Promise<SuiteRun> {
  const reportPath = join(sandbox, ".sidecrew-tests.json");
  await rm(reportPath, { force: true });
  // Resolved for the reason `typecheck` gives: the command runs with `cwd` inside the sandbox.
  const bin = binary(resolve(projectDir), runner);
  const args = suiteArgs(runner, reportPath, sandboxCacheDir(sandbox));
  const r = await run(bin.cmd, [...bin.args, ...args], { cwd: sandbox, timeoutMs, env: stageEnv() });
  const text = output(r);
  if (looksLikeOom(text)) {
    throw new VerifierSetupError(
      `${runner} ran out of memory on ${projectDir}, which is a limit on this machine rather than anything ` +
      "about the change. Give it more heap: NODE_OPTIONS=--max-old-space-size=8192 sidecrew fix <plan>",
    );
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(await readFile(reportPath, "utf8")) as unknown;
  } catch {
    parsed = null;
  }
  if (parsed === null) {
    return {
      reported: false, ran: 0, passed: 0, failed: 0, passed_ids: [], seen_ids: [],
      message: `${runner} ${args.join(" ")} produced no report:\n${text}`, ms: r.ms,
    };
  }
  const counts = parseTestReport(parsed, sandbox);
  return { reported: true, ...counts, message: text, ms: r.ms };
}

// ── the baseline (ADR-0046) ───────────────────────────────────────────────────────────────────────

export interface BaselineOpts {
  projectDir: string;
  runner: TestRunner;
  tsconfig?: string;
  timeouts?: Partial<ChangeTimeouts>;
  /** Every file any task in this step may touch. Checked against `tsc`'s program before anything runs. */
  files?: string[];
  /** ADR-0063 condition 2: the baseline is captured under the same strictness the verdicts use. */
  compilerFlags?: readonly string[];
}

export interface CapturedBaseline {
  baseline: ChangeBaseline;
  /**
   * The compiler's own text, which the contract deliberately does not carry: a whole project's `tsc`
   * output is megabytes, and a shape that has to be written to disk and parsed back is a shape somebody
   * eventually truncates quietly. `ChangeBaseline` records the counts the gate compares; this is what
   * the *worker* is shown, and it lives only as long as the step does.
   */
  diagnostics: string;
}

/**
 * What the project looked like before the change, captured in the sandbox the change will happen in.
 *
 * Once per **step**, not once per task: the existing suite is the expensive stage, and ADR-0044 §2
 * re-captures it at a step boundary because step N+1's baseline is the project after step N's
 * survivors were applied.
 */
export async function captureBaseline(sandbox: string, opts: BaselineOpts): Promise<CapturedBaseline> {
  const timeouts = { ...DEFAULT_CHANGE_TIMEOUTS, ...opts.timeouts };
  const tsconfig = opts.tsconfig ?? "tsconfig.json";
  const projectDir = resolve(opts.projectDir);
  const tsc = await typecheck(sandbox, projectDir, tsconfig, timeouts.compile, opts.compilerFlags ?? []);
  if (opts.files) assertInProgram(opts.files, tsc.program, tsconfig);

  const suite = await runSuite(sandbox, projectDir, opts.runner, timeouts.tests);
  if (!suite.reported) {
    throw new VerifierSetupError(
      `the baseline could not be captured: ${opts.runner} produced no report in ${opts.projectDir}.\n` +
      `  Half of this workload's gate is the project's own suite, so there is nothing to verify against.\n` +
      `  ${suite.message.slice(0, 600)}`,
    );
  }
  if (suite.ran === 0) {
    // ADR-0006's Swift lesson, in TypeScript: `swift test` exits 0 on an empty suite and so would a
    // runner asked nicely. A suite that collected nothing cannot say anything about behaviour, and
    // calling the resulting green a gate would be the quiet pass ADR-0037 was written about.
    throw new VerifierSetupError(
      `${opts.runner} collected zero tests in ${opts.projectDir}, so the suite half of the gate is vacuous.\n` +
      "  Workload #2a is gated by the project's own tests; a project with none cannot be verified this way.",
    );
  }

  const baseline = ChangeBaseline.parse({
    project: toPosix(opts.projectDir),
    captured_at: new Date().toISOString(),
    errors: tsc.errors,
    tests: { ran: suite.ran, passed: suite.passed, failed: suite.failed, passed_ids: suite.passed_ids },
    timing_ms: { compile: tsc.ms, tests: suite.ms },
  });
  return { baseline, diagnostics: tsc.message };
}

// ── the verdict ───────────────────────────────────────────────────────────────────────────────────

export interface VerifyChangeOpts {
  /** The step's sandbox, holding the state the baseline describes. Cloned per task; never written to. */
  sandbox: string;
  baseline: ChangeBaseline;
  /** The real project, for its own `tsc` and runner binaries and its `node_modules`. */
  projectDir: string;
  runner: TestRunner;
  tsconfig?: string;
  timeouts?: Partial<ChangeTimeouts>;
  sandboxRoot?: string;
  /** Leave the task's sandbox on disk and print its path. For debugging a verdict you do not believe. */
  keepSandbox?: boolean;
  /** ADR-0063. Must match the flags the baseline was captured with, or the two error counts are not comparable. */
  compilerFlags?: readonly string[];
}

const pick = (counts: ErrorCounts, files: string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const f of files) {
    const n = counts.by_file[toPosix(f)] ?? 0;
    if (n > 0) out[toPosix(f)] = n;
  }
  return out;
};

/** Files anywhere that have more errors after than before, and by how many. */
const introducedBy = (before: ErrorCounts, after: ErrorCounts): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [file, n] of Object.entries(after.by_file)) {
    const was = before.by_file[file] ?? 0;
    if (n > was) out[file] = n - was;
  }
  return out;
};

/**
 * Verify one candidate against one task's baseline. Returns a `ChangeVerdict`; throws only when the
 * machine cannot run the gate at all, because "your toolchain is missing" and "your change is wrong"
 * must never arrive at the retry loop wearing the same clothes.
 *
 * Order is confinement → apply → compile → tests, and confinement being first is the property whole-file
 * edits buy (ADR-0047 §2): **nothing is written until it has passed.**
 */
export async function verifyChange(
  task: ChangeTask, candidate: ChangeCandidate, opts: VerifyChangeOpts,
): Promise<ChangeVerdict> {
  const timeouts = { ...DEFAULT_CHANGE_TIMEOUTS, ...opts.timeouts };
  const tsconfig = opts.tsconfig ?? "tsconfig.json";
  const projectDir = resolve(opts.projectDir);
  const before = opts.baseline.errors;
  const targets = task.files.map((f) => toPosix(f.path));
  // ADR-0066 option C. Taken before anything expensive runs, so the pair brackets the gate rather than
  // describing the machine the gate was about to ruin. Nothing below reads it (ADR-0066 is *record*).
  const machineBefore = await readMachineState();

  // ADR-0044's "the other direction", built in Phase 12: a worker that says it cannot do the task is an
  // escalation with a reason, and it stops here. The point is the 262 s it does not spend — Phase 11
  // measured the gate at 95 % of a candidate's cost, so failing at `compile` for a reason nobody can
  // read is the single most expensive way for a worker to be unable to do something.
  if (candidate.refusal !== null && candidate.edits.length === 0) {
    return ChangeVerdict.parse({
      task_id: task.task_id,
      stage_reached: "generate",
      survived: false,
      compile_ok: false,
      tests_ok: false,
      confined: true,
      files_touched: [],
      errors: { before, after: before, introduced: {}, remaining_in_target: pick(before, targets), message: null },
      tests: null,
      confinement: [],
      observations: [],
      refused: truncateError(candidate.refusal),
      error: truncateError(`the worker refused this task: ${candidate.refusal}`),
      timing_ms: {},
      // A refusal stops here, so the two samples bracket nothing and are deliberately the same
      // reading. Recording it anyway keeps `machine: null` meaning exactly one thing — *this verdict
      // predates ADR-0069/0066* — rather than also meaning *no gate ran*.
      baseline_captured_at: opts.baseline.captured_at,
      verified_at: new Date().toISOString(),
      machine: { before: machineBefore, after: machineBefore },
    });
  }

  const confinement: ConfinementBreach[] = checkConfinement(task, candidate);
  const confined = confinement.length === 0;
  const problems: string[] = [];
  if (!confined) problems.push(confinementMessage(confinement));

  // The stage a candidate stopped in, and `generate` is not the same as `confinement`: an answer that
  // could not be read as edits at all is a different finding from one that edited the wrong file, and
  // Phase 11 counts them apart (ADR-0047 §2).
  let stage_reached: ChangeStage = candidate.edits.length === 0 && candidate.unparsed !== null ? "generate" : "confinement";
  let compile_ok = false;
  let tests_ok = false;
  let after: ErrorCounts = before;
  let errorMessage: string | null = null;
  let tests: ChangeVerdict["tests"] = null;
  const timing_ms: { compile?: number; tests?: number } = {};
  const files_touched = candidate.edits
    .filter((e) => task.files.find((f) => f.path === e.path)?.source !== e.contents)
    .map((e) => toPosix(e.path));

  if (candidate.unparsed !== null) {
    problems.push(`part of the worker's answer could not be read as a file:\n${candidate.unparsed}`);
  }
  if (candidate.truncated) {
    problems.push("the completion hit the token ceiling, so at least one file is cut off (ADR-0047 §2)");
  }

  if (confined) {
    const sandbox = await cloneSandbox(opts.sandbox, opts.sandboxRoot);
    try {
      stage_reached = "apply";
      for (const edit of candidate.edits) {
        // Only a path the task lists, and only inside the sandbox. Confinement has already refused
        // anything else; this is the second lock on the same door, because a path traversal in a
        // worker's answer must not be able to write into the real project.
        const target = resolve(sandbox, edit.path);
        if (!target.startsWith(resolve(sandbox) + sep)) {
          throw new VerifierSetupError(`refusing to write ${edit.path}: it escapes the sandbox`);
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, edit.contents, "utf8");
      }

      stage_reached = "compile";
      const tsc = await typecheck(sandbox, projectDir, tsconfig, timeouts.compile, opts.compilerFlags ?? []);
      assertInProgram(targets, tsc.program, tsconfig);
      after = tsc.errors;
      timing_ms.compile = tsc.ms;

      const remaining = pick(after, targets);
      const introduced = introducedBy(before, after);
      compile_ok = Object.keys(remaining).length === 0 && Object.keys(introduced).length === 0;
      if (!compile_ok) {
        errorMessage = truncateError(tsc.message);
        problems.push(
          `tsc is not satisfied: ${Object.keys(remaining).length > 0
            ? `${Object.entries(remaining).map(([f, n]) => `${n} error(s) left in ${f}`).join(", ")}`
            : "no errors left in the task's files"}` +
          `${Object.keys(introduced).length > 0
            ? `; ${Object.entries(introduced).map(([f, n]) => `${n} new error(s) in ${f}`).join(", ")}`
            : ""}\n${tsc.message}`,
        );
      }

      // Skipped when the verdict is already settled. The suite is the expensive stage of this workload
      // — the same reason workload #1 skips mutation — and a change that does not compile cannot be
      // rescued by running it.
      if (compile_ok) {
        stage_reached = "tests";
        const suite = await runSuite(sandbox, projectDir, opts.runner, timeouts.tests);
        timing_ms.tests = suite.ms;
        const passedNow = new Set(suite.passed_ids);
        const seenNow = new Set(suite.seen_ids);
        // A test that passed before and **failed** after is a regression. A test whose id is not in
        // the report at all is not evidence of anything, and calling it a regression fails good
        // changes on any project whose test titles are generated — a `describe` built from
        // `Date.now()` gets a different id every run, so its baseline id is never found again
        // (ADR-0053). Measured on a real React project: two such tests failed every candidate.
        //
        // Safe here for a reason specific to this workload: a candidate **cannot** delete a test,
        // because editing a test file is a confinement breach (ADR-0046, ADR-0048), and `ran_after >=
        // ran_before` below still refuses a suite that collected fewer tests than the baseline. So an
        // id that vanished is a renamed test, never a removed one.
        const regressed = opts.baseline.tests.passed_ids.filter((id) => !passedNow.has(id) && seenNow.has(id));
        const vanished = opts.baseline.tests.passed_ids.filter((id) => !seenNow.has(id)).length;
        tests = {
          reported: suite.reported,
          ran_before: opts.baseline.tests.ran,
          ran_after: suite.ran,
          regressed,
          passed_before: opts.baseline.tests.passed,
          passed_after: suite.passed,
          message: suite.reported && regressed.length === 0
            ? (vanished === 0 ? null : truncateError(
                `${vanished} test(s) that passed in the baseline are absent from this report — generated ` +
                "test names, not regressions; a candidate cannot delete a test (ADR-0053)"))
            : truncateError(suite.message),
        };
        // ADR-0067: `suite.passed >= baseline.passed` is the clause `regressed` cannot express. A
        // `test.each` block shares one `fullName` across its cases, so breaking one of nine leaves the
        // id in `passedNow` and records nothing — and `ran_after >= ran_before` misses it too, because
        // a failing case still ran. Counts catch it, and they are also *more* robust to the generated
        // name problem ADR-0053 solved: a renamed test still counts.
        tests_ok = suite.reported
          && regressed.length === 0
          && suite.ran >= opts.baseline.tests.ran
          && suite.ran > 0
          && suite.passed >= opts.baseline.tests.passed;
        if (tests_ok) stage_reached = "done";
        else if (!suite.reported) {
          problems.push(`the ${opts.runner} run produced no report — a machine problem, not the change's (ADR-0012)\n${suite.message}`);
        } else if (regressed.length > 0) {
          problems.push(
            `${regressed.length} test(s) that passed before now fail:\n` +
            regressed.slice(0, 20).map((t) => `  ${t}`).join("\n") +
            (regressed.length > 20 ? `\n  … and ${regressed.length - 20} more` : ""),
          );
        } else if (suite.passed < opts.baseline.tests.passed) {
          // Named separately from `regressed`, because the correction round and a human read it
          // differently: there are no test *names* to give here — that is precisely why the id-based
          // check missed it — so the sentence has to say what it does know (ADR-0067).
          problems.push(
            `${opts.baseline.tests.passed - suite.passed} fewer test(s) passed than in the baseline ` +
            `(${suite.passed} vs ${opts.baseline.tests.passed}) while no test id stopped passing. That is a ` +
            "`test.each` case breaking under a shared name: the id is still in the passing set, and the " +
            "failing case still ran, so only the counts can see it (ADR-0067)",
          );
        } else {
          problems.push(
            `${suite.ran} tests ran and the baseline ran ${opts.baseline.tests.ran} — a suite that collected ` +
            "fewer tests than before is not a green suite (ADR-0048)",
          );
        }
      }
    } finally {
      if (opts.keepSandbox) process.stderr.write(`sidecrew: task sandbox kept at ${sandbox}\n`);
      else await rm(sandbox, { recursive: true, force: true });
    }
  }

  const fields = {
    task_id: task.task_id,
    stage_reached,
    compile_ok,
    tests_ok,
    confined,
    files_touched,
    errors: {
      before,
      after,
      introduced: introducedBy(before, after),
      remaining_in_target: pick(after, targets),
      message: errorMessage,
    },
    tests,
    confinement,
    // Nothing below gates. `changeSurvives` does not read it and `ChangeVerdict` asserts that (ADR-0057).
    observations: observe(task, candidate),
    refused: null,
    error: problems.length > 0 ? truncateError(problems.join("\n\n")) : null,
    timing_ms,
    // ADR-0069 option A and ADR-0066 option C, both *record and gate nothing*. The two timestamps are
    // the gap a stale baseline hides in; the two samples are the swap delta that separated the one
    // measured false negative from two passes of identical bytes.
    baseline_captured_at: opts.baseline.captured_at,
    verified_at: new Date().toISOString(),
    machine: { before: machineBefore, after: await readMachineState() },
  };
  return ChangeVerdict.parse({ ...fields, survived: changeSurvives({ ...fields, survived: false }) });
}

/**
 * Sandboxes an interrupted run left behind — the housekeeping half of unattended mode.
 *
 * A run removes its own sandbox in a `finally`, so a run that *finishes* leaves nothing. A run that is
 * killed does not, and unattended mode is precisely the feature that makes killed runs ordinary: a
 * closed lid, a Ctrl-C after forty minutes, a machine that reboots. Measured on 18 Sep 2026 during
 * Phase 11b — **nine orphans at roughly 500 MB each**, about 4.5 GB, from one afternoon of restarts.
 * That is not a tidiness problem: the same session was thrashing, and a full disk is one of the ways a
 * gate starts failing for reasons that have nothing to do with the change.
 *
 * **Age is the only safe discriminator and this never sweeps by default.** Two runs can share a
 * machine — they did all day — and a live step sandbox is written only at step boundaries, which are
 * tens of minutes apart, so recency cannot distinguish "in use" from "idle". The rule is therefore
 * conservative by construction: nothing younger than `olderThanHours` is touched, the default is
 * generous, and the caller asks for it explicitly rather than having a run decide to delete something
 * it does not own.
 */
export interface Orphan { path: string; ageHours: number; bytes: number }

const SANDBOX_PREFIXES = ["sidecrew-fix-", "sidecrew-task-"];

/** Bytes under a directory. Best-effort: an unreadable entry contributes nothing rather than throwing. */
async function sizeOf(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const at = stack.pop()!;
    let ents: Dirent[];
    try {
      ents = await readdir(at, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const p = join(at, e.name);
      // Never follow a symlink: `node_modules` is symlinked into every sandbox (above), and following
      // it would report the project's dependencies as the sandbox's own size — and, worse, invite a
      // future version of this to delete through it.
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(p);
      else {
        try {
          total += (await stat(p)).size;
        } catch { /* vanished under us; it was going to be deleted anyway */ }
      }
    }
  }
  return total;
}

export async function findOrphanSandboxes(olderThanHours = 12, root?: string): Promise<Orphan[]> {
  const base = root ?? tmpdir();
  const now = Date.now();
  let names: string[];
  try {
    names = await readdir(base);
  } catch {
    return [];
  }

  const out: Orphan[] = [];
  for (const name of names) {
    if (!SANDBOX_PREFIXES.some((p) => name.startsWith(p))) continue;
    const path = join(base, name);
    try {
      const st = await stat(path);
      if (!st.isDirectory()) continue;
      const ageHours = (now - st.mtimeMs) / 3_600_000;
      if (ageHours < olderThanHours) continue;
      out.push({ path, ageHours, bytes: await sizeOf(path) });
    } catch { /* gone, or not ours to read */ }
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

/** Remove what `findOrphanSandboxes` found. Returns what it actually removed. */
export async function sweepOrphanSandboxes(orphans: Orphan[]): Promise<Orphan[]> {
  const removed: Orphan[] = [];
  for (const o of orphans) {
    // Belt and braces: re-check the prefix at the point of deletion rather than trusting the list we
    // were handed. This function removes directories recursively, and the cost of it being handed a
    // wrong path once is unbounded.
    if (!SANDBOX_PREFIXES.some((p) => basename(o.path).startsWith(p))) continue;
    try {
      await rm(o.path, { recursive: true, force: true });
      removed.push(o);
    } catch { /* ADR-0056: a sandbox that will not delete is the machine's problem, not a failure */ }
  }
  return removed;
}

/** `verifyChange` needs the project's compiler and runner to exist before it spends anything. */
export function assertChangeToolchain(projectDir: string, tsconfig: string): void {
  for (const [what, path] of [["a package.json", "package.json"], [tsconfig, tsconfig]] as const) {
    if (!existsSync(join(resolve(projectDir), path))) throw new VerifierSetupError(`${projectDir} has no ${what}`);
  }
  if (resolveNodeModules(resolve(projectDir)) === null) {
    throw new VerifierSetupError(`no node_modules at or above ${projectDir} — run npm i`);
  }
}
