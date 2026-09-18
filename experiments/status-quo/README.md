# Phase 11b — sidecrew against not using sidecrew

**The frozen artefact.** `docs/plan/prompts/phase-11b-against-the-status-quo.md` is how it got here;
§4 below is copied **verbatim** from it, before any arm ran. Do not edit §4; append below it, dated.

Projects are `project-a` (Nest/jest) and `project-b` (React/jest), unmodified and not ours
(CLAUDE.md #7). Their plans are untracked for the same reason.

## The question

Every number in this repository compares a local 7B against Haiku **inside** sidecrew, behind the
same gate. That answers *which worker should sidecrew hire*. It does not answer the only question a
colleague asks: **is this better than what I do now?** — which is asking Opus or Sonnet directly,
with no plan, no gate and no review pass.

## Declared before the first arm ran: §4.2's verdict is WITHHELD

§4.4 refuses a verdict when the task set is all renames and unused-import removals. **It is**, and
this was established by survey rather than discovered afterwards:

| shape | project-a | project-b |
|---|---|---|
| `api_migration` — `@deprecated … use X instead` in a file ≤400 lines | **0** | **0** |
| `null_guard` — `x!.` dereference in a small file | **0** | 11 |
| small source files overall | 2,001 | 1,902 |

Not scarcity of files: ~2,000 small files each. `@deprecated` occurs 34 times in project-a and every
instance naming a replacement sits in a file past ADR-0047 §2's whole-file ceiling. Phase 11 already
measured zero `tsc` errors on both projects.

**So the cells are reported and §4.2 is not applied.** That is §4.4 working rather than failing, and
the alternative — amending the clause to fit what these codebases happen to contain — is the precise
failure this discipline exists to prevent.

### What that leaves, and the finding it produced

The addressable surface of workload #2a on a clean, well-maintained codebase is **much smaller than
`VISION.md` assumes**. Type errors: zero. Null guards: zero to eleven. API migrations: present but
untaskable. What exists is renames and dead imports — which is what Phase 11 measured, and which now
looks less like a narrow first cut than like most of the population.

**Multi-file renames are added as a separately-reported shape.** An exported symbol used across 2–5
small files: the rename must stay consistent *across* files and a missed call site is a compile
error, so it is a failure mode these codebases can actually supply — 60+ available per project,
which was the search cap rather than the supply. It is **not** one of §4.4's three shapes and cannot
satisfy that clause; it is reported on its own row, and it puts `max_group_size` above 1, which no
number in this repository has ever measured.

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


---

## Observations, appended after §4 was frozen — 18 Sep 2026

§4 above is frozen and nothing below amends it. These are measurements and one recorded prediction,
dated, in the order they were taken.

### O1 — Arms A and B produced byte-identical output on all 19 tasks

Measured 14:20, before arm C finished, by rendering every arm's result through one diff renderer.

Not "similar", and not merely the matching 167 changed lines already recorded: **the same bytes**, on
every one of the 19 tasks. The two sandboxes differ nowhere at all (`diff -rq` is empty).

Checked for the boring explanation before believing it, because one sandbox seeded from the other
would look exactly like this:

| evidence | arm A | arm B |
|---|---|---|
| directory inode | 305647986 | 305743323 |
| task-file mtimes | 13:06–13:13 | 13:24–13:25 |
| marginal tokens | 80,131 | 88,820 |

Separate inodes, separate write windows twelve to eighteen minutes apart, different token totals. Both
arms genuinely wrote their own trees.

**The correct reading is not that two frontier models agree.** It is that **this task set cannot
discriminate between models at all**, because the ask leaves nothing to decide:

> Rename the symbol `parseEnvSizeA` to `parseSizeFromEnvA` in this file, and update every reference
> to it. Change nothing else.

Old name given, new name given, scope given. The task admits essentially one correct answer, so any
competent model emits the same bytes. The shape mix is **19/19 `rename`** — zero null guards, zero API
migrations, zero dead-code removal.

**This vindicates §4.4's withholding with a mechanism rather than a judgement.** The clause was written
before any arm ran, on the suspicion that an all-rename task set would make a WIN meaningless. It is now
measured: two different models, byte-identical output, 19/19. A metric computed over these tasks cannot
rank anything, which is Phase 11's "a metric that saturates cannot rank anything" arriving by a second
and independent route — there, saturation at the top of a rate; here, zero variance in the artefact
itself.

**One practical finding survives the withholding, and it is worth reporting on its own.** For output
that is byte-identical, the cheaper model cost **10.8 % more**: 88,820 marginal tokens against 80,131.
On fully-determined tasks in this harness, choosing the cheaper model does not buy a cheaper run.

### O2 — Prediction for arm D, recorded before it runs

Written 14:22, with arm C in flight and arm D not yet started, per the same discipline §4.3 applies to
the phase as a whole: **a rule written after a number is a description of that number.**

Arm D applies the gate to arm A's 19 diffs. Those diffs are correct by construction — fully-determined
asks, independently reproduced byte-for-byte by a second model. So:

> **Arm D should pass all 19, or very close to it.** If it rejects any, the first hypothesis is a false
> negative of the ADR-0066 kind, *not* a defect the gate found. That hypothesis is testable and must be
> tested before the rejection is reported as a gate success: re-run the identical candidate, and check
> the rejection's timestamp against `results/pressure-project-a.csv`.

Stated plainly so it cannot be adjusted afterwards: **on this task set arm D cannot demonstrate the
gate's value, because there is no defect present for a gate to catch.** A clean 19/19 from arm D is
consistent with the gate being worthless *and* with it being excellent; this task set does not separate
those. The arm still earns its place by measuring the gate's *cost* against arm A, and by being the
control that makes any arm-C rejection interpretable.

### O3 — A 7B matched Opus byte-for-byte on 18 of 19 tasks, and the one divergence is the whole result

Measured 16:10, after arm C completed and while arm D ran.

Comparing arm C's candidates against arm A's output, per task:

| | |
|---|---|
| byte-identical to Opus | **18 / 19** |
| differ | **1** (`rename-12`) |

Combined with O1 (arms A and B byte-identical on 19/19) and arm D replaying arm A's diffs, **all four
arms produce the same bytes on 18 of 19 tasks.** There is no quality difference to measure on those
eighteen, by any reviewer, because there is no difference. §4.4's withholding is now over-determined.

**The single divergence is worth more than the other eighteen combined.** The ask was:

> Rename the symbol `normalizeXId` to `canonicaliseXId` in this file, and update every
> reference to it. **Change nothing else.**

Opus renamed the symbol. The local 7B renamed the symbol *and* reworded the function's doc comment
from "Normalises …" to "Canonicalises …" so the prose matched the new name.

Two defensible readings, and which one is right is exactly the judgement `P(x)` exists to capture:

- **a defect** — "change nothing else" is explicit, and a comment is not a reference to a symbol;
- **better than Opus** — the rename made the comment untrue, and Opus left stale documentation behind.

**This is the same signature Phase 11 found.** Its one blind-review rejection on this project was
`"1 of 10 C2 survivors reworded a doc comment ('Normalises' -> …)"`. The same local model, the same
behaviour, on the same word, in a different phase and a different task set. That is no longer an
anecdote about one candidate; it is a reproducible property of this worker.

**And the mechanism built to catch it did not.** ADR-0057 put non-gating `observations` on every
verdict specifically to make unrequested cosmetic edits visible without spending a reviewer. All 19 of
arm C's verdicts carry `observations: []`, `rename-12` included. `observe` (`confinement.ts:221`)
computes `commentLines(before) - commentLines(after)` and fires only when the count **drops**; a
reword has the same count, so it is structurally invisible. Phase 12's own handoff predicted this in
one clause — *"a line delta is blind to a comment reworded at the same length"* — and it is now
measured rather than anticipated. See ADR-0068.

**What this does to the blind review.** The pack is not 4 × 19 items; after dedup it is **20 distinct
diffs** — 19 shared by every arm, plus arm C's variant of `rename-12`. `P(A)`, `P(B)`, `P(C)` and
`P(D)` are therefore equal by construction on 18 tasks and can differ on at most one. The review is
still worth running, but its question has changed: it is no longer "which arm is more precise" — that
question has no purchase here — but "is this class of change correct at all, and is the doc-comment
reword a defect or an improvement."

### O4 — Arms C and D ran on the pre-ADR-0067 gate, and that cannot be checked retroactively

Recorded 16:25, while arm D was in flight.

The gate changed on `main` during this phase. ADR-0067 (`passed_after >= passed_before`) and ADR-0068
(`comment_text_changed`) landed at `7d13ddf`, both found by reading this phase's own artefacts.

**Arms C and D are unaffected**, and that is by construction rather than luck: both ran from a
detached worktree pinned at `2e7aa1e`, verified at launch by commit, by `src` cleanliness and by
`dist` md5 (`f7a21e35d8352b5b424208e93fe0edeb`, identical across both arms). A gate that moves
mid-experiment is the thing §4 forbids, and here it moved and could not reach the run.

**What that costs, stated rather than discovered.** Every arm-C and arm-D number in this phase was
produced by the **lenient** gate — the one that compares test identity and not counts. ADR-0067's
whole point is that such a gate can admit a change which broke one case of a parameterised test.
Arm C survived 19/19 under it.

**Corrected 16:35.** This section first said the question could not be recovered from the artefacts.
That is true of the **verdict** and false of the **run**, which is a distinction worth keeping: the
pre-0067 `ChangeVerdict.tests` carries `reported`, `ran_before`, `ran_after` and `regressed` and no
passed-count — but `FixResult.project` and `baselines/*.json` both record passed counts, and every run
writes them.

For arm C:

| | |
|---|---|
| `baselines/0.json` → `tests.passed` | 6159 |
| `result.project.tests_passed` | 6159 |
| `result.project.combined_regressions` | 0 |

**ADR-0067's clause, evaluated on the final combined state, is already on disk and it passes**
(`6159 >= 6159`, 6368 ran). With all 19 survivors applied together the suite lost no passing
execution, so no `test.each` case was broken by the set of changes as a whole.

What that proves, and what it does not:

- **Proves** — the 19 survivors *together* lose no passing execution. A parameterised case broken
  anywhere in the set would appear here as `tests_passed < 6159`.
- **Does not prove** — that each of the 19 satisfies the clause *individually*. In principle one
  candidate could break a case while another turns a previously-failing test green, netting to zero.
- **That cancellation is implausible, and the reason is checkable rather than rhetorical:** it would
  require a behaviour-preserving rename to fix a test that was already failing, on a project whose 209
  pre-existing failures fail for environmental reasons. It would also have to be present in arm A,
  since 18 of the 19 diffs are byte-identical to Opus's.

**Second residue, added 16:45.** The count clause assumes a **deterministic suite**. It compares two
numbers taken an hour apart, so on a drifting suite a `+n` flake can mask a `-1` breakage — precisely
the direction ADR-0067 exists to catch. The clause has a noise floor that the id rule does not
(an id either passed or it did not), which is why both clauses are kept and neither subsumes the other.

Measured on this run rather than assumed, and the evidence is unusually good:

| check | result |
|---|---|
| distinct `ran_after` across arm C's 19 suite runs | `{6368: 19}` — collection identical every time |
| distinct `regressed` counts across those 19 | `{0: 19}` — no whole-id regression, ever |
| `passed_ids` sets of the two baselines, an hour apart | **identical** — same 6159 passing, same 209 failing |

So across arm C's 21 executions the suite did not drift.

**Falsified within the hour, 17:18.** Arm D's `multi-06` failed at `tests` with 12 regressions in one
spec file — on a candidate whose edits hash to `b1eded7bb483eb37`, **the same bytes as arm C's
`multi-06`, which survived**. The machine was at its quietest of the day: pressure `1`, 9.3–9.9 GB
free, swap 2.2 GB.

So the sentence above was too strong, and the error is worth naming because it is the same one this
phase keeps finding. Nineteen runs with constant `ran_after` and zero regressions support *"no drift
observed in 19 runs"*. They do not support *"the suite does not drift"*, which is what was written.
**Absence of evidence over a sample was stated as a property of the system.**

Two consequences:

1. **There is a second source of gate non-determinism, independent of memory pressure.** ADR-0066's
   mechanism is real and reproduced, but it is not the only one. Whatever produced this is not
   explained by swap, compression or contention, because none of those were present.
2. **The `+n`-flake caveat on the count clause is live rather than theoretical.** A suite that can
   produce 12 spurious regressions on a quiet machine can also produce a spurious `+n`, and the
   combined-state check (`6159 >= 6159`) rests on it not having done so. That check remains the best
   evidence available and it is no longer unqualified.

So the honest statement of arm C's result is: **19/19 under the gate as it stood at `2e7aa1e`, and the
combined final state satisfies the stricter gate's clause as well.** Two residues remain, both small
and both stated rather than waved away: per-candidate isolation, and the count clause's dependence on
a suite that does not drift — which is measured here and should not be assumed elsewhere.

**Phase 11's #2a rates have the same exposure and the cheap check is not available to them.** Its run
directories are gone, and `results/partials/*.json` carry the `FixResult` without the baseline, so
there is no captured `baseline.tests.passed` to compare against. `baseline-reference.json` is not a
substitute — it is a quiet-machine reference at a different commit, and using a reference in place of
a run's own captured baseline is exactly the substitution that reference exists to detect. Phase 11's
`12/12` and `11/12` are therefore *"measured under the gate as it stood"* with no way to re-derive the
stricter clause short of re-running those arms. Worth knowing before anyone quotes them beside a
post-`7d13ddf` number.

**The follow-up that closes the residue**, in two sizes:

- **Full** — re-verify all 19 survivors on the post-`7d13ddf` gate. ~80 minutes at 255 s per candidate.
  A choice about rigour before publication, not a repair.
- **Targeted, ~8 minutes** — re-verify only `rename-12`, the single candidate whose diff is *not*
  byte-identical to arm A's and therefore the only place arm C did something no other arm did. It is
  also the only task where the doc-comment reword could interact with the clause.

### O5 — The one contested judgement, decided by the owner, and why it still does not produce a verdict

Recorded 17:05, with arm D at 17/19.

§4.0 requires the reviewer be blind to the arm. **That requirement could not be met by this session**,
and saying so is more useful than producing a number that does not mean what its name says: the
session that ran the arms also found the divergence and knew which arm produced which variant.

It is mostly moot, for a reason O1 and O3 already established: on 18 of 19 tasks every arm's diff is
the *same file*. Blindness protects a comparison between arms, and there is no comparison to protect
when there is one artefact. The judgement has content on exactly one task.

**The owner judged `rename-12` directly**, shown both variants against the original with the arms
unnamed in the presentation:

| | |
|---|---|
| ask | *Rename `normalizeXId` to `canonicaliseXId` … **Change nothing else.*** |
| variant 1 (Opus, Sonnet, arm D) | renames declaration + 3 call sites; leaves the doc comment |
| variant 2 (local 7B) | the same, **and** updates the doc comment `Normalises` → `Canonicalises` |

**Owner's judgement, 18 Sep 2026: variant 2 is acceptable.** The rename made the comment describe a
name that no longer exists, so updating it completes the ask rather than exceeding it. Worth noting
the sharper form of the question: the comment said *"Normalises"* and the new name is *canonicalise*,
which are not synonyms in every codebase — so variant 2 is asserting the new name is accurate, not
merely tracking a word.

**Consequence for the cells:** every delivered change in every arm is accepted. `P(A) = P(B) = P(C) =
P(D) = 1.0`, and `E(x) = 0` everywhere.

### O6 — §4.2's WIN condition is now satisfied, and §4.4 forbids applying it. It is not applied.

This is the clause doing the job it was written for, so it is worth stating plainly rather than
burying in a verdict field.

With O5's judgement the cells are:

| | P(x) | delivered | worker tokens |
|---|---|---|---|
| A — Opus alone | 1.0 | 19 | 80,131 |
| B — Sonnet alone | 1.0 | 19 | 88,820 |
| **C — sidecrew** | **1.0** | **19** | **0** |
| D — gate on A's diffs | 1.0 | 19 | 0 (A's cost) |

§4.2's first clause reads: **WIN** — `P(C) >= P(A)` and `T(C) < T(A)`. Both hold, and not marginally:
equal precision at zero worker tokens against 80,131.

**§4.2 is not applied, because §4.4 says it may not be.** At least half the tasks must be null guards,
API migrations or dead-code removal for §4.2 to be evaluated at all; the shape mix is 19/19 `rename`.
The verdict remains **WITHHELD**, exactly as declared before the first arm ran.

That clause was written on a suspicion and is now over-determined by measurement: two frontier models
and a 7B produced byte-identical output on 18 of 19 tasks, so this task set cannot distinguish
*anything*. A WIN computed over it would say only that sidecrew is competitive on changes that admit
one correct answer — which nobody doubted, and which is precisely what §4.4 anticipated.

**What this phase therefore claims**, and it is narrower and more defensible than the WIN it is
declining: *on fully-determined single-symbol renames in a commercial Nest codebase, a local 7B behind
a mechanical gate produced output byte-identical to Opus on 18 of 19 tasks, at zero worker tokens, and
every delivered change was accepted on review.* The comparison that would earn a verdict needs the
harder shapes, and ADR-0063 and ADR-0064 are the route to generating them.

### O7 — The same behaviour was judged the other way in Phase 11, and that is a finding about reviewers

Phase 11's blind reviewer **rejected** a doc-comment reword by the same worker — `"1 of 10 C2
survivors reworded a doc comment ('Normalises' -> …)"` — and it was the single rejection that drove
`A(C2)` to 0.900 and left that phase's GO with **zero margin**.

The owner has now judged the same behaviour, by the same model, on the same word, **acceptable**.

Neither judgement is wrong. The point is that `P(x)` has **reviewer variance on exactly the behaviour
that distinguishes the local tier**, and Phase 11's verdict turned on a single instance of it. That is
a caveat on Phase 11's zero-margin GO which did not exist before today: had that reviewer leaned the
other way, `A(C2)` would have been 1.000 and the margin would have been comfortable rather than nil.

**Consequence worth carrying:** a metric whose deciding cases are contested judgements needs more than
one reviewer, or it is measuring the reviewer. Phase 11 sampled `min(10, survivors)` from one reviewer;
that is enough to estimate a rate and not enough to settle a contested class. Before `P(x)` is used as
a veto again, the disputed class should be judged by at least two people and the disagreement reported.

### O8 — A second source of gate non-determinism, on a quiet machine, located but not diagnosed

Measured 17:18–17:20, arm D, project-a.

`multi-06` failed at `tests` with **12 regressions**, then survived the retry. The candidate's edits
hash to `b1eded7bb483eb37` on both attempts and on arm C's run of the same task, which also survived.

| evaluation | machine | verdict |
|---|---|---|
| arm C | pressure 1, swap ~3 GB | survived |
| arm D attempt 0 | **pressure 1, swap 2.2 GB, 9.3–9.9 GB free** | **failed**, 12 regressed |
| arm D attempt 1 | same | survived |

**This is not ADR-0066.** The machine was at its quietest of the day — the lowest swap reading in the
whole telemetry record. O2 named the pressure false negative as the *first hypothesis* for any arm-D
rejection and required it be tested before the rejection was read as a gate success. It was tested and
it does not hold.

**What is known:**

- all 12 failures are in **one spec file**, under a **single `describe` block**;
- 4 of the 12 test titles concern caching, and `multi-06` renames a symbol in a **cache utility** —
  the failing tests and the edited file are in the same functional area;
- it did not reproduce on a retry of identical bytes, and did not occur at all in arm C.

**What that rules out.** The functional-area coincidence looks causal and cannot be: a
behaviour-preserving rename either breaks a test or it does not, and this one passed twice out of
three on the same bytes. So it is not a deterministic consequence of the change — which is the only
thing the gate is entitled to conclude from it.

**Undiagnosed, deliberately.** The plausible causes — shared state or ordering within that spec, or
something in the runner-cache territory ADR-0055 covers — are guesses, and this phase has already
produced one confident wrong diagnosis today. It is recorded as an open question.

**Why it matters beyond one task.** Combined with ADR-0066 this is now **two independent sources of
false negatives in the #2a gate**, only one of which is understood. Every survival rate in this
repository is a lower bound of unknown tightness, and the mechanical retry — which exists for
transient failures and fired correctly here — is currently the only thing standing between them and
the reported number. That is worth saying out loud in a project whose central claim is that *a machine
can decide what a human is allowed to see.*

### O9 — `rename-12` re-verified on the post-`7d13ddf` gate: it survives, and the new `observations` sees it

Measured 18:07, on the fixed gate (`a4d2232`, dist md5 `1d86598a5294f021fcdf79f84ce679c5`), replaying
**arm C's own recorded candidate** for `rename-12`. Only the gate differs from arm C's run.

| field | value |
|---|---|
| survived | **true** |
| confined / compile_ok | true / true |
| regressed | 0 |
| ran before → after | 6368 → 6368 |
| **passed before → after** | **6159 → 6159** — ADR-0067's clause, satisfied **per candidate** |
| observations | **`comment_text_changed`** — *"1 comment line(s) reworded that the ask did not call for"* |

**This closes O4's residue for the candidate it mattered on.** The combined-state check already showed
the 19 survivors together lose no passing execution; the open question was per-candidate isolation.
`rename-12` was the only one worth checking — the other 18 are byte-identical to Opus's output — and
it satisfies the stricter clause on its own.

**And it is the cleanest possible confirmation of ADR-0068.** Three hours earlier this same candidate
produced `observations: []`, because `observe` counted comment lines and a reword is constant-volume.
The fix compares comment *text*, and it fires on exactly the case that motivated it — verified against
the original artefact rather than a synthetic test. **Measured sensitivity on the one case in the
dataset: 0/1 before, 1/1 after.**

Two caveats kept, because neither is closed by this:

- **The other 18 candidates were not re-verified individually.** They are byte-identical to arm A's
  output and covered by the combined-state check, and O8 means that check's no-drift assumption is
  qualified. A full re-run of all 19 on the new gate is ~80 minutes and remains available.
- **The re-verify hit the same tier mismatch as arm D** — a replay arm declaring `api` with zero
  worker tokens is refused by the schema, correctly, so no `result.json` was written. The verdict is
  on disk and is what is reported above. A replay arm is neither `local` nor `api` and the contract
  has no word for it; that is recorded as open, not worked around.

### O10 — project-b's plan is validated, and its gate will be materially hungrier than project-a's

Built and validated 18:15, ahead of running its arms.

`experiments/go-no-go-2a/plans/project-b-11b.json` (untracked, CLAUDE.md #7 — it holds absolute paths
into a client checkout and names their symbols): **19 tasks, 12 single-file + 7 multi-file, 26 files,
all disjoint, shape mix 19/19 `rename`** — deliberately mirroring project-a's so the two projects are
comparable task-for-task.

`sidecrew fix --validate` accepted all 19: every file is inside the tsconfig program, none carries a
pre-existing `tsc` error its ask does not cover, none is too large to return whole, and no two tasks
share a file. **Zero refusals**, so the denominator is the full 19. The validator also prints §4.4's
own warning at 0 % hard shapes, which is the discipline enforcing itself rather than relying on memory.

**One operational finding that bears directly on ADR-0066.** `tsc --noEmit` on project-b **ran out of
memory at the default heap** and needs `NODE_OPTIONS=--max-old-space-size=8192` — the project's own
`checkTs` script already uses exactly that. So project-b's gate holds **up to 8 GB for the compiler
alone**, on top of a jest suite of 772 suites and 8,795 tests, on a 32 GB machine.

That is a much tighter memory budget than project-a's, whose `tsc` takes 17 s and a fraction of the
heap. Phase 11 measured project-b's gate at 63 s of `tsc` against project-a's 17 s, which is the same
fact seen from the other side. **The arms must run with that heap set and on an otherwise idle
machine**, or ADR-0066's false negative becomes likely rather than possible — and on this project it
would be the compiler, not the suite, that tips it.

---

## project-b — arms A and B, 18 Sep 2026

Unmodified commercial React/jest codebase, 772 suites, 8,795 tests, 2,867 source files. Plan
`project-b-11b.json`: 19 tasks, 12 single-file + 7 multi-file renames, 26 disjoint files, shape mix
19/19 `rename`, mirroring project-a's so the projects are comparable task-for-task.

### O11 — the arms are *not* byte-identical here, and the difference is entirely formatting

| | |
|---|---|
| files byte-identical between Opus and Sonnet | **24 / 26** |
| files differing | 2 |

Both divergences are the same phenomenon, and neither is about the rename:

- the new, longer symbol name pushes a line past **80 columns**;
- **Opus reflowed** the line (wrapping a `.sort` comparator; expanding a JSX element onto four lines);
- **Sonnet left it long** — 88 and 83 characters respectively.

This is a genuinely different result from project-a, where all 19 tasks were byte-identical across
both models, and the cause is a property of the *project* rather than of the models:
`.prettierrc` sets `printWidth: 80` and `eslint.config.js:36` sets `'prettier/prettier': ['error', …]`.
Renaming to a longer name in this codebase **cannot** leave formatting untouched and also satisfy the
project's own lint. *"Change nothing else"* is not fully satisfiable here, and each model resolved that
conflict differently without being asked to.

**Precisely how much it matters, without overstating it:** the project's *main* lint treats this as an
error, but its dedicated `eslint.gate.config.js:35` sets `'prettier/prettier': 'off'`. So Sonnet's
output would fail `pnpm lint` and pass the team's own gate.

**And the #2a gate cannot see it either way.** ADR-0048's gate is `confined ∧ compile_ok ∧ tests_ok`;
formatting is not in it. Both variants will survive. So on project-b the choice between *"rename only,
leave the line long"* and *"rename and reflow"* is invisible to the gate by construction and lands
entirely on the reviewer — a third category of thing the gate does not judge, alongside ADR-0067's
counts and ADR-0068's comment text.

### O12 — the cheaper model was cheaper here, reversing project-a

| | project-a | project-b |
|---|---|---|
| arm A, Opus, marginal tokens | 80,131 | **95,335** |
| arm B, Sonnet, marginal tokens | 88,820 | **88,680** |
| cheaper arm | **Opus**, by 10.8 % | **Sonnet**, by 7.0 % |

The ordering flipped, and the reason is visible in the transcripts rather than inferred: Opus did more
exploration — repo-wide greps to confirm a symbol was file-local, and the formatting judgement in O11
— averaging more tool calls per task. Sonnet more often edited and stopped.

**So "which model is cheaper" is not a property of the models.** It is a property of the model *and*
the codebase, and a single-project measurement would have reported the wrong sign. This is the second
reason §4 forbids pooling across projects, and the first one that was measured rather than argued.

### O13 — arm A found a defect in the experiment's own inputs

`multi-02` as first written renamed a symbol whose references included a **6,270-line** barrel file
outside the task's file set. Arm A's model noticed, renamed only what it was given, and reported the
third file rather than silently half-completing the rename.

The cause was mine: the candidate scanner excluded `/index\.tsx$` — intended to skip the app
bootstrap — and that pattern matched **every** barrel file in the tree, so symbols referenced only
from barrels looked file-local. An audit then found a second instance (`rename-05`, referenced from
two files of 3,293 and 2,185 lines).

**`sidecrew fix --validate` cannot catch this.** It checks tsconfig membership, pre-existing errors,
file size and task-to-task file sharing — not whether a task's file set covers every reference to the
symbol it names. That is the planner's job, and Phase 12's planner would have the same blind spot.
Both tasks were replaced with candidates whose reference sets were verified complete against **every**
`.ts`/`.tsx` file in the project, and arm A's sandbox was reverted for the dropped tasks and re-run —
23 files changed, none outside the plan, before the replacements were issued.

Worth stating plainly: **the ungated arm caught a defect in the experiment that the gate's own
validator was not designed to catch.** Extending the task to include those barrels was not an option
either — at 6,270 lines the file exceeds what a worker can return whole under ADR-0047 §2, so arm C
would have failed for a harness reason wearing the costume of a model failure.

### O14 — the gate caught a real defect the frontier models did not make

Arm C, project-b, `rename-02`, 22:20. **The first true gate rejection in the phase**, and the first
measured quality difference between the local 7B and a frontier model that is not about formatting.

The ask named **one non-exported symbol**. The 7B performed a **blanket prefix substitution** across
the whole file, renaming seven symbols and rewriting prose:

| renamed | asked for? | exported? |
|---|---|---|
| `<Prefix>Context` | **yes** | no |
| `<Prefix>Provider` | no | **yes** |
| `use<Prefix>` | no | **yes** |
| `<Prefix>EditContext`, `…ContextValue` | no | **yes** |
| `<Prefix>EditProvider` | no | **yes** |
| `use<Prefix>Edit` | no | **yes** |
| two doc comments and two `throw new Error(...)` message strings | no | — |

Verdict: `confined: true`, `compile_ok: false`, **0 → 5 `tsc` errors across four other files**, all
`TS2305: Module './context' has no exported member …`.

**This is ADR-0048's `compile_ok` clause doing exactly what it was written for.** The diff is
perfectly confined — nothing outside the task's file was touched — and it still breaks the build,
because the file's *exports* changed. Confinement alone cannot see that; only compiling the whole
program can. A reviewer skimming the diff might not have caught it either: the substitution is
uniform, plausible and tidy.

**Both frontier arms identified the trap explicitly and avoided it.** Opus: *"the sibling
`…EditContext`, `…Provider`, `use…` are separate symbols that merely share the prefix."* Sonnet: *"the
similarly-named but distinct symbol … was left untouched, as requested."* The 7B did not distinguish
a symbol from a string.

**Why this matters more than the 18/19 identity on project-a.** Project-a's tasks had symbols with no
prefix-sharing siblings, so a substitution and a rename are the same operation there — which is why
three models emitted identical bytes and nothing could be distinguished. Project-b has a file where
seven symbols share a prefix, and the two approaches diverge immediately. **The difference between a
7B and a frontier model on this workload is not capability in general; it is whether the task admits
a lexical shortcut.** That is a property of the codebase, which is ADR-0064's finding arriving from a
third direction.

It is also the clearest statement of the product's thesis this repository has produced: *a weak model
made a confident, tidy, plausible mistake, and a machine caught it before a human saw it.*

### O15 — a second compile rejection, byte-identical to Opus's output, and a prediction for arm D

Arm C, project-b, `multi-02`, 23:06. Recorded **before arm D reaches this task**.

Both attempts failed at `compile` with the same five errors, so it is deterministic. But the diff is
**correct** — all four occurrences (declaration, recursive self-call, import, call site), which is
exactly what arm A reported doing — and the candidate is **byte-identical to arm A's output**.

The five errors are all `TS2589: Type instantiation is excessively deep and possibly infinite`, in
**five test files about asset forms**, which have no relationship to the renamed locale helper.

**My prediction that this would be memory pressure was falsified by the recorder.** O10 argued that on
project-b an ADR-0066 false negative would come from the compiler rather than the suite. The telemetry
at that moment: **pressure 1, 14–18 GB free, swap flat at 1.5 GB for the entire run**. The machine was
pristine. That is the second pre-registered prediction of mine this instrument has refuted today, and
both times the value was in being able to check rather than argue.

**The likely mechanism, stated as a hypothesis and not a conclusion:** a large React codebase with
deep generic form types sits near `tsc`'s instantiation budget, and any perturbation can tip
individual files over it. The rename is semantically inert, so if that is right the project has a
latent fragility that *any* change could expose, and the gate is correctly reporting "five errors
exist now that did not before" while the cause is the project rather than the change.

**The test, and arm D is already the control.** Arm D replays arm A's diffs, and arm A's `multi-02`
output is byte-identical to this candidate. So:

> **Arm D's `multi-02` must fail at `compile` with the same five `TS2589` errors.** If it does, this
> is a property of the project and the change, not of the worker, and it must **not** be counted as a
> worker-quality failure in any denominator — both a 7B and a frontier model produce it. If arm D
> instead survives, then something differs between the arms that should not, and both results are
> suspect until that is explained.

**Either way it is not a 7B-vs-frontier difference**, which distinguishes it sharply from `rename-02`
(O14), where the 7B's over-rename was a real defect that both frontier models explicitly avoided.
Those two rejections belong in different buckets and must not be pooled into one survival rate.

**Deferred, deliberately:** the cleanest check is running `tsc` cold on the *unmodified* project to see
whether those five errors are latent. That is ~70 s of compiler against a machine currently running
the gate, and running it now is exactly the contention this phase spent a day learning not to create.
It runs after both arms finish.

### O16 — the two gate clauses disagree on a real final state, and my project-a reasoning was wrong

Arm C, project-b, final combined state, 23:21.

| | |
|---|---|
| baseline | 8,795 ran, **8,788 passed** |
| after all 15 survivors applied together | 8,795 ran, **8,788 passed** |
| `combined_regressions` | **2** |

So two tests that passed at baseline now fail, and two that failed now pass. The net is zero.

**The two clauses of the gate return opposite answers on this state:**

- ADR-0067's **count** clause, `passed_after >= passed_before`: **passes** (8788 ≥ 8788).
- The **identity** clause, `combined_regressions == 0`: **fails**.

ADR-0067's addendum argued that both clauses must stay because they fail in different directions and
neither subsumes the other. That was reasoning; this is the measurement. A `+n` flake masking a `-1`
breakage is not hypothetical — it happened on the first project with a low enough baseline-failure
count for it to be visible.

**And it corrects something I wrote about project-a.** O4 said per-candidate cancellation was
implausible there, on the grounds that it *"would require a behaviour-preserving rename to fix a test
that was already failing."* That reasoning was wrong, because it assumed the only way to cancel is a
rename fixing a test. **The actual mechanism is flakiness** — a borderline test flipping in either
direction, with no causal link to the change at all. Project-b has 7 pre-existing failures and 2 of
them flipped; project-a had 209, any of which could have done the same.

So project-a's combined-state evidence is **weaker than O4 claimed**: it shows the net was zero, not
that no regression occurred. The conclusion there does not change — the per-candidate `regressed`
check was zero on all 19, which is the stronger clause — but the argument I gave for it was unsound
and is withdrawn.

**What to carry:** on a suite with any flakiness, a count comparison is evidence of absence only in
the weak sense. The identity clause is the one that detects a specific regression; the count clause is
the one that detects what identity cannot see (a `test.each` case). **Report both, and never let one
stand in for the other.**

**Still to check, after both arms finish:** whether those 2 regressions are the flaky pair or a real
interaction between survivors that no per-candidate gate could see. Each candidate passed `tests_ok`
individually; an emergent interaction at the step boundary would be a different and more serious
finding than flakiness, and the two are distinguishable by re-running the combined state.
