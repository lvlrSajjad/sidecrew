# Phase 1 — serve + worker client + bench

Read `CLAUDE.md`, `PHASES.md` (Phase 1 DoD), research §A (shortlist) and §C (serving, determinism, memory).

Goal: one command starts a deterministic local worker on this M2 Pro / 32 GB machine, and we measure it.

1. `src/models.json` is the pin file. Add a `sidecrew models` subcommand that lists entries and, after a model has been downloaded, resolves the local HF snapshot commit and offers to write it into `revision` (`--pin`). Keep the commented-out Devstral note as a JSON `_notes` field.
2. `sidecrew serve [--model KEY] [--port N]` (`src/serve.ts`): spawns `python3 -m mlx_lm.server --model <repo> [--revision …]`, detaches, writes `.sidecrew/worker-<port>.{pid,log}`, waits for `/v1/models` to answer, prints model + revision + port. Refuse to start if free RAM < `ram_gb` + 2 (memory rule) unless `--force`. `sidecrew stop [--port]`, `sidecrew status`.
3. `src/worker.ts`: `complete()` against `/v1/chat/completions` with `temperature: 0`, `seed`, `max_tokens`, `stop`; returns text, usage, wall ms, TTFT (use streaming to measure first token, or document why not). Retry once on ECONNREFUSED/ECONNRESET only. Refuse any base URL containing `anthropic.com`.
4. Determinism: `sidecrew bench --determinism` sends the same ~400-token prompt 5× and reports byte-identical or not. If mlx_lm.server batching breaks it, find the flag or serialise requests and write ADR-0003.
5. `sidecrew bench` → `experiments/go-no-go/results/bench-<YYYY-MM-DD>.json`: per model that fits — decode tok/s, TTFT, peak RSS of the server (ps over the run), plus `machdep.cpu.brand_string`, RAM, macOS version, whether Xcode was open. All fields `"measured": true`.
6. Tests: `test/worker.test.ts` against a tiny in-process fake OpenAI server (node http). No test needs a real model; `test/worker.slow.test.ts` may.

Do not write test-generation prompts yet; the client takes `messages` as given. Do not touch verifiers.

Finish with: the bench numbers, whether 14B fit alongside Xcode, and the determinism result.
