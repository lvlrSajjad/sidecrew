# Phase 5 — Planner & exemplars

Read `CLAUDE.md`, `PHASES.md` Phase 5 DoD, research §B (few-shot / exemplar evidence, TestGen-LLM filters), `docs/specs/pipeline.md` (`TestPlan`, `TestShape`, `Exemplar`), `.claude/agents/test-planner.md`.

Goal: Opus reads a module and produces a `TestPlan` with one *exemplar test per shape*, written against the real API, that compiles and passes. Workers then generate by analogy.

1. Define the canonical shape taxonomy in the spec (and keep it small): `happy_path`, `boundary`, `error_or_throw`, `async`, `stateful_sequence`, `property_like` (optional). Each function in the plan is assigned 1–3 shapes.
2. Finalise `.claude/agents/test-planner.md`: it reads the module, emits `test_plan.json` + `exemplars/<shape>.<ext>`, runs the exemplars through `sidecrew_verify` itself, and fixes them until they survive. Record Claude tokens used (from Claude Code's usage output) in the plan's `meta.planner_tokens`.
3. Tune `src/prompts/worker.md` against the TS fixture: measure survival rate of the 7B worker across 3 prompt variants (bare / +exemplar / +exemplar+shape rules), 20 functions each, temperature 0. Write the numbers to `experiments/go-no-go/results/prompt-ablation-<date>.json` (measured). Keep the winner.
4. Add `sidecrew_plan_validate(plan_path)` MCP tool (schema + every exemplar survives).
5. Guard: planner output is for the *same* module version; store `source_sha` per function in the plan so `run_batch` refuses stale plans.

Don't start the go/no-go here even if it's tempting — that's Phase 6 with all three configs.
