# Phase 3 — Verifier: Swift

Read `CLAUDE.md`, `PHASES.md` Phase 3 DoD, and the TS verifier you (or a previous session) built in Phase 2 — Swift must return an identical `Verdict` shape.

1. `fixtures/swift-fixture/`: SwiftPM package, ~20 pure functions mirroring the TS fixture's spread (Foundation-only, no UIKit). Two test targets: `XCTest` and `Swift Testing` (`@Test`). Same deliberate off-by-one.
2. `muter.conf.yml` template: `executable: /usr/bin/xcrun` with `swift test` (or `xcodebuild` if the package needs a scheme), `SWIFT_TREAT_WARNINGS_AS_ERRORS=NO`, `excludeList` for tests. Runtime scoping via `muter --files-to-mutate <src>`.
3. `src/verifier/swift.ts`: same stages as TS — `swift build` → `swift test --filter <TestClass>` → `muter run --files-to-mutate <src> --output json` → parse. Handle both XCTest and Swift Testing output. Check Muter's current Swift Testing support first; if it can't attribute failures, fall back to running the test command yourself per mutant and document it (ADR-0005).
4. Cost per candidate → `experiments/go-no-go/results/verifier-swift-cost.json` (measured). Swift will be slower; note whether the simulator needs to be running (it shouldn't for a pure package).
5. Same tautology fixtures translated to Swift (`XCTAssertTrue(true)`, `XCTAssertEqual(x, x)`, `#expect(true)`).
6. Tests as in Phase 2.

Extra: check the Muter licence file in the repo and record it in `docs/research/licences.md`.
