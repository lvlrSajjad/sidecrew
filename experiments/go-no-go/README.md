# Go/no-go experiment (Phase 6)

**Question:** on this machine (M2 Pro, 32 GB), does a local 7B coder gated by the verifier reach Claude Haiku's
survival rate on narrow, exemplar-conditioned per-function test tasks — at zero worker tokens?

## Inputs (identical for every configuration)
- `fixtures/ts-fixture` and `fixtures/swift-fixture`, ~20 pure functions each.
- One `TestPlan` + exemplars per fixture, written once by `test-planner` (Opus). Planner tokens recorded and shared across configs.
- Same `WorkerTask`s, same verifier, same retry policy (one retry with error), same tautology detector.

## Configurations
| id | worker | how | notes |
|----|--------|-----|-------|
| C1 | Apple Foundation Models (on-device ~3B) | local OpenAI shim (`gety-ai/apple-on-device-openai` or `afm serve`) | Apple says "avoid code generation"; 4K context. Run for the record. |
| C2 | Qwen2.5-Coder-7B-Instruct-4bit | `sidecrew serve` (mlx_lm.server) | primary candidate |
| C2b | Qwen2.5-Coder-14B-Instruct-4bit | `sidecrew serve MODEL=qwen2.5-coder-14b-4bit` | only if it fit alongside Xcode in Phase 1 |
| C3 | Claude Haiku | `haiku-worker` agent | network control; count tokens |

## Measured per configuration
- Funnel: tasks → compiled → passed → killed ≥ 1 → non-tautological (= survivors). Survival rate = survivors / tasks.
- Latency per candidate: median, p90 (generation + verification separately).
- Peak RAM of the worker process; whether Xcode + simulator were open (they should be).
- Claude tokens: planning (shared), workers (must be 0 for C1/C2), review (not run here).
- Retries used, escalations.

## Decision rule (fixed before the run — do not edit during)
Let S(x) = survival rate of config x on the same inputs, L(x) = median end-to-end latency per candidate.

- **GO** if S(C2) ≥ 0.90 · S(C3) **and** L(C2) ≤ L(C3) **and** worker tokens(C2) = 0.
- **GO-WITH-14B** if 0.75 · S(C3) ≤ S(C2) < 0.90 · S(C3) and S(C2b) ≥ 0.90 · S(C3) (accuracy-limited: trade speed/parallelism for the bigger model).
- **NO-GO (revisit)** if S(C2) < 0.75 · S(C3) and 14B does not fix it, or if latency is > 2× Haiku's with no concurrency headroom.
- Prefer 7B × N over 14B × 1 whenever 7B clears the bar: throughput and RAM headroom matter more than a few points of survival because the verifier absorbs the difference via retries.

## Expected (write down before running, compare after)
C3 highest raw survival; C2 within 10–15 points on pure-logic functions; C1 fails mostly on compile/context. Swift will be slower to verify than TS.

## Output
`experiments/go-no-go/results/go-no-go-<date>.json` (all numbers, `"measured": true`) and `experiments/go-no-go/results/REPORT.md` (one page, funnel table, decision, surprises).
