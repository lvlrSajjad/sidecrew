// Phase 12 §2.2 — the correction round, run in two passes because the corrector is the session.
//
//   npx tsx scripts/correction-round.ts briefs <plan> <pass1-run-dir> <out.json>
//   npx tsx scripts/correction-round.ts apply  <plan> <pass1-run-dir> <notes.json> <out-dir>
//
// `src/correction.ts` deliberately does not call a model: *"the note is written by Opus — the session
// driving the run — and handed back through `RunFixOpts.correct`"*, so that a local-tier `fix` cannot
// spend Claude tokens from inside the library. That is the right design and it means §2.2 cannot be a
// single unattended process. Hence two passes with files between them, which is this repository's
// normal IPC anyway (CLAUDE.md).
//
// **Rule 1 is preserved by the same mechanism `runFix` uses, not by a promise.** `briefs` emits what
// `brief()` returns and nothing else — `brief()` takes a `ChangeVerdict`, a `ChangeCandidate` is not in
// its signature, and the diff is never read. The session writing notes sees the brief and only the
// brief, which is `experiments/correction-round/README.md` §4.0 precondition 2 and the line between
// this design and "Opus reviews everything".
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { performance } from "node:perf_hooks";
import { brief, renderBrief } from "../src/correction.js";
import { buildChangeTask, generateChange, loadChangePlan } from "../src/fix.js";
import { captureBaseline, makeChangeSandbox, verifyChange } from "../src/change.js";
import { readMachineState } from "../src/doctor.js";
import { ChangeVerdict, crossesCalendarDay, swapGrowthGb, type ChangeTask } from "../src/schemas.js";
import { safeName } from "../src/verifier/shared.js";
import { discoverWorkers, portsFromEnv } from "../src/batch.js";

const [mode, planPath, runDir, third, fourth] = process.argv.slice(2);
const say = (s: string): void => { process.stdout.write(`${s}\n`); };
if (mode === undefined || planPath === undefined || runDir === undefined || third === undefined) {
  process.stderr.write("usage: correction-round.ts briefs|apply <plan> <pass1-run-dir> <notes.json> [out-dir]\n");
  process.exit(1);
}

const loaded = await loadChangePlan(planPath);
const planned = loaded.plan.steps.flatMap((s) => s.tasks);
const byId = new Map(planned.map((t) => [t.task_id, t]));

/**
 * Tasks that reached attempt 2's threshold: failed attempt 0 **and** failed the mechanical retry.
 *
 * This is §4.1's `n₂` and the exclusions are its. A verdict that never reported a suite is a machine
 * failure (ADR-0012, ADR-0056) and does not spend an attempt, so it is not a correction's to rescue
 * and is named rather than silently dropped.
 */
const twiceFailed = async (): Promise<{ id: string; verdict: ChangeVerdict; excluded: string | null }[]> => {
  const out: { id: string; verdict: ChangeVerdict; excluded: string | null }[] = [];
  for (const p of planned) {
    // `safeName`, not the raw id. `runFix` writes `snc-02#1` as `snc-02.1.json`, and looking for the
    // raw spelling finds nothing — which this harness first reported as "no mechanical retry was
    // spent", a *plausible* exclusion, and so n₂ = 0 and a false INCONCLUSIVE. A miss whose failure
    // path reads more sensibly than its success path is the dangerous kind; use the writer's function.
    const a0 = join(runDir, "verdicts", `${safeName(p.task_id)}.json`);
    const a1 = join(runDir, "verdicts", `${safeName(`${p.task_id}#1`)}.json`);
    if (!existsSync(a0)) continue;
    const v0 = ChangeVerdict.parse(JSON.parse(await readFile(a0, "utf8")));
    if (v0.survived) continue;
    if (!existsSync(a1)) {
      // Failed once and never retried: the retry rule declined it, which it does only for a runner
      // that produced no report. That is the machine, not the worker.
      out.push({ id: p.task_id, verdict: v0, excluded: "no mechanical retry was spent — machine failure (ADR-0012)" });
      continue;
    }
    const v1 = ChangeVerdict.parse(JSON.parse(await readFile(a1, "utf8")));
    if (v1.survived) continue;
    out.push({ id: p.task_id, verdict: v1, excluded: v1.tests !== null && !v1.tests.reported ? "the runner produced no report (ADR-0056)" : null });
  }
  return out;
};

if (mode === "briefs") {
  const rows = await twiceFailed();
  const eligible = rows.filter((r) => r.excluded === null);
  const payload = {
    plan: basename(planPath),
    pass1_run: basename(runDir).replace(/^(\d{4}-\d{2}-\d{2}T[\d-]+Z)-.*$/, "$1-project-a"),
    n2: eligible.length,
    excluded: rows.filter((r) => r.excluded !== null).map((r) => ({ task_id: r.id, reason: r.excluded })),
    // What the session may read, and the whole of it.
    briefs: eligible.map((r) => {
      const b = brief(r.verdict, byId.get(r.id)!.shape);
      return { task_id: r.id, shape: b.shape, stage: b.stage, findings: b.findings, on_observation: b.on_observation, rendered: renderBrief(b), note: null };
    }),
  };
  await writeFile(third, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  say(`n₂ = ${eligible.length} (${rows.length - eligible.length} excluded) → ${third}`);
  say(eligible.length >= 8 ? "  at or above §4.3's floor of 8" : `  BELOW §4.3's floor of 8 — this project is INCONCLUSIVE and that is a complete result`);
} else if (mode === "apply") {
  const outDir = fourth ?? join(runDir, "..", `${basename(runDir)}-pass2`);
  await mkdir(join(outDir, "verdicts"), { recursive: true });
  await mkdir(join(outDir, "corrections"), { recursive: true });
  const notes = JSON.parse(await readFile(third, "utf8")) as {
    briefs: { task_id: string; note: string | null; tokens?: number; rendered: string }[];
  };
  const withNotes = notes.briefs.filter((b) => b.note !== null && b.note.trim().length > 0);
  if (withNotes.length === 0) throw new Error(`no notes written in ${third} — nothing to apply`);

  const machineBefore = await readMachineState();
  const sandbox = await makeChangeSandbox(loaded.projectDir);
  say(`sandbox ${sandbox}`);
  const t0 = performance.now();
  const captured = await captureBaseline(sandbox, {
    projectDir: loaded.projectDir, runner: loaded.runner, files: planned.flatMap((p) => p.files),
    compilerFlags: loaded.plan.compiler_flags,
  });
  say(`baseline: ${captured.baseline.tests.passed}/${captured.baseline.tests.ran} passing, ` +
      `${captured.baseline.errors.total} tsc errors, ${((performance.now() - t0) / 1000).toFixed(0)}s`);
  const workers = await discoverWorkers(portsFromEnv());
  if (workers.length === 0) throw new Error("no worker is answering — start one with: sidecrew serve");
  const worker = workers[0]!;
  say(`worker ${worker.model} @ ${worker.baseUrl}`);

  const rows = [];
  for (const [i, b] of withNotes.entries()) {
    const p = byId.get(b.task_id)!;
    // attempt 2 with the note attached. The schema refuses a note on any attempt but 2 and refuses an
    // attempt 2 without one, so rule 3 — "the free retry is spent first" — is checked, not remembered.
    const task: ChangeTask = buildChangeTask(loaded, p, sandbox, captured, {
      attempt: 2, retryOf: b.task_id, previousError: null, correction: b.note,
    });
    const candidate = await generateChange(task, worker);
    const verdict = await verifyChange(task, candidate, {
      sandbox, baseline: captured.baseline, projectDir: loaded.projectDir, runner: loaded.runner,
      compilerFlags: loaded.plan.compiler_flags,
    });
    await writeFile(join(outDir, "verdicts", `${task.task_id}.json`), `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
    await writeFile(join(outDir, "corrections", `${task.task_id}.md`), `${b.rendered}\n\n---\n\n${b.note}\n`, "utf8");
    rows.push({
      task_id: b.task_id, survived: verdict.survived, stage: verdict.stage_reached,
      regressed: verdict.tests?.regressed.length ?? 0, tokens: b.tokens ?? 0,
      crossed_calendar_day: crossesCalendarDay(verdict), swap_growth_gb: swapGrowthGb(verdict.machine),
    });
    say(`[${i + 1}/${withNotes.length}] ${b.task_id} → ${verdict.survived ? "SURVIVED" : `failed at ${verdict.stage_reached}`}`);
  }
  const survived = rows.filter((r) => r.survived).length;
  await writeFile(join(outDir, "pass2.json"), `${JSON.stringify({
    measured: true, n2: withNotes.length, survived, S_c: survived / withNotes.length,
    compiler_flags: loaded.plan.compiler_flags,
    machine_before: machineBefore, machine_after: await readMachineState(), rows,
  }, null, 2)}\n`, "utf8");
  say(`\nS_c = ${survived}/${withNotes.length} = ${(survived / withNotes.length).toFixed(3)}`);
} else {
  throw new Error(`unknown mode ${mode}`);
}
