// Can this function be survived at all?
//
// Not the same question as "does it have mutants", and Swift is where the two come apart. `killed`
// counts only mutants a test reported a *failure* against; a mutant that crashes the process lands in
// `timeout`, counts towards the score and never towards survival (ADR-0005 §2, ADR-0012). So a function
// whose only mutant crashes has a mutant and can still never be survived by any test.
//
// It lives in src/ rather than in the script because ADR-0018 made it a rule the planner is held to —
// plan only what comes back `yes` — and a rule with a test is worth more than a rule in a comment.
export type Plannable = "yes" | "no_mutants" | "crash_only" | "unknown" | "not_measured";

import type { Stage } from "../schemas.js";

export interface MutantCounts {
  mutants: number;
  killed: number;
  survived: number;
  timeout: number;
  /**
   * Mutants no test reached. Added in ADR-0033, because without it an **all-`NoCoverage`** result — the
   * exact shape of "the runner never found the test file" — reached `return "unknown"` and printed
   * *"0 mutant(s) survived this probe; weak probe, or equivalent"*: a statement about the test, when
   * what happened is that jest ran nothing. ADR-0030 closed this hazard for a stage that did not
   * complete and left this one open, because the stage completes perfectly well.
   */
  no_coverage?: number;
}

/**
 * `yes` — a mutant died of an assertion, so the function is demonstrably survivable.
 * `no_mutants` — nothing to kill.
 * `crash_only` — every mutant crashed rather than failing an assertion; no test can ever kill one.
 * `unknown` — mutants survived this probe. Either it was a weak probe or they are equivalent, and only
 *   looking at them settles it. That is why this is not a boolean: "we have not checked" is an answer,
 *   and rounding it to either of the other two would be a guess the planner then acts on.
 * `not_measured` — nothing about this function's mutants was observed: the probe never reached the
 *   mutation stage, or it reached it and every mutant came back uncovered, which means the runner never
 *   ran the test. **This is the one that used to be reported as `no_mutants`**, and the difference is the
 *   difference between "do not plan this function" and "fix your machine". Found on a real project
 *   (ADR-0030): `tsc` ran out of heap and Stryker could not load its plugins, and eleven perfectly
 *   ordinary functions came back "NOT PLANNABLE — no mutants at all". Every count is zero in both cases,
 *   which is why the counts alone cannot tell them apart.
 */
export const classifyProbe = (p: MutantCounts, stageReached: Stage = "done"): Plannable => {
  // Asked first, because every other branch below reads counts that only mean something once the stage
  // that produces them has run. `mutation` means the tool itself broke (ADR-0012), which is also not a
  // statement about the function.
  if (stageReached !== "done") return "not_measured";
  if (p.killed >= 1) return "yes";
  if (p.mutants === 0) return "no_mutants";
  // Every mutant present and none of them reached: the runner did not run the test, whatever the reason.
  // Nothing was learned about the function, so this is the same answer as a stage that never ran.
  if ((p.no_coverage ?? 0) === p.mutants) return "not_measured";
  if (p.survived === 0 && p.timeout > 0) return "crash_only";
  return "unknown";
};
