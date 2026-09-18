# Reading a Verdict

Survive ⇔ `compile_ok ∧ pass_ok ∧ ¬tautological ∧ mutation.killed ≥ 1`. `src/schemas.ts` enforces that as
an iff, so a `Verdict` whose `survived` disagrees with its own fields does not parse.

| stage | what ran | fail means |
|---|---|---|
| tautology | static check on the candidate's text | constant assertions, `x == x`, snapshot-only, never calls the function → retry with the finding, which names the line and the reason. Runs first and for free, and skips the mutation stage when it fires |
| compile | `tsc --noEmit` / `swift build --build-tests` | wrong import, signature or type → retry with the compiler's error |
| pass | `vitest run <file>` / `swift test [--filter]` | the assertion is wrong about real behaviour → retry with the failing assertion text |
| mutation | Stryker / Muter, scoped to the **function's line range** | `killed == 0` → read the next section before retrying |

## `stage_reached` is progress, not a failure code

| value | meaning |
|---|---|
| `compile` | stopped in compile |
| `pass` | stopped in pass, or skipped mutation because the verdict was already settled |
| `mutation` | the stage ran and produced no report — the mutation tool crashed or timed out |
| `done` | every stage ran; `mutation` holds the result |

**`mutation` is not about the candidate.** The test may be fine and the tool broken. A retry loop that
cannot tell it from `pass` retries a machine problem at the worker's expense, twice, and then escalates
it to Claude. Do not consume the retry on it (ADR-0012).

## Three failures do not get the retry

`runBatch` retries everything else once, with the error appended to the prompt — including a tautology,
because the detector's finding names the line and the reason and that is the most actionable thing a
retry can carry. The exceptions are the ones that are not the candidate's fault, or that a retry cannot
change:

| condition | why not |
|---|---|
| `stage_reached === "mutation"` | the mutation tool produced no report — a machine problem (ADR-0012) |
| all four mutation counts are `0` | nothing in that function could be mutated (ADR-0005), below |
| the retry prompt would be byte-identical to the first attempt's | generation is deterministic at temperature 0 with a fixed seed, so the second candidate *is* the first one and the second verdict *is* the first one (ADR-0022) |

`src/batch.ts`'s `shouldRetry` is the one implementation of the first two rows, and `test/batch.test.ts`
has a case per row. The third is in the loop rather than in `shouldRetry`, because it is a fact about two
prompts and not about a verdict; it fires when the verifier had nothing quotable to say.

The retry prompt is `src/prompts/worker.md` plus `src/prompts/retry.md`, in that order, so it **contains**
the first attempt's prompt verbatim and adds the failure to the end (ADR-0022).

## `killed == 0` has two causes and only one is the test's fault

Check the counts, not just `killed`:

- `killed + survived + timeout + no_coverage > 0` → mutants existed and the test caught none of them.
  **That is the test's fault. Retry with "your test killed no mutants".**
- all four are `0` → **nothing could be mutated**, so no test of that function could ever have killed
  anything. Retrying is spending the one retry on a test that was never the problem. The `error` text
  says which case it is.

  It happens in both languages and for opposite reasons. On **Swift**, Muter's whole operator set is
  `RelationalOperatorReplacement`, `RemoveSideEffects`, `ChangeLogicalConnector`, `SwapTernary`, so a
  function with no branch, connector or ternary has no mutants (ADR-0005). On **TypeScript**, Stryker has
  several dozen operators and its type checker throws the results away: measured on the fixture,
  `nextState(state, event) { return TRANSITIONS[state][event] ?? state; }` has zero mutants, because
  `?? → &&` changes the return type and an emptied body returns nothing, so every mutant is a type error
  (ADR-0016). The stricter the types, the more of this there is.

  A function like that should never have been planned. If one reaches a run, the plan is what to fix —
  `scripts/probe-mutants.ts` answers it before a plan is written, and `crash_only` is one of its four
  answers.

  **A test can also turn a killable mutant into a crash.** If it reaches the function under test through
  a sibling that the mutant breaks — `Machine.nextState` force-unwraps behind a `canTransition` guard,
  so a mutated `canTransition` crashes it — the process dies before the failing assertion is reported,
  and a correct test comes back `killed 0`. Same counts, and this one *is* the test's fault: rewrite it
  to call the function under test directly.

## The score

`mutation.score` is the mutation-testing standard — `(killed + timeout) / (killed + timeout + survived +
no_coverage)`, and `0` when that denominator is `0`. It is *not* `killed / (killed + survived)`.

**Survival does not follow the score**, and the asymmetry is deliberate: `killed ≥ 1` counts real kills
only. A mutant that hung the suite (Stryker `Timeout`) or crashed the process (Muter `runtimeError`)
counts towards the score and never towards survival, because it is a mutant nothing *asserted* about
(ADR-0012, ADR-0005).

Equivalent mutants can never be killed, so a low score is a review signal and not automatically a
failure. Survival requires `killed ≥ 1`, never a score threshold.

**A Swift score is coarser than a TypeScript one and does not mean the same thing.** A function-scoped
Swift verdict is computed over one or two mutants — the median on the fixture is 1 — against six to
twelve on TypeScript, because four operators do not find much in a small function. Do not compare the
two languages' scores, and do not use one threshold for both.

## Survival is a filter, not an endorsement

A test can kill every mutant and still pin a bug — a snapshot of today's wrong output does exactly that,
and both fixtures have a planted off-by-one that proves it on demand. That is why survivors below the
review threshold still get Claude's eyes.

## Which survivors reach Claude

Survival is a filter; the score is the router (ADR-0006, ADR-0024). `sidecrew_review` selects:

- every survivor **below** the threshold, weakest first, plus
- a deterministic **10 %** audit sample of the survivors the threshold passed over.

**The threshold is per language and the two are not interchangeable.** Defaults: **0.6** on TypeScript,
**1.0** on Swift. A Swift verdict is computed over one or two mutants, so a Swift survivor scores 1.00 by
construction whenever the denominator is 1 — 0.6 there selects nothing at all, and 1.0 reads "it left a
mutant alive out of the one or two it had".

The audit sample is drawn from `sha256(run_id:task_id)`, so asking twice about one run asks about the same
tests. It is the part that catches the router being wrong, and skipping it because the scores look fine is
skipping the only check on the scores.

Batches are capped at an estimated token count. An item larger than the cap on its own gets a batch to
itself — nothing is dropped, because the longest survivor is the one most likely to be doing something odd.

## There is a second gate now, and it is not this one

Everything above is **workload #1**: generating unit tests, gated by `compile → run → mutation-kill`.
Phase 10 added **workload #2a** — behaviour-preserving changes to code that already exists — and its gate
is a different object with different rules:

```
survives ⇔ the diff was confined to the task's files
         ∧ tsc clean in those files, with no error introduced anywhere else
         ∧ every test that passed before still passes, on a suite that actually ran
```

Three things worth knowing before you reason about a `ChangeVerdict`:

- **The sandbox keeps the project's tests**, which is the opposite of what ADR-0004 does above — here the
  suite *is* the gate, and a change that edits a test file is refused for editing the instrument
  (ADR-0046). The comparison is a **baseline** captured before the change, so *every test that passed
  before still passes* — never *everything is green*, because a project with pre-existing failures is
  normal.
- **Seven cheap ways to pass are blocked by name** (ADR-0048): `path_outside_task`,
  `build_config_edited`, `test_file_edited`, `suppression_added`, `any_escape_added`,
  `deletion_without_replacement`, `no_edit_at_all`. Four of them leave a project `tsc` is perfectly happy
  with, so "it compiles and the tests pass" is *not* the rule and must not be quoted as one.
- **There is no MCP tool for it yet, and no planner.** `sidecrew fix <change_plan.json>` is the CLI, plans
  are written by hand, and the agent that writes them is Phase 12 (ADR-0044). Do not tell anybody to call
  a `sidecrew_fix` tool: there isn't one.

`docs/specs/pipeline.md` § *Workload #2a* has the contracts. No survival rate exists for this workload;
Phase 11 produces the first one, against a rule frozen before anybody had seen a number.
