# Pipeline contracts

> Test generation is workload #1. The WorkerTask → Candidate → Verdict triple is meant to stay generic; only the verifier and the shape taxonomy are test-specific.

Everything between planner → worker → verifier → reviewer is JSON conforming to these shapes.
The zod schemas in `src/schemas.ts` mirror this file, and `test/schemas.test.ts` parses every `json` block below
with them, so the two cannot drift.

```
Opus (test-planner)          local worker (MLX)          verifier            Claude (survivor-reviewer)
  reads module    ──────►  TestPlan + Exemplars
  one exemplar/shape        WorkerTask ──► Candidate ──► Verdict ──┬─ survive ──► BatchResult.survivors ──► review
                                            ▲                     └─ fail ──► retry once (error appended) ──► escalate
```

## Shapes (`TestShape.kind`)

A shape is one *kind of question* to ask about a function, and it is the unit the worker generates
against: one function × one shape → one `WorkerTask` → one candidate test file. The taxonomy is closed
and deliberately small (Phase 5). Six is already more than most modules use, and every extra kind
multiplies the planner's exemplar budget — one exemplar per shape, each of which must itself survive the
verifier — while giving the worker one more way to pick the wrong analogy.

| kind | the question | a `rules` string says |
|---|---|---|
| `happy_path` | what does it do when nothing is unusual? | one or two representative inputs; assert the exact return value, never its type or its length |
| `boundary` | what happens at the edges of its domain? | empty, one element, and the value either side of each limit; one test per boundary, exact values |
| `error_or_throw` | what does it refuse, and how? | the inputs the contract rejects; assert the error *type* and that the message names the offending value |
| `async` | does awaiting it produce the right value, in the right order? | await the result and assert it; assert ordering where order is part of the contract; no timers and no clock |
| `stateful_sequence` | does a sequence of operations end where it should? | drive a sequence of transitions and assert the state after each; include one rejected step |
| `property_like` | what is true of *every* output? | a handful of hand-chosen inputs and one invariant asserted over all of them; no random generator |

`property_like` is optional and the planner should reach for it last: an invariant asserted over
hand-chosen inputs is the shape a 7B is worst at and the shape most likely to be tautological
(`expect(typeof result).toBe("string")` is an invariant), so it earns its place only where a real
invariant exists — `gcd(a, b)` divides both, `rotate(xs, n).length === xs.length`.

**Each function gets 1–3 shapes.** One is the floor because a function nobody asks a question about
does not belong in the plan; three is the ceiling because the fourth shape on a small pure function is
where the planner starts inventing questions, and every shape costs a generate → verify round. A plan
that assigns more than three is invalid, not merely unusual — `sidecrew plan --validate` says so.

A shape's `rules` is the only prose the worker receives about *what kind of test to write*, and it is
read alongside a whole exemplar file. Two sentences, imperative, about assertions rather than about
style. It is measured, not assumed — and the measurement is smaller than the design assumes: on the TS
fixture the rules are worth **one task in twenty** over the exemplar alone, and the exemplar is worth
**nothing** over one sentence naming the framework import. What it does buy is survivor quality and
cost: median mutation score 1.00 against 0.93, at 150 completion tokens against 258. ADR-0017 and
`experiments/go-no-go/results/prompt-ablation-2026-09-14.json` have the table and the caveats.

## Enums
`Language` — `typescript` · `swift` · `python` · `kotlin`
`TestFramework` — open string. `vitest` · `jest` · `xctest` · `swift-testing` are what the verifier can
drive today; the verifier rejects the rest, because it is what knows.
`CapabilityStatus` — `ok` · `degraded` · `missing`

## TestPlan
```json
{
  "version": 1,
  "language": "typescript",
  "module": "fixtures/ts-fixture/src/strings.ts",
  "test_framework": "vitest",
  "meta": { "planner_model": "claude-opus", "planner_tokens": 4120, "created": "2026-09-10T10:00:00Z" },
  "shapes": [
    { "kind": "happy_path", "exemplar": "exemplars/happy_path.test.ts", "exemplar_function": "slugify",
      "rules": "One representative input, assert the exact return value." },
    { "kind": "boundary", "exemplar": "exemplars/boundary.test.ts", "exemplar_function": "slugify",
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

`test_target` is optional and Swift only (ADR-0014): the directory name under `Tests/` that a candidate
is written into. A package with one test target needs no answer — the verifier takes the only one. A
package with several cannot be guessed at, so `verifySwift` refuses rather than picking, and the planner
— the only component that has read the package — names it. `sidecrew verify --test-target` overrides it
for a one-off. On a TypeScript plan the field is meaningless rather than illegal, and is ignored.

`source_sha` is the sha-256, hex, of the function's source text as `line_range` slices it from `module`.
A run recomputes it before it spends a token: a stale range mutates the wrong lines, which is exactly
what ADR-0013 made expensive to get wrong.

## Exemplar
A real test file for one shape, written by the planner against the actual module, that has itself survived the verifier.
Stored next to the plan. Referenced by path from `TestPlan.shapes[].exemplar`.

`exemplar_function` names the function that file tests, and it is required (ADR-0015). An exemplar is
normally about a function `functions[]` deliberately does **not** list — listing it would hand the
worker the answer — so nothing else in the plan can say which lines to mutate when the exemplar is
itself verified. `rangeFor` then finds the range in the module rather than in the plan, which is what
that fallback was built for.

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

## WorkerKind
`local` — an `mlx_lm.server` on `http://localhost:<port>/v1`. `api` — the Anthropic API, used only on
machines with no room to host a worker (ADR-0009). `seed` is `null` on `api`, which offers none; a
`local` candidate without one does not parse. Both tiers run at `temperature` 0.

**Which tier a run is on comes from *installed* RAM and never from free RAM** (ADR-0045 §4): free RAM
moves when somebody opens Xcode, and a 32 GB machine that happens to be busy must not quietly start
billing. The boundary is `models.json`'s `tiers` table — `min_ram_gb: 24` and above is `local`,
everything below is `api`.

On the `api` tier, `worker.model` is the **pinned model id** from `models.json`'s `api` block
(ADR-0060) and `worker.revision` is the empty string: a hosted model has no commit, and writing one
would claim a pin the provider does not offer. `models.json`'s `api` block also carries the context
window and the per-MTok rates with the date they were true; the rates exist to compute the tier's cost
line and are not a price quote.

## Candidate  (raw worker output, never shown to Claude)
```json
{
  "task_id": "slugify:boundary:0",
  "worker": { "kind": "local", "model": "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit", "revision": "abc123", "temperature": 0.0, "seed": 42 },
  "test_source": "import { describe, it, expect } from 'vitest'; …",
  "usage": { "prompt_tokens": 1830, "completion_tokens": 240 },
  "timing": { "ttft_ms": 410, "wall_ms": 6200 }
}
```

## Verdict
```json
{
  "task_id": "slugify:boundary:0",
  "stage_reached": "done",                 // compile | pass | mutation | done
  "survived": true,
  "compile_ok": true,
  "pass_ok": true,
  "tautological": false,
  "mutation": { "score": 0.67, "killed": 4, "survived": 2, "timeout": 0, "no_coverage": 0, "killed_ids": ["3","5","7","8"] },
  "error": null,                           // truncated to 2048 chars when a stage fails
  "timing_ms": { "compile": 1400, "pass": 900, "mutation": 21000 }
}
```
Survive ⇔ `compile_ok ∧ pass_ok ∧ mutation.killed ≥ 1 ∧ ¬tautological`. `src/schemas.ts` enforces this as an
iff: a `Verdict` whose `survived` disagrees with its own fields does not parse.

`mutation` is `null` when the mutation stage never ran (compile or pass failed first, or the candidate
was already known to be tautological), and each key of `timing_ms` is present only for a stage that
actually ran.

`stage_reached` is how far the pipeline got, and the four values are not four failures (ADR-0012):

| value | meaning |
|---|---|
| `compile` | stopped in compile |
| `pass` | stopped in pass, or skipped mutation because the verdict was already settled |
| `mutation` | the mutation stage ran and did not produce a report — the mutation tool crashed or timed out |
| `done` | every stage ran; `mutation` holds the result |

`mutation` is the one that is not about the candidate: the test may be fine and the mutation run broken.
A retry loop that cannot tell it apart from `pass` retries a machine problem at the worker's expense.

### `killed == 0` is two different situations

A retry loop has to tell them apart, and it can, from the counts alone — no extra field:

| condition | meaning | retry? |
|---|---|---|
| `killed + survived + timeout + no_coverage > 0` | mutants existed and the test caught none | **yes** — this is the test's fault |
| all four are `0` | nothing in that function could be mutated | **no** — no test of it could ever have killed anything |

The second is common on Swift, where Muter's whole operator set is four rules, and it is reachable on
TypeScript too. Spending the single retry on it rewrites a test that was never the problem. `error`
says which case it is in words; the counts say it in a way code can branch on (ADR-0005).

### The score

`mutation.score` is the mutation-testing standard — `(killed + timeout) / (killed + timeout + survived +
no_coverage)`, and 0 when that denominator is 0 — so the numbers compare with everybody else's.
Survival is stricter and asks for `killed ≥ 1` with `killed` counting only mutants a test *reported a
failure* against: Stryker's `Killed`, Muter's `failed`. A mutant that hung the suite or crashed the
process is a mutant nothing asserted about, so it lands in `timeout` — counted towards the score, never
towards survival. Mutants the tool could not build (Stryker `CompileError` / `Ignored`, Muter
`buildError`) are in neither.

**A score does not mean the same thing in both languages.** A function-scoped Swift verdict is computed
over one or two mutants against TypeScript's six to twelve, because Muter has four operators to
Stryker's several dozen. Any threshold that routes survivors to review has to be per language
(ADR-0005, ADR-0006).

## BatchResult
```json
{
  "run_id": "2026-09-10T10-31-02Z-ts-fixture",
  "plan": "…/test_plan.json",
  "config": { "worker_kind": "local", "worker_model": "…", "concurrency": 2, "retry": 1 },
  "stats": { "tasks": 40, "survived": 31, "retried": 9, "escalated": 6,
             "funnel": { "compiled": 37, "passed": 34, "killed_ge_1": 32, "non_tautological": 31 },
             "latency_ms": { "median": 6100, "p90": 11800 }, "peak_rss_mb": 5100,
             "claude_tokens": { "planning": 4120, "workers": 0, "review": null } },
  "survivors": [ { "task_id": "…", "test_path": ".sidecrew/runs/…/slugify.boundary.test.ts", "mutation_score": 0.67 } ],
  "escalations": [ { "task_id": "…", "attempts": [ { "error": "…" }, { "error": "…" } ] } ]
}
```
`claude_tokens.workers` must be `0` whenever `config.worker_kind` is `local`, and the schema enforces
it: a local run that billed Claude for worker inference is a bug, not a number to report.

**On `api` it is what Anthropic billed**, summed from every candidate's own `usage` — which comes
straight from the Messages API's usage fields, never estimated (ADR-0045 §6). The schema checks this
from the other side too, added in Phase 13: an `api` run that produced outcomes (`survived + escalated
> 0`) and reports `workers: 0` does **not** parse, because that is either lost or estimated usage and
Phase 13 §5.0.2 voids such a run. A dry run, which produces nothing, is unaffected.

## StatusReport
```json
{
  "worker": { "up": true, "base_url": "http://localhost:8000/v1", "model": "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit", "revision": "abc123" },
  "memory": { "total_gb": 32.0, "free_gb": 17.2 },
  "capabilities": { "mlx_lm": "ok", "tsc": "ok", "vitest": "ok", "stryker": "missing", "swift": "ok", "muter": "missing" }
}
```
`worker.model` / `worker.revision` are `null` while the worker is down. `capabilities` keys are open — every
row `doctor` knows about appears here with a `CapabilityStatus`.

## ValidationReport
```json
{
  "plan": ".sidecrew/plans/strings/test_plan.json",
  "valid": false,
  "checked": { "functions": 20, "shapes": 6, "exemplars": 6 },
  "errors": [ { "code": "missing_exemplar", "message": "shapes[1].exemplar does not exist on disk", "where": "shapes[1].exemplar" } ],
  "warnings": [ { "code": "stale_source_sha", "message": "slugify changed since the plan was written", "where": "functions[0]" } ],
  "stale": ["slugify"]
}
```
`valid` is `errors.length === 0`; warnings never make a plan invalid. `stale` lists function names whose
`source_sha` no longer matches the module on disk.

`checked` counts what was actually checked, so a report that skipped the expensive half says so: with
`verify_exemplars` false, `checked.exemplars` is `0` and a warning names the check that did not run.

**The codes are the contract's**, because a caller branches on them and an error message is prose:

| code | severity | meaning |
|---|---|---|
| `unreadable_plan` | error | not on disk, or not JSON |
| `schema` | error | does not parse as a `TestPlan`; `where` is the failing field's path |
| `missing_module` | error | `module` is not on disk, relative to the cwd or to the plan |
| `missing_exemplar` | error | a `shapes[].exemplar` is not on disk |
| `duplicate_shape` | error | two entries in `shapes[]` with the same `kind` — a function asking for it would get whichever came first |
| `undefined_shape` | error | a function asks for a shape `shapes[]` does not define; `buildTask` would refuse mid-run |
| `duplicate_function` | error | two entries in `functions[]` with the same `name` |
| `bad_line_range` | error | inverted, or past the end of the module |
| `range_not_function` | error | `line_range` does not begin at a declaration of `name` |
| `unknown_test_target` | error | Swift: the package has no test target by that name (ADR-0014) |
| `ambiguous_test_target` | error | Swift: the package has several test targets and the plan names none — `verifySwift` would refuse after the first candidate (ADR-0014) |
| `exemplar_did_not_survive` | error | the exemplar was verified and did not survive; `message` carries the verdict's own words |
| `unused_shape` | warning | defined in `shapes[]`, asked for by no function — an exemplar nobody reads |
| `stale_source_sha` | warning | the function has changed since the plan was written; also in `stale` |
| `exemplars_not_verified` | warning | `verify_exemplars` was false, so the expensive check did not run |

Staleness is a **warning** and not an error on purpose: a plan whose code has moved is still a
well-formed plan, and it is `sidecrew_run_batch` — the thing about to spend tokens on it — that refuses.
Validation reports; the run decides.

## EscalationBatch

A task that has used both attempts leaves a line in `.sidecrew/runs/<id>/escalations.jsonl` — appended
when it gives up, not assembled at the end, so a run that dies still has the record of what its attempts
bought (ADR-0023). `sidecrew escalate` joins that queue back to the tasks on disk and hands Claude the
batch below: the same function source, exemplar and rules the local worker had, plus what went wrong.

```json
{
  "run_id": "2026-09-14T10-31-02Z-strings",
  "plan": "…/test_plan.json",
  "language": "typescript",
  "test_framework": "vitest",
  "suggested_model": "sonnet",
  "items": [
    {
      "task_id": "truncate:boundary:0",
      "reason": "compiled but did not pass",
      "attempts": [
        { "task_id": "truncate:boundary:0", "stage_reached": "pass", "error": "vitest run …: expected 'Hel…' to be 'Hell…'" },
        { "task_id": "truncate:boundary:1", "stage_reached": "pass", "error": "vitest run …: expected 'Hel…' to be 'Hell…'" }
      ],
      "escalated_at": "2026-09-14T10:35:11.000Z",
      "task": {
        "task_id": "truncate:boundary:0",
        "language": "typescript",
        "test_framework": "vitest",
        "function": { "name": "truncate", "signature": "truncate(text: string, maxLength: number): string",
                      "source": "export function truncate(…) { … }", "source_sha": "9f2c…" },
        "imports_hint": "import { truncate } from \"../src/strings\";",
        "shape": { "kind": "boundary", "rules": "Empty input, one element, and either side of each limit." },
        "exemplar_source": "import { describe, it, expect } from \"vitest\";\n…",
        "retry_of": null,
        "previous_error": null
      }
    }
  ]
}
```

`attempts` is newest last: one entry when the retry rule refused the second attempt (ADR-0012, ADR-0005),
two otherwise. `stage_reached` is `null` when the task **threw** rather than returning a verdict — the
worker went away, or the verifier crashed — because nothing ran and naming a stage would read as a
verdict the run never reached. `task` is the **first** attempt's `WorkerTask` — Claude is being asked the question the
worker could not answer, so it gets the question rather than a summary of it. `suggested_model` is
`sonnet` unless the caller says otherwise: escalations are the tail, and the tail is where the tokens
the whole design saves are meant to be spent.

## ReviewQueue

Survivors are a filter, not an endorsement, so Claude reads the ones the score says are weakest plus a
sample of the rest (ADR-0006, ADR-0024). Ascending by score inside a batch, and batched under a token
cap.

```json
{
  "run_id": "2026-09-14T10-31-02Z-strings",
  "plan": "…/test_plan.json",
  "language": "typescript",
  "threshold": 0.6,
  "audit_fraction": 0.1,
  "max_batch_tokens": 12000,
  "counts": { "survivors": 17, "below_threshold": 3, "audit": 2, "not_reviewed": 12 },
  "batches": [
    { "estimated_tokens": 420,
      "items": [
        { "task_id": "mean:boundary:0", "mutation_score": 0.33, "reason": "below_threshold",
          "test_path": ".sidecrew/runs/…/tests/mean.boundary.0.test.ts", "test_source": "…", "estimated_tokens": 210 },
        { "task_id": "zip:happy_path:0", "mutation_score": 1, "reason": "audit",
          "test_path": ".sidecrew/runs/…/tests/zip.happy_path.0.test.ts", "test_source": "…", "estimated_tokens": 210 }
      ] }
  ]
}
```

`threshold` is **per language and never shared**: a function-scoped Swift verdict is computed over one or
two mutants against TypeScript's six to twelve, so 0.6 routes nothing on Swift while routing a real tail
on TypeScript (ADR-0018, ADR-0024). `audit_fraction` is drawn from the survivors the threshold did *not*
select, deterministically from the `run_id` and the `task_id`, so re-running `sidecrew review` on a
finished run asks about the same tests rather than a fresh sample every time. `estimated_tokens` is
`estimateTokens` — characters ÷ 4, labelled an estimate in `src/prompt.ts` — and it is what the cap is
applied to; an item larger than the cap on its own gets a batch to itself rather than being dropped.

# Workload #2a — behaviour-preserving code changes

> Workload #1 is above. Everything from here down is the second workload: the user asks for a change to
> code that already exists and a machine decides whether it survived. The gate is **the project's own
> test suite plus `tsc`** (ADR-0031 option A) — free, exact, and already written by the user.
> ADR-0046 is the sandbox that keeps the tests, ADR-0047 the contract, ADR-0048 the gate.

```
Opus (by hand in Phase 10, the planner agent in Phase 12)      local worker (MLX)        gate
  reads the project ─────►  ChangePlan: ordered steps of tasks, each a group of files
                            ChangeBaseline (once per step) ─┐
                            ChangeTask ──► ChangeCandidate ─┴─► ChangeVerdict ──┬─ survive ──► FixResult.survivors
                                              ▲                                └─ fail ──► retry once ──► escalate
```

**Survive ⇔ `confined ∧ compile_ok ∧ tests_ok`.** `src/schemas.ts` enforces it as an iff, and more
strictly than workload #1's: `tests_ok` cannot be true without a report, without at least as many tests
running as in the baseline, and without an empty `regressed`. A suite that collected zero tests was
never going to be allowed to read as a green suite (ADR-0037, ADR-0048).

## ChangePlan
```json
{
  "version": 1,
  "language": "typescript",
  "project": "fixtures/fix-fixture",
  "test_framework": "vitest",
  "meta": { "planner_model": "claude-opus", "planner_tokens": 3100, "created": "2026-09-16T10:00:00Z" },
  "max_group_size": 10,
  "correction": { "enabled": false, "max_corrections": 0, "max_tokens": 0, "on_observations": false },
  "compiler_flags": [],
  "retry_regressions": true,
  "demote_test_type_errors": true,
  "symbol_gate": "declaration",
  "steps": [
    {
      "name": "widen the accepted input types",
      "tasks": [
        { "task_id": "totals:0", "ask": "Fix every TypeScript error in these files without changing what the code does.",
          "files": ["src/totals.ts"], "max_deleted_lines": 0, "blocking": false, "shape": "null_guard",
          "notes": "roundTo is called with a string in one place." }
      ]
    },
    {
      "name": "fix the call sites",
      "tasks": [
        { "task_id": "report:0", "ask": "Fix every TypeScript error in these files without changing what the code does.",
          "files": ["src/report.ts", "src/format.ts"], "max_deleted_lines": 0, "blocking": false, "shape": "rename" }
      ]
    },
    {
      "name": "guard one declaration inside a file",
      "tasks": [
        { "task_id": "rates:0", "ask": "Fix every TypeScript error in these declarations without changing what the code does.",
          "files": ["src/rates.ts"], "max_deleted_lines": 0, "blocking": false, "shape": "null_guard",
          "symbols": [{ "file": "src/rates.ts", "name": "rateFor" }] }
      ]
    }
  ]
}
```

### `symbols` — a task may name declarations instead of files (ADR-0086)

A worker returns whole files, so a whole-file task is bounded by what the worker can reproduce inside
its completion ceiling. On a real Nest service that refused **3.3 % of the files and 48.1 % of the
bytes**. The refused files are the big ones, which is where the work is (ADR-0075, measured). A task
carrying `symbols` is **symbol-scoped** instead:

- `name` is `f` for a top-level declaration (function, class, interface, type alias, enum, or a
  `const`/`let` declaring one name) or `C.m` for a member of a top-level class (method, property,
  accessor, `C.constructor`). A name matching zero or several declarations (an overload, a
  `get`/`set` pair) is **refused, never guessed**: `symbol_missing`, `symbol_ambiguous`.
- Every listed file carries at least one symbol (`file_without_symbol`), no two overlap
  (`symbols_overlap`), and the size clause applies to the declarations' text instead of the files':
  `symbols_too_large_to_rewrite`. **`files_too_large_to_rewrite` does not apply to a symbol task.**
  That is the whole reach gain. A 60-line method inside a 4,000-line service is a 60-line task.
- **`symbol_gate` decides what `compile_ok` asks of a symbol task** (ADR-0086 §6). The default,
  `"declaration"` (option B, the owner's decision, 23 Sep 2026): **zero errors inside the named
  declarations after the change, and no more errors outside them in the same file than before.** The
  verdict says so in `target_scope: "declaration"` and records the outside counts in
  `errors.outside_target`, and the schema refuses a `compile_ok` either one contradicts. It compares
  *outside before* with *outside after*, never the file's totals: fixing two errors inside and breaking
  one outside lowers the total, and it is still a change that made the file worse. `"file"` (option A,
  14c's rule) wants zero errors anywhere in the task's files, and there the validator refuses an error
  outside the declarations up front, as `pre_existing_error_outside_symbol`. A whole-file task is
  always judged by its files.

### `demote_test_type_errors` — ADR-0077 option B, on by default

A type error the change introduced into a **test file** is recorded as an observation
(`test_type_error_demoted`) instead of failing `compile_ok`. Errors in non-test source still fail, and
the tests themselves must still **pass** — only their *type* errors are demoted, never a failure.

**It applies only under added strictness flags**, and the verdict records which — `compiler_flags` on
`ChangeVerdict` is what makes the rule checkable rather than a convention. With no flags, the baseline
and the verdict are both under the project's **own** tsconfig, so an introduced error is a real break
of a build that was working, and `compile_ok` is the clause that promised otherwise.
`fixtures/fix-fixture` has that case: retyping `places: string` to `number` pushes an error into
`test/report.test.ts` under the project's own config, and it is **still refused**.

**Why there is no legal edit that avoided them.** Adding the null guard `--strictNullChecks` demands
narrows a type; the narrowed type propagates into a fixture or a mock; and a candidate may not edit a
test file, because tests **are** the gate (ADR-0046, ADR-0048). Measured on probe 1: the errors that
sank its tasks were in a test file in **21 of 21** cases and in non-test source in **0**. Re-gating
those 15 with the demotion, **14 survived the project's own suite** — 95 % `[0.681, 0.998]` against
`S₁₄`'s `[0.008, 0.221]`, intervals that do not overlap.

**What stops it being a hole.** The candidate cannot edit a test file, cannot add `any` or a
suppression — each of those is a `ConfinementRule` with a control fixture that is asserted to be
refused — and the suite must still be green. `compile_ok`'s rule is enforced by `ChangeVerdict`'s own
refinement, so a verdict claiming it with a *non-test* file broken still does not serialise.

Set it `false` to reproduce `S₁₄ = 2/30` and every #2a rate taken before 22 Sep 2026.

### `retry_regressions` — on by default, and the only reason to turn it off

ADR-0084. A verdict failing **only** on regressions is re-read once and the second reading decides;
`tests.first_reading` keeps the one that was discarded. It is `true` unless a run is reproducing a
number measured before it existed — every survival rate published up to 22 Sep 2026 was taken one
evaluation per candidate, and those are biased low by the ~6 % this removes.

It is **not** a strictness dial. Turning it off does not make the gate stricter in any useful sense; it
makes it noisier, in the direction that fails changes which did nothing wrong.

### `compiler_flags` — strictness an experiment adds, and every number says so

ADR-0063. Default `[]`, which is the ordinary case and the only one any published rate has been taken
under. A team turning on `strict` and clearing the fallout is among the most common large
behaviour-preserving jobs in TypeScript and is exactly what #2a is shaped for — but a project that
already compiles clean has an **empty task list by construction**, so measuring that job at all means
asking the compiler for more than the project does.

**It is a flag list, never an edited `tsconfig.json`** (condition 1): the moment a project has to be
changed to be verified, that is a finding about sidecrew rather than a setup step.

**Every entry is a bare boolean strictness switch, enforced by an allowlist in `schemas.ts`.** Free
text would satisfy condition 1 and break something else — `--noEmit false` makes the compile stage
write into the sandbox, `-p` silently re-points the whole program, and either turns `compile_ok` into
a statement about a program nobody asked about.

**One list, every `tsc` in the run** (condition 2): the step baseline, each candidate's verdict, the
validator's pre-existing-error pass, and the combined check at the end. `compile_ok` compares an error
count before against one after, and counts from two compiler configurations are not comparable —
meaningless rather than merely imprecise. `runFix` reads it once into a local binding so no call site
can quietly be the one that differs.

**What it changes about the gate's meaning** (condition 4), which the report must state: under the
project's own configuration the gate asks *does this preserve what the project's own compiler says*.
With flags set it asks *does this satisfy a stricter compiler*. The second is a legitimate and more
valuable experiment, and it is a different question. A survival rate taken under `--strictNullChecks`
and one taken under the project's own configuration may not share a table cell.

`steps` is **ordered**: tasks inside a step are independent and run in parallel, and step N+1's baseline
is the project after step N's survivors were applied (ADR-0044 §2). `blocking` is `false` by default —
an escalation in step N does not stop step N+1 unless the plan says it should.

**There is no `workers` field, and the schema is `strict`, so a plan carrying one does not parse.** Opus
decides how the work is cut, grouped and ordered; the machine decides how many pieces are in flight,
from free RAM at the instant the run starts (ADR-0011, ADR-0025, ADR-0044 §3). "Hire ten workers for
this step" means ten tasks queued against whatever is up.

`max_group_size` defaults to 10 — the owner's "5–10" — and validation refuses a task with more files. A
plan field with a default rather than a constant, because the right number is a measurement and Phase 11
is where it is taken.

`max_deleted_lines` defaults to 0 per task. *Deleting the offending line* is the cheapest way to pass a
type-error gate and *removing dead code* is a real 2a job; the difference is in what was asked, not in
the diff, so the ask carries its own deletion budget.

A plan that lists a test file or a build config in a task's `files` is **invalid**, not merely unwise:
those two confinement rules must not be switchable from the plan, because the planner is going to be a
model (ADR-0048).

`shape` is **required and has no default**. It is what the ask actually is — `rename`, `unused_import`,
`null_guard`, `api_migration`, `dead_code` — and it is a contract field rather than a note because **the
shape is the caveat on every number**. Phase 11's coverage hole is about 1 survivor in 5 whose changed
lines no test that ran executed, and how much that weakens a result depends entirely on the shape: for a
rename `tsc` proves completeness and is a fair oracle where no test runs, while for a null guard or an
API migration the compiler cannot tell you the behaviour survived. Every rate measured so far is for
`rename` and `unused_import` only. A default would have quietly made everything a rename.

`correction` is ADR-0044 §4's round, as a budget. **Every field defaults to off**, because ADR-0044
decided the round gets built and *measured*, not that it gets switched on — whether it pays for itself
is a number (`experiments/correction-round/README.md` §4.2), and a default of on would ship an
unmeasured mechanism. `on_observations` is separate from `enabled` and off separately: it is the
survivor case (ADR-0057), which ADR-0044 §4 never contemplated, so asking for the gate-visible round is
not asking to spend tokens correcting changes that already passed.

## ChangeBaseline
```json
{
  "project": "fixtures/fix-fixture",
  "captured_at": "2026-09-16T10:02:00Z",
  "errors": { "total": 7, "by_file": { "src/totals.ts": 4, "src/report.ts": 3 } },
  "tests": {
    "ran": 12, "passed": 11, "failed": 1,
    "passed_ids": ["test/totals.test.ts::totals sums a column", "test/report.test.ts::report renders a row"]
  },
  "timing_ms": { "compile": 2400, "tests": 5100 }
}
```

Captured **in the same sandbox, before the change, in the same way** — that is what makes it a baseline
rather than an assumption (ADR-0046). Once per *step*, not once per task: the existing suite is the
expensive stage.

The rule is *every test that passed **before** still passes*, never *everything is green*. A project
with pre-existing failures is normal — project-a has 23 suites failing on missing DB env — so
`passed_ids` is the comparison and `failed` is allowed to be non-zero.

## ChangeTask
```json
{
  "task_id": "totals:0",
  "language": "typescript",
  "test_framework": "vitest",
  "ask": "Fix every TypeScript error in these files without changing what the code does.",
  "files": [
    { "path": "src/totals.ts", "source": "export function roundTo(...) { … }", "source_sha": "9f2c…", "errors": 4 }
  ],
  "diagnostics": "src/totals.ts(14,10): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
  "max_deleted_lines": 0,
  "notes": "roundTo is called with a string in one place.",
  "attempt": 0,
  "retry_of": null,
  "previous_error": null,
  "correction": null,
  "shape": "null_guard",
  "symbols": []
}
```

`symbols` is empty on a whole-file task. On a symbol task each entry is a declaration located by the
compiler when the task was built. `start`/`end` are offsets into that file's `source` (the schema
checks that `source.slice(start, end)` is the entry's own text), along with its lines, the `tsc` errors
inside it at the baseline, and the read-only context the worker is shown: the file's imports and a
member's class header. The worker is shown **only** that, from `prompts/fixer-symbol.md`, a separate
template, so the whole-file prompt and every cache key built from it are byte-identical to before.

`files` is the group — the dispatch unit (ADR-0044 §1) — and each entry carries the file's `tsc` error
count at the step's baseline, which is what gives the verdict per-file reporting without a verifier run
per file.

`attempt` is `0 | 1 | 2`: the first attempt, the mechanical retry that carries the tool's own words
(ADR-0022), and the correction round of ADR-0044 §4. `correction` is written from the *verdict* and never
from raw worker output (non-negotiable #3, ADR-0044 §4 rule 1).

**The pairing is machine-checked, both ways.** A task carrying a `correction` on any attempt but `2` does
not parse, and an `attempt: 2` carrying no correction does not parse either. That is ADR-0044 §4 rule 3
— *the mechanical retry is tried first, because it carries the tool's own words for free* — turned from
a sentence into a refusal. Without it, the §2.2 measurement silently changes question: "what does an
Opus note buy over the free retry" becomes "what does an Opus note buy", which is a different and much
easier thing to pass.

## ChangeCandidate
```json
{
  "task_id": "totals:0",
  "worker": { "kind": "local", "model": "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit", "revision": "abc123", "temperature": 0.0, "seed": 42 },
  "edits": [ { "path": "src/totals.ts", "contents": "export function roundTo(value: number | string, places = 2) { … }" } ],
  "symbol_edits": [],
  "unparsed": null,
  "truncated": false,
  "refusal": null,
  "usage": { "prompt_tokens": 2400, "completion_tokens": 780 },
  "timing": { "ttft_ms": 380, "wall_ms": 14200 }
}
```

**A worker returns whole files, not a patch** (ADR-0047 §2). A 7B emitting correct `@@` hunk headers
against code it is reading for the first time fails in a way that says nothing about whether it
understood the change, and it adds a whole stage — *the patch did not apply* — for a verdict to
represent. Whole contents apply mechanically, the diff is then computed exactly rather than trusted,
and — the property that matters most — **confinement is decidable before a byte is written**, because
it is a pure function of the task's sources and the candidate's.

**On a symbol task the worker returns declarations** instead: `--- SYMBOL: path#name ---` and the
declaration's whole new text, kept verbatim in `symbol_edits`. sidecrew splices each one into the
task's own source by its span **before the gate**, so `edits` still holds whole files, and every stage
after `generate` (confinement, the diff, `tsc`, the suite, the documentation rule) reads exactly the
shape it always has. The model never writes a line number, which is the failure mode that made hunks a
no. A returned name the task does not list, or one returned twice, is kept and not spliced, so the
gate can refuse it by name.

What that costs is recorded rather than discovered: `truncated` (the completion hit the ceiling) and
`unparsed` (the answer could not be read as edits) are counted by name in `FixResult.stats`, so a funnel
that collapses at *"could not read the worker's answer"* is a different finding from one that collapses
at *"the change was wrong"*. Phase 11's frozen rule turns a quarter of attempts there into an
inconclusive run and a format experiment, not a no-go on the workload.

`edits` may be empty. That is `no_edit_at_all`, a confinement rule, not a crash.

`refusal` is ADR-0044's *"the other direction"*, built in Phase 12: *"I cannot do this, because X"*
instead of a bad candidate. Workers still do not chat — a refusal is an **escalation with a reason**, not
a question, and it opens no turn. A candidate carrying a refusal and no edits stops the gate at
`generate`: no sandbox, no `tsc`, no suite. That is the point. Phase 11 measured the gate at **95 %** of
a candidate's cost and **262 s**, so a worker that knows it cannot do the task otherwise spends four and
a half minutes failing at `compile` for a reason nobody can read.

It is cheap to abuse, and the check on that is a funnel row rather than a rule: `FixResult.stats.refusals`
counts them, so a worker that learns to refuse everything shows up as a refusal rate instead of as a
survival rate that quietly stopped having a denominator.

## ChangeVerdict
```json
{
  "task_id": "totals:0",
  "stage_reached": "done",
  "survived": true,
  "compile_ok": true,
  "tests_ok": true,
  "confined": true,
  "target_scope": "file",
  "files_touched": ["src/totals.ts"],
  "errors": {
    "before": { "total": 7, "by_file": { "src/totals.ts": 4, "src/report.ts": 3 } },
    "after": { "total": 3, "by_file": { "src/report.ts": 3 } },
    "introduced": {},
    "remaining_in_target": {},
    "outside_target": {},
    "message": null
  },
  "tests": { "reported": true, "ran_before": 12, "ran_after": 12, "passed_before": 12, "passed_after": 12, "regressed": [], "message": null, "first_reading": null },
  "confinement": [],
  "observations": [],
  "refused": null,
  "error": null,
  "timing_ms": { "compile": 2300, "tests": 5000 },
  "compiler_flags": [],
  "baseline_captured_at": "2026-09-19T09:14:02.000Z",
  "verified_at": "2026-09-19T09:18:29.000Z",
  "machine": {
    "before": { "pressure": "normal", "free_gb": 18.8, "swap_gb": 2.5, "compressed_gb": 4.9 },
    "after": { "pressure": "warn", "free_gb": 5.9, "swap_gb": 2.7, "compressed_gb": 15.1 }
  }
}
```

### `tests.first_reading` — the reading the verdict did not rest on (ADR-0084)

`null` on almost every verdict. It is present only when the suite failed on **regressions** and was
re-read, and it carries the reading that was discarded.

**The rule: a regression-only failure is re-read once, and the second reading decides.** Not *take the
better of two* — the asymmetry is deliberate and sound in one direction only. A candidate that
genuinely breaks a test **breaks it twice**, so the false-*pass* rate is unchanged; what goes away is a
false-*fail* rate that was measured at `3/50` of runs on an **unmodified** tree, where 11 tests each
failed in exactly one of 50 runs. That figure is indistinguishable from `D = 2/19`, the number this
project had been calling the gate's own error rate.

**Only a regression buys the retry.** A missing report is a machine problem and a different thing
(ADR-0012); a suite that collected fewer tests is structural rather than flaky. Spending the retry on
either would make this *re-run until it passes*, and the schema refuses a verdict whose `first_reading`
is not a reported regression failure.

**The block above always holds the deciding reading**, because `ChangeVerdict`'s refinement requires
`tests_ok` to be supported by the fields beside it — a verdict that claims a survival its own fields do
not support must not serialise (CLAUDE.md #2). So a rescued verdict says what it was rescued from
rather than quietly replacing it. The second reading runs in the **same** sandbox: state a test leaves
behind can only make the re-read *more* likely to fail, which is the conservative direction, and a
fresh clone of a real project is half a gigabyte spent on a candidate that is already failing.

`retryRegressions` turns it off, for reproducing a number measured before it existed.

### Three fields that record and never gate

`baseline_captured_at`, `verified_at` and `machine` are the two false-negative sources this project has
diagnosed, written down where the verdict is read. **None of them is a clause of the gate.**
`changeSurvives` does not read them and a test asserts it, for the same reason `observations` has one:
the way these decisions get lost is somebody later reading a recorded field as a soft gate, after which
survival stops being comparable with Phase 11's and nothing fails.

**The two timestamps are ADR-0069.** A baseline is captured once per *step* and candidates are then
verified against it for hours, so the two can land on different calendar days — and the measured
consequence is not one lost task. A single test asserting on what was tracked *today* passed at capture
and fails afterwards, so **every** candidate verified past the boundary inherits it as a regression.
`crossesCalendarDay` compares **local or UTC** calendar days rather than elapsed hours, because the
failure is a step function at whatever boundary the project's tests encode and "older than N hours"
needs a number nobody has. **Both frames, since ADR-0083** — a real suite was measured moving three
tests at 00:00 **UTC** while the machine's local clock read 01:55 → 02:02 and never changed day, so
local alone stayed silent. `sidecrew fix` warns once, on the first verdict where it becomes true, and
does not stop.

**`machine` is ADR-0066 option C**, and it is a *pair* of samples rather than one. The ADR's own
amendment ruled out the pressure level as a threshold — a large suite reaches `warn` unaided on the
baseline machine, so a rule keyed on it would downgrade nearly every real failure to a machine failure.
What separated the one measured false negative from two passes of byte-identical edits was **swap**:
flat at 2.5–3.0 GB when it survived, 5.3 of 6.1 GB and paging when it did not. Swap growth is a delta,
which one sample cannot express. `before` is taken before the sandbox work and `after` once the suite
has finished, because ADR-0011's argument is that the workload creates the condition *after* the check
passes. `swapGrowthGb` over a corpus of verdicts is how option A's threshold stops being a guess.

Both are nullable with a default of `null`, and the null means exactly one thing: **this verdict was
written before the field existed.** `--resume` and every analysis script read verdicts from before
Phase 12. A machine that could not be asked — a non-macOS host, a missing `sysctl` — is a *present*
`machine` whose members are null, which is a different sentence and the one a reader deserves.

`stage_reached` is how far the pipeline got, and **confinement comes before apply**:

| value | meaning |
|---|---|
| `generate` | nothing usable came back — the answer could not be read as edits at all |
| `confinement` | the diff broke a rule, so nothing was written |
| `apply` | the edits could not be written into the sandbox |
| `compile` | stopped in `tsc` |
| `tests` | stopped in the suite, or the runner produced no report |
| `done` | every stage ran |

`errors.remaining_in_target`, `errors.introduced`, `errors.message`, `tests.regressed` and
`confinement[]` exist for one named reader: the correction round of ADR-0044 §4, which writes its note
from the **verdict** and from what the gate extracted — never from the candidate's diff. That is the
line between "Opus corrects a worker" and "Opus reviews everything", and it is why the verdict was
designed for a reader who arrives two phases later.

`tests.passed_before` / `passed_after` are **counts of executions**, and they exist because `regressed`
structurally cannot see one case of a `test.each` block breaking (ADR-0067): every case shares one
`fullName`, so the id stays in the passing set, and `ran_after >= ran_before` holds too because the
failing case still ran. Measured on a real project: 54 ids appearing up to 9 times, covering 295 of
6,368 executions. The counts are also **more** robust to the generated-name problem of ADR-0053, since a
renamed test still counts. This is the one gate defect found so far that erred towards **leniency** —
it let a broken change through, where a starved gate only refuses a good one.

`tests` is `null` when the stage never ran, which is **not** the same as `reported: false` — a runner
that produced no parseable report is a machine problem and does not spend the retry, exactly as
`stage_reached === "mutation"` does not in workload #1 (ADR-0012).

### `compile_ok` is two conditions, and the third is a theorem

`compile_ok` ⇔ every file in the task has zero `tsc` errors after, **and** no file anywhere has more
errors after than before. The Phase 10 prompt also asks for *strictly fewer errors overall*; that is not
a third condition, it follows — if the task's files went from N > 0 to zero and nothing else gained any,
the total strictly dropped. Two conditions rather than three is what makes the gate **monotone**, and
monotone is what lets "fix every TypeScript error in a large codebase" converge over many tasks without
any single one having to finish it.

### `observations` are true of the candidate and nothing gates on them

ADR-0057, and the distinction from `confinement` is load-bearing: **a breach kills a candidate; an
observation changes nothing about its fate.** `changeSurvives` does not read `observations`, and
`ChangeVerdict`'s refinement asserts that, so a run carrying them is still comparable with Phase 11's.

| kind | what it records |
|---|---|
| `whitespace_churn` | blank lines added or removed beyond the change itself |

**The documentation kinds moved out of this list on 20 Sep 2026.** `comment_lines_removed` and
`comment_text_changed` are now the confinement rule **`documentation_changed`**, which *does* gate —
the owner's decision (ADR-0054): *"the gate must care about the reason behind doing a work even if
it's not documented on the disc."* A `dead_code` ask is exempt, and a "remove the stale comments" ask
is already that shape, so the legitimate case needs no budget field.

What is left here is whitespace, which is recorded and does not gate: killing a correct change over a
blank line is the false-positive risk ADR-0054's option C warned about, and it is not what the
decision was about.

**Rates taken before and after that date are not comparable.** `confined` gained a clause, so
`changeSurvives` did too. Phase 11's, 11b's and 12's numbers were all measured on the seven-rule gate
and stay valid for what they measured; a future rate is on an eight-rule gate and must say so.

It exists because the **only** measured quality gap between the local tier and the control is invisible
to `survives ⇔ confined ∧ compile_ok ∧ tests_ok`: unrequested cosmetic edits, 4 of 23 sampled survivors
against 0 of 23 (ADR-0054). A correction may only be written from the verdict (ADR-0044 §4 rule 1), so
without a field here the only routes to that behaviour are letting Opus read the diff — the line this
design does not cross — or adding a refusal, which is answering a measurement question with a gate rule.

**What it sees.** A deleted docblock, a stray blank line, and — since ADR-0068 — a comment reworded at
constant volume. That last one was added because the original line delta's blind spot lined up exactly
with the local worker's one reproducible signature: Phase 11b found rewording a doc comment to match a
renamed symbol was the **only** divergence between a local 7B and Opus across 19 real tasks, and every
verdict reported `observations: []`. A mechanism believed to cover a case it cannot see is worse than an
absent one.

**What it still does not see.** Comments are compared as a multiset of trimmed lines, so a comment
rewrapped across different boundaries with identical words does not register — and nothing here judges
whether a reword was *right*. On the measured case the rename arguably made the old comment untrue,
which is a judgement for a reviewer and deliberately not for the gate.

`refused` is the worker's own sentence when it declined the task. A verdict carrying one has
`stage_reached: "generate"` and `survived: false`, and the schema refuses any other combination.

### The seven cheap ways to pass, blocked by name

`confined` ⇔ `confinement` is empty. Each rule is a **count before against a count after**, per file,
rather than a diff — a gate whose verdict depends on which alignment a diff algorithm chose has a
heuristic inside it. The diff is still written to the run directory, because that is what a reviewer
reads; nothing gates on it.

| rule | what it blocks |
|---|---|
| `path_outside_task` | an edit to a file the task does not list |
| `build_config_edited` | tsconfig, package.json, a lockfile, an eslint/jest/vitest/babel/bundler config — **even a listed one** |
| `test_file_edited` | a test file, `__tests__`, `__mocks__` or a snapshot — the gate's own instrument |
| `suppression_added` | a new `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `eslint-disable` |
| `any_escape_added` | a new `as any`, `: any`, `<any>` |
| `deletion_without_replacement` | more code lines removed than `max_deleted_lines` allows |
| `no_edit_at_all` | a candidate that changed nothing |
| `documentation_changed` | documentation the ask did not call for, removed or reworded (ADR-0054) |
| `edit_outside_symbol` | on a symbol task, any change outside the named declarations: judged by putting them back and requiring the original file byte for byte, so a whole-file answer gets no way round it. Also a returned name the task does not list, or one returned twice (ADR-0086 §4) |
| `symbol_not_redeclared` | on a symbol task, a named declaration that no longer resolves exactly once: renamed, split or deleted. **Fails closed** when the compiler cannot be loaded |

Seven was the count when ADR-0048 was written. ADR-0054 added the eighth and ADR-0086 the last two.
The two symbol rules are still a pure function of the task and the candidate, so confinement is still
decided **before anything is written** — `test/symbols.test.ts` asserts it on a path that does not
exist.

## FixResult
```json
{
  "run_id": "2026-09-16T10-31-02Z-fix-fixture",
  "plan": "…/change_plan.json",
  "config": { "worker_kind": "local", "worker_model": "…", "concurrency": 2, "retry": 1 },
  "project": { "errors_before": 7, "errors_after": 0, "tests_ran": 12, "tests_passed": 11, "combined_regressions": 0 },
  "steps": [
    { "name": "widen the accepted input types", "tasks": 1, "survived": 1, "escalated": 0, "errors_before": 7, "errors_after": 3 },
    { "name": "fix the call sites", "tasks": 1, "survived": 1, "escalated": 0, "errors_before": 3, "errors_after": 0 }
  ],
  "stats": {
    "tasks": 2, "survived": 2, "retried": 1, "escalated": 0,
    "funnel": { "answered": 3, "edits_parsed": 3, "confined": 2, "applied": 2, "compiled": 2, "suite_green": 2 },
    "edit_parse_failed": 0,
    "edit_truncated": 0,
    "machine_failures": 0,
    "refusals": 0,
    "cache": { "enabled": false, "hits": 0, "writes": 0 },
    "corrections": { "written": 0, "survived": 0, "on_observations": 0, "tokens": 0, "budget_exhausted": null },
    "confinement_breaks": { "suppression_added": 1 },
    "latency_ms": { "median": 24000, "p90": 31000 },
    "generate_ms": { "median": 14200, "p90": 18000 },
    "gate_ms": { "median": 7400, "p90": 9100 },
    "peak_rss_mb": 5100,
    "claude_tokens": { "planning": 3100, "workers": 0, "review": null }
  },
  "survivors": [
    { "task_id": "totals:0", "files": ["src/totals.ts"], "diff_path": ".sidecrew/runs/…/diffs/totals.0.diff", "errors_fixed": 4 }
  ],
  "escalations": []
}
```

`claude_tokens.workers` must be `0` whenever `config.worker_kind` is `local`, and the schema enforces
it — the same guarantee `BatchResult` carries, in the second workload's result. And the same api-tier
half: an `api` run with `funnel.answered > 0` and `workers: 0` does not parse (ADR-0045 §6, Phase 13
§5.0.2). `answered` is the right denominator here because it counts candidates that came back from a
worker, which is exactly what a bill would be for.

`funnel` counts **attempts**, not tasks, as workload #1's does. `generate_ms` and `gate_ms` are kept
apart because for this workload the expensive stage is the project's own suite, which is identical for
every worker configuration: a latency comparison between workers here would be measuring the user's test
suite. `VISION.md` already rules out any claim of being faster per unit.

`steps[].errors_before` / `errors_after` are the monotone gate's evidence: a long job converging over
many tasks, with no single task having had to finish it.

`project.combined_regressions` is the one number that no individual verdict can produce. Each candidate
is verified alone, against its own step's baseline, in a sandbox holding only its own change — so two
survivors that are each fine and together are not would pass every per-task gate there is. The run
re-runs the suite once at the end, with everything applied, and counts what broke. **It should always be
zero**, and a run where it is not has found a hole in the gate rather than a bad change.

`machine_failures` counts tasks that produced no verdict because the **machine** failed — a sandbox that
would not delete (ADR-0056), a runner that produced no report (ADR-0012) — so a rate's denominator can
exclude what was never the worker's to answer. Phase 11 is why it is a field rather than a footnote:
project-b's twelfth task was lost to `ENOTEMPTY` during teardown and landed in `escalated`, where it is
indistinguishable from *the worker could not do this*. The report had to carry both readings, `11/12`
and `11/11`, because nothing in the contract could say which was which.

`cache` is the candidate memoisation of ADR-0065, and the field exists so that a reader can tell whether
`generate_ms` means anything. **A cached run's generate time is not a measurement** — a hit is near-zero
and drags the median towards a number no worker ever achieved — so any figure quoted from `experiments/`
must come from a run with `enabled: false`. A measurement of what the workers do cannot be served from a
record of what they did last time. The schema refuses a run that reports hits without having enabled it.

Candidates are cached; **verdicts never are**, and that is measured rather than argued: Phase 11b saw a
byte-identical candidate produce `tests_ok: false` with 155 named regressions on a swapping machine and
`survived` on a rerun of the same bytes (ADR-0066). A verdict is not a pure function of its inputs, so
caching one would make a transient environmental failure permanent.

`corrections` is what ADR-0044 §4's round cost and bought — Phase 12 §2.2 in four integers.
`survived ÷ written` is the rate the frozen rule calls `S_c`, and `on_observations` is kept **apart** and
never pooled into it, because correcting a candidate that already passed (ADR-0057) is a different
mechanism from correcting one that failed. `budget_exhausted` says why the round stopped early when it
did, so a low rate caused by a spent budget cannot be read as a low rate caused by bad corrections.

The schema refuses three incoherent combinations: more corrected attempts surviving than corrections
written, tokens spent by a run that wrote none, and corrections costing more Opus tokens than the run's
own `claude_tokens.planning` — because a correction **is** an Opus token, this is the one place a `fix`
run may legitimately spend them, and a token outside the accounting is a token §2.2 cannot see.

## ChangeEscalation

```json
{
  "task_id": "totals:0",
  "shape": "null_guard",
  "reason": "tsc is not satisfied",
  "machine_failure": false,
  "refused": null,
  "attempts": [
    { "task_id": "totals:0", "attempt": 0, "stage_reached": "compile", "confinement": [], "regressed": [], "error": "src/totals.ts(14,10): error TS2345: …" },
    { "task_id": "totals:0#1", "attempt": 1, "stage_reached": "compile", "confinement": [], "regressed": [], "error": "src/totals.ts(14,10): error TS2345: …" }
  ],
  "escalated_at": "2026-09-18T12:00:00Z"
}
```

The workload-#2a queue, one JSON object per line of `.sidecrew/runs/<id>/escalations.jsonl`, written
**when the task gives up** rather than assembled from `result.json` at the end (ADR-0023).

A separate shape from `Escalation` rather than a widened one. The two carry different evidence:
workload #1's `stage_reached` is `Stage` — compile, pass, mutation — and says nothing about confinement
or a regressed test, which are the first two things a 2a reader needs. Widening `Stage` would give every
workload-#1 escalation four permanently-null fields and make the discriminant a runtime question.

`machine_failure` is true when nothing here was the worker's fault, matching
`FixResult.stats.machine_failures`. `refused` carries the worker's own words when it declined.

`ChangeEscalationBatch` joins the queue back to the `ChangeTask`s on disk — the same rule
`EscalationBatch` follows, and for the same reason: Claude is asked the question the worker could not
answer, not a summary of it.

## MCP tool signatures
```
sidecrew_status(port: int | None = None, project: str | None = None) -> StatusReport
sidecrew_generate(task: WorkerTask) -> Candidate
sidecrew_verify(candidate: Candidate, plan_path: str,
                function_name: str | None = None, test_target: str | None = None) -> Verdict
sidecrew_run_batch(plan_path: str, concurrency: int | None = None, dry_run: bool = False,
                   test_target: str | None = None) -> BatchResult
sidecrew_plan_validate(plan_path: str, verify_exemplars: bool = True) -> ValidationReport
sidecrew_escalate(run_id: str | None = None, dir: str | None = None,
                  model: str | None = None) -> EscalationBatch
sidecrew_review(run_id: str | None = None, dir: str | None = None, threshold: float | None = None,
                audit_fraction: float | None = None, max_batch_tokens: int | None = None) -> ReviewQueue

sidecrew_fix_plan_validate(plan_path: str, compile: bool = True) -> ChangeValidationReport
sidecrew_fix(plan_path: str, concurrency: int | None = None, dry_run: bool = False,
             keep_sandbox: bool = False) -> FixResult
sidecrew_fix_escalate(run_id: str | None = None, dir: str | None = None,
                      model: str | None = None) -> ChangeEscalationBatch
```

The last three are workload #2a and are Phase 12's. `BACKLOG.md` held them back from Phase 10 on
purpose: a tool Claude can call is only useful once something writes `ChangePlan`s for it to call with,
and shipping one earlier would have shipped a tool that went stale before anyone used it. The thing that
writes them is `claude/agents/change-planner.md`.

`compile` is `True` by default and is what makes 2a validation mean something — it is the half that
produces the **refusals**, and a refused task is one the gate could never have passed. Against a gate
measured at 262 s per attempt, one refusal saves about nine minutes, which is why the expensive check is
the default rather than the option.
`project` is the package being verified: `tsc`, `vitest` and `stryker` are reported from *its*
`node_modules`, because that is the toolchain a verdict depends on (ADR-0004's sandbox symlinks it).
`function_name` defaults to the part of `task_id` before the first colon. `test_target` is Swift's, and
overrides `TestPlan.test_target` for a one-off (ADR-0014).

`verify_exemplars` is `True` by default and is what makes validation mean something: an exemplar the
worker is about to copy is only an exemplar if it survives. It costs one verdict per shape — seconds on
TypeScript, tens of seconds on Swift — so `False` exists for the fast structural pass, and the report
warns when it was used.

`task_id` is `<function>:<shape>:<attempt>`, and the attempt is `0` or `1` — the one retry.

`sidecrew_escalate` and `sidecrew_review` both read a finished run out of `.sidecrew/runs/<id>/` and
neither spends a worker token: they assemble what Claude is about to read. With no `run_id` they take
the most recent run in `dir`.
