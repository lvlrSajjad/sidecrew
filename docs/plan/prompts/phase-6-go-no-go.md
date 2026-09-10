# Phase 6 — Go/no-go experiment

Read `CLAUDE.md`, `experiments/go-no-go/README.md` (the protocol and the go criterion — do not change them mid-run), research §D.

Run the experiment exactly as written, on both fixtures, three worker configurations with identical `TestPlan` inputs:

- **C1** Apple Foundation Models via a local OpenAI shim (see README for the wrapper options). Expected to underperform; run it anyway for the record. If the 4K context truncates, log it as a failure mode, don't work around it.
- **C2** Qwen2.5-Coder-7B-Instruct-4bit via `sidecrew serve` (and C2b: 14B if it fit in Phase 1).
- **C3** Claude Haiku via the `haiku-worker` agent — the network control. Count its tokens.

Per config record: survival rate (compile / pass / mutation-kill / non-tautological, as a funnel), median and p90 latency per candidate, peak RAM, Claude tokens (planning shared; worker tokens must be 0 for C1/C2), retries used, escalations.

Write `experiments/go-no-go/results/go-no-go-<date>.json` and `experiments/go-no-go/results/REPORT.md` (one page): the funnel table, the decision against the criterion, and honest notes on what surprised you. Apply the decision rule from the README: go / go-with-14B / no-go, and say which result should make us pick the bigger model over speed.

Do not tune prompts or the verifier during the run. If you find a bug that invalidates results, fix it, note it, and rerun all configs.
