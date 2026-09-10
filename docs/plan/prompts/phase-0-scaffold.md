# Phase 0 — Scaffold, contracts, doctor

Read `CLAUDE.md`, `docs/plan/PHASES.md`, `docs/specs/pipeline.md`, and skim `docs/research/2026-09-10-local-worker-models.md` (§C, §D). Look at github.com/lvlrSajjad/simframe for the packaging and `doctor` style we copy.

The package is scaffolded; nothing works yet. This session:

1. **Contracts.** Complete `src/schemas.ts` with zod: `PlannedFunction`, `TestPlan`, `WorkerTask`, `Candidate`, `MutationResult`, `Verdict`, `BatchResult`, `StatusReport`, `ValidationReport`. Field names exactly as in the spec. Export inferred types. Add `test/schemas.test.ts` cases that parse every JSON example block in the spec (extract them from the markdown in the test so spec and code can't drift). If an example contradicts the prose, fix the spec and record it as ADR-0006.
2. **`src/exec.ts`.** One helper for shell-outs: `run(cmd, args, {cwd, timeoutMs, env})` → `{code, stdout, stderr, ms}`, kills the process group on timeout. Everything later (tsc, vitest, stryker, swift, muter, mlx_lm) goes through it.
3. **`sidecrew doctor`.** Implement `src/doctor.ts`: rows for node version, `python3 -m mlx_lm.server --help` availability, worker reachability on the default port (GET `/v1/models`), memory (total via `sysctl hw.memsize`, free via `vm_stat` page counts), TypeScript toolchain (`tsc`, `vitest`, `stryker` — via `npx --no-install` in cwd), Swift toolchain (`swift --version`, `muter --version`). Output format and ok/missing wording like simframe's doctor; non-zero exit only if node or memory checks fail (everything else is a degraded capability, not an error).
4. **Fixtures shells.** `fixtures/ts-fixture` (pnpm or npm, Vitest, strict TS, empty `src/`) and `fixtures/swift-fixture` (SwiftPM, XCTest + Swift Testing test targets, empty source). READMEs say Phase 2/3 fill them.
5. `npm run lint && npm test` green. Update `PHASES.md` status and `docs/CHANGELOG.md`. Small conventional commits.

Don't implement `serve`, the worker client, verifiers or MCP tools — the stubs that throw with the phase name are correct for now. No new runtime dependencies without an ADR.

Finish by printing what you built, the doctor output on this machine, and open questions.
