// Which survivors Claude actually reads, and in what batches (ADR-0024).
//
// Survival is a filter, not an endorsement (ADR-0006): a test that pins today's wrong answer kills every
// mutant, and Phase 6 produced the example rather than the hypothetical — Haiku survived
// `truncate:boundary` by never asserting the boundary the fixture's planted off-by-one lives on. So the
// mutation score routes, and a sample of everything else is read anyway, because a router that only ever
// looks where it expects trouble never finds out it is wrong.
//
// Three rules in here, none of them arbitrary:
//
//   * **The threshold is per language.** A function-scoped Swift verdict is computed over one or two
//     mutants against TypeScript's six to twelve (ADR-0018), so one number cannot mean the same thing in
//     both. `verifier.md` has said "do not use one threshold for both" since Phase 3; this is where that
//     stops being advice.
//   * **The audit sample is drawn deterministically.** "Random 10 %" from `Math.random` means
//     `sidecrew review` on a finished run asks about different tests every time it is called, which is
//     the opposite of what non-negotiable #4 is for. The draw is a hash of `run_id` + `task_id`.
//   * **The cap splits, it never drops.** An item over the cap on its own gets a batch to itself. Silently
//     omitting the longest survivor would omit exactly the one most likely to be doing something odd.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { estimateTokens } from "./prompt.js";
import { ReviewQueue, type BatchResult, type Language, type ReviewItem } from "./schemas.js";

/**
 * Below this, a survivor is read. Per language, and both numbers come from a measured distribution
 * rather than from taste:
 *
 * - **TypeScript 0.6**, the Phase 7 prompt's default. Phase 6's C2 survivors have a median score of 1.00
 *   over six-to-twelve mutants, so 0.6 selects a genuine tail — a test that left nearly half the mutants
 *   of its own function alive — rather than a third of the run.
 * - **Swift 1.0**, because 0.6 there selects *nothing*. Nine of the fifteen survivable fixture functions
 *   have exactly one mutant (ADR-0018), so a Swift survivor's score is 1.00 by construction whenever the
 *   denominator is 1, and the measured median is 1.00. A threshold below that is inert. At 1.0 the rule
 *   reads "it left a mutant alive out of the one or two it had", which is the strongest signal a
 *   four-operator mutation run can give — and the audit sample covers the rest.
 *
 * Both are defaults. `--threshold` overrides either, and the queue records what was used.
 */
export const REVIEW_THRESHOLD: Record<Language, number> = {
  typescript: 0.6,
  swift: 1.0,
  python: 0.6,
  kotlin: 0.6,
};

/** One in ten of the survivors the threshold passed over. The prompt's number, and it is a sample size. */
export const DEFAULT_AUDIT_FRACTION = 0.1;

/**
 * The per-batch input ceiling, in estimated tokens.
 *
 * A survivor is a test file — the fixture's run at 150–400 completion tokens each — so this is room for
 * roughly thirty of them, which is more than any single module produces. It exists for the repo that
 * plans two hundred functions: one review call carrying every survivor is a call whose later items get
 * read with whatever attention is left.
 */
export const DEFAULT_MAX_BATCH_TOKENS = 12_000;

export interface ReviewOpts {
  threshold?: number;
  auditFraction?: number;
  maxBatchTokens?: number;
}

/**
 * A stable number in [0, 1) for one survivor of one run.
 *
 * sha-256 of `run_id:task_id`, first 52 bits over 2^52 — a hash rather than a sequence, so the draw does
 * not depend on how many survivors there were or what order they arrived in. Re-running `sidecrew review`
 * on a finished run therefore asks about the same tests; re-running the *batch* draws afresh, because the
 * run id carries the timestamp.
 */
export const auditDraw = (runId: string, taskId: string): number => {
  const digest = createHash("sha256").update(`${runId}:${taskId}`, "utf8").digest();
  return Number(digest.readBigUInt64BE(0) >> 12n) / 2 ** 52;
};

export interface Survivor {
  task_id: string;
  test_path: string;
  mutation_score: number;
  test_source: string;
}

/**
 * Which survivors go to review: everything below the threshold, plus an audit fraction of the rest.
 *
 * The audit is drawn from the survivors the threshold did **not** select, so the fraction buys new
 * coverage rather than re-selecting what was already going. Score ascending — the weakest test is the one
 * worth reading first.
 */
export function chooseForReview(survivors: Survivor[], runId: string, opts: ReviewOpts & { threshold: number }): ReviewItem[] {
  const fraction = opts.auditFraction ?? DEFAULT_AUDIT_FRACTION;

  const below = survivors.filter((s) => s.mutation_score < opts.threshold);
  const rest = survivors.filter((s) => s.mutation_score >= opts.threshold);

  // Ceil, so a fraction above 0 always draws at least one: on a run of six survivors, a 10 % sample that
  // rounds to zero is a sample that never happens, and the audit exists precisely for the runs nobody
  // thinks need it.
  const wanted = fraction <= 0 ? 0 : Math.min(rest.length, Math.ceil(fraction * rest.length));
  const audit = [...rest]
    .sort((a, b) => auditDraw(runId, a.task_id) - auditDraw(runId, b.task_id))
    .slice(0, wanted);
  const drawn = new Set(audit.map((s) => s.task_id));

  const item = (s: Survivor): ReviewItem => ({
    task_id: s.task_id,
    mutation_score: s.mutation_score,
    reason: drawn.has(s.task_id) ? "audit" : "below_threshold",
    test_path: s.test_path,
    test_source: s.test_source,
    estimated_tokens: estimateTokens(s.test_source),
  });

  return [...below, ...audit]
    .map(item)
    .sort((a, b) => a.mutation_score - b.mutation_score || a.task_id.localeCompare(b.task_id));
}

/** Greedy, in the order given, so a batch keeps the ascending-score reading order the caller chose. */
export function packBatches(items: ReviewItem[], maxTokens: number): { estimated_tokens: number; items: ReviewItem[] }[] {
  const batches: { estimated_tokens: number; items: ReviewItem[] }[] = [];
  for (const item of items) {
    const last = batches.at(-1);
    // An item that does not fit anywhere still goes somewhere: its own batch, over the cap, rather than
    // out of the queue. The cap is about attention, and dropping a survivor is about honesty.
    if (last === undefined || last.estimated_tokens + item.estimated_tokens > maxTokens) {
      batches.push({ estimated_tokens: item.estimated_tokens, items: [item] });
      continue;
    }
    last.items.push(item);
    last.estimated_tokens += item.estimated_tokens;
  }
  return batches;
}

/** The language decides the default threshold, so it is read from the plan the run names. */
export const thresholdFor = (language: Language): number => REVIEW_THRESHOLD[language];

export interface BuildQueueOpts extends ReviewOpts {
  /** Read the survivor's test file. Injected so the selection can be tested without a filesystem. */
  readTest?: (path: string) => Promise<string>;
}

/**
 * A finished `BatchResult` → the queue Claude reads.
 *
 * It reads the survivors' test files and nothing else: the candidates and the verdicts stay on disk, and
 * what reaches Claude is a test that already compiled, passed and killed a mutant (CLAUDE.md #3).
 */
export async function buildReviewQueue(result: BatchResult, language: Language, opts: BuildQueueOpts = {}): Promise<ReviewQueue> {
  const read = opts.readTest ?? ((path: string) => readFile(path, "utf8"));
  const threshold = opts.threshold ?? thresholdFor(language);
  const maxBatchTokens = opts.maxBatchTokens ?? DEFAULT_MAX_BATCH_TOKENS;

  const survivors: Survivor[] = await Promise.all(result.survivors.map(async (s) => ({
    task_id: s.task_id,
    test_path: s.test_path,
    mutation_score: s.mutation_score,
    test_source: await read(s.test_path).catch(() => ""),
  })));

  const items = chooseForReview(survivors, result.run_id, { ...opts, threshold });
  const batches = packBatches(items, maxBatchTokens);

  return ReviewQueue.parse({
    run_id: result.run_id,
    plan: result.plan,
    language,
    threshold,
    audit_fraction: opts.auditFraction ?? DEFAULT_AUDIT_FRACTION,
    max_batch_tokens: maxBatchTokens,
    counts: {
      survivors: survivors.length,
      below_threshold: items.filter((i) => i.reason === "below_threshold").length,
      audit: items.filter((i) => i.reason === "audit").length,
      not_reviewed: survivors.length - items.length,
    },
    batches,
  });
}

export const renderReviewQueue = (q: ReviewQueue): string => {
  const head = [
    `review ${q.run_id} · ${q.language}, threshold ${q.threshold} · audit ${(q.audit_fraction * 100).toFixed(0)} %`,
    `  ${q.counts.below_threshold} below threshold · ${q.counts.audit} audit · ${q.counts.not_reviewed} of ${q.counts.survivors} not reviewed`,
    `  ${q.batches.length} batch${q.batches.length === 1 ? "" : "es"}, cap ${q.max_batch_tokens} estimated tokens`,
  ];
  const rows = q.batches.flatMap((b, i) => b.items.map((item) =>
    `  ${String(i + 1).padStart(2)}  ${item.reason === "audit" ? "audit " : "low   "} ${item.mutation_score.toFixed(2)}  ${item.task_id}`));
  return [...head, ...rows].join("\n");
};
