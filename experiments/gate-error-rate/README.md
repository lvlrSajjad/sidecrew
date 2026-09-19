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
