# Phases

One phase per Opus session (roughly). Each has a prompt in `prompts/`, a definition of done, and a status you update when finished. Don't start N+1 until N's DoD is met.

| # | Phase | Status | Prompt |
|---|-------|--------|--------|
| 0 | Scaffold, contracts, `doctor` | ✅ done | `prompts/phase-0-scaffold.md` |
| 1 | `serve` + worker client + bench | ✅ done | `prompts/phase-1-worker.md` |
| 2 | Verifier: TypeScript (Stryker) | ✅ done | `prompts/phase-2-verifier-ts.md` |
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

**Done** (2026-09-11). Both revisions pinned — and pinning turned out to mean something other than the
prompt assumed: mlx_lm 0.31 has no `--revision`, so `serve` passes the cached snapshot *path*, which is
one immutable commit that cannot reach the network (ADR-0010).

Measured on the baseline M2 Pro / 32 GB, macOS 26.6.2, mlx_lm 0.31.3, mains, Xcode **and** a simulator
open (`experiments/go-no-go/results/bench-2026-09-11.json`, `"measured": true`):

| model | decode | TTFT warm | peak RSS | swapped | determinism |
|---|---|---|---|---|---|
| qwen2.5-coder-7b-4bit | **40.5 tok/s** | 159 ms | 4527 MB | 0 MB | 5/5 byte-identical |
| qwen2.5-coder-14b-4bit | **21.1 tok/s** | 199 ms | 8258 MB | 0 MB | 5/5 byte-identical |

Quiet-machine comparison in `bench-2026-09-11-quiet.json`: 42.3 and 21.2 tok/s. So the whole Xcode +
simulator working set costs the 7B about 4 % and the 14B almost nothing — the constraint it imposes is
memory, not speed. Cold TTFT on a fresh worker is ~4 s of graph compilation; warm TTFT is what the table
shows, and after the readiness fix below it is no longer charged to the first request.

**Does the 14B fit with Xcode open? It depends on free RAM at that instant, and that is the answer.**
With Xcode and a simulator open this machine sits anywhere from 9.1 GB free (just after booting the
simulator) to 14.1 GB (settled). At 14.1 GB the 14B runs clean — 0 swapouts, 21.1 tok/s, and its true
footprint is 8.06 GiB. At 9.1 GB the same run **swapped out 3.2 GB**, and *reported a lower peak RSS
while doing it*, because macOS compresses under pressure. The 7B swapped 0 MB in every configuration
measured, at 4.42 GiB. So the 7B stays the default; the 14B is allowed only when the gate says there is
room at that moment (`ram_gb` 8.2 + 2 GB headroom = 10.2 GB free), and `ram_gb` is a measured
steady-state footprint rather than a research estimate (ADR-0011).

Determinism: 5/5 byte-identical on both models in every configuration, and the reason is in the source
rather than in the luck — mlx_lm excludes any seeded request from its batch (ADR-0003). A negative
result is recorded there too: unseeded *concurrent* requests also came back identical, so this run did
not reproduce the divergence research §C warned about and cannot be cited as proof the seed is required.

Fixed in review before Phase 2, each with a regression test: `serve` treated "`/v1/models` answers" as
ready, but mlx_lm serves that endpoint from the Hugging Face cache while the model is still loading —
measured 1.9 s early on a warm 14B, and the whole load when cold. Readiness now means the worker
generated a token. That also fixed the footprint numbers above, since the RSS sampler had been measuring
a model on its way up. A `serve` that failed readiness deleted its pidfile *without killing the worker*,
leaking a process holding the port and several GB with nothing left to find it by. `stop` would signal a
whole process group on a pid read off disk without checking it was still ours — a stale pidfile plus pid
reuse put somebody else's work in the blast radius. And the new swap flag fired at >0 MB, which on a
system-wide counter means it fired on 10.8 MB of background noise; it now has a floor calibrated between
that and the 3197 MB that mattered. CI (`.github/workflows/ci.yml`) runs the fast set on macOS for node
20 and 22, and fails if the two versions disagree or a shipped model is unpinned or non-permissive.

Not done, deliberately: no `api`-tier client (ADR-0009 decided the tier; nothing calls it, so the
fallback is documented and inert). No `sidecrew models --download`; getting weights into the cache is
still mlx_lm's job or the user's. Verifiers, planner and MCP tools still throw with their phase name.

## 2 — Verifier: TypeScript
**DoD:** `fixtures/ts-fixture` (~20 pure functions, Vitest, strict, one planted off-by-one); Stryker config scoped to one file, incremental; `verifyTs` → `Verdict` with stage, error (≤ 2 KB), mutation score, killed ids, per-stage ms; tautology detector separates 4 tautology / 4 legit fixtures; cost per candidate recorded.

**Done** (2026-09-12). 21 functions across five files; `verifyTs` runs tautology → `tsc --noEmit` →
`vitest run <file>` → `stryker run` and returns a parsed `Verdict`. The detector separates all eight
fixtures and names a different reason for each of the four tautologies.

Measured on the baseline M2 Pro / 32 GB with Xcode open
(`experiments/go-no-go/results/verifier-ts-cost.json`, `"measured": true`):

| | median | p90 |
|---|---|---|
| a surviving candidate | **7.2 s** | 15.5 s |
| a tautological candidate | **0.80 s** | — |
| compile / pass / mutation | 0.44 s · 0.36 s · 6.4 s | — |

The mutation stage is ~90 % of a verdict, which is why the static check runs first and short-circuits it:
a tautology costs 0.8 s instead of 8 s, and nothing that cannot survive ever reaches the expensive stage.

**Three things the prompt did not ask for, each because measuring turned one up.** *(a)* The sandbox
excludes the project's own tests (ADR-0004) — otherwise, in any repo that already has a suite, every
candidate inherits kills earned by tests that were there first and `killed ≥ 1` stops meaning anything.
*(b)* Stryker's incremental cache is per candidate and therefore always cold: with a shared cache, a
candidate whose only assertion was `expect(true).toBe(true)` was credited with the previous candidate's
6 kills — measured, with the mechanism quoted from Stryker's source. *(c)* Mutation is scoped to the
function's line range rather than the file (ADR-0013): 7.2 s against 23.4 s, and a median score of 0.83
against 0.19, because a whole-file score is mostly a report on functions nobody was asked to test — and
ADR-0006 routes review by that score.

`stage_reached` gained a meaning it did not have (ADR-0012): `done` is a completed pipeline and
`mutation` is now reserved for a mutation run that broke, which is not the candidate's fault and must
not consume the single retry. One contract example changed with it, in the same commit as the ADR.

Not done, deliberately: no `sidecrew verify` CLI subcommand and no `.sidecrew/runs/<id>/` artefacts —
Phase 4 owns both, and `verifyTs` takes an explicit target because there is no `TestPlan` to read one
from yet. `deriveLineRange` is the stand-in for `TestPlan.functions[].line_range` and says so. The Swift
verifier, the planner and the MCP tools still throw with their phase name.

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
