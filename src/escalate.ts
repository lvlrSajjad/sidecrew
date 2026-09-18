// The escalation queue: `.sidecrew/runs/<id>/escalations.jsonl`, and what `sidecrew escalate` makes of it.
//
// A task that has used both attempts is Claude's problem. Two things about *when* it is written are the
// whole point of the file existing at all (ADR-0023):
//
//   * **Appended when the task gives up**, not derived from `result.json` at the end. A run that dies —
//     a worker that goes away, a machine that reboots, a Ctrl-C after forty minutes — has still spent
//     those attempts, and the queue is the only record of what they bought. `BatchResult.escalations`
//     says the same thing for a run that finished; this says it for one that did not.
//   * **One JSON object per line.** Appending to a JSON array means rewriting it, which means a partial
//     write is a corrupt file. A line is atomic enough for this, and a truncated last line is one lost
//     escalation rather than a lost queue.
//
// `sidecrew escalate` then joins the queue back to the tasks on disk, so what reaches Claude is the
// question the worker was asked — same function source, same exemplar, same rules — plus what went wrong.
import { appendFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ChangeEscalation, ChangeEscalationBatch, ChangeTask, EscalationBatch, Escalation, WorkerTask,
  type Language, type TestFramework,
} from "./schemas.js";
import { sidecrewDir } from "./serve.js";
import { safeName } from "./verifier/shared.js";

export const ESCALATIONS_FILE = "escalations.jsonl";

/**
 * Sonnet, and the reason is the shape of the work rather than a preference.
 *
 * Escalations are the tail the local tier could not do: on Phase 6's TypeScript fixture three tasks of
 * twenty, on Swift most of them. They are the tokens the whole design exists to *concentrate*, so they
 * go to a model that can write the test rather than to the cheapest one that might. Opus plans; Sonnet
 * writes these; the local worker did the other seventeen.
 */
export const DEFAULT_ESCALATION_MODEL = "sonnet";

/** Append one line. The run is mid-flight when this is called, so it never reads what is already there. */
export async function appendEscalation(runDir: string, escalation: Escalation): Promise<void> {
  await appendFile(join(runDir, ESCALATIONS_FILE), `${JSON.stringify(Escalation.parse(escalation))}\n`, "utf8");
}

/**
 * Every line that parses, in the order they were written.
 *
 * A line that does not parse is skipped rather than fatal: the one way this file gets damaged is a run
 * killed mid-append, which damages the last line only, and refusing to read the other nineteen because
 * of it would throw away the thing the append-as-you-go design was for.
 */
export async function readEscalations(runDir: string): Promise<Escalation[]> {
  const raw = await readFile(join(runDir, ESCALATIONS_FILE), "utf8").catch(() => "");
  return raw.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    try {
      return [Escalation.parse(JSON.parse(line))];
    } catch {
      return [];
    }
  });
}

/** Run directories, newest last — the ids sort lexically because they start with an ISO timestamp. */
export async function runDirs(dir = sidecrewDir()): Promise<string[]> {
  const names = await readdir(join(dir, "runs")).catch(() => [] as string[]);
  return names.filter((n) => !n.startsWith(".")).sort();
}

/**
 * The run to act on: the one named, or the most recent.
 *
 * "The most recent" is a convenience with a sharp edge — it is whichever run *started* last, which on a
 * machine running two plans at once is not necessarily the one the user means. So it is a default and the
 * result always names the run it chose.
 */
export async function resolveRunDir(runId: string | undefined, dir = sidecrewDir()): Promise<{ id: string; path: string }> {
  if (runId !== undefined) return { id: runId, path: join(dir, "runs", runId) };
  const ids = await runDirs(dir);
  const latest = ids.at(-1);
  if (latest === undefined) throw new Error(`no runs under ${join(dir, "runs")} — nothing to escalate`);
  return { id: latest, path: join(dir, "runs", latest) };
}

/**
 * The language a run actually ran in, read off its own tasks.
 *
 * Not off the plan: `escalate` and `review` act on a finished run, and by then the plan may have been
 * edited, moved or re-planned. The tasks are what the worker was given, and they carry `language`
 * because the worker needed it too.
 */
export async function runLanguage(runDirPath: string): Promise<Language | null> {
  const names = (await readdir(join(runDirPath, "tasks")).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).sort();
  for (const name of names) {
    const task = await readJson(join(runDirPath, "tasks", name), (v) => WorkerTask.parse(v));
    if (task !== null) return task.language;
  }
  return null;
}

const readJson = async <T>(path: string, parse: (v: unknown) => T): Promise<T | null> => {
  try {
    return parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null;
  }
};

export interface EscalateOpts {
  dir?: string;
  /** Overrides `DEFAULT_ESCALATION_MODEL` in the batch's `suggested_model`. */
  model?: string;
}

/**
 * The queue, joined to the prompts the worker had → one `EscalationBatch`.
 *
 * The first attempt's task, never the retry's: the retry carries `previous_error`, and handing Claude a
 * prompt that already contains a compiler error would be handing it the worker's second guess rather than
 * the question. The errors are in `attempts`, where they are labelled as history.
 */
export async function escalationBatch(runId: string | undefined, opts: EscalateOpts = {}): Promise<EscalationBatch> {
  const dir = opts.dir ?? sidecrewDir();
  const { id, path } = await resolveRunDir(runId, dir);

  const escalations = await readEscalations(path);
  const result = await readJson(join(path, "result.json"), (v) => v as { plan?: unknown });

  const items = await Promise.all(escalations.map(async (e) => {
    const task = await readJson(join(path, "tasks", `${safeName(e.task_id)}.json`), (v) => WorkerTask.parse(v));
    return task === null ? [] : [{ ...e, task }];
  }));
  const joined = items.flat();

  // Both come off the tasks rather than off the plan: `escalate` must work on a run whose plan has since
  // been edited or moved, and the tasks are what the worker was actually given. An empty batch still
  // reads the run's own tasks rather than guessing, and only guesses when there are none to read.
  const first = joined[0]?.task;
  const language = (first?.language ?? await runLanguage(path) ?? "typescript") as Language;
  const test_framework = (first?.test_framework ?? "vitest") as TestFramework;

  return EscalationBatch.parse({
    run_id: id,
    plan: typeof result?.plan === "string" ? result.plan : path,
    language,
    test_framework,
    suggested_model: opts.model ?? DEFAULT_ESCALATION_MODEL,
    items: joined,
  });
}

export const renderEscalationBatch = (b: EscalationBatch): string => {
  if (b.items.length === 0) return `${b.run_id}: nothing escalated — every task survived, or the run never wrote a queue`;
  const head = `${b.run_id}: ${b.items.length} escalation${b.items.length === 1 ? "" : "s"} · ${b.language}/${b.test_framework} · suggested model ${b.suggested_model}`;
  const rows = b.items.map((i) =>
    `  ${i.task_id.padEnd(36)} ${i.attempts.length} attempt${i.attempts.length === 1 ? "" : "s"} · ${i.reason}`);
  return [head, ...rows].join("\n");
};

// ── workload #2a ─────────────────────────────────────────────────────────────────────────────────
//
// The same file and the same `escalations.jsonl`, with a different shape on the line. `ChangeEscalation`
// is not a widened `Escalation` for the reason `docs/specs/pipeline.md` gives: workload #1's
// `stage_reached` is `Stage` and says nothing about confinement or a regressed test, which are the first
// two things a 2a reader needs.
//
// One line per task that gave up, appended when it gives up (ADR-0023). A `fix` run is 262 s of gate per
// attempt and hours long, so "the run finished and wrote result.json" is exactly the assumption that
// fails.

/** Append one 2a escalation. Mid-flight, so it never reads what is already there. */
export async function appendChangeEscalation(runDir: string, escalation: ChangeEscalation): Promise<void> {
  await appendFile(join(runDir, ESCALATIONS_FILE), `${JSON.stringify(ChangeEscalation.parse(escalation))}\n`, "utf8");
}

/** Every 2a line that parses, in order. A damaged last line costs one escalation, never the queue. */
export async function readChangeEscalations(runDir: string): Promise<ChangeEscalation[]> {
  const raw = await readFile(join(runDir, ESCALATIONS_FILE), "utf8").catch(() => "");
  return raw.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    try {
      return [ChangeEscalation.parse(JSON.parse(line))];
    } catch {
      return [];
    }
  });
}

/**
 * The 2a queue, joined back to the `ChangeTask`s on disk.
 *
 * The **first** attempt's task, as workload #1 does and for the same reason: a retry's task carries
 * `previous_error`, and a correction's carries `correction`, so handing either to Claude would hand it
 * the worker's second guess dressed as the question. The history lives in `attempts`, labelled.
 */
export async function changeEscalationBatch(
  runId: string | undefined, opts: EscalateOpts = {},
): Promise<ChangeEscalationBatch> {
  const dir = opts.dir ?? sidecrewDir();
  const { id, path } = await resolveRunDir(runId, dir);

  const escalations = await readChangeEscalations(path);
  const result = await readJson(join(path, "result.json"), (v) => v as { plan?: unknown });

  const items = await Promise.all(escalations.map(async (e) => {
    const task = await readJson(join(path, "tasks", `${safeName(e.task_id)}.json`), (v) => ChangeTask.parse(v));
    return task === null ? [] : [{ ...e, task }];
  }));
  const joined = items.flat();
  const first = joined[0]?.task;

  return ChangeEscalationBatch.parse({
    run_id: id,
    plan: typeof result?.plan === "string" ? result.plan : path,
    language: (first?.language ?? "typescript") as Language,
    test_framework: (first?.test_framework ?? "vitest") as TestFramework,
    suggested_model: opts.model ?? DEFAULT_ESCALATION_MODEL,
    items: joined,
  });
}

export const renderChangeEscalationBatch = (b: ChangeEscalationBatch): string => {
  if (b.items.length === 0) {
    return `${b.run_id}: nothing escalated — every task survived, or the run never wrote a queue`;
  }
  // Machine failures and refusals are called out rather than counted in, because both are the thing
  // Phase 11 had no way to say: project-b's twelfth task was an ENOTEMPTY teardown sitting in
  // `escalated`, indistinguishable from a worker that could not do the job (ADR-0056).
  const machine = b.items.filter((i) => i.machine_failure).length;
  const refused = b.items.filter((i) => i.refused !== null).length;
  const real = b.items.length - machine;
  const head = [
    `${b.run_id}: ${b.items.length} escalation${b.items.length === 1 ? "" : "s"} · ${b.language}/${b.test_framework} · suggested model ${b.suggested_model}`,
    `  ${real} the worker could not do${machine > 0 ? `, ${machine} the machine failed (not the worker's — exclude from any rate)` : ""}${refused > 0 ? `, of which ${refused} the worker refused with a reason` : ""}`,
  ];
  const rows = b.items.map((i) => {
    const last = i.attempts.at(-1);
    const rules = last !== undefined && last.confinement.length > 0 ? ` · ${last.confinement.join(", ")}` : "";
    const regressed = last !== undefined && last.regressed.length > 0 ? ` · ${last.regressed.length} test(s) regressed` : "";
    return `  ${i.task_id.padEnd(28)} ${i.shape.padEnd(14)} ${i.attempts.length} attempt${i.attempts.length === 1 ? "" : "s"} · ${i.reason}${rules}${regressed}`;
  });
  return [...head, ...rows].join("\n");
};
