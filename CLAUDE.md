# CLAUDE.md — how to work in this repo

You are building **sidecrew**: an npm package (CLI + MCP server, TypeScript, Node ≥ 20) that farms narrow,
verifiable subtasks — first: unit tests — out to local MLX models and only shows Claude what survived
compile → run → mutation-kill. Sibling project in style and packaging: github.com/lvlrSajjad/simframe.

## Read first
- `docs/research/2026-09-10-local-worker-models.md` — the evidence behind every design choice. Don't re-litigate; if you disagree, write an ADR.
- `docs/plan/PHASES.md` — where we are. One phase per session; the prompt is in `docs/plan/prompts/`.
- `docs/specs/pipeline.md` — JSON contracts between planner, workers, verifier, reviewer. Changing a contract needs an ADR and a spec update in the same commit.

## Non-negotiables
1. Worker inference never touches the Anthropic API **on the local tier** — reached over `http://localhost:<port>/v1` (mlx_lm.server), never via a subagent. ADR-0009 adds an `api` tier for machines with no room to host a worker; it is opt-in per machine, never the default, and `BatchResult` records which tier ran. The guarantee is enforced in `src/schemas.ts`, not assumed: a `local` run that spent Claude tokens on worker inference does not serialise.
2. Survive ⇔ compiles ∧ passes on original code ∧ kills ≥ 1 mutant of the function under test ∧ non-tautological.
3. Claude reviews survivors only, batched, filtered by mutation score. Never surface raw worker output to Claude.
4. Determinism: temperature 0, fixed seed, one in-flight request per worker process. Pin HF revisions in `src/models.json`.
5. Memory: total resident under ~28 GB on the 32 GB baseline. Default 2 × 7B or 1 × 14B. Never swap.
6. Licences: Apache-2.0 / MIT only for anything downloaded or shipped by default. Codestral weights are research-only.

## Shape (copy simframe)
- One package, `bin: sidecrew`, subcommands, `sidecrew mcp` for stdio. Only runtime dependency: `@modelcontextprotocol/sdk` (+ `zod`). External capabilities (`mlx_lm`, `muter`, `stryker`, `swift`) are shelled out and reported by `doctor`, never bundled.
- `server.json` and `package.json` versions move together; `release.yml` enforces it.
- README leads with measured numbers. Every number in docs is labelled measured or estimated.
- Files are the IPC where possible: runs go to `.sidecrew/runs/<id>/`, one JSON per candidate/verdict.

## Conventions
- TypeScript strict, ESM, `vitest`. No default exports. `zod` for contracts. Shell-outs through one helper (`src/exec.ts`) with timeouts.
- Slow tests (`*.slow.test.ts`) need real toolchains and run only with `SIDECREW_SLOW=1`; CI runs the fast set.
- Every phase ends with: `npm run lint && npm test` green, `PHASES.md` status updated, an ADR if anything was decided, a line in `docs/CHANGELOG.md`.
- Don't pull features forward from later phases; note them in `docs/plan/BACKLOG.md`.
- Measured numbers → `experiments/go-no-go/results/*.json` with `"measured": true` plus machine info.

## When unsure
Smallest working thing. If a decision is bigger than a function signature, write the options into `docs/DECISIONS.md` as a proposed ADR and ask.
