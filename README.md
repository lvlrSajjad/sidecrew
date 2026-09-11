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
| Latency bound | API | your hardware — **40 tok/s** per 7B worker, measured below |
| What Claude reads | raw output | only tests that compiled, passed and killed ≥ 1 mutant |
| Network for generation | yes | none |

The token and survival columns are the job of `experiments/go-no-go/` (Phase 6) — measured, not promised.
The speed column is measured already:

**M2 Pro, 32 GB, macOS 26.6.2, mlx_lm 0.31.3, with Xcode *and* a simulator open** —
`experiments/go-no-go/results/bench-2026-09-11.json`, every field `"measured": true`:

| model | decode | TTFT (warm) | peak RSS | swapped | 5× same prompt |
|---|---|---|---|---|---|
| Qwen2.5-Coder-7B-Instruct-4bit | **40.5 tok/s** | 159 ms | 4.4 GB | 0 | byte-identical |
| Qwen2.5-Coder-14B-Instruct-4bit | **21.1 tok/s** | 199 ms | 8.1 GB | 0 | byte-identical |

On a quiet machine: 42.3 and 21.2 tok/s — a full Xcode working set costs the 7B about 4 % and the 14B
almost nothing. What Xcode costs is memory, not speed: at 9.1 GB free the 14B swapped 3.2 GB. That is
why the 7B is the default and why starting a worker is gated on free RAM at that instant (ADR-0011).

## Install

```
npm install -g sidecrew
sidecrew doctor
```

`doctor` checks each capability separately:

```
ok       node       v20.20.0
ok       mlx_lm     python3 -m mlx_lm server available
MISSING  worker     nothing on http://localhost:8000/v1 — start one with: sidecrew serve
DEGRADED memory     32.0 GB total · 12.9 GB free — room for one qwen2.5-coder-7b-4bit, not two workers or a 14B
ok       tsc        Version 5.9.3
ok       vitest     vitest/2.1.9 darwin-arm64 node-v20.20.0
MISSING  stryker    not in this project's node_modules — npm i -D @stryker-mutator/core
ok       swift      Apple Swift version 6.3.3
MISSING  muter      not installed — brew install muter-mutation-testing/formulae/muter
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
- **Workers are deterministic.** temperature 0, fixed seed, pinned model revision. The seed is also what
  keeps a request out of `mlx_lm.server`'s batch — it decides batchability as `is_batchable and
  args.seed is None`, so sending one serialises the request by construction (ADR-0003).
- **Workers are a separate process, not a Claude Code subagent.** Subagents can only pick haiku/sonnet/opus on the session endpoint, so local routing has to go through MCP. See `docs/research/`.
- **Memory-aware, in two different senses.** *Installed* RAM picks the tier — 24 GB and up host a local
  worker, 16 GB machines fall back to the API (ADR-0009). *Free* RAM decides whether one may start right
  now: `serve` refuses below the model's footprint + 2 GB, because a worker that starts into swap does not
  merely run slowly, it poisons every number measured afterwards.

## CLI

```
sidecrew doctor                                  what this machine can do
sidecrew models [--pin [KEY]]                    pinned revisions, what is downloaded, this machine's tier
sidecrew serve [--model qwen2.5-coder-7b-4bit] [--port 8000] [--force]
sidecrew status / stop
sidecrew bench [--determinism]                   tok/s, TTFT, peak RSS → experiments/go-no-go/results/
sidecrew run test_plan.json --concurrency 2      (Phase 4)
sidecrew verify Tests/FooTests.swift --plan test_plan.json   (Phase 2/3)
sidecrew mcp
```

### Pinning a model

mlx_lm has no `--revision`, so a repo id means "whatever `main` is today". `sidecrew models --pin` writes
the commit that is actually in your Hugging Face cache into `src/models.json`, and `serve` then passes the
snapshot *path* — one immutable commit that cannot reach the network (ADR-0010).

```
sidecrew serve                 # downloads on first run
sidecrew models --pin          # writes the commit it downloaded
sidecrew bench --determinism   # 5× the same prompt: byte-identical, or non-zero exit
```

## Status

Phase 1. `serve` / `stop` / `status` / `models` / `bench` work; the verifiers, the planner and the MCP tools
do not yet. `docs/plan/PHASES.md` is the roadmap; `docs/research/` is why it looks like this.

## Releasing

Same as simframe: bump `package.json` and `server.json` together, tag, push; the release workflow checks they agree and publishes to npm and the MCP Registry.

## License

MIT. Worker models and tools have their own licences; only Apache-2.0 / MIT ones are on the shortlist.
