# Licences

Non-negotiable #6: **Apache-2.0 or MIT only for anything sidecrew downloads or ships by default.**

This file is the audit, not the policy. Every row was read off the installed artefact on
2026-09-12 — the `LICENSE` file in the package, or the `license` field in its `package.json` — rather
than off a project's website, because a website is not what gets installed.

Three categories, and only the first two are bound by the rule:

- **shipped** — code that goes into the npm tarball or is a runtime dependency of it;
- **downloaded by default** — model weights `sidecrew serve` will fetch;
- **external capability** — a tool the user installs themselves and sidecrew shells out to. `doctor`
  reports these as ok / degraded / missing and they are never bundled (ADR-0002), so their licence
  constrains *us* only in what we may recommend and vendor. We record it anyway, because a tool the
  README tells people to `brew install` is a tool we are making a recommendation about.

## Shipped

| | licence | how it was checked |
|---|---|---|
| sidecrew itself | MIT | `LICENSE`, `package.json` |
| `@modelcontextprotocol/sdk` | MIT | `node_modules/.../package.json` |
| `zod` | MIT | `node_modules/.../package.json` |

Dev-only, so not in the tarball, but they run in CI and on contributors' machines:
`typescript` Apache-2.0, `vitest` MIT, `tsx` MIT, `@types/node` MIT.

## Downloaded by default

| model | licence | notes |
|---|---|---|
| `mlx-community/Qwen2.5-Coder-7B-Instruct-4bit` | Apache-2.0 | the default worker |
| `mlx-community/Qwen2.5-Coder-14B-Instruct-4bit` | Apache-2.0 | gated on free RAM (ADR-0011) |

Recorded in `src/models.json` alongside the pinned revision, and CI fails if a shipped model is either
unpinned or non-permissive — the check is in `.github/workflows/ci.yml`, so this table cannot quietly
stop being true.

**Two models are excluded by this rule and both exclusions cost us something.** Qwen2.5-Coder-3B is
the one size in that family under the Qwen Research License rather than Apache-2.0, and it is exactly
the model anyone would reach for on a 16 GB machine; ADR-0009 sends those machines to the API tier
instead. Codestral's weights are research-only and must never be added (research §E).

## External capabilities

| tool | version checked | licence | how it was checked |
|---|---|---|---|
| Muter | 16 (`muter-mutation-testing/formulae`) | **MIT**, © 2020 Muter | `/opt/homebrew/Cellar/muter/16/LICENSE`, 20 lines, verbatim MIT |
| StrykerJS | `@stryker-mutator/core` | Apache-2.0 | `package.json` in `fixtures/ts-fixture/node_modules` |
| `mlx_lm` | 0.31.3 | MIT | Apple's mlx-examples / mlx-lm repository |
| Swift toolchain, `xcrun` | Xcode 26 | Apple licence | Apple's own terms; installed by the user with Xcode, never by us |

Muter is the reason this file exists — the Phase 3 prompt asked for its licence to be read out of the
repository rather than assumed. It is MIT, which is inside the rule, so `sidecrew doctor` may keep
recommending `brew install muter-mutation-testing/formulae/muter`. Two things are worth writing down
next to that:

- **We link to it, we do not vendor it.** `src/verifier/swift.ts` shells out through `src/exec.ts` and
  reads a JSON file. Nothing of Muter's is copied into this repository, so MIT's attribution clause is
  satisfied by this row rather than by a bundled notice.
- **The Homebrew formula is the distribution we actually check.** The tap is
  `muter-mutation-testing/formulae` and `brew info` reports it built from source at version 16. A
  future bottle from somewhere else is a different artefact, and the version in
  `experiments/go-no-go/results/verifier-swift-cost.json` is what says which one a measurement came
  from.

The Swift toolchain is the one row that is not permissive, and it is not meant to be: it arrives with
Xcode, the user agreed to Apple's terms when they installed it, and sidecrew neither ships nor
downloads any part of it. `doctor` reporting `swift missing` is the whole of our involvement.
