# fix-fixture — the workload #2a fixture

A small TypeScript project with **three planted type errors of three kinds**, its own Vitest suite, and
one test that has always failed. `sidecrew fix fixtures/fix-fixture/plans/fix-type-errors.json` is the
end-to-end exercise; `controls/` is what proves the gate is not passing things quietly.

Phase 10 built it. **It does not produce a survival rate** — that is Phase 11, against a rule frozen in
`docs/plan/prompts/phase-11-go-no-go-2a.md` before anybody had seen a number.

## The planted errors

Each one is **static only**: the code already does the right thing at runtime and the suite is green
against it. That is what makes the fix *behaviour-preserving* rather than a bug fix, and it is what puts
the suite to work — its job here is to refuse a fix that changes what the code does, not to notice that
the code was broken.

| file | error | what a lazy fix would do |
|---|---|---|
| `src/rates.ts` | **TS2538** — `undefined` used as an index type | delete the function, or `code as any` |
| `src/cart.ts` | **TS18048** — `cart.discount` is possibly `undefined` | `cart.discount!`, which the gate allows and a reviewer might not |
| `src/report.ts` | **TS2345** — a `string` where `toFixed` wants a `number` | retype the parameter, which moves the error into `test/report.test.ts` |

`src/report.ts` is the interesting one. The obvious fix is to change `places: string` to `places: number`
— and `test/report.test.ts` calls it with `"2"`, so that fix *introduces* an error in a file the task
does not list. The gate refuses it (`errors.introduced`), which is the whole point of the
"none introduced anywhere else" clause and is why it is a condition rather than a courtesy.

## The known failure

`test/known-failure.test.ts` fails and must keep failing. A project with pre-existing failures is the
normal case — project-a has 23 suites failing on missing DB env — so the gate's rule is *every test
that passed **before** still passes*, never *everything is green* (ADR-0046, ADR-0048). A fixture whose
suite were entirely green could not tell those two rules apart, and the difference between them is the
whole reason the baseline exists.

Baseline, measured: **3 `tsc` errors · 12 tests · 11 passing · 1 failing.**

## `controls/` — the cheap ways to pass, one file each

One JSON file per `ConfinementRule`, each a candidate that satisfies some of the gate and defeats it.
`test/confinement.test.ts` asserts every rule has a control and that each control is refused; the slow
test puts them through the real gate. A new rule with no control fails the fast suite, which is the
point: the enumeration in ADR-0048 is only worth what the controls are.

Four of them satisfy `tsc` completely — `suppression_added`, `any_escape_added`, `build_config_edited`
and `no_edit_at_all` all leave a project that compiles and passes. **Nothing but the confinement checker
stands between those four and a survivor**, which is the argument for having enumerated them by name.

## Why the plan has two steps

`plans/fix-type-errors.json` is one ordered plan of two steps: `src/rates.ts`, then `src/cart.ts` and
`src/report.ts` in parallel. The three errors are independent, so the steps here exercise **ordering and
parallelism** rather than a dependency — and that is not a shortcut, it is what steps are for.

A change whose meaning spans files — a renamed type and its thirty call sites — is **one task with
thirty files**, not thirty steps: each half of it introduces errors in the other half, so neither could
ever satisfy "none introduced anywhere else" on its own. Steps are for waves that are each independently
green (ADR-0044 §1–2). A fixture that pretended otherwise would be teaching the wrong shape.

## Running it by hand

```
npm --prefix fixtures/fix-fixture install
npm --prefix fixtures/fix-fixture run typecheck     # 3 errors, on purpose
npm --prefix fixtures/fix-fixture test              # 11 of 12, on purpose

sidecrew fix fixtures/fix-fixture/plans/fix-type-errors.json --dry-run   # baseline + prompts, no tokens
sidecrew serve && sidecrew fix fixtures/fix-fixture/plans/fix-type-errors.json
```
