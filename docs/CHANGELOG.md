# Changelog

## 0.0.1 — 2026-09-10
- Scaffold in simframe shape: npm package, CLI + MCP stubs, `server.json`, phased plan and per-phase prompts, contracts spec, optional Claude skill + agents, experiment protocol, research.
- Contracts: all nine pipeline shapes in `src/schemas.ts`, with `test/schemas.test.ts` parsing every json example out of `docs/specs/pipeline.md` so spec and code cannot drift (ADR-0007). Survival and zero-worker-tokens are enforced by the schema, not by convention.
- `src/exec.ts`: the one shell-out helper. Own process group per child, SIGTERM then SIGKILL on timeout, per-stream output cap, missing binaries reported rather than thrown.
- `sidecrew doctor`: node · mlx_lm · worker · memory · tsc/vitest/stryker · swift/muter, each ok / degraded / missing, `--port` and `--json`. Non-zero exit only when node or memory fails.
- Fixture shells: `fixtures/ts-fixture` (strict TS, Vitest, Stryker) and `fixtures/swift-fixture` (SwiftPM with XCTest *and* Swift Testing targets). Both build today; Phases 2 and 3 fill them.
- `npm run lint` now typechecks `test/` as well as `src/`.
