// Which functions of a module can be mutation-tested at all?
//
//   npx tsx scripts/probe-mutants.ts --module fixtures/swift-fixture/Sources/SwiftFixture/Strings.swift \
//     --tests experiments/mutant-probe/swift --test-target SwiftFixtureXCTests --framework xctest
//
// ADR-0016 gave the planner a rule it cannot follow by reading code: **do not plan a function with no
// mutants.** A candidate for one can never survive — `killed ≥ 1` is unreachable — so the task burns a
// generate and a verify to produce an escalation that is not the worker's fault, and any survival rate
// computed over it reports on somebody's tsconfig or on Muter's operator set rather than on the model.
//
// Whether a function has mutants is not predictable by eye in either language, and for opposite reasons:
// Stryker generates dozens and its type checker throws out the ones that do not type, Muter has four
// operators and generates almost none. So it is measured, once, before a plan is written.
//
// The probe needs a *real* test per function — one that compiles, passes, and calls the thing. A test
// that asserts nothing is caught by the tautology detector and short-circuits before the mutation stage
// ever runs (ADR-0006), so there is no cheap way to ask this question. `--tests <dir>` holds one file
// per function, named for it. They are throwaway and are not exemplars: an exemplar has to be worth
// copying, a probe only has to be honest.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { hostname } from "node:os";
import { readMemory } from "../src/doctor.js";
import { deriveLineRange } from "../src/verifier/shared.js";
import { isTestRunner, verifyTs, type TestRunner } from "../src/verifier/ts.js";
import { verifySwift, type SwiftFramework } from "../src/verifier/swift.js";
import { classifyProbe, type Plannable } from "../src/verifier/probe.js";
import { findProjectRoot, testSuffixFor } from "../src/plan.js";
import type { Verdict } from "../src/schemas.js";

const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

const say = (line: string): void => { process.stderr.write(`${line}\n`); };

interface Probe {
  function: string;
  mutants: number;
  killed: number;
  survived: number;
  timeout: number;
  no_coverage: number;
  /**
   * `yes` — a mutant was killed by an assertion, so the function is demonstrably survivable.
   * `no_mutants` — nothing to kill.
   * `crash_only` — every mutant crashed rather than failing an assertion, so no test can ever kill one.
   * `unknown` — mutants survived this probe. Either the probe was weak or they are equivalent; only
   *   looking at them settles it, which is why this is not a boolean.
   */
  plannable: Plannable;
  /** Whether the probe itself survived — a probe that failed to compile proves nothing either way. */
  probe_survived: boolean;
  stage_reached: string;
  error: string | null;
  ms: number;
}

async function main(): Promise<void> {
  const modulePath = flag("--module");
  const testsDir = flag("--tests");
  /**
   * ADR-0028 taught the verifier Jest and this probe kept passing `vitest` unconditionally, which made
   * step 2 of the real-world protocol unexecutable on any Jest project — the probe refused before it
   * could measure anything, naming a plugin the project had no reason to install.
   */
  const runnerFlag = flag("--runner") ?? "vitest";
  if (!isTestRunner(runnerFlag)) {
    throw new Error(`--runner must be vitest or jest, not ${runnerFlag}`);
  }
  const runner: TestRunner = runnerFlag;
  if (modulePath === undefined || testsDir === undefined) {
    say("usage: probe-mutants.ts --module <file> --tests <dir> [--runner vitest|jest] [--framework xctest|swift-testing] [--test-target T] [--out FILE]");
    process.exit(2);
  }

  const source = await readFile(modulePath, "utf8");
  const swift = extname(modulePath) === ".swift";
  const language = swift ? "swift" : "typescript";
  const projectDir = findProjectRoot(modulePath, language);
  // The same join `loadPlan` makes: both verifiers want the module relative to the package root.
  const sourceFile = relative(projectDir, resolve(modulePath)).split(sep).join("/");

  const files = (await readdir(testsDir)).filter((f) => f.endsWith(swift ? ".swift" : ".test.ts")).sort();
  const probes: Probe[] = [];

  for (const file of files) {
    const name = basename(file).replace(/\.(test\.ts|swift)$/, "");
    const range = deriveLineRange(source, name, language);
    if (range === null) {
      say(`  ${name}: not a function of ${basename(modulePath)} — skipped`);
      continue;
    }
    const candidate = {
      task_id: `${name}:probe:0`,
      worker: { kind: "local" as const, model: "probe", revision: "", temperature: 0 as const, seed: 0 },
      test_source: await readFile(join(testsDir, file), "utf8"),
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      timing: { ttft_ms: 0, wall_ms: 0 },
    };

    const started = performance.now();
    let verdict: Verdict;
    try {
      verdict = swift
        ? await verifySwift(candidate, {
          target: {
            projectDir,
            sourceFile,
            functionName: name,
            lineRange: range,
            framework: (flag("--framework") ?? "xctest") as SwiftFramework,
            ...(flag("--test-target") === undefined ? {} : { testTarget: flag("--test-target")! }),
            testFile: `Probe${name[0]!.toUpperCase()}${name.slice(1)}.swift`,
          },
        })
        : await verifyTs(candidate, {
          target: { projectDir, sourceFile, functionName: name, lineRange: range, runner, testFile: `test/probe.${name}${testSuffixFor(projectDir)}` },
          concurrency: 1,
        });
    } catch (e) {
      say(`  ${name}: the verifier could not run — ${String((e as Error).message).split("\n")[0]}`);
      continue;
    }

    const m = verdict.mutation;
    const total = m === null ? 0 : m.killed + m.survived + m.timeout + m.no_coverage;
    const counts = { mutants: total, killed: m?.killed ?? 0, survived: m?.survived ?? 0, timeout: m?.timeout ?? 0, no_coverage: m?.no_coverage ?? 0 };
    probes.push({
      function: name,
      ...counts,
      no_coverage: m?.no_coverage ?? 0,
      plannable: classifyProbe(counts, verdict.stage_reached),
      probe_survived: verdict.survived,
      stage_reached: verdict.stage_reached,
      error: verdict.error,
      ms: Math.round(performance.now() - started),
    });
    const last = probes.at(-1)!;
    const WHY: Record<Plannable, string> = {
      yes: `${last.mutants} mutants, ${last.killed} killed`,
      no_mutants: "NOT PLANNABLE — no mutants at all",
      crash_only: `NOT PLANNABLE — all ${last.mutants} mutant(s) crash rather than failing an assertion`,
      unknown: `UNKNOWN — ${last.survived} mutant(s) survived this probe; weak probe, or equivalent`,
      // Named as a machine problem, because that is what it is. Reported as "no mutants" it reads as a
      // fact about the function and a planner acts on it (ADR-0030).
      not_measured: `NOT MEASURED — the probe stopped at ${last.stage_reached}, so nothing was observed about this function's mutants. Fix the machine, not the plan: ${(last.error ?? "").split("\n")[0]}`,
    };
    say(`  ${name.padEnd(18)} ${WHY[last.plannable]}`);
  }

  const out = flag("--out");
  if (out !== undefined && probes.length === 0) {
    // `"measured": true` is this project's marker for "a machine produced this, not a projection", and
    // over an empty array it certifies nothing (ADR-0033). Refusing is the only honest option: a results
    // file that exists is one somebody will read.
    throw new Error(
      `nothing was probed in ${basename(modulePath)}, so there is no measurement to write to ${out}.\n` +
      "  Every function was skipped or errored — the lines above say which and why.",
    );
  }
  if (out !== undefined) {
    const mem = await readMemory();
    await mkdir(join(out, ".."), { recursive: true });
    await writeFile(out, `${JSON.stringify({
      measured: true,
      experiment: "mutant-probe",
      date: new Date().toISOString(),
      machine: { host: hostname(), total_gb: mem?.total_gb ?? null },
      module: modulePath,
      language,
      framework: swift ? (flag("--framework") ?? "xctest") : runner,
      note: "`plannable` is the question; `mutants > 0` is not the same question. A mutant that crashes the process counts towards the score and never towards survival (ADR-0005), so a function whose only mutant crashes has mutants and can still never be survived. `unknown` means mutants survived this probe and nobody has looked at whether they are equivalent — plan such a function only after someone has.",
      probes,
    }, null, 2)}\n`, "utf8");
    say(`wrote ${out}`);
  }

  const yes = probes.filter((p) => p.plannable === "yes");
  const rest = probes.filter((p) => p.plannable !== "yes");
  say(`\n${yes.length}/${probes.length} demonstrably survivable in ${basename(modulePath)}`
    + (rest.length ? ` — ${rest.map((d) => `${d.function} (${d.plannable})`).join(", ")}` : ""));
}

main().catch((e) => {
  process.stderr.write(`${String((e as Error)?.stack ?? e)}\n`);
  process.exit(1);
});
