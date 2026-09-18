# Conventions

## Where a plan lives

`plans/<module>/test_plan.json` next to the package's tests, with `exemplars/<shape>.<ext>` beside it.
One plan per module, because `TestPlan.module` is one source file and the exemplars have to be about a
function *in that file* — the verifier mutates the function each exemplar names, and it finds it in the
plan's own module.

One function per module hosts the exemplars and is left out of `functions[]`; it is named in every
shape's `exemplar_function` (ADR-0015). So a plannable module needs at least two functions that can be
survived, and `fixtures/ts-fixture/src/machine.ts` is the counter-example that has no plan (ADR-0016).

**Which functions those are is measured before anything is planned**, with
`npx tsx scripts/probe-mutants.ts --module M --tests DIR`. Plan only what it marks `yes`. The three other
answers are all real and all mean "a candidate for this can never survive": `no_mutants` (nothing to
kill), `crash_only` (every mutant crashes rather than failing an assertion, so it counts towards the
score and never towards survival — three Swift functions, no TypeScript ones), and `unknown` (mutants
survived the probe; somebody has to look at whether they are equivalent). Planning one of them spends a
generation and a verdict to produce an escalation that is not the worker's fault, and puts a ceiling
into the survival rate that has nothing to do with the model (ADR-0018).

`line_range` starts at the function's doc comment when it has one. Comments carry no mutants, so the
mutation scope is unchanged, and `WorkerTask.function.source` is sliced from the same range — which
hands the worker the sentence stating the contract instead of making it infer one from the body.
`scripts/plan-ranges.mjs` computes the range and the `source_sha` together; typing either by hand is how
a run ends up mutating the wrong lines.

## TypeScript
- Tests live in `<pkg>/test/` (or `tests/`, `__tests__/`, `src/__tests__/` if the project already uses
  one). Detect, don't impose — `testDirFor` picks the first that exists, and `WorkerTask.imports_hint`
  is computed from it, with a `.js` extension if and only if the project's tsconfig is NodeNext.
- File per function × shape while in `.sidecrew/runs/`; merged into `<module>.test.ts` on `/sidecrew review` accept.
- Vitest by default; Jest if `jest.config.*` exists. Imports relative to the test file.
- Mutation: StrykerJS scoped to the function's **line range**, not the file —
  `--mutate <src file>:<from>-<to>` (ADR-0013). Whole-file scoring is mostly a report on functions
  nobody was asked to test: measured, it took the median score from 0.83 to 0.19 and the clock from
  7.2 s to 23.4 s. The incremental cache lives inside the per-candidate sandbox and is never shared.

## Swift
- SwiftPM: `Tests/<Target>Tests/<Module>Tests.swift`. Prefer the framework the target already uses (XCTest vs Swift Testing); don't mix in one file.
- `@testable import <Module>`.
- Mutation: Muter `--files-to-mutate <src>`; `SWIFT_TREAT_WARNINGS_AS_ERRORS=NO`. Muter has no
  line-range flag, so the function scope is applied to its **report** — Swift gets ADR-0013's score
  and not its speed (ADR-0005).
- A package with more than one test target cannot be guessed at: the candidate's target has to be
  named. `TestPlan.test_target` carries it, optional and Swift only (ADR-0014); `sidecrew verify
  --test-target` overrides it for a one-off. With one test target the verifier takes it; with several
  and nothing naming one, it refuses by name rather than writing the candidate into whichever came
  first.
- Muter leaves a sibling `<package>_mutated/` directory and `muter_logs/` behind. The verifier
  removes both; a `muter run` by hand does not.

## Naming
`test_<function>_<shape>_<short_case>` (Swift camelCase equivalent). One behaviour per test.
