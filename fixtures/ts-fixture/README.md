# ts-fixture

The TypeScript half of the verifier's ground truth. **Phase 2 fills this in** — see
`docs/plan/prompts/phase-2-verifier-ts.md`.

Today it is a shell: strict TypeScript, Vitest, Stryker in `devDependencies`, and empty `src/` and
`test/`. It is a separate npm project on purpose — `sidecrew doctor` and the verifier probe the
toolchain of the project they are pointed at, and this is the project they will be pointed at.

Phase 2 adds:
- ~20 small pure functions in `src/`, one of them carrying a planted off-by-one so a test that
  survives can still be wrong. That is the case the mutation gate exists to expose.
- a `stryker.conf.json` scoped to a single source file with `incremental: true`, because mutating
  the whole fixture per candidate is not affordable.
- tautology fixtures: four tests that pass and mean nothing, four that pass and mean something.

Nothing here is installed by the root package, and it is not published: `npm i` in this directory
when you start Phase 2.
