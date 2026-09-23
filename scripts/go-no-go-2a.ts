// The workload-#2a go/no-go (Phase 11). Protocol: `experiments/go-no-go-2a/README.md`, §4 frozen
// before the run and copied there verbatim.
//
//   npx tsx scripts/go-no-go-2a.ts --config c2 --input fixture
//   npx tsx scripts/go-no-go-2a.ts --config c3 --input fixture --emit      # hand these to the agent
//   npx tsx scripts/go-no-go-2a.ts --config c3 --input fixture --verify    # grade what it wrote
//   npx tsx scripts/go-no-go-2a.ts --report
//
// One question: can a 7B make a correct small change to unfamiliar code at all, and is what survives
// the gate a change Opus would have accepted? Everything here exists to make the configurations differ
// in **one** thing — which model wrote the candidate.
//
// Held constant across configurations, deliberately:
//
//   * **The plans.** Hand-written, validated with `--dry-run`, byte-identical between arms. Read once
//     per invocation from the same path; never regenerated per configuration.
//   * **The prompt.** `src/prompts/fixer.md`, the shipped one, for every configuration including the
//     agent. Phase 6 made the same choice for the same reason: the fair comparison hands Haiku the
//     rendered prompt the 7B gets rather than a better one.
//   * **The loop.** `runFix` itself — the steps, the baseline capture, the gate, the retry rule and the
//     step boundary — with only the generator swapped, via `RunFixOpts.generate`. Phase 6's harness
//     reuses `shouldRetry` from `src/batch.ts` rather than copying it, and that is why its numbers are
//     comparable; this goes one further and reuses the whole run.
//   * **The gate, at concurrency 1.** The project's own suite is the expensive stage and a suite that
//     shares cores with itself differently between arms would put noise straight into the column being
//     read.
//
// ## Why C3's prompts can all be rendered up front
//
// `runFix` re-captures the baseline at each step boundary, so in general step N+1's prompt depends on
// step N's survivors. The agent cannot be called from inside the run, so C3 needs its answers on disk
// before the loop starts — which is only sound if no task's files overlap another's. `assertDisjoint`
// checks exactly that and refuses the plan otherwise, rather than leaving it as an assumption: with
// disjoint files, `buildChangeTask` reads the same source and the same per-file error count whether or
// not an earlier step landed, because `diagnosticsFor` filters the compiler's words to the task's own
// files and `files[].errors` is per file.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { hostname, totalmem } from "node:os";
import { join } from "node:path";
import { run } from "../src/exec.js";
import { readMemory } from "../src/doctor.js";
import { changePromptText } from "../src/prompt.js";
import { buildChangeTask, loadChangePlan, parseEdits, runFix, type LoadedChangePlan } from "../src/fix.js";
import { captureBaseline, makeChangeSandbox } from "../src/change.js";
import { ChangeCandidate, type ChangeTask, type FixResult } from "../src/schemas.js";
import { safeName } from "../src/verifier/shared.js";

const RESULTS = "experiments/go-no-go-2a/results";
const PARTIALS = join(RESULTS, "partials");
/** C3's handshake: prompts out, answers in. Kept, so the run is auditable after the fact. */
const C3_DIR = "experiments/go-no-go-2a/c3";

type ConfigId = "c2" | "c2b" | "c3";
type InputId = "fixture" | "api" | "web";

interface InputSpec {
  label: string;
  plan: string;
  /** The project's own Node, when it differs from sidecrew's. `engines` is the authority. */
  node?: string;
}

// Labels are what land in the results, and the results are published. `project-a` / `project-b` are
// the anonymous names (CLAUDE.md #7): the stack and the scale are the properties a reader needs, and
// the client's name is not one of them. The plan paths are local configuration and are redacted out
// of every partial by `redact` below.
const INPUTS: Record<InputId, InputSpec> = {
  fixture: { label: "fixtures/fix-fixture", plan: "fixtures/fix-fixture/plans/fix-type-errors.json" },
  api: { label: "project-a (Nest, jest)", plan: "experiments/go-no-go-2a/plans/project-a.json" },
  web: { label: "project-b (React, jest)", plan: "experiments/go-no-go-2a/plans/project-b.json" },
};

/**
 * Strip the client from anything that gets written to `results/`.
 *
 * A `FixResult` carries the plan path, and its baseline carries the project directory — both absolute
 * paths on one machine, both naming a client whose code this is not. They are configuration rather
 * than measurement, so nothing is lost by replacing them, and CLAUDE.md #7 is a rule about what leaves
 * the repository rather than about what is polite. Applied at the boundary, once, so no caller has to
 * remember.
 */
// Anchored to the project root, deliberately. An earlier version matched `/Users/…project-a`
// non-greedily from `/Users/`, which also swallowed sidecrew's own run directory —
// `…/.sidecrew/runs/<timestamp>-project-a/diffs/x.diff` collapsed to `<project-a>/diffs/x.diff`,
// destroying the timestamp that identifies the run. Redaction must remove the name without
// destroying the structure around it, because other things join on that structure.
const REDACTIONS: [RegExp, string][] = [
  [/\/Users\/[\w.-]+\/Coding\/[^/\s]+\/[^/\s]+\/project-a/gi, "<project-a>"],
  [/\/Users\/[\w.-]+\/Coding\/[^/\s]+\/[^/\s]+\/project-b/gi, "<project-b>"],
  [/project-a/gi, "project-a"],
  [/project-b/gi, "project-b"],
  [/the-client|eztrak|the-client/gi, "project"],
];

export const redact = <T,>(value: T): T => {
  let text = JSON.stringify(value);
  for (const [re, to] of REDACTIONS) text = text.replace(re, to);
  return JSON.parse(text) as T;
};

const say = (line: string): void => { process.stdout.write(`${line}\n`); };

const has = (flag: string): boolean => process.argv.includes(flag);
const value = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag);
  const next = at === -1 ? undefined : process.argv[at + 1];
  return next !== undefined && !next.startsWith("--") ? next : undefined;
};

const writeJson = async (path: string, v: unknown): Promise<void> =>
  writeFile(path, `${JSON.stringify(v, null, 2)}\n`, "utf8");

// ── the machine, recorded with every number ───────────────────────────────────────────────────────

interface MachineState { host: string; total_gb: number; free_gb: number | null; at: string }

const machineState = async (): Promise<MachineState> => {
  const mem = await readMemory();
  return {
    host: hostname(),
    total_gb: mem?.total_gb ?? Math.round(totalmem() / 1024 ** 3),
    free_gb: mem === null ? null : Number(mem.free_gb.toFixed(2)),
    at: new Date().toISOString(),
  };
};

const commit = async (): Promise<string> => {
  const r = await run("git", ["rev-parse", "HEAD"], { timeoutMs: 10_000 });
  return r.stdout.trim();
};

const dirty = async (): Promise<boolean> => {
  const r = await run("git", ["status", "--porcelain"], { timeoutMs: 10_000 });
  return r.stdout.trim().length > 0;
};

// ── the disjointness the C3 handshake rests on ────────────────────────────────────────────────────

/**
 * Refuse a plan whose tasks share a file.
 *
 * Not a style rule: it is the precondition that lets C3's prompts be rendered before the run (see the
 * header). It is also true of every plan this phase uses for a reason that has nothing to do with the
 * harness — a change whose meaning spans files is **one task with many files** (ADR-0044 §1–2), so two
 * tasks that share a file are a grouping mistake, which is §2's first denominator exclusion.
 */
export function assertDisjoint(loaded: LoadedChangePlan): void {
  const owner = new Map<string, string>();
  const clashes: string[] = [];
  for (const step of loaded.plan.steps) {
    for (const task of step.tasks) {
      for (const file of task.files) {
        const already = owner.get(file);
        if (already !== undefined) clashes.push(`${file} is in both ${already} and ${task.task_id}`);
        else owner.set(file, task.task_id);
      }
    }
  }
  if (clashes.length > 0) {
    throw new Error(
      `this plan's tasks share files, so C3's prompts cannot be rendered before the run:\n` +
      clashes.map((c) => `  ${c}`).join("\n"),
    );
  }
}

// ── C3: prompts out ───────────────────────────────────────────────────────────────────────────────

const c3dir = (input: InputId, sub: string): string => join(C3_DIR, input, sub);

/**
 * Render every task's prompt from the plan's first baseline and write it where the agent can read it.
 *
 * The baseline is captured for real — one `tsc` and one suite run — rather than skipped, because a
 * tsconfig that does not cover the plan's files and a suite that collects nothing are both how this
 * workload fails before a model is involved, and C3 must hit them in the same place C2 does.
 */
async function emitC3(input: InputId): Promise<void> {
  const spec = INPUTS[input];
  const loaded = await loadChangePlan(spec.plan);
  assertDisjoint(loaded);

  for (const sub of ["tasks", "prompts", "answers"]) await mkdir(c3dir(input, sub), { recursive: true });

  const sandbox = await makeChangeSandbox(loaded.projectDir);
  const all = loaded.plan.steps.flatMap((s) => s.tasks);
  const captured = await captureBaseline(sandbox, {
    projectDir: loaded.projectDir,
    runner: loaded.runner,
    files: [...new Set(all.flatMap((t) => t.files))],
  });
  say(
    `baseline: ${captured.baseline.errors.total} tsc errors, ` +
    `${captured.baseline.tests.passed}/${captured.baseline.tests.ran} tests passing ` +
    `(${Math.round(captured.baseline.timing_ms.compile)} ms tsc, ${Math.round(captured.baseline.timing_ms.tests)} ms suite)`,
  );

  for (const planned of all) {
    const task = buildChangeTask(loaded, planned, sandbox, captured);
    await writeJson(join(c3dir(input, "tasks"), `${safeName(task.task_id)}.json`), task);
    await writeFile(join(c3dir(input, "prompts"), `${safeName(task.task_id)}.md`), await changePromptText(task), "utf8");
  }
  say(`${all.length} prompt(s) → ${c3dir(input, "prompts")}`);
  say(`the agent's answer goes to ${c3dir(input, "answers")}/<task-id>.txt, verbatim, and its cost to timings.json`);
}

/** What the harness recorded for one agent invocation. Phase 6's shape, and its caveat. */
interface AgentTiming {
  task_id: string;
  generate_ms: number;
  /**
   * The Agent tool's own `subagent_tokens`: one number, no prompt/completion split and no cache
   * breakdown, so it cannot be put in `ChangeCandidate.usage` without inventing the halves. It is
   * summed into `claude_tokens.workers`, where a total is the only honest shape, and the per-candidate
   * token columns stay 0 for C3 rather than carrying a guess.
   */
  agent_tokens?: number;
}

// ── C3: answers in, through the production loop ───────────────────────────────────────────────────

/**
 * A generator that reads what the agent wrote, and is otherwise the local one.
 *
 * The same `parseEdits` the local tier uses, so `edit_parse_failed` means the same thing in both arms —
 * §4.4 turns that counter into a verdict about the edit format rather than about the model, and a
 * second parser here would make the two columns incomparable.
 */
function answerReader(input: InputId, timings: AgentTiming[]): (task: ChangeTask) => Promise<ChangeCandidate> {
  return async (task: ChangeTask): Promise<ChangeCandidate> => {
    const file = join(c3dir(input, "answers"), `${safeName(task.task_id)}.txt`);
    if (!existsSync(file)) {
      throw new Error(`no answer on disk for ${task.task_id} — run --emit, hand the prompt to the agent, and save it to ${file}`);
    }
    const text = await readFile(file, "utf8");
    const t = timings.find((x) => x.task_id === task.task_id);
    const { edits, unparsed } = parseEdits(text, task);
    return ChangeCandidate.parse({
      task_id: task.task_id,
      // `api`: the tokens were spent at Anthropic, which is what ADR-0009's tier means. No seed there.
      worker: { kind: "api", model: "claude-haiku-4-5", revision: "", temperature: 0, seed: null },
      edits,
      unparsed,
      // The agent harness has no `finish_reason`, so truncation is inferred from the one signal that is
      // a fact rather than a guess: an answer that stops mid-file has no trailing newline on its last
      // edit and no closing marker. Recorded as false when it cannot be told, and the report says so.
      truncated: false,
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      timing: { ttft_ms: 0, wall_ms: t?.generate_ms ?? 0 },
    });
  };
}

async function verifyC3(input: InputId): Promise<void> {
  const spec = INPUTS[input];
  const timingPath = join(C3_DIR, input, "timings.json");
  const timings: AgentTiming[] = existsSync(timingPath)
    ? (JSON.parse(readFileSync(timingPath, "utf8")) as AgentTiming[])
    : [];

  const answers = await readdir(c3dir(input, "answers")).catch(() => []);
  say(`${answers.length} answer(s) on disk, ${timings.length} timing(s)`);

  const result = await runFix(spec.plan, {
    generate: answerReader(input, timings),
    workerKind: "api",
    workerModel: "claude-haiku-4-5",
    workerTokens: timings.reduce((n, t) => n + (t.agent_tokens ?? 0), 0),
    onEvent: (l) => say(`  ${l}`),
  });
  await writePartial("c3", input, result, { agent_invocations: timings.length });
}

// ── C2 / C2b: the local tier ──────────────────────────────────────────────────────────────────────

async function runLocal(config: ConfigId, input: InputId): Promise<void> {
  const spec = INPUTS[input];
  const result = await runFix(spec.plan, { concurrency: 1, onEvent: (l) => say(`  ${l}`) });
  await writePartial(config, input, result, {});
}

// ── partials ──────────────────────────────────────────────────────────────────────────────────────

async function writePartial(
  config: ConfigId, input: InputId, result: FixResult, extra: Record<string, unknown>,
): Promise<void> {
  await mkdir(PARTIALS, { recursive: true });
  const path = join(PARTIALS, `${config}-${input}.json`);
  await writeJson(path, redact({
    measured: true,
    config,
    input,
    label: INPUTS[input].label,
    plan: INPUTS[input].plan,
    commit: await commit(),
    repo_dirty: await dirty(),
    machine: await machineState(),
    result,
    ...extra,
  }));
  say(`→ ${path}`);
  say(
    `${result.stats.survived}/${result.stats.tasks} survived · ` +
    `${result.project.errors_before} → ${result.project.errors_after} tsc errors · ` +
    `gate median ${result.stats.gate_ms.median} ms`,
  );
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  const config = (value("--config") ?? "c2") as ConfigId;
  const input = (value("--input") ?? "fixture") as InputId;
  if (!(input in INPUTS)) throw new Error(`unknown --input ${input}; one of ${Object.keys(INPUTS).join(", ")}`);

  if (config === "c3") {
    if (has("--emit")) return emitC3(input);
    return verifyC3(input);
  }
  return runLocal(config, input);
};

main().catch((e: unknown) => {
  process.stderr.write(`${String((e as Error)?.stack ?? e)}\n`);
  process.exitCode = 1;
});
