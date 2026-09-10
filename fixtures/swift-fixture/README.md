# swift-fixture

The Swift half of the verifier's ground truth. **Phase 3 fills this in** — see
`docs/plan/prompts/phase-3-verifier-swift.md`.

Today it is a SwiftPM shell with one library target and two test targets, one per framework:

| target | framework | why both |
|---|---|---|
| `SwiftFixtureXCTests` | XCTest | what most existing Swift packages still use |
| `SwiftFixtureTests` | Swift Testing | what new ones use, and where Muter's per-test attribution is unproven |

Muter runs the package's own test command, so it inherits whatever the target uses. Whether it can
attribute a kill to the right Swift Testing test is the open question behind ADR-0005; keeping both
targets here is what makes that answerable rather than assumed.

Phase 3 adds ~20 pure functions in `Sources/SwiftFixture/` and replaces the placeholders. Run with
`swift test` in this directory, and mutate with `muter --files-to-mutate <file>` and
`SWIFT_TREAT_WARNINGS_AS_ERRORS=NO`.
