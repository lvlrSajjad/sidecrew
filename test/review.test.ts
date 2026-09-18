// Which survivors reach Claude, and why. ADR-0024.
//
// Every number in here is a default with a measurement behind it, so the tests are mostly about the
// three things that would quietly break the routing: a Swift threshold that selects nothing, an audit
// sample that changes every time it is asked, and a cap that drops the longest test instead of splitting.
import { describe, it, expect } from "vitest";
import {
  auditDraw,
  buildReviewQueue,
  chooseForReview,
  DEFAULT_AUDIT_FRACTION,
  packBatches,
  REVIEW_THRESHOLD,
  thresholdFor,
  type Survivor,
} from "../src/review.js";
import { BatchResult } from "../src/schemas.js";

const survivor = (task_id: string, mutation_score: number, test_source = "expect(f(1)).toBe(2);"): Survivor => ({
  task_id,
  test_path: `.sidecrew/runs/r/tests/${task_id}.test.ts`,
  mutation_score,
  test_source,
});

describe("thresholdFor", () => {
  it("is per language, because a score does not mean the same thing in both", () => {
    // ADR-0018: a function-scoped Swift verdict is computed over one or two mutants against
    // TypeScript's six to twelve. `references/verifier.md` has said "do not use one threshold for both"
    // since Phase 3; this is where it stops being advice.
    expect(thresholdFor("typescript")).toBe(0.6);
    expect(thresholdFor("swift")).toBe(1);
    expect(REVIEW_THRESHOLD.swift).toBeGreaterThan(REVIEW_THRESHOLD.typescript);
  });

  it("selects nothing on Swift at TypeScript's threshold, which is why Swift has its own", () => {
    // Nine of the fifteen survivable Swift fixture functions have exactly one mutant, so a Swift
    // survivor scores 1.00 by construction. 0.6 there is a router wired to no destination.
    const swiftSurvivors = [survivor("a", 1), survivor("b", 1), survivor("c", 1)];
    expect(chooseForReview(swiftSurvivors, "r", { threshold: 0.6, auditFraction: 0 })).toHaveLength(0);
    expect(chooseForReview(swiftSurvivors, "r", { threshold: thresholdFor("swift"), auditFraction: 0 })).toHaveLength(0);
    // …and one that left its single mutant alive is selected at the Swift threshold and not at 0.6.
    const withAMiss = [...swiftSurvivors, survivor("d", 0.67)];
    expect(chooseForReview(withAMiss, "r", { threshold: 0.6, auditFraction: 0 })).toHaveLength(0);
    expect(chooseForReview(withAMiss, "r", { threshold: 1, auditFraction: 0 }).map((i) => i.task_id)).toEqual(["d"]);
  });
});

describe("chooseForReview", () => {
  const many = Array.from({ length: 20 }, (_, i) => survivor(`f${String(i).padStart(2, "0")}:happy_path:0`, i < 3 ? 0.4 : 1));

  it("takes everything below the threshold plus a fraction of what is left", () => {
    const chosen = chooseForReview(many, "run-a", { threshold: 0.6, auditFraction: 0.1 });
    expect(chosen.filter((i) => i.reason === "below_threshold")).toHaveLength(3);
    // 10 % of the seventeen the threshold passed over, rounded up.
    expect(chosen.filter((i) => i.reason === "audit")).toHaveLength(2);
  });

  it("draws the audit from what the threshold did not already select", () => {
    const chosen = chooseForReview(many, "run-a", { threshold: 0.6, auditFraction: 0.1 });
    const audited = chosen.filter((i) => i.reason === "audit");
    // Otherwise the fraction re-selects tests that were going anyway and buys no new coverage.
    expect(audited.every((i) => i.mutation_score >= 0.6)).toBe(true);
    expect(new Set(chosen.map((i) => i.task_id)).size).toBe(chosen.length);
  });

  it("asks about the same tests every time, because a fresh sample per call is not a sample", () => {
    // Determinism is non-negotiable #4's subject, and `Math.random` here would mean `sidecrew review`
    // on a finished run audits different survivors each time it is called.
    const once = chooseForReview(many, "run-a", { threshold: 0.6 }).map((i) => i.task_id);
    const twice = chooseForReview([...many].reverse(), "run-a", { threshold: 0.6 }).map((i) => i.task_id);
    expect(twice).toEqual(once);
    // A different run draws a different sample: the id carries the timestamp.
    const other = chooseForReview(many, "run-b", { threshold: 0.6 }).map((i) => i.task_id);
    expect(other).not.toEqual(once);
  });

  it("draws at least one when the fraction is not zero, and none when it is", () => {
    // Ceil, so a six-survivor run does not silently audit nothing — those are the runs nobody checks.
    const six = many.slice(0, 6).map((s) => ({ ...s, mutation_score: 1 }));
    expect(chooseForReview(six, "r", { threshold: 0.6, auditFraction: 0.1 })).toHaveLength(1);
    expect(chooseForReview(six, "r", { threshold: 0.6, auditFraction: 0 })).toHaveLength(0);
  });

  it("reads weakest first", () => {
    const chosen = chooseForReview(
      [survivor("c", 0.5), survivor("a", 0.1), survivor("b", 0.3)],
      "r",
      { threshold: 0.6, auditFraction: 0 },
    );
    expect(chosen.map((i) => i.mutation_score)).toEqual([0.1, 0.3, 0.5]);
  });

  it("defaults the audit fraction to one in ten", () => {
    expect(DEFAULT_AUDIT_FRACTION).toBe(0.1);
  });
});

describe("auditDraw", () => {
  it("is a stable number in [0, 1) for one run and one task", () => {
    const a = auditDraw("run-a", "f:happy_path:0");
    expect(a).toBe(auditDraw("run-a", "f:happy_path:0"));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
    expect(a).not.toBe(auditDraw("run-b", "f:happy_path:0"));
  });

  it("spreads, rather than clustering at one end", () => {
    const draws = Array.from({ length: 200 }, (_, i) => auditDraw("run", `t${i}`));
    const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
    expect(mean).toBeGreaterThan(0.4);
    expect(mean).toBeLessThan(0.6);
  });
});

describe("packBatches", () => {
  const item = (id: string, tokens: number) => ({
    task_id: id,
    mutation_score: 0.5,
    reason: "below_threshold" as const,
    test_path: `${id}.ts`,
    test_source: "",
    estimated_tokens: tokens,
  });

  it("fills a batch up to the cap and then starts another", () => {
    const batches = packBatches([item("a", 40), item("b", 40), item("c", 40)], 100);
    expect(batches.map((b) => b.items.map((i) => i.task_id))).toEqual([["a", "b"], ["c"]]);
    expect(batches[0]?.estimated_tokens).toBe(80);
  });

  it("gives an oversized item its own batch rather than dropping it", () => {
    // Silently omitting the longest survivor omits exactly the one most likely to be doing something odd.
    const batches = packBatches([item("a", 40), item("huge", 500), item("b", 40)], 100);
    expect(batches.map((b) => b.items.map((i) => i.task_id))).toEqual([["a"], ["huge"], ["b"]]);
    expect(batches[1]?.estimated_tokens).toBe(500);
  });

  it("keeps the order it was given, so a batch still reads weakest first", () => {
    const batches = packBatches([item("a", 10), item("b", 10)], 1000);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.items.map((i) => i.task_id)).toEqual(["a", "b"]);
  });
});

describe("buildReviewQueue", () => {
  const result = BatchResult.parse({
    run_id: "2026-09-14T10-31-02Z-strings",
    plan: "plans/strings/test_plan.json",
    config: { worker_kind: "local", worker_model: "m", concurrency: 1, retry: 1 },
    stats: {
      tasks: 4, survived: 4, retried: 0, escalated: 0,
      funnel: { compiled: 4, passed: 4, killed_ge_1: 4, non_tautological: 4 },
      latency_ms: { median: 1, p90: 1 }, peak_rss_mb: 0,
      claude_tokens: { planning: 0, workers: 0, review: null },
    },
    survivors: [
      { task_id: "a:happy_path:0", test_path: "a.test.ts", mutation_score: 0.2 },
      { task_id: "b:happy_path:0", test_path: "b.test.ts", mutation_score: 0.9 },
      { task_id: "c:happy_path:0", test_path: "c.test.ts", mutation_score: 1 },
      { task_id: "d:happy_path:0", test_path: "d.test.ts", mutation_score: 1 },
    ],
    escalations: [],
  });

  const readTest = async (path: string): Promise<string> => `// ${path}\nexpect(1).toBe(1);`;

  it("counts what it routed and what it did not", async () => {
    const queue = await buildReviewQueue(result, "typescript", { readTest });
    expect(queue.language).toBe("typescript");
    expect(queue.threshold).toBe(0.6);
    expect(queue.counts.survivors).toBe(4);
    expect(queue.counts.below_threshold).toBe(1);
    expect(queue.counts.audit).toBe(1);
    expect(queue.counts.not_reviewed).toBe(2);
    expect(queue.counts.below_threshold + queue.counts.audit + queue.counts.not_reviewed).toBe(4);
  });

  it("carries the test source, because that is the thing being reviewed", async () => {
    const queue = await buildReviewQueue(result, "typescript", { readTest });
    const item = queue.batches[0]?.items[0];
    expect(item?.test_source).toContain("expect(1).toBe(1);");
    expect(item?.estimated_tokens).toBeGreaterThan(0);
  });

  it("survives a survivor whose test file is gone rather than failing the whole queue", async () => {
    // The tests are written under `.sidecrew/runs/<id>/tests/` and that directory outlives nothing in
    // particular. An unreadable one is an empty review item, not a crashed review.
    const queue = await buildReviewQueue(result, "typescript", { readTest: async () => { throw new Error("ENOENT"); } });
    expect(queue.counts.below_threshold).toBe(1);
    expect(queue.batches[0]?.items[0]?.test_source).toBe("");
  });

  it("routes a Swift run by the Swift threshold without being told twice", async () => {
    const queue = await buildReviewQueue(result, "swift", { readTest, auditFraction: 0 });
    expect(queue.threshold).toBe(1);
    // Three of the four are under 1.00 here, which on Swift means they left a mutant of one or two alive.
    expect(queue.counts.below_threshold).toBe(2);
  });
});
