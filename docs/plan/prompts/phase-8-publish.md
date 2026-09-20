# Phase 8 — Publish

Read `CLAUDE.md`, `PHASES.md` Phase 8, `experiments/go-no-go/results/REPORT.md`, and simframe's README + release workflow for the pattern.

1. Replace every estimated number in `README.md` with the measured ones from Phase 6; keep the measured/estimated labels.
2. `npm pack --dry-run` shows only `dist`, `claude`, README, LICENSE. `npx -y sidecrew@file:… doctor` works from a temp dir.
3. Validate `server.json` against the current MCP Registry schema; bump both versions to `0.1.0`.
4. Tag `v0.1.0`, confirm `release.yml` passes the version check and publishes.
   *(Corrected 20 Sep 2026: **no `NPM_TOKEN`.** npm is ending token publishing; both halves now
   authenticate by OIDC. npm's needs a Trusted Publisher entry created once on npmjs.com.)*
5. `docs/` GitHub Pages site like simframe's: what it is, install, measured table, how it works.
6. Write `docs/plan/prompts/phase-9-*.md` for Python/Kotlin verifiers and a second workload.
