# Changelog
## Unreleased — Phase 1 (2026-09-11)
- `sidecrew serve` / `stop` / `status`: starts `mlx_lm.server` detached, waits for `/v1/models` to answer,
  writes `.sidecrew/worker-<port>.{pid,log,json}`. Refuses to start below the model's footprint + 2 GB free
  unless `--force`; on a 16 GB machine the refusal says "api tier" rather than "close Xcode" (ADR-0009).
  This is the one place that does not go through `src/exec.ts`, because a worker has to outlive the CLI.
- `src/worker.ts`: streamed `/v1/chat/completions` at temperature 0 with a mandatory seed, returning text,
  usage, wall ms and TTFT. Streams in order to measure TTFT at all; `stream_options.include_usage` keeps the
  token counts measured rather than guessed, and a response without one is flagged, never estimated.
  Refuses any Anthropic base URL. Retries once, only on ECONNREFUSED/ECONNRESET, only before a token has
  arrived, and after a 250 ms backoff — an immediate retry asks the same dead socket twice.
- `sidecrew models [--pin [KEY]]`: lists the pin file against the Hugging Face cache — downloaded or not,
  pinned or drifted — and writes the cached commit into `revision`. `models.json` gained `tiers`
  (installed RAM → tier) and `_notes` (why Devstral, Qwen-3B and Codestral are absent), and lost
  `max_concurrency_32gb`, which baked one machine size into a field name (ADR-0009).
- `sidecrew bench [--determinism]`: decode tok/s, TTFT and peak RSS per model that fits, with the machine
  (CPU, RAM, macOS, mlx_lm version, whether Xcode and a simulator were open, mains or battery) in every
  record, `"measured": true`, into `experiments/go-no-go/results/bench-<date>.json`. `--determinism` sends
  one ~400-token prompt 5× serially and exits non-zero unless the outputs are byte-identical.
- **Measured, on the baseline M2 Pro / 32 GB with Xcode and a simulator open** (`bench-2026-09-11.json`):
  7B 40.5 tok/s, 159 ms warm TTFT, 4.4 GB peak RSS, 0 swapouts; 14B 21.1 tok/s, 199 ms, 8.1 GB, 0
  swapouts. Quiet: 42.3 and 21.2 tok/s. Both 5/5 byte-identical at temperature 0 with a fixed seed. The
  14B only stays clean while there is room: at 9.1 GB free it swapped out 3.2 GB. Research §A's estimates
  (7B 35–55, 14B 20–28 tok/s) are replaced by these.
- `serve` waits until the worker can **generate**, not until `/v1/models` answers. mlx_lm serves that
  endpoint from the Hugging Face cache while the model is still loading: measured 1.9 s early on a warm
  14B, and the entire load when cold. A first request that used to absorb a 4.3 s load now returns in
  0.97 s, and the RSS sampler no longer measures a model on its way up — which is why the footprints
  above are larger, and right, compared with the first draft of these numbers.
- `serve` kills the worker it started when readiness fails, instead of deleting the pidfile and leaving a
  process holding the port and several GB with nothing left to find it by. `stop` checks the pid is still
  an mlx_lm worker before signalling its process group, so a stale pidfile plus pid reuse can no longer
  put an unrelated process in the blast radius; it clears the stale file and says it killed nothing.
- ADR-0011 and the `ram_gb` values with it (4.5 / 8.2, measured, replacing estimates of 5.0 / 9.0): RSS is
  only meaningful after the model is loaded and only from a run that swapped nothing — under pressure
  macOS compresses and RSS *falls* while the machine thrashes (the 14B read 4364 MB while writing 3.2 GB
  to disk). `bench` now records a swapout delta per model and marks a row `trustworthy: false` past a
  100 MB floor — not past zero, because the counter is system-wide and a clean run still picked up
  10.8 MB of background noise.
- CI at last (`.github/workflows/ci.yml`), flagged as missing since Phase 0: the fast set on macOS for
  node 20 and 22, plus two contract checks — `package.json`/`server.json` versions agree, and every
  shipped model is Apache-2.0/MIT and pinned.
- ADR-0003: determinism under batching is solved by the seed itself — mlx_lm decides batchability as
  `is_batchable and args.seed is None`, so a seeded request is served outside the batch. Verified in the
  source of the pinned version, not inferred from five matching runs.
- ADR-0010: mlx_lm has no `--revision`, so the pin is the cached snapshot *path* — one immutable commit
  that cannot reach the network. Unpinned runs say so, in `models`, in `serve`, and in every bench record.
- `doctor` now probes `python3 -m mlx_lm server` (the `-m mlx_lm.server` form is deprecated in 0.31 and put
  a warning in the log on every start) and honours `SIDECREW_PYTHON`.
- Tests: 113 fast tests, none needing a model. The worker client is tested against an in-process fake that
  is deliberately literal about mlx_lm's SSE framing; `serve`/`stop` are tested end to end against a stub
  interpreter, which is what the `SIDECREW_PYTHON` seam buys. `test/worker.slow.test.ts` covers the real
  server under `SIDECREW_SLOW=1`.

## 0.0.1 — 2026-09-10
- Scaffold in simframe shape: npm package, CLI + MCP stubs, `server.json`, phased plan and per-phase prompts, contracts spec, optional Claude skill + agents, experiment protocol, research.
- Contracts: all nine pipeline shapes in `src/schemas.ts`, with `test/schemas.test.ts` parsing every json example out of `docs/specs/pipeline.md` so spec and code cannot drift (ADR-0007). Survival and zero-worker-tokens are enforced by the schema, not by convention.
- `src/exec.ts`: the one shell-out helper. Own process group per child, SIGTERM then SIGKILL on timeout, per-stream output cap, missing binaries reported rather than thrown.
- `sidecrew doctor`: node · mlx_lm · worker · memory · tsc/vitest/stryker · swift/muter, each ok / degraded / missing, `--port` and `--json`. Non-zero exit only when node or memory fails.
- Fixture shells: `fixtures/ts-fixture` (strict TS, Vitest, Stryker) and `fixtures/swift-fixture` (SwiftPM with XCTest *and* Swift Testing targets). Both build today; Phases 2 and 3 fill them.
- `npm run lint` now typechecks `test/` as well as `src/`; `npm run build` copies `src/prompts/` into `dist/`, which `tsc` does not do and `files` would otherwise never ship.
- `TestFramework` is an open string rather than a closed enum: the verifier, not the contract, is what knows which frameworks it can drive (ADR-0007, amended).
- `doctor` fails on total RAM, not on free RAM. A machine that is merely busy is degraded and exits 0 (ADR-0008).
- Worker tier is part of the contract (ADR-0009). `Candidate.worker.kind` and `BatchResult.config.worker_kind` are `local` | `api`; 16 GB machines, which cannot host a local worker alongside Xcode, fall back to the API. The zero-worker-tokens guarantee is now conditional on the tier rather than absolute — and still enforced, not assumed.
