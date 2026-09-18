// Swift verifier: tautology → swift build → swift test → Muter, scoped to one function of one file.
//
// Same four words as the TypeScript verifier and the same `Verdict` shape (CLAUDE.md #2), reached by a
// different route because Muter is not Stryker. Four differences are load-bearing and every one of them
// was measured rather than assumed — ADR-0005 has the evidence:
//
//   * **Muter cannot see a Swift Testing failure.** It decides a mutant was killed by matching
//     `with ([1-9][0-9]*) failure` against the test output — an XCTest summary line that Swift Testing
//     never prints. Every detected mutant of a `@Test` came back `runtimeError`, indistinguishable from
//     a crash, so no Swift Testing candidate could ever have survived. `sidecrew-test.sh` translates the
//     one verdict into the one sentence Muter reads, and the outcome becomes `failed` again.
//   * **Muter has no per-mutant timeout.** A mutant that turns `size < 1` into `size > 1` makes
//     `chunk`'s loop step by zero, and the run hangs until something outside kills it. The same wrapper
//     owns the watchdog, and a timed-out mutant lands in the `timeout` bucket where ADR-0012 puts it.
//   * **Muter has no `--mutate file:from-to`.** Scoping is per file, so the function scope of ADR-0013
//     is applied to the report instead of to the run: the score is about the function under test, the
//     cost is still about the file.
//   * **`swift test` exits 0 when it runs nothing.** A filter that matches no test, or a class whose
//     methods are not named `test…`, passes the run stage without evaluating a single assertion. The
//     exit code cannot see this, so the stage counts the tests both frameworks report.
//
// The sandbox rules are ADR-0004's, with one addition Swift forces: the build directory lives *outside*
// the sandbox, because Muter copies the project wholesale and a copied `.build` carries a module cache
// pinned to the path it was built at.
import { cp, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { run, type RunResult } from "../exec.js";
import { MutationResult, survives, Verdict, type Candidate, type Stage } from "../schemas.js";
import { analyseTautology, type TautologyReport } from "./tautology.js";
import { deriveLineRange, output, safeName, truncateError, VerifierSetupError } from "./shared.js";

export { VerifierSetupError };

/** The two frameworks `swift test` runs, and the two the fixture has a target for. */
export type SwiftFramework = "xctest" | "swift-testing";

/** What the candidate was asked to test. Phase 4 fills this from the `TestPlan`; Phase 3 is explicit. */
export interface SwiftTarget {
  /** Package root: the directory holding `Package.swift`. */
  projectDir: string;
  /** Source file under test, relative to `projectDir` — e.g. `Sources/SwiftFixture/Strings.swift`. */
  sourceFile: string;
  /** The function under test. The tautology check and the mutation scope are both about this name. */
  functionName: string;
  /**
   * 1-based and inclusive, as `TestPlan.functions[].line_range` records it. Unlike Stryker, Muter
   * cannot be *told* a range, so this filters its report rather than its run: the candidate is graded
   * only on mutants of its own function, but the wall clock is still the whole file's (ADR-0005).
   *
   * Three values, three meanings: a range is used as given; `null` counts the whole file on purpose;
   * omitted derives the range from the source, which is what Phase 3 does because there is no planner
   * yet to supply one.
   */
  lineRange?: readonly [number, number] | null;
  /** Which framework the candidate is written in. Decides the `--filter` and nothing else. */
  framework: SwiftFramework;
  /**
   * The test target the candidate is written into, as the directory name under `Tests/`. Required when
   * the package has more than one, because guessing which target a candidate belongs to from its
   * framework is exactly the kind of inference that is right until it is silently wrong.
   */
  testTarget?: string;
  /** File name for the candidate inside that target. Defaults to one derived from the task id. */
  testFile?: string;
}

export interface StageTimeouts {
  compile: number;
  pass: number;
  mutation: number;
}

/**
 * Swift is slower than TypeScript at every stage and the mutation run rebuilds per mutant, so these are
 * roughly double Phase 2's. They bound the *whole* stage; the per-mutant bound is `mutantTimeoutS`.
 */
export const DEFAULT_TIMEOUTS: StageTimeouts = { compile: 300_000, pass: 300_000, mutation: 1_800_000 };

/**
 * Per-mutant wall clock, enforced by `sidecrew-test.sh` because Muter enforces nothing. Generous next to
 * the ~1.2 s a warm mutant run takes on the fixture, because the first mutant after Muter's copy pays
 * for a cold build and a mutant killed by the clock is a mutant we learn nothing from.
 *
 * It is not free, and the fixture makes that visible: one mutant of `chunk` never finishes, so this
 * constant is 60 of that candidate's 92.6 s — the single largest line item in the slowest verdict
 * measured (`verifier-swift-cost.json`). Deriving it from the baseline the pass stage already timed is
 * in BACKLOG; picking a smaller constant on the evidence of one fixture is not.
 */
export const DEFAULT_MUTANT_TIMEOUT_S = 60;

export interface VerifySwiftOpts {
  target: SwiftTarget;
  timeouts?: Partial<StageTimeouts>;
  mutantTimeoutS?: number;
  /** Leave the sandbox on disk and print its path. For debugging a verdict you do not believe. */
  keepSandbox?: boolean;
  /** Where sandboxes are made. Defaults to the OS temp dir, deliberately outside the project. */
  sandboxRoot?: string;
  /**
   * Skip Muter's coverage pass. Measured and then left alone: 28.1 s against 28.0 s with coverage on
   * (`verifier-swift-cost.json`), so it saves nothing and the default is Muter's own behaviour. It
   * stays reachable because a project whose coverage pass is expensive is a project this becomes true
   * for again.
   */
  skipCoverage?: boolean;
}

/**
 * Never copied into a sandbox: build output, VCS state, and Muter's own leavings. `.build` is the one
 * that matters — Muter copies the project to a sibling `<name>_mutated` directory, and a module cache
 * built at the old path makes every mutant fail to compile with `missing required module 'SwiftShims'`.
 */
export const NEVER_COPY = new Set([
  ".build", ".git", ".sidecrew", ".swiftpm", "muter_logs", "DerivedData", ".DS_Store",
]);

/** Anything matching this is a test, and tests are what the sandbox must not inherit (ADR-0004). */
export const TEST_FILE_PATTERN = /\.swift$/;

// ── the files written into the sandbox ────────────────────────────────────────────────────────────

/** Muter's configuration file. The name is Muter's, not ours; it reads no other. */
export const MUTER_CONFIG = "muter.conf.yml";
/** The wrapper Muter runs instead of `swift test`. See the header and ADR-0005. */
export const TEST_RUNNER = "sidecrew-test.sh";
/** Where Muter's json report is written, named here rather than defaulted because the verifier reads it. */
export const MUTER_REPORT = "sidecrew-muter.json";

/**
 * The template. `fixtures/swift-fixture/muter.conf.yml` is this text with the defaults, and
 * `test/verifier-swift.test.ts` fails if the two ever differ — the fixture's copy is for a human running
 * `muter run` by hand, and a config that drifted from the one the verifier uses would make that
 * debugging session answer a question nobody asked.
 *
 * `executable` is `/bin/sh` rather than the `/usr/bin/xcrun` the phase prompt asked for, and xcrun is
 * one level down inside the wrapper. That is the whole of the deviation, and ADR-0005 is why.
 */
export function muterConfig(): string {
  // No `--filter`. The sandbox holds exactly one test file, so a filter would buy nothing and would add
  // a way for Muter's baseline to select no tests at all — which `swift test` reports as success.
  const args = [`./${TEST_RUNNER}`, "/usr/bin/xcrun", "swift", "test"];
  return `# Generated by sidecrew (src/verifier/swift.ts). See ADR-0005.
#
# The executable is /bin/sh and not xcrun directly, because ${TEST_RUNNER} does two things Muter 16
# does not: it gives every mutant a deadline, and it translates a Swift Testing failure into the XCTest
# sentence Muter's kill detector actually matches. xcrun is still what runs the tests, one line down.
executable: /bin/sh
arguments:
${args.map((a) => `- ${JSON.stringify(a)}`).join("\n")}
# Belt and braces: the verifier also passes --files-to-mutate, so nothing outside the file under test is
# mutated. This list is what protects a human who runs \`muter run\` here without it.
exclude:
- Package.swift
- Tests
excludeCalls: []
`;
}

export interface TestRunnerOpts {
  mutantTimeoutS?: number;
}

/**
 * The wrapper Muter runs per mutant. Two jobs, both of them things Muter 16 does not do:
 *
 * 1. **A deadline.** Killing it is harder than it looks, and the first version of this script got it
 *    wrong: `xcrun` spawns `swift-test` spawns the built `xctest` binary, and **SwiftPM puts that
 *    binary in a process group of its own**. So `set -m` plus a group kill reaches the two launchers
 *    and stops exactly short of the process that is actually spinning — measured, as two orphaned
 *    `xctest` processes at 100 % CPU with `PPID 1`, still running after the verdict they belonged to
 *    had been returned. The watchdog therefore kills by working directory first: Muter runs each mutant
 *    inside its own `<sandbox>_mutated` copy, every process in that tree names the path in its command
 *    line, and nothing else on the machine does.
 * 2. **A translation.** Muter decides a mutant was killed by matching `with ([1-9][0-9]*) failure`
 *    against the output. That is XCTest's summary line. Swift Testing prints
 *    `✘ Test run with N tests … failed` instead, which matches nothing, so Muter falls back to
 *    `runtimeError` — and a `runtimeError` is not a kill, because it is also what a crash looks like.
 *    The added line is emitted only when Swift Testing actually reported a failed run, so a mutant that
 *    crashed or timed out still reads as `runtimeError` and still does not count towards survival.
 */
export function testRunnerScript(opts: TestRunnerOpts = {}): string {
  const timeout = opts.mutantTimeoutS ?? DEFAULT_MUTANT_TIMEOUT_S;
  return `#!/bin/sh
# Generated by sidecrew (src/verifier/swift.ts). Run by Muter once per mutant. See ADR-0005.
set -m
timeout_s=\${SIDECREW_MUTANT_TIMEOUT_S:-${timeout}}
log=$(mktemp -t sidecrew-swift) || exit 70

"$@" >"$log" 2>&1 &
child=$!
(
  sleep "$timeout_s"
  # By path first, then by process group. SwiftPM runs the built xctest binary in a process group of
  # its own, so the group kill below reaches xcrun and swift-test and leaves the thing that is actually
  # hung spinning for ever with PPID 1. Muter gives each mutant its own <sandbox>_mutated copy, so
  # every process in this tree names $PWD and nothing else on the machine does.
  pkill -9 -f "$PWD" 2>/dev/null
  kill -9 -"$child" 2>/dev/null
) 2>/dev/null &
watchdog=$!
set +m
wait "$child" 2>/dev/null
code=$?
kill -9 "$watchdog" 2>/dev/null
wait "$watchdog" 2>/dev/null

cat "$log"
# Muter looks for XCTest's "with <n> failure" to call a mutant killed. Swift Testing never prints it, so
# without this line every Swift Testing kill is reported as a runtime error instead. Gated on the run
# actually having reported failures: a crash or a timeout must keep reading as a runtime error.
if grep -q 'Test run with .* failed' "$log"; then
  echo "sidecrew: the Swift Testing run failed. Executed 1 tests, with 1 failure."
fi
rm -f "$log"
exit "$code"
`;
}

// ── the mutation report ───────────────────────────────────────────────────────────────────────────

/**
 * Muter's `testSuiteOutcome` → the `MutationResult` in the contract, keeping Phase 2's asymmetry.
 *
 * `failed` is the only outcome that counts towards **survival**, because it is the only one that means
 * a test reported a failure. `runtimeError` — a mutant that crashed the process, or one the wrapper's
 * watchdog killed — goes where ADR-0012 puts a Stryker `Timeout`: into the score, never into
 * `killed ≥ 1`. `buildError` is Muter talking about Swift, not about the test, and is counted nowhere.
 */
const OUTCOME: Record<string, "killed" | "survived" | "timeout" | "no_coverage"> = {
  failed: "killed",
  passed: "survived",
  runtimeError: "timeout",
  noCoverage: "no_coverage",
};

interface RawPosition { line?: unknown; column?: unknown }
interface RawPoint { mutationOperatorId?: unknown; filePath?: unknown; position?: RawPosition }
interface RawOperator { testSuiteOutcome?: unknown; mutationPoint?: RawPoint }
interface RawFileReport { fileName?: unknown; appliedOperators?: RawOperator[] }
interface RawReport { fileReports?: RawFileReport[] }

const posix = (path: string): string => path.split(sep).join("/");

/**
 * Muter's json → `MutationResult`, counting only mutants of the function under test.
 *
 * Muter has no mutant ids, so `killed_ids` carries `<operator>@<line>:<column>` — stable across runs of
 * the same source, and readable, which the contract's opaque Stryker ids are not.
 */
export function parseMuterReport(
  report: unknown,
  sourceFile?: string,
  lineRange?: readonly [number, number] | null,
): MutationResult {
  const reports = (report as RawReport | null)?.fileReports ?? [];
  const wanted = sourceFile === undefined ? null : posix(sourceFile);
  const wantedName = wanted === null ? null : basename(wanted);

  const matches = (fr: RawFileReport): boolean => {
    if (wanted === null) return true;
    // `fileName` is a basename; `filePath` is absolute and inside Muter's `_mutated` copy, so the
    // relative path is the sharper test and the basename is the fallback when a mutant carries none.
    const byPath = (fr.appliedOperators ?? []).some((op) => {
      const path = typeof op.mutationPoint?.filePath === "string" ? posix(op.mutationPoint.filePath) : "";
      return path.length > 0 && path.endsWith(wanted);
    });
    return byPath || fr.fileName === wantedName;
  };

  const selected = reports.filter(matches);
  // A report that names the file differently is still a report about the run we just did; counting
  // nothing would turn a naming difference into "this test killed nothing", which is a lie.
  const counted = selected.length > 0 ? selected : reports;

  const totals = { killed: 0, survived: 0, timeout: 0, no_coverage: 0 };
  const killed_ids: string[] = [];
  for (const fileReport of counted) {
    for (const op of fileReport.appliedOperators ?? []) {
      const bucket = OUTCOME[String(op.testSuiteOutcome)];
      if (bucket === undefined) continue;
      const line = Number(op.mutationPoint?.position?.line ?? 0);
      const column = Number(op.mutationPoint?.position?.column ?? 0);
      // Muter emits a zeroed placeholder for a file the coverage pass found untested. It names no
      // location, so it cannot be attributed to the function under test — and counting an
      // unattributable mutant against the candidate is the mistake ADR-0013 exists to prevent.
      if (line === 0) continue;
      if (lineRange && (line < lineRange[0] || line > lineRange[1])) continue;
      totals[bucket] += 1;
      if (bucket === "killed") killed_ids.push(`${String(op.mutationPoint?.mutationOperatorId ?? "mutant")}@${line}:${column}`);
    }
  }

  const denominator = totals.killed + totals.timeout + totals.survived + totals.no_coverage;
  const score = denominator === 0 ? 0 : (totals.killed + totals.timeout) / denominator;
  return MutationResult.parse({ score, ...totals, killed_ids });
}

// ── reading `swift test` ──────────────────────────────────────────────────────────────────────────

/** XCTest's per-suite and overall summary. Printed several times; the largest is the overall one. */
const XCTEST_SUMMARY = /Executed (\d+) tests?, with \d+ failures?/g;
/** Swift Testing's one summary line, whether the run passed or failed. */
const SWIFT_TESTING_SUMMARY = /Test run with (\d+) tests?\b/g;

const largest = (text: string, pattern: RegExp): number => {
  pattern.lastIndex = 0;
  let best = 0;
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) best = Math.max(best, Number(m[1]));
  return best;
};

/**
 * How many tests actually ran, per framework and in total.
 *
 * This exists because **`swift test` exits 0 when it runs nothing**. A candidate whose tests are never
 * selected — a `--filter` that matches no name, a `@Test` the runner did not pick up — passes the run
 * stage without a single assertion being evaluated. That is a cheap pass in ADR-0006's sense, and the
 * exit code cannot see it.
 */
export function executedTests(text: string): { xctest: number; swiftTesting: number; total: number } {
  const xctest = largest(text, XCTEST_SUMMARY);
  const swiftTesting = largest(text, SWIFT_TESTING_SUMMARY);
  return { xctest, swiftTesting, total: xctest + swiftTesting };
}

/**
 * What to pass to `swift test --filter`, or null when the candidate offers no single name to filter on.
 *
 * Null is a real answer and not a failure: `--filter` is an optimisation here, since the sandbox holds
 * exactly one test file anyway, and a filter guessed wrong would select nothing — which, per
 * `executedTests`, is the one outcome that must never be mistaken for success.
 */
export function deriveTestFilter(source: string, framework: SwiftFramework): string | null {
  const pattern = framework === "xctest"
    ? /^[ \t]*(?:[A-Za-z_]\w*[ \t]+)*class\s+(\w+)\s*:\s*[^{]*\bXCTestCase\b/gm
    : /@Suite\b(?:\s*\([^)]*\))?\s+(?:[A-Za-z_]\w*\s+)*(?:struct|class|enum|actor)\s+(\w+)/g;
  pattern.lastIndex = 0;
  const names = new Set<string>();
  for (let m = pattern.exec(source); m !== null; m = pattern.exec(source)) if (m[1]) names.add(m[1]);
  const [only] = [...names];
  return names.size === 1 && only !== undefined ? only : null;
}

// ── the sandbox ───────────────────────────────────────────────────────────────────────────────────

/** Directory names under `Tests/`, which for a conventionally laid-out package are its test targets. */
export function testTargets(projectDir: string): string[] {
  const tests = join(projectDir, "Tests");
  if (!existsSync(tests)) return [];
  return readdirSync(tests)
    .filter((name) => !name.startsWith("."))
    .filter((name) => statSync(join(tests, name)).isDirectory())
    .sort();
}

/**
 * A copy of the package with its own tests left behind (ADR-0004) and every other test target reduced
 * to a file that declares nothing.
 *
 * The empty placeholder is not decoration: SwiftPM resolves every target named in `Package.swift`, and
 * the alternative — editing the manifest to drop the targets we are not using — would mean the sandbox
 * no longer builds the package the user actually has.
 */
export async function makeSandbox(
  projectDir: string,
  keep: { testTarget: string; testFile: string; source: string },
  root?: string,
): Promise<string> {
  const sandbox = await mkdtemp(join(root ?? tmpdir(), "sidecrew-swift-"));
  await cp(projectDir, sandbox, {
    recursive: true,
    filter: (src) => {
      const rel = relative(projectDir, src);
      if (rel.length === 0) return true;
      const parts = rel.split(sep);
      if (parts.some((part) => NEVER_COPY.has(part))) return false;
      // Every Swift file under Tests/ is somebody else's test until the candidate is written in.
      return !(parts[0] === "Tests" && TEST_FILE_PATTERN.test(basename(src)));
    },
  });

  for (const target of testTargets(projectDir)) {
    await mkdir(join(sandbox, "Tests", target), { recursive: true });
    if (target === keep.testTarget) continue;
    await writeFile(
      join(sandbox, "Tests", target, "SidecrewPlaceholder.swift"),
      "// Left empty by sidecrew: this target is not the one under test, and SwiftPM still resolves it.\n",
      "utf8",
    );
  }

  const candidate = join(sandbox, "Tests", keep.testTarget, keep.testFile);
  await mkdir(dirname(candidate), { recursive: true });
  await writeFile(candidate, keep.source, "utf8");
  return sandbox;
}

/**
 * `swift build` and `swift test` are told to build here, and the path is deliberately a *sibling* of the
 * sandbox rather than the `.build` inside it. Muter copies the project wholesale; a copied module cache
 * still names the directory it was built in, and every mutant then fails to compile.
 */
const scratchPath = (sandbox: string): string => `${sandbox}-build`;

/** Muter's own working copy, which it creates beside the project and does not clean up. */
const mutatedPath = (sandbox: string): string => `${sandbox}_mutated`;

const STAGE_ENV = {
  // Muter's own docs ask for this, and it is the difference between a verdict about the candidate and a
  // verdict about a package whose warnings someone else promoted.
  SWIFT_TREAT_WARNINGS_AS_ERRORS: "NO",
  NO_COLOR: "1",
} as const;

/** A spawn that never happened: `exec.ts` reports a missing binary as `code: null` with no signal. */
const didNotRun = (r: RunResult): boolean => r.code === null && r.signal === null && !r.timedOut;

// ── the verifier ──────────────────────────────────────────────────────────────────────────────────

/**
 * Verify one candidate against one function. Returns a `Verdict`; throws only when the machine cannot
 * run the pipeline at all, because "your toolchain is missing" and "your test is bad" must never arrive
 * at the retry loop wearing the same clothes.
 */
export async function verifySwift(candidate: Candidate, opts: VerifySwiftOpts): Promise<Verdict> {
  const target = opts.target;
  const projectDir = resolve(target.projectDir);
  const timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };

  for (const [what, path] of [["a Package.swift", "Package.swift"], ["a Tests directory", "Tests"], [target.sourceFile, target.sourceFile]] as const) {
    if (!existsSync(join(projectDir, path))) throw new VerifierSetupError(`${projectDir} has no ${what}`);
  }

  const targets = testTargets(projectDir);
  const testTarget = target.testTarget ?? (targets.length === 1 ? targets[0] : undefined);
  if (testTarget === undefined) {
    throw new VerifierSetupError(
      `${projectDir} has ${targets.length} test targets (${targets.join(", ") || "none"}); ` +
      "name the one the candidate belongs to in SwiftTarget.testTarget",
    );
  }
  if (!targets.includes(testTarget)) {
    throw new VerifierSetupError(`${projectDir} has no test target ${testTarget} — found ${targets.join(", ") || "none"}`);
  }
  const testFile = target.testFile ?? `${safeName(candidate.task_id)}.swift`;

  // Free, and the most useful thing the retry can be told, so it is computed before anything is spawned.
  const tautology = analyseTautology(candidate.test_source, target.functionName, "swift");

  const timing_ms: { compile?: number; pass?: number; mutation?: number } = {};
  const problems: string[] = [];
  if (tautology.tautological) problems.push(tautologyMessage(tautology, target.functionName));

  const sandbox = await makeSandbox(projectDir, { testTarget, testFile, source: candidate.test_source }, opts.sandboxRoot);
  const scratch = scratchPath(sandbox);
  let compile_ok = false;
  let pass_ok = false;
  let mutation: MutationResult | null = null;
  let stage_reached: Stage = "compile";

  try {
    const build = await run("swift", ["build", "--build-tests", "--scratch-path", scratch], {
      cwd: sandbox, timeoutMs: timeouts.compile, env: STAGE_ENV,
    });
    timing_ms.compile = build.ms;
    if (didNotRun(build)) throw new VerifierSetupError(`swift could not be run: ${build.stderr.trim()}`);
    compile_ok = build.code === 0;
    if (!compile_ok) problems.push(`swift build --build-tests failed:\n${output(build)}`);

    const filter = compile_ok ? deriveTestFilter(candidate.test_source, target.framework) : null;

    if (compile_ok) {
      stage_reached = "pass";
      const args = ["test", "--scratch-path", scratch, ...(filter === null ? [] : ["--filter", filter])];
      const tested = await run("swift", args, { cwd: sandbox, timeoutMs: timeouts.pass, env: STAGE_ENV });
      timing_ms.pass = tested.ms;
      const ran = executedTests(output(tested));
      pass_ok = tested.code === 0 && ran.total > 0;
      if (tested.code !== 0) {
        problems.push(`swift test failed:\n${output(tested)}`);
      } else if (ran.total === 0) {
        // `swift test` exits 0 when it ran nothing, so the exit code alone would have called this a pass.
        problems.push(
          `swift test ran no tests at all${filter === null ? "" : ` (--filter ${filter} matched nothing)`}. ` +
          `A test that never runs asserts nothing about ${target.functionName}.`,
        );
      }
    }

    // Skipped when the verdict is already settled. Mutation is the overwhelming majority of the cost of
    // a candidate, and a test that does not compile, does not run, or asserts nothing cannot be rescued
    // by mutating the source it was not looking at.
    if (compile_ok && pass_ok && !tautology.tautological) {
      stage_reached = "mutation";
      await writeFile(join(sandbox, MUTER_CONFIG), muterConfig(), "utf8");
      await writeFile(join(sandbox, TEST_RUNNER), testRunnerScript({ mutantTimeoutS: opts.mutantTimeoutS }), "utf8");
      await chmod(join(sandbox, TEST_RUNNER), 0o755);

      const range = target.lineRange === undefined
        ? deriveLineRange(await readFile(join(projectDir, target.sourceFile), "utf8"), target.functionName, "swift")
        : target.lineRange;

      const muterArgs = [
        "run",
        "--files-to-mutate", posix(target.sourceFile),
        "--format", "json",
        "--output", MUTER_REPORT,
        // Nothing here should ever reach the network, and a version check inside a verifier is a
        // non-deterministic step in a pipeline whose whole point is that it is not one.
        "--skip-update-check",
        ...(opts.skipCoverage === true ? ["--skip-coverage"] : []),
      ];
      const mutated = await run("muter", muterArgs, { cwd: sandbox, timeoutMs: timeouts.mutation, env: STAGE_ENV });
      timing_ms.mutation = mutated.ms;
      if (didNotRun(mutated)) throw new VerifierSetupError(`muter could not be run: ${mutated.stderr.trim()}`);

      const report = await readReport(join(sandbox, MUTER_REPORT));
      if (report === null) {
        // The mutation run itself broke. `stage_reached` says so, because escalating this candidate as
        // though its test were at fault would retry a machine problem at the worker's expense (ADR-0012).
        problems.push(`muter produced no ${MUTER_REPORT}:\n${output(mutated)}`);
      } else {
        stage_reached = "done";
        mutation = parseMuterReport(report, target.sourceFile, range);
        if (mutation.killed === 0) problems.push(noKillMessage(mutation, target.functionName, range));
      }
    }
  } finally {
    if (opts.keepSandbox) {
      process.stderr.write(`sidecrew: sandbox kept at ${sandbox} (build at ${scratch}, muter copy at ${mutatedPath(sandbox)})\n`);
    } else {
      // Three directories, because Muter and SwiftPM each put one beside the sandbox rather than in it.
      await Promise.all([sandbox, scratch, mutatedPath(sandbox)].map((d) => rm(d, { recursive: true, force: true })));
    }
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

/**
 * Why nothing was killed, and the two answers are not the same problem.
 *
 * Muter's operator set is four rules wide — RelationalOperatorReplacement, RemoveSideEffects,
 * ChangeLogicalConnector, SwapTernary — so a function built out of Foundation calls and no branches has
 * no mutants at all. Telling a worker "your test killed nothing" about a function nothing can mutate
 * would spend the single retry on a test that was never the problem.
 */
const noKillMessage = (m: MutationResult, fn: string, range: readonly [number, number] | null): string => {
  const total = m.killed + m.survived + m.timeout + m.no_coverage;
  if (total === 0) {
    return `muter generated no mutants of ${fn}${range ? ` (lines ${range[0]}-${range[1]})` : ""}. ` +
      "Its operators are RelationalOperatorReplacement, RemoveSideEffects, ChangeLogicalConnector and " +
      "SwapTernary, and this function contains none of them, so no test of it can kill one. " +
      "This is not a fault in the test.";
  }
  return `no mutant of ${fn} was killed: ${m.survived} survived, ${m.no_coverage} were never reached, ` +
    `${m.timeout} crashed or timed out rather than failing an assertion. ` +
    "The test passes against the original code and against every changed version of it.";
};

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
