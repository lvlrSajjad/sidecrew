# Phase 11 — the go/no-go for workload #2a, and its frozen decision rule

Read `docs/plan/VISION.md`, then ADR-0031 (why 2a is first), ADR-0044 (task shape and steps), ADR-0046
through ADR-0048 (the sandbox, the contract and the gate Phase 10 built), then
`experiments/go-no-go/README.md` — the Phase 6 protocol this one is modelled on, including its
amendment — then this.

> **This file was written on 2026-09-16, during Phase 10, before `sidecrew fix` had produced a single
> verdict and before anybody had seen a survival rate for this workload.** That is the whole point of
> it. Phase 6's value was not its number; it was that the number had somewhere to land. A rule written
> after a number is a description of that number.
>
> **The rule in §4 is frozen.** Do not edit it during or after the run. If it turns out to be the wrong
> rule, say so in an amendment appended *below* it, dated, the way ADR-0020 amended Phase 6's — so the
> run stays readable against the rule that was in force when it ran.

## 1. The question

**Can a 7B make a correct small change to unfamiliar code at all?**

Nothing measured so far touches it. Workload #1's ~0.40 on real projects is about *writing a test for a
function whose body it was handed*. This is about *reading code it was not given a tour of and editing
it*. It could be much better — the task is narrower, the oracle is exact and already written — or much
worse, because the worker has to reproduce code it did not write.

The secondary question, which the design's economics turn on and which Phase 6 had no equivalent of:
**is what survives the 2a gate a change Opus would have accepted?** For workload #1 a survivor is a
test, and a bad test costs a wasted review. For 2a a survivor is a **change to the user's source**, and
the whole claim of `VISION.md` is that the user cannot tell the difference. §4's approval guard is how
that claim gets a number instead of an assurance.

## 2. Inputs — identical for every configuration

- **The fixture**: `fixtures/fix-fixture`, with its planted errors of at least three kinds and its own
  suite. Its number is the cheap one and it **overstates real-world**; workload #1's fixture overstated
  it by more than 2× (`PHASES.md`), and there is no reason to expect this one to be kinder. Label it.
- **Unmodified real projects, on both stacks** — a Nest/jest project and a React/vitest project, the
  same two the six workload-#1 trials used. This is the number that means something, and it is the one
  the publication bar in `VISION.md` asks for. *Unmodified*: if the project has to be changed to be
  verified, that is a finding about sidecrew, not a setup step.
- **Hand-written change plans**, validated with `sidecrew fix --dry-run` before the run, identical for
  every configuration. The planner that writes them is Phase 12; hand-written plans are how this phase
  is exercised, and writing them is part of this phase's cost.
- Same gate, same confinement rules, same retry policy, same baseline capture.

### The denominators, and why they are not "every task"

Phase 6 had to exclude functions that could never survive (no mutants). The 2a analogues, and each must
be found **before** the run, not explained afterwards:

1. **A task whose correct fix needs a file the task does not list cannot survive**, because the diff
   would break confinement. That is a grouping mistake, and grouping is the plan's. Check every task by
   hand: is there a fix inside these files? If not, fix the plan or drop the task and say so.
2. **A task whose baseline has zero errors in its own files has nothing to do.** Drop it.
3. **A task whose files no test exercises** is a task the suite half of the gate cannot judge. Do
   **not** drop it — it is a real shape of real work — but count them separately, because their
   survivors are admitted by `tsc` alone and §5 asks for that number on purpose.

## 3. Configurations

| id | worker | how | notes |
|----|--------|-----|-------|
| C2 | Qwen2.5-Coder-7B-Instruct-4bit | `sidecrew serve` | the primary candidate |
| C2b | Qwen2.5-Coder-14B-Instruct-4bit | `sidecrew serve --model qwen2.5-coder-14b-4bit` | only if §4 needs it |
| C3 | Claude Haiku | the `haiku-worker` agent harness, as Phase 6 used it | the control |

**C3's token figures are an upper bound and not what the `api` tier costs.** Phase 6 measured Haiku
from a subagent harness and ADR-0045 §7 says the tier gets its own number, through this same protocol,
in Phase 13, with the real client. Do not quote this run's C3 tokens as the tier's price.

C1 (Apple Foundation Models) is not run. Phase 6 measured it into the ground on the easier workload;
a 3B told to "avoid code generation" is not going to rewrite a file.

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

## 5. What to measure, per configuration

The funnel, and it has more rows than workload #1's because there are more ways to fail:

```
tasks → answered → edits parsed → applied → confined → compiled → suite green → survivors
```

with `edit_parse_failed`, `edit_truncated` and each **confinement rule** broken counted by name — the
rule names are the contract's (ADR-0048), so the table says *which* cheap pass the worker reached for,
not merely that it did. That table is the most interesting thing this phase produces regardless of the
verdict, because it is the first measurement of what a local model does when it is asked to edit
somebody's code.

Also, per configuration:

- **S(x) and A(x)**, per project, with an exact 95 % interval on S. Phase 6's habit of quoting `4/10`
  with its 0.12–0.74 interval is the standard; a rate from twenty tasks is not a rate.
- **the gate's known hole**: the fraction of survivors whose **changed lines no test that ran
  executed** (`--coverage` over the post-change suite). Those survivors were admitted by `tsc` alone.
  This is the 2a equivalent of ADR-0037's question — *can this gate prove it checked the thing it
  claims to have checked?* — and it is a **reported number, not a criterion**, because a project's
  coverage is the user's business. It belongs in the README next to the rate, so nobody reads a rate as
  a stronger claim than it is.
- generate-stage and gate-stage latency (median, p90), separately;
- peak worker RSS, and whether anything else was open on the machine;
- Claude tokens: planning (the hand-written plans' own cost, measured with
  `scripts/planner-tokens.mjs --mark`), workers (**0** for C2 — the schema refuses anything else), the
  review pass that produced A;
- retries used, escalations, and how many tasks the baseline made impossible per §2's three exclusions;
- **the wall-clock cost of the gate per task**, which is the number Phase 12 needs to decide whether a
  correction round can afford to re-run it.

## 6. Do not

- Do not tune the prompt, the confinement rules or the gate during the run. If you find a bug that
  invalidates results, fix it, note it, and rerun **every** configuration — Phase 6's rule, and the
  reason its numbers are comparable.
- Do not relax a confinement rule because a survivor "obviously" should have passed. Write it down as a
  finding, finish the run, and propose the change as an ADR afterwards with the count attached.
- Do not report a pooled rate across projects, or a rate without its denominator and interval.
- Do not let Phase 12 start on the strength of the fixture's number. The real projects' numbers are the
  ones the correction round's budget has to be argued from.

## 7. Output

- `experiments/go-no-go-2a/README.md` — this protocol, with §4 copied **verbatim**, before the first
  run. It is the frozen artefact; this prompt is only how it got here.
- `experiments/go-no-go-2a/results/go-no-go-2a-<date>.json` — every number, `"measured": true`, machine
  info, and the exact commit.
- `experiments/go-no-go-2a/results/REPORT.md` — one page: the funnel table with the confinement rules
  broken by name, S and A per project with intervals, the coverage hole, the decision against §4.3 cell
  by cell, and what surprised you.
- `PHASES.md` updated, a line in `docs/CHANGELOG.md`, and an ADR for anything the run decided.

## 8. Definition of done

- The §4.0 precondition holds, and the report says so with the evidence.
- Every configuration has run on the fixture **and** on both unmodified real projects.
- §4.3 has been applied cell by cell and the answer is written down, including if it is
  NO-GO or INCONCLUSIVE. **A phase that produces a NO-GO has done its job**; Phase 6 produced one for
  Swift and it is still the most useful thing in that report.
- No rule in §4 was edited. Anything learned about the rule is an amendment below it, dated.
