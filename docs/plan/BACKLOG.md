# Backlog (ideas from later phases noticed early — do not implement out of order)

- Property-based shape (fast-check / swift-check) as a first-class shape.
- Coverage delta as a secondary signal (xccov / istanbul) — TestGen-LLM style, in addition to mutation.
- Reuse Apple Foundation Models for non-code helpers (summarising verdicts for the review batch) once its context grows.
- Ollama backend as alternative to mlx_lm.server (Ollama speaks the Anthropic Messages API since v0.14).
- Kotlin (PIT) and Python (mutmut / cosmic-ray + SlipCover) verifiers — Phase 8.

## Adversarial (LLM-proposed) mutants — after Phase 6
Operator-based mutation (Muter/Stryker) mutates syntax: flip `<` to `<=`, drop a statement. It never mutates the *logic you would actually get wrong* (off-by-one in a range, wrong null-handling branch, unit mismatch). Meta's ACH (arXiv:2501.12862) had an LLM propose realistic faults for a class and required tests to catch them.

Idea: a second local worker gets the function and returns 3–5 plausible buggy variants as diffs. The verifier applies each, runs the candidate test, and counts kills separately (`mutation.llm_killed`). Survival rule stays `killed ≥ 1` on operator mutants; LLM-mutant kills feed the review threshold and the planner's `notes`. Fully on-device, so it costs no Claude tokens — only wall time. Check the proposed bug actually compiles and changes behaviour (run the *existing* suite against it; if nothing fails and the diff is non-empty it is a valid mutant).

## Bandit routing between worker models — Phase 7 or later
When two models are configured (7B, 14B), pick per function using observed survival rate per (model, shape, language) — Thompson sampling over a Beta prior is ~10 lines. Call it "routing" in code; write the reasoning in an ADR. Only worth it if Phase 6 shows the models differ by shape rather than uniformly.

## Noticed in Phase 0
- **No CI workflow exists.** `CLAUDE.md` says `release.yml` enforces that `server.json` and
  `package.json` versions move together, and that CI runs the fast test set. Neither workflow is in the
  repo. Phase 8 owns release; the fast-set CI is worth having well before that.
- **`doctor` does not report the worker's pinned revision.** `GET /v1/models` gives an id, not the HF
  commit. `StatusReport.worker.revision` is therefore always null until `serve` records what it started
  (Phase 1), which is also what makes the revision-pinning check in Phase 7 possible.
- **Tier selection at `serve` time (ADR-0009, decided — Phase 1 implements).** Installed RAM picks the
  tier, free RAM picks the concurrency. `models.json` still carries `max_concurrency_32gb`, which bakes
  one tier into a field name and should become a function of `ram_gb` and free RAM. The `api` fallback
  must be opt-in per machine, never silent.
- **Phase 6 needs a per-tier decision rule.** It produces one verdict for one machine today, and 24 GB —
  the most common tier in the team poll — is measured by nothing at all.
