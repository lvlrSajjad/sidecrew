// `sidecrew fix --report` — what to read first, after a run you were not watching.
//
// The other half of unattended mode (`BACKLOG.md` § *The edge ideas*, item 4). `VISION.md`'s shape is
// *Opus files a stepped plan, walks away, and reads a step report*, and the measure attached to it is
// **Opus tokens spent between filing the plan and reading the report — the target is zero.** A report
// that made Opus read a run directory to find out what happened would spend exactly the tokens the
// shape exists to save.
//
// So this is an **ordering**, not a summary. `FixResult` already says what happened; what it does not
// say is which of the things that happened deserve attention first, and the ordering is the judgement:
//
//   1. **combined regressions** — the only signal in a run that no per-task verdict can produce, and it
//      is a hole in the gate rather than a bad change (`FixResult.project.combined_regressions`).
//   2. **machine failures** — not the worker's, and they need re-running rather than reading (ADR-0012,
//      ADR-0056). Reading them as worker failures is the mistake Phase 11 had to warn about by hand.
//   3. **refusals** — the worker said the change cannot be made in these files. Usually a plan problem.
//   4. **escalations** — what the local tier could not do. Real work for a paid model or a human.
//   5. **survivors carrying observations** — passed the gate, and did something the ask did not call
//      for (ADR-0054, ADR-0057). The gate cannot see these and a reviewer is the last line.
//   6. **plain survivors** — read or sample last. Survival is a filter, not an endorsement.
//
// Nothing here recomputes anything. It reads `result.json` and the verdicts beside it, so it costs no
// worker tokens and no gate time, exactly as `sidecrew escalate` and `sidecrew review` do.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { readChangeEscalations, resolveRunDir } from "./escalate.js";
import { ChangeVerdict, FixResult, type ChangeObservation } from "./schemas.js";

export interface ReportItem {
  /** Lower sorts first. The ordering is the point of the file. */
  rank: number;
  kind: "combined_regression" | "machine_failure" | "refusal" | "escalation" | "observed_survivor" | "survivor";
  task_id: string;
  /** One line. What it is and why it is at this rank. */
  why: string;
  /** Where to look — a diff, a verdict, or the run directory itself. */
  where: string;
}

export interface RunReport {
  run_id: string;
  run_dir: string;
  project: FixResult["project"];
  stats: {
    tasks: number;
    survived: number;
    escalated: number;
    refusals: number;
    machine_failures: number;
    observed_survivors: number;
    corrections_written: number;
  };
  /** True when the run stopped on a blocking task rather than finishing its plan (ADR-0044 §2). */
  stopped: string | null;
  /** Ordered. The first entry is what to read first. */
  read_first: ReportItem[];
  /** One line, for a caller that will read nothing else. */
  headline: string;
}

const readJson = async <T>(path: string, parse: (v: unknown) => T): Promise<T | null> => {
  try {
    return parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null;
  }
};

/** Every verdict on disk, by task id — including attempts, which is how observations are found. */
const verdictsOf = async (runDir: string): Promise<ChangeVerdict[]> => {
  const names = (await readdir(join(runDir, "verdicts")).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
  const all = await Promise.all(names.sort().map((n) => readJson(join(runDir, "verdicts", n), (v) => ChangeVerdict.parse(v))));
  return all.filter((v): v is ChangeVerdict => v !== null);
};

const observationLine = (o: ChangeObservation[]): string =>
  o.map((x) => `${x.kind} in ${x.file}`).join(", ");

export interface ReportOpts { dir?: string }

export async function runReport(runId: string | undefined, opts: ReportOpts = {}): Promise<RunReport> {
  const { id, path } = await resolveRunDir(runId, opts.dir);
  const result = await readJson(join(path, "result.json"), (v) => FixResult.parse(v));
  if (result === null) {
    throw new Error(
      `${join(path, "result.json")} is missing or unreadable — a run that died before writing it still has ` +
      "its per-task verdicts on disk (ADR-0023); `sidecrew fix --resume " + id + "` will finish it",
    );
  }

  const stopped = await readFile(join(path, "stopped.txt"), "utf8").then((t) => t.trim()).catch(() => null);
  const verdicts = await verdictsOf(path);
  const escalations = await readChangeEscalations(path);
  const survivorIds = new Set(result.survivors.map((s) => s.task_id));

  const items: ReportItem[] = [];

  if (result.project.combined_regressions > 0) {
    items.push({
      rank: 0,
      kind: "combined_regression",
      task_id: "(the run)",
      why:
        `${result.project.combined_regressions} test(s) pass with each survivor alone and fail with all of ` +
        "them applied. No per-task verdict can see this, and it is a hole in the gate rather than a bad change",
      where: join(path, "combined-regressions.txt"),
    });
  }

  for (const e of escalations) {
    if (e.machine_failure) {
      items.push({
        rank: 1,
        kind: "machine_failure",
        task_id: e.task_id,
        why: "the machine failed, not the worker — re-run it, and exclude it from any rate you quote (ADR-0012, ADR-0056)",
        where: join(path, "verdicts", `${e.task_id}.json`),
      });
    } else if (e.refused !== null) {
      items.push({
        rank: 2,
        kind: "refusal",
        task_id: e.task_id,
        why: `the worker refused: ${e.refused.split("\n")[0]} — usually a plan to fix rather than a change to write`,
        where: join(path, "tasks", `${e.task_id}.json`),
      });
    } else {
      items.push({
        rank: 3,
        kind: "escalation",
        task_id: e.task_id,
        why: `${e.shape}: ${e.reason}`,
        where: join(path, "verdicts", `${e.task_id}.json`),
      });
    }
  }

  // Survivors that did something the ask did not call for. The gate admitted them by design
  // (ADR-0057), so a reader is the only thing between this and the user's source.
  const observed = new Map<string, ChangeObservation[]>();
  for (const v of verdicts) {
    if (v.survived && v.observations.length > 0) observed.set(v.task_id, v.observations);
  }

  for (const s of result.survivors) {
    const obs = observed.get(s.task_id) ?? [];
    items.push(obs.length > 0
      ? {
        rank: 4,
        kind: "observed_survivor",
        task_id: s.task_id,
        why: `passed the gate and ${observationLine(obs)} — the gate cannot see this (ADR-0054)`,
        where: s.diff_path,
      }
      : {
        rank: 5,
        kind: "survivor",
        task_id: s.task_id,
        why: `fixed ${s.errors_fixed} error(s) in ${s.files.join(", ")}`,
        where: s.diff_path,
      });
  }

  items.sort((a, b) => a.rank - b.rank || a.task_id.localeCompare(b.task_id));

  const st = result.stats;
  const headline = stopped !== null
    ? `STOPPED — ${stopped}`
    : `${st.survived}/${st.tasks} survived · ${result.project.errors_before} → ${result.project.errors_after} tsc errors` +
      (result.project.combined_regressions > 0 ? ` · ${result.project.combined_regressions} COMBINED REGRESSION(S)` : "") +
      (st.machine_failures > 0 ? ` · ${st.machine_failures} machine failure(s), not the worker's` : "") +
      (observed.size > 0 ? ` · ${observed.size} survivor(s) did something unasked` : "");

  return {
    run_id: id,
    run_dir: path,
    project: result.project,
    stats: {
      tasks: st.tasks,
      survived: st.survived,
      escalated: st.escalated,
      refusals: st.refusals,
      machine_failures: st.machine_failures,
      observed_survivors: observed.size,
      corrections_written: st.corrections.written,
    },
    stopped,
    read_first: items,
    headline,
  };
}

export const renderRunReport = (r: RunReport): string => {
  const lines = [`${r.run_id}: ${r.headline}`];
  if (r.read_first.length === 0) {
    lines.push("  nothing to read — no survivors, no escalations, nothing observed");
    return lines.join("\n");
  }
  lines.push("  read in this order:");
  for (const i of r.read_first) {
    lines.push(`  [${i.kind}] ${i.task_id}`);
    lines.push(`      ${i.why}`);
    lines.push(`      ${i.where}`);
  }
  return lines.join("\n");
};
