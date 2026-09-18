# Go/no-go for workload #2a (Phase 11)

**Question:** can a 7B make a correct small change to unfamiliar code at all — and is what survives the
2a gate a change Opus would have accepted?

This file is the **frozen artefact**. `docs/plan/prompts/phase-11-go-no-go-2a.md` is only how it got
here. §4 below is copied **verbatim** from that prompt, where it was written on 2026-09-16 during Phase
10, **before `sidecrew fix` had produced a single verdict and before anybody had seen a survival rate
for this workload**. Copied into place on 2026-09-17, before the first run of this experiment, at
commit `95ee2d8`.

**Do not edit §4.** If it turns out to be the wrong rule, append an amendment *below* it, dated, the
way ADR-0020 amended Phase 6's — so the run stays readable against the rule that was in force when it
ran.

## 1. The question

**Can a 7B make a correct small change to unfamiliar code at all?**

Nothing measured so far touches it. Workload #1's ~0.40 on real projects is about *writing a test for a
function whose body it was handed*. This is about *reading code it was not given a tour of and editing
it*.

The secondary question, which the design's economics turn on: **is what survives the 2a gate a change
Opus would have accepted?** For 2a a survivor is a **change to the user's source**, and the whole claim
of `VISION.md` is that the user cannot tell the difference. §4's approval guard is how that claim gets a
number instead of an assurance.

## 2. Inputs — identical for every configuration

- **The fixture**: `fixtures/fix-fixture`, three planted errors of three kinds, its own suite, one test
  that has always failed. Its number is the cheap one and it **overstates real-world**. Labelled.
- **Unmodified real projects, on both stacks** — `project-a` (Nest/jest, 354 suites, 6,368 tests) and
  `project-b` (React/jest, 772 suites, 8,795 tests), the same two the six workload-#1 trials used. *Unmodified*: if the project has to be changed to be
  verified, that is a finding about sidecrew, not a setup step.
- **Hand-written change plans**, validated with `sidecrew fix --dry-run` before the run, identical for
  every configuration.
- Same gate, same confinement rules, same retry policy, same baseline capture.

### The denominators — the three exclusions, applied before the run

1. **A task whose correct fix needs a file the task does not list cannot survive**, because the diff
   would break confinement. Check every task by hand: is there a fix inside these files? If not, fix
   the plan or drop the task and say so.
2. **A task whose baseline has zero errors in its own files has nothing to do.** Drop it.
3. **A task whose files no test exercises** is a task the suite half of the gate cannot judge. Do
   **not** drop it — count them separately, because their survivors are admitted by `tsc` alone.

## 3. Configurations

| id | worker | how | notes |
|----|--------|-----|-------|
| C2 | Qwen2.5-Coder-7B-Instruct-4bit | `sidecrew serve` | the primary candidate |
| C2b | Qwen2.5-Coder-14B-Instruct-4bit | `sidecrew serve --model qwen2.5-coder-14b-4bit` | only if §4 needs it |
| C3 | Claude Haiku | the `haiku-worker` agent harness, as Phase 6 used it | the control |

**C3's token figures are an upper bound and not what the `api` tier costs** (ADR-0045 §7, Phase 13).

C1 (Apple Foundation Models) is not run.

## 4. The decision rule — frozen 2026-09-16, before any number existed

### 4.0 Precondition: the gate has to be honest before its number means anything

This is not a criterion, it is a validity check, and it comes first because ADR-0037 is the most
expensive thing six trials bought: **a gate that passes quietly turns "same quality as Opus" into a lie
that nothing detects.**

Before any rate is believed, all three must hold:

- every planted Goodhart control (`@ts-ignore`, deleting the offending line, editing the tsconfig, and
  every other rule in ADR-0048) **fails the gate** in this run's own pipeline, not merely in Phase 10's
  unit tests;
- every survivor's verdict shows the suite **ran** — `tests.ran_after ≥ tests.ran_before > 0` — and the
  confinement checker reports the files it actually compared;
- at least one survivor is re-verified from scratch, from its recorded diff, and reaches the same
  verdict.

If any of these fails, the run is **void**. Fix it, note it, rerun every configuration. Do not report a
rate from a run whose gate could not prove itself.

### 4.1 The two measured quantities

Let, on the same inputs and per project (never pooled, never averaged across projects):

- **S(x)** = survivors ÷ tasks for configuration *x*.
- **A(x)** = the **blind approval rate**: of a sample of *x*'s survivors, the fraction that a reviewer,
  shown the diff and the ask and **not** told which configuration produced it, says they would have
  accepted as the change. Sample = `min(10, survivors)`, drawn deterministically from the `run_id` and
  `task_id` the way `sidecrew review` draws its audit sample. Every configuration's sample is reviewed
  in one shuffled pass, so the reviewer cannot tell C2's diffs from C3's.

**Why A exists, and why it is not optional.** ADR-0020 had to be written after Phase 6 because survival
rate alone could not separate "survived" from "survived by not testing the thing" — the control passed
`truncate:boundary` by never asserting the boundary the bug lived on. The 2a form of that failure is
worse, because a 2a survivor is **edited source**. The mutation score was workload #1's mechanical
proxy for it; 2a has no such proxy, so the guard is a human-equivalent judgement, made blind, on a
sample, and reported as a number. A design whose headline is *"the same quality Opus would produce"*
has to be willing to measure exactly that.

### 4.2 Latency is reported, never a criterion

Phase 6's rule had `L(C2) ≤ L(C3)`. It does not carry over and importing it would measure the wrong
thing: for 2a the expensive stage is **the project's own test suite**, which is identical for every
configuration and has nothing to do with the worker. `VISION.md` already rules out any claim of being
faster per unit. Report generate-stage and gate-stage medians separately, and let the rule turn only on
S and A.

### 4.3 The rule

Applied per project. Report each project's cell; never average them into one.

- **GO** — `S(C2) ≥ 0.90 · S(C3)` **and** `A(C2) ≥ 0.90 · A(C3)` **and** `S(C2) ≥ 0.25` **and**
  worker tokens(C2) = 0.
- **GO-WITH-14B** — `0.75 · S(C3) ≤ S(C2) < 0.90 · S(C3)`, and C2b clears every GO clause above.
- **CONDITIONAL GO** — C2 is in that band, C2b does not rescue it, **and** `A(C2) ≥ 0.90 · A(C3)` and
  `S(C2) ≥ 0.25`. Ship the local tier for that project's stack with the measured rate stated in the
  README, exactly as ADR-0020 set the precedent. It is not a GO; the bar is 0.90 and stays 0.90.
- **NO-GO (revisit)** — `S(C2) < 0.75 · S(C3)` and 14B does not fix it; **or** `A(C2) < 0.90 · A(C3)`
  at any survival rate; **or** `S(C2) < 0.25`.

**The approval guard is a veto, not a tiebreak.** Below it, every other cell collapses to NO-GO. A
worker that gets changes past the gate that a reviewer would not have accepted is worse than a worker
that gets nothing past it, because the second kind of failure is visible.

**Why the absolute floor is 0.25, decided without a number in hand.** The ratio clauses ask whether the
7B is close to Haiku; the floor asks whether the *workload* pays for itself at all. Below one task in
four, three quarters of the work is escalation, Opus does that work itself, and the premise this whole
design rests on — that the deciding is much smaller than the doing — has failed for this workload. At
that point the answer is not a better worker, it is a different unit of work. The floor is what stops a
good ratio against a weak control from reading as a green light.

### 4.4 The clause that says the number is not about the model

Phase 10 chose **whole-file rewriting** as the edit format (ADR-0047) and recorded the risk in the same
breath: a 7B asked to reproduce a 300-line file with one line changed can truncate it, drift in it, or
fail to emit it in the expected form, and none of that is evidence about whether it can reason about
the change. So:

> If `edit_parse_failed + edit_truncated ≥ 0.25` of C2's attempts, the run is **INCONCLUSIVE about the
> model**. Report S and A for the record, and do not apply §4.3 to them. The next action is an
> **edit-format experiment** — search/replace blocks against whole-file rewrites, same tasks, same
> worker, same gate — and a re-run of this protocol afterwards. It is not a verdict on workload #2a.

Both counters are in the verdict for this reason. A funnel that collapses at "could not read the
worker's answer" and a funnel that collapses at "the change was wrong" are different findings with
different next steps, and Phase 6's C1 is the precedent for keeping them apart.


---

## Protocol note, 2026-09-18 — the baseline was corrupted by the launcher, not by the machine

**§4 above is untouched.** This is a note against §2 and §5. It **replaces** a note written on 17 Sep
that blamed external memory pressure; that explanation was wrong and is corrected here rather than
quietly deleted, because a protocol that hides its own false starts is not a protocol.

### What was seen
Four runs on `project-a` captured a baseline of **2412–2417 of ~6350 tests passing** where a validated
run had captured **6140**. About 170 whole suites had stopped passing — entire suites, not scattered
assertions.

### What it was not
Each of these was proposed, and each was refuted by measurement rather than argument:

| hypothesis | how it died |
|---|---|
| external load (a browser) | reproduced on a machine with nothing else running |
| memory pressure from the suite's own workers | the suite ran **healthy at 10.6 GB free, while swapping** |
| the resident 7B competing with jest | healthy with the worker up; the worker is irrelevant |
| the `CI=true` the stage sets | identical results in the project and the sandbox, with and without it |
| timezone | the date failures are pre-existing and present in every configuration |
| sidecrew's sandbox | a sandbox run is healthy; so is `captureBaseline` |

### What it was
**The launcher.** Every degraded run was started with `npx tsx`; every healthy one with `node`. Same
code, same project, same machine — isolated to a single spec so each test cost thirty seconds:

| launcher | source | that spec |
|---|---|---|
| `node` | compiled | 176 passed |
| `npx tsx` | source | 176 **failed** |
| `npx tsx` | **compiled** | 176 **failed** — so the launcher, not the compilation |
| `npx tsx`, `npm_*` stripped | compiled | 176 passed |

`npx` exports npm's own state — `npm_config_cache`, `npm_config_prefix`, `INIT_CWD`, `NODE`, a dozen
`npm_package_*` — and every child inherits it, including the project's test runner. A dependency that
resolves a cache directory from those variables then resolves a **different** one:
`mongodb-memory-server` looked for its cached `mongod` where npm pointed rather than where the project
had put it, failed an MD5 check on what it found, and took every suite needing an in-memory Mongo with
it.

### Why this is the workload-#2a form of ADR-0037, and worse
ADR-0037's compile stage could pass a candidate it never opened: the gate **broke**. Here the gate
does not break. The contamination lands in the **baseline**, so the gate quietly gets *weaker* — only
the tests that survived it have to keep passing afterwards, and no field in the verdict says so. A
rate taken against such a baseline is an overstatement that nothing detects. That is exactly the
failure §4.0 exists to refuse, arriving through a door nobody had thought to watch.

**The gate's own asymmetry held, and is worth writing down.** Contamination during a *candidate's* run
fails **closed**: ADR-0048 requires `ran_after ≥ ran_before`, so a candidate whose suite lost whole
files is refused. Only the baseline is exposed, and only upward.

### The fix, and the discipline
The fix is in sidecrew rather than in this experiment (ADR-0052): `stageEnv()` strips what a package
manager exports before the project's toolchain runs, and `src/exec.ts` treats `env: {FOO: undefined}`
as *unset FOO*, which a spread cannot express. Validated on the exact failing path — `npx tsx`, which
produced 2417, now produces 6156.

The discipline stays, because it is what caught this when the explanation was still wrong:

1. A quiet-machine **reference** per project, in `results/baseline-reference.json`.
2. Every run's baseline is checked against it; a mismatch means the run is **discarded and redone**,
   never repaired. This worked: all four contaminated arms were refused and none reached a report.
3. Any task refused with `ran_after < ran_before` is reported separately.

**A reference is only valid for the commit it was measured at.** Both projects moved under this
experiment overnight, which is its own finding about measuring against somebody else's repository:
the reference records the commit, and a project that has moved is re-measured rather than compared.

