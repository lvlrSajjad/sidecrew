// Pipeline contracts — MUST mirror docs/specs/pipeline.md.
// test/schemas.test.ts parses every ```json block of that file with the schemas below, so the two
// cannot drift: change one and the other fails.
import { z } from "zod";

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

export const TestShape = z.object({ kind: ShapeKind, exemplar: z.string(), rules: z.string() });
export type TestShape = z.infer<typeof TestShape>;

/** What the worker is told about a shape. No exemplar *path* — it gets the exemplar's text instead. */
export const WorkerShape = TestShape.omit({ exemplar: true });
export type WorkerShape = z.infer<typeof WorkerShape>;

export const PlannedFunction = z.object({
  name: z.string().min(1),
  signature: z.string().min(1),
  source_sha: Sha,
  line_range: z.tuple([NonNegInt, NonNegInt]),
  shapes: z.array(ShapeKind).min(1),
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

const CandidateFields = z.object({
  task_id: z.string().min(1),
  worker: z.object({
    kind: WorkerKind,
    model: z.string().min(1),
    revision: z.string(),
    // Determinism is a non-negotiable, not a default: a candidate produced at temperature > 0 is not
    // reproducible and its verdict says nothing about the model. Both tiers can honour temperature 0.
    temperature: z.literal(0),
    /** null only on the api tier, which offers no seed. See the refinement below. */
    seed: z.number().int().nullable(),
  }),
  test_source: z.string(),
  usage: z.object({ prompt_tokens: NonNegInt, completion_tokens: NonNegInt }),
  timing: z.object({ ttft_ms: Millis, wall_ms: Millis }),
});

export const Candidate = CandidateFields.superRefine((c, ctx) => {
  // A local worker has no excuse: same seed, same output, or the bench in Phase 1 is measuring noise.
  // The API tier cannot offer one, and pretending otherwise by writing a seed we never sent would make
  // the record say something untrue.
  if (c.worker.kind === "local" && c.worker.seed === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["worker", "seed"], message: "a local worker must record the seed it ran with" });
  }
});
export type Candidate = z.infer<typeof CandidateFields>;

export const MutationResult = z.object({
  /** killed / (killed + survived). Equivalent mutants make a low score a review signal, not a failure. */
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
