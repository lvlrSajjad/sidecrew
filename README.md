# sidecrew

**Local workers for Claude Code, behind a verifier.**

Claude Opus plans, writes one exemplar per kind of task, and reviews. Small models running **on your Mac**
(MLX, no network) do the narrow work in parallel. A mechanical gate — compile → run → mutation-kill — decides
what Claude ever sees. Workers cost zero Claude tokens.

First workload: **unit tests for an existing Swift or TypeScript project.** The same worker + verifier loop
is meant to carry other narrow, checkable jobs later (doc comments, fixtures, migrations).

Not a test framework. Vitest/XCTest run the tests; StrykerJS/Muter mutate the code. sidecrew orchestrates.

## Why

| | Claude writes every test | sidecrew |
|---|---|---|
| Tokens per test | full generation, every function | planning + one exemplar per shape + review of survivors |
| Latency bound | API | your hardware — 2–3 × 7B workers on 32 GB |
| What Claude reads | raw output | only tests that compiled, passed and killed ≥ 1 mutant |
| Network for generation | yes | none |

Numbers for this table are the job of `experiments/go-no-go/` — measured, not promised. Nothing runs yet (see Status).

## Install

```
npm install -g sidecrew
sidecrew doctor
```

`doctor` checks each capability separately:

```
ok   node             v22.x
ok   mlx_lm           python3 -m mlx_lm.server
ok   worker           :8000 · Qwen2.5-Coder-7B-Instruct-4bit · rev pinned
ok   memory           32 GB total · 17 GB free
ok   typescript       tsc / vitest / stryker
ok   swift            swift 6 / muter
```

### Claude Code

```
claude mcp add --scope user sidecrew -- npx -y sidecrew mcp
```

Optionally install the skill and agents so `/sidecrew plan|run|review` exist:

```
cp -r $(npm root -g)/sidecrew/claude/skills/sidecrew ~/.claude/skills/
cp    $(npm root -g)/sidecrew/claude/agents/*.md     ~/.claude/agents/
```

### Any other MCP client

```json
{ "mcpServers": { "sidecrew": { "command": "npx", "args": ["-y", "sidecrew", "mcp"] } } }
```

## Capabilities are independent

| Capability | Needs | Without it |
|---|---|---|
| Plan, validate, verify TypeScript | node, `tsc`, `vitest`, `stryker` | — |
| Verify Swift | Xcode CLT, `muter` | TS only |
| Local workers | `pip install mlx-lm` (Apple Silicon) | verify-only; Claude writes tests itself |

```
pip install mlx-lm                                          # workers
brew install muter-mutation-testing/formulae/muter          # Swift mutation
```

## The tools

| Tool | What it does |
|---|---|
| `sidecrew_status` | Worker up? Which model, revision, free RAM, which verifiers are available. |
| `sidecrew_generate` | One `WorkerTask` → one candidate test from the local model. Never touches the Anthropic API. |
| `sidecrew_verify` | compile → run → mutate one file → `Verdict`. |
| `sidecrew_run_batch` | Whole plan: generate → verify → retry once with the error → escalate. Returns survivors and escalations only. |
| `sidecrew_plan_validate` | Schema + every exemplar survives + `source_sha` matches the code. |

## How it works

```
Claude (Opus)          sidecrew                       local worker (mlx_lm.server)
  reads module ──► test_plan.json + one exemplar/shape
                     for each function × shape ──► prompt = source + exemplar ──► candidate
                     verifier: tsc/swift build → vitest/swift test → stryker/muter
                        survive? ── yes ──► survivors (Claude reviews low mutation-score ones)
                                 ── no  ──► retry once with error ──► escalate to Claude
```

- **The verifier is the product.** Survive ⇔ compiles ∧ passes ∧ kills ≥ 1 mutant ∧ not tautological.
- **Workers are deterministic.** temperature 0, fixed seed, pinned model revision.
- **Workers are a separate process, not a Claude Code subagent.** Subagents can only pick haiku/sonnet/opus on the session endpoint, so local routing has to go through MCP. See `docs/research/`.
- **Memory-aware.** Won't spawn a worker if free RAM < model estimate + 2 GB.

## CLI

```
sidecrew doctor
sidecrew serve [--model qwen2.5-coder-7b-4bit] [--port 8000]
sidecrew run test_plan.json --concurrency 2
sidecrew verify Tests/FooTests.swift --plan test_plan.json
sidecrew status / stop / mcp
```

## Status

Phase 0 (scaffold). `docs/plan/PHASES.md` is the roadmap; `docs/research/` is why it looks like this.

## Releasing

Same as simframe: bump `package.json` and `server.json` together, tag, push; the release workflow checks they agree and publishes to npm and the MCP Registry.

## License

MIT. Worker models and tools have their own licences; only Apache-2.0 / MIT ones are on the shortlist.
