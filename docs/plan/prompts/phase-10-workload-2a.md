# Phase 10 — Workload #2a: local models making behaviour-preserving changes

Read `docs/plan/VISION.md` first, then ADR-0031 (options, and why A is first), then ADR-0044 (the
management side: task shape, steps, corrections), then this.

This is the first phase whose output is a sentence from the vision rather than a step towards it: **the
user asks for a change to their source code and gets it.** Everything before this wrote tests.

## The workload, exactly

A **behaviour-preserving** change to code that already exists: a TypeScript error fixed, a lint rule
satisfied, a rename applied, a null guard added, an API migration, dead code removed. The owner's
motivating example is *fix every TypeScript error in a large codebase*, and it is the best-fitting job in
the whole design — so it is the one to build against.

**Not in this phase:** implementing a function, fixing a bug, anything where the repo does not already
know the right answer. That is 2b (Phase 15), its economics are worse and its Goodhart direction is
inverted, and no number from this phase will say anything about it.

## The gate, which is the whole point

```
survives ⇔ tsc clean (or strictly fewer errors, see below) ∧ every test that passed before still passes
         ∧ the diff touches only what was asked
```

Free, exact, and already written by the user. Three things it must be able to prove about itself, and
ADR-0037 is why each one is here rather than assumed:

1. **The suite actually ran.** A suite that collected zero tests is not a green suite. Record the number
   of tests that ran, compare it to the pre-change baseline, and refuse if it dropped.
2. **The baseline is real.** Capture it *before* the change, in the same sandbox, in the same way. A
   project with pre-existing failures is normal — project-a has 23 suites failing on missing DB env —
   so the rule is "every test that passed **before** still passes", never "everything is green".
3. **The diff is confined.** A worker that fixes a type error by editing `tsconfig.json`, deleting the
   failing line, adding `// @ts-ignore`, or changing an unrelated file has defeated the gate, not passed
   it. This is the Goodhart surface for this workload (ADR-0006) and it is the thing to be paranoid
   about. Enumerate the cheap ways to pass and block each one explicitly.

For "fix all the type errors", the per-task rule is **strictly fewer errors overall, zero in the target
file, and none introduced anywhere else** — a monotone gate, so a large job can converge over many tasks
without any single one having to finish it.

## What has to be built

Four things, per `VISION.md`:

- **A sandbox that keeps the project's tests.** ADR-0004 deletes them on purpose and for a good reason;
  here they *are* the gate. This is a design change and needs an ADR, not a flag — and it needs to say
  what happens to ADR-0004's reasoning rather than quietly contradicting it.
- **A verdict that is not mutation-shaped.** `Verdict.mutation` means nothing here. Changing the contract
  needs an ADR and a `docs/specs/pipeline.md` edit in the same commit (CLAUDE.md).
- **A diff as the artefact.** A worker currently returns a whole new file. Here it touches something that
  exists, and "confined to what was asked" has to be mechanically checkable — so what a worker returns is
  a contract question, not an implementation detail. Prefer the smallest thing that can be checked.
- **The `baseline → change → re-verify` loop**, with the baseline captured once per run rather than once
  per task where the project allows it. The existing suite is expensive; measure it.

## The plan, and the task it is made of — the management side starts here

Phase 10's DoD says `sidecrew fix` *takes a plan*. Who writes it and what a task in it looks like are
**ADR-0044** (accepted 16 Sep 2026), and its first two sections are contract decisions that have to be
settled in this phase because the code-change `WorkerTask` cannot be written without them:

1. **What is one task** — one file, or a group of related files Opus chose (the owner's 5–10)? The
   recommendation is a group as the dispatch unit, with the per-file error count recorded in the verdict
   so per-file reporting is available without a verifier run per file. Group size is a plan field with a
   default, not a constant, because Phase 11 measures it.
2. **Steps.** A refactor has waves, and step N+1's baseline is the project after step N's survivors were
   applied. The plan carries an ordered `steps`; tasks inside a step are independent and run in parallel;
   the run enforces the order. Phase 10 builds the contract and the runner's respect for it. The *planner*
   that writes such a plan — Opus deciding the groups and the order — is Phase 12, and hand-written plans
   are how this phase is exercised.
3. **How many workers** is not a plan field. Opus decides how the work is cut; free RAM decides how many
   tasks run at once (ADR-0011, ADR-0025). The docs stop saying "instances" and say "tasks".

Also settled here, for the same reason: the code-change `Verdict` has to say *what* failed precisely
enough that a correction can be written from it — which `tsc` errors in which file, which tests
regressed, which confinement rule the diff broke — because the correction round of ADR-0044 §4 (Phase 12)
reads the verdict and nothing else. Design the verdict for that reader now, even though the reader arrives
two phases later.

## What must not be rebuilt

The contract skeleton, determinism (temperature 0, fixed seed, pinned revision, one in-flight request),
the zero-worker-tokens guarantee enforced in `schemas.ts`, the memory gate, the queue, thermal back-off,
the retry rule, the escalation queue, review routing. And every hard-won fact about real projects:
sandboxing, monorepos, pnpm, ts-jest, module resolution — ADR-0029 through ADR-0041 were paid for once.

## Definition of done

- A `sidecrew fix` (or equivalent) that takes a plan of behaviour-preserving tasks and produces verdicts.
- A fixture with **planted** errors of at least three kinds, and a control for each of the cheap ways to
  pass — a candidate that adds `@ts-ignore`, one that deletes the offending line, one that edits the
  tsconfig. **Each must fail the gate**, and there must be a test asserting that it does.
- The gate proves the suite ran and the diff was confined, and there is a test for each.
- A slow test that does the whole loop on the fixture for real.
- `npm run lint && npm test` green, `PHASES.md` updated, ADRs written for the sandbox change and the
  contract change, a line in `docs/CHANGELOG.md`.
- **No survival rate claimed.** That is Phase 11, with a frozen decision rule, and a number produced
  during construction is a number produced by somebody who wanted it to be good.

## The question this phase exists to answer

**Can a 7B make a correct small change to unfamiliar code at all?**

Nothing measured so far touches it. Workload #1's ~0.40 is about *writing a test for a function whose
body it was handed*; this is about *reading code it was not given a tour of and editing it*. It could be
much better — the task is narrower and the oracle is exact — or much worse. Build the apparatus so that
Phase 11 can find out cheaply, and resist the urge to answer it early with a number you chose the
conditions for.
