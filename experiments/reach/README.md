# The reach: how much of a codebase can a worker be asked to change? (Phase 14c)

The decision rule is **not here**. It is frozen in `docs/plan/prompts/phase-14c-the-reach.md` §3–§4
(22 Sep 2026) and is not restated. This file declares **how `Reach` is counted**, which the frozen
rule names without computing. It was written on **22 Sep 2026, after the build (`79d2ce5`) and before any
after-number existed**. Do not edit §1–§2. Amend below them, dated.

## 1. Before — recorded first, on the untouched code

`scripts/reach-census.ts` at `cc1a71a`, before `src/` changed. Every `.ts`/`.tsx` under `<project>/src`,
`.d.ts` excluded; test artefacts are counted separately and are never addressable (ADR-0048). A file is
refused iff `rewriteCost([source]) > MAX_FIX_TOKENS`, which is the §1 clause itself, imported.

| | source files | refused | refused bytes | `Reach` |
|---|---|---|---|---|
| project-a | 2,174 | 72 | 48.1 % | **0.519** |
| project-b | 2,136 | 76 | 27.2 % | **0.728** |

Measured: `results/census-before-*.json`, with each project's commit and a sha256 of the refused list.
The lists name client files and live only in `local/` (gitignored, CLAUDE.md #7). **The refused list is
`S_big`'s population**, and its hash is how a later session proves it drew from this one.

## 2. After — the definition, declared before the number

A byte of a non-test source file is **addressable** iff either

- (a) its file passes the whole-file clause, as before; or
- (b) it lies inside a declaration that a symbol-scoped task can name, meaning `resolveSymbol` finds
  **exactly one** declaration by that name (so overloads and `get`/`set` pairs do not count), and whose
  own text passes the **same** size clause, `rewriteCost([text]) ≤ MAX_FIX_TOKENS`.

Bytes in (b) are counted over the **union** of spans, so a method inside a class that also fits is not
counted twice. Everything else in a refused file is **not** addressable: its imports, JSDoc, top-level
expression statements, an ambiguous name, and any declaration too large to return even alone.
`Reach = addressable bytes / all source bytes`, computed by `reach-census.ts --after`.

**Two things it deliberately does not count, and why:**

- **Pre-existing `tsc` errors.** `pre_existing_error_outside_symbol` makes some of these bytes
  unsatisfiable, but that depends on `compiler_flags`, and the "before" number did not subtract
  pre-existing-error refusals either. Like for like, `Reach` is about the **size** clause, which is the
  clause §1 names. What pre-existing errors cost shows up in `S_big`'s refusals instead, where it
  belongs.
- **Whether a real task would name those declarations.** This is reach, not demand. `S_big` measures
  whether the reached part can actually be changed.

The biases, stated before the number: (b) **overstates** reach where a real change spans several
declarations in one ask (ADR-0075's *"a big change is not a big file"*, which the frozen rule turns into
`14c′`). It **understates** it where a class that is too big as a whole is fully covered by its members
anyway, since the union counts only member bytes and never the header or the braces between them.

## 3. The task set — the selection rule, declared 22 Sep 2026 before it was run

`scripts/reach-plan.ts`. This is the correction-round README §2 rule that picked Phase 14b's 30 tasks,
applied once per arm, so the arms differ **only** in which side of the §1 clause their file is on.

- **Pool, both arms:** a non-test file under `src/`, in `tsc`'s program, with **1–3** errors under
  `--strictNullChecks` and **no TS2417/TS2418**.
- **`S_small`:** the file is not in the refused list. One whole-file task, worded as 14b's were.
- **`S_big`:** the file is in the refused list whose sha256 §1 recorded. Every error lies inside a
  uniquely named declaration; each error takes the **innermost** one, and the task names their union.
  The union must not overlap and must pass the size clause. One symbol task per file.
- **`n = 20` per arm**, the first 20 by path (an order unrelated to difficulty), or the whole pool if it
  is smaller. The size comes from the time budget: 40 tasks at the 7B × 2 fits inside the 02:05–06:30
  window with the retry included. Interleaved in **one step**, so both arms share one baseline and the
  same hours on the same machine.
- **Gate:** `retry_regressions: true`, `demote_test_type_errors: true`,
  `compiler_flags: ["--strictNullChecks"]`, correction off, ADR-0086 §6 option A. Every one of these is
  also recorded in each verdict.
- **Validated before the first token.** A task the validator refuses is removed *then*, and counted by
  code in the result. This is not a verdict, so it is not the §4.0.4 violation. After the first token,
  nothing is added, dropped or re-planned.

**At `n = 20` the two intervals will overlap.** A ratio between them is a direction, not a result, and
it will be reported that way (prompt §3).
