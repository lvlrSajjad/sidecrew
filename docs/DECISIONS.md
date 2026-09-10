# Architecture decisions

## ADR-0001 — Workers are a separate local process behind MCP, not Claude Code subagents
Context: subagents can only choose haiku/sonnet/opus on the session's endpoint; `ANTHROPIC_BASE_URL` is session-wide; per-subagent local routing is an open request (anthropics/claude-code #38698). Research §C.
Decision: workers = `mlx_lm.server` (OpenAI-compatible) reached through the `sidecrew` MCP server / CLI. Subagents only for planning (Opus), review (Sonnet), and the Haiku experiment control.
Consequences: zero Claude tokens for workers by construction; one extra process (`sidecrew serve`); we own retry/concurrency.

## ADR-0002 — TypeScript npm package, no Python helper
Context: simframe ships as `npx -y simframe mcp`; mlx_lm.server already speaks HTTP; verifiers are shell-outs.
Decision: single Node package; `mlx_lm` is an external capability like `idb` is for simframe, checked by `doctor`.
Consequences: one toolchain to install; Python appears only as `python3 -m mlx_lm.server` spawned by `serve`.

## ADR-0003 — (Phase 1) determinism under mlx_lm.server batching — _tbd_
## ADR-0004 — (Phase 2) verification sandbox: temp copy vs git worktree — _tbd_
## ADR-0005 — (Phase 3) Muter + Swift Testing attribution — _tbd_

## ADR-0006 — The verifier is a scoring rule; design it against Goodhart, not just against bugs
Context: the worker is an optimizer pointed at the verifier. The cheapest way to score well is not to write a good test but to satisfy the gate: `assert true`, `expect(x).toBe(x)`, a snapshot that pins today's (possibly wrong) output, or one weak assertion that happens to kill a single trivial mutant. This becomes acute if we ever fine-tune or select a worker on its own survivors.
Decision: every gate we add is judged by "what is the cheapest way to pass it without the test being useful?" before it ships. Current gates and their known cheap passes:
- compile / pass → tautological tests. Countered by the static tautology check.
- killed ≥ 1 → a test that kills one trivial mutant (e.g. removes a `return`) while asserting nothing about the interesting logic. Countered only partially; hence mutation *score* drives review, not survival alone.
- mutation score → snapshot-of-current-bug kills mutants and encodes the bug. Countered by review of low-score survivors and, later, LLM-proposed mutants (BACKLOG).
- equivalent mutants inflate "survived" and depress the score for good tests. Accept; treat score as a review signal, not a pass/fail.
Consequences: no single metric is the objective; survival is a filter, score is a router to review, and Claude still sees the low-confidence tail. Any new metric gets a "cheap pass" line added here before it is used for anything.
