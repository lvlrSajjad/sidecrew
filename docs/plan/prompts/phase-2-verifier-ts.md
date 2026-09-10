# Phase 2 — Verifier: TypeScript

Read `CLAUDE.md`, `PHASES.md` Phase 2 DoD, `docs/specs/pipeline.md` (`Candidate`, `Verdict`) and research §B (mutation tooling, tautologies) and §E.

Goal: `verify_ts(candidate: Candidate) -> Verdict` for one generated test file against one source file, using Vitest + StrykerJS, scoped to that file only.

1. `fixtures/ts-fixture/src/`: ~20 pure functions across 3–4 files (string/number/array utils, a small state machine, one async function, one that throws). Strict TS. Intentionally include one function with a subtle off-by-one so exemplar tests can catch it later.
2. Stryker: `stryker.config.mjs` template with `vitest` runner, `typescript-checker`, `incremental: true`, and `mutate` overridden per run to the single source file. Write `src/verifier/ts.ts` that: (a) writes the candidate test file into a temp copy of the package (or a git worktree — pick one, ADR-0004); (b) `tsc --noEmit` → compile stage; (c) `vitest run <file>` → pass stage; (d) `npx stryker run --mutate <src>` → mutation stage; (e) parses `reports/mutation/mutation.json` into killed/survived/timeout/no-coverage counts and mutation score.
3. Tautology detector `src/verifier/tautology.ts` (language-agnostic AST-light, regex is fine to start): flags tests whose only assertions are constant (`expect(true)`, `toBe(x)` where both sides are the same identifier, snapshot-only, `assert.ok(1)`), or that never reference the function under test. Add 4 tautology fixtures and 4 legitimate fixtures; detector must separate them.
4. `Verdict` must include stage reached, error text (truncated to 2 KB, for the retry prompt), mutation score, killed mutant ids, wall time per stage.
5. Cost: measure wall time per candidate on the fixture and write it into `experiments/go-no-go/results/verifier-ts-cost.json` (measured).
6. Tests: unit tests for the parser and tautology detector; one integration test marked `@vitest.mark.slow` that runs the whole thing on the fixture.

Rule from CLAUDE.md #2 applies: survive = compile ∧ pass ∧ killed ≥ 1 ∧ not tautological.
