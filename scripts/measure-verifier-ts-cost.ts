// What one candidate costs to verify. `npm run measure:verifier-ts`.
//
// Writes experiments/go-no-go/results/verifier-ts-cost.json with "measured": true and the machine it
// came from, for the same reason `bench` does (CLAUDE.md): the go/no-go rule compares wall time across
// runs, and a second per candidate is only a number if you know what was running beside it.
//
// It measures two things the design turns on:
//   * the cost of a verdict, split by stage, over the eight catalogue candidates;
//   * function-scoped mutation against whole-file mutation, which is the one lever that moved it.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { machineInfo, RESULTS_DIR, type MachineInfo } from "../src/bench.js";
import { readMemory } from "../src/doctor.js";
import { DEFAULT_STRYKER_CONCURRENCY, deriveLineRange, verifyTs } from "../src/verifier/ts.js";
import type { Candidate, Verdict } from "../src/schemas.js";

const FIXTURE = "fixtures/ts-fixture";
const OUT = join(RESULTS_DIR, "verifier-ts-cost.json");

interface CandidateEntry {
  file: string;
  task_id: string;
  source: string;
  function: string;
  shape: string;
  expect: "survives" | "tautological";
}

interface Measurement {
  task_id: string;
  file: string;
  function: string;
  shape: string;
  expected: CandidateEntry["expect"];
  /** Whole-file mutation, for the scoping comparison; absent on the default scoped runs. */
  scope: "function" | "file";
  survived: boolean;
  stage_reached: Verdict["stage_reached"];
  tautological: boolean;
  mutation_score: number | null;
  killed: number | null;
  timing_ms: Verdict["timing_ms"] & { total: number };
}

const candidate = (entry: CandidateEntry, test_source: string): Candidate => ({
  task_id: entry.task_id,
  worker: { kind: "local", model: "fixtures/ts-fixture", revision: "checked-in", temperature: 0, seed: 42 },
  test_source,
  usage: { prompt_tokens: 0, completion_tokens: 0 },
  timing: { ttft_ms: 0, wall_ms: 0 },
});

const measure = async (entry: CandidateEntry, scope: Measurement["scope"]): Promise<Measurement> => {
  const source = await readFile(join(FIXTURE, entry.file), "utf8");
  const started = Date.now();
  const verdict = await verifyTs(candidate(entry, source), {
    target: {
      projectDir: FIXTURE,
      sourceFile: entry.source,
      functionName: entry.function,
      // `null` is "mutate the whole file"; omitted derives the function's range from the source.
      lineRange: scope === "file" ? null : deriveLineRange(await readFile(join(FIXTURE, entry.source), "utf8"), entry.function),
    },
  });
  const total = Date.now() - started;
  process.stdout.write(
    `${entry.file.padEnd(42)} ${scope.padEnd(9)} ${verdict.survived ? "survived" : "failed  "} ` +
    `${String(total).padStart(6)} ms  (compile ${verdict.timing_ms.compile ?? 0}, pass ${verdict.timing_ms.pass ?? 0}, mutation ${verdict.timing_ms.mutation ?? 0})\n`,
  );
  return {
    task_id: entry.task_id,
    file: entry.file,
    function: entry.function,
    shape: entry.shape,
    expected: entry.expect,
    scope,
    survived: verdict.survived,
    stage_reached: verdict.stage_reached,
    tautological: verdict.tautological,
    mutation_score: verdict.mutation?.score ?? null,
    killed: verdict.mutation?.killed ?? null,
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
  config: { stryker_concurrency: number; fixture: string; candidates: number };
  candidates: Measurement[];
  summary: Record<string, unknown>;
  measured: true;
}

const main = async (): Promise<void> => {
  const catalogue = (JSON.parse(await readFile(join(FIXTURE, "candidates.json"), "utf8")) as { candidates: CandidateEntry[] }).candidates;
  const machine = await machineInfo(await readMemory());
  if (machine.on_battery) process.stdout.write("WARNING: on battery — these numbers are about a throttled machine\n");

  const scoped: Measurement[] = [];
  for (const entry of catalogue) scoped.push(await measure(entry, "function"));
  // Only the survivors are worth comparing: a tautology never reaches the mutation stage, so its cost
  // is the same whatever the scope would have been.
  const wholeFile: Measurement[] = [];
  for (const entry of catalogue.filter((c) => c.expect === "survives")) wholeFile.push(await measure(entry, "file"));

  const survivors = scoped.filter((m) => m.expected === "survives");
  const tautologies = scoped.filter((m) => m.expected === "tautological");

  const report: CostReport = {
    created: new Date().toISOString(),
    what: "wall clock for one candidate through verifyTs (tautology → tsc → vitest → stryker) on fixtures/ts-fixture",
    machine,
    config: { stryker_concurrency: DEFAULT_STRYKER_CONCURRENCY, fixture: FIXTURE, candidates: catalogue.length },
    candidates: [...scoped, ...wholeFile],
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
      mutation_scope_ms: {
        function_scoped_median: quantile(totals(survivors), 0.5),
        whole_file_median: quantile(totals(wholeFile), 0.5),
      },
      mutation_score: {
        function_scoped_median: quantile(survivors.map((m) => m.mutation_score ?? 0), 0.5),
        whole_file_median: quantile(wholeFile.map((m) => m.mutation_score ?? 0), 0.5),
      },
    },
    measured: true,
  };

  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\n${OUT}\n${JSON.stringify(report.summary, null, 2)}\n`);
};

await main();
