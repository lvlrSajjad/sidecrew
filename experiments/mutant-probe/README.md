# Mutant probe

Which functions of a module can be mutation-tested at all?

```bash
npx tsx scripts/probe-mutants.ts \
  --module fixtures/swift-fixture/Sources/SwiftFixture/Strings.swift \
  --tests experiments/mutant-probe/swift \
  --test-target SwiftFixtureXCTests --framework xctest \
  --out experiments/mutant-probe/results/swift-Strings.json
```

ADR-0016 gave the planner a rule it cannot follow by reading code: **do not plan a function with no
mutants.** A candidate for one can never survive, because `killed ≥ 1` is unreachable — so the task
spends a generation and a verdict to produce an escalation that is not the worker's fault, and any
survival rate computed over it is reporting on a tsconfig or on an operator set rather than on a model.

It is not predictable by eye, and the two languages fail in opposite directions. Stryker generates
dozens of mutants and its type checker discards the ones that do not type; Muter has four operators and
generates almost none. So it is measured once, before a plan is written, and the plan's denominator is a
number somebody can look up.

## `swift/`, `typescript/`

One throwaway test per function, named for it. They are **not exemplars** — an exemplar has to be worth
copying literally, a probe only has to be honest. They exist because the question has no cheap form: a
test that asserts nothing is caught by the tautology detector and short-circuits before the mutation
stage runs (ADR-0006), so finding out whether a function has mutants requires a test that compiles,
passes and actually calls it.

## Reading a result

`plannable` is `mutants > 0` and is the whole output. `probe_survived` is about the probe, not the
function: a probe can fail to kill anything and the function still be plannable, because the mutant
counts come from the mutation tool rather than from the probe's assertions. The two disagree exactly
when the throwaway test was weak, which is allowed.
