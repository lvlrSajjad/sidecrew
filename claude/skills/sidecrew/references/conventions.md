# Conventions

## TypeScript
- Tests live in `<pkg>/test/` (or `__tests__/` if the project already uses it). Detect, don't impose.
- File per function × shape while in `.sidecrew/runs/`; merged into `<module>.test.ts` on `/sidecrew review` accept.
- Vitest by default; Jest if `jest.config.*` exists. Imports relative to the test file.
- Mutation: StrykerJS with `--mutate <src file>` only, incremental on.

## Swift
- SwiftPM: `Tests/<Target>Tests/<Module>Tests.swift`. Prefer the framework the target already uses (XCTest vs Swift Testing); don't mix in one file.
- `@testable import <Module>`.
- Mutation: Muter `--files-to-mutate <src>`; `SWIFT_TREAT_WARNINGS_AS_ERRORS=NO`.

## Naming
`test_<function>_<shape>_<short_case>` (Swift camelCase equivalent). One behaviour per test.
