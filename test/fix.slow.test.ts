// The workload-#2a gate, for real: a real `tsc`, the fixture's real Vitest suite, and the seven
// controls put through it. SIDECREW_SLOW=1 to include. Needs `npm i` in fixtures/fix-fixture.
//
// Two things in here are the point of the phase rather than coverage of it:
//
//   * **every control fails**, and the four that satisfy `tsc` completely are shown to satisfy it — so
//     the claim "nothing but the confinement checker stands between these and a survivor" is measured
//     rather than asserted (ADR-0048);
//   * **the naive fix for `src/report.ts` is refused because it introduces an error in the test file.**
//     That is the "none introduced anywhere else" clause doing the work it was written for, on a real
//     compiler, and it is the clause that makes the gate monotone.
//
// It does **not** produce a survival rate. That is Phase 11, against a rule frozen before anybody had
// seen a number, and a number produced during construction is a number produced by somebody who wanted
// it to be good.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  captureBaseline, cloneSandbox, makeChangeSandbox, typecheck, verifyChange, type CapturedBaseline,
} from "../src/change.js";
import { loadChangePlan, runFix } from "../src/fix.js";
import { runReport } from "../src/report.js";
import { ChangeCandidate, ChangeTask, ConfinementRule, FixResult } from "../src/schemas.js";
import { locateSymbols, resolveSymbol } from "../src/symbols.js";
import { startFake, type Fake } from "./fake-worker.js";

const SLOW = process.env.SIDECREW_SLOW === "1";
const PROJECT = "fixtures/fix-fixture";
const PLAN = `${PROJECT}/plans/fix-type-errors.json`;
const CONTROLS = `${PROJECT}/controls`;
const MINUTES = 60_000;

/** The correct, behaviour-preserving fix for each planted error. Hand-written: this is the control arm. */
const FIXES: Record<string, (source: string) => string> = {
  "src/rates.ts": (s) => s.replace("return rates[code] ?? 0;", "return code === undefined ? 0 : rates[code] ?? 0;"),
  "src/cart.ts": (s) => s.replace("gross - gross * cart.discount", "gross - gross * (cart.discount ?? 0)"),
  "src/report.ts": (s) => s.replace("toFixed(places)", "toFixed(Number(places))"),
};

const read = (rel: string): string => readFileSync(join(PROJECT, rel), "utf8");

const task = (paths: string[], maxDeleted = 0): ChangeTask => ChangeTask.parse({
  task_id: `t.${paths.map((p) => basename(p)).join("+")}`,
  language: "typescript",
  test_framework: "vitest",
  ask: "Fix every TypeScript error in these files without changing what the code does.",
  files: paths.map((path) => ({ path, source: read(path), source_sha: "sha", errors: 1 })),
  diagnostics: "",
  max_deleted_lines: maxDeleted,
  notes: null,
  attempt: 0,
  retry_of: null,
  previous_error: null,
  correction: null,
  shape: "null_guard",
});

const candidate = (edits: { path: string; contents: string }[]): ChangeCandidate => ChangeCandidate.parse({
  task_id: "t",
  worker: { kind: "local", model: "hand-written", revision: "", temperature: 0, seed: 0 },
  edits,
  unparsed: null,
  refusal: null,
  truncated: false,
  usage: { prompt_tokens: 0, completion_tokens: 1 },
  timing: { ttft_ms: 0, wall_ms: 0 },
});

describe.skipIf(!SLOW)("the 2a gate on fixtures/fix-fixture", () => {
  let sandbox = "";
  let captured: CapturedBaseline;
  const temps: string[] = [];

  beforeAll(async () => {
    sandbox = await makeChangeSandbox(PROJECT);
    temps.push(sandbox);
    captured = await captureBaseline(sandbox, {
      projectDir: PROJECT,
      runner: "vitest",
      files: ["src/rates.ts", "src/cart.ts", "src/report.ts"],
    });
  }, 10 * MINUTES);

  afterAll(async () => { for (const d of temps) await rm(d, { recursive: true, force: true }); });

  it("captures a baseline that is the project as it actually is", () => {
    const b = captured.baseline;
    // Three planted errors of three kinds, and the README says which.
    expect(b.errors.total).toBe(3);
    expect(Object.keys(b.errors.by_file).sort()).toEqual(["src/cart.ts", "src/rates.ts", "src/report.ts"]);
    // Twelve tests, eleven passing. The twelfth fails on purpose, so that "every test that passed
    // before still passes" and "everything is green" cannot be confused (ADR-0046).
    expect(b.tests.ran).toBe(12);
    expect(b.tests.passed).toBe(11);
    expect(b.tests.failed).toBe(1);
    expect(b.tests.passed_ids).not.toContain("test/known-failure.test.ts::roundTo (known failure) > rounds half to even");
    expect(b.tests.passed_ids.filter((id) => id.startsWith("test/known-failure"))).toEqual([]);
    expect(captured.diagnostics).toMatch(/TS2538|TS18048|TS2345/);
  });

  it("keeps the project's tests in the sandbox, which is the opposite of ADR-0004 and on purpose", () => {
    const files = readdirSync(join(sandbox, "test"));
    expect(files.sort()).toEqual(readdirSync(join(PROJECT, "test")).sort());
  });

  for (const [path, fix] of Object.entries(FIXES)) {
    it(`admits the correct fix for ${path}`, { timeout: 5 * MINUTES }, async () => {
      const t = task([path]);
      const verdict = await verifyChange(t, candidate([{ path, contents: fix(read(path)) }]), {
        sandbox, baseline: captured.baseline, projectDir: PROJECT, runner: "vitest",
      });
      expect(verdict.error ?? "").toBe("");
      expect(verdict.survived).toBe(true);
      expect(verdict.stage_reached).toBe("done");
      expect(verdict.files_touched).toEqual([path]);
      // The per-file half of ADR-0044 §1: this file's errors are gone and nothing else gained any.
      expect(verdict.errors.remaining_in_target).toEqual({});
      expect(verdict.errors.introduced).toEqual({});
      expect(verdict.errors.after.total).toBeLessThan(verdict.errors.before.total);
      expect(verdict.tests?.ran_after).toBe(12);
      expect(verdict.tests?.regressed).toEqual([]);
    });
  }

  it("refuses the naive fix for src/report.ts, because it moves the error into the test file", { timeout: 5 * MINUTES }, async () => {
    // Retyping `places: string` to `places: number` satisfies this file and breaks `test/report.test.ts`,
    // which calls it with `"2"`. The change is confined, it compiles *locally*, and the gate refuses it
    // anyway — which is the "none introduced anywhere else" clause, on a real compiler.
    const naive = read("src/report.ts").replace("places: string", "places: number");
    const verdict = await verifyChange(task(["src/report.ts"]), candidate([{ path: "src/report.ts", contents: naive }]), {
      sandbox, baseline: captured.baseline, projectDir: PROJECT, runner: "vitest",
    });
    expect(verdict.confined).toBe(true);
    expect(verdict.survived).toBe(false);
    expect(verdict.stage_reached).toBe("compile");
    expect(verdict.errors.remaining_in_target).toEqual({});
    expect(Object.keys(verdict.errors.introduced)).toEqual(["test/report.test.ts"]);
  });

  // ADR-0086 §6 option B through the real gate: `rates.ts` carries one planted error, inside `rateFor`.
  describe("a symbol task judged by its declaration (ADR-0086 §6 B)", () => {
    const symbolTask = (name: string): ChangeTask => {
      const base = task(["src/rates.ts"]);
      const located = locateSymbols(base.files, [{ file: "src/rates.ts", name }], captured.diagnostics, PROJECT);
      if (!Array.isArray(located)) throw new Error(located.problem);
      return ChangeTask.parse({ ...base, symbols: located });
    };
    const convertRefactor = read("src/rates.ts").replace(
      "  return roundTo(amount * rateFor(rates, code), 2);",
      "  const rate = rateFor(rates, code);\n  return roundTo(amount * rate, 2);",
    );

    it("passes a change to one declaration though another in the file still has its error", { timeout: 5 * MINUTES }, async () => {
      const t = symbolTask("convert");
      expect(t.symbols[0]!.errors).toBe(0);
      const verdict = await verifyChange(t, candidate([{ path: "src/rates.ts", contents: convertRefactor }]), {
        sandbox, baseline: captured.baseline, projectDir: PROJECT, runner: "vitest",
      });
      expect(verdict.target_scope).toBe("declaration");
      expect(verdict.errors.outside_target["src/rates.ts"]).toEqual({ before: 1, after: 1 });
      expect(verdict.compile_ok, verdict.error ?? "").toBe(true);
      expect(verdict.survived, verdict.error ?? "").toBe(true);
    });

    it("refuses the same change under symbol_gate \"file\", 14c's rule", { timeout: 5 * MINUTES }, async () => {
      const verdict = await verifyChange(symbolTask("convert"), candidate([{ path: "src/rates.ts", contents: convertRefactor }]), {
        sandbox, baseline: captured.baseline, projectDir: PROJECT, runner: "vitest", symbolGate: "file",
      });
      expect(verdict.target_scope).toBe("file");
      expect(verdict.compile_ok).toBe(false);
    });

    it("refuses a fix that clears its declaration by breaking a neighbour — B's control", { timeout: 5 * MINUTES }, async () => {
      // Narrowing rateFor's parameter clears its own error and pushes one into convert, which calls it
      // with `string | undefined`. The file's total does not rise; the outside count does.
      const t = symbolTask("rateFor");
      expect(t.symbols[0]!.errors).toBe(1);
      const moved = read("src/rates.ts").replace(
        "export function rateFor(rates: Record<string, number>, code: string | undefined): number {",
        "export function rateFor(rates: Record<string, number>, code: string): number {",
      );
      const verdict = await verifyChange(t, candidate([{ path: "src/rates.ts", contents: moved }]), {
        sandbox, baseline: captured.baseline, projectDir: PROJECT, runner: "vitest",
      });
      expect(verdict.errors.remaining_in_target).toEqual({});
      expect(verdict.errors.outside_target["src/rates.ts"]).toEqual({ before: 0, after: 1 });
      expect(verdict.compile_ok).toBe(false);
      expect(verdict.error).toContain("outside the named declarations");
    });
  });

  describe("the controls", () => {
    const controls = readdirSync(CONTROLS).filter((f) => f.endsWith(".json"))
      .map((f) => ({ name: basename(f, ".json"), ...JSON.parse(readFileSync(join(CONTROLS, f), "utf8")) as {
        rule: string; why: string; symbols?: string[]; edits: { path: string; contents: string }[];
      } }));

    it("has one for every rule the contract knows", () => {
      expect(controls.map((c) => c.name).sort()).toEqual([...ConfinementRule.options].sort());
    });

    for (const control of controls) {
      it(`fails the real gate: ${control.name}`, { timeout: 5 * MINUTES }, async () => {
        // ADR-0086: a symbol rule's control runs against a task scoped the way `buildChangeTask` scopes one.
        const base = task(["src/rates.ts"]);
        const located = control.symbols === undefined ? []
          : locateSymbols(base.files, control.symbols.map((name) => ({ file: "src/rates.ts", name })), "", PROJECT);
        if (!Array.isArray(located)) throw new Error(located.problem);
        const verdict = await verifyChange(ChangeTask.parse({ ...base, symbols: located }), candidate(control.edits), {
          sandbox, baseline: captured.baseline, projectDir: PROJECT, runner: "vitest",
        });
        expect(verdict.survived, control.why).toBe(false);
        expect(verdict.confined).toBe(false);
        expect(verdict.confinement.map((b) => b.rule)).toContain(control.rule);
        // Nothing was written: confinement runs before apply, which is the property whole-file edits
        // buy (ADR-0047 §2). So the step sandbox is untouched and the next control sees the original.
        expect(readFileSync(join(sandbox, "src/rates.ts"), "utf8")).toBe(read("src/rates.ts"));
      });
    }

    // The claim this phase has to be able to make: for four of the seven, `tsc` is *satisfied* and the
    // suite is *green*. Nothing but the confinement checker stands between them and a survivor, and a
    // gate of "compiles ∧ tests pass" alone would have admitted every one.
    for (const name of ["suppression_added", "any_escape_added", "build_config_edited", "no_edit_at_all"]) {
      it(`would otherwise have passed tsc: ${name}`, { timeout: 5 * MINUTES }, async () => {
        const control = controls.find((c) => c.name === name)!;
        const clone = await cloneSandbox(sandbox);
        temps.push(clone);
        for (const edit of control.edits) await writeFile(join(clone, edit.path), edit.contents, "utf8");
        const after = await typecheck(clone, PROJECT, "tsconfig.json", 5 * MINUTES);
        const rates = after.errors.by_file["src/rates.ts"] ?? 0;
        if (name === "no_edit_at_all") {
          // The exception, and it is the one that proves the rule is needed: doing nothing leaves the
          // error in place, so this control is refused by `tsc` too. It is here because a gate that
          // only asked "is the suite still green?" would have admitted it.
          expect(rates).toBe(1);
        } else {
          expect(rates, control.why).toBe(0);
        }
      });
    }
  });
});

// ── the whole loop ────────────────────────────────────────────────────────────────────────────────

/** The fake worker answers in the form the prompt asks for, choosing the fix from the file it was shown. */
const answerFor = (body: Record<string, unknown>): string[] => {
  const messages = body.messages as { content?: string }[] | undefined;
  const prompt = messages?.[0]?.content ?? "";
  // ADR-0086: a symbol task is answered with the fixed declaration alone, which is all it was shown.
  const symbol = /--- SYMBOL: (src\/[\w.]+)#(\w+) ---/.exec(prompt);
  if (symbol !== null) {
    const [, file, name] = symbol as unknown as [string, string, string];
    const fixed = FIXES[file]!(read(file));
    const r = resolveSymbol(fixed, name, file);
    if (!r.ok) return ["nothing to do"];
    return [`--- SYMBOL: ${file}#${name} ---\n`, fixed.slice(r.span.start, r.span.end)];
  }
  const path = Object.keys(FIXES).find((p) => prompt.includes(`--- FILE: ${p} ---`));
  if (path === undefined) return ["nothing to do"];
  return [`--- FILE: ${path} ---\n`, FIXES[path]!(read(path))];
};

/**
 * A worker that gets it wrong until it is told what is wrong — the shape ADR-0044 §4 is for.
 *
 * The first two attempts add a `// @ts-ignore`, which is `suppression_added` and is refused without the
 * candidate being read. The third attempt looks for the correction in its prompt and, finding it, makes
 * the real fix. That is the mechanism under test: a note the gate produced changing what comes back.
 */
const stubbornAnswer = (body: Record<string, unknown>): string[] => {
  const messages = body.messages as { content?: string }[] | undefined;
  const prompt = messages?.[0]?.content ?? "";
  const path = Object.keys(FIXES).find((p) => prompt.includes(`--- FILE: ${p} ---`));
  if (path === undefined) return ["nothing to do"];
  // `correction` is rendered by `fix-retry.md`, so its presence in the prompt is the thing being proved.
  const corrected = prompt.includes("CORRECTION-MARKER");
  const body_ = corrected ? FIXES[path]!(read(path)) : `// @ts-ignore\n${FIXES[path]!(read(path))}`;
  return [`--- FILE: ${path} ---\n`, body_];
};

describe.skipIf(!SLOW)("the correction round, end to end (ADR-0044 §4)", () => {
  let fake: Fake;
  let dir = "";

  beforeAll(async () => {
    fake = await startFake({ chunksFor: stubbornAnswer, modelId: "fake-worker" });
    dir = await mkdtemp(join(tmpdir(), "sidecrew-fix-correct-"));
  });

  afterAll(async () => {
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  });

  const oneTaskPlan = async (correction: Record<string, unknown>): Promise<string> => {
    const plan = JSON.parse(readFileSync(PLAN, "utf8")) as Record<string, unknown>;
    plan.correction = correction;
    plan.steps = [{
      name: "guard the rate lookup",
      tasks: [{
        task_id: "rates", ask: "Fix every TypeScript error in these files without changing what the code does.",
        files: ["src/rates.ts"], max_deleted_lines: 0, blocking: false, shape: "null_guard",
      }],
    }];
    const d = await mkdtemp(join(tmpdir(), "sidecrew-correct-plan-"));
    const path = join(d, "change_plan.json");
    await writeFile(path, JSON.stringify(plan, null, 2), "utf8");
    return path;
  };

  it("is off by default, so the task escalates after the free retry", { timeout: 10 * MINUTES }, async () => {
    const path = await oneTaskPlan({ enabled: false, max_corrections: 0, max_tokens: 0, on_observations: false });
    const result = await runFix(path, { dir, ports: [fake.port] });
    expect(result.stats.survived).toBe(0);
    expect(result.stats.corrections.written).toBe(0);
    // Two attempts, both refused by the confinement checker without the candidate being compiled.
    //
    // **Both rules fire, and that is the gate being right rather than a bug.** ADR-0054 made an
    // unrequested documentation change a breach, and the control's suppression is a `// @ts-ignore`
    // line — which is a comment line added, so it trips that rule as well. The expectation here was
    // written before ADR-0054 and had been stale ever since, silently, because `ci.yml` runs the fast
    // set and nothing runs this file. `suppression_added` is still the meaningful one.
    expect(result.stats.confinement_breaks).toEqual({ documentation_changed: 2, suppression_added: 2 });
    expect(result.stats.claude_tokens.planning).toBe(0);
  });

  it("writes one note after the mechanical retry, and the worker survives on attempt 2", { timeout: 10 * MINUTES }, async () => {
    const path = await oneTaskPlan({ enabled: true, max_corrections: 3, max_tokens: 0, on_observations: false });
    const seen: string[] = [];
    const result = await runFix(path, {
      dir,
      ports: [fake.port],
      correct: async (b) => {
        // Rule 1, at the call site: what arrives is the gate's own findings and nothing else.
        seen.push(b.findings.join("\n"));
        return { note: "CORRECTION-MARKER: never add a suppression; fix the type instead.", tokens: 120 };
      },
    });

    expect(result.stats.corrections.written).toBe(1);
    expect(result.stats.corrections.survived).toBe(1);
    expect(result.stats.corrections.tokens).toBe(120);
    expect(result.stats.survived).toBe(1);
    // A correction IS an Opus token, so it has to be inside the run's accounting (the schema refuses
    // a result where it is not) — and the workers still cost zero on the local tier.
    expect(result.stats.claude_tokens.planning).toBe(120);
    expect(result.stats.claude_tokens.workers).toBe(0);

    // What the writer was handed: the named rule, and no trace of the candidate.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("suppression_added");
    expect(seen[0]).not.toContain("@ts-ignore\nexport");

    // Three attempts on disk, and the third is the corrected one. The note is filed under the attempt
    // whose **verdict it was written from** — `rates#1`, the mechanical retry — rather than under the
    // attempt it produced, because that is the pairing a reader reconstructing the run needs.
    const runDir = join(dir, "runs", result.run_id);
    const note = await readFile(join(runDir, "corrections", "rates.1.md"), "utf8");
    expect(note).toContain("CORRECTION-MARKER");
    const corrected = JSON.parse(await readFile(join(runDir, "tasks", "rates.2.json"), "utf8")) as Record<string, unknown>;
    expect(corrected.attempt).toBe(2);
    expect(corrected.correction).toContain("CORRECTION-MARKER");
  });

  it("stops at the budget rather than correcting everything it can", { timeout: 10 * MINUTES }, async () => {
    const path = await oneTaskPlan({ enabled: true, max_corrections: 0, max_tokens: 0, on_observations: false });
    const result = await runFix(path, {
      dir,
      ports: [fake.port],
      correct: async () => ({ note: "CORRECTION-MARKER: should never be reached", tokens: 999 }),
    });
    expect(result.stats.corrections.written).toBe(0);
    expect(result.stats.corrections.budget_exhausted).toMatch(/budget of 0/);
    expect(result.stats.survived).toBe(0);
  });
});

describe.skipIf(!SLOW)("unattended mode — resume and the report (BACKLOG item 4)", () => {
  let fake: Fake;
  let dir = "";

  beforeAll(async () => {
    fake = await startFake({ chunksFor: answerFor, modelId: "fake-worker" });
    dir = await mkdtemp(join(tmpdir(), "sidecrew-fix-resume-"));
  });

  afterAll(async () => {
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("does not generate again for a task it already answered", { timeout: 30 * MINUTES }, async () => {
    // The whole point of ADR-0023 writing a file per task as the run goes: a run that dies has the
    // record, and resuming it should cost the workers nothing for what is already done.
    const first = await runFix(PLAN, { dir, ports: [fake.port] });
    expect(first.stats.survived).toBe(3);
    const generatedFirst = fake.requests.length;
    expect(generatedFirst).toBeGreaterThan(0);

    const again = await runFix(PLAN, { dir, ports: [fake.port], resume: first.run_id });

    // Not one further completion was asked for, and the outcome is the same run's.
    expect(fake.requests.length).toBe(generatedFirst);
    expect(again.run_id).toBe(first.run_id);
    expect(again.stats.survived).toBe(3);
    expect(again.stats.tasks).toBe(first.stats.tasks);

    // The survivors still land: the sandbox is rebuilt and the reused edits applied, so the project
    // converges exactly as it did the first time.
    expect(again.project.errors_after).toBe(0);
    expect(again.project.combined_regressions).toBe(0);

    // And the escalation queue did not gain duplicates for tasks that were reused.
    const queue = await readFile(join(dir, "runs", first.run_id, "escalations.jsonl"), "utf8").catch(() => "");
    const ids = queue.split("\n").filter((l) => l.trim() !== "").map((l) => (JSON.parse(l) as { task_id: string }).task_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("refuses to resume a run that is not there, rather than starting a new one under that name", async () => {
    await expect(runFix(PLAN, { dir, ports: [fake.port], resume: "nope" })).rejects.toThrow(/nothing to resume/);
  });

  it("orders the report by what needs attention, not by what happened", { timeout: 30 * MINUTES }, async () => {
    const result = await runFix(PLAN, { dir, ports: [fake.port] });
    const report = await runReport(result.run_id, { dir });

    expect(report.run_id).toBe(result.run_id);
    expect(report.stats.survived).toBe(3);
    // A clean run: nothing above rank 4, so every item is a survivor and the headline says so.
    expect(report.read_first.every((i) => i.kind === "survivor" || i.kind === "observed_survivor")).toBe(true);
    expect(report.headline).toContain("3/3 survived");
    expect(report.stopped).toBeNull();

    // Every item says where to look, and the ranks are non-decreasing — the ordering is the product.
    const ranks = report.read_first.map((i) => i.rank);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    for (const i of report.read_first) expect(i.where.length).toBeGreaterThan(0);
  });

  it("tells a caller to resume rather than guessing, when the run never wrote a result", async () => {
    const half = await mkdtemp(join(tmpdir(), "sidecrew-half-"));
    await mkdir(join(half, "runs", "2026-09-18T00-00-00Z-x"), { recursive: true });
    await expect(runReport("2026-09-18T00-00-00Z-x", { dir: half })).rejects.toThrow(/--resume/);
    await rm(half, { recursive: true, force: true });
  });
});

describe.skipIf(!SLOW)("the candidate cache (ADR-0065)", () => {
  let fake: Fake;
  let dir = "";

  beforeAll(async () => {
    fake = await startFake({ chunksFor: answerFor, modelId: "fake-worker" });
    dir = await mkdtemp(join(tmpdir(), "sidecrew-fix-cache-"));
  });

  afterAll(async () => {
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("is off unless asked, and a run that did not ask reports it off", { timeout: 30 * MINUTES }, async () => {
    // ADR-0065: off by default, because an `experiments/` figure must come from a run that asked no
    // worker to repeat itself. The schema refuses a result claiming hits it did not enable.
    const result = await runFix(PLAN, { dir, ports: [fake.port] });
    expect(result.stats.cache).toEqual({ enabled: false, hits: 0, writes: 0 });
  });

  it("serves the second identical run without asking a worker", { timeout: 30 * MINUTES }, async () => {
    const cacheDir = join(dir, "shared-cache");
    const first = await runFix(PLAN, { dir, ports: [fake.port], cache: true, cacheDir });
    const askedFirst = fake.requests.length;
    expect(first.stats.cache.enabled).toBe(true);
    expect(first.stats.cache.hits).toBe(0);
    expect(first.stats.cache.writes).toBeGreaterThan(0);

    const second = await runFix(PLAN, { dir, ports: [fake.port], cache: true, cacheDir });

    // Not one further completion, and the same outcome — which is the determinism claim ADR-0003 makes,
    // now load-bearing rather than asserted once in Phase 1.
    expect(fake.requests.length).toBe(askedFirst);
    expect(second.stats.cache.hits).toBe(first.stats.cache.writes);
    expect(second.stats.survived).toBe(first.stats.survived);
    expect(second.project.errors_after).toBe(first.project.errors_after);

    // The gate still ran: the cache saves generation and nothing else, which is why the win is ~5 %.
    expect(second.stats.gate_ms.median).toBeGreaterThan(0);
  });

  // The template-change miss — the property the whole key design turns on — is pinned as a unit test in
  // `test/cache.test.ts` rather than here. Doing it end to end would need a test-only hook to render a
  // different prompt, and adding production API to satisfy a test is a worse trade than the coverage is
  // worth: the key is a pure function and a pure function is where that belongs.
});

describe.skipIf(!SLOW)("runFix over an ordered plan", () => {
  let fake: Fake;
  let dir = "";

  beforeAll(async () => {
    fake = await startFake({ chunksFor: answerFor, modelId: "fake-worker" });
    dir = await mkdtemp(join(tmpdir(), "sidecrew-fix-run-"));
  });

  afterAll(async () => {
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("captures a baseline and stops before the first token on --dry-run", { timeout: 10 * MINUTES }, async () => {
    // The baseline is deliberately not skipped: a tsconfig that does not cover the plan's files, or a
    // suite that collects nothing, is how this workload fails before the model is ever involved.
    const result = await runFix(PLAN, { dir, dryRun: true, ports: [fake.port] });
    expect(fake.requests.length).toBe(0);
    expect(result.stats.tasks).toBe(0);
    const runDir = join(dir, "runs", result.run_id);
    const prompt = await readFile(join(runDir, "prompts", "rates.md"), "utf8");
    expect(prompt).toContain("--- FILE: src/rates.ts ---");
    // The compiler's own words about this task's files, and nobody else's (ADR-0022's lesson).
    expect(prompt).toContain("TS2538");
    expect(prompt).not.toContain("TS18048");
  });

  it(
    "runs the steps in order, lands each step's survivors, and converges",
    { timeout: 30 * MINUTES },
    async () => {
      const result = await runFix(PLAN, { dir, ports: [fake.port] });
      expect(() => FixResult.parse(result)).not.toThrow();

      const plan = await loadChangePlan(PLAN);
      expect(result.stats.tasks).toBe(plan.plan.steps.reduce((n, s) => n + s.tasks.length, 0));
      expect(result.stats.survived).toBe(3);
      expect(result.stats.escalated).toBe(0);
      expect(result.config.worker_kind).toBe("local");
      expect(result.stats.claude_tokens.workers).toBe(0);

      // The monotone gate, over two steps: three errors at the start, none at the end, and each step's
      // `errors_after` is the next one's `errors_before` because the baseline was re-captured (ADR-0044 §2).
      expect(result.project.errors_before).toBe(3);
      expect(result.project.errors_after).toBe(0);
      expect(result.steps.map((s) => [s.errors_before, s.errors_after])).toEqual([[3, 2], [2, 0]]);
      expect(result.steps.map((s) => s.name)).toEqual(["guard the rate lookup", "default the optional fields"]);

      // Every survivor was verified alone. This is the only number in the run that can see two of them
      // interacting, and it must be zero — anything else is a hole in the gate, not a bad change.
      expect(result.project.combined_regressions).toBe(0);
      expect(result.project.tests_ran).toBe(12);
      expect(result.project.tests_passed).toBe(11);

      // Files are the IPC: the diff is on disk for every survivor, and it is a diff.
      for (const survivor of result.survivors) {
        const diff = await readFile(survivor.diff_path, "utf8");
        expect(diff).toContain(`--- a/${survivor.files[0]}`);
        expect(diff).toMatch(/^\+/m);
      }
      expect(result.stats.edit_parse_failed).toBe(0);
      expect(result.stats.confinement_breaks).toEqual({});
    },
  );

  it(
    "stops after a step that left a blocking task unfinished",
    { timeout: 20 * MINUTES },
    async () => {
      // ADR-0044 §2: an escalation does not hold up the next step *unless the plan says it does*. The
      // default is not, because a wait per step is where a long job dies overnight; `blocking` is the
      // planner's way of saying step N+1 would be building on sand.
      const plan = JSON.parse(readFileSync(PLAN, "utf8")) as Record<string, unknown>;
      const steps = plan.steps as Record<string, unknown>[];
      // `src/money.ts` has no errors and is not one the fake knows how to fix, so this task cannot
      // survive — which is the point. It is marked blocking, so step 2 must never run.
      steps[0]!.tasks = [{
        task_id: "money", ask: "Fix every TypeScript error in these files without changing what the code does.",
        files: ["src/money.ts"], max_deleted_lines: 0, blocking: true, shape: "null_guard",
      }];
      const dir2 = await mkdtemp(join(tmpdir(), "sidecrew-fix-block-"));
      const path = join(dir2, "change_plan.json");
      await writeFile(path, JSON.stringify(plan, null, 2), "utf8");
      try {
        const result = await runFix(path, { dir: dir2, ports: [fake.port] });
        expect(result.stats.tasks).toBe(1);
        expect(result.stats.survived).toBe(0);
        expect(result.steps.map((s) => s.name)).toEqual(["guard the rate lookup"]);
        const stopped = await readFile(join(dir2, "runs", result.run_id, "stopped.txt"), "utf8");
        expect(stopped).toContain("money");
        // Nothing landed, so the project is exactly where it started.
        expect(result.project.errors_after).toBe(result.project.errors_before);
      } finally {
        await rm(dir2, { recursive: true, force: true });
      }
    },
  );
  it(
    "carries a symbol-scoped task from the plan to a survivor, splicing the declaration back (ADR-0086)",
    { timeout: 20 * MINUTES },
    async () => {
      const plan = JSON.parse(readFileSync(PLAN, "utf8")) as Record<string, unknown>;
      const steps = plan.steps as Record<string, unknown>[];
      plan.steps = [steps[0]];
      steps[0]!.tasks = [{
        task_id: "rateFor", ask: "Fix every TypeScript error in these declarations without changing what the code does.",
        files: ["src/rates.ts"], max_deleted_lines: 0, blocking: false, shape: "null_guard",
        symbols: [{ file: "src/rates.ts", name: "rateFor" }],
      }];
      const dir2 = await mkdtemp(join(tmpdir(), "sidecrew-fix-symbol-"));
      const path = join(dir2, "change_plan.json");
      await writeFile(path, JSON.stringify(plan, null, 2), "utf8");
      try {
        const result = await runFix(path, { dir: dir2, ports: [fake.port] });
        expect(result.stats.survived).toBe(1);
        expect(result.stats.confinement_breaks).toEqual({});
        const runDir = join(dir2, "runs", result.run_id);
        const cand = ChangeCandidate.parse(JSON.parse(await readFile(join(runDir, "candidates", "rateFor.json"), "utf8")));
        expect(cand.symbol_edits.map((e) => e.name)).toEqual(["rateFor"]);
        // The spliced file is the hand-written whole-file fix, byte for byte: nothing outside moved.
        expect(cand.edits).toEqual([{ path: "src/rates.ts", contents: FIXES["src/rates.ts"]!(read("src/rates.ts")) }]);
        // The worker was never shown the rest of the file.
        const sent = fake.requests.at(-1) as { messages: { content: string }[] };
        expect(sent.messages[0]!.content).not.toContain("export function convert(");
      } finally {
        await rm(dir2, { recursive: true, force: true });
      }
    },
  );
});
