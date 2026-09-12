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
- **No CI workflow exists.** ~~Neither workflow is in the repo.~~ Half done before Phase 2:
  `.github/workflows/ci.yml` runs the fast set on macOS for node 20 and 22, and checks that the two
  versions agree and that every shipped model is permissive and pinned. `release.yml` is still Phase 8's.
- **`doctor` does not report the worker's pinned revision.** ~~`GET /v1/models` gives an id, not the HF
  commit.~~ Done in Phase 1: `serve` writes `.sidecrew/worker-<port>.json` with the commit it started,
  and `sidecrew status` reads it. `doctor`'s own worker row still shows only the id — it does not read
  the record — which is a small unification worth doing when Phase 4 builds `sidecrew_status`.
- **Tier selection at `serve` time (ADR-0009).** Done in Phase 1: `tiers` in `models.json` maps installed
  RAM to a tier, `max_concurrency_32gb` is gone, and `serve`'s refusal tells a 16 GB machine it is the
  api tier rather than to close Xcode. The `api` worker itself is not implemented — nothing calls it
  yet, so the fallback is documented and inert rather than silent. Phase 4 owns the client and the
  opt-in flag; `Candidate.worker.kind` already carries the tier.
- **Phase 6 needs a per-tier decision rule.** It produces one verdict for one machine today, and 24 GB —
  the most common tier in the team poll — is measured by nothing at all.

## Noticed in Phase 1
- **Pin the mlx_lm version, not just the model revision.** ADR-0003 rests on `_is_batchable`, which is
  internal to mlx_lm 0.31.3. `bench` records `machine.mlx_lm` in every results file, but nothing warns
  when the installed version moves away from the one the determinism claim was verified against.
  `doctor` is the natural place for a known-good range.
- **`sidecrew models` cannot download.** It reports what is in the HF cache and pins it, but getting the
  weights there is `serve` (which lets mlx_lm fetch them) or the user's own `hf download`. A
  `sidecrew models --download KEY` with resume would have saved this phase real time: the Hugging Face
  client did not resume a stalled transfer on this network — each retry started a fresh `.incomplete` —
  and the weights had to be fetched with `curl -C -` and assembled into the cache by hand.
- **Peak RSS is the worker process only.** ~~It does not record system-wide pressure.~~ `bench` now
  records a swapout delta per model and flags a row past a 100 MB floor (ADR-0011) — this turned out to
  matter, not to be hygiene. Still missing: `memory_pressure` level, swap*ins*, and any *reaction* to the
  signal. Phase 7's back-off owns the reaction; nothing reads the field at runtime today.
- **`bench` writes one file per day and overwrites it.** A second run on the same date replaces the
  first. Fine while runs are deliberate; Phase 6 should either append a run id or refuse to clobber.

## Noticed while reviewing Phase 1, before Phase 2
- **`doctor`'s worker row still does not read the worker record.** `status` learned to (it prints the
  model, revision and pid that `serve` wrote down); `doctor` still only says how many models the endpoint
  offers, which is a catalogue of the Hugging Face cache and not what is loaded. Worth unifying when
  Phase 4 builds `sidecrew_status`, since both will want the same function.
- **`fixtures/ts-fixture` has never had its devDependencies installed.** Its `package.json` names Stryker,
  its checker and its Vitest runner, but there is no lockfile or `node_modules` there, so `npm test` in
  that directory does not run today. Phase 2 hits this on step one — it is that phase's job, but it is
  not the clean start the Phase 0 note implies.
- **`Candidate.usage` has no way to say the counts were not measured.** `complete()` returns
  `usage_estimated` when the server sent no usage block, and nothing in the contract carries it, so a
  Phase 4 that built a `Candidate` from such a response would record zeros as if they were counts. Either
  the contract gains a field (ADR + spec, per CLAUDE.md) or `run_batch` refuses such a response.
- **`bench` writes results relative to the current directory.** Run from anywhere but the repo root it
  creates `experiments/go-no-go/results/` wherever it happens to be standing. Fine for a dev tool, wrong
  for an installed one; a `--out` flag or a repo-root probe would settle it.

## Noticed in Phase 2
- **`sidecrew verify` is still a stub.** `verifyTs` exists and is tested, but nothing on the CLI reaches
  it and no `.sidecrew/runs/<id>/` artefacts are written. Phase 4 owns both; until then the verifier is
  reachable only from tests and from `npm run measure:verifier-ts`.
- **`verifyTs` takes an explicit target because there is no plan to read one from.** `TsTarget` carries
  `sourceFile`, `functionName` and an optional `lineRange` that Phase 5's `TestPlan` will supply. When
  it does, `deriveLineRange` should become the fallback for a stale or missing `line_range` rather than
  the normal path — and a stale range now mutates the *wrong lines*, which raises the stakes on
  `source_sha` and `ValidationReport.stale`.
- **Stryker concurrency is a constant.** `DEFAULT_STRYKER_CONCURRENCY` is 2 because Stryker's own
  default (`cpus - 1`) would put eight vitest processes next to a resident 7B worker. It should come
  from the same memory-aware calculation as worker concurrency in Phase 4, not from two places.
- **Mutation timeouts are charged to the candidate.** A mutant that hangs costs `timeoutMS` (10 s) of
  wall clock each; the `boundary` candidate's three timeouts are why its verdict costs 15 s against a
  7 s median. Worth revisiting with `--ignoreStatic` or a shorter factor once Phase 6 has a real
  distribution.
- **The detector has a known gap, on purpose.** A real assertion no mutant can break —
  `expect(typeof f(x)).toBe("string")` — passes every static rule. Only `killed ≥ 1` stops it. It is in
  ADR-0006's cheap-pass list and in the slow test; the adversarial-mutant idea above is the eventual
  answer.
- **The copy is per candidate.** Cheap on the fixture and on any normal repo, but it is a whole working
  tree each time. If it ever shows up in a profile, the fix is one sandbox per module with the test file
  rewritten between candidates — never a shared Stryker cache (ADR-0004).
