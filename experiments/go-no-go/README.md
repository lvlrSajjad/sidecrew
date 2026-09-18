# Go/no-go experiment (Phase 6)

**Question:** on this machine (M2 Pro, 32 GB), does a local 7B coder gated by the verifier reach Claude Haiku's
survival rate on narrow, exemplar-conditioned per-function test tasks — at zero worker tokens?

## Inputs (identical for every configuration)
- `fixtures/ts-fixture` and `fixtures/swift-fixture`, 21 functions each.
- **The plans, written in Phase 5 and already validated** — one per module, not one per fixture, because
  `TestPlan.module` is a single source file:

  | fixture | plans | functions | tasks | frameworks |
  |---|---|---|---|---|
  | ts-fixture | `plans/{strings,numbers,arrays,async}` | 14 | **20** | vitest |
  | swift-fixture | `plans/{Strings,Numbers,Arrays,Machine,Async}` | 10 | **18** | xctest ×3, swift-testing ×2 |

  Every exemplar has survived the verifier; `sidecrew plan <plan>` re-checks that and is the gate before
  a run. Planner tokens are in each plan's `meta` and are shared across configurations.

  **`meta.planner_tokens` on these fixtures is an upper bound, not the marginal cost of planning a
  module.** Both fixtures were planned inside the Phase 5 session that also built the tooling the planner
  runs — `plan-ranges.mjs`, `probe-mutants.ts`, three ADRs — and the measured window cannot be separated
  after the fact. Each fixture's window is split evenly across its plans, which makes the *sum* correct
  and the per-plan figure an allocation. So `claude_tokens.planning` is comparable **between
  configurations** (it is identical for all of them, by construction) and **not** between the two
  fixtures: Swift's 104,540 against TypeScript's 32,309 is mostly a difference in how much tooling got
  built that afternoon. If Phase 6 wants the real planning cost, re-plan one module from a clean session
  with `scripts/planner-tokens.mjs --mark` around it and nothing else.
- Same `WorkerTask`s, same verifier, same retry policy (one retry with error), same tautology detector.

### The denominators, and why they are not 21
Measured in Phase 5 (`experiments/mutant-probe/results/`, ADR-0016 and ADR-0018), not chosen:

- **Five functions per fixture host the exemplars** and are deliberately left out of their own plan.
  An exemplar of a function the plan also asks about hands the worker the answer (ADR-0015).
- **Two TypeScript functions have no mutants** — `machine.ts`'s `nextState` and `applyAll`, because
  Stryker's type checker drops every mutant it generates as a type error. That module has no plan at all,
  since the one remaining function cannot both host the exemplars and be planned.
- **Six Swift functions cannot be survived**: two have no mutants, three have only mutants that *crash*
  rather than failing an assertion — which count towards the score and never towards survival — and one
  is unresolved.

A candidate for any of those can never survive, so including it would put a ceiling below 100 % into
every configuration's funnel that has nothing to do with the worker. Run `scripts/probe-mutants.ts`
before adding a fixture, and plan only what it marks `yes`.

## Configurations
| id | worker | how | notes |
|----|--------|-----|-------|
| C1 | Apple Foundation Models (on-device ~3B) | local OpenAI shim (`gety-ai/apple-on-device-openai` or `afm serve`) | Apple says "avoid code generation"; 4K context. Run for the record. |
| C2 | Qwen2.5-Coder-7B-Instruct-4bit | `sidecrew serve` (mlx_lm.server) | primary candidate |
| C2b | Qwen2.5-Coder-14B-Instruct-4bit | `sidecrew serve MODEL=qwen2.5-coder-14b-4bit` | only if it fit alongside Xcode in Phase 1 |
| C3 | Claude Haiku | `haiku-worker` agent | network control **and**, since ADR-0009, the shipped worker for 16 GB machines — so this row is a product configuration, not only a baseline; count tokens |

## Measured per configuration
- Funnel: tasks → compiled → passed → killed ≥ 1 → non-tautological (= survivors). Survival rate = survivors / tasks.
- Latency per candidate: median, p90 (generation + verification separately).
- Peak RAM of the worker process; whether Xcode + simulator were open (they should be).
- Claude tokens: planning (shared), workers (must be 0 for C1/C2), review (not run here).
- Retries used, escalations.

## Decision rule (fixed before the run — do not edit during)
Let S(x) = survival rate of config x on the same inputs, L(x) = median end-to-end latency per candidate.

- **GO** if S(C2) ≥ 0.90 · S(C3) **and** L(C2) ≤ L(C3) **and** worker tokens(C2) = 0.

  `S(x)` is **per fixture**. A TypeScript survival rate and a Swift one are not the same measurement —
  nine of the fifteen survivable Swift functions have exactly one mutant, so `killed ≥ 1` demands a
  perfect score there and a median of eight makes it cheap on TypeScript (ADR-0018). Apply the rule to
  each fixture and report both; never average them into one number.
- **GO-WITH-14B** if 0.75 · S(C3) ≤ S(C2) < 0.90 · S(C3) and S(C2b) ≥ 0.90 · S(C3) (accuracy-limited: trade speed/parallelism for the bigger model).
- **NO-GO (revisit)** if S(C2) < 0.75 · S(C3) and 14B does not fix it, or if latency is > 2× Haiku's with no concurrency headroom.
- Prefer 7B × N over 14B × 1 whenever 7B clears the bar: throughput and RAM headroom matter more than a few points of survival because the verifier absorbs the difference via retries.

## Amendment, 2026-09-14 — after the first run, for the next one
The rule above is left exactly as it was when Phase 6 ran; this is appended so that run stays readable
against the rule in force at the time. ADR-0020 has the argument.

- **CONDITIONAL GO** names the cell the original rule could not: `0.75 · S(C3) ≤ S(C2) < 0.90 · S(C3)`
  **and** S(C2b) fails to reach `0.90 · S(C3)`. Ship the local tier for that language with the measured
  rate in the README; keep the api tier as the documented escape. Not a GO — the bar is 0.90 and stays
  0.90.
- **CONDITIONAL GO carries a guard**: it holds only while the median mutation score of the local tier's
  survivors is **not below** the control's. Survival rate alone cannot separate "survived" from
  "survived by not testing the thing" — Phase 6's C3 passed `truncate:boundary` by never asserting the
  boundary the planted bug lives on, while C2 failed it by asserting the correct answer. In the band and
  below the control on score is a **NO-GO**, not a conditional anything.
- Applied to the 2026-09-14 run: **TypeScript is CONDITIONAL GO** (0.85, survivors at 1.00 against the
  control's 0.917). **Swift stays NO-GO (revisit)** (0.29, not in the band).

## Expected (write down before running, compare after)
C3 highest raw survival; C2 within 10–15 points on pure-logic functions; C1 fails mostly on compile/context. Swift will be slower to verify than TS.

## Output
`experiments/go-no-go/results/go-no-go-<date>.json` (all numbers, `"measured": true`) and `experiments/go-no-go/results/REPORT.md` (one page, funnel table, decision, surprises).
