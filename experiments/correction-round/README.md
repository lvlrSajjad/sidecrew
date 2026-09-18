# Does the correction round pay for itself? (Phase 12 §2.2)

**Question:** when a worker fails, is one Opus-written sentence cheaper than handing the whole task to a
paid model — and does what comes back survive for the right reasons?

This file is the **frozen artefact**. §4 below was written on 2026-09-18, during Phase 12, **before a
single correction had been generated and before the correction round existed in the code**.
`ADR-0044 §4` decided that it gets built and measured; `docs/plan/prompts/phase-12-management.md` §2.2 is
how this got here.

**Do not edit §4.** Amend below it, dated.

## 1. The rule this is already frozen against

ADR-0044 §4 rule 2, accepted 16 Sep 2026, before any of this was built:

> **Budgeted, and switched off by its own number.** Phase 12 measures corrected-attempt survival and the
> Opus tokens each correction cost, against what escalation would have cost. If corrected attempts do not
> survive often enough to pay for themselves, B is off by default and the docs say so.

§4 below is that sentence turned into arithmetic. It can only produce three answers and one of them —
*it does not pay* — is a complete result that this phase reports without apology.

## 2. The feasibility problem, measured before the rule was written

**Every task Phase 11 ever ran reached a verdict on its first attempt.** Not one reached the mechanical
retry, so not one could have reached the correction round:

| arm | tasks | survived | **retried** | escalated |
|---|---|---|---|---|
| C2 fixture | 3 | 3 | **0** | 0 |
| C2 project-a | 12 | 12 | **0** | 0 |
| C2 project-b | 12 | 11 | **0** | 1 |
| C3 fixture | 3 | 3 | **0** | 0 |
| C3 project-a | 12 | 12 | **0** | 0 |
| C3 project-b | 12 | 12 | **0** | 0 |

Read off `experiments/go-no-go-2a/results/partials/*.json` on 18 Sep 2026. The one escalation is
project-b's `ENOTEMPTY` sandbox teardown — a machine failure (ADR-0056), which the retry rule declines to
spend an attempt on, correctly.

**So the correction round has a denominator of zero on every task this repository has measured**, and
§2.2 cannot be answered on the existing plans at any run length. That is not a defect in the correction
round; it is what "every real task so far is a rename or an unused-import removal" means when you ask a
question about failure.

### What follows, and it is a constraint on the run rather than an observation

The measurement needs **tasks a 7B actually fails**, and the only honest way to get them is the shapes
nobody has measured: **null guards, API migrations, and dead-code removal** (`VISION.md`'s own list of
2a work). Those are the same shapes Phase 11b §4.4 requires before its verdict may be applied, so one
extended task set serves both phases — and **that is the only coupling between them.** Neither phase's
verdict may assume the other ran.

**A task set chosen because the worker fails on it is a biased task set**, and the bias runs towards the
correction round looking useful. §4.0 precondition 4 is how that is held down.

## 3. What a correction is, so that what is measured is the thing ADR-0044 decided

- Written by **Opus**, from the `ChangeVerdict` and from what the gate extracted — the `tsc` message, the
  named confinement rule and its offending line, the names of the regressed tests. **Never from the
  candidate's diff.** Non-negotiable #3 and ADR-0044 §4 rule 1; `ChangeVerdict` was designed for this
  reader (ADR-0047 §3).
- Spent **only after the mechanical retry has failed** (ADR-0044 §4 rule 3). The cheapest correction —
  ADR-0022's, which carries the tool's own words for free — is always tried first.
- **One** note, appended to the same task as `ChangeTask.correction`, `attempt` becomes `2`. Not a
  conversation: ADR-0044 ruled that out and this measurement does not relitigate it.
- Against a **per-run budget** carried in the plan. A run that exhausts it falls back to escalation for
  the remaining tail.

## 4. The decision rule — frozen 2026-09-18, before the first correction

### 4.0 Precondition

A run is read only if all of these hold. Any one failing makes it **void** or **inconclusive** as stated,
never marginal:

1. **The gate is the production gate.** The correction round changes what a worker is *asked*; it may
   not change what survival *means*. `changeSurvives` is untouched during the run.
2. **Rule 1 is machine-checked, not promised.** The thing that writes a correction is handed the verdict
   and cannot reach the candidate's diff or contents. If that separation is only a convention, the run
   is **void** — this is the one property that distinguishes the measured thing from "Opus reviews
   everything".
3. **The baseline matches a reference** measured on a quiet machine at the same commit. Phase 11's
   amendment, and it caught every contaminated arm there while the explanation attached to it was wrong
   three times over.
4. **The task set is declared and justified before the run**, with its shape mix, and the same set is
   used for the uncorrected control. A task added after seeing a failure voids the run.

### 4.1 The measured quantities

Per project, never pooled:

- **n₂** — tasks that reached attempt 2: failed attempt 0, failed the mechanical retry, and were not
  excluded as machine failures (ADR-0012's rule, and ADR-0056's).
- **S_c** — corrected-attempt survival: survivors at attempt 2 ÷ n₂.
- **T_c** — Opus tokens per correction written, measured from the session record the way §2.1 measures
  planning, not estimated.
- **T_e** — what escalating the same task would have cost instead: the whole task handed to a paid model.
  Taken as Phase 11's C3 control, **7,794 tokens/task** on project-a, and **priced at Sonnet**, because
  Sonnet is escalation's default (`DEFAULT_ESCALATION_MODEL`) and comparing Opus tokens against Opus
  tokens would flatter the correction round by a factor of the price ratio.
- **A_c** — the blind approval rate of **corrected** survivors, defined exactly as Phase 11 §4.1's
  `A(x)`, and **A_u** — the same for survivors that were never corrected.
- **Break-even**, `S_be = cost(T_c, Opus) ÷ cost(T_e, Sonnet)`, in dollars at the rates recorded on the
  day of the run. Both rates are written into the result file.

### 4.2 The rule

- **KEEP ON — `S_c ≥ 2 · S_be`.** Corrections save at least twice their cost in expectation. ADR-0044's
  option B is on by default and the docs say what it costs.
- **MARGINAL — `S_be ≤ S_c < 2 · S_be`.** It pays, but not convincingly. On by default, with the ratio
  stated in the README **and the wall clock stated beside it**: a correction re-runs the gate, which
  Phase 11 measured at **262 s** per candidate, and that cost is real whatever the tokens say.
- **OFF BY DEFAULT — `S_c < S_be`.** ADR-0044 §4 rule 2's kill switch fires. The round ships switched
  off, the docs say so and say why, and the tail escalates as it does today. **This is a complete result
  and the phase reports it without looking for a cut of the data where it passes.**

### 4.3 The two vetoes

**The quality veto, and it overrides every cell in §4.2.** Corrected and uncorrected survivors go into
**one shuffled blind pass per project**, the reviewer blind to which is which and told only to judge the
change. If **`A_c < A_u`**, the correction round is **OFF** regardless of what it saved.

The reason is Phase 11's central finding and not a precaution: survival saturated at 1.00 in four of five
measurable cells and could rank nothing, and the entire verdict fell to the approval guard. A correction
round is a mechanism for turning failures into survivors, which is exactly the mechanism that would
manufacture survivors whose flaws the gate cannot see. A cheaper survivor that a reviewer rejects is not
a saving.

**The denominator floor.** If **n₂ < 8** on a project, that project is **INCONCLUSIVE**: the cells are
reported and no verdict is applied. Phase 11's intervals at n = 10 ran `[0.555, 0.997]`, and its
amendment warns that a small sample's lattice tends to land on its own threshold. So where n₂ permits,
**the bar is restated as a count** in the result file — "k of n₂ survivors are needed" — rather than as a
rate, for the reason that amendment gives.

### 4.4 The ADR-0054 probe, and why it is separable

Phase 12's prompt offers the unrequested cosmetic edit — 4 of 23 sampled survivors against 0 of 23, the
**only** measured quality gap between the local tier and the control — as a ready-made test of whether
corrections work at all.

**It is not usable as one under rule 1 as the gate stands today, and that is recorded here rather than
discovered mid-run.** A cosmetic edit **survives**: confined, `tsc` clean, suite green. Its verdict says
`survived: true` and carries nothing about the comment. So there is no failing verdict for a correction
to be written from, and the only ways to reach it are to let Opus read the diff — which rule 1 forbids
and which is the line between this design and "Opus reviews everything" — or to make the behaviour
visible to the verdict first.

Making it visible is an ADR-sized decision (ADR-0054's options A, B, C, and the *observe-without-gating*
option Phase 12 raises), and it is **not** decided inside this protocol.

Therefore:

- **§4.2 and §4.3 are applied to gate-visible failures only**, and that verdict stands whatever happens
  to ADR-0054.
- **If and only if** ADR-0054 lands in a form that puts the behaviour into the verdict, the probe runs
  as a **separately reported cell** — corrected-attempt survival on cosmetic-edit breaches, with its own
  n — and it is **never pooled into `S_c`**. Two mechanisms with one rate is the pooling error §4.1
  already forbids across projects.

### 4.5 The threat this run cannot remove

The task set is chosen to contain failures (§2), so **`n₂ > 0` is an artefact of task selection and not a
property of the workload.** Every number here is conditional on that set, the run reports the shape mix
beside every cell, and the phase may not claim a rate at which real work reaches the correction round.
That rate is Phase 11b's to produce, on a task set chosen for a different reason.

## 5. What is written down

`results/correction-round-<date>.json`, `"measured": true`, machine info, commit, the task set with its
shape mix, per-project cells, both token prices, the blind pass's shuffle seed and the reviewer's
instructions verbatim, and the verdict §4.2 and §4.3 produced.

**Machine for this phase:** Mac14,10 · Apple M2 Pro · 32 GB · macOS 26.6.2 · node v20.20.0.

`project-a` and `project-b`, never the client (CLAUDE.md #7).

---

## Amendment to §4, dated 2026-09-18

*§4 above is unedited. This is appended below it, as §4's own preamble requires, and it was written
before any correction had been generated — the thing §4 is frozen against.*

**§4.4's condition is met: ADR-0057 landed the same day, option D.** The verdict gains non-gating
`observations`, `changeSurvives` is untouched, and the correction round may fire on a survivor that
carries one — under its own budget, off by default.

Three consequences for how this protocol is read, and none of them moves a threshold:

1. **§4.4's "if and only if" is now satisfied**, so the probe runs as the separately reported cell §4.4
   already specifies. It is still **never pooled into `S_c`**: gate-visible failures and cosmetic
   observations are two mechanisms and §4.1 forbids one rate over two.
2. **The probe's denominator is its own**, call it `n_obs` — survivors carrying a cosmetic observation —
   and §4.3's floor of 8 applies to it separately. Phase 11 sampled 4 such survivors in 23, so a run
   large enough to clear the floor is a constraint on the task set and is stated with the cell.
3. **The observation is a comment-line delta, so it sees deletions and not rewordings.** Of Phase 11's
   four sampled cases, three were deletions or an inserted blank line and one was a rewording
   (`Normalises` → `Canonicalises`). The probe therefore measures roughly three quarters of the
   behaviour ADR-0054 counted, and **the cell says which half it measured** rather than reporting a rate
   over a denominator it cannot fully see. Option B and the TypeScript AST are what close that, and they
   are not in this phase.

**No threshold in §4.2 or §4.3 is changed by this amendment**, including the quality veto, which applies
to corrected survivors whether the correction was triggered by a failure or by an observation.
