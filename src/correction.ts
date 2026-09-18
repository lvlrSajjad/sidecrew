// ADR-0044 §4 option B: **one Opus-written note per task, after the mechanical retry has failed.**
//
// The design's whole risk is that this becomes "Opus reviews everything", and the thing that stops it is
// not a convention — it is that the function which writes a correction **cannot reach the candidate**.
// `brief()` takes a `ChangeVerdict` and returns text; a `ChangeCandidate` is not in its signature, so
// rule 1 is a type error rather than a promise:
//
//   > **Fed by the gate, never by raw output.** Non-negotiable #3 says Claude sees survivors only. A
//   > correction is written from the verdict and from what the gate itself extracted […] Opus does not
//   > read the candidate's diff to write a correction. That is the line between B and "Opus reviews
//   > everything". — ADR-0044 §4 rule 1
//
// `experiments/correction-round/README.md` §4.0 precondition 2 makes that a *void run* condition: if the
// separation is only a convention, the measurement is worthless, because what was measured is not the
// mechanism ADR-0044 decided.
//
// **What this file does not do.** It does not call a model. The note is written by Opus — the session
// driving the run — and handed back through `RunFixOpts.correct`. Putting an API call here would make a
// `fix` run on the local tier spend Claude tokens from inside the library, which is the guarantee
// `schemas.ts` exists to enforce; instead the caller supplies the writer and the run accounts for what
// it spent.
import type { ChangeShape, ChangeVerdict, CorrectionBudget } from "./schemas.js";

/**
 * Everything a correction may be written from, and nothing else.
 *
 * Note what is absent: the candidate, its edits, its diff, and the worker's raw text. A reader who wants
 * to add one of those should read ADR-0044 §4 rule 1 first — and then
 * `experiments/correction-round/README.md` §4.0, which voids the run rather than adjusting for it.
 */
export interface CorrectionBrief {
  task_id: string;
  shape: ChangeShape;
  /** The gate stage that stopped it, or `done` when it survived and carries only observations. */
  stage: ChangeVerdict["stage_reached"];
  /** One sentence per thing the gate found, in the order a fixer should act on them. */
  findings: string[];
  /** True when the candidate **passed** and this is the survivor case (ADR-0057). */
  on_observation: boolean;
}

/**
 * The verdict, reduced to the sentences a correction can be written from.
 *
 * Ordered by what a worker can act on, which is the same ordering `shouldRetryChange` uses and for the
 * same reason: a named confinement rule is the most actionable thing this gate produces, a compiler
 * message is next, and "a test regressed" is last because it says the least about what to change.
 */
export function brief(verdict: ChangeVerdict, shape: ChangeShape): CorrectionBrief {
  const findings: string[] = [];

  for (const b of verdict.confinement) {
    findings.push(`${b.rule} in ${b.file}: ${b.detail}`);
  }

  const remaining = Object.entries(verdict.errors.remaining_in_target);
  if (remaining.length > 0) {
    findings.push(`still ${remaining.map(([f, n]) => `${n} tsc error(s) in ${f}`).join(", ")}`);
  }
  const introduced = Object.entries(verdict.errors.introduced);
  if (introduced.length > 0) {
    findings.push(`the change introduced ${introduced.map(([f, n]) => `${n} tsc error(s) in ${f}`).join(", ")}`);
  }
  if (verdict.errors.message !== null) findings.push(`the compiler said:\n${verdict.errors.message}`);

  if (verdict.tests !== null && verdict.tests.regressed.length > 0) {
    const names = verdict.tests.regressed.slice(0, 10);
    findings.push(
      `${verdict.tests.regressed.length} test(s) that passed before now fail: ${names.join(", ")}` +
      (verdict.tests.regressed.length > names.length ? ", …" : ""),
    );
  }

  for (const o of verdict.observations) {
    findings.push(`${o.kind} in ${o.file}: ${o.detail}`);
  }

  return {
    task_id: verdict.task_id,
    shape,
    stage: verdict.stage_reached,
    findings,
    on_observation: verdict.survived,
  };
}

/**
 * Should this verdict get a correction at all, given what the run has already spent?
 *
 * Three refusals, and each one is a way the §2.2 measurement would otherwise be wrong rather than a
 * micro-optimisation:
 *
 *   * **A machine failure gets no correction.** There is nothing for a worker to do differently about a
 *     runner that produced no report (ADR-0012) — a note spent here is an Opus token bought against a
 *     denominator that should have excluded the task (ADR-0056).
 *   * **A refusal gets no correction.** The worker said the task cannot be done inside these files. If
 *     it is right, the answer is a better plan; if it is wrong, that is a planner defect. Either way
 *     the sentence to write is not addressed to the worker.
 *   * **Nothing quotable gets no correction.** A brief with no findings is a note that would say "try
 *     again", which ADR-0022 already proves is a wasted verdict against a deterministic worker.
 */
export interface CorrectionGate {
  write: boolean;
  reason: string;
}

export function shouldCorrect(
  verdict: ChangeVerdict,
  budget: CorrectionBudget,
  spent: { written: number; tokens: number },
): CorrectionGate {
  const survivorCase = verdict.survived;

  if (survivorCase && verdict.observations.length === 0) {
    return { write: false, reason: "survived with nothing observed" };
  }
  if (survivorCase && !budget.on_observations) {
    return {
      write: false,
      reason: "correcting a survivor is the ADR-0057 case and is off separately — ADR-0044 §4 never " +
        "contemplated spending tokens on a change that already passed",
    };
  }
  if (!survivorCase && !budget.enabled) return { write: false, reason: "the correction round is off (ADR-0044 §4 rule 2's default)" };

  if (verdict.refused !== null) {
    return { write: false, reason: "the worker refused with a reason — that is a plan problem, not a worker one" };
  }
  if (verdict.tests !== null && !verdict.tests.reported) {
    return { write: false, reason: "the test runner produced no report — a machine failure, and a note cannot act on it (ADR-0012)" };
  }
  if (spent.written >= budget.max_corrections) {
    return { write: false, reason: `the run's budget of ${budget.max_corrections} correction(s) is spent` };
  }
  if (budget.max_tokens > 0 && spent.tokens >= budget.max_tokens) {
    return { write: false, reason: `the run's correction token cap of ${budget.max_tokens} is spent` };
  }
  if (brief(verdict, "rename").findings.length === 0) {
    return { write: false, reason: "the gate had nothing quotable to say, so a note would only say `try again` (ADR-0022)" };
  }
  return { write: true, reason: survivorCase ? "survived, with observations (ADR-0057)" : "failed the gate with something a note can act on" };
}

/**
 * What the run hands the writer, rendered.
 *
 * Text rather than an object because the writer is a language model and this is its prompt; keeping the
 * rendering here rather than at the call site is what makes "a correction was written from the verdict"
 * checkable by reading one function.
 */
export const renderBrief = (b: CorrectionBrief): string => [
  `Task ${b.task_id} (${b.shape}) ${b.on_observation ? "passed the gate, but the gate observed" : `failed at ${b.stage}`}:`,
  ...b.findings.map((f) => `  - ${f}`),
  "",
  b.on_observation
    ? "Write one sentence telling the worker what to leave alone next time. It does not describe the code; " +
      "it names the thing the ask did not call for."
    : "Write one short note telling the worker what to do differently. Name the specific thing the gate " +
      "found. Do not write the fix yourself, and do not describe code you have not been shown.",
].join("\n");
