# Phase 14c — the reach: symbol-scoped return

Read `CLAUDE.md`, `docs/plan/HANDOFF.md`, `docs/plan/PHASES.md` § *14c*, `docs/specs/pipeline.md` and
**ADR-0075** before anything. ADR-0075 is **decided — option C** — so this phase builds rather than
chooses.

**The exit check below was frozen on 22 Sep 2026, before this phase started and before any number
existed.** Everything in §3 and §4 is the frozen part. Amend below it, dated, never in place.

## 0. What this phase is, in one paragraph

Half a real codebase is unaddressable and it is the half the work is in — **3.3 % of files are 48.1 %
of the bytes**, and a task is refused outright when its files cost more to rewrite than a worker's
output budget. That is the **return format**, not the model: a worker returns whole files (ADR-0047
§2). Option C makes the task name a *declaration*, the worker return **that declaration's new text**,
and sidecrew splice it back by AST range — so the model never writes a line number and confinement
stays decidable before a byte is written.

## 1. What "previously refused" means, exactly

Not "1000+ lines" — that is the description, not the rule. The rule is
`fix-validate.ts`'s **`files_too_large_to_rewrite`**: `rewriteCost(sources) > MAX_FIX_TOKENS`, and
`MAX_FIX_TOKENS` is **8192** (`src/fix.ts`). A task is *previously refused* iff it is refused by that
clause against the code as it stands **before** this phase changes anything.

**Record the refused set before you start.** It is the denominator of `Reach` and the population
`S_big` is drawn from, and it cannot be re-derived afterwards — the whole point of the phase is that
the clause stops firing.

## 2. The trap that would void this phase, and it is new

**`S_small` may NOT be taken from Phase 11, the go/no-go, or any number published before 22 Sep 2026.**

The gate changed twice that day:

- **ADR-0084** — a regression-only failure is re-read once and the second reading decides. Every rate
  before it is biased **low** by roughly 6 %.
- **ADR-0077 option B** — a type error pushed into a test file is demoted, **under added strictness
  flags only**. On the shape it was measured on, that moved survival from 2/30 to a counterfactual 14/15.

So an old `S_small` and a new `S_big` are two different gates, and the ratio between them would measure
this phase plus yesterday's two decisions. **`S_small` is re-measured in this phase, in the same run,
under the same settings, on the same project.** That is `PHASES.md`'s *"same project and the same
declared task set"* clause, one level deeper than it was written.

**Record the gate settings in the result**: `retry_regressions`, `demote_test_type_errors` and
`compiler_flags`, all of which the verdict now carries. A number whose gate is not recorded cannot be
compared with anything later, which is the lesson ADR-0080 and the 21 Sep provenance gap both cost.

## 3. The rule is frozen. Copy it, do not restate it.

`PHASES.md` § *14c* → *Exit check*. `Reach` is the addressable share **by bytes**; `S_big` is survival
on tasks in files the §1 clause previously refused; `S_small` is survival on files that were always in
reach, **measured in the same run**.

| | |
|---|---|
| `Reach ≥ 0.85` **and** `S_big ≥ 0.75 × S_small` | **PROCEED to 14d** |
| `Reach ≥ 0.85` **but** `S_big < 0.75 × S_small` | **INSERT `14c′`** — *a big change is not a big file* |
| `Reach < 0.85` | **STOP** and re-open ADR-0075; option D is a different phase, not a patch |

**Every rate is an interval, never a point** — `D > 0.10` made that a standing rule and the intervals
are exact Clopper–Pearson (`scripts/results-11b.py`). At the plan sizes this phase will use, the
intervals for `S_big` and `S_small` will overlap. **Say so.** A ratio between two overlapping intervals
is a direction, not a result, and reporting it as one is the mistake §4.5 warns about.

**Declare the task set before the first token.** Write it to `experiments/` with the refused set from
§1, and do not add to it, drop from it, or re-plan it after seeing a verdict. A set adjusted after
seeing failures is the §4.0 precondition 4 violation, and it is the easiest one to commit by accident
here because the refused set is interesting to look at.

## 4. How to run it without poisoning the number

**The build is 2–3 sessions and needs nothing special. The measurement is one run of 2–4 hours and
needs a quiet machine** — that is the real constraint, not the clock. Derived from probe 1: generation
~87 min on a 14B at concurrency 1 (use the **7B at 2**, the README says the 14B is never the trade
here), compile ~18 s per candidate, suite **~225 s per candidate that compiles**. The suite is only
paid by candidates that get that far, so **a successful 14c run costs more than a failed one** — and
ADR-0084's retry adds a second suite run for every candidate that fails on regressions.

- **Never swap.** ADR-0066's original false negative *was* a swapping machine, and `D` is still not
  fully explained. `doctor` before, and the verdict brackets each evaluation.
- **Do not span 02:00 local** (00:00 UTC). ADR-0083: `project-a` moves three tests at the UTC boundary.
  Warnable now, free to avoid.
- **Clean trees, both of them.** A `tsx` harness compiles uncommitted edits into a run invisibly, and
  the *project's* tree moves too — it moved twice on 21 Sep alone. Record its commit; the harnesses do.
- **Run the slow set before the phase ends**: `SIDECREW_SLOW=1 npx vitest run test/fix.slow.test.ts`.
  Nothing in CI does, and an assertion in it had been stale since ADR-0054 without anyone noticing.

## 5. What "done" looks like

- The contract change lands **with its `docs/specs/pipeline.md` update in the same commit** (CLAUDE.md).
- Confinement is still decidable **before** anything is written, and a test asserts it.
- **A control fixture per new failure mode**, and the coverage test that every `ConfinementRule` has one
  still passes.
- `Reach`, `S_big` and `S_small` measured against §3, with intervals, gate settings and both projects'
  commits recorded.
- The fork §3 names is applied **as written** — PROCEED, INSERT `14c′`, or STOP.
- `PHASES.md` status, an ADR for anything decided, a `CHANGELOG` line, and **`HANDOFF.md` current**.

**`Reach < 0.85` is a complete result, not a failed phase.** Report it without going looking for a cut
of the data where it passes — the sentence §2.2 and 14b both earned.
