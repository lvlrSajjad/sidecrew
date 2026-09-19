# The gate's own error rate (Phase 12, §4 of the handoff)

**Question:** when the gate is shown a candidate it has already judged, how often does it judge it
differently — and therefore, how loose is the phrase *"every survival rate in this repository is a
lower bound of unknown tightness"*?

This file is the **frozen artefact**. §4 was written on **2026-09-19, before a single replay was
run**, and before anything was known beyond the two disagreements §2 records. **Do not edit §4.**
Amend below it, dated, the way ADR-0020 amended Phase 6's.

The owner approved this measurement on 19 Sep 2026. It is the highest-value item in the phase because
it turns the project's biggest standing caveat into a number, which is the move that has paid every
time here.

## 1. Why this is not already known

Three independent sources of workload-#2a false negatives are known. Only one is understood:

| source | state |
|---|---|
| memory pressure — ADR-0066 | diagnosed, measured twice, **option C implemented 19 Sep** (recorded on the verdict, gates nothing) |
| a stale baseline — ADR-0069 | diagnosed, measured once, **option A implemented 19 Sep** (recorded on the verdict, gates nothing) |
| `experiments/status-quo/README.md` **O8** | **undiagnosed** — and §2 below is a second instance of it |

Every one of them biases in the same direction: the gate refuses a change that was fine, and the
refusal is indistinguishable in the artefact from a real defect. So every survival rate this project
has published is a **lower bound**, and nobody knows by how much. That sentence appears in the README,
in ADR-0066, in ADR-0069 and in two phase reports, and it has never had a number attached.

## 2. What is already measured, at zero cost, before any replay runs

Phase 11b's arm D ran **the gate over Opus's own diffs** on both projects, and the mechanical retry
means its run directories already contain candidates that were **evaluated twice**. The candidates
survive on disk even though the arm sandboxes do not — *the run is the record, not the verdict* — and
their edits hash byte-for-byte.

| case | edits sha | attempt 0 | attempt 1 | agree? |
|---|---|---|---|---|
| project-a `multi-06` | `1c31aa97b4f22c64` | **failed** at `tests`, 12 regressed | **survived** | **no** |
| project-b `multi-02` | `6626afd9464eaffd` | failed at `compile` | failed at `compile` | yes |

**The second row is what makes the first one a finding rather than an anecdote.** On a real defect the
gate is perfectly reproducible; on this one it is not, four minutes apart, on identical bytes.

**And this one is not ADR-0066.** Cross-referenced against the pressure recorder that ran throughout
(`experiments/status-quo/results/pressure-project-a.csv`, 20 s samples), both attempts sat at
**pressure 1 (normal), swap flat at 2.2 GB — the run's own floor — and 9–12 GB free**. There was no
swap growth and no pressure event. It is not ADR-0069 either: both attempts fall in the same local
calendar day as their baseline. All 12 regressions are in **one** suite file, out of 6,368 executions,
with `ran_before == ran_after`.

So the undiagnosed class is real, it is reproducible enough to have appeared twice, and it appears on
a quiet machine — which is precisely why it needs a rate rather than another anecdote.

## 3. The method, and what the corpus is

**Replay known-good candidates through the gate and count disagreements.**

The corpus is **Phase 11b arm D's candidates**, both projects, 19 tasks each. They are the ideal input
and the handoff says why: they are a frontier model's own output, 18 of 19 byte-identical to the local
worker's on project-a, and arm D already established the gate finds no defect in them. **Any
disagreement on a replay is therefore a property of the gate, not of the change.**

Each replay is one evaluation of one candidate's exact bytes against a baseline captured today. Paired
with arm D's recorded verdict for the same bytes, that is **one pair of evaluations**, and the pair is
the unit.

**Budget:** ~262 s per replay (Phase 11's measured gate cost). Nineteen candidates is ~85 minutes of
machine time per project.

### Two confounds that are handled rather than hoped away

1. **A date-dependent test is not a gate error.** ADR-0069 measured a test in project-b that fails on
   unmodified code depending on the day. A replay run today captures **today's** baseline, so a test
   that flipped between 18 and 19 September is recorded as failing *before* the change as well and
   contributes no regression. This is why the replay re-captures rather than reusing arm D's baseline.
2. **The reference verdicts predate ADR-0067**, so they carry no `passed_before` / `passed_after` and
   do not parse under the current `ChangeVerdict`. The comparison is therefore made on the reference
   JSON's `survived` field read directly, and the replay's `survived` computed by the current schema.
   Recorded here because a silent schema upgrade mid-comparison is exactly how a number stops meaning
   what its label says.

## 4. The decision rule — frozen 2026-09-19, before the first replay

### 4.0 Preconditions

A replay run is read only if all hold. Any one failing makes it **void**, not marginal:

1. **One measurement on the machine at a time.** Nothing else running. Replaying under contention
   would manufacture the exact false negative this experiment exists to count, which would be the
   measurement destroying its own instrument.
2. **A pressure recorder samples every 20 s for the whole run**, and its `free_gb` agrees with
   `parseMemory`. Every replay verdict additionally carries its own `machine` sample pair (ADR-0066
   option C, landed today), so the run has both a timeline and a per-verdict record.
3. **Replays run one at a time**, `--concurrency 1`.
4. **The project's working tree is unmodified** and on the same commit arm D ran against. A replay
   against different source is not a replay.
5. **No verdict cache.** ADR-0065 forbids it anyway; stated here because a cached verdict would make
   the disagreement rate identically zero and look like a result.

### 4.1 What counts as a disagreement

For one candidate, with edits byte-identical to the reference's:

> **A disagreement is a replay whose `survived` differs from the reference verdict's `survived`.**

Nothing else counts. Not a different `stage_reached` at equal survival, not a different regression
count, not a different timing. Those are reported and are not the rate, because the gate's output that
anything downstream consumes is `survived` — `changeSurvives` is the whole contract (ADR-0048), and a
rate defined on something the pipeline does not read would be a rate about nothing.

Disagreements are counted in **both directions and reported separately**, because they mean opposite
things:

- **strict-direction** — the reference survived and the replay failed. A false negative *now*.
- **lenient-direction** — the reference failed and the replay survived. Evidence the *reference* was a
  false negative, which is the same defect seen from the other end. `multi-06` above is this one.

### 4.2 The denominator

**`D = disagreements ÷ pairs`, where a pair is one candidate evaluated twice** — once by arm D, once
by the replay. `pairs` is the number of candidates replayed, not the number of tasks planned and not
the number of runs.

Excluded from `pairs`, each named individually in the result with its reason:

1. A candidate whose reference verdict stopped at `generate` — there is no gate evaluation to disagree
   with.
2. A candidate whose replay could not run for a machine reason (a missing toolchain, a full disk).
   These are `machine_failures` in the sense ADR-0056 already defined and they were never the gate's.

**A candidate that the reference recorded as failing is NOT excluded.** It is the lenient-direction
denominator and dropping it would measure only the half of the phenomenon that is comfortable.

`D` is never reported without `pairs`, for the reason `P` is never reported without `N`: at 19 pairs a
single disagreement is 0.053 and the interval around it is enormous. **The result carries an exact
Clopper-Pearson interval**, computed the way `scripts/results-11b.py` already does it.

### 4.3 The rule

`D` is a **per-evaluation** disagreement rate, and every published survival rate is biased downward by
approximately the strict-direction half of it.

- **ACCEPTABLE — `D ≤ 0.02`.** The gate disagrees with itself at most once in fifty evaluations.
  Published survival rates stand as they are, with a stated caveat of about ±1 task at N ≈ 19, and the
  phrase "lower bound of unknown tightness" is replaced by this number wherever it appears.
- **MATERIAL — `0.02 < D ≤ 0.10`.** The caveat is real and quantified. **Every survival rate this
  project publishes must carry `D` beside it**, ADR-0066's option A stops being proposed and becomes
  required before the next go/no-go, and no two rates may be compared without saying whether their
  difference exceeds `D`.
- **UNACCEPTABLE — `D > 0.10`.** More than one evaluation in ten is decided by something other than
  the change. **No survival rate may be published as a point estimate** until the cause is diagnosed.
  The tool's claim is withdrawn to the half that still holds — *the gate admits nothing that fails* —
  and the half that does not, *it refuses only things that fail*, is stated as unproven.

**`D > 0.10` is not a reason to stop, and is not a reason to disbelieve the design.** The gate's value
was never that it is precise about rejection; it is that **nothing survives it that should not**. A
high `D` damages the *rate* as a published statistic and leaves the safety property untouched. Say it
in those words rather than reaching for a softer framing.

### 4.4 What this measurement does not answer

- **It does not diagnose the cause.** A rate is not a mechanism, and O8 stays undiagnosed until
  something explains it. Any diagnosis that arrives is an ADR, not an edit here.
- **It does not measure the lenient direction of the gate** — candidates that survive and should not.
  That is the blind approval rate `A(x)`, it is a human judgement, and no replay can produce it.
- **It says nothing about workload #1's gate.** Mutation testing is a different oracle with different
  failure modes, and the corpus here is entirely #2a.

## 5. What is written down

`results/gate-error-rate-<date>.json` with `"measured": true`, machine info, the commit, the reference
run ids, every pair with both `survived` values and the candidate's edits hash, the exclusions with
reasons, `D` with `pairs` and its interval, the pressure timeline, and the verdict §4.3 produced.

**Machine:** Mac14,10 · Apple M2 Pro · 32 GB · macOS 26.6.2 · node v20.20.0 (project-a's suite needs
node ≥ 22.18.0 and uses v22.23.2 — ADR-0049).

Results name `project-a` and `project-b` and never the client (CLAUDE.md #7). Candidate contents,
regression names and diffs quote the client's source and are never committed; the hashes and the
counts are ours and stay.

---

## Amendment, 2026-09-19 — three operational rulings §4 did not anticipate, all settled before the first replay

*Not an edit to §4. Its rule, thresholds, denominator and exclusions stand as frozen. What follows is
how the harness resolves three cases §4 is silent on, written down before any replay ran so that none
of them is a choice made after seeing a number.*

### 1. A reference candidate with two evaluations that disagree with each other

§4.1 says "the reference verdict's `survived`", singular. The mechanical retry means some candidates
have **two** reference evaluations, and for project-a `multi-06` those two disagree — which is the
whole of §2.

Ruling: **the candidate is already a measured disagreement and is counted as one.** The replay still
runs and is reported as a third opinion, compared against the **majority** of the reference
evaluations, and every row carries `reference.evaluations` and `reference.self_consistent` so the
collapse to a single value is visible rather than implied. Dropping such a candidate would remove from
the denominator precisely the cases the experiment exists to find, which is the denominator error this
project has written down twice and is not going to make a third time.

### 2. One baseline for a corpus that came from two steps

The reference run had two steps, and step N+1's baseline is the project after step N's survivors
landed. In principle a step-1 candidate could therefore assume a change a pristine baseline does not
contain.

Ruling: **the harness asserts the steps' file sets are disjoint and refuses to run if they are not.**
Measured on this corpus: step 0 is 12 `rename` tasks over 12 files, step 1 is 7 `multi` tasks over 16
files, and the **overlap is zero** — so one pristine baseline serves all 19 and no candidate is judged
against a world it did not assume. Where a future corpus overlaps, the replay is per group against its
own baseline; the assertion is what makes that a refusal rather than a silent wrong answer.

### 3. The corpus is deduplicated by content, not by task id

Two reference evaluations of the same task are the same bytes in every case observed (both retry
pairs hash equal). Ruling: **the replay runs once per distinct `edits_sha`**, not once per verdict
file. Replaying identical bytes twice would inflate `pairs` with a second evaluation that carries no
new information, and §4.2's denominator is candidates, not verdicts.

### What the harness is, and one hazard it inherits

`scripts/gate-replay.ts` drives `verifyChange` — the production gate, the same function `runFix`
calls — over the tasks and candidates the reference run wrote to disk. It does **not** reconstruct a
plan: the plan is gitignored and was not kept, and it is not needed, because every task and candidate
was written as the run went (ADR-0023). *The run is the record, not the verdict.*

It is a `tsx` harness, so it imports `../src/*.js` **from source**. Uncommitted edits to `src/` are
compiled into a run at the moment it starts with nothing in any log to show it, and "I only edited
source, I did not rebuild" is therefore not a safety argument. The run is started from a clean tree
and the result records the commit.

---

## Result, 2026-09-19 — `D = 2/19 = 0.105`, **UNACCEPTABLE** by one pair

Run against §4 as frozen, on the machine and at the commit §5 requires. Full result in
`results/replay-project-a-2026-09-19.json`.

| | |
|---|---|
| pairs | **19** (20 reference evaluations → 19 distinct candidates) |
| disagreements | **2** |
| strict (a false negative *now*) | **1** — `rename-10` |
| lenient (the reference was one) | **1** — `multi-06` |
| **`D`** | **0.105** |
| §4.3 verdict | **UNACCEPTABLE** (`D > 0.10`) |
| machine | pressure normal throughout; swap 1.2 → 1.7 GB over 100 minutes |
| baseline | 6,138 / 6,368 passing, 1 `tsc` error, 319 s |

**The verdict is UNACCEPTABLE by a single pair**, and at `pairs = 19` that is exactly the fragility
§4.2 anticipated when it required the denominator to travel with the number: one disagreement either
way moves `D` between 0.053 and 0.158, across two of the three bands. **`D = 0.105` is not a precise
quantity and must never be quoted as one.** What the run establishes is the order of magnitude — the
gate disagrees with itself on the order of one candidate in ten, not one in a thousand — and that is
enough to act on, because §4.3's consequences were written against bands rather than points.

### The two disagreements

**`multi-06` — lenient, and it resolves a case that was previously ambiguous.** Its two reference
evaluations of identical bytes disagreed with each other (§2). The replay is the third evaluation of
`1c31aa97b4f22c64` and it survived, so the count is now **2 survivals in 3 evaluations** and attempt
0's failure is a false negative on the evidence rather than on suspicion. *The tie-break matters and
is reported: §4's amendment collapses a reference to its majority, and a 1–1 split collapses to
`false`, so this row is counted as a disagreement. Had the tie broken the other way it would have
been counted as agreement, `D` would read `1/19 = 0.053`, and the verdict would read MATERIAL.* That
sensitivity is a property of a 19-pair denominator and is the reason §4.2 forbids the bare number.

**`rename-10` — strict, and it is new.** The reference evaluated it once and it survived. The replay
failed it at `tests` with **72 regressions**, on a machine at pressure normal whose swap *fell* by
0.19 GB during the verification, against a baseline captured the same calendar day. It is neither
ADR-0066 nor ADR-0069. It is a **fresh instance of the undiagnosed class**, produced deliberately
rather than stumbled upon, which is the first time that has happened.

### One structural observation, offered as a lead and not as a diagnosis

Across **every verdict on disk that records a regression** — six of them, including ADR-0066's 155,
ADR-0069's 1, and `multi-06`'s 12 — **every regressed test lies in exactly one suite file.** Not one
spans two. The counts differ by two orders of magnitude and the causes are known to differ (memory in
one case, the wall clock in another), yet the shape is identical.

That points at a **suite-level** mechanism rather than a test-level one: a spec file that fails to
run at all — setup, teardown, a shared resource, a timeout — and every test inside it is recorded as
having regressed. It would explain why the counts are large and arbitrary, why they are reproducible
on a real defect (`multi-02` failed at `compile`, twice, deterministically) and not on these, and why
no amount of reading individual test names has diagnosed it.

**It is a lead and not a result, for a reason worth stating.** This corpus contains **no true
`tests`-stage negative** to contrast against — arm D's candidates are a frontier model's own output
and contain no defect. So the signature "all regressions in one suite" is consistent with every
observed false negative and has never been tested against a genuine one. Until something produces a
real test-stage failure and it is checked for the same shape, this discriminates nothing. §2.2's run
is the first thing on the schedule that would produce such cases.

### What follows immediately, per §4.3's UNACCEPTABLE clause

1. **No survival rate in this repository may be published as a point estimate** until this is
   diagnosed. That includes Phase 11's and Phase 11b's, and it is the correct reading of numbers that
   were always described as lower bounds of unknown tightness.
2. **The safety property is untouched and should be stated in the same breath.** `D` measures the
   gate refusing things that were fine. Nothing here is evidence of the gate *admitting* something it
   should not, and the corpus cannot produce such evidence. *The gate admits nothing that fails*
   stands; *it refuses only things that fail* is now measured to be false at roughly one in ten.
3. **ADR-0066's option A is not the fix.** Both disagreements here occurred at pressure normal with
   swap flat or falling, so a rule that downgraded pressured failures to `machine_failure` would have
   caught neither. The pressure hypothesis is a real cause of *some* false negatives and is not the
   cause of these.
