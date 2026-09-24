// Pipeline contracts — MUST mirror docs/specs/pipeline.md.
// test/schemas.test.ts parses every ```json block of that file with the schemas below, so the two
// cannot drift: change one and the other fails.
import { z } from "zod";
// ADR-0077 option B needs the gate's own answer to "is this a test file" inside the refinement, so
// that `compile_ok`'s rule stays enforced by the schema rather than by convention (CLAUDE.md #2).
// Safe against the import-cycle hazard: `confinement.ts` imports `node:path` and a **type** from this
// file, and a type import is erased — so there is no runtime edge back.
import { isTestArtefact } from "./confinement.js";

export const ShapeKind = z.enum(["happy_path", "boundary", "error_or_throw", "async", "stateful_sequence", "property_like"]);
export type ShapeKind = z.infer<typeof ShapeKind>;

export const Language = z.enum(["typescript", "swift", "python", "kotlin"]);
export type Language = z.infer<typeof Language>;

/**
 * The frameworks sidecrew knows how to drive today. Advisory, not exhaustive — see `TestFramework`.
 */
export const KNOWN_TEST_FRAMEWORKS = ["vitest", "jest", "xctest", "swift-testing"] as const;

/**
 * Open on purpose. A closed enum here would reject a real project before the verifier ever got a
 * chance to say whether it could handle it, and the verifier — not the contract — is what actually
 * knows: it has to recognise the framework to build a run command at all, and fails loudly when it
 * cannot. Widening the contract moves that "no" to where the reason for it lives.
 */
export const TestFramework = z.string().min(1);
export type TestFramework = z.infer<typeof TestFramework>;

/**
 * Where a candidate's tokens were spent. `local` is an mlx_lm.server on localhost; `api` is the
 * fallback for machines with no room to host one (ADR-0009). The distinction is in the contract
 * rather than in a comment because the zero-worker-tokens guarantee is conditional on it.
 */
export const WorkerKind = z.enum(["local", "api"]);
export type WorkerKind = z.infer<typeof WorkerKind>;

/** How `doctor` and `sidecrew_status` describe one external capability. */
export const CapabilityStatus = z.enum(["ok", "degraded", "missing"]);
export type CapabilityStatus = z.infer<typeof CapabilityStatus>;

/** Errors are truncated, not dropped: the retry prompt carries them and a whole compiler log is not useful. */
export const MAX_ERROR_CHARS = 2048;
const ErrorText = z.string().max(MAX_ERROR_CHARS);

const NonNegInt = z.number().int().nonnegative();
const Millis = z.number().nonnegative();
const Sha = z.string().min(1);

/** The ceiling on `PlannedFunction.shapes`. See the taxonomy section of `docs/specs/pipeline.md`. */
export const MAX_SHAPES_PER_FUNCTION = 3;

export const TestShape = z.object({
  kind: ShapeKind,
  exemplar: z.string(),
  /**
   * The function in `module` the exemplar tests (ADR-0015). Verifying an exemplar means mutating that
   * function's lines, and nothing else in the plan says which they are — the exemplar is deliberately
   * about a function `functions[]` does not list, so `functionOfTaskId` has nothing to read. Guessing
   * would mutate the wrong lines, which is the one mistake ADR-0013 made expensive.
   */
  exemplar_function: z.string().min(1),
  rules: z.string(),
});
export type TestShape = z.infer<typeof TestShape>;

/**
 * What the worker is told about a shape: the kind and the rules.
 *
 * No exemplar *path* — it gets the exemplar's text instead — and no `exemplar_function`, which is the
 * planner's bookkeeping and would be one more name for a 7B to confuse with the function it was asked
 * about.
 */
export const WorkerShape = TestShape.omit({ exemplar: true, exemplar_function: true });
export type WorkerShape = z.infer<typeof WorkerShape>;

export const PlannedFunction = z.object({
  name: z.string().min(1),
  signature: z.string().min(1),
  source_sha: Sha,
  line_range: z.tuple([NonNegInt, NonNegInt]),
  /**
   * 1–3, and both ends are load-bearing (Phase 5, spec §Shapes). A function nobody asks a question
   * about does not belong in the plan; the fourth shape on a small pure function is where the planner
   * starts inventing questions, and every shape costs a generate → verify round. In the contract rather
   * than in the planner's prompt because the cost lands on the run, not on the planner.
   */
  shapes: z.array(ShapeKind).min(1).max(MAX_SHAPES_PER_FUNCTION),
  notes: z.string().optional(),
});
export type PlannedFunction = z.infer<typeof PlannedFunction>;

export const TestPlan = z.object({
  version: z.literal(1),
  language: Language,
  module: z.string().min(1),
  test_framework: TestFramework,
  meta: z.object({
    planner_model: z.string().min(1),
    planner_tokens: NonNegInt,
    created: z.string().datetime(),
  }),
  /**
   * Swift only, and optional (ADR-0014). A SwiftPM package with one test target needs no answer — the
   * verifier takes the only one. A package with several cannot be guessed at, and the planner is the
   * only component that has read the package, so it is the only one that can name the target without
   * guessing. Absent, `verifySwift` refuses a multi-target package rather than picking; meaningless
   * but not illegal on a TypeScript plan, because a language-conditional required field would make
   * every future language pay for Swift's problem.
   */
  test_target: z.string().min(1).optional(),
  shapes: z.array(TestShape).min(1),
  functions: z.array(PlannedFunction).min(1),
});
export type TestPlan = z.infer<typeof TestPlan>;

export const WorkerTask = z.object({
  task_id: z.string().min(1),
  language: Language,
  test_framework: TestFramework,
  function: z.object({
    name: z.string().min(1),
    signature: z.string().min(1),
    source: z.string().min(1),
    source_sha: Sha,
  }),
  imports_hint: z.string(),
  shape: WorkerShape,
  exemplar_source: z.string(),
  /** task_id of the first attempt. Set only on the single retry. */
  retry_of: z.string().nullable(),
  previous_error: ErrorText.nullable(),
});
export type WorkerTask = z.infer<typeof WorkerTask>;

/**
 * Who produced a candidate and under what conditions — shared by both workloads (ADR-0047).
 *
 * One stamp rather than two copies, because the tier guarantee is attached to it: `seedIsRecorded`
 * below is the rule that a `local` candidate must say which seed it ran with, and a second workload
 * that quietly omitted it would be a second place for non-negotiable #4 to be false.
 */
const WorkerStamp = z.object({
  kind: WorkerKind,
  model: z.string().min(1),
  revision: z.string(),
  // Determinism is a non-negotiable, not a default: a candidate produced at temperature > 0 is not
  // reproducible and its verdict says nothing about the model. Both tiers can honour temperature 0.
  temperature: z.literal(0),
  /** null only on the api tier, which offers no seed. See the refinement below. */
  seed: z.number().int().nullable(),
});

/**
 * A local worker has no excuse: same seed, same output, or the bench in Phase 1 is measuring noise.
 * The API tier cannot offer one, and pretending otherwise by writing a seed we never sent would make
 * the record say something untrue.
 */
const seedIsRecorded = (c: { worker: z.infer<typeof WorkerStamp> }, ctx: z.RefinementCtx): void => {
  if (c.worker.kind === "local" && c.worker.seed === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["worker", "seed"], message: "a local worker must record the seed it ran with" });
  }
};

const CandidateFields = z.object({
  task_id: z.string().min(1),
  worker: WorkerStamp,
  test_source: z.string(),
  usage: z.object({ prompt_tokens: NonNegInt, completion_tokens: NonNegInt }),
  timing: z.object({ ttft_ms: Millis, wall_ms: Millis }),
});

export const Candidate = CandidateFields.superRefine(seedIsRecorded);
export type Candidate = z.infer<typeof CandidateFields>;

export const MutationResult = z.object({
  /**
   * `(killed + timeout) / (killed + timeout + survived + no_coverage)`, the mutation-testing standard,
   * and 0 when nothing was mutated. Equivalent mutants make a low score a review signal rather than a
   * failure — survival asks only for `killed ≥ 1`, and asks for a real kill (ADR-0006, ADR-0012).
   */
  score: z.number().min(0).max(1),
  killed: NonNegInt,
  survived: NonNegInt,
  timeout: NonNegInt,
  no_coverage: NonNegInt,
  killed_ids: z.array(z.string()),
});
export type MutationResult = z.infer<typeof MutationResult>;

export const Stage = z.enum(["compile", "pass", "mutation", "done"]);
export type Stage = z.infer<typeof Stage>;

const VerdictFields = z.object({
  task_id: z.string().min(1),
  stage_reached: Stage,
  survived: z.boolean(),
  compile_ok: z.boolean(),
  pass_ok: z.boolean(),
  tautological: z.boolean(),
  /** null when the mutation stage never ran. */
  mutation: MutationResult.nullable(),
  error: ErrorText.nullable(),
  /** A key is present only for a stage that actually ran. */
  timing_ms: z.object({ compile: Millis.optional(), pass: Millis.optional(), mutation: Millis.optional() }),
});

/** Survive ⇔ compiles ∧ passes ∧ kills ≥ 1 mutant ∧ non-tautological. The one rule the whole project rests on. */
export const survives = (v: z.infer<typeof VerdictFields>): boolean =>
  v.compile_ok && v.pass_ok && !v.tautological && (v.mutation?.killed ?? 0) >= 1;

// Enforced as an iff rather than computed on construction, so a Verdict that reached us from disk, from
// a worker run or from a future verifier cannot quietly claim a survival its own fields don't support.
export const Verdict = VerdictFields.superRefine((v, ctx) => {
  if (v.survived !== survives(v)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["survived"],
      message: `survived must equal compile_ok ∧ pass_ok ∧ ¬tautological ∧ mutation.killed ≥ 1 (here: ${survives(v)})`,
    });
  }
});
export type Verdict = z.infer<typeof VerdictFields>;

const BatchResultFields = z.object({
  run_id: z.string().min(1),
  plan: z.string().min(1),
  config: z.object({
    worker_kind: WorkerKind,
    worker_model: z.string().min(1),
    concurrency: z.number().int().positive(),
    retry: NonNegInt,
  }),
  stats: z.object({
    tasks: NonNegInt,
    survived: NonNegInt,
    retried: NonNegInt,
    escalated: NonNegInt,
    funnel: z.object({
      compiled: NonNegInt,
      passed: NonNegInt,
      killed_ge_1: NonNegInt,
      non_tautological: NonNegInt,
    }),
    latency_ms: z.object({ median: Millis, p90: Millis }),
    peak_rss_mb: z.number().nonnegative(),
    claude_tokens: z.object({
      planning: NonNegInt,
      /** Zero whenever `config.worker_kind` is `local` — enforced below, not merely intended. */
      workers: NonNegInt,
      /** null until the survivors have been reviewed. */
      review: NonNegInt.nullable(),
    }),
  }),
  survivors: z.array(z.object({
    task_id: z.string().min(1),
    test_path: z.string().min(1),
    mutation_score: z.number().min(0).max(1),
  })),
  escalations: z.array(z.object({
    task_id: z.string().min(1),
    attempts: z.array(z.object({ error: ErrorText })),
  })),
});

/**
 * The zero-worker-tokens guarantee, now conditional rather than absolute (ADR-0009).
 *
 * It used to be `z.literal(0)`, which made a paid worker unrepresentable — the strongest possible
 * statement, and wrong once 16 GB machines fall back to the API tier. Deleting the literal without
 * replacing it would have quietly downgraded the project's headline claim to a comment, so the
 * guarantee is re-stated where it is still true: a local run that billed Claude for worker inference
 * is a bug, and does not serialise.
 */
export const BatchResult = BatchResultFields.superRefine((b, ctx) => {
  if (b.config.worker_kind === "local" && b.stats.claude_tokens.workers !== 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["stats", "claude_tokens", "workers"],
      message: "a local worker cannot spend Claude tokens — it is reached over http://localhost/v1",
    });
  }
  // The same guarantee from the other side, added in Phase 13 (ADR-0045 §6).
  //
  // The rule above makes a *false zero* on the local tier unrepresentable. On the api tier the lie
  // runs the other way and is the more likely one: a run that generated candidates and reports zero
  // worker tokens has either lost the API's usage fields or estimated them, and Phase 13 §5.0.2 voids
  // exactly that run — "`claude_tokens.workers` is what Anthropic billed, taken from the API's usage
  // fields rather than estimated". Without this, a broken accounting path produces a free-looking api
  // run and nothing notices.
  if (b.config.worker_kind === "api" && b.stats.survived + b.stats.escalated > 0 && b.stats.claude_tokens.workers === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["stats", "claude_tokens", "workers"],
      message: `an api run that produced ${b.stats.survived + b.stats.escalated} outcome(s) cannot have cost 0 worker tokens — this is either lost or estimated usage, and the tier's whole measurement is its price`,
    });
  }
});
export type BatchResult = z.infer<typeof BatchResultFields>;

export const StatusReport = z.object({
  worker: z.object({
    up: z.boolean(),
    base_url: z.string().url(),
    /** null while the worker is down. */
    model: z.string().nullable(),
    revision: z.string().nullable(),
  }),
  memory: z.object({ total_gb: z.number().positive(), free_gb: z.number().nonnegative() }),
  /** Open key set: every row `doctor` knows about. */
  capabilities: z.record(z.string(), CapabilityStatus),
});
export type StatusReport = z.infer<typeof StatusReport>;

export const ValidationIssue = z.object({ code: z.string().min(1), message: z.string().min(1), where: z.string() });
export type ValidationIssue = z.infer<typeof ValidationIssue>;

export const ValidationReport = z.object({
  plan: z.string().min(1),
  valid: z.boolean(),
  checked: z.object({ functions: NonNegInt, shapes: NonNegInt, exemplars: NonNegInt }),
  errors: z.array(ValidationIssue),
  warnings: z.array(ValidationIssue),
  /** Function names whose source_sha no longer matches the module on disk. */
  stale: z.array(z.string()),
}).superRefine((r, ctx) => {
  if (r.valid !== (r.errors.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["valid"], message: "valid must equal errors.length === 0" });
  }
});
export type ValidationReport = z.infer<typeof ValidationReport>;

// ── Phase 7: the two queues Claude reads ──────────────────────────────────────────────────────────

/**
 * One task that ran out of attempts, as a line of `.sidecrew/runs/<id>/escalations.jsonl`.
 *
 * Written when the task gives up rather than assembled from `result.json` at the end (ADR-0023): a run
 * that dies has still spent those attempts, and the queue is the record of what they bought.
 */
export const Escalation = z.object({
  task_id: z.string().min(1),
  /** `shouldRetry`'s sentence for the last attempt — why this stopped, in the words the run log used. */
  reason: z.string().min(1),
  /** Newest last. One entry for a failure the retry rule refused, two for everything else. */
  attempts: z.array(z.object({
    task_id: z.string().min(1),
    /**
     * null when the task threw rather than returning a verdict — the worker went away, or the verifier
     * crashed. There is no stage to name: nothing ran. Calling it `compile` would read as "it did not
     * compile", which is a different problem with a different fix.
     */
    stage_reached: Stage.nullable(),
    error: ErrorText,
  })).min(1),
  escalated_at: z.string().datetime(),
});
export type Escalation = z.infer<typeof Escalation>;

/**
 * What `sidecrew escalate` hands to Claude: the queue, joined back to the prompts the worker had.
 *
 * `task` is the first attempt's `WorkerTask` verbatim — the same function source, exemplar and rules the
 * local model was given. Claude is being asked the question the worker could not answer, so it gets the
 * question rather than a summary of it.
 */
export const EscalationBatch = z.object({
  run_id: z.string().min(1),
  plan: z.string().min(1),
  language: Language,
  test_framework: TestFramework,
  /** Which model the run recommends for these; Sonnet unless the caller says otherwise. */
  suggested_model: z.string().min(1),
  items: z.array(Escalation.extend({ task: WorkerTask })),
});
export type EscalationBatch = z.infer<typeof EscalationBatch>;

/** Why one survivor is in front of Claude: it scored low, or it was drawn for the audit. */
export const ReviewReason = z.enum(["below_threshold", "audit"]);
export type ReviewReason = z.infer<typeof ReviewReason>;

export const ReviewItem = z.object({
  task_id: z.string().min(1),
  mutation_score: z.number().min(0).max(1),
  reason: ReviewReason,
  test_path: z.string().min(1),
  test_source: z.string(),
  /** `estimateTokens` over `test_source`, and an estimate — the label is in `src/prompt.ts`. */
  estimated_tokens: NonNegInt,
});
export type ReviewItem = z.infer<typeof ReviewItem>;

/**
 * Survivors routed to review, batched under a token cap (ADR-0024).
 *
 * Score ascending within a batch, because the weakest test is the one worth reading first and a model
 * that runs out of attention should run out of it at the end.
 */
export const ReviewQueue = z.object({
  run_id: z.string().min(1),
  plan: z.string().min(1),
  language: Language,
  /** Per language, never shared: a Swift score is computed over one or two mutants (ADR-0018, ADR-0024). */
  threshold: z.number().min(0).max(1),
  audit_fraction: z.number().min(0).max(1),
  max_batch_tokens: z.number().int().positive(),
  counts: z.object({ survivors: NonNegInt, below_threshold: NonNegInt, audit: NonNegInt, not_reviewed: NonNegInt }),
  batches: z.array(z.object({ estimated_tokens: NonNegInt, items: z.array(ReviewItem).min(1) })),
});
export type ReviewQueue = z.infer<typeof ReviewQueue>;

// ── Phase 10: workload #2a, behaviour-preserving code changes ─────────────────────────────────────
//
// The gate is the project's own test suite plus `tsc` (ADR-0031 option A), and everything below exists
// to make it checkable rather than merely stated. ADR-0046 is the sandbox that keeps the tests,
// ADR-0047 the contract, ADR-0048 the gate and the seven cheap ways to pass it that are blocked by
// name. Nothing here is mutation-shaped: `Verdict.mutation` means nothing to a code change.

/** The ceiling on a task's `files` unless the plan says otherwise — the owner's "5–10" (ADR-0044 §1). */
export const DEFAULT_MAX_GROUP_SIZE = 10;

/**
 * How far the pipeline got. Confinement comes **before** apply on purpose (ADR-0047): it is a pure
 * function of the task's sources and the candidate's, so nothing is written to a sandbox until it has
 * passed, and there is no partially-applied state to reason about.
 */
export const ChangeStage = z.enum(["generate", "confinement", "apply", "compile", "tests", "done"]);
export type ChangeStage = z.infer<typeof ChangeStage>;

/**
 * The cheap ways to pass this gate, each blocked by name (ADR-0048).
 *
 * Names rather than prose because two readers branch on them: the Phase 11 funnel counts each one, so
 * the report says *which* cheap pass a local model reached for, and the Phase 12 correction round
 * writes its note from the rule rather than from the diff (ADR-0044 §4 rule 1).
 */
export const ConfinementRule = z.enum([
  /** An edit to a file the task does not list. */
  "path_outside_task",
  /** An edit to tsconfig, package.json, a lockfile, or a linter/runner/bundler config — even a listed one. */
  "build_config_edited",
  /** An edit to a test file, `__tests__`, `__mocks__` or a snapshot — the gate's own instrument (ADR-0046). */
  "test_file_edited",
  /** A new `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` or `eslint-disable`. */
  "suppression_added",
  /** A new `as any`, `: any` or `<any>` — the type-shaped version of the same move. */
  "any_escape_added",
  /** More code lines removed than the task's `max_deleted_lines` allows. */
  "deletion_without_replacement",
  /** A candidate that changed nothing: the suite is already green, so do nothing. */
  "no_edit_at_all",
  /**
   * Documentation the ask did not call for — removed, or reworded at constant volume (ADR-0054).
   *
   * **The eighth cheap way past the gate, and the last one measured rather than imagined.** A comment
   * is neither a type nor a test, so `confined ∧ compile_ok ∧ tests_ok` answers "yes" to a candidate
   * that silently deleted the docblock explaining why a fix is safe. Phase 11 measured it on both
   * inputs where the worker could be watched, and it was the **only** behaviour separating the local
   * tier from a frontier control in the entire phase.
   *
   * Exempt on a `dead_code` ask: removing code that nothing reaches removes the comments explaining
   * it, and a "remove the stale comments" ask is already that shape — so the legitimate case needs no
   * budget field of its own.
   */
  "documentation_changed",
  /**
   * A symbol-scoped task's answer changed something outside the declarations it names (ADR-0086 §4).
   *
   * Decided by a revert: put the named declarations back as they were, and the file must be the
   * original byte for byte. A whole-file answer is judged the same way, so the answer form is no way
   * around it. It also fires on a returned symbol the task does not name, or one returned twice.
   */
  "edit_outside_symbol",
  /**
   * A symbol-scoped task's answer no longer declares a name the task names exactly once. It was renamed,
   * split, deleted, or the compiler that would find it could not be loaded (fails closed, ADR-0086 §4).
   */
  "symbol_not_redeclared",
]);
export type ConfinementRule = z.infer<typeof ConfinementRule>;

/**
 * What the ask is, coarsely — and it is a contract field rather than a note because **the shape is the
 * caveat**.
 *
 * Phase 11's coverage hole is about 1 survivor in 5 whose changed lines no test that ran executed, and
 * how much that weakens a result depends entirely on this enum: for a `rename` `tsc` proves completeness
 * and is a reasonable oracle where no test runs, while for a `null_guard` or an `api_migration` the
 * compiler cannot tell you the behaviour survived. Every rate in this repository so far is for `rename`
 * and `unused_import`, and quoting one for the others would be the fixture-overstates-by-2x error again.
 *
 * Phase 11b §4.4 refuses to apply its verdict at all unless half the tasks are the harder three, so the
 * planner has to be able to say which it wrote.
 */
export const ChangeShape = z.enum([
  /** Rename a symbol and every reference to it. `tsc` proves completeness. */
  "rename",
  /** Remove an import nothing uses. The other shape every measured number so far is about. */
  "unused_import",
  /** Add a null/undefined check the types now demand. The compiler cannot prove behaviour survived. */
  "null_guard",
  /** Move call sites from a deprecated API to its replacement. */
  "api_migration",
  /** Delete code nothing reaches. The one shape whose ask needs a deletion budget above zero. */
  "dead_code",
]);
export type ChangeShape = z.infer<typeof ChangeShape>;

/**
 * Something true of a candidate that the gate does **not** decide on (ADR-0057).
 *
 * The distinction from `ConfinementBreach` is the whole point and it is load-bearing: a breach makes
 * `confined` false and kills the candidate, an observation changes nothing about its fate. ADR-0048's
 * rule is untouched, so a run carrying observations is still comparable with Phase 11's.
 *
 * It exists because the only measured quality gap between the local tier and the control — unrequested
 * cosmetic edits, 4 of 23 sampled survivors against 0 of 23 (ADR-0054) — is invisible to `survives ⇔
 * confined ∧ compile_ok ∧ tests_ok`, and a correction may only be written from the verdict (ADR-0044 §4
 * rule 1). Without a field here there is nothing to write one from short of reading the diff, which is
 * the line this design does not cross.
 */
export const ObservationKind = z.enum([
  /** Comment lines removed that the ask did not call for. */
  "comment_lines_removed",
  /**
   * Comment *text* changed while the count stayed the same — a reword (ADR-0068).
   *
   * ADR-0057 shipped a line delta and predicted this gap in its own "not decided" section. Phase 11b
   * then measured it: the local 7B's single divergence from Opus across 19 real tasks was rewording a
   * doc comment to match a renamed symbol, and **all 19 verdicts carried `observations: []`**. Phase 11
   * had seen the same worker do the same thing to the same word. Sensitivity 0/1 on the only case in
   * the dataset, on the model's one reproducible signature behaviour.
   */
  "comment_text_changed",
  /** Blank lines added or removed beyond the edit itself — project-b's stray line. */
  "whitespace_churn",
  /**
   * **A type error the change introduced into a test file — ADR-0077 option B.**
   *
   * Demoted from a `compile_ok` failure to this. The measured case: adding the null guard
   * `--strictNullChecks` demands narrows a type, the narrowed type propagates into a fixture or a
   * mock, and the gate forbids editing test files because tests **are** the gate (ADR-0046,
   * ADR-0048). There was no legal edit that passed, whatever wrote it — the errors that sank probe 1's
   * tasks were in a test file in **21 of 21** cases and in non-test source in **0**.
   *
   * **Recorded rather than ignored.** `compile_ok` stops depending on it; nothing else does. A reader,
   * a correction and every analysis script still see exactly which files gained what.
   */
  "test_type_error_demoted",
]);
export type ObservationKind = z.infer<typeof ObservationKind>;

export const ChangeObservation = z.object({
  kind: ObservationKind,
  file: z.string().min(1),
  /** The count, or the line. What a correction quotes — never the diff. */
  detail: z.string().min(1),
});
export type ChangeObservation = z.infer<typeof ChangeObservation>;

export const ConfinementBreach = z.object({
  rule: ConfinementRule,
  file: z.string().min(1),
  /** The offending line, or the count that broke the budget. What a correction quotes. */
  detail: z.string().min(1),
});
export type ConfinementBreach = z.infer<typeof ConfinementBreach>;

/** `tsc` errors, project-wide and per file. The per-file half is ADR-0044 §1's free per-file reporting. */
export const ErrorCounts = z.object({
  total: NonNegInt,
  /** Only files that have at least one error. Paths are posix, relative to the project root. */
  by_file: z.record(z.string(), NonNegInt),
});
export type ErrorCounts = z.infer<typeof ErrorCounts>;

/**
 * The project before the change, captured in the same sandbox and in the same way (ADR-0046).
 *
 * Captured once per **step**, not once per task: the existing suite is the expensive stage, and
 * ADR-0044 §2 re-captures it at a step boundary because step N+1's baseline is the project after step
 * N's survivors were applied.
 */
export const ChangeBaseline = z.object({
  project: z.string().min(1),
  captured_at: z.string().datetime(),
  errors: ErrorCounts,
  tests: z.object({
    ran: NonNegInt,
    passed: NonNegInt,
    failed: NonNegInt,
    /**
     * `<file>::<full name>` for every test that passed. The gate's rule is "every test that passed
     * **before** still passes", never "everything is green" — a project with pre-existing failures is
     * normal, and project-a has 23 suites failing on missing DB env.
     */
    passed_ids: z.array(z.string()),
  }),
  timing_ms: z.object({ compile: Millis, tests: Millis }),
});
export type ChangeBaseline = z.infer<typeof ChangeBaseline>;

/**
 * ADR-0044 §4 option B, as a budget rather than as a policy — *"a bounded number of Opus-written notes
 * per task against a per-run budget"*, and the kill switch of rule 2 is the default.
 *
 * **Everything here defaults to off.** ADR-0044 decided the round gets built and measured, not that it
 * gets switched on; whether it pays for itself is a number
 * (`experiments/correction-round/README.md` §4.2), and a default of on would be this repository
 * shipping an unmeasured mechanism it wrote a frozen rule to avoid shipping.
 */
export const CorrectionBudget = z.object({
  /** The gate-visible round: one Opus note after the mechanical retry has failed (ADR-0044 §4). */
  enabled: z.boolean().default(false),
  /** How many corrections this run may write at all. Exhausting it falls back to escalation (option A). */
  max_corrections: NonNegInt.default(0),
  /** A ceiling on Opus tokens spent writing them, so a run cannot cost more than it saves by accident. */
  max_tokens: NonNegInt.default(0),
  /**
   * The survivor case (ADR-0057): correct a candidate that **passed** but carries an observation.
   *
   * Separate from `enabled`, and off separately, because ADR-0044 §4 never contemplated it. A run that
   * asked for the gate-visible round has not asked to spend tokens on changes that already survived.
   */
  on_observations: z.boolean().default(false),
}).strict();
export type CorrectionBudget = z.infer<typeof CorrectionBudget>;

/** One task of one step: the ask, and the group of files it may touch (ADR-0044 §1). */
export const PlannedChange = z.object({
  task_id: z.string().min(1),
  ask: z.string().min(1),
  files: z.array(z.string().min(1)).min(1),
  /**
   * How many code lines this ask is allowed to remove. Default 0, and that is the point: *deleting the
   * offending line* is a cheap way to pass a type-error gate, and *removing dead code* is a real 2a
   * job. The difference is not in the diff, it is in what was asked — so the ask carries the budget.
   */
  max_deleted_lines: NonNegInt.default(0),
  /** ADR-0044 §2: an escalation here stops the run rather than letting step N+1 build on sand. */
  blocking: z.boolean().default(false),
  /**
   * What kind of change this is. Required, with no default: a planner that does not know what it is
   * asking for cannot be trusted to have checked the ask is satisfiable, and a default would quietly
   * make everything a `rename` — the shape every existing number is already about.
   */
  shape: ChangeShape,
  notes: z.string().optional(),
  /**
   * ADR-0086: the declarations this task may change, and nothing else. Absent means the task is
   * whole-file, as every task was before Phase 14c. Present means every listed file carries at least one,
   * the worker returns each declaration's new text, and the size clause is the declarations' rather than
   * the files' — which is what brings a method inside a 4,000-line service into reach (ADR-0075 option C).
   */
  symbols: z.array(z.object({
    file: z.string().min(1),
    /** `f` for a top-level declaration, `C.m` for a member of a top-level class. */
    name: z.string().regex(/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)?$/, "a symbol is `f` or `C.m`"),
  }).strict()).min(1).optional(),
}).strict();
export type PlannedChange = z.infer<typeof PlannedChange>;

/** Tasks inside a step are independent and run in parallel; the run enforces the order of steps. */
export const ChangeStep = z.object({
  name: z.string().min(1),
  tasks: z.array(PlannedChange).min(1),
}).strict();
export type ChangeStep = z.infer<typeof ChangeStep>;

/**
 * What `sidecrew fix` takes. Written by Opus — by hand in Phase 10, by the planner agent in Phase 12.
 *
 * **`strict` is load-bearing.** ADR-0044 §3 decided there is no `workers` field: Opus decides how the
 * work is cut, the machine decides how many pieces are in flight. A plan carrying one does not parse,
 * which is the difference between a decision and a sentence in a document.
 */
/**
 * Compiler strictness an experiment may add on top of the project's own configuration — ADR-0063.
 *
 * **An allowlist, and the reason it is one is the gate.** ADR-0063's first condition is that *no file
 * in the project changes*: a flag, never an edited `tsconfig.json`, because the moment a project has
 * to be modified to be verified that is a finding about sidecrew rather than a setup step. A free-text
 * flag list would satisfy that rule and break a different one — `--noEmit false` makes the type-check
 * stage write files into the sandbox, and `-p` silently re-points the whole program, either of which
 * turns `compile_ok` into a statement about something nobody asked about.
 *
 * So every entry is a **boolean strictness switch, passed bare**. No values, no project selection, no
 * emit control, enforced here rather than in a comment — a gate condition a schema cannot check is a
 * convention (CLAUDE.md #2).
 *
 * ADR-0063's fourth condition is the one to keep in mind when reading a number taken with any of these
 * set: the gate stops asking *does this preserve what the project's own compiler says* and starts
 * asking *does this satisfy a stricter compiler*. A legitimate and more valuable experiment, and a
 * different question.
 */
export const StrictnessFlag = z.enum([
  "--strict",
  "--strictNullChecks",
  "--strictFunctionTypes",
  "--strictBindCallApply",
  "--strictPropertyInitialization",
  "--noImplicitAny",
  "--noImplicitThis",
  "--noImplicitOverride",
  "--noImplicitReturns",
  "--noUnusedLocals",
  "--noUnusedParameters",
  "--noFallthroughCasesInSwitch",
  "--exactOptionalPropertyTypes",
  "--noUncheckedIndexedAccess",
  "--useUnknownInCatchVariables",
]);
export type StrictnessFlag = z.infer<typeof StrictnessFlag>;

export const ChangePlan = z.object({
  version: z.literal(1),
  language: Language,
  /** The project root: the thing with a package.json, a tsconfig, and an installed node_modules. */
  project: z.string().min(1),
  test_framework: TestFramework,
  meta: z.object({
    planner_model: z.string().min(1),
    planner_tokens: NonNegInt,
    created: z.string().datetime(),
  }),
  /** A plan field with a default, never a constant: the right number is what Phase 11 measures. */
  max_group_size: z.number().int().positive().default(DEFAULT_MAX_GROUP_SIZE),
  /** ADR-0044 §4's option B, budgeted. Absent means the whole round is off, which is the default. */
  correction: CorrectionBudget.default({}),
  /**
   * ADR-0063: strictness this experiment adds on top of the project's own `tsconfig`, as flags.
   *
   * Default empty, which is the ordinary case and the only one any published rate has been taken
   * under. A non-empty list means **every number from this run says so** (ADR-0063 condition 3): a
   * survival rate under `--strictNullChecks` and one under the project's own configuration are not
   * the same measurement and may not share a table cell.
   *
   * The baseline is captured with the same flags — condition 2, and it is not optional. `compile_ok`
   * compares an error count before against one after, and comparing counts across two compiler
   * configurations is meaningless rather than merely imprecise.
   */
  compiler_flags: z.array(StrictnessFlag).default([]),
  /**
   * **ADR-0084, and it defaults to `true`.** Re-read the suite once when a verdict is failing *only*
   * on regressions, and let the second reading decide.
   *
   * Set it `false` to reproduce a number measured before this existed — every survival rate published
   * up to 22 Sep 2026 was taken one evaluation per candidate, and those are biased low by the ~6 %
   * this removes. That is the only reason to turn it off; it is not a strictness dial.
   */
  retry_regressions: z.boolean().default(true),
  /**
   * **ADR-0077 option B, and it defaults to `true`.** A type error the change introduced into a test
   * file is recorded as an observation instead of failing `compile_ok`.
   *
   * Measured before it was accepted: on the 15 tasks whose target compiled clean and whose only
   * introduced errors were in test files, **14 survived the project's own suite** — 95 %
   * `[0.681, 0.998]` against `S₁₄`'s `[0.008, 0.221]`, intervals that do not overlap. Set it `false`
   * to reproduce `S₁₄ = 2/30` and every #2a rate taken before 22 Sep 2026.
   */
  demote_test_type_errors: z.boolean().default(true),
  /**
   * **ADR-0086 §6 option B, decided by the owner 23 Sep 2026, and the default.** On a symbol-scoped task,
   * `compile_ok` asks about the **named declarations**: zero errors inside them after the change, and no
   * more errors *outside* them in the same file than before. `"file"` is option A, the rule 14c was
   * measured under: zero errors anywhere in the task's files. Set it to reproduce 14c's numbers.
   * A whole-file task is always judged by the file, whatever this says.
   */
  symbol_gate: z.enum(["declaration", "file"]).default("declaration"),
  steps: z.array(ChangeStep).min(1),
}).strict();
export type ChangePlan = z.infer<typeof ChangePlan>;

/** What a worker is handed for a code change. The #2a counterpart of `WorkerTask`. */
export const ChangeTask = z.object({
  task_id: z.string().min(1),
  language: Language,
  test_framework: TestFramework,
  ask: z.string().min(1),
  files: z.array(z.object({
    path: z.string().min(1),
    source: z.string(),
    source_sha: Sha,
    /** `tsc` errors in this file at the step's baseline — the per-file half of ADR-0044 §1. */
    errors: NonNegInt,
  })).min(1),
  /** The compiler's own words about this task's files, from the baseline. Empty when there are none. */
  diagnostics: z.string(),
  max_deleted_lines: NonNegInt,
  notes: z.string().nullable(),
  /**
   * 0 first attempt, 1 the mechanical retry that carries the tool's own words (ADR-0022), 2 the
   * correction round of ADR-0044 §4. The value `2` is unreachable until Phase 12 and the room for it is
   * deliberate: deciding it after the schema existed would have been a migration.
   */
  attempt: z.number().int().min(0).max(2),
  retry_of: z.string().nullable(),
  previous_error: ErrorText.nullable(),
  /** Phase 12's Opus-written note, read from the verdict and never from raw output (ADR-0044 §4 rule 1). */
  correction: ErrorText.nullable(),
  /** What kind of change this is, carried through from the plan so the verdict can be read by shape. */
  shape: ChangeShape,
  /**
   * ADR-0086: the declarations a symbol-scoped task may change, located by the compiler when the task was
   * built. Empty on a whole-file task. The offsets index into the matching `files[].source`, and the
   * refinement below checks that they do, which is what lets confinement trust them without reparsing
   * the original.
   */
  symbols: z.array(z.object({
    path: z.string().min(1),
    name: z.string().min(1),
    start: NonNegInt,
    end: NonNegInt,
    start_line: z.number().int().positive(),
    end_line: z.number().int().positive(),
    /** The declaration's text, exactly `files[path].source.slice(start, end)`. */
    source: z.string().min(1),
    /** `tsc` errors inside the span at the step's baseline. */
    errors: NonNegInt,
    /** What the worker is shown and may not change: the file's imports, and a member's class header. */
    imports: z.string(),
    enclosing: z.string(),
  }).strict()).default([]),
}).superRefine((t, ctx) => {
  const sources = new Map(t.files.map((f) => [f.path, f.source]));
  for (const [i, s] of t.symbols.entries()) {
    const source = sources.get(s.path);
    if (source === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["symbols", i, "path"], message: `${s.path} is not one of this task's files` });
    } else if (s.end <= s.start || source.slice(s.start, s.end) !== s.source) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["symbols", i], message: `${s.name}'s span does not index its own text in ${s.path}` });
    }
  }
  // ADR-0044 §4 rule 3: the correction round is spent only after the mechanical retry has failed, so a
  // note can only ride on `attempt: 2`. Enforced rather than intended, because the whole measurement is
  // "what does a correction buy over the free retry" and an early note silently changes the question.
  if (t.correction !== null && t.attempt !== 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["correction"],
      message: `a correction rides on attempt 2 — the mechanical retry is tried first and is free (ADR-0044 §4 rule 3); this task is attempt ${t.attempt}`,
    });
  }
  if (t.attempt === 2 && t.correction === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["attempt"],
      message: "attempt 2 is the correction round; a third attempt carrying no correction is a retry the retry rule did not authorise",
    });
  }
});
export type ChangeTask = z.infer<typeof ChangeTask>;

/** One file the worker rewrote, whole. See ADR-0047 §2 for why this is not a patch. */
export const FileEdit = z.object({ path: z.string().min(1), contents: z.string() });
export type FileEdit = z.infer<typeof FileEdit>;

/** One declaration a worker returned for a symbol-scoped task, exactly as it returned it (ADR-0086 §3). */
export const SymbolEdit = z.object({ path: z.string().min(1), name: z.string().min(1), text: z.string() });
export type SymbolEdit = z.infer<typeof SymbolEdit>;

const ChangeCandidateFields = z.object({
  task_id: z.string().min(1),
  worker: WorkerStamp,
  /**
   * Empty when the worker answered with nothing usable — which is `no_edit_at_all`, not a crash.
   *
   * On a symbol-scoped task these are the files **after the splice** (ADR-0086 §3). They are still whole
   * files, so every gate stage after `generate` reads the same shape it always has.
   */
  edits: z.array(FileEdit),
  /** A symbol-scoped task's answer before the splice. Empty on a whole-file task. */
  symbol_edits: z.array(SymbolEdit).default([]),
  /** What the parser could not read as an edit. null when the whole answer parsed. */
  unparsed: ErrorText.nullable(),
  /**
   * *"I cannot do this, because X"* — ADR-0044's *"the other direction"*, built in Phase 12.
   *
   * Workers still do not chat: a refusal is an **escalation with a reason**, not a question, and it
   * short-circuits the gate rather than opening a turn. The point is that a worker which knows it
   * cannot do the task stops costing 262 s of gate to fail at `compile` for a reason nobody can read.
   *
   * It is deliberately cheap to abuse and that is checked elsewhere: a refusal is counted in its own
   * funnel row, so a worker that learns to refuse everything shows up as a refusal rate rather than as
   * a survival rate that quietly stopped having a denominator.
   */
  refusal: ErrorText.nullable(),
  /** The completion hit the token ceiling, so at least one file is cut off. */
  truncated: z.boolean(),
  usage: z.object({ prompt_tokens: NonNegInt, completion_tokens: NonNegInt }),
  timing: z.object({ ttft_ms: Millis, wall_ms: Millis }),
});

export const ChangeCandidate = ChangeCandidateFields.superRefine(seedIsRecorded);
export type ChangeCandidate = z.infer<typeof ChangeCandidateFields>;

/**
 * The machine's own state at one instant — ADR-0066 option C, and **nothing here gates**.
 *
 * `free_gb` is the same reclaimable-pages figure `parseMemory` reports, so a verdict's record and the
 * run's own sizing decision are the same instrument reading the same thing. The other two are what the
 * pressure level cannot say: under load macOS compresses first and swaps second, and those are
 * different conditions with the same `pressure: "warn"`.
 *
 * Every field but `pressure` is nullable because the reads are `vm_stat` and `sysctl`, which exist on
 * macOS and nowhere else. A null is "this machine could not be asked", never a guess at zero.
 */
export const MachineSample = z.object({
  pressure: z.enum(["normal", "warn", "critical", "unknown"]),
  free_gb: z.number().nonnegative().nullable(),
  swap_gb: z.number().nonnegative().nullable(),
  compressed_gb: z.number().nonnegative().nullable(),
}).strict();
export type MachineSample = z.infer<typeof MachineSample>;

/**
 * The machine before and after one verification — ADR-0066 option C, *record and gate nothing*.
 *
 * **Two samples rather than one, and the reason is the ADR's own amendment of 18 Sep 2026.** Reading
 * the pressure level once is what the ADR ruled out as a threshold: this suite reaches `warn`
 * unaided on the baseline machine, so a rule keyed on the level would downgrade nearly every real
 * failure to a machine failure — the same bug with the sign flipped. What separated the measured
 * false negative from the two true passes of identical bytes was **swap**: flat at 2.5–3.0 GB when it
 * survived, 5.3 of 6.1 GB and actively paging when it did not. Swap is a delta, so recording one
 * number cannot express it.
 *
 * `before` is taken as the sandbox is verified and `after` once the suite has finished, which is the
 * only ordering that says anything: ADR-0011's argument is that the workload creates the condition
 * *after* the check has passed, so a sample taken only at the start records the machine the gate was
 * about to ruin.
 *
 * This is the field option A will eventually threshold on. It is deliberately not thresholded now —
 * the ADR's finding is that nobody has the number yet, and `swapGrowthGb` over a corpus of verdicts
 * is how it stops being a guess.
 */
export const VerdictMachine = z.object({
  before: MachineSample,
  after: MachineSample,
}).strict();
export type VerdictMachine = z.infer<typeof VerdictMachine>;

/** How much swap this one verification added. null when either end could not be read. */
export const swapGrowthGb = (m: VerdictMachine | null): number | null =>
  m === null || m.before.swap_gb === null || m.after.swap_gb === null
    ? null
    : m.after.swap_gb - m.before.swap_gb;

const ChangeVerdictFields = z.object({
  task_id: z.string().min(1),
  stage_reached: ChangeStage,
  survived: z.boolean(),
  compile_ok: z.boolean(),
  tests_ok: z.boolean(),
  confined: z.boolean(),
  /**
   * What `compile_ok` judged: the task's **file**s (the rule since ADR-0048), or, on a symbol task under
   * ADR-0086 §6 option B, its named **declaration**s. Recorded so the schema can enforce whichever rule
   * applied, and so two survival rates taken under different scopes cannot share a table cell unnoticed.
   */
  target_scope: z.enum(["file", "declaration"]).default("file"),
  files_touched: z.array(z.string()),
  errors: z.object({
    before: ErrorCounts,
    after: ErrorCounts,
    /** Files that have more errors after than before, and by how many. Empty is what `compile_ok` needs. */
    introduced: z.record(z.string(), NonNegInt),
    /**
     * The task's own files that still have errors, and how many. Under `target_scope: "declaration"`
     * these are errors **inside the named declarations** only (ADR-0086 §6 option B).
     */
    remaining_in_target: z.record(z.string(), NonNegInt),
    /**
     * ADR-0086 §6 option B: per task file, the errors **outside** the named declarations, before and
     * after. `compile_ok` needs `after <= before` for every entry. Comparing the file's total instead
     * would pass a change that fixed two errors inside and broke one outside. Empty on a file-scoped
     * verdict.
     */
    outside_target: z.record(z.string(), z.object({ before: NonNegInt, after: NonNegInt })).default({}),
    /** The compiler's own words, truncated. What a correction quotes (ADR-0044 §4 rule 1). */
    message: ErrorText.nullable(),
  }),
  /** null when the tests stage never ran, which is not the same as a suite that produced no report. */
  tests: z.object({
    /** False when the runner produced no parseable report: a machine problem, and it does not spend the retry. */
    reported: z.boolean(),
    ran_before: NonNegInt,
    ran_after: NonNegInt,
    /**
     * How many test **executions** passed, before and after — counts, not identities (ADR-0067).
     *
     * `regressed` is computed by set membership over `passed_ids`, and a `test.each` block gives every
     * one of its cases the same `fullName`. So a candidate that breaks one case of nine leaves the id
     * in the set, records no regression, and passes `ran_after >= ran_before` because the failing case
     * still ran. Measured on a real project: 54 ids appearing up to 9 times, covering 295 of 6,368
     * executions.
     *
     * These two fields are what lets the gate compare *how much* passed rather than *which names*
     * passed, and they are in the verdict rather than derived so the refinement below can enforce it —
     * a gate condition a schema cannot check is a convention, not a gate (CLAUDE.md #2).
     */
    passed_before: NonNegInt,
    passed_after: NonNegInt,
    /** Names of tests that passed before and do not now. The other half of what a correction reads. */
    regressed: z.array(z.string()),
    message: ErrorText.nullable(),
    /**
     * **The reading this verdict did NOT rest on — ADR-0084.** Present only when a regression-only
     * failure was re-read and the second reading decided.
     *
     * The block above always carries the **deciding** reading, because the refinement below requires
     * `tests_ok` to be supported by the fields beside it: a verdict that claims a survival its own
     * fields do not support must not serialise (CLAUDE.md #2). So the discarded reading lives here
     * rather than replacing it, and **a candidate that was rescued says what it was rescued from.**
     *
     * Measured: 11 tests in one project each failed in exactly one of 50 runs of an *unmodified* tree,
     * and a run carried at least one such failure `3/50` of the time — indistinguishable from `D`
     * itself. One observation was never enough to call a regression.
     */
    first_reading: z.object({
      reported: z.boolean(),
      ran_after: NonNegInt,
      passed_after: NonNegInt,
      regressed: z.array(z.string()),
      message: ErrorText.nullable(),
    }).nullable().default(null),
  }).nullable(),
  confinement: z.array(ConfinementBreach),
  /**
   * True of the candidate, and **nothing here gates** (ADR-0057). `changeSurvives` does not read it and
   * the refinement below asserts that, so the rule ADR-0048 froze stays the rule.
   */
  observations: z.array(ChangeObservation).default([]),
  /** The worker said it could not do this. The gate stops at `generate`; no sandbox, no suite, no 262 s. */
  refused: ErrorText.nullable().default(null),
  error: ErrorText.nullable(),
  /** A key is present only for a stage that actually ran. */
  timing_ms: z.object({ compile: Millis.optional(), tests: Millis.optional() }),
  /**
   * When the baseline this verdict was judged against was captured — ADR-0069 option A.
   *
   * The timestamp already exists on `ChangeBaseline`; what did not exist was any way to see it *where
   * the verdict is read*. A baseline is captured once per step and candidates are then verified for
   * hours against it, so the two can fall on different days, and the measured consequence is not
   * subtle: one test asserting on what was tracked **today** turned a stale baseline into a total run
   * failure, because every candidate verified after midnight inherited the same regression.
   *
   * `verified_at` is the other end of that gap. Neither gates — `changeSurvives` does not read them,
   * and the refinement below asserts nothing does. The warning is `crossesCalendarDay`.
   */
  baseline_captured_at: z.string().datetime().nullable().default(null),
  verified_at: z.string().datetime().nullable().default(null),
  /**
   * The machine on either side of this verification — ADR-0066 option C. Nothing here gates.
   *
   * Nullable with a default rather than required, and the reason is on disk: `--resume` and every
   * analysis script read verdicts written before this field existed. A null therefore means *taken
   * before the field existed*, which is a different sentence from *this machine could not be asked* —
   * that one is a present `VerdictMachine` with null members.
   */
  machine: VerdictMachine.nullable().default(null),
  /**
   * **The strictness this verdict was judged under — ADR-0063 condition 2, made checkable.**
   *
   * It was already true that a baseline and its verdicts must share these flags, or the two error
   * counts are not comparable. It was not recorded, so nothing could check it and no reader could tell
   * which configuration a number came from.
   *
   * **ADR-0077 option B is what forced it.** A test-file type error is demoted only under added flags,
   * because with none the baseline and the verdict are both under the *project's own* tsconfig and an
   * introduced error is a real break of a build that was working. The refinement below enforces that,
   * and it needs this field to do it — otherwise the rule would live only in `verifyChange` and be a
   * convention rather than a gate (CLAUDE.md #2).
   *
   * Empty by default, which is both the ordinary case and what a verdict written before this parses as.
   */
  compiler_flags: z.array(StrictnessFlag).default([]),
});

/**
 * Survive ⇔ the diff was confined ∧ it compiles ∧ every test that passed before still passes.
 * The workload-#2a form of CLAUDE.md #2, and the one rule this workload rests on (ADR-0048).
 */
export const changeSurvives = (v: z.infer<typeof ChangeVerdictFields>): boolean =>
  v.confined && v.compile_ok && v.tests_ok;

/**
 * True when a verdict's baseline was captured on a different calendar day from the verification —
 * ADR-0069's warning, and **it is a warning rather than a clause of the gate**.
 *
 * The comparison is by local calendar day rather than by elapsed hours, because the failure is not
 * gradual with age: it is a step function at whatever boundary the project's own tests encode, and
 * midnight is merely the most common one. "Older than N hours" is the wrong shape and needs a number
 * nobody has; "these fell on different days" needs none.
 *
 * **Both frames, local and UTC, and ADR-0083 is why.** This compared local days only, on the reasoning
 * that *"the baseline and the candidate ran on the same machine, so the suite's own notion of today is
 * this process's"*. That reasoning is wrong and it was measured wrong: 25 runs of an unmodified real
 * suite moved **three tests at 00:00 UTC**, while the machine's local clock read 01:55 → 02:02 and
 * never changed day. The old comment named the blind spot as *"a project that pins `TZ` itself"*, which
 * made it sound exotic. It is not — any code doing date arithmetic in UTC, which is most backend code
 * and every `toISOString().slice(0, 10)`, has a UTC notion of *today* whatever the machine's clock says.
 *
 * So a run between 01:00 and 03:00 in a UTC+2 summer crosses the boundary the tests care about and not
 * the one this watched. Either frame changing is now the warning. It is strictly more sensitive, it
 * cannot make the gate refuse anything — this gates nothing — and a false warning costs a sentence.
 *
 * null when either timestamp is absent — a verdict written before ADR-0069 cannot answer, and saying
 * `false` there would be claiming it had.
 */
export const crossesCalendarDay = (v: Pick<z.infer<typeof ChangeVerdictFields>, "baseline_captured_at" | "verified_at">): boolean | null => {
  if (v.baseline_captured_at === null || v.verified_at === null) return null;
  const localDay = (iso: string): string => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  };
  const utcDay = (iso: string): string => new Date(iso).toISOString().slice(0, 10);
  return localDay(v.baseline_captured_at) !== localDay(v.verified_at)
    || utcDay(v.baseline_captured_at) !== utcDay(v.verified_at);
};

/**
 * The gate, as an iff rather than a convention — and stronger than workload #1's, because there are
 * more ways to be quietly wrong here (ADR-0037, ADR-0048).
 *
 * A `ChangeVerdict` that claims a survival its own fields do not support does not serialise. In
 * particular `tests_ok` cannot be true without a report, without the suite having run at least as much
 * as the baseline did, and without an empty `regressed` — "the suite collected zero tests" was never
 * going to be allowed to read as "the suite is green".
 */
export const ChangeVerdict = ChangeVerdictFields.superRefine((v, ctx) => {
  const fail = (path: (string | number)[], message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  };
  if (v.confined !== (v.confinement.length === 0)) {
    fail(["confined"], `confined must equal confinement.length === 0 (here: ${v.confinement.length === 0})`);
  }
  // **ADR-0077 option B.** `compile_ok` requires the task's own files clean and nothing introduced in
  // **non-test** source. A type error introduced into a test file is an observation instead — see
  // `ObservationKind.test_type_error_demoted` for why there was no legal edit that avoided it.
  //
  // The iff stays checkable, which is the whole point of asserting it here rather than trusting
  // `verifyChange` (CLAUDE.md #2): the demotion is written into the rule the schema enforces, so a
  // verdict claiming `compile_ok` with a *non-test* file broken still does not serialise.
  //
  // **The demotion applies only under added strictness flags.** With none, the baseline and this
  // verdict are both under the project's own tsconfig, so an introduced error is a real break of a
  // build that was working — and `compile_ok` is the clause that promised otherwise.
  const demotable = v.compiler_flags.length > 0;
  const blockingIntroduced = Object.keys(v.errors.introduced)
    .filter((f) => !(demotable && isTestArtefact(f)));
  // ADR-0086 §6 option B. Under a declaration scope, a task file is judged by what is *outside* its named
  // declarations rather than by its total, so it is taken out of the `introduced` rule and checked here.
  const scoped = v.target_scope === "declaration";
  if (scoped && v.compile_ok) {
    for (const [file, o] of Object.entries(v.errors.outside_target)) {
      if (o.after > o.before) fail(["compile_ok"], `compile_ok requires no more errors outside the named declarations in ${file} than before (${o.after} > ${o.before})`);
    }
  }
  const judgedOutside = new Set(scoped ? Object.keys(v.errors.outside_target) : []);
  if (v.compile_ok && (Object.keys(v.errors.remaining_in_target).length > 0
    || blockingIntroduced.filter((f) => !judgedOutside.has(f)).length > 0)) {
    fail(["compile_ok"], demotable
      ? "compile_ok requires zero errors in the task's files and none introduced in non-test source"
      : "compile_ok requires zero errors in the task's files and none introduced anywhere — a test-file error is demoted only under added strictness flags (ADR-0077 option B)");
  }
  if (v.tests_ok) {
    if (v.tests === null) fail(["tests_ok"], "tests_ok cannot be true when the tests stage never ran");
    else if (!v.tests.reported) fail(["tests_ok"], "tests_ok cannot be true when the runner produced no report");
    else if (v.tests.regressed.length > 0) fail(["tests_ok"], "tests_ok cannot be true when a test that passed before now fails");
    else if (v.tests.ran_after < v.tests.ran_before) fail(["tests_ok"], "tests_ok cannot be true when fewer tests ran than in the baseline");
    else if (v.tests.ran_after === 0) fail(["tests_ok"], "a suite that collected zero tests is not a green suite");
    // ADR-0067, and it is the clause that catches what `regressed` structurally cannot: a `test.each`
    // case that broke while its shared id stayed in the passing set. Leniency is the dangerous
    // direction — this one let a bad change through, where ADR-0066's failure only refused a good one.
    else if (v.tests.passed_after < v.tests.passed_before) {
      fail(["tests_ok"], `tests_ok cannot be true when fewer tests passed than in the baseline (${v.tests.passed_after} < ${v.tests.passed_before})`);
    }
  }
  // ADR-0084. A retry is spent only on a verdict that was failing on `tests_ok` **with a report** — a
  // machine problem is not a flake and does not buy a second suite run. Asserting it here keeps the
  // rule from drifting into "re-run until it passes", which is the one shape this must never become.
  if (v.tests?.first_reading != null) {
    const first = v.tests.first_reading;
    const firstFailed = !first.reported
      || first.regressed.length > 0
      || first.passed_after < v.tests.passed_before
      || first.ran_after < v.tests.ran_before;
    if (!firstFailed) {
      fail(["tests", "first_reading"], "a first reading is recorded only when it failed — a passing reading is not re-read");
    }
    if (!first.reported) {
      fail(["tests", "first_reading"], "a reading that produced no report is a machine problem, not a flake, and does not spend the retry");
    }
  }
  if (v.survived !== changeSurvives(v)) {
    fail(["survived"], `survived must equal confined ∧ compile_ok ∧ tests_ok (here: ${changeSurvives(v)})`);
  }
  // ADR-0057: an observation is not a breach. Asserted rather than trusted, because the one way this
  // decision gets lost is somebody later reading `observations` as a soft confinement list — and then
  // survival stops being comparable with Phase 11's without anything failing.
  if (v.refused !== null && v.survived) {
    fail(["refused"], "a candidate the worker refused to write cannot have survived the gate");
  }
  if (v.refused !== null && v.stage_reached !== "generate") {
    fail(["stage_reached"], `a refusal stops at generate — it never reaches a sandbox (here: ${v.stage_reached})`);
  }
});
export type ChangeVerdict = z.infer<typeof ChangeVerdictFields>;

/**
 * The workload-#2a escalation queue — `.sidecrew/runs/<id>/escalations.jsonl` for a `fix` run.
 *
 * A separate shape rather than a widened `Escalation`, and the reason is that the two carry different
 * evidence. Workload #1's `stage_reached` is `Stage` — compile, pass, mutation — and says nothing about
 * confinement or a regressed test, which are the two things a 2a reader needs first. Widening `Stage`
 * would have made every workload-#1 escalation carry four fields that are always null, and made the
 * discriminant a runtime question (`BACKLOG.md` named this as the contract change Phase 12 owns).
 *
 * What a reader gets that `ChangeVerdict` alone does not: the **task** the worker was asked, verbatim,
 * so Claude answers the question the worker could not rather than a summary of it — the same rule
 * `EscalationBatch` follows.
 */
export const ChangeEscalation = z.object({
  task_id: z.string().min(1),
  shape: ChangeShape,
  /** `shouldRetryChange`'s sentence for the last attempt, in the words the run log used. */
  reason: z.string().min(1),
  /**
   * True when nothing here is the worker's fault — a sandbox that would not delete, a runner that
   * produced no report (ADR-0012, ADR-0056). A rate that counts these is an understatement and the
   * reader cannot tell; `FixResult.stats.machine_failures` counts the same thing.
   */
  machine_failure: z.boolean().default(false),
  /** The worker's own words when it refused, rather than a verdict that failed for a reason nobody can read. */
  refused: ErrorText.nullable().default(null),
  /** Newest last. Each attempt's verdict, which is everything a correction or a human would read. */
  attempts: z.array(z.object({
    task_id: z.string().min(1),
    attempt: z.number().int().min(0).max(2),
    /** null when the task threw rather than returning a verdict: nothing ran, so no stage is honest. */
    stage_reached: ChangeStage.nullable(),
    /** Which confinement rules fired, by name — the most actionable sentence this gate produces. */
    confinement: z.array(ConfinementRule),
    /** Names of tests that passed before and do not now. Truncated by the writer, not here. */
    regressed: z.array(z.string()),
    error: ErrorText,
  })).min(1),
  escalated_at: z.string().datetime(),
});
export type ChangeEscalation = z.infer<typeof ChangeEscalation>;

/** What `sidecrew escalate --fix` hands to Claude: the 2a queue, joined back to the tasks on disk. */
export const ChangeEscalationBatch = z.object({
  run_id: z.string().min(1),
  plan: z.string().min(1),
  language: Language,
  test_framework: TestFramework,
  suggested_model: z.string().min(1),
  items: z.array(ChangeEscalation.extend({ task: ChangeTask })),
});
export type ChangeEscalationBatch = z.infer<typeof ChangeEscalationBatch>;

/**
 * What `sidecrew fix --validate` / `sidecrew_fix_plan_validate` reports about a change plan.
 *
 * Its own shape rather than `ValidationReport`, whose `checked` counts functions, shapes and exemplars —
 * none of which a change plan has.
 *
 * The field that earns the schema is **`refusals`**. A plan can be well-formed and still contain a task
 * no worker could ever pass, and the run would spend 262 s of gate per attempt discovering that. Phase
 * 11 nearly measured one (ADR-0050 option C). So the validator refuses them by name, and the count
 * travels into the planner-cost denominator: a task the planner refused is not a task it planned, and
 * hiding refusals in `N` would make a careful planner look expensive
 * (`experiments/planner-cost/README.md` §4.1).
 */
export const ChangeValidationReport = z.object({
  plan: z.string().min(1),
  valid: z.boolean(),
  checked: z.object({ steps: NonNegInt, tasks: NonNegInt, files: NonNegInt }),
  errors: z.array(ValidationIssue),
  warnings: z.array(ValidationIssue),
  /** Tasks the gate could never pass, by `task_id`, with the rule that says so. */
  refusals: z.array(z.object({
    task_id: z.string().min(1),
    code: z.string().min(1),
    message: z.string().min(1),
  })),
  /**
   * How many tasks of each shape. Reported because Phase 11b §4.4 **withholds its verdict** unless at
   * least half the tasks are the harder three, and because every rate in this repository so far is for
   * `rename` and `unused_import`. A planner that only emits renames should be visible as one.
   */
  shapes: z.record(z.string(), NonNegInt),
  /** True when the expensive half — a real `tsc` over the project — was skipped. */
  structural_only: z.boolean(),
}).superRefine((r, ctx) => {
  if (r.valid !== (r.errors.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["valid"], message: "valid must equal errors.length === 0" });
  }
});
export type ChangeValidationReport = z.infer<typeof ChangeValidationReport>;

const FixResultFields = z.object({
  run_id: z.string().min(1),
  plan: z.string().min(1),
  config: z.object({
    worker_kind: WorkerKind,
    worker_model: z.string().min(1),
    concurrency: z.number().int().positive(),
    retry: NonNegInt,
  }),
  /** The project at the start of the run and at the end of it — the monotone gate's evidence. */
  project: z.object({
    errors_before: NonNegInt,
    errors_after: NonNegInt,
    /** The suite, re-run once after every survivor of every step has landed together. */
    tests_ran: NonNegInt,
    tests_passed: NonNegInt,
    /**
     * Tests that passed at the run's first baseline and do not pass with **all** the survivors applied.
     *
     * Every verdict is taken against its own step's baseline, in a sandbox holding one candidate — so
     * nothing in the per-task gate can see two survivors that are each fine and together are not. This
     * is the only number in the run that can, and it should always be zero: anything else is a hole in
     * the gate, named here rather than left for a user to find.
     */
    combined_regressions: NonNegInt,
  }),
  /** One row per step, in order, with the baseline re-captured between them (ADR-0044 §2). */
  steps: z.array(z.object({
    name: z.string().min(1),
    tasks: NonNegInt,
    survived: NonNegInt,
    escalated: NonNegInt,
    errors_before: NonNegInt,
    errors_after: NonNegInt,
  })),
  stats: z.object({
    tasks: NonNegInt,
    survived: NonNegInt,
    retried: NonNegInt,
    escalated: NonNegInt,
    /** Attempts, not tasks — a picture of where the gate rejected things, as workload #1's funnel is. */
    funnel: z.object({
      answered: NonNegInt,
      edits_parsed: NonNegInt,
      confined: NonNegInt,
      applied: NonNegInt,
      compiled: NonNegInt,
      suite_green: NonNegInt,
    }),
    /**
     * The two rows that say the number is about the **edit format** rather than about the model
     * (ADR-0047 §2). Phase 11's frozen rule §4.4 turns a quarter of attempts here into an inconclusive
     * run and a format experiment, rather than a no-go on the workload.
     */
    edit_parse_failed: NonNegInt,
    edit_truncated: NonNegInt,
    /**
     * Tasks that produced no verdict because the **machine** failed — a sandbox that would not delete
     * (ADR-0056), a runner that produced no report (ADR-0012). Counted apart so a survival rate's
     * denominator can exclude what was never the worker's to answer.
     *
     * Phase 11 is why this is a field: project-b's twelfth task was lost to `ENOTEMPTY` during teardown
     * and landed in `escalated`, where it is indistinguishable from *the worker could not do this*. The
     * report had to carry both readings — `11/12` and `11/11` — because nothing in the contract could
     * say which was which.
     */
    machine_failures: NonNegInt.default(0),
    /**
     * The candidate cache (ADR-0065). **Off by default, and a run that used it says so**, because a
     * cached run's `generate_ms` is not a measurement: a hit is near-zero and drags the median towards
     * a number no worker ever achieved. Any `experiments/` figure must come from a run with
     * `enabled: false` — a measurement of what the workers do cannot be served from a record of what
     * they did last time.
     */
    cache: z.object({
      enabled: z.boolean(),
      hits: NonNegInt,
      writes: NonNegInt,
    }).default({ enabled: false, hits: 0, writes: 0 }),
    /** Tasks where the worker said it could not do this, with a reason (ADR-0044, *the other direction*). */
    refusals: NonNegInt.default(0),
    /**
     * What ADR-0044 §4's correction round cost and bought, which is the whole of Phase 12 §2.2.
     *
     * `written` is the denominator the budget is spent against; `survived` over `written` is `S_c`; and
     * `on_observations` is kept apart because it is a **different mechanism** — correcting a candidate
     * that already passed (ADR-0057) — and pooling two mechanisms into one rate is what the frozen rule
     * forbids.
     */
    corrections: z.object({
      written: NonNegInt,
      survived: NonNegInt,
      on_observations: NonNegInt,
      /** Opus tokens the corrections cost. Zero written means zero here, and the schema checks it. */
      tokens: NonNegInt,
      /** Why the round stopped early, when it did: the budget, the token cap, or nothing. */
      budget_exhausted: z.string().nullable(),
    }).default({ written: 0, survived: 0, on_observations: 0, tokens: 0, budget_exhausted: null }),
    /** Each `ConfinementRule` that fired, by name and count — which cheap pass the worker reached for. */
    confinement_breaks: z.record(z.string(), NonNegInt),
    latency_ms: z.object({ median: Millis, p90: Millis }),
    /** Kept apart because for 2a the expensive stage is the project's own suite, not the worker. */
    generate_ms: z.object({ median: Millis, p90: Millis }),
    gate_ms: z.object({ median: Millis, p90: Millis }),
    peak_rss_mb: z.number().nonnegative(),
    claude_tokens: z.object({
      planning: NonNegInt,
      /** Zero whenever `config.worker_kind` is `local` — enforced below, not merely intended. */
      workers: NonNegInt,
      review: NonNegInt.nullable(),
    }),
  }),
  survivors: z.array(z.object({
    task_id: z.string().min(1),
    files: z.array(z.string().min(1)).min(1),
    /** The unified diff on disk. The artefact a reviewer reads; nothing gates on it (ADR-0048). */
    diff_path: z.string().min(1),
    errors_fixed: NonNegInt,
  })),
  escalations: z.array(z.object({
    task_id: z.string().min(1),
    attempts: z.array(z.object({ error: ErrorText })),
  })),
});

/** The same guarantee `BatchResult` carries, in the second workload's result (ADR-0009, ADR-0045). */
export const FixResult = FixResultFields.superRefine((r, ctx) => {
  if (r.config.worker_kind === "local" && r.stats.claude_tokens.workers !== 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["stats", "claude_tokens", "workers"],
      message: "a local worker cannot spend Claude tokens — it is reached over http://localhost/v1",
    });
  }
  // The api tier's half of the same guarantee (ADR-0045 §6, Phase 13 §5.0.2) — see `BatchResult` for
  // the argument. `funnel.answered` is the right denominator here because it counts candidates that
  // came back from a worker, which is exactly what a bill would be for.
  if (r.config.worker_kind === "api" && r.stats.funnel.answered > 0 && r.stats.claude_tokens.workers === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["stats", "claude_tokens", "workers"],
      message: `an api run that got ${r.stats.funnel.answered} answer(s) cannot have cost 0 worker tokens — this is either lost or estimated usage, and the tier's whole measurement is its price`,
    });
  }
  // A run that never switched the cache on cannot have hit it. Cheap, and it is the field an
  // `experiments/` reader checks before quoting `generate_ms` (ADR-0065).
  if (!r.stats.cache.enabled && (r.stats.cache.hits > 0 || r.stats.cache.writes > 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["stats", "cache"],
      message: "the cache reports hits or writes but was not enabled for this run",
    });
  }
  const c = r.stats.corrections;
  if (c.survived > c.written) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["stats", "corrections", "survived"],
      message: `more corrected attempts survived (${c.survived}) than corrections were written (${c.written})`,
    });
  }
  if (c.written === 0 && c.tokens !== 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["stats", "corrections", "tokens"],
      message: "a run that wrote no corrections cannot have spent Opus tokens writing them",
    });
  }
  // The correction round is Opus writing notes. On the local tier the *workers* stay free (above) and
  // this is the one place a `fix` run may legitimately spend Claude tokens, so it is accounted in
  // `planning` rather than hidden: §2.2 prices corrections against what escalation would have cost, and
  // a token that is not in the result is a token the measurement cannot see.
  if (c.tokens > r.stats.claude_tokens.planning) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["stats", "corrections", "tokens"],
      message: `corrections cost ${c.tokens} tokens but claude_tokens.planning is ${r.stats.claude_tokens.planning} — corrections are Opus tokens and must be inside the run's accounting`,
    });
  }
});
export type FixResult = z.infer<typeof FixResultFields>;

// ── Phase 14d: recon, the predicate half of retrieval (ADR-0079 option A, ADR-0090) ───────────────

/** Errors and the files carrying them, for one side of the source/test split. */
export const ReconSplit = z.object({ errors: NonNegInt, files: NonNegInt });
export type ReconSplit = z.infer<typeof ReconSplit>;

/** One file a flag adds errors to. `test` is the gate's own predicate (`isTestArtefact`), not a copy. */
export const ReconFile = z.object({
  file: z.string().min(1),
  errors: z.number().int().positive(),
  test: z.boolean(),
});

export const ReconCode = z.object({ code: z.string().regex(/^TS\d+$/), count: z.number().int().positive() });

/**
 * What one strictness flag would add to the project's own configuration.
 *
 * **`already_on` means the project's resolved configuration enables the flag**, read from `tsc
 * --showConfig`, and then nothing was run for it: re-running the same compiler would report zero added
 * errors, and "zero" and "you already have this" are different answers to the user's question.
 */
export const ReconFlagFields = z.object({
  flag: StrictnessFlag,
  already_on: z.boolean(),
  /** Errors this flag adds over the baseline, per file and never negative: `source + tests + config`. */
  added: NonNegInt.nullable(),
  source: ReconSplit.nullable(),
  /**
   * Added errors in test files. Reported separately because they are the ones a behaviour-preserving
   * task may not edit (ADR-0046), and they sank `null_guard` in 21 of 21 cases (ADR-0077).
   */
  tests: ReconSplit.nullable(),
  /** Added errors `tsc` reported against no file — a flag the project's toolchain rejects, say. */
  config_errors: NonNegInt.nullable(),
  top_files: z.array(ReconFile),
  top_codes: z.array(ReconCode),
  ms: NonNegInt,
});
export type ReconFlag = z.infer<typeof ReconFlagFields>;

const reconFlagConsistent = (f: ReconFlag, ctx: z.RefinementCtx, at: (string | number)[] = []): void => {
  const counted = [f.added, f.source, f.tests, f.config_errors].filter((v) => v !== null).length;
  if (f.already_on && counted !== 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...at, "added"], message: `${f.flag} is already on, so nothing was run for it and it can carry no counts` });
  }
  if (!f.already_on && counted !== 4) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...at, "added"], message: `${f.flag} was run, so added, source, tests and config_errors are all measured` });
  }
  if (f.already_on || f.source === null || f.tests === null || f.config_errors === null || f.added === null) return;
  if (f.added !== f.source.errors + f.tests.errors + f.config_errors) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...at, "added"], message: `added (${f.added}) is not source + tests + config errors (${f.source.errors + f.tests.errors + f.config_errors})` });
  }
  if (f.top_files.length > f.source.files + f.tests.files) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...at, "top_files"], message: "more top files than files the flag added errors to" });
  }
};

export const ReconFlag = ReconFlagFields.superRefine((f, ctx) => reconFlagConsistent(f, ctx));

/**
 * `sidecrew recon`: the project's own `tsc` error count, and what each stricter flag would add — ADR-0079
 * option A, and piece 1 of ADR-0090 §4.
 *
 * **A predicate report, so relevance is not in question** (ADR-0090 §2.1): the user asked *how many*,
 * and every number here is `tsc`'s own, exact and re-runnable. Nothing in it came from a model.
 *
 * **`fix_offered` is the literal `false`, and that is the gate.** PHASES.md: *"what it must not do yet:
 * offer to fix what it counts"* — `null_guard` under a strictness flag measured 2/30 (ADR-0077), and a
 * report that quantifies work the gate cannot deliver converts a quiet limitation into a loud broken
 * promise. A report that offers does not serialise; the day it may, this changes with an ADR.
 */
export const ReconReport = z.object({
  version: z.literal(1),
  /** As the caller gave it. Never written into this repository: it names somebody's checkout. */
  project: z.string().min(1),
  tsconfig: z.string().min(1),
  /** The project's own compiler, which is the one every number here is from. */
  typescript: z.string().nullable(),
  created: z.string().datetime(),
  /** False when `tsc --showConfig` did not answer; then no flag can be known to be already on, and every one was run. */
  config_read: z.boolean(),
  baseline: z.object({
    errors: NonNegInt,
    source: ReconSplit,
    tests: ReconSplit,
    config_errors: NonNegInt,
    /** Files `tsc` had in the program — never zero, or the compiler did not run (ADR-0037). */
    program_files: z.number().int().positive(),
    /** Test files in that program: a narrowed type can reach them, and no task may edit them (ADR-0071). */
    tests_in_program: NonNegInt,
    top_codes: z.array(ReconCode),
    ms: NonNegInt,
  }),
  flags: z.array(ReconFlagFields),
  fix_offered: z.literal(false),
  note: z.string().min(1),
}).superRefine((r, ctx) => {
  const seen = new Set<string>();
  r.flags.forEach((f, i) => {
    reconFlagConsistent(f, ctx, ["flags", i]);
    if (seen.has(f.flag)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["flags", i, "flag"], message: `${f.flag} is reported twice` });
    seen.add(f.flag);
    if (f.already_on && !r.config_read) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["flags", i, "already_on"], message: "the configuration was not read, so no flag can be known to be already on" });
    }
  });
  const b = r.baseline;
  if (b.errors !== b.source.errors + b.tests.errors + b.config_errors) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["baseline", "errors"], message: "baseline errors is not source + tests + config errors" });
  }
});
export type ReconReport = z.infer<typeof ReconReport>;

// ── Phase 14d: predicate retrieval — `sidecrew query` (ADR-0090 §4 piece 3) ───────────────────────
//
// The four questions the 20 Sep planners wrote their own scripts for, answered by the project's own
// compiler: who references a declaration, which exports nothing outside their file uses, what fits the
// rewrite ceiling, and where a flag's errors are. Predicate questions (ADR-0090 §2.1): the answer is
// exact and re-runnable, so its relevance is the question the planner chose.
//
// **Every list is capped and says so.** `total` is what the compiler found and `truncated` is true
// exactly when fewer were listed: a capped answer that reads as complete is the shape of five defects
// in this repository already (HANDOFF §5, *"anything this tool truncates for display…"*).

const QueryLocation = z.object({ file: z.string().min(1), line: z.number().int().positive() });

const QueryCommon = {
  version: z.literal(1),
  project: z.string().min(1),
  tsconfig: z.string().min(1),
  created: z.string().datetime(),
  ms: NonNegInt,
  /** How many the compiler found, before the cap. */
  total: NonNegInt,
  truncated: z.boolean(),
};

export const RefsAnswer = z.object({
  ...QueryCommon,
  kind: z.literal("refs"),
  items: z.array(z.object({
    file: z.string().min(1),
    name: z.string().min(1),
    /** False when no declaration of that name is in that file; then every count is zero. */
    found: z.boolean(),
    /** References, the declaration itself excluded. */
    references: NonNegInt,
    /** Distinct files those references are in, the declaring file included. */
    files: NonNegInt,
    /** How many of the references are in test files — which a behaviour-preserving task may not edit. */
    from_tests: NonNegInt,
    locations: z.array(QueryLocation),
    locations_truncated: z.boolean(),
  })),
});

export const UnreferencedAnswer = z.object({
  ...QueryCommon,
  kind: z.literal("unreferenced"),
  /** The project-relative prefix scanned, or null for the whole program. */
  under: z.string().nullable(),
  /** Exported declarations examined. `total` is how many of them had no reference outside their file from a non-test file. */
  scanned: NonNegInt,
  items: z.array(z.object({
    file: z.string().min(1),
    name: z.string().min(1),
    line: z.number().int().positive(),
    kind: z.string().min(1),
    /**
     * A decorated class is reached by reflection — DI, an ORM's entity glob, a controller registry — and
     * a reference count cannot see that. The 20 Sep planner refused eight tasks on exactly this. Recorded,
     * never filtered: the planner decides, and it decides knowing.
     */
    decorated: z.boolean(),
    /** References from test files. Non-zero means removing it breaks a test, which the gate would catch. */
    refs_from_tests: NonNegInt,
  })),
});

export const SizesAnswer = z.object({
  ...QueryCommon,
  kind: z.literal("sizes"),
  under: z.string().nullable(),
  /** `MAX_FIX_TOKENS`: what a worker can return in one answer (ADR-0047 §2). */
  ceiling: z.number().int().positive(),
  /** Files, of `total`, whose whole-file rewrite fits under the ceiling. */
  fitting: NonNegInt,
  items: z.array(z.object({
    file: z.string().min(1),
    chars: NonNegInt,
    /** `rewriteCost`, the validator's own estimate, so this can never disagree with a refusal. */
    rewrite_tokens: NonNegInt,
    fits: z.boolean(),
    /** For a file that does not fit: its uniquely nameable declarations, and how many of them fit alone (ADR-0086). */
    declarations: NonNegInt.nullable(),
    declarations_fitting: NonNegInt.nullable(),
  })),
});

export const DiagnosticsAnswer = z.object({
  ...QueryCommon,
  kind: z.literal("diagnostics"),
  under: z.string().nullable(),
  /** The flag added on top of the project's configuration, or null for the configuration as it is. */
  flag: StrictnessFlag.nullable(),
  /** When a flag is set, only errors the baseline did not already have are listed. */
  added_only: z.boolean(),
  codes: z.array(z.string().regex(/^TS\d+$/)),
  items: z.array(z.object({
    file: z.string().min(1),
    line: z.number().int().positive(),
    code: z.string().regex(/^TS\d+$/),
    message: z.string().max(200),
  })),
});

export const QueryAnswer = z.discriminatedUnion("kind", [RefsAnswer, UnreferencedAnswer, SizesAnswer, DiagnosticsAnswer])
  .superRefine((a, ctx) => {
    if (a.items.length > a.total) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items"], message: `${a.items.length} items listed but total is ${a.total}` });
    }
    if (a.truncated !== (a.items.length < a.total)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["truncated"], message: "truncated must be true exactly when fewer items are listed than were found" });
    }
    if (a.kind === "refs") {
      a.items.forEach((it, i) => {
        if (!it.found && (it.references !== 0 || it.files !== 0 || it.locations.length !== 0)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items", i], message: `${it.name} was not found, so it has no references` });
        }
        if (it.from_tests > it.references || it.locations.length > it.references) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items", i], message: "more test references or locations than references" });
        }
        if (it.locations_truncated !== (it.locations.length < it.references)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items", i, "locations_truncated"], message: "locations_truncated must be true exactly when fewer locations are listed than references" });
        }
      });
    }
    if (a.kind === "unreferenced" && a.total > a.scanned) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["total"], message: "more unreferenced exports than exports scanned" });
    }
    if (a.kind === "sizes") {
      if (a.fitting > a.total) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fitting"], message: "more fitting files than files" });
      a.items.forEach((it, i) => {
        if (it.fits !== (it.rewrite_tokens <= a.ceiling)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items", i, "fits"], message: "fits must equal rewrite_tokens ≤ ceiling" });
        }
        if ((it.declarations === null) !== (it.declarations_fitting === null) || (it.declarations_fitting ?? 0) > (it.declarations ?? 0)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items", i, "declarations"], message: "declarations and declarations_fitting are both counted or both null, and fitting ≤ declarations" });
        }
      });
    }
    if (a.kind === "diagnostics" && a.added_only && a.flag === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["added_only"], message: "added_only needs a flag to be added over" });
    }
  });
export type QueryAnswer = z.infer<typeof QueryAnswer>;

// ── Phase 14d: judgement retrieval — `sidecrew read` (ADR-0090 §2.2, §4 piece 4) ───────────────────

/**
 * The caps, stated in `prompts/phase-14d-retrieval.md`'s 24 Sep amendment **before this code existed**.
 * Changing one changes what a measured `R₁` means, so it needs a dated amendment there first.
 */
export const READ_BUDGET = {
  max_claims: 8,
  max_claim_chars: 300,
  min_quote_chars: 12,
  max_quote_chars: 400,
  max_rendered_chars: 4000,
  max_files: 10,
  max_input_chars: 60_000,
} as const;

export const ReadRefusal = z.enum([
  /** The cited file is not one the question gave the reader. */
  "file_not_given",
  /** The cited lines are not in the file. */
  "lines_out_of_range",
  /** The quote is not inside the cited lines, byte for byte or word for word — its evidence does not exist there. */
  "quote_not_found",
  /** Shorter than the floor, where a quote could be found almost anywhere, or longer than the cap. */
  "quote_size",
  /** A claim with no citation, or a claim longer than the cap: not checkable. */
  "uncited",
  "claim_too_long",
  /** Admitted on its own, and past the answer's claim or character budget. */
  "over_budget",
]);
export type ReadRefusal = z.infer<typeof ReadRefusal>;

export const ReadCitation = z.object({
  file: z.string().min(1),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  quote: z.string().min(READ_BUDGET.min_quote_chars).max(READ_BUDGET.max_quote_chars),
  /**
   * `exact`: the quote is byte for byte inside the lines. `normalised`: it is once line-leading comment
   * markers are removed and whitespace collapsed on both sides — the same words, contiguous and in order
   * (the prompt file's second 24 Sep amendment). Never anything looser.
   */
  match: z.enum(["exact", "normalised"]),
}).refine((c) => c.end_line >= c.start_line, { message: "end_line before start_line" });

export const ReadClaim = z.object({
  claim: z.string().min(1).max(READ_BUDGET.max_claim_chars),
  citations: z.array(ReadCitation).min(1),
});

/**
 * What `sidecrew read` returns: a local worker read the files and answered the question, and **only the
 * claims whose every citation a machine found, byte for byte, are here** (ADR-0090 §2.2).
 *
 * **Admitted means existence, and nothing more.** The machine checked that each quote is where the
 * worker said it is. Whether the claim is *relevant* nobody checked, by design: its cost is capped by
 * `READ_BUDGET` and metered by `R`, and a claim that misleads a plan produces tasks the change gate then
 * fails (ADR-0090 §2.3). There is no survival rate here and none may be computed from it (§3).
 *
 * **Refused claims are counted, never carried** (non-negotiable #3: raw worker output never reaches
 * Claude). The raw answer is on disk at `raw_path` for a person diagnosing the reader.
 */
export const ReadAnswer = z.object({
  version: z.literal(1),
  project: z.string().min(1),
  question: z.string().min(1),
  files: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/), lines: NonNegInt }))
    .min(1).max(READ_BUDGET.max_files),
  worker: z.object({
    kind: z.literal("local"),
    model: z.string().min(1),
    revision: z.string(),
    temperature: z.literal(0),
    seed: z.number().int(),
  }),
  usage: z.object({ prompt_tokens: NonNegInt, completion_tokens: NonNegInt }),
  wall_ms: NonNegInt,
  outcome: z.enum(["answered", "nothing_found", "unparsed"]),
  claims: z.array(ReadClaim).max(READ_BUDGET.max_claims),
  refused: z.record(ReadRefusal, z.number().int().positive()),
  /** Characters of the text rendering Opus reads — what the budget caps. */
  rendered_chars: NonNegInt.max(READ_BUDGET.max_rendered_chars),
  raw_path: z.string().nullable(),
  /** Zero, always: the local tier spends no Claude tokens on the reader (non-negotiable #1). */
  claude_tokens: z.literal(0),
}).superRefine((a, ctx) => {
  if ((a.outcome === "answered") !== (a.claims.length > 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome"], message: "outcome is answered exactly when at least one claim was admitted" });
  }
  const given = new Set(a.files.map((f) => f.path));
  const lines = new Map(a.files.map((f) => [f.path, f.lines]));
  a.claims.forEach((c, i) => c.citations.forEach((cite, j) => {
    // The one check a schema can make without the file: the citation points inside a file it was given.
    if (!given.has(cite.file) || cite.end_line > (lines.get(cite.file) ?? 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["claims", i, "citations", j], message: `${cite.file}:${cite.start_line}-${cite.end_line} is not inside a file the question gave` });
    }
  }));
});
export type ReadAnswer = z.infer<typeof ReadAnswer>;
