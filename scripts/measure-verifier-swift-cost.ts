// What one Swift candidate costs to verify. `npm run measure:verifier-swift`.
//
// Writes experiments/go-no-go/results/verifier-swift-cost.json with "measured": true and the machine it
// came from, for the same reason `bench` does (CLAUDE.md): the go/no-go rule compares wall time across
// runs, and a minute per candidate is only a number if you know what was running beside it.
//
// It measures three things the design turns on, and the first two are where Swift stops resembling
// TypeScript:
//   * the cost of a verdict, split by stage, over the nine catalogue candidates;
//   * function scope against whole-file scope — where Stryker bought 3.3× *and* a usable score
//     (ADR-0013), Muter has no `--mutate file:from-to`, so the scope is applied to its report instead of
//     to its run. The score should move and the clock should not, and this is what says whether it does;
//   * Muter's coverage pass against `--skip-coverage`, which is the one flag with a real cost attached.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { machineInfo, RESULTS_DIR, type MachineInfo } from "../src/bench.js";
import { readMemory } from "../src/doctor.js";
import { DEFAULT_MUTANT_TIMEOUT_S, verifySwift, type SwiftFramework } from "../src/verifier/swift.js";
import { deriveLineRange } from "../src/verifier/shared.js";
import type { Candidate, Verdict } from "../src/schemas.js";

const FIXTURE = "fixtures/swift-fixture";
const OUT = join(RESULTS_DIR, "verifier-swift-cost.json");

interface CandidateEntry {
  file: string;
  task_id: string;
  source: string;
  function: string;
  shape: string;
  framework: SwiftFramework;
  test_target: string;
  expect: "survives" | "tautological";
}

type Scope = "function" | "file";
type Coverage = "muter-default" | "skip-coverage";

interface Measurement {
  task_id: string;
  file: string;
  function: string;
  shape: string;
  framework: SwiftFramework;
  expected: CandidateEntry["expect"];
  scope: Scope;
  coverage: Coverage;
  survived: boolean;
  stage_reached: Verdict["stage_reached"];
  tautological: boolean;
  mutation_score: number | null;
  killed: number | null;
  /** Mutants Muter reported as runtimeError: a crash, or one the wrapper's watchdog stopped. */
  timed_out: number | null;
  mutants: number | null;
  timing_ms: Verdict["timing_ms"] & { total: number };
}

const candidate = (entry: CandidateEntry, test_source: string): Candidate => ({
  task_id: entry.task_id,
  worker: { kind: "local", model: FIXTURE, revision: "checked-in", temperature: 0, seed: 42 },
  test_source,
  usage: { prompt_tokens: 0, completion_tokens: 0 },
  timing: { ttft_ms: 0, wall_ms: 0 },
});

const measure = async (entry: CandidateEntry, scope: Scope, coverage: Coverage): Promise<Measurement> => {
  const source = await readFile(join(FIXTURE, entry.file), "utf8");
  const started = Date.now();
  const verdict = await verifySwift(candidate(entry, source), {
    skipCoverage: coverage === "skip-coverage",
    target: {
      projectDir: FIXTURE,
      sourceFile: entry.source,
      functionName: entry.function,
      framework: entry.framework,
      testTarget: entry.test_target,
      // `null` counts every mutant in the file; omitted derives the function's range from the source.
      lineRange: scope === "file" ? null : deriveLineRange(await readFile(join(FIXTURE, entry.source), "utf8"), entry.function, "swift"),
    },
  });
  const total = Date.now() - started;
  const m = verdict.mutation;
  process.stdout.write(
    `${entry.file.padEnd(44)} ${scope.padEnd(8)} ${coverage.padEnd(14)} ${verdict.survived ? "survived" : "failed  "} ` +
    `${String(total).padStart(7)} ms  (compile ${verdict.timing_ms.compile ?? 0}, pass ${verdict.timing_ms.pass ?? 0}, mutation ${verdict.timing_ms.mutation ?? 0})\n`,
  );
  return {
    task_id: entry.task_id,
    file: entry.file,
    function: entry.function,
    shape: entry.shape,
    framework: entry.framework,
    expected: entry.expect,
    scope,
    coverage,
    survived: verdict.survived,
    stage_reached: verdict.stage_reached,
    tautological: verdict.tautological,
    mutation_score: m?.score ?? null,
    killed: m?.killed ?? null,
    timed_out: m?.timeout ?? null,
    mutants: m === null ? null : m.killed + m.survived + m.timeout + m.no_coverage,
    timing_ms: { ...verdict.timing_ms, total },
  };
};

const quantile = (values: number[], q: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[at] ?? 0;
};

const totals = (rows: Measurement[]): number[] => rows.map((r) => r.timing_ms.total);

interface CostReport {
  created: string;
  what: string;
  machine: MachineInfo;
  config: {
    fixture: string;
    candidates: number;
    mutant_timeout_s: number;
    muter_version: string;
    swift_version: string;
    /** The prompt asked. A SwiftPM package targeting macOS never boots one, and this records that. */
    simulator_required: false;
  };
  candidates: Measurement[];
  summary: Record<string, unknown>;
  measured: true;
}

const versionOf = async (cmd: string, args: string[]): Promise<string> => {
  const { run } = await import("../src/exec.js");
  const r = await run(cmd, args, { timeoutMs: 30_000 });
  return `${r.stdout}\n${r.stderr}`.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "unknown";
};

const main = async (): Promise<void> => {
  const catalogue = (JSON.parse(await readFile(join(FIXTURE, "candidates.json"), "utf8")) as { candidates: CandidateEntry[] }).candidates;
  const machine = await machineInfo(await readMemory());
  if (machine.on_battery) process.stdout.write("WARNING: on battery — these numbers are about a throttled machine\n");

  const scoped: Measurement[] = [];
  for (const entry of catalogue) scoped.push(await measure(entry, "function", "muter-default"));

  // Only the survivors are worth comparing on either axis: a tautology never reaches the mutation
  // stage, so neither the scope nor the coverage flag changes anything about what it cost.
  const survivorEntries = catalogue.filter((c) => c.expect === "survives");
  const wholeFile: Measurement[] = [];
  for (const entry of survivorEntries) wholeFile.push(await measure(entry, "file", "muter-default"));
  const noCoverage: Measurement[] = [];
  for (const entry of survivorEntries) noCoverage.push(await measure(entry, "function", "skip-coverage"));

  const survivors = scoped.filter((m) => m.expected === "survives");
  const tautologies = scoped.filter((m) => m.expected === "tautological");

  const report: CostReport = {
    created: new Date().toISOString(),
    what: "wall clock for one candidate through verifySwift (tautology → swift build → swift test → muter) on fixtures/swift-fixture",
    machine,
    config: {
      fixture: FIXTURE,
      candidates: catalogue.length,
      mutant_timeout_s: DEFAULT_MUTANT_TIMEOUT_S,
      muter_version: await versionOf("muter", ["--version"]),
      swift_version: await versionOf("swift", ["--version"]),
      simulator_required: false,
    },
    candidates: [...scoped, ...wholeFile, ...noCoverage],
    summary: {
      per_candidate_ms: {
        survivor_median: quantile(totals(survivors), 0.5),
        survivor_p90: quantile(totals(survivors), 0.9),
        survivor_max: Math.max(...totals(survivors)),
        // The static check is what keeps these off the expensive stage entirely.
        tautology_median: quantile(totals(tautologies), 0.5),
      },
      stage_median_ms: {
        compile: quantile(scoped.map((m) => m.timing_ms.compile ?? 0), 0.5),
        pass: quantile(scoped.map((m) => m.timing_ms.pass ?? 0), 0.5),
        mutation: quantile(survivors.map((m) => m.timing_ms.mutation ?? 0), 0.5),
      },
      // Muter cannot be told a line range, so this is the pair ADR-0013 measured for Stryker with the
      // cost half removed on purpose: the clock should barely move and the score should.
      mutation_scope_ms: {
        function_scoped_median: quantile(totals(survivors), 0.5),
        whole_file_median: quantile(totals(wholeFile), 0.5),
      },
      mutation_score: {
        function_scoped_median: quantile(survivors.map((m) => m.mutation_score ?? 0), 0.5),
        whole_file_median: quantile(wholeFile.map((m) => m.mutation_score ?? 0), 0.5),
      },
      mutants_counted: {
        function_scoped_median: quantile(survivors.map((m) => m.mutants ?? 0), 0.5),
        whole_file_median: quantile(wholeFile.map((m) => m.mutants ?? 0), 0.5),
      },
      coverage_pass_ms: {
        muter_default_median: quantile(totals(survivors), 0.5),
        skip_coverage_median: quantile(totals(noCoverage), 0.5),
      },
      by_framework_ms: {
        xctest_median: quantile(totals(survivors.filter((m) => m.framework === "xctest")), 0.5),
        swift_testing_median: quantile(totals(survivors.filter((m) => m.framework === "swift-testing")), 0.5),
      },
      // ADR-0005's regression, as a number: every kill a Swift Testing candidate earned was reported by
      // Muter as `failed` rather than `runtimeError`. Without `sidecrew-test.sh` this is 0.
      swift_testing_kills: survivors
        .filter((m) => m.framework === "swift-testing")
        .reduce((sum, m) => sum + (m.killed ?? 0), 0),
    },
    measured: true,
  };

  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\n${OUT}\n${JSON.stringify(report.summary, null, 2)}\n`);
};

await main();
