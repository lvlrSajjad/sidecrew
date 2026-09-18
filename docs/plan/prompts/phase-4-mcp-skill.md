# Phase 4 — MCP tools + run + skill wiring

Read `CLAUDE.md`, `PHASES.md` Phase 4 **and the Phase 2 and 3 records above it**, research §C (why workers
can't be subagents), `claude/skills/sidecrew/SKILL.md`, `claude/skills/sidecrew/references/verifier.md`,
`claude/agents/*.md`, `src/mcp.ts`, `src/cli.ts`, and both verifiers — `src/verifier/ts.ts` and
`src/verifier/swift.ts`. They are built, tested and measured; this phase wires them up and writes
nothing of its own into them.

Goal: Claude Code sees sidecrew as MCP tools and a skill; `/sidecrew run` on the TS fixture returns only survivors.

1. `src/prompt.ts`: build the worker prompt from a `WorkerTask` using `src/prompts/worker.md` (simple `{{var}}` + `{{#if}}` templating, no dependency). Under 600 tokens excluding source and exemplar. Phase 5 tunes the wording.
2. `src/batch.ts`: `runBatch(planPath, {concurrency, dryRun})` — for every function × shape: generate → verify
   → on failure retry once with the error appended → escalate. Writes
   `.sidecrew/runs/<id>/{tasks,candidates,verdicts}/*.json` and `result.json` (`BatchResult`). Files are the
   IPC; the MCP tool just returns `result.json`.
   **Concurrency is a function, not a field.** `max_concurrency_32gb` was deleted by ADR-0009: installed RAM
   picks the tier, free RAM at the instant the run starts picks the concurrency, and the gate is
   `models.json`'s `ram_gb` + 2 GB free per worker (ADR-0011). `src/models.json` `_notes.concurrency` says
   this phase owns it. `DEFAULT_STRYKER_CONCURRENCY` is a constant in `src/verifier/ts.ts` for the same
   reason and should come from the same calculation rather than from two places.
   **Two things must not consume the single retry** (ADR-0012, ADR-0005): `stage_reached === "mutation"`
   means the mutation tool broke, not that the test is bad; and a verdict whose four mutation counts are all
   `0` means nothing in that function could be mutated, so no test of it could ever have killed anything.
   `docs/specs/pipeline.md` has the table.
3. `sidecrew run`, `sidecrew verify`, `sidecrew generate` CLI subcommands over the same functions.
   **There are two verifiers now and `verify` has to dispatch.** `TestPlan.language` picks `verifyTs` or
   `verifySwift`; both take an explicit target and return the same `Verdict`. Mapping a `TestPlan` onto a
   target is the real work here, and two pieces of it are not in the contract yet:
   - `projectDir`. `TestPlan.module` is a path to the source file, so the package root has to be found by
     walking up to the nearest `package.json` / `Package.swift`, or passed in. Affects both languages.
   - `testTarget`, Swift only. A package with one test target defaults fine; one with several cannot be
     guessed at and `verifySwift` raises a `VerifierSetupError` saying so. **Read the proposed ADR-0014 in
     `docs/DECISIONS.md` and settle it before writing the dispatch** — it is a contract change, so it needs
     the ADR and the spec update in the same commit.
   Phase 4's acceptance is on the TS fixture, so a Swift path that raises a clear setup error is an
   acceptable landing point — but it must be a deliberate one, not a discovery.
4. `src/mcp.ts`: tools `sidecrew_status`, `sidecrew_generate`, `sidecrew_verify`, `sidecrew_run_batch` with zod input schemas from `src/schemas.ts`; tool descriptions say plainly that generation runs locally and costs no Claude tokens.
5. Verify from a clean checkout: `npm run build && npm link && claude mcp add --scope user sidecrew -- sidecrew mcp`, then a real call from Claude Code.
6. Finish `claude/skills/sidecrew/SKILL.md` (`/sidecrew plan|run|review|escalate`) and the install snippet in
   README. The skill must state that generation goes through the MCP tool, never a subagent. Its
   `/sidecrew run` step 1 currently calls a `sidecrew_plan_validate` tool that this phase's DoD does not
   build — either add the tool or leave validation on the CLI, but do not leave the skill naming something
   that does not exist.
7. Manual acceptance on the TS fixture; paste the `BatchResult.stats` block into `docs/CHANGELOG.md`.
