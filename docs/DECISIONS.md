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

## ADR-0007 — StatusReport and ValidationReport are defined in the spec, and the spec is executable
Context: `docs/specs/pipeline.md` named `StatusReport` and `ValidationReport` in the MCP tool signatures
but never gave them a shape, so Phase 0 could not implement them "exactly as in the spec" — there was no
spec to be exact about. Separately, the phase-0 prompt asked for this decision to be recorded as ADR-0006;
that number was already taken by the Goodhart ADR, hence 0007.
Decision: (a) define both shapes in the spec, with a json example, before writing the zod for them;
(b) make `test/schemas.test.ts` extract every ```json block from the spec markdown and parse it with the
matching schema, and fail if the set of blocks and the set of schemas ever differ. The spec is now the
test fixture, so it cannot drift from the code in either direction.
Also fixed while there: the spec claimed "Pydantic models live in src/schemas.ts", a leftover from a
Python draft. Added the `Language` / `TestFramework` / `CapabilityStatus` enums the shapes were already
using implicitly.
Consequences: adding a shape means adding a spec example, not just a schema. Two invariants moved from
prose into the type system — a `Verdict` whose `survived` disagrees with its own fields does not parse,
and `BatchResult.stats.claude_tokens.workers` is a literal `0`, so a run that spent Claude tokens on
worker inference cannot be serialised. 
Amended same day: `TestFramework` is an open string, not the closed enum this ADR first shipped. The
enum would have rejected a real project at parse time, before the verifier got to say whether it could
handle it — and the verifier is what actually knows, since it has to recognise the framework to build a
run command at all. `KNOWN_TEST_FRAMEWORKS` keeps the four we can drive today as documentation.

## ADR-0008 — `doctor` fails on the machine, not on the moment
Context: the memory row failed the command whenever free RAM was below the default model's footprint.
On the baseline 32 GB machine with Xcode and a simulator open that is an ordinary Tuesday: 8.6 GB free
against a 6.5 GB need is one browser away from red, and the state clears by itself when Xcode closes.
Decision: total RAM is a property of the machine and can fail `doctor`; free RAM is a property of the
moment and only degrades it. A machine that could never fit the default model fails, as does one whose
memory we cannot read; a machine that is merely busy reports the number and the remedy and exits 0. The
run refuses on its own when there is no room at the instant it asks — that check belongs to Phase 4's
memory-aware concurrency, where the answer is still true a second later.
Consequences: the DoD still holds — memory can fail the command — but red now means something a person
has to act on. A diagnostic that goes red for a condition that fixes itself is one people learn to
ignore, and then it is not there for the case it exists for.
