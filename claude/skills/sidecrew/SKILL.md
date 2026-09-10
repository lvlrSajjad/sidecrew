---
name: sidecrew
description: Generate unit tests for an existing Swift or TypeScript module using local MLX worker models and a compile→run→mutation verifier, so Claude only plans, writes exemplars and reviews survivors. Use this whenever the user asks to add tests, raise coverage, write unit tests for a module/package/file, or mentions sidecrew, mutation testing, Muter or Stryker — even if they don't say "sidecrew". Do NOT hand-write the bulk of tests yourself in this repo; that's what the workers are for.
---

# sidecrew

Orchestrator–workers test generation. You are the orchestrator. Local models are the workers.
The verifier, not you, decides what is good enough. You see only survivors.

## Why it's shaped this way (read once)
- Small local models are weak generators but a compile/run/mutation-kill gate converts "generation quality" into pass/fail — after the gate, model size matters much less (research §B). So your job is to make the gate strong and give workers one perfect exemplar per test shape.
- Worker inference must cost zero Claude tokens and zero network. That's why workers are reached through the `sidecrew_*` MCP tools and **never** through a subagent — Claude Code subagents can only pick haiku/sonnet/opus on the session endpoint (research §C).

## Commands

### `/sidecrew plan <path-to-module>`
1. Call `sidecrew_status`. If the worker is down, tell the user to run `sidecrew serve` (and `sidecrew doctor` if that fails) and stop.
2. Invoke the `test-planner` agent on the module. It produces `test_plan.json` and `exemplars/` next to the module's tests dir, verifies every exemplar with `sidecrew_verify`, and fixes them until they survive.
3. Report: functions, shapes, exemplar survival, planner tokens.

### `/sidecrew run [plan_path] [--concurrency N]`
1. `sidecrew_plan_validate` first; refuse stale plans (`source_sha` mismatch).
2. `sidecrew_run_batch`. Do not poll raw candidates. Wait for the `BatchResult`.
3. Summarise the funnel (compiled → passed → killed ≥1 → non-tautological), latency, RAM, escalations. Tokens spent by workers must be 0 — if not, something is misconfigured; stop and say so.

### `/sidecrew review [run_id]`
1. Invoke `survivor-reviewer` with the `BatchResult`. It only gets survivors below the review threshold plus a small audit sample.
2. Apply accepted tests into the project's test directory with the naming convention in `references/conventions.md`. Never modify source under test.

### `/sidecrew escalate [run_id]`
Hand `escalations` to yourself (or Sonnet) with the exemplar and both failure attempts. Write the test, run `sidecrew_verify` on it, and only then add it.

## Rules
- Never show raw worker output to the user unless asked; show verdicts.
- Never lower the survival rule to make numbers look better.
- If free RAM < model estimate + 2 GB, reduce concurrency rather than swap.
- Record measured numbers in `experiments/go-no-go/experiments/go-no-go/results/` when running experiments.

## References
- `references/conventions.md` — test file naming, imports, where tests live per language.
- `references/verifier.md` — what each verifier stage checks and how to read a `Verdict`.
- `docs/specs/pipeline.md` in the sidecrew repo — the JSON contracts.
