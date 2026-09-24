---
name: sidecrew
description: Farm narrow, verifiable work out to local MLX worker models behind a gate a machine can run, so Claude plans and reviews survivors instead of doing the work. The main workload is behaviour-preserving code changes to a project that already exists — type errors, renames, null guards, API migrations, dead code — gated by the project's own suite plus tsc (`/sidecrew fix`). It also writes unit tests for a Swift/TypeScript module, gated by compile→run→mutation (`/sidecrew run`). Use whenever the user asks how many TypeScript errors a project has (or would have under a stricter flag), to fix every type error, rename something everywhere, add null checks, migrate off an API, remove dead code, add tests, raise coverage, or mentions sidecrew, mutation testing, Muter or Stryker — even if they don't say "sidecrew". Do NOT hand-write the bulk of it yourself in this repo; that is what the workers are for.
---

# sidecrew

Orchestrator–workers. You are the orchestrator. Local models are the workers. **A gate a machine can
run, not you, decides what is good enough — and you see only what survived it.**

## Start here: the user wants something changed

The shape of the job, end to end. `/sidecrew fix` is below and has the detail.

```
user: "rename `fetchAll` to `listAll` everywhere"

  you        → change-planner agent → plans/rename/change_plan.json, grouped and ordered
             → sidecrew_fix_plan_validate until valid; READ WHAT IT REFUSED
             → sidecrew_fix { dry_run: true }   baseline captured, no tokens spent
             → sidecrew_fix                     hours, not minutes — the suite runs per candidate
  workers    → one whole-file rewrite per task, on your Mac, zero Claude tokens
  the gate   → confined ∧ tsc clean ∧ every test that passed before still passes
  you        → survivors with their diffs and their `observations`, for the user to approve
             → escalations: what the workers could not do, with both attempts' errors
```

**Two workloads, and they differ in what the gate is made of.** **#2a changes existing code** — the
one above, gate: the project's own suite plus `tsc`. **#1 writes new unit tests** — gate: compile →
run → kill a mutant. Everything from `/sidecrew plan` down to "Workload #2a" is #1; the #2a commands
are in their own section further down.

## Why it's shaped this way (read once)
- Small local models are weak generators but a compile/run/mutation-kill gate converts "generation quality" into pass/fail — after the gate, model size matters much less (research §B). So your job is to make the gate strong and give workers one perfect exemplar per test shape.
- Worker inference must cost zero Claude tokens and zero network. That is why generation goes through the `sidecrew_*` MCP tools and **never** through a subagent: a Claude Code subagent can only pick haiku/sonnet/opus on the session endpoint, so there is no way to route one at a local model (ADR-0001, research §C). If you ever find yourself about to spawn a subagent to write candidate tests, you are about to spend tokens the whole design exists to avoid — call `sidecrew_run_batch` instead.
- Everything a run learns is on disk under `.sidecrew/runs/<id>/`: one JSON per task, candidate and verdict, plus `result.json`. Files are the IPC. Read them when a number surprises you.

## Commands

### `/sidecrew plan <path-to-module>`
1. Call `sidecrew_status` with `project` set to the package being tested. If the worker is down, tell the user to run `sidecrew serve` (and `sidecrew doctor --project <pkg>` if that fails) and stop. A missing `stryker` or `muter` is worth stopping for too: without it every verdict fails for a reason that is not the test's fault. So is a missing **`stryker-runner`** — Stryker drives Vitest and Jest through separate plugin packages, and without the matching one the mutation stage dies minutes in with an error about Stryker rather than about the test (ADR-0028). The fix is `npm i -D @stryker-mutator/jest-runner` (or `vitest-runner`) *in the project being tested*.
2. Set `test_framework` in the plan to what the project actually runs — `vitest` or `jest` for TypeScript. It is not decoration: it picks the runner the verifier drives, and a plan naming one the verifier cannot drive is refused by name before a token is spent.
3. Invoke the `test-planner` agent on the module. It produces `plans/<module>/test_plan.json` and `exemplars/<shape>.<ext>`, and loops on `sidecrew_plan_validate` until the plan is `valid` — which includes every exemplar surviving the verifier for real.
4. An exemplar is about a function the plan does **not** list — listing it would hand the worker the answer — and each shape names its host in `exemplar_function` (ADR-0015). The verifier takes the line range from the plan when the plan has the function and from the module when it does not, and refuses a name neither knows.
5. A module needs **two** mutation-testable functions before it can have a plan: one hosts the exemplars, and the rest are what the workers are asked about. Some perfectly ordinary functions have no mutants at all — on TypeScript because the type checker drops every one (ADR-0016) — and planning one produces candidates that can never survive. The planner drops them and says so.
6. Report: functions, shapes, exemplar survival, planner tokens, and anything it dropped.

### `/sidecrew validate <plan_path>`
`sidecrew_plan_validate`. Run it after any edit to a plan or a module, and before a run. It is `valid`
only when the plan parses, its module and exemplars are on disk, every `line_range` really is the
function it names, and every exemplar survives. `verify_exemplars: false` is the fast structural pass
and the report says it was used. A stale `source_sha` is a **warning** here — a plan whose code moved is
still well formed — and a refusal in `sidecrew_run_batch`, which is the thing about to spend tokens.

### `/sidecrew run [plan_path] [--concurrency N]`
1. `sidecrew_run_batch` with `dry_run: true` first. It writes every task **and every rendered prompt** to `.sidecrew/runs/<id>/prompts/`, reports the concurrency it picked and why, and refuses a stale plan — a `source_sha` that no longer matches the module means the line range has moved, and mutation is scoped to that range (ADR-0013). Re-plan rather than override. `sidecrew_plan_validate` is the fuller check and the one to run after editing a plan; the dry run does the staleness half on its own, so that nobody has to remember. Read one prompt if a run has been surprising you: the task says what the worker will be told, the prompt is what it actually receives.
2. `sidecrew_run_batch` for real. Do not poll raw candidates. Wait for the `BatchResult`.
3. Summarise the funnel (compiled → passed → killed ≥1 → non-tautological), latency, RAM, escalations. Tokens spent by workers must be 0 — if not, something is misconfigured; stop and say so.
4. Do not report a survivor as a good test. Survival is a filter, not an endorsement: a test that pins today's wrong answer kills every mutant. That is what `/sidecrew review` is for.
5. If `.sidecrew/runs/<id>/throttle.json` exists, the machine sagged and the run finished at lower concurrency than it started (ADR-0025). Say so when reporting latency — those numbers describe a hot machine, not the model. A run that threw on a task rather than returning a verdict escalates that task and keeps going; the reason is in the queue.

### `/sidecrew review [run_id]`
1. `sidecrew_review` builds the queue: survivors **below** the per-language mutation-score threshold, plus a deterministic 10 % audit sample of the ones above it, sorted weakest first and batched under a token cap (ADR-0024). Defaults are 0.6 on TypeScript and 1.0 on Swift — a Swift score is computed over one or two mutants against TypeScript's six to twelve, so one number cannot mean the same thing in both (`references/verifier.md`). Do not pass one `threshold` for both languages.
2. Invoke `survivor-reviewer` once per batch, with that batch. It sees only what the queue selected — never the whole survivor list, and never a candidate that did not survive.
3. The audit sample is the part that catches the router being wrong, so do not skip it because the scores look fine. It is drawn from exactly the survivors the threshold passed over.
4. Apply accepted tests into the project's test directory with the naming convention in `references/conventions.md`. Never modify source under test.

### `/sidecrew escalate [run_id]`
1. `sidecrew_escalate` reads `.sidecrew/runs/<id>/escalations.jsonl` — appended as the run goes, so it is there even for a run that died — and returns each failed task with the exemplar, the rules and the function source the worker had, plus both attempts' errors (ADR-0023). `suggested_model` is `sonnet`; that is the default because escalations are the tail the local tier could not do, and the tokens the whole design saves are meant to be spent here.
2. Hand the batch to Sonnet (or write them yourself for a short tail). Write the test, run `sidecrew_verify` on it, and only then add it.
3. Two kinds of escalation are **not** about the test and must not be rewritten as though they were — a `stage_reached` of `mutation` means the mutation tool broke, and four mutation counts of zero mean nothing in that function could be mutated. Both are in `references/verifier.md`; fix the machine or pick a different function.
4. An item whose `reason` says the run *threw* is a third kind: the worker went away or the verifier crashed. Re-run that task before rewriting anything — there is no candidate to judge.

## Workload #2a — changing code that already exists

Everything above writes **new tests**. This writes **changes to the user's own source**, gated by the
project's own suite plus `tsc` instead of by mutation. Reach for it when the ask is *fix every
TypeScript error*, *rename X everywhere*, *add the null checks*, *migrate off this API*, *drop the dead
code* — behaviour-preserving work, where the user already wrote the oracle.

**The bar is different and higher.** A workload-#1 survivor is a new file nobody depended on. A #2a
survivor is an edit to code the user ships, so the claim being made is that they cannot tell it from a
change Opus would have made. Phase 11 says GO on both real projects **by a margin of exactly zero,
twice**, on samples of ten. Do not treat it as settled.

### `/sidecrew fix <ask>`
1. `sidecrew_status` with `project` set to the package. No `tsc` means every task fails for a reason
   that is not the worker's.
2. Invoke the **`change-planner`** agent with the ask. It produces `plans/<job>/change_plan.json` —
   grouped files, ordered steps — and loops on `sidecrew_fix_plan_validate` until it is `valid`.
3. Read what it **refused**. A refusal is the planner's most useful output: a task whose files already
   carry a `tsc` error the ask does not cover is one no worker can pass at any temperature, because the
   gate demands zero errors there (ADR-0050 option C). At 262 s of gate per attempt, one refusal saves
   about nine minutes of doing nothing.
4. `sidecrew_fix` with `dry_run: true` once. It captures the baseline and stops before the first token,
   which is how you learn the tsconfig does not cover the files or the suite collects nothing.
5. `sidecrew_fix`. **Budget hours, not minutes** — the project's own suite runs per candidate, and Phase
   11 measured the gate at 95 % of a candidate's cost. The 13.5 s of generation is not the cost.
6. Report survivors with their diffs. Never apply them without the user seeing them: the gate decides
   what you are allowed to *see*, not what ships.

### `/sidecrew fix-escalate [run_id]`
`sidecrew_fix_escalate`. Two kinds here are **not** the worker's fault and must not be rewritten as
though they were:
- `machine_failure: true` — the sandbox or the runner broke (ADR-0012, ADR-0056). Exclude it from any
  rate you quote, and re-run the task.
- `refused` is non-null — the worker said the change cannot be made inside those files. Usually it is
  right, and the thing to fix is the **plan**.

### `/sidecrew recon [project]` — "how many TypeScript issues are there?"
`sidecrew_recon` with `project` set. It runs the project's own `tsc` as configured and once per stricter
flag, in a copy, and returns what each flag would **add** — source files and test files apart, the worst
files, the commonest codes. No worker, no tokens beyond reading it; a minute or more per flag on a big
project. Put the sentence in front of the user — *"your config reports 0; `--strictNullChecks` reports
763, 163 of them in tests"* — and **let them choose the scope**. Two rules (ADR-0090):
- **It counts; it does not offer.** Do not promise a fix on the strength of the number. Fixes under a
  strictness flag mostly narrow a type, the narrowed type lands in test files no task may edit, and that
  shape measured 2/30 (ADR-0077). The report says so itself (`fix_offered: false`).
- **An already-on flag is not a zero.** `already_on: true` means the project has it; nothing was run.

### Reading a codebase without reading it — `sidecrew_query` and `sidecrew_read` (ADR-0090)
While planning, ask instead of reading. **`sidecrew_query`** answers predicate questions with the
project's own compiler — `refs`, `unreferenced` (a `DECORATED` class may be reached by reflection),
`sizes` (what fits a rewrite), `diagnostics` — no worker, seconds. **`sidecrew_read`** has the local
worker read ≤ 10 files and answer one question; only claims whose quotes a machine found where they cite
come back. **Admitted is not true**: open the cited lines before acting on a load-bearing claim, and treat
`nothing_found` as *read it yourself*. The change-planner uses both when its brief turns retrieval on.

### What the gate cannot see
`survives ⇔ confined ∧ compile_ok ∧ tests_ok`, and a comment is neither a type nor a test. Measured: the
local tier made unrequested cosmetic edits — a deleted docblock, a reworded comment, a stray blank line
— in **4 of 23 sampled survivors against 0 of 23** for the control, and every one of them passed
(ADR-0054). The verdict now carries them as non-gating `observations` (ADR-0057), so **read those before
you approve a diff**; they are the one known quality gap and the gate is not going to stop them.

Also: about **1 survivor in 5** had changed lines that no test which ran ever executed. For a rename
that is mild — `tsc` proves completeness. For a null guard or an API migration it is not, because there
the compiler cannot tell you the behaviour survived. The task's `shape` is what tells you which case you
are reading.

## Rules
- Never show raw worker output to the user unless asked; show verdicts.
- **Never write a correction from a diff.** If the correction round is on, the note comes from the
  *verdict* and from what the gate extracted — never from the candidate's output. That is the line
  between correcting a worker and reviewing everything (ADR-0044 §4 rule 1), and `src/correction.ts`
  cannot reach a candidate by construction. It also defaults to **off**: whether it pays for itself is a
  number that does not exist yet.
- Never lower the survival rule to make numbers look better.
- Concurrency is the run's to pick, not yours: it comes from free RAM at the instant the run starts and from how many workers are up, and the run may lower it further if the machine sags (ADR-0025). Pass `--concurrency` only to lower it.
- If `sidecrew serve` refuses, read which refusal it is. **Not enough free RAM, or the kernel reporting memory pressure** (ADR-0026) — tell the user to close Xcode or a simulator, or suggest `sidecrew serve --wait 300` to queue for room; never suggest `--force`, which starts a worker into swap and poisons every number taken afterwards. **An unpinned revision** (ADR-0027) — `sidecrew models --pin` is the fix; `--allow-unpinned` is only for a model being evaluated, and a run on one is not comparable with any other run.
- Record measured numbers in `experiments/go-no-go/results/` when running experiments, with `"measured": true` and the machine they came from.

## References
- `references/conventions.md` — test file naming, imports, where tests live per language.
- `references/verifier.md` — what each verifier stage checks and how to read a `Verdict`.
- `docs/specs/pipeline.md` in the sidecrew repo — the JSON contracts, and §Shapes for the six shapes,
  what each one asks, and why a function gets 1–3 of them.
