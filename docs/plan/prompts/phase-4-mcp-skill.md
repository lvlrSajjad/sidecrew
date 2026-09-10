# Phase 4 — MCP tools + run + skill wiring

Read `CLAUDE.md`, `PHASES.md` Phase 4, research §C (why workers can't be subagents), `claude/skills/sidecrew/SKILL.md`, `claude/agents/*.md`, `src/mcp.ts`, `src/cli.ts`.

Goal: Claude Code sees sidecrew as MCP tools and a skill; `/sidecrew run` on the TS fixture returns only survivors.

1. `src/prompt.ts`: build the worker prompt from a `WorkerTask` using `src/prompts/worker.md` (simple `{{var}}` + `{{#if}}` templating, no dependency). Under 600 tokens excluding source and exemplar. Phase 5 tunes the wording.
2. `src/batch.ts`: `runBatch(planPath, {concurrency, dryRun})` — for every function × shape: generate → verify → on failure retry once with the error appended → escalate. Concurrency default = min(`max_concurrency_32gb`, what free RAM allows). Writes `.sidecrew/runs/<id>/{tasks,candidates,verdicts}/*.json` and `result.json` (`BatchResult`). Files are the IPC; the MCP tool just returns `result.json`.
3. `sidecrew run`, `sidecrew verify`, `sidecrew generate` CLI subcommands over the same functions.
4. `src/mcp.ts`: tools `sidecrew_status`, `sidecrew_generate`, `sidecrew_verify`, `sidecrew_run_batch` with zod input schemas from `src/schemas.ts`; tool descriptions say plainly that generation runs locally and costs no Claude tokens.
5. Verify from a clean checkout: `npm run build && npm link && claude mcp add --scope user sidecrew -- sidecrew mcp`, then a real call from Claude Code.
6. Finish `claude/skills/sidecrew/SKILL.md` (`/sidecrew plan|run|review|escalate`) and the install snippet in README. The skill must state that generation goes through the MCP tool, never a subagent.
7. Manual acceptance on the TS fixture; paste the `BatchResult.stats` block into `docs/CHANGELOG.md`.
