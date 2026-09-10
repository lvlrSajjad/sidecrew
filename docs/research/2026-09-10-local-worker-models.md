# Local worker models for an orchestrator–workers test-generation pipeline (M2 Pro, 32 GB) — 10 Sep 2026

Research report answering `2026-09-10-research-prompt.md`. Every number is flagged **measured** (with source) or **estimated**.
Machine: MacBook Pro 16" 2023, M2 Pro, 32 GB, macOS Tahoe 26.6.2; Xcode + simulator resident → ~14–18 GB usable for models.

## TL;DR
- **Download a model; do not use Apple's on-device Foundation Model as the worker.** Apple tells developers to avoid code generation with it, publishes no coding benchmark, and its context is 4,096 tokens on macOS 26.
- **Shortlist:** Qwen2.5-Coder-14B-Instruct 4-bit (accuracy tier, 1–2 parallel) and Qwen2.5-Coder-7B-Instruct 4-bit (fast tier, 2–3 parallel), both Apache-2.0, both via MLX. Devstral Small (24B, Apache-2.0) is marginal on 32 GB. 30B-class is a no-go with Xcode open.
- **After a compile→run→mutation-kill verifier, model size matters much less** than for raw generation (Meta TestGen-LLM / ACH, TestGenEval). Exemplar conditioning reliably lifts small models (TestPilot, 2026 few-shot studies).
- **Workers cannot be Claude Code subagents.** Subagents only select haiku/sonnet/opus on the session endpoint; no per-subagent local routing (open request anthropics/claude-code #38698). Run workers behind `mlx_lm.server` and call them from an MCP server.

## A. Candidate worker models

### Apple Foundation Models (on-device ~3B) — not the worker
1. WWDC25 session 248 (Apple engineer, verbatim): "The system model is not optimized for code, so avoid code generation tasks as well." Developer docs: it "may not perform as well on complex reasoning tasks, math, or code generation." The 2025 tech report scopes it to summarisation, extraction, understanding, refinement, short dialog, creative text.
2. No HumanEval/MBPP/pass@k published for the on-device model.
3. `SystemLanguageModel.contextSize` = **4096** on macOS 26 (8192 reported for the OS-27 / gen-3 model, community). Overflow throws `.exceededContextWindowSize`; no auto-trim. 26.4 added `contextSize` and `tokenCount(for:)`.
4. Advantage: zero download, near-zero footprint (inference in a resident system service; client idles ~33 MB). Doesn't outweigh vendor guidance.

CLI drivability: no first-party CLI on macOS 26; a `swiftc`-compiled executable importing `FoundationModels` works from Terminal. Community OpenAI/Ollama shims: gety-ai/apple-on-device-openai (:11535, model `apple-on-device`), Techopolis/afm-Server (:11435), scouzi1966/maclocal-api (`afm`), rudrankriyam/Foundation-Models-Framework-CLI (`afm serve`), apfel (Homebrew, MCP, MIT). A first-party `fm` CLI + Python SDK is reported for macOS 27 (WWDC26 session 334) — unconfirmed on Tahoe. Use case here: free non-code helper (e.g. summarising verdicts), not the worker.

### Ranked shortlist (32 GB, ~14–18 GB usable)

| rank | model | licence | Q4 RAM | M2 Pro tok/s (MLX) | context | parallel on 32 GB | notes |
|---|---|---|---|---|---|---|---|
| 1 (accuracy) | Qwen2.5-Coder-14B-Instruct | Apache-2.0 | ~8 GB + KV | **~20–28 est.** (M2 Pro 32 GB llama.cpp 14B ≈ 20 measured, community; MLX ≈ 1.5–2× llama.cpp measured on M4 Max) | 128K (gen ≤ 8K) | 1–2 | sits between 7B and 32B on EvalPlus/LiveCodeBench |
| 2 (fast) | Qwen2.5-Coder-7B-Instruct | Apache-2.0 | ~4.2 GB + KV | **~35–55 est.** (llama.cpp 7B Q4 ≈ 70 on M2 Ultra measured; MLX 7–8B ≈ 62 on M4 Max measured) | 128K | 2–3 | **HumanEval+ 84.1 % measured** (Qwen2.5-Coder tech report, arXiv:2409.12186) — beat CodeStral-22B and DS-Coder-33B |
| 3 (agentic) | Devstral Small 1.1 / Small 2 (24B) | Apache-2.0 | ~14 GB | ~12–18 est. | 128K / 256K | 1, no headroom | SWE-bench Verified **53.6 % → 68.0 % measured** (mistral.ai); marginal with Xcode open |
| — | Qwen2.5-Coder-32B | Apache-2.0 | ~19–20 GB | ~9–12 est. | 128K | 0 with Xcode | only if Xcode/simulator closed — contradicts constraints |
| — | Qwen3-Coder-30B-A3B / Qwen3-Coder-Next 80B-A3B (MoE) | permissive | 17–45 GB | fast (3B active) | 256K | marginal/no | weights too big for the budget despite speed |

Other families: DeepSeek-Coder-V2-Lite (16B MoE, 2.4B active) viable alternative in the 7–9B class; **Codestral 22B weights are non-production (licence trap — avoid)**; Gemma 3, Phi-4 (14B, MIT), StarCoder2, Granite Code exist but trail Qwen2.5-Coder at equal size on coding benchmarks.

**Test-generation-specific advantage:** none documented for any small model. The lever is verifier + exemplar, not a test-specialised model.

## B. What "accuracy" should mean, and the evidence
Definition adopted: **survival rate through compile → pass → mutation-kill (≥ 1 mutant) → non-tautological.**

- **TestGen-LLM** (Alshahwan et al., FSE 2024, arXiv:2402.09171): filters = builds, passes reliably, raises coverage. Reels/Stories: 75 % built, 57 % passed reliably, 25 % increased coverage; test-a-thons improved 11.5 % of classes, 73 % of recommendations accepted for production. The filters, not the model, give the guarantee.
- **ACH / mutation-guided** (Foster et al., FSE 2025, arXiv:2501.12862): of 571 accepted tests, 277 would have been discarded under a coverage-only criterion — mutation targeting is what yields fault-catching tests.
- **TestGenEval** (Jain, Synnaeve, Rozière, ICLR 2025, arXiv:2410.00752): on real repos the best model (GPT-4o) reaches 35.2 % coverage and **18.8 % mutation score**, vs ~100 % line coverage on self-contained TestEval. Everyone is weak on hard code, which compresses the small-vs-frontier gap once failures are discarded. Mutation score is far more correlated with bug detection and harder to game.
- **TestPilot** (Schäfer et al., TSE 2023, arXiv:2302.06527): re-prompting with the failure message → median 70.2 % statement / 52.8 % branch coverage (gpt-3.5-turbo, 25 npm packages) vs Nessie 51.3 / 25.6. Validates one-retry-with-error.
- **Few-shot / exemplars**: ICPC 2026 study (arXiv:2602.12256) — human-written exemplars give the best coverage and correctness; Ahmed & Devanbu (ASE 2022) — same-project examples improve output across 8 projects. Validates "Opus writes one exemplar per shape; worker copies by analogy".

**Answer to the key question:** after a strong verifier, size mostly changes the *discard rate* (how many attempts to get a survivor), not the quality of what survives. Expect a 7–14B local coder to reach most of Haiku's survival rate on narrow per-function tasks; the one-retry policy absorbs the rest.

### Verifier tooling
- **Swift — Muter** (MIT; github.com/muter-mutation-testing/muter): SwiftSyntax-based; invokes your test command (`swift test` / `xcodebuild`), so Swift Testing works as long as the command does. Expensive (suite per mutant) → scope with `--files-to-mutate <file>` and run only the corresponding test file. Set `SWIFT_TREAT_WARNINGS_AS_ERRORS=NO`.
- **TypeScript — StrykerJS** (Apache-2.0; stryker-mutator.io): Vitest/Jest runners, `typescript-checker` drops type-error mutants, `incremental: true`, `mutate` per file. Per-PR incremental runs typically < 2 min; full runs 5–30 min on medium codebases (measured, vendor/community).
- Coverage: `xccov` (Swift), Vitest/Istanbul (TS), SlipCover (Python, later).

## C. Architecture and orchestration
- **Claude Code subagents** (code.claude.com/docs/en/sub-agents): Markdown + YAML frontmatter, own context window, tool allow-list; `model` resolves per-invocation → frontmatter → `CLAUDE_CODE_SUBAGENT_MODEL` → main model, and accepts only `sonnet | opus | haiku | inherit` on **one session-wide provider**. `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` redirect *all* traffic. Per-subagent local endpoints: open feature request (#38698).
- **Therefore:** worker layer = separate local process. Options: (1) MCP server wrapping the MLX/Ollama endpoint (chosen — ADR-0001), (2) shell tool/hook. Either way goal 3 (zero Claude tokens for workers) holds by construction.
- **Anthropic "Building effective agents"**: orchestrator–workers = central LLM decomposes, delegates to worker LLMs, synthesises; recommended for coding products touching many files; use the simplest/cheapest component that works.
- **Serving:** `mlx_lm.server --model mlx-community/Qwen2.5-Coder-7B-Instruct-4bit --port 8000` (OpenAI-compatible `/v1/chat/completions`). Determinism: `temperature=0`, fixed `seed`; batched serving may ignore per-request seeds → one request per process or disable batching (verify in Phase 1, ADR-0003). Ollama ≥ 0.14 also speaks the Anthropic Messages API.
- **Memory:** 7B Q4 ≈ 4.2 GB each → 2–3 workers; 14B Q4 ≈ 8 GB → 1–2. Keep total resident < ~28 GB.

### Proposed pipeline
1. **Plan** (Opus, once per module): test plan with *shapes* + one exemplar per shape against the real API; exemplars must survive the verifier.
2. **Fan-out**: per function × shape → local worker (temp 0, seed), source + matching exemplar.
3. **Verify**: compile → run → mutate the single source file; survive ⇔ compiles ∧ passes ∧ kills ≥ 1 ∧ non-tautological.
4. **Retry once** with the error (TestPilot-style).
5. **Escalate** remaining failures to Claude in batch.
6. **Review survivors only** (Claude, batched), filtered by mutation score below a threshold + random audit sample.

## D. Go/no-go experiment
See `experiments/go-no-go/README.md` for the frozen protocol and decision rule. Summary: two fixtures (~20 functions each), identical plan/exemplars, three configs — C1 Apple FM via shim, C2 Qwen2.5-Coder-7B via MLX (C2b 14B), C3 Haiku via subagent as network control. Measure survival funnel, median/p90 latency, peak RAM, Claude tokens. **GO** if S(C2) ≥ 0.9·S(C3) ∧ L(C2) ≤ L(C3) ∧ worker tokens = 0. Expected: C3 highest raw survival, C2 within ~10–15 points on pure logic, C1 fails on code quality/context. Pick 14B only if 7B lands in the 75–89 % band.

## E. Risks
- **Tautological tests**: mutation testing catches assert-true and non-sensitive tests reliably; it does *not* catch snapshot-of-current-bug tests that still kill mutants, and equivalent mutants inflate "survived". Hence: killed ≥ 1 **and** a static tautology check **and** review of low-score survivors.
- **Licence traps**: Codestral weights non-production; Qwen2.5-Coder (except 3B) and Devstral Apache-2.0; Muter MIT; Stryker Apache-2.0. Watch AGPL in reporting add-ons.
- **Memory pressure**: 14B + Xcode + simulator is tight; performance collapses on swap. Prefer 7B × N.
- **Thermal throttling**: sustained batches on a laptop M2 Pro sag; back off concurrency when tok/s drops.
- **Model churn**: pin HF revisions and MLX/Ollama versions so survival rates stay comparable.

## Caveats
- M2 Pro tok/s are **estimates** scaled by memory bandwidth from M3/M4 MLX and M2-class llama.cpp measurements (±30 %) — Phase 1 replaces them with `bench.sh` measurements.
- 2026-dated items (Qwen3-Coder-Next, Devstral 2, Apple OS-27 CLI) are partly community-reported. Load-bearing facts (TestGen-LLM/ACH, TestGenEval, TestPilot, Qwen HumanEval+, Devstral SWE-bench, 4,096 context, no per-subagent routing) are from primary sources.

## Sources
- Apple: developer.apple.com/videos/play/wwdc2025/248/ · Foundation Models framework docs · machinelearning.apple.com/research/introducing-apple-foundation-models · developer.apple.com/forums/thread/800238 · infoq.com/news/2026/03/apple-foundation-models-context · artemnovichkov.com/blog/tracking-token-usage-in-foundation-models · blakecrosley.com/blog/foundation-models-python-fm-cli
- Models: arxiv.org/abs/2409.12186 (Qwen2.5-Coder) · huggingface.co/mlx-community · ollama.com/library/qwen2.5-coder:7b · mistral.ai/news (Devstral, Codestral)
- Speed: github.com/ggml-org/llama.cpp/discussions/4167 · markaicode.com/benchmarks/hugging-face-qwen-3-m4-max-throughput-benchmark/
- Test generation: arxiv.org/abs/2402.09171 · arxiv.org/abs/2501.12862 · arxiv.org/abs/2410.00752 · arxiv.org/abs/2302.06527 · arxiv.org/abs/2403.16218 (CoverUp) · arxiv.org/abs/2602.12256 · dl.acm.org/doi/10.1145/3551349.3559555
- Tooling: github.com/muter-mutation-testing/muter · stryker-mutator.io/docs/stryker-js/ · ericsspace.com/articles/scaling-mutation-testing-in-a-large-ios-codebase/
- Orchestration: anthropic.com/engineering/building-effective-agents · code.claude.com/docs/en/sub-agents · code.claude.com/docs/en/skills · github.com/anthropics/claude-code/issues/38698 · code.claude.com/docs/en/llm-gateway-connect
