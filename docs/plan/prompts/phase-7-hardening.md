# Phase 7 — Hardening

Read `CLAUDE.md`, `PHASES.md` Phase 7, `experiments/go-no-go/results/REPORT.md` from Phase 6, research §E (risks).

Implement, each with tests and an ADR where a choice was made:

1. **Retry policy**: exactly one local retry, with the verifier's error text (compile error or failing assertion or "killed 0 mutants") appended; then escalate. Make the retry prompt a separate template.
2. **Escalation queue**: `.sidecrew/runs/<id>/escalations.jsonl`; `/sidecrew escalate` hands the batch to Claude (Sonnet by default) with the exemplar and the failure history.
3. **Survivor review batching**: `survivor-reviewer` gets survivors sorted by mutation score ascending; only those below `review_threshold` (default 0.6) plus a random 10 % audit sample are sent. Cap per-batch input tokens.
4. **Memory guard**: before spawning a worker, check free memory (`vm_stat`/`memory_pressure`) ≥ model RAM estimate + 2 GB; otherwise queue. Never swap.
5. **Thermal back-off**: track rolling tok/s; if it drops > 30 % from the bench baseline for 2 minutes, reduce concurrency by one and log it.
6. **Model pinning**: refuse to start a worker whose local HF snapshot hash ≠ `models.json` revision unless `--allow-unpinned`.
7. `--dry-run` for `run_batch` (prompts built, nothing sent).
8. Update the skill and README; bump `plugin.json` version.
