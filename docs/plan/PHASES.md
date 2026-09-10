# Phases

One phase per Opus session (roughly). Each has a prompt in `prompts/`, a definition of done, and a status you update when finished. Don't start N+1 until N's DoD is met.

| # | Phase | Status | Prompt |
|---|-------|--------|--------|
| 0 | Scaffold, contracts, `doctor` | ✅ done | `prompts/phase-0-scaffold.md` |
| 1 | `serve` + worker client + bench | ⬜ | `prompts/phase-1-worker.md` |
| 2 | Verifier: TypeScript (Stryker) | ⬜ | `prompts/phase-2-verifier-ts.md` |
| 3 | Verifier: Swift (Muter) | ⬜ | `prompts/phase-3-verifier-swift.md` |
| 4 | MCP tools + `run` + skill wiring | ⬜ | `prompts/phase-4-mcp-skill.md` |
| 5 | Planner & exemplars (Opus side) | ⬜ | `prompts/phase-5-planner.md` |
| 6 | Go/no-go experiment | ⬜ | `prompts/phase-6-go-no-go.md` |
| 7 | Hardening | ⬜ | `prompts/phase-7-hardening.md` |
| 8 | Publish: npm + MCP Registry, docs site | ⬜ | `prompts/phase-8-publish.md` |
| 9 | Python + Kotlin verifiers; second workload | ⬜ | (write when 8 is done) |

## 0 — Scaffold, contracts, doctor
**DoD:** `src/schemas.ts` covers every shape in `docs/specs/pipeline.md` and round-trips the spec examples in tests; `sidecrew doctor` reports node / mlx_lm / worker / memory / tsc+vitest+stryker / swift+muter each as ok / missing / degraded; `npm run lint && npm test` green; fixture shells exist.

**Done** (2026-09-10). All nine shapes in zod; the test extracts every json block from the spec and parses it, and fails if blocks and schemas ever diverge (ADR-0007). `src/exec.ts` is the single shell-out, with a process-group kill on timeout. `doctor` exits non-zero only on node or memory. Fixture shells build and their test targets run. Not done, deliberately: `serve`, the worker client, verifiers and MCP tools still throw with their phase name; there is no CI workflow yet (BACKLOG).

## 1 — serve + worker client + bench
**DoD:** `sidecrew serve` starts `mlx_lm.server` with the pinned revision from `src/models.json`, pidfile + log under `.sidecrew/`; `sidecrew stop`; `src/worker.ts` completes a chat at temp 0 + seed and returns identical output 5/5 (ADR-0003 if batching interferes); `sidecrew bench` writes `experiments/go-no-go/results/bench-<date>.json` (tok/s, TTFT, peak RSS, machine) for 7B and, if it fits with Xcode open, 14B; revisions pinned.

## 2 — Verifier: TypeScript
**DoD:** `fixtures/ts-fixture` (~20 pure functions, Vitest, strict, one planted off-by-one); Stryker config scoped to one file, incremental; `verifyTs` → `Verdict` with stage, error (≤ 2 KB), mutation score, killed ids, per-stage ms; tautology detector separates 4 tautology / 4 legit fixtures; cost per candidate recorded.

## 3 — Verifier: Swift
**DoD:** `fixtures/swift-fixture` (SwiftPM, XCTest + Swift Testing targets); Muter scoped via `--files-to-mutate`, `SWIFT_TREAT_WARNINGS_AS_ERRORS=NO`; `Verdict` parity with TS; Swift Testing attribution handled or ADR-0005; cost recorded.

## 4 — MCP tools + run + skill wiring
**DoD:** `sidecrew mcp` exposes `sidecrew_status/generate/verify/run_batch`; `sidecrew run plan.json` does generate → verify → retry once → escalate with memory-aware concurrency and writes `.sidecrew/runs/<id>/`; `claude mcp add … npx -y sidecrew mcp` works from a clean checkout via `npm link`; `claude/skills/sidecrew/SKILL.md` drives `/sidecrew run` on the TS fixture and returns only survivors.

## 5 — Planner & exemplars
**DoD:** shape taxonomy fixed in the spec; `test-planner` agent produces a valid `TestPlan` + exemplars that survive; `sidecrew plan --validate`; prompt ablation (bare / +exemplar / +exemplar+rules) measured on the TS fixture; `source_sha` staleness check.

## 6 — Go/no-go
Run `experiments/go-no-go/README.md` as written. Output: results JSON + one-page REPORT.md with the decision.

## 7 — Hardening
Retry template, escalation queue + `/sidecrew escalate`, survivor review batching by mutation score + audit sample, memory guard, thermal back-off, revision pinning check, `--dry-run`.

## 8 — Publish
`npm publish` dry-run, `server.json` validated against the registry schema, release workflow green on a `v0.1.0` tag, docs site (`docs/` → GitHub Pages like simframe), README numbers replaced with measured ones from Phase 6.
