# Pipeline contracts

> Test generation is workload #1. The WorkerTask → Candidate → Verdict triple is meant to stay generic; only the verifier and the shape taxonomy are test-specific.

Everything between planner → worker → verifier → reviewer is JSON conforming to these shapes.
Pydantic models live in `src/schemas.ts` and must match this file (Phase 0).

```
Opus (test-planner)          local worker (MLX)          verifier            Claude (survivor-reviewer)
  reads module    ──────►  TestPlan + Exemplars
  one exemplar/shape        WorkerTask ──► Candidate ──► Verdict ──┬─ survive ──► BatchResult.survivors ──► review
                                            ▲                     └─ fail ──► retry once (error appended) ──► escalate
```

## Shapes (`TestShape.kind`)
`happy_path` · `boundary` · `error_or_throw` · `async` · `stateful_sequence` · `property_like`

## TestPlan
```json
{
  "version": 1,
  "language": "typescript",
  "module": "fixtures/ts-fixture/src/strings.ts",
  "test_framework": "vitest",
  "meta": { "planner_model": "claude-opus", "planner_tokens": 4120, "created": "2026-09-10T10:00:00Z" },
  "shapes": [
    { "kind": "happy_path", "exemplar": "exemplars/happy_path.test.ts",
      "rules": "One representative input, assert the exact return value." },
    { "kind": "boundary", "exemplar": "exemplars/boundary.test.ts",
      "rules": "Empty input, single element, max size. One test per boundary." }
  ],
  "functions": [
    { "name": "slugify", "signature": "slugify(input: string): string",
      "source_sha": "9f2c…", "line_range": [12, 31],
      "shapes": ["happy_path", "boundary"],
      "notes": "Unicode normalisation happens before lowercasing." }
  ]
}
```

## Exemplar
A real test file for one shape, written by the planner against the actual module, that has itself survived the verifier.
Stored next to the plan. Referenced by path from `TestPlan.shapes[].exemplar`.

## WorkerTask  (what the MCP server builds per function × shape)
```json
{
  "task_id": "slugify:boundary:0",
  "language": "typescript",
  "test_framework": "vitest",
  "function": { "name": "slugify", "signature": "slugify(input: string): string", "source": "export function slugify(...) {...}", "source_sha": "9f2c…" },
  "imports_hint": "import { slugify } from '../src/strings';",
  "shape": { "kind": "boundary", "rules": "…" },
  "exemplar_source": "…full text of exemplars/boundary.test.ts…",
  "retry_of": null,
  "previous_error": null
}
```
`retry_of` / `previous_error` are set only on the single retry.

## Candidate  (raw worker output, never shown to Claude)
```json
{
  "task_id": "slugify:boundary:0",
  "worker": { "model": "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit", "revision": "abc123", "temperature": 0.0, "seed": 42 },
  "test_source": "import { describe, it, expect } from 'vitest'; …",
  "usage": { "prompt_tokens": 1830, "completion_tokens": 240 },
  "timing": { "ttft_ms": 410, "wall_ms": 6200 }
}
```

## Verdict
```json
{
  "task_id": "slugify:boundary:0",
  "stage_reached": "mutation",            // compile | pass | mutation | done
  "survived": true,
  "compile_ok": true,
  "pass_ok": true,
  "tautological": false,
  "mutation": { "score": 0.67, "killed": 4, "survived": 2, "timeout": 0, "no_coverage": 0, "killed_ids": ["3","5","7","8"] },
  "error": null,                           // truncated to 2048 chars when a stage fails
  "timing_ms": { "compile": 1400, "pass": 900, "mutation": 21000 }
}
```
Survive ⇔ `compile_ok ∧ pass_ok ∧ mutation.killed ≥ 1 ∧ ¬tautological`.

## BatchResult
```json
{
  "run_id": "2026-09-10T10-31-02Z-ts-fixture",
  "plan": "…/test_plan.json",
  "config": { "worker_model": "…", "concurrency": 2, "retry": 1 },
  "stats": { "tasks": 40, "survived": 31, "retried": 9, "escalated": 6,
             "funnel": { "compiled": 37, "passed": 34, "killed_ge_1": 32, "non_tautological": 31 },
             "latency_ms": { "median": 6100, "p90": 11800 }, "peak_rss_mb": 5100,
             "claude_tokens": { "planning": 4120, "workers": 0, "review": null } },
  "survivors": [ { "task_id": "…", "test_path": ".sidecrew/runs/…/slugify.boundary.test.ts", "mutation_score": 0.67 } ],
  "escalations": [ { "task_id": "…", "attempts": [ { "error": "…" }, { "error": "…" } ] } ]
}
```

## MCP tool signatures (Phase 4)
```
sidecrew_status() -> StatusReport
sidecrew_generate(task: WorkerTask) -> Candidate
sidecrew_verify(candidate: Candidate, plan_path: str) -> Verdict
sidecrew_run_batch(plan_path: str, concurrency: int | None = None, dry_run: bool = False) -> BatchResult
sidecrew_plan_validate(plan_path: str) -> ValidationReport      # Phase 5
```
