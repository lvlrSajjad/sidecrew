# Phase 12 — the management side, and the two numbers that make it worth having

Read `docs/plan/VISION.md`, then `docs/plan/ROADMAP.md` (which reorders the priorities and is newer
than `PHASES.md`), then ADR-0044 (the management design, accepted), then
`experiments/go-no-go-2a/results/REPORT.md` — Phase 11's numbers and the six defects it cost to get
them. Then this.

> **Phase 11 produced a GO on both real projects by a margin of exactly zero, twice.** That is the
> ground this phase stands on and it is thinner than it looks: `S(C2) = 12/12` and `11/12`,
> `A(C2) = 0.900` against a bar of `0.900`, on samples of ten. Do not treat "2a works" as settled
> and build on top of it. Two of this phase's deliverables are measurements that could undercut it.

## 1. What this phase is for

ADR-0044 decided the management half — grouped-file tasks, ordered steps, no `workers` field, and a
correction round — and Phase 10 built §1–2 into the contract. What is missing is the half the
owner's worked example is mostly about:

1. **A planner.** Nothing turns *"fix the type errors in this project"* into grouped, ordered tasks.
   Phase 11's plans were hand-written, which is why its economics are half-measured.
2. **A correction round.** ADR-0044 §4: Opus reads the **verdict**, writes one short note, the worker
   tries once more, against a per-run budget. Today the only retry is mechanical.
3. **A refusal shape.** A worker that cannot do a task should escalate *with a reason*, not return a
   bad candidate that fails at `compile` for a reason nobody can read.
4. **`sidecrew_fix` as an MCP tool**, with skill wiring. Claude cannot invoke workload #2a at all
   today; it is CLI-only, which is why nobody but us has used it.

## 2. The two numbers, and they are the point

A planner that works and is unmeasured leaves this project exactly where Phase 11 left it.

### 2.1 The cost of deciding

Phase 11 measured the *doing* side completely: generate **13.5 s at zero worker tokens**, gate
**262 s**, and the gate is **95 %** of a candidate's cost and free. The *deciding* side is blank.

**Measure: Opus tokens spent planning ÷ tasks planned, against tokens the workers did not spend.**
`scripts/planner-tokens.mjs --mark` exists for this and has never been used on a clean window —
Phase 5's figures are an upper bound contaminated by tooling built in the same session, and Phase 11
could not supply one at all because planning was interleaved with everything else. Plan one module
from a clean session with the mark around it and nothing else.

Without this the claim is "the work is free". With it the claim is "coordination costs X and buys Y",
which is the argument the whole design rests on.

### 2.2 Whether the correction round pays for itself

ADR-0044 §4 rule 2 is already frozen: **corrected-attempt survival against the Opus tokens each
correction cost, against what escalation would have cost instead.** If corrected attempts do not
survive often enough to pay, B is off by default and the docs say so. Write that rule down with its
thresholds *before* the first correction is generated — Phase 11 is the argument for why.

One thing Phase 11 hands the correction round for free: the **only** measured quality gap between
the local tier and the control is unrequested cosmetic edits — a deleted docblock, a reworded
comment, a stray blank line, **4 of 23 sampled survivors against 0 of 23** (ADR-0054). That is
exactly the shape a one-sentence correction should fix, and it is a cheaper answer than an eighth
confinement rule. It is also a ready-made test of whether corrections work at all.

## 2.3 What this phase does **not** answer, and who does

Neither number above compares sidecrew against **not using sidecrew**. Everything in this repository
pits a 7B against Haiku *inside* the tool, behind the same gate; nothing has ever been measured
against a person simply asking Opus or Sonnet directly, which is what a colleague actually does
today and the only comparison that supports a claim of improvement.

That is **Phase 11b** (`prompts/phase-11b-against-the-status-quo.md`, §4 frozen 18 Sep 2026), and by
`ROADMAP.md` it outranks this phase. It is separated out because it is an experiment rather than a
build, and because its arms need more tasks and more task shapes than Phase 11 had — every real task
measured so far is a rename or an unused-import removal.

**Two things this phase owes it.** The planner (§1.1) is what makes 40 tasks per project affordable
to plan, and 11b needs that. And if 11b runs first, its Opus-alone arm gives this phase a precision
ceiling to aim the correction round at. Either order works; do not let either quietly assume the
other happened.

## 3. Constraints carried in

- **Non-negotiable #3 holds.** A correction is written from the **verdict** and from what the gate
  extracted — never from the candidate's diff. That line is what separates "Opus corrects a worker"
  from "Opus reviews everything", and `ChangeVerdict` was designed for this reader (ADR-0047 §3).
- **CLAUDE.md #7.** The client's code and name never enter the repository. Plans carry absolute
  paths; results are redacted at the boundary. Scan before any commit.
- **ADR-0055's rule, generalised**: a stage is isolated in environment, filesystem **and** cache.
  Two of the three were learned expensively in Phase 11.
- **The planner must refuse what cannot be survived.** Phase 11 nearly measured a task that was
  unsatisfiable through no fault of a worker — a pre-existing `tsc` error in a task's own file means
  the gate can never pass it (ADR-0050 option C). That is §2's first denominator exclusion, and it
  should be enforced in `validateChangePlan` rather than remembered by whoever writes the plan.
- **Group size and task shape are open questions, not settled ones.** `max_group_size` defaults to
  10 and Phase 11 measured only **one file per task**. Every survival number in this repo is for
  single-file tasks; nothing says a 7B can handle five files at once.

## 4. What Phase 11 says about the ground you are building on

Read these as constraints, not trivia:

- **Survival rate saturated and could not rank anything** — five of six cells at or above 0.917. If
  this phase needs to compare two things, a mechanical rate probably will not separate them; budget
  for a blind approval pass.
- **Every real-project task so far is a rename or an unused-import removal.** That is a narrow slice
  of workload #2a. Null guards, API migrations and dead-code removal are unmeasured, and the coverage
  hole (about 1 survivor in 5 admitted by `tsc` alone) bites much harder on those, because there the
  compiler cannot prove behaviour survived.
- **Six defects surfaced on the first two real projects and none was visible in a summary
  statistic.** Expect the same rate. Read discarded output.

## 5. Definition of done

- The planner turns an ask into a validated `ChangePlan`, and refuses tasks that cannot be survived.
- **2.1 is measured** and in `experiments/` with `"measured": true` and machine info.
- The correction round is built, budgeted, and **2.2 is measured against a rule frozen first** —
  including the case where the answer is "it does not pay", which is a complete result.
- `sidecrew_fix` is an MCP tool with skill wiring, and a 2a escalation queue exists.
- `npm run lint && npm test` green, `PHASES.md` and `ROADMAP.md` updated, a line in
  `docs/CHANGELOG.md`, an ADR for anything decided, and the articles kept current as you go.

## 6. Do not

- Do not treat Phase 11's GO as a mandate. It passed by zero margin, twice, on samples of ten.
- Do not build the correction round as a conversation. ADR-0044 ruled that out: bounded notes,
  fed by the gate, against a per-run budget.
- Do not let the planner name the client anywhere it writes.
- Do not start workload #2b. It is behind publication and nothing measured so far bears on it.
