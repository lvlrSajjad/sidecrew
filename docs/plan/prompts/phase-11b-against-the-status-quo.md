# Phase 11b — sidecrew against not using sidecrew

Read `docs/plan/VISION.md`, `docs/plan/ROADMAP.md` §1.1, then
`experiments/go-no-go-2a/results/REPORT.md` and the protocol it ran against
(`experiments/go-no-go-2a/README.md`, §4 frozen before any number existed). Then this.

> **§4 of this prompt is frozen the day it is written and before any arm has run**, on the same
> terms Phase 11's was: do not edit it during or after the run; anything learned about it is
> appended below, dated. A rule written after a number is a description of that number.

## 1. The question, and why no existing number answers it

Every measurement in this repository compares **a 7B against Haiku inside sidecrew**, behind the
same gate, on the same tasks. That answers *which worker should sidecrew hire*.

It does not answer the only question a colleague asks: **is this better than what I do now?** And
"what I do now" is asking Opus or Sonnet directly, in Claude Code, with no plan, no gate and no
review pass.

Phase 11 produced `S = 12/12` and `A = 0.900` and those numbers are real, but they are about the
inside of the tool. Nothing in this repository supports a claim of improvement over the status quo,
and the README should not make one until this phase exists.

**It is also the most publishable thing here.** The literature compares models with models. It very
rarely compares *model + verification harness* against *model alone* on the same work, with cost and
a blind quality judgement on both sides.

## 2. Inputs — identical for every arm

- The **same unmodified real projects** Phase 11 used, and the **same plans**, so the tasks are
  literally the ones already measured. Reuse `experiments/go-no-go-2a/plans/project-a.json` and
  `project-b.json` — renamed and **untracked** since Phase 12 (CLAUDE.md #7: `project` is an absolute
  path into a client checkout and a rename ask quotes the client's own symbols). They are on disk and
  the harness reads them; do not re-add them, and see `phase-11b-handoff-from-12.md` §1.

  **What being untracked costs, and how to pay it.** The experiment's inputs are then not in the
  repository, so a reader cannot re-run it and a disk failure loses the plans. That is the right
  trade — it is not our code to publish — but it means the *committed* record has to carry enough to
  describe the experiment without it: task count, the shape mix, and the properties each task turned
  on. Put those in the results JSON rather than leaving them only in a file nobody else can see.
- **More tasks than Phase 11 had.** Twelve is too few: Phase 11's intervals ran `[0.555, 0.997]` and
  its survival rate saturated at 1.00 and could rank nothing. Target **40 per project**, extending
  the existing plans with the same discipline (disjoint files, validated with `--dry-run`, §2's
  three denominator exclusions applied by hand before the run).
- **Task shapes must be mixed and reported separately.** Every real task so far is a rename or an
  unused-import removal. Add null guards, an API migration and dead-code removal. If the shapes are
  not reported apart, the number means nothing — see §5.

### 2.1 Which sidecrew arm C is, and why not the one Phase 11 measured

Phase 12 added a worker refusal shape (`--- CANNOT: reason ---`) to `src/prompts/fixer.md` in
`6c161de`, after Phase 11's arms ran. Arm C is therefore **not byte-comparable with Phase 11's C2**,
and there is a real choice here rather than an accident to paper over.

**Decision: run arm C on the current sidecrew, and do not pin the old template.** Two reasons.

1. **11b's validity is internal.** It compares A, B, C and D against each other on the same tasks in
   the same run. Comparability with Phase 11 is a nice-to-have; comparability *within* this run is
   the whole experiment, and pinning an old prompt does nothing for it.
2. **Pinning would measure a sidecrew nobody will ship.** The question is whether the tool a
   colleague installs beats asking Opus directly. That tool has the refusal shape in it.

**What this costs, and it must be in the report rather than discovered:** the refusal shape gives
the worker a new exit, so arm C's survival rate is not directly comparable with Phase 11's `S(C2)`.
A worker that can say *"I cannot do this"* may refuse where it previously produced a bad candidate —
which would **lower S and raise precision at the same time**, and those two moving together is
exactly the confound this phase exists to avoid confusing with a real improvement. Count refusals as
their own funnel row and report them beside S, never folded into it.

### 2.2 The task-shape requirement is now doubly load-bearing

§4.4 below already refuses a verdict if the tasks are all renames and unused-import removals. Phase
12 found a second, independent reason for the same requirement, and it is worth stating because two
phases now depend on one property of the task set.

**Measured across Phase 11's six arms: `retried = 0` on all 54 tasks.** Read off
`experiments/go-no-go-2a/results/partials/*.json`, not the prose. Not one task failed in a way that
earned even the mechanical retry — everything either survived first attempt or was lost to a machine
error. So Phase 12's correction round has a denominator of **zero** on every task this repository
has measured, and cannot be evaluated on them at all.

Renames and unused-import removals are, it turns out, too easy to fail. That makes §4.4's
requirement and Phase 12's §2.2 the *same* constraint: **the task set must contain null guards, API
migrations and dead-code removal, or neither phase gets a verdict.**

This is the only coupling between the two phases. Neither verdict may assume the other ran.

## 3. The arms

| id | what it is | what it costs |
|----|---|---|
| **A** | **Opus alone.** The ask, the files, no plan, no gate, no review. What a colleague does today. | Opus tokens for everything |
| **B** | **Sonnet alone.** Same, cheaper model. | Sonnet tokens |
| **C** | **sidecrew.** Local 7B behind the gate; Opus plans and reviews survivors only. | planning + review; workers free |
| **D** | *(optional)* **Opus alone, then the gate applied afterwards.** | Opus tokens + gate |

**D is the arm that isolates the gate from the worker**, and it is the one that makes this a
scientific result rather than a product comparison: if D beats A on precision, the *gate* is doing
the work, independently of who wrote the code — which is the thesis stated in `VISION.md`. Run it if
budget allows; it is cheap, because A's diffs already exist.

Arms A and B must be driven the way a person drives them — one ask at a time, no frozen-rule
scaffolding — or the comparison flatters C by construction. Record the exact prompt used.

## 4. The decision rule — frozen before any arm has run

### 4.0 Precondition
The same as Phase 11 §4.0, plus one this phase needs: **the reviewer must be blind to the arm**, and
A, B, C and D are reviewed in **one shuffled pass per project**. An unblinded comparison against
"what I do now" is worthless, because the reviewer knows which one is supposed to win.

### 4.1 The measured quantities

Per arm, per project, never pooled:

- **P(x)** — **precision**: the blind approval rate, defined exactly as Phase 11 §4.1's `A(x)`. The
  fraction of *delivered* changes a blind reviewer would have accepted. For C, delivered means
  survivors. **For A and B, delivered means everything they produced**, because a person using Opus
  directly has no gate throwing anything away. That asymmetry is the point and must not be
  smoothed over.
- **T(x)** — **tokens**, split planning / doing / review, and priced.
- **W(x)** — wall clock per task, reported, never a criterion (Phase 11 §4.2's reasoning holds: the
  expensive stage is the project's own suite and it is identical across arms).
- **E(x)** — **escaped defects**: delivered changes the blind reviewer rejected. The number that
  matters to a user, and the one a survival rate hides.

### 4.2 The rule

The owner's bar, 18 Sep 2026, in the owner's terms:

> If performance and precision increase with the same token usage it's still a win.

- **WIN** — `P(C) ≥ P(A)` and `T(C) < T(A)`. Same precision, cheaper.
- **WIN** — `P(C) > P(A)` and `T(C) ≤ T(A)`. Better precision, no dearer.
- **PARTIAL** — `P(C) ≥ 0.95 · P(A)` and `T(C) ≤ 0.5 · T(A)`. Slightly worse, much cheaper: ship it
  with the number stated, the way ADR-0020 set the precedent.
- **LOSS** — `P(C) < 0.95 · P(A)` at any token cost. **Precision is the veto**, for the reason
  Phase 11 established: a tool that delivers changes a reviewer would reject is worse than one that
  delivers nothing, because the second failure is visible.

`E(C) > E(A)` is a **LOSS regardless of every other cell.**

### 4.3 The prediction, recorded before the run

Written now so it cannot be adjusted afterwards: **Opus alone will probably match or beat C on
precision.** It is a much stronger model and these tasks are small. The plausible win for C is
**cost at equal precision**, and the plausible win for the *thesis* is arm D — the gate improving a
model's output independently of which model it is.

If C loses on precision, that is a real result and it is publishable. Say so.

### 4.4 The clause that says the number is not about the tool

If the tasks are all renames and unused-import removals — the only shapes measured so far — then a
WIN says only that **sidecrew is competitive on trivial changes**, which nobody doubted. At least
half the tasks must be null guards, API migrations or dead-code removal for §4.2 to be applied at
all. Otherwise report the cells and withhold the verdict.

## 5. What to measure

Per arm × project × task shape:

- P, T, E with exact 95 % intervals, per shape as well as overall;
- the funnel for C (Phase 11's) and, for A and B, how many of their changes **would have** failed
  the gate — that is the gate's value, measured directly;
- **refusals, as their own row, beside both S and T.** Phase 12 added a worker refusal shape, and the
  fields are `FixResult.stats.refusals` (task-level; a task counts if any attempt refused),
  `ChangeVerdict.refused` (per attempt, the worker's sentence) and `ChangeEscalation.refused`
  alongside `machine_failure`. The schema refuses a verdict that is both refused and survived, and
  the parser is strict — only a literal `--- CANNOT: reason ---` with **no edits at all** counts, so
  hedging prose does not quietly leave the denominator.

  **The denominator for a worker-quality claim is therefore**
  `tasks − survived − refusals − machine_failures`: what actually reached the gate and failed it.
  Using `tasks` flatters nothing and using `survived / tasks` understates the worker; say which one
  a number is.

  **And refusals move two metrics at once.** A refusal short-circuits at `generate` — no sandbox, no
  `tsc`, no suite — so it costs ~13.5 s against a 262 s gate. If arm C's refusal rate is non-trivial
  its cost-per-task *improves* while its survival rate *falls*, for the same underlying reason. That
  is a second pair of metrics moving together, on top of the precision/survival pair in §2.1, and
  both must be reported with the refusal rate next to them or the comparison reads as a win that is
  really an abstention.
- **`observations` must not enter the blind pack.** Phase 12 put non-gating `observations` on every
  verdict (ADR-0057) — the gate's note that a change did something it was not asked to, such as
  editing documentation. They are not part of a diff, they exist on **one arm only**, and a pack
  carrying them would tell the reviewer which arm wrote the item. That defeats §4.0's blindness
  requirement, which is the thing that makes `P(x)` mean anything at all.

  They are still worth having: an `observation` is a **free, mechanical read on `E(x)`**, available
  without spending a reviewer. Report it beside the blind rate, never folded into it, and treat
  agreement between the two as a result in its own right — if the gate's observations predict the
  blind reviewer's rejections, that is a cheap proxy for an expensive judgement, and if they do not,
  that is worth knowing before anyone relies on them.
- tokens priced in dollars at current rates, because that is the unit a colleague compares in;
- wall clock, reported;
- every threat Phase 11 listed, plus: the person driving A and B is not a neutral party.

## 6. Do not

- Do not let C's arm use anything A cannot. If C gets a hand-written plan, A gets the same
  information in its prompt.
- Do not report a pooled figure across shapes or projects.
- Do not run this before the tasks are extended past renames (§4.4).
- Do not adjust §4 after seeing a cell.
