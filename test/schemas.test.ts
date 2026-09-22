import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  BatchResult, Candidate, ChangeBaseline, ChangeCandidate, ChangeEscalation, ChangePlan, ChangeTask,
  ChangeVerdict, EscalationBatch, FixResult, ReviewQueue, StatusReport, TestPlan, Verdict,
  ValidationReport, WorkerTask, changeSurvives, crossesCalendarDay, survives, swapGrowthGb,
} from "../src/schemas.js";

const SPEC = fileURLToPath(new URL("../docs/specs/pipeline.md", import.meta.url));

/**
 * The spec examples are illustrative JSON: they carry `// …` notes on the fields that need them.
 * Strip those, but only outside string literals — `"http://localhost:8000/v1"` must survive.
 */
const stripLineComments = (src: string): string => {
  let out = "";
  let inString = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inString) {
      out += c;
      if (c === "\\") { out += src[i + 1] ?? ""; i += 1; } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i += 1; out += "\n"; continue; }
    out += c;
  }
  return out;
};

/** Every ```json block in the spec, keyed by the first word of the `## ` heading above it. */
const specExamples = (): Map<string, unknown> => {
  const lines = readFileSync(SPEC, "utf8").split("\n");
  const found = new Map<string, unknown>();
  let heading = "";
  for (let i = 0; i < lines.length; i += 1) {
    const h = /^##\s+`?(\w+)/.exec(lines[i]!);
    if (h) { heading = h[1]!; continue; }
    if (lines[i] !== "```json") continue;
    const end = lines.indexOf("```", i + 1);
    expect(end, `unterminated json block under ## ${heading}`).toBeGreaterThan(i);
    const body = lines.slice(i + 1, end).join("\n");
    expect(found.has(heading), `two json blocks under ## ${heading}`).toBe(false);
    found.set(heading, JSON.parse(stripLineComments(body)));
    i = end;
  }
  return found;
};

const SCHEMAS: Record<string, z.ZodTypeAny> = {
  TestPlan, WorkerTask, Candidate, Verdict, BatchResult, StatusReport, ValidationReport,
  EscalationBatch, ReviewQueue,
  // Workload #2a (Phase 10). Same rule as above: one spec example each, and they round-trip — so a
  // defaulted field has to be written out in the example rather than left to zod (ADR-0007).
  ChangePlan, ChangeBaseline, ChangeTask, ChangeCandidate, ChangeVerdict, FixResult,
  // Phase 12 (ADR-0044 §4, ADR-0057). The 2a queue is its own shape, not a widened Escalation.
  ChangeEscalation,
};

describe("docs/specs/pipeline.md ⇄ src/schemas.ts", () => {
  const examples = specExamples();

  it("has exactly the json examples the schemas expect", () => {
    // Fails when a shape gains a spec example with no schema, or loses the example that pins it.
    expect([...examples.keys()].sort()).toEqual(Object.keys(SCHEMAS).sort());
  });

  for (const [name, schema] of Object.entries(SCHEMAS)) {
    it(`${name} parses its spec example and round-trips`, () => {
      const example = examples.get(name);
      expect(example, `no json example under ## ${name}`).toBeDefined();
      const parsed = schema.parse(example);
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(example);
    });
  }
});

describe("the invariants the contracts are here to enforce", () => {
  const base = Verdict.parse(specExamples().get("Verdict"));

  it("rejects a Verdict that claims a survival its own fields don't support", () => {
    expect(Verdict.safeParse({ ...base, tautological: true }).success).toBe(false);
    expect(Verdict.safeParse({ ...base, mutation: { ...base.mutation!, killed: 0, score: 0 } }).success).toBe(false);
    expect(Verdict.safeParse({ ...base, survived: false }).success).toBe(false);
  });

  it("accepts a failed Verdict where survived follows the same rule", () => {
    const failed = { ...base, survived: false, tautological: true };
    expect(Verdict.safeParse(failed).success).toBe(true);
    expect(survives(failed)).toBe(false);
  });

  it("survives() is unmoved by a stage that never ran", () => {
    expect(survives({ ...base, mutation: null })).toBe(false);
  });

  it("truncates errors at 2048 chars rather than carrying a whole compiler log", () => {
    expect(Verdict.safeParse({ ...base, survived: false, compile_ok: false, error: "x".repeat(2048) }).success).toBe(true);
    expect(Verdict.safeParse({ ...base, survived: false, compile_ok: false, error: "x".repeat(2049) }).success).toBe(false);
  });

  const batch = BatchResult.parse(specExamples().get("BatchResult"));
  const spentOnWorkers = (kind: "local" | "api") => ({
    ...batch,
    config: { ...batch.config, worker_kind: kind },
    stats: { ...batch.stats, claude_tokens: { ...batch.stats.claude_tokens, workers: 1 } },
  });

  it("refuses a local run that spent Claude tokens on worker inference", () => {
    expect(BatchResult.safeParse(spentOnWorkers("local")).success).toBe(false);
  });

  it("allows the api tier to cost what it costs", () => {
    // ADR-0009: the guarantee is conditional now, not abandoned. A fallback run reporting 0 would be
    // the lie worth catching, not the honest number.
    expect(BatchResult.safeParse(spentOnWorkers("api")).success).toBe(true);
  });

  // ── workload #2a ────────────────────────────────────────────────────────────────────────────────

  it("refuses a local fix run that spent Claude tokens on worker inference", () => {
    // The same guarantee `BatchResult` carries. A second workload that quietly dropped it would be a
    // second place for the project's headline claim to stop being true (ADR-0009, ADR-0045).
    const fix = FixResult.parse(specExamples().get("FixResult"));
    const spent = { ...fix, stats: { ...fix.stats, claude_tokens: { ...fix.stats.claude_tokens, workers: 1 } } };
    expect(FixResult.safeParse(spent).success).toBe(false);
    expect(FixResult.safeParse({ ...spent, config: { ...fix.config, worker_kind: "api" } }).success).toBe(true);
  });

  it("refuses a ChangePlan with a `workers` field — ADR-0044 §3 is `strict`, not a sentence", () => {
    const plan = specExamples().get("ChangePlan") as Record<string, unknown>;
    expect(ChangePlan.safeParse({ ...plan, workers: 3 }).success).toBe(false);
    const steps = (plan.steps as Record<string, unknown>[]).map((s) => ({ ...s, workers: 2 }));
    expect(ChangePlan.safeParse({ ...plan, steps }).success).toBe(false);
  });

  it("gives a ChangeTask room for the correction round without letting it arrive early", () => {
    // ADR-0044 §4 is Phase 12's. `attempt: 2` and `correction` exist now so that phase is a fill rather
    // than a migration, and `3` is not a number of attempts this design has.
    const task = ChangeTask.parse(specExamples().get("ChangeTask"));
    expect(ChangeTask.safeParse({ ...task, attempt: 2, correction: "the import is wrong" }).success).toBe(true);
    expect(ChangeTask.safeParse({ ...task, attempt: 3 }).success).toBe(false);
  });

  it("pairs a correction with attempt 2 in both directions — ADR-0044 §4 rule 3, as a refusal", () => {
    // The mechanical retry carries the tool's own words for free (ADR-0022), so an Opus note may only
    // ride on attempt 2. Without this the §2.2 measurement quietly changes question: "what does a note
    // buy over the free retry" becomes "what does a note buy", which is far easier to pass.
    const task = ChangeTask.parse(specExamples().get("ChangeTask"));
    expect(ChangeTask.safeParse({ ...task, attempt: 0, correction: "too early" }).success).toBe(false);
    expect(ChangeTask.safeParse({ ...task, attempt: 1, correction: "still too early" }).success).toBe(false);
    expect(ChangeTask.safeParse({ ...task, attempt: 2, correction: null }).success).toBe(false);
  });

  it("requires a task to say what shape of change it is, with no default", () => {
    // The shape is the caveat on every number: `tsc` proves a rename complete and proves nothing about
    // a null guard's behaviour. A default would have made every unlabelled task a rename — the shape
    // every existing rate is already about.
    const task = specExamples().get("ChangeTask") as Record<string, unknown>;
    const { shape: _omitted, ...without } = task;
    expect(ChangeTask.safeParse(without).success).toBe(false);
    expect(ChangeTask.safeParse({ ...task, shape: "refactor" }).success).toBe(false);
  });

  it("keeps observations out of the gate — ADR-0057, asserted rather than trusted", () => {
    // The one way this decision gets lost is somebody reading `observations` as a soft confinement
    // list. Then survival stops being comparable with Phase 11's and nothing fails.
    const verdict = ChangeVerdict.parse(specExamples().get("ChangeVerdict"));
    const observed = ChangeVerdict.parse({
      ...verdict,
      observations: [{ kind: "comment_lines_removed", file: "src/totals.ts", detail: "7 comment line(s) removed" }],
    });
    expect(observed.survived).toBe(true);
    expect(changeSurvives(observed)).toBe(true);
  });

  it("refuses a refusal that claims to have survived, or to have reached a sandbox", () => {
    const verdict = ChangeVerdict.parse(specExamples().get("ChangeVerdict"));
    expect(ChangeVerdict.safeParse({ ...verdict, refused: "I cannot do this" }).success).toBe(false);
    const failed = { ...verdict, survived: false, tests_ok: false, tests: null, compile_ok: false };
    expect(ChangeVerdict.safeParse({ ...failed, refused: "no", stage_reached: "compile" }).success).toBe(false);
    expect(ChangeVerdict.safeParse({
      ...failed,
      refused: "the ask needs a file this task does not list",
      stage_reached: "generate",
      errors: { ...verdict.errors, remaining_in_target: {} },
    }).success).toBe(true);
  });

  it("refuses correction accounting that does not add up", () => {
    const fix = FixResult.parse(specExamples().get("FixResult"));
    const withStats = (corrections: Record<string, unknown>): unknown =>
      ({ ...fix, stats: { ...fix.stats, corrections } });
    expect(FixResult.safeParse(withStats({ written: 1, survived: 2, on_observations: 0, tokens: 10, budget_exhausted: null })).success).toBe(false);
    expect(FixResult.safeParse(withStats({ written: 0, survived: 0, on_observations: 0, tokens: 400, budget_exhausted: null })).success).toBe(false);
    // A correction IS an Opus token, so it has to be inside the run's own accounting or §2.2 cannot see it.
    const planning = fix.stats.claude_tokens.planning;
    expect(FixResult.safeParse(withStats({ written: 1, survived: 1, on_observations: 0, tokens: planning + 1, budget_exhausted: null })).success).toBe(false);
    expect(FixResult.safeParse(withStats({ written: 1, survived: 1, on_observations: 0, tokens: planning, budget_exhausted: "max_corrections" })).success).toBe(true);
  });

  it("defaults the whole correction round to off, because ADR-0044 decided it gets measured", () => {
    const plan = ChangePlan.parse(specExamples().get("ChangePlan"));
    expect(plan.correction).toEqual({ enabled: false, max_corrections: 0, max_tokens: 0, on_observations: false });
    const { correction: _dropped, ...without } = specExamples().get("ChangePlan") as Record<string, unknown>;
    expect(ChangePlan.parse(without).correction.enabled).toBe(false);
  });

  it("records the baseline's age and the machine, and gates on neither (ADR-0069, ADR-0066)", () => {
    // Both decisions are *record, don't gate*, and the way that gets lost is somebody later reading a
    // recorded field as a soft gate — after which survival stops being comparable with Phase 11's and
    // nothing fails. So it is asserted here rather than left to the comment that says it.
    const verdict = ChangeVerdict.parse(specExamples().get("ChangeVerdict"));
    expect(verdict.survived).toBe(true);
    const stale = ChangeVerdict.parse({
      ...verdict,
      baseline_captured_at: "2026-09-18T23:26:01.000Z",
      verified_at: "2026-09-19T00:03:17.000Z",
      machine: {
        before: { pressure: "critical", free_gb: 0.4, swap_gb: 5.3, compressed_gb: 15.2 },
        after: { pressure: "critical", free_gb: 0.2, swap_gb: 6.1, compressed_gb: 15.9 },
      },
    });
    expect(stale.survived).toBe(true);
    expect(changeSurvives(stale)).toBe(true);
  });

  it("reads a stale baseline as a calendar-day gap, not as an elapsed-hours one (ADR-0069)", () => {
    // The measured case: baseline 2026-09-18 23:26:01, candidate 2026-09-19 00:03:17. Thirty-seven
    // minutes apart, and the test that asserts on what was tracked *today* had already flipped. Any
    // threshold in hours misses this; the day boundary is the whole of the signal.
    const day = (b: string, v: string): boolean | null =>
      crossesCalendarDay({ baseline_captured_at: b, verified_at: v });
    const iso = (h: number, m: number, d: number): string => new Date(2026, 8, d, h, m).toISOString();
    expect(day(iso(23, 26, 18), iso(0, 3, 19))).toBe(true);

    // **ADR-0083: the UTC boundary counts too, and it is the one that was measured.** 25 runs of a
    // real suite moved three tests at 00:00 UTC while the machine's local clock read 01:55 → 02:02
    // and never changed day. These are explicit `Z` instants, so the UTC days differ by construction
    // and this holds in every timezone — including the UTC runners CI uses, where it would otherwise
    // be indistinguishable from the local check above.
    expect(day("2026-09-21T23:55:03.000Z", "2026-09-22T00:02:23.000Z")).toBe(true);

    // Neither frame moves. **A one-minute window at local noon is the only shape that is safe in
    // every timezone**, and that is a fact about the problem rather than about this test: local
    // midnight is twelve hours away, and UTC midnight can coincide with an endpoint but never fall
    // strictly inside. An eleven-hour same-local-day gap — what this line used to assert — *does*
    // cross UTC in the far-eastern offsets, which is the defect, not a flaw in the assertion.
    const noon = new Date(2026, 8, 19, 12, 0, 0);
    const noonPlus = new Date(noon.getTime() + 60_000);
    expect(day(noon.toISOString(), noonPlus.toISOString())).toBe(false);
    expect(day(noon.toISOString(), noon.toISOString())).toBe(false);
    // A verdict written before ADR-0069 cannot answer, and `false` would be claiming that it had.
    expect(day(null as unknown as string, iso(9, 0, 19))).toBe(null);
    expect(crossesCalendarDay(ChangeVerdict.parse(specExamples().get("ChangeVerdict")))).toBe(false);
  });

  it("keeps null meaning `written before the field existed`, not `this machine could not be asked`", () => {
    // `--resume` and every analysis script read verdicts from before Phase 12, so the fields default.
    // The two nulls are different sentences and a reader has to be able to tell them apart.
    const { baseline_captured_at: _a, verified_at: _b, machine: _c, ...older } =
      specExamples().get("ChangeVerdict") as Record<string, unknown>;
    const legacy = ChangeVerdict.parse(older);
    expect(legacy.machine).toBe(null);
    expect(crossesCalendarDay(legacy)).toBe(null);
    expect(swapGrowthGb(legacy.machine)).toBe(null);

    const unaskable = ChangeVerdict.parse({
      ...older,
      machine: {
        before: { pressure: "unknown", free_gb: null, swap_gb: null, compressed_gb: null },
        after: { pressure: "unknown", free_gb: null, swap_gb: null, compressed_gb: null },
      },
    });
    expect(unaskable.machine).not.toBe(null);
    expect(swapGrowthGb(unaskable.machine)).toBe(null);
  });

  it("measures swap as a delta, because a level cannot separate the measured false negative", () => {
    // ADR-0066's amendment: the suite reaches `warn` unaided on this hardware, so the level is the same
    // in both of these. Swap is not — flat when the identical bytes survived, climbing when they did not.
    const sample = (swap: number) => ({ pressure: "warn" as const, free_gb: 7.1, swap_gb: swap, compressed_gb: 14.2 });
    expect(swapGrowthGb({ before: sample(2.5), after: sample(2.6) })).toBeCloseTo(0.1, 5);
    expect(swapGrowthGb({ before: sample(5.3), after: sample(6.1) })).toBeCloseTo(0.8, 5);
  });

  it("takes strictness flags as an allowlist, not as free text (ADR-0063)", () => {
    // ADR-0063 condition 1 is that no file in the project changes — a flag, never an edited tsconfig.
    // A free-text flag list satisfies that and breaks a different rule: `--noEmit false` makes the
    // compile stage write into the sandbox and `-p` re-points the whole program, either of which stops
    // `compile_ok` being a statement about the thing anyone asked about. So: bare boolean switches.
    const plan = specExamples().get("ChangePlan") as Record<string, unknown>;
    expect(ChangePlan.parse(plan).compiler_flags).toEqual([]);
    expect(ChangePlan.parse({ ...plan, compiler_flags: ["--strictNullChecks"] }).compiler_flags)
      .toEqual(["--strictNullChecks"]);
    for (const bad of ["--noEmit", "-p", "--project", "tsconfig.strict.json", "--strictNullChecks=false", "--outDir"]) {
      expect(ChangePlan.safeParse({ ...plan, compiler_flags: [bad] }).success).toBe(false);
    }
  });

  it("is the same gate `changeSurvives` computes, on the spec's own example", () => {
    const verdict = ChangeVerdict.parse(specExamples().get("ChangeVerdict"));
    expect(changeSurvives(verdict)).toBe(verdict.survived);
    expect(changeSurvives({ ...verdict, confined: false })).toBe(false);
  });

  it("takes an optional test_target, and does not require one (ADR-0014)", () => {
    // Swift only, and pinned here rather than in the spec example: the example is a TypeScript plan,
    // and adding a Swift-only key to it to satisfy a test would make the example lie.
    const plan = TestPlan.parse(specExamples().get("TestPlan"));
    expect(TestPlan.safeParse(plan).success).toBe(true);
    expect(TestPlan.parse({ ...plan, test_target: "SwiftFixtureTests" }).test_target).toBe("SwiftFixtureTests");
    expect(TestPlan.safeParse({ ...plan, test_target: "" }).success).toBe(false);
  });

  it("lets an unknown test framework through, and leaves the no to the verifier", () => {
    const plan = TestPlan.parse(specExamples().get("TestPlan"));
    expect(TestPlan.safeParse({ ...plan, test_framework: "ava" }).success).toBe(true);
    expect(TestPlan.safeParse({ ...plan, test_framework: "" }).success).toBe(false);
  });

  it("refuses a Candidate generated above temperature 0, on either tier", () => {
    const candidate = Candidate.parse(specExamples().get("Candidate"));
    expect(Candidate.safeParse({ ...candidate, worker: { ...candidate.worker, temperature: 0.2 } }).success).toBe(false);
    expect(Candidate.safeParse({
      ...candidate,
      worker: { ...candidate.worker, kind: "api", seed: null, temperature: 0.2 },
    }).success).toBe(false);
  });

  it("holds a local worker to its seed and lets the api tier admit it has none", () => {
    const candidate = Candidate.parse(specExamples().get("Candidate"));
    expect(Candidate.safeParse({ ...candidate, worker: { ...candidate.worker, seed: null } }).success).toBe(false);
    expect(Candidate.safeParse({ ...candidate, worker: { ...candidate.worker, kind: "api", seed: null } }).success).toBe(true);
  });
});
