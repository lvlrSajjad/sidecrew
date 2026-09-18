// The escalation queue, and what `sidecrew escalate` makes of it. ADR-0023.
//
// The queue exists for the run that does not finish, so most of these are about reading a directory that
// is missing something: a truncated last line, a `result.json` that was never written, a task file that
// has gone. Every one of those is a real state of `.sidecrew/runs/<id>/` after a Ctrl-C.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import {
  appendEscalation,
  DEFAULT_ESCALATION_MODEL,
  escalationBatch,
  ESCALATIONS_FILE,
  readEscalations,
  renderEscalationBatch,
  resolveRunDir,
  runLanguage,
} from "../src/escalate.js";
import { buildTasks, loadPlan } from "../src/plan.js";
import type { Escalation } from "../src/schemas.js";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

const escalation = (task_id: string, over: Partial<Escalation> = {}): Escalation => ({
  task_id,
  reason: "did not compile",
  attempts: [{ task_id, stage_reached: "compile", error: "tsc: expected ';'" }],
  escalated_at: "2026-09-14T10:35:11.000Z",
  ...over,
});

/** A run directory with real tasks in it, built from the fixture plan so the join has something to join. */
const aRun = async (id = "2026-09-14T10-31-02Z-strings"): Promise<{ dir: string; runDir: string; id: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "sidecrew-esc-"));
  dirs.push(dir);
  const runDir = join(dir, "runs", id);
  await mkdir(join(runDir, "tasks"), { recursive: true });
  const tasks = buildTasks(await loadPlan("fixtures/ts-fixture/plans/strings/test_plan.json"));
  for (const task of tasks) {
    await writeFile(join(runDir, "tasks", `${task.task_id.replace(/:/g, ".")}.json`), JSON.stringify(task), "utf8");
  }
  return { dir, runDir, id };
};

describe("the queue file", () => {
  it("is one JSON object per line, appended", async () => {
    // Appending to a JSON *array* means rewriting it, which means a killed run leaves a corrupt file.
    const { runDir } = await aRun();
    await appendEscalation(runDir, escalation("truncate:boundary:0"));
    await appendEscalation(runDir, escalation("mean:happy_path:0"));

    const raw = readFileSync(join(runDir, ESCALATIONS_FILE), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);
    expect(JSON.parse(raw.trim().split("\n")[0]!)).toMatchObject({ task_id: "truncate:boundary:0" });
    expect((await readEscalations(runDir)).map((e) => e.task_id)).toEqual(["truncate:boundary:0", "mean:happy_path:0"]);
  });

  it("keeps the lines it can read when the last one was cut off mid-write", async () => {
    // The one way this file gets damaged is a run killed during an append, which damages the last line.
    // Refusing to read the other nineteen because of it throws away what appending-as-you-go bought.
    const { runDir } = await aRun();
    await appendEscalation(runDir, escalation("truncate:boundary:0"));
    await writeFile(join(runDir, ESCALATIONS_FILE), `${readFileSync(join(runDir, ESCALATIONS_FILE), "utf8")}{"task_id":"mean`, "utf8");
    expect((await readEscalations(runDir)).map((e) => e.task_id)).toEqual(["truncate:boundary:0"]);
  });

  it("is empty rather than an error for a run that escalated nothing", async () => {
    const { runDir } = await aRun();
    expect(await readEscalations(runDir)).toEqual([]);
  });
});

describe("resolveRunDir", () => {
  it("takes the most recent run when none is named, because the ids sort by time", async () => {
    const { dir } = await aRun("2026-09-14T09-00-00Z-a");
    await mkdir(join(dir, "runs", "2026-09-14T11-00-00Z-b"), { recursive: true });
    expect((await resolveRunDir(undefined, dir)).id).toBe("2026-09-14T11-00-00Z-b");
    expect((await resolveRunDir("2026-09-14T09-00-00Z-a", dir)).id).toBe("2026-09-14T09-00-00Z-a");
  });

  it("says there is nothing to act on rather than returning a path that is not there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sidecrew-esc-"));
    dirs.push(dir);
    await expect(resolveRunDir(undefined, dir)).rejects.toThrow(/no runs under/);
  });
});

describe("runLanguage", () => {
  it("comes off the run's own tasks, not off a plan that may have moved since", async () => {
    const { runDir } = await aRun();
    expect(await runLanguage(runDir)).toBe("typescript");
  });

  it("is null when there is nothing readable to take it from", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sidecrew-esc-"));
    dirs.push(dir);
    expect(await runLanguage(dir)).toBeNull();
  });
});

describe("escalationBatch", () => {
  it("joins each escalation back to the prompt the worker had", async () => {
    const { dir, id, runDir } = await aRun();
    await appendEscalation(runDir, escalation("truncate:boundary:0"));

    const batch = await escalationBatch(id, { dir });
    expect(batch.run_id).toBe(id);
    expect(batch.language).toBe("typescript");
    expect(batch.test_framework).toBe("vitest");
    expect(batch.items).toHaveLength(1);

    const item = batch.items[0]!;
    // The question, not a summary of it: same function source, same exemplar, same rules.
    expect(item.task.function.name).toBe("truncate");
    expect(item.task.exemplar_source.length).toBeGreaterThan(0);
    expect(item.task.shape.kind).toBe("boundary");
    expect(item.attempts[0]?.error).toMatch(/expected ';'/);
  });

  it("hands over the first attempt's task, never the retry's", async () => {
    // The retry's prompt already carries a compiler error. Giving Claude that is giving it the worker's
    // second guess rather than the question; the errors belong in `attempts`, labelled as history.
    const { dir, id, runDir } = await aRun();
    await appendEscalation(runDir, escalation("truncate:boundary:0", {
      attempts: [
        { task_id: "truncate:boundary:0", stage_reached: "compile", error: "first" },
        { task_id: "truncate:boundary:1", stage_reached: "pass", error: "second" },
      ],
    }));
    const batch = await escalationBatch(id, { dir });
    expect(batch.items[0]?.task.retry_of).toBeNull();
    expect(batch.items[0]?.task.previous_error).toBeNull();
    expect(batch.items[0]?.attempts.map((a) => a.error)).toEqual(["first", "second"]);
  });

  it("suggests sonnet, and lets the caller say otherwise", async () => {
    const { dir, id, runDir } = await aRun();
    await appendEscalation(runDir, escalation("truncate:boundary:0"));
    expect((await escalationBatch(id, { dir })).suggested_model).toBe(DEFAULT_ESCALATION_MODEL);
    expect((await escalationBatch(id, { dir, model: "opus" })).suggested_model).toBe("opus");
  });

  it("works on a run that never wrote a result.json — the case the queue exists for", async () => {
    // A run killed at minute forty has spent those attempts. `BatchResult.escalations` says the same
    // thing for a run that finished; this says it for one that did not.
    const { dir, id, runDir } = await aRun();
    await appendEscalation(runDir, escalation("truncate:boundary:0"));
    const batch = await escalationBatch(id, { dir });
    expect(batch.items).toHaveLength(1);
    expect(batch.plan).toBe(runDir);
  });

  it("drops an escalation whose task file has gone, rather than inventing one", async () => {
    const { dir, id, runDir } = await aRun();
    await appendEscalation(runDir, escalation("neverPlanned:happy_path:0"));
    expect((await escalationBatch(id, { dir })).items).toEqual([]);
  });
});

describe("renderEscalationBatch", () => {
  it("says so plainly when there is nothing to escalate", async () => {
    const { dir, id } = await aRun();
    expect(renderEscalationBatch(await escalationBatch(id, { dir }))).toMatch(/nothing escalated/);
  });

  it("names each task, how many attempts it had and why it stopped", async () => {
    const { dir, id, runDir } = await aRun();
    await appendEscalation(runDir, escalation("truncate:boundary:0", { reason: "killed no mutant" }));
    const rendered = renderEscalationBatch(await escalationBatch(id, { dir }));
    expect(rendered).toMatch(/truncate:boundary:0/);
    expect(rendered).toMatch(/1 attempt · killed no mutant/);
    expect(rendered).toMatch(/suggested model sonnet/);
  });
});
