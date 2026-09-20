# The editing ceiling: is it the model, or the task? (Phase 14b)

**Question:** the 7B does not *attempt* `null_guard` work — survival was **1/30**, and 16 of 17 tasks
where it returned the file unchanged returned it unchanged **again** after a note saying that returning
it unchanged *was* the failure. Is that a capability ceiling, or a fixable gap?

This file is the **frozen artefact**. §1 is copied verbatim from `docs/plan/PHASES.md` § *14b* →
*Exit check*, which was itself frozen on **2026-09-20 before either probe ran**. §2–§4 were written on
**2026-09-20, before the first candidate was generated** and before any number in this directory
existed.

**Do not edit §1.** Amend below it, dated.

---

## 1. The decision rule — copied from `PHASES.md`, unedited

> ### Exit check — frozen 20 Sep 2026, before either probe ran
>
> Let `S₁₄` be `null_guard` survival on the 30 declared tasks, best of the two probes. Today's baseline
> is **1/30 = 0.033**.
>
> - **`S₁₄ ≥ 0.30` → INSERT `14b′` — "make the thing that worked the default."** A shape going from
>   unusable to usable changes the product more than 14c does, and it would be wrong to ship 14c first
>   on the grounds that it was already planned. `14b′` is: whichever of the two probes won (a 14B
>   worker, or planner-side decomposition into single-function tasks) becomes the default, with the
>   memory arithmetic re-done if it is the 14B — CLAUDE.md #5 is not negotiable, and one 14B means one
>   worker rather than two.
> - **`0.10 ≤ S₁₄ < 0.30` → PROCEED to 14c, and record the shape as *"improvable but not usable"*.**
>   Worth returning to after the reach work, not worth reordering for.
> - **`S₁₄ < 0.10` → PROCEED to 14c, and write the ceiling down as a product fact.** The Shapes row
>   stops being a thing to fix by tuning, the 90 % bar rests on Reach + Cost + a narrower shape list,
>   and `README` says which shapes sidecrew is for rather than implying all of them. **This is a
>   complete result**, and the same sentence §2.2 earned: a negative result reported without looking
>   for a cut of the data where it passes.
>
> **In every branch, 14b cuts no version and adds no code.**

`S₁₄` is reported as **`k/30` with an exact Clopper–Pearson interval**, never as a bare fraction, using
the `clopper_pearson` already in `scripts/results-11b.py` rather than a second implementation. At
`n = 30` the intervals for 3/30 and 6/30 overlap, so **0.30 is a decision rule and not a claim of
precision.**

`D = 0.105` — the gate's own measured error rate — applies here. It was measured on #2a's gate and this
is #2a's gate.

## 2. The task set: the same 30, and why it may not be regenerated

The 30 tasks are `experiments/correction-round/plans/project-a-2026-09-20/change_plan.json`, **1 step,
30 tasks, every one `shape: "null_guard"`, one file each, 42 errors covered**, under
`--strictNullChecks` (ADR-0063). Verified intact before this run.

That plan is **gitignored** (`.gitignore:46`) because its `project` key is an absolute path to the
client's checkout, and CLAUDE.md #7 forbids committing it. It exists on the owner's machine and nowhere
else.

**Comparability with the 1/30 baseline requires literally these 30 tasks.** A regenerated set is a
different experiment and an `S₁₄` computed on it cannot be compared with the baseline — which is the
only thing this phase is for. The set was not regenerated, re-planned or refreshed.

Baseline to compare against:
`experiments/correction-round/results/correction-round-2026-09-20.json` — `pass1.survived = 1 of 30`,
funnel `answered 59 · confined 25 · compiled 1 · suite_green 1`, `no_edit_at_all = 34`.

**Every figure here is under `--strictNullChecks` and may not share a table cell with a figure taken
under the project's own configuration** (ADR-0063 condition 3).

## 3. The two probes, and the third that is already answered

Same 30 tasks, both.

**Probe 1 — the 14B.** `qwen2.5-coder-14b-4bit`, pinned in `src/models.json` at revision
`29efdbab55a1`. The machine hosts one 14B **or** two 7Bs, never both (CLAUDE.md #5), so it is a clean
swap and concurrency drops to 1. Phase 6 measured the 14B *matching* the 7B on TypeScript at 2.2×
generation time; this asks whether that holds on a shape the 7B cannot do at all.

**Probe 2 — decomposition to a single function.** Settles whether the failure is task **size** rather
than task **kind**. What this can and cannot be is worth stating exactly, because the obvious reading
is not available:

- The return format is **whole-file** (ADR-0047 §2) and ADR-0075 — symbol-scoped return — is
  undecided; it is 14c's, not this phase's. So "decomposed" here means the **ask is narrowed to the
  single function containing the error**, named with its line range, while the whole file is still
  returned.
- The alternative — extracting the function into a standalone fixture and gating it on `tsc` alone —
  would drop the project's own suite from the gate. That is not the production gate (ADR-0046,
  ADR-0048), so its survival rate would not be comparable with the 1/30 baseline, which is the only
  thing this phase is for. **It was rejected for that reason and not attempted.**
- Therefore probe 2 tests **reasoning scope**, not output size. The honest statement of its negative
  case: an `S₁₄` that stays low under probe 2 rules out *ask-narrowing* as the lever, and does **not**
  rule out a genuinely symbol-scoped task of the kind 14c would make possible.

**Probe 3 is already answered — it is recorded here so nobody runs it.** *"Is it the whole-file return
format?"* **No.** All 30 files were **under** the rewrite ceiling, largest 18.9 KB, with **0 truncated
and 0 unparsed**. The format caps what can be *reached* (14c, ADR-0075); it is not why the reachable
ones failed.

## 4. Written before the numbers: one prior, and the threats

**The prior, stated in advance because it will be tempting to notice it afterwards.** Pass 1's single
survivor, `snc-01`, is **the smallest file in the set** — 648 bytes, against a next-smallest of 892 and
a median of about 5 KB. That is `n = 1` and proves nothing, but it points the same way probe 2 does.
So: **if probe 2 lifts survival, this prior is why that result is less surprising than it looks, and it
was written down before the run rather than discovered in the data.** Conversely, a probe 2 that does
*not* lift survival is evidence against size mattering even where the prior pointed that way.

Threats, all inherited and none removed by this phase:

1. **The task set was chosen to contain failures** (§2.2's §4.5), and under ADR-0063 the *strictness
   setting* was chosen too. No rate here says how often real work hits this shape.
2. **ADR-0071 — 12 of the 29 twice-failed tasks were unsatisfiable by construction**: a test file the
   plan may never list gains an error when the task's file changes type. Those remain in the
   denominator, because changing the set after seeing failures is what §4.0 precondition 4 forbids.
   **A per-task outcome table is recorded so a reader can see the clean subset without the denominator
   being quietly adjusted.**
3. **`D = 0.105`.** At `k` of 30, the gate's own error rate is not negligible against the 0.10
   threshold, and a result landing near a boundary is reported as landing near a boundary.
4. **ADR-0069** — a run crossing local midnight against a stale baseline can lose the whole run. Unlike
   §2.2, where 15 verdicts crossed and none reached the suite, suite-stage verdicts are the *expected*
   case here if a probe works. Both runs are scheduled not to cross, and `baseline_captured_at` /
   `verified_at` are read off every verdict rather than reasoned about.

## 5. How it is run

- **From a clean tree at a recorded commit.** A `tsx` harness imports `../src/*.js` from source, so
  uncommitted edits would compile into the run with nothing in any log to show it.
- **One measurement on the machine at a time, nothing else running.** The 14B's measured footprint is
  8.2 GB and Phase 6 measured it **swapping 3.2 GB** on this machine with Xcode and a simulator open at
  9.1 GB free — while *reporting a lower peak RSS*, because macOS compresses under pressure. Contention
  manufactures exactly the false negative ADR-0066 is about.
- **`changeSurvives` is untouched.** The gate is the production gate; this phase changes what a worker
  is *asked* and which model answers, never what survival means. **No product code changes in any
  branch of this phase.**
- Per-probe: `sidecrew fix` on the plan with `correction.enabled: false`, so each task gets attempt 0
  and, on failure, ADR-0022's free mechanical retry — exactly pass 1's configuration, with only the
  worker (probe 1) or the ask (probe 2) varying.

**Machine:** Mac14,10 · Apple M2 Pro · 32 GB · macOS 26.6.2 · node v22.23.2 for anything touching the
project's suite (ADR-0049), `NODE_OPTIONS=--max-old-space-size=8192` for `tsc` (ADR-0032).

**Commit at declaration:** `03b10f0565417d51917568a50d9f688fd40555c8`.

`project-a`, never the client (CLAUDE.md #7).

---

## Amendment, 2026-09-20 — a prediction for probe 2, written while it runs

*§1–§4 are unedited. This is written **after probe 1 reported and before probe 2 has produced a single
verdict**, which is the only time it is worth anything. Phase 12's `N = 41` arm used the same device:
a caveat written afterwards is a description of how one felt about the result.*

Probe 1 found that **21 of the 30 tasks are unsatisfiable under ADR-0071**, every one of them because
a **test file** gained a type error — 21 test files, **0 non-test source files**. Tightening a type
under `--strictNullChecks` propagates into fixtures and mocks, and the gate forbids editing tests
because tests *are* the gate (ADR-0046).

**The prediction: probe 2 cannot fix this, and its `S₁₄` will also land below 0.10.**

The reasoning is mechanical rather than empirical. Narrowing an ask changes *what the worker is asked
to reason about*; it does not change *what a type change does downstream*. A guard added inside one
named function propagates to a test fixture exactly as the same guard added by a whole-file ask does.
So decomposition can convert `no_edit_at_all` into an attempt — which is the thing probe 2 is actually
testing — but each conversion lands in the unsatisfiable bucket rather than in survival.

**What would falsify it**, and each of these is worth more than the prediction being right:

- `S₁₄ ≥ 0.10` on probe 2. Then narrowing the ask does something the mechanism above does not explain,
  and the unsatisfiable analysis is incomplete.
- Probe 2's unsatisfiable count staying near pass 1's **12** while its `no_edit_at_all` count falls.
  That would mean narrowed asks produce edits which do *not* propagate — a smaller, more surgical
  change — and would make ask-narrowing a real lever after all.
- A non-test source file gaining an error. Probe 1 had none in 21; one here would mean the type
  changes are not confined to the test boundary and the whole reading is wrong.

**If the prediction holds, `S₁₄ < 0.10` is confirmed by both probes and the frozen rule's third branch
applies** — with the ceiling recorded as what it measurably is: not the model's, but the gate's scope
on this shape.

---

## Result, 2026-09-20 — `S₁₄ = 2/30 = 0.067`, and the prediction held

Run against §1 as frozen. Full result in `results/editing-ceiling-2026-09-20.json`; per-probe files
and per-task classifications beside it.

| | |
|---|---|
| probe 1 — 14B, whole-file ask | **2 / 30** = 0.067 · 95 % `[0.008, 0.221]` |
| probe 2 — 7B, ask narrowed to one function | **1 / 30** = 0.033 · 95 % `[0.001, 0.172]` |
| **`S₁₄`** (best of the two) | **2 / 30 = 0.067** · 95 % `[0.008, 0.221]` |
| baseline | 1 / 30 = 0.033 · 95 % `[0.001, 0.172]` |
| **verdict** | **`S₁₄ < 0.10` → PROCEED to 14c, and write the ceiling down as a product fact** |

§1 said in advance that this branch is **a complete result**, and it is reported without looking for a
cut of the data where it passes.

### The verdict is not the finding

| arm | declined | **target fixed correctly** | unsatisfiable | survived |
|---|---|---|---|---|
| pass 1 — 7B, whole-file | 17 | **8** | 12 | 1 |
| probe 2 — 7B, narrowed | 10 | **14** | 18 | 1 |
| probe 1 — 14B, whole-file | 3 | **17** | 21 | 2 |

**Both probes did what they were built to do.** The 14B nearly eliminated the decline behaviour, 17 → 3.
Narrowing the ask cut it too, 17 → 10 — so task *size* was a real part of why the 7B would not attempt,
which is the question probe 2 existed to answer. Neither converted into survival.

**Against pass 1, probe 2 fixed +6 more targets correctly and gained +6 unsatisfiable; probe 1 fixed
+9 and gained +9.** One to one, in both arms. Every extra target a worker gets right becomes an
unsatisfiable task.

**Why:** of probe 1's 21 unsatisfiable tasks the sinking error is in a **test file in 21 of 21**, and
in a non-test source file in **0**. The guard narrows a type, the narrowed type propagates into
fixtures and mocks, and the gate forbids editing tests because tests *are* the gate (ADR-0046). No
legal edit passes. And it worsens with capability — 12 → 18 → 21 — because a file nobody edits cannot
break anything downstream.

So the ceiling is real and it is **not the model's**. **ADR-0077 (proposed)** puts the four options to
the owner and recommends measuring the counterfactual before choosing.

### The prediction, and what it would have taken to break it

The amendment above was committed at `04c7dc6` **after probe 1 and before probe 2 had a verdict**. It
held: declines 17 → 10, unsatisfiable 12 → 18, survival 1 → 1. **None of its three falsifiers fired** —
probe 2 did not reach 0.10, its unsatisfiable count did not stay near 12, and no non-test source file
gained an error in either probe.

### What weakens this, stated rather than discovered later

1. **`D = 0.105`.** `S₁₄ = 0.067` sits below the 0.10 threshold **by less than the gate's own measured
   error rate**. The branch is not carried by that margin; it is carried by **both probes agreeing**
   and by the mechanism being visible in the fields rather than inferred from the rate.
2. **The reachable maximum was never 30.** 12 of the 30 were already unsatisfiable for the 7B, so no
   probe could have scored above 18/30 = 0.60, and the 0.30 threshold sat at half of what was
   reachable. **The rule is applied to 30 as written** — this is recorded, not used as an adjustment.
3. **Both choices still bias this set** — chosen to contain failures, under a chosen strictness flag
   (ADR-0063, §4.5). No rate here says how often real work hits this shape.
4. **The counterfactual is not claimed.** 15 tasks had a clean target with only test-file errors and
   would have *reached* the suite under different scoping. Whether they survive it is unmeasured, and
   ADR-0077 option D is the run that would answer it.

### Environment

Both runs finished on the local day they started, so **ADR-0069 has no purchase**: 0 crossing verdicts
in either probe, read off `baseline_captured_at` / `verified_at`. Machine state per verdict is in the
result files; pressure was normal throughout, and the checkout was byte-identical before and after.
Claude tokens spent on worker inference: **0**, enforced by the schema.
