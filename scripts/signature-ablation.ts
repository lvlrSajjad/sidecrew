// What is the qualified name worth? The one prompt change Phase 6's Swift result points at.
//
//   npm run measure:signature-ablation -- --fixture swift
//   npm run measure:signature-ablation -- --fixture ts
//
// Phase 6 measured a 7B that could not say where a Swift function lives. Every fixture function is a
// static member of an enum; a `line_range` slices it out of that enum, so the worker sees
// `public static func percentChange(...)` and has to infer `Numbers.…`. It inferred
// `SwiftFixture.percentChange(...)` — the module name from `imports_hint` — and 13 of 18 candidates
// never compiled. Haiku, given the identical prompt, wrote `Numbers.percentChange(...)`.
//
// `WorkerTask.function.signature` has carried the qualified name since Phase 0 and
// `src/prompts/worker.md` has never rendered it. This measures whether rendering it helps, on **both**
// fixtures — because a change that rescues Swift and costs TypeScript is not an improvement, and
// TypeScript is the fixture where the shipped prompt already scores 0.85.
//
// Held constant: the same tasks built once per fixture, seed 42, temperature 0, verifier concurrency 1,
// one worker, one in-flight request. **No retry** — this is first-attempt survival, the same convention
// Phase 5's ablation used (ADR-0017), so the effect is attributable to the wording and not to a second
// attempt that had the compiler error to read. Phase 6's own first-attempt numbers are recomputed from
// its stored records for the comparison, rather than quoted from a run that included retries.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { discoverWorkers, generate, portsFromEnv, RUN_SEED } from "../src/batch.js";
import { readMemory } from "../src/doctor.js";
import { buildTasks, functionOfTaskId, loadPlan, verifyCandidate, type LoadedPlan } from "../src/plan.js";
import { run } from "../src/exec.js";
import { safeName } from "../src/verifier/shared.js";
import type { Verdict, WorkerTask } from "../src/schemas.js";

const FIXTURES = {
  ts: {
    plans: ["strings", "numbers", "arrays", "async"].map((m) => `fixtures/ts-fixture/plans/${m}/test_plan.json`),
    ext: ".test.ts",
  },
  swift: {
    plans: ["Strings", "Numbers", "Arrays", "Machine", "Async"].map((m) => `fixtures/swift-fixture/plans/${m}/test_plan.json`),
    ext: ".swift",
  },
} as const;
type FixtureId = keyof typeof FIXTURES;

const VARIANTS = [
  { id: "shipped", file: "experiments/signature-ablation/variants/shipped.md", has: "src/prompts/worker.md as it ships" },
  { id: "signature", file: "experiments/signature-ablation/variants/signature.md", has: "shipped + the qualified name on the 'Function under test' line" },
] as const;

const RESULTS = "experiments/go-no-go/results";
const CANDIDATES = "experiments/signature-ablation/candidates";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const say = (line: string): void => { process.stderr.write(`${line}\n`); };

const quantile = (values: number[], q: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0;
};

const version = async (cmd: string, args: string[]): Promise<string> => {
  try {
    const r = await run(cmd, args, { timeoutMs: 20_000 });
    return `${r.stdout}${r.stderr}`.trim().split("\n")[0] ?? "";
  } catch {
    return "unknown";
  }
};

interface Outcome {
  task_id: string;
  survived: boolean;
  stage_reached: string;
  compile_ok: boolean;
  pass_ok: boolean;
  tautological: boolean;
  killed: number;
  mutation_score: number | null;
  /** The first compiler/runtime diagnostic, so a wall of failures can be classified rather than counted. */
  first_error: string | null;
  completion_tokens: number;
  generate_ms: number;
  verify_ms: number;
}

const DIAGNOSTIC = /error: ([^\n]+)/;

/**
 * Phase 6's first-attempt numbers, recomputed from its stored records.
 *
 * Its headline 4/18 and 17/20 include the one retry. Comparing those against a no-retry ablation would
 * credit the wording with a difference the retry made, which is the mistake ADR-0017 exists to avoid.
 */
async function phase6FirstAttempt(fixture: FixtureId): Promise<Record<string, unknown> | null> {
  const path = join(RESULTS, "partials", `c2-${fixture}.json`);
  if (!existsSync(path)) return null;
  const body = JSON.parse(await readFile(path, "utf8")) as {
    records: { attempts: { attempt: number; survived: boolean; compile_ok: boolean; pass_ok: boolean; killed: number; tautological: boolean }[] }[];
  };
  const firsts = body.records.map((r) => r.attempts[0]).filter((a): a is NonNullable<typeof a> => a !== undefined);
  return {
    source: path,
    tasks: firsts.length,
    survived: firsts.filter((a) => a.survived).length,
    survival_rate: Number((firsts.filter((a) => a.survived).length / firsts.length).toFixed(3)),
    compiled: firsts.filter((a) => a.compile_ok).length,
    passed: firsts.filter((a) => a.pass_ok).length,
    killed_ge_1: firsts.filter((a) => a.killed >= 1).length,
  };
}

async function main(): Promise<void> {
  const fixture = (flag("--fixture") ?? "") as FixtureId;
  if (!(fixture in FIXTURES)) throw new Error(`--fixture must be one of ${Object.keys(FIXTURES).join(", ")}`);

  const plans: LoadedPlan[] = [];
  const tasks: { task: WorkerTask; plan: LoadedPlan }[] = [];
  for (const path of FIXTURES[fixture].plans) {
    const plan = await loadPlan(path);
    plans.push(plan);
    for (const task of buildTasks(plan)) tasks.push({ task, plan });
  }
  say(`${tasks.length} tasks over ${plans.length} plans`);

  const worker = (await discoverWorkers(portsFromEnv()))[0];
  if (worker === undefined) throw new Error("no local worker is answering — start one with: sidecrew serve");
  say(`worker ${worker.model} @ ${worker.revision.slice(0, 12) || "unpinned"} on ${worker.baseUrl}`);

  const mem = await readMemory();
  const variants: Record<string, unknown>[] = [];

  for (const variant of VARIANTS) {
    const template = await readFile(variant.file, "utf8");
    const dir = join(CANDIDATES, `${fixture}-${variant.id}`);
    await mkdir(dir, { recursive: true });
    const outcomes: Outcome[] = [];
    say(`\n── ${variant.id} ──`);

    for (const { task, plan } of tasks) {
      const t0 = performance.now();
      const candidate = await generate(task, worker, { template });
      const t1 = performance.now();
      const verdict: Verdict = await verifyCandidate(plan, candidate, functionOfTaskId(task.task_id), { concurrency: 1 });
      const t2 = performance.now();

      const diagnostic = DIAGNOSTIC.exec(verdict.error ?? "");
      outcomes.push({
        task_id: task.task_id,
        survived: verdict.survived,
        stage_reached: verdict.stage_reached,
        compile_ok: verdict.compile_ok,
        pass_ok: verdict.pass_ok,
        tautological: verdict.tautological,
        killed: verdict.mutation?.killed ?? 0,
        mutation_score: verdict.mutation?.score ?? null,
        first_error: diagnostic?.[1]?.slice(0, 120) ?? null,
        completion_tokens: candidate.usage.completion_tokens,
        generate_ms: Math.round(t1 - t0),
        verify_ms: Math.round(t2 - t1),
      });
      await writeFile(join(dir, `${safeName(task.task_id)}${FIXTURES[fixture].ext}`), candidate.test_source, "utf8");
      say(`  ${verdict.survived ? "survived" : `failed ${verdict.stage_reached}`.padEnd(15)}  ${task.task_id}`);
    }

    const survivors = outcomes.filter((o) => o.survived);
    const errors = outcomes.reduce<Record<string, number>>((acc, o) => {
      if (o.first_error === null) return acc;
      acc[o.first_error] = (acc[o.first_error] ?? 0) + 1;
      return acc;
    }, {});
    variants.push({
      id: variant.id,
      prompt: variant.file,
      contains: variant.has,
      tasks: outcomes.length,
      survived: survivors.length,
      survival_rate: Number((survivors.length / outcomes.length).toFixed(3)),
      funnel: {
        compiled: outcomes.filter((o) => o.compile_ok).length,
        passed: outcomes.filter((o) => o.pass_ok).length,
        killed_ge_1: outcomes.filter((o) => o.killed >= 1).length,
        non_tautological: outcomes.filter((o) => o.killed >= 1 && !o.tautological).length,
      },
      median_mutation_score_of_survivors: survivors.length === 0
        ? null
        : Number(quantile(survivors.map((o) => o.mutation_score ?? 0), 0.5).toFixed(3)),
      median_completion_tokens: quantile(outcomes.map((o) => o.completion_tokens), 0.5),
      generate_ms: { median: quantile(outcomes.map((o) => o.generate_ms), 0.5) },
      verify_ms: { median: quantile(outcomes.map((o) => o.verify_ms), 0.5) },
      first_errors: Object.fromEntries(Object.entries(errors).sort((a, b) => b[1] - a[1])),
      outcomes,
    });
  }

  const result = {
    measured: true,
    experiment: "signature-ablation",
    fixture,
    date: new Date().toISOString(),
    question: "does rendering WorkerTask.function.signature — the qualified name — change first-attempt survival?",
    machine: {
      host: hostname(),
      total_gb: mem?.total_gb ?? null,
      free_gb_at_start: mem?.free_gb ?? null,
      macos: await version("sw_vers", ["-productVersion"]),
      node: process.version,
      mlx_lm: await version("python3", ["-c", "import mlx_lm; print(mlx_lm.__version__)"]),
    },
    worker: { kind: "local", model: worker.model, revision: worker.revision, temperature: 0, seed: RUN_SEED },
    held_constant: [
      "the same WorkerTasks, built once from the plans and reused for both variants",
      `seed ${RUN_SEED}, temperature 0`,
      "verifier concurrency 1, one worker, one in-flight request",
      "no retry: first-attempt survival, as in ADR-0017's ablation",
    ],
    phase6_c2_first_attempt: await phase6FirstAttempt(fixture),
    variants,
  };

  await mkdir(RESULTS, { recursive: true });
  const path = `${RESULTS}/signature-ablation-${fixture}-${new Date().toISOString().slice(0, 10)}.json`;
  if (existsSync(path) && !argv.includes("--force")) {
    throw new Error(`${path} already exists — pass --force to overwrite`);
  }
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  say("\n── result ──");
  for (const v of variants as { id: string; survived: number; tasks: number; funnel: Record<string, number> }[]) {
    say(`${v.id.padEnd(10)} ${v.survived}/${v.tasks}  compiled ${v.funnel.compiled} → passed ${v.funnel.passed} → killed≥1 ${v.funnel.killed_ge_1}`);
  }
  say(`wrote ${path}`);
}

main().catch((e) => {
  process.stderr.write(`${String((e as Error)?.stack ?? e)}\n`);
  process.exit(1);
});
