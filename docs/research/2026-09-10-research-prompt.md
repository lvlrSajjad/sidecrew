# Research prompt — local worker models for an orchestrator–workers coding pipeline

Paste into a fresh session with research enabled. Adjust the machine spec line.

---

I want to build an orchestrator–workers coding pipeline: a frontier model (Claude
Opus, via Claude Code) does the planning, decomposition and final judgment; many
small workers run **locally on my Mac** and execute narrow, verifiable subtasks in
parallel. The first target workload is **writing unit tests for a large existing
project** (Swift and TypeScript first; Python/Kotlin later). Every worker output is
verified mechanically before a human or Claude ever sees it: compile → run →
mutation-test (the test must fail when the code under test is mutated) → score.
Failures go back to the worker once with the error, then escalate to Claude.

Goals, in priority order:
1. **No network** for worker inference — fully on-device, so per-task latency is
   bounded by my hardware, not by an API.
2. **Accuracy on the narrow worker task** at least equal to what Claude produces
   for the same task *after the same verifier gate* — measured as survival rate
   through compile/pass/mutation, not as raw generation quality.
3. **Tokens spent on Claude are only for planning, exemplars and reviewing
   survivors** — workers must not consume Claude tokens.

My machine: [Apple Silicon — fill in chip and unified memory, e.g. M3 Max, 64 GB].
Willing to download models (up to ~20 GB on disk, must fit comfortably in memory
alongside Xcode and a simulator). Licence must permit commercial use.

Research and report on:

**A. Candidate worker models, on-device, September 2026.**
- Apple's Foundation Models framework (macOS 26 on-device ~3B model; tool
  calling; `@Generable` constrained output). What is actually known about its
  coding ability? Any benchmarks, developer reports, or Apple statements on code
  generation? Context window, rate limits, whether it can be driven from a CLI
  or only from an app, and whether "no download, always present" outweighs its
  size for this task.
- Open coding models that run well on Apple Silicon via MLX, llama.cpp/Ollama, or
  Core ML: Qwen2.5-Coder and Qwen3-Coder families (1.5B–32B), DeepSeek-Coder-V2
  Lite, Codestral / Devstral Small, Gemma 3 / Gemma 3n, Phi-4 and Phi-4-mini,
  Llama 3.x / 4 small variants, StarCoder2, Granite Code, and anything new in
  2026 (report what exists at the ~4B, ~7–9B, ~14B and ~30B tiers). For each:
  HumanEval / MBPP / LiveCodeBench / SWE-bench-Verified where available;
  **unit-test-specific** results if any (TestEval, TestGenEval, or similar);
  measured tokens/sec and time-to-first-token on M3/M4-class machines at 4-bit
  and 8-bit; memory footprint; licence; MLX/Ollama availability; context length.
- Whether any small model has a documented advantage at *test generation
  specifically* versus general coding.

**B. What "accuracy" should mean here, and evidence for it.**
- Published work on LLM unit-test generation with verification loops: pass
  rate, mutation score, coverage gains, and how much a compile/run/mutation
  filter closes the gap between small and frontier models (e.g. TestPilot,
  CodaMosa, ChatUniTest, CoverUp, Meta's TestGen-LLM, and 2025–2026 follow-ups).
  The key question: **after a strong mechanical verifier, how much does model
  size still matter?**
- Evidence on few-shot / exemplar-conditioned generation for small models: does
  giving a small model one high-quality exemplar test of the same shape (written
  by the frontier model) bring it close to frontier quality on the analogous
  case?
- Mutation-testing tools I can use as the verifier on Swift (Muter, or
  alternatives) and TypeScript (Stryker), plus coverage tooling, and their
  runtime cost per test.

**C. Architecture and orchestration.**
- How Claude Code subagents work today (custom agents, model selection per
  agent, parallelism, context isolation) and whether a subagent can be pointed
  at a *local* model endpoint (Ollama/MLX OpenAI-compatible server) or whether
  the worker layer must be a separate process Claude Code invokes as a tool/MCP
  server. Cite Anthropic's docs.
- Anthropic's "Building effective agents" orchestrator–workers pattern and any
  guidance on routing tasks to cheaper models.
- A proposed pipeline: Claude reads the module and writes a test plan plus one
  exemplar per test *shape*; workers generate by analogy per function; verifier
  gates; failures retry once locally then escalate; Claude reviews only
  survivors in batch. Include how to cap review cost (mutation score as the
  filter), how to keep workers deterministic (temperature, seeds), and how to
  run N workers in parallel within memory limits.

**D. A go/no-go experiment I can run in a day.**
- Pick one module (~20 functions) in a Swift package and one in a TypeScript
  package. Have Claude write the plan and exemplars. Run three worker
  configurations on the *same* inputs: Apple Foundation Models, the best ~7–9B
  open coder via MLX, and Claude Haiku via Claude Code subagents as the
  network control. Measure per configuration: survival rate through
  compile/pass/mutation, median latency per test, memory, and the number of
  Claude tokens spent overall. Define the go criterion precisely (e.g. local
  survival rate ≥ 90% of Haiku's on the same inputs, median latency ≤ Haiku's
  wall time, zero Claude tokens per worker task).
- Say honestly which configuration you expect to win and why, and what result
  would make me choose a bigger local model over speed or vice versa.

**E. Risks.**
- Small models writing tautological tests (assert true, snapshot-of-current-bug),
  and whether mutation testing catches them reliably.
- Licence traps (research-only weights, AGPL tooling), memory pressure
  alongside Xcode + simulator, thermal throttling on sustained batches, and
  model-update churn.

Deliverable: a report with (a) a ranked shortlist of worker models with the
measured/estimated numbers above and licences, (b) an honest answer to "is
Apple's on-device model the best bet, or should I download something?", with
the conditions under which each is right, (c) the proposed pipeline, (d) the
go/no-go experiment as a step-by-step plan I can hand to Claude Code, (e) all
sources with links, and every number flagged as measured vs estimated.
