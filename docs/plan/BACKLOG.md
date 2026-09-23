# Backlog (ideas from later phases noticed early — do not implement out of order)

- Property-based shape (fast-check / swift-check) as a first-class shape.
- Coverage delta as a secondary signal (xccov / istanbul) — TestGen-LLM style, in addition to mutation.
- Reuse Apple Foundation Models for non-code helpers (summarising verdicts for the review batch) once its context grows.
- Ollama backend as alternative to mlx_lm.server (Ollama speaks the Anthropic Messages API since v0.14).
- Kotlin (PIT) and Python (mutmut / cosmic-ray + SlipCover) verifiers — Phase 8.

## Noticed while building Phase 10 — all Phase 12's, and all deliberate
Workload #2a ships as a CLI and nothing else, because each of these needs something Phase 12 builds
first. Listed so they are decisions rather than omissions.

- **A `sidecrew_fix` MCP tool, and the skill wiring for it.** A tool Claude can call is only useful once
  something writes `ChangePlan`s for it to call with, and that is the Phase 12 planner. Adding it now
  would ship a tool that goes stale before anyone uses it. `claude/skills/sidecrew/` gains its #2a
  section in the same phase.
- **An escalation queue for #2a.** `sidecrew escalate` joins `escalations.jsonl` back to the
  `WorkerTask`s on disk, and a `ChangeTask` is not one; `Escalation.stage_reached` is workload #1's
  `Stage` and does not carry `confinement` or `tests`. Widening both is a contract change, and Phase 12
  is where it pays for itself, because the correction round reads verdicts anyway. Until then every
  verdict and diff is written as it is produced, so a run that dies still has the record (ADR-0023) —
  what is missing is the join, not the data.
- **`ChangeVerdict` has no coverage field.** Phase 11 reports the fraction of survivors whose changed
  lines no test that ran executed, as a number beside the rate (ADR-0048's first named hole). If that
  fraction turns out to matter, putting it *in the verdict* is a contract change with an ADR, not a
  field added quietly — and it should be argued from the number rather than before it.
- **Memoise task → candidate by content hash.** Already in *The edge ideas* below as item 3, and #2a is
  where it bites first: a step that re-runs after a plan edit regenerates files that did not change.

## The edge ideas (16 Sep 2026) — six ways to spend local compute so Opus spends less
The owner's goal, stated as the measure for all of these: *use the edge computing capacity to improve
what happens when users use Claude Opus on its own — fewer tokens, faster, more precise.* Each entry says
which of the three it serves, what the machine checks, and which phase owns it. Ranked by how well it
fits the repo's one rule: a machine has to be able to check the result.

1. **Local models read the codebase so Opus does not have to.** *Tokens, precision.* Planning cost
   120–145k Opus tokens for 8–14 units and most of it was Opus reading code. A local model does the
   finding — "where is the type that owns this field" → file paths, symbol names, line ranges — and the
   check is mechanical: the symbol exists at that location or it does not (`tsc`, the TypeScript AST, or
   a grep confirms). Opus reads only confirmed locations. Serves every Opus session, not only a workload
   run, and the Phase 12 planner needs it anyway to group files by coupling. ~~**Owner: Phase 12**~~ —
   **Phase 12 did not build it**; the planner reads the codebase itself (`Read, Grep, Glob`).
   **Reassigned to Phase 13b** (owner, 18 Sep 2026). Measure: Opus planning tokens per task with and
   without it, on the same plan; and the false-location rate the checker catches. **§2.1 is its go/no-go,
   not just its baseline** — if planning is cheap per task there is nothing here to save — and its gate
   needs an ADR first, because confirming a symbol exists proves existence and not *relevance*.
2. **Fine-tune the 7B on its own survivors.** *Precision, then tokens.* Every survivor is a verified
   task→output pair from the user's own codebase at zero labelling cost. MLX supports LoRA; the weights
   are Apache-2.0; the gate stays in front of the result, so whatever it learns still has to compile,
   pass and stay confined. Survival rate should climb per repository. **Not before Phase 11 has a
   baseline**, or there is nothing to measure the gain against; a pinned adapter is a configuration and
   gets its own run. Risk to write down first: an adapter trained on survivors of a soft gate learns the
   softness — so only survivors from after ADR-0037 qualify, and the tautology rule is part of the gate.
   After publish (Phase 17).
3. **Memoise task → candidate by content hash.** *Faster, honestly.* Runs are deterministic (ADR-0003):
   same rendered prompt, seed, model and revision give the same bytes. A cache keyed on those makes a
   re-run after an unrelated change cost nothing and a re-plan that keeps most tasks cost only the new
   ones. Local tier only — the api tier has no seed. Small enough that Phase 10 may take it if it falls
   out of the step runner (step N+1 re-runs nothing from step N); ~~otherwise Phase 12~~ — neither phase
   took it. **Reassigned to Phase 13b** (owner, 18 Sep 2026). Measure: wall time of a second identical
   run. **The claim above that a re-run "costs nothing" is wrong against Phase 11's numbers**: generation
   is 13.5 s of a ~275 s candidate and the gate is 95 % of it, so memoising generation saves about 5 %.
   The version worth having caches *verdicts*, and that needs an ADR on what goes in the key — a verdict
   depends on the candidate **and** the baseline **and** the project's state, and a key that misses one
   serves a stale pass, which is ADR-0037's failure mode.
4. **Unattended mode as the product shape.** *Speed as the user feels it, and tokens.* Faster than Opus
   per unit is a claim the vision refuses; the win is that the work happens while Opus is not there. Opus
   files a stepped plan, walks away, and reads a step report. Most of it exists; missing are a run that
   survives a closed lid (resume from `.sidecrew/runs/<id>/`, which is already one file per task) and a
   report that says what to read first. ~~**Owner: Phase 12**~~ — **Phase 12 did not build it.**
   **Reassigned to Phase 13b** (owner, 18 Sep 2026), and it is the **best of the four**: most of it
   exists, it is the product shape rather than an optimisation of it, and its measure is the only
   unambiguous one here. Measure: Opus tokens spent between filing the plan and reading the report — the
   target is zero.
5. **Pool workers across a team's machines.** *The literal edge-computing version.* The worker is reached
   over HTTP on localhost already; letting one Mac's idle worker serve another's run is a configurable
   URL plus the pinned-revision check `serve` already does. Answers "my laptop has 16 GB" without Haiku.
   Needs an ADR on trust between machines and on determinism across two different Macs before any of it.
   After publish (Phase 17).
6. **Two-model agreement as a review signal.** *Precision.* Run the 7B and the 14B on the same task;
   where both survive and differ, route to the audit sample (ADR-0024). Wall time only, no Opus tokens.
   The cheaper cousin of bandit routing (below); only worth it if Phase 11 shows the two models disagree
   on real projects. ~~After publish (Phase 17).~~ **Moved to Phase 13b** (owner, 18 Sep 2026), ahead of
   publish. **Its stated precondition is untested**: Phase 11 never ran C2b, because §4.3 only called for
   the 14B if C2 landed in the 0.75–0.90 band and it did not — so nothing is known about whether the two
   models disagree. At `S(C2) = 12/12` and `11/12` there is barely room for disagreement to show, and
   running both doubles wall clock on a machine that hosts either two 7Bs or one 14B, not both
   (CLAUDE.md #5). **Measure the disagreement before building anything that consumes it.**

**Not on the list, on purpose:** more agents. The design has the two roles that pay for themselves — one
planner, many workers, a gate between. A third earns its place only by removing Opus tokens, and item 1
is that agent.

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
  yet, so the fallback is documented and inert rather than silent. ~~Phase 4 owns the client and the
  opt-in flag~~ — Phase 13 owns the client (ADR-0045), and there is no opt-in flag: the tier is decided by
  installed RAM. `Candidate.worker.kind` already carries the tier.
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
  matter, not to be hygiene. Phase 7 added the two reactions: `kern.memorystatus_vm_pressure_level` gates
  `serve` and `bench` (ADR-0026), and decode rate drives the thermal back-off (ADR-0025). Still missing:
  swap*ins* as a signal, and `PoolRss` saying "the machine was swapping, do not trust this number".
- **`bench` writes one file per day and overwrites it.** ~~A second run on the same date replaces the
  first unless `--tag` is passed.~~ Done before Phase 6: `refuseToClobber` makes an existing results file
  an error naming the flag, so a forgotten `--tag` costs a rerun instead of a measurement. `--tag` is
  still how two runs sit beside each other; it is no longer something to remember.

## Noticed while reviewing Phase 1, before Phase 2
- **`doctor`'s worker row still does not read the worker record.** ~~`doctor` only says how many models
  the endpoint offers, which is a catalogue of the Hugging Face cache and not what is loaded.~~ Phase 4
  unified it where it mattered: `src/status.ts` joins `doctor`'s checks with the worker record, so
  `sidecrew_status` reports the loaded model and its pinned revision. `doctor`'s own **rendered** row
  still shows only the endpoint's catalogue — one line, and it would want `doctor` to read the record
  too.
- **`fixtures/ts-fixture` has never had its devDependencies installed.** Its `package.json` names Stryker,
  its checker and its Vitest runner, but there is no lockfile or `node_modules` there, so `npm test` in
  that directory does not run today. Phase 2 hits this on step one — it is that phase's job, but it is
  not the clean start the Phase 0 note implies.
- **`Candidate.usage` has no way to say the counts were not measured.** ~~A Phase 4 that built a
  `Candidate` from such a response would record zeros as if they were counts.~~ Settled in Phase 4 by
  the second option: `generate` refuses a response with `usage_estimated`, naming the server, rather
  than widening the contract for a case only a non-mlx_lm server produces.
- **`bench` writes results relative to the current directory.** Run from anywhere but the repo root it
  creates `experiments/go-no-go/results/` wherever it happens to be standing. Fine for a dev tool, wrong
  for an installed one; a `--out` flag or a repo-root probe would settle it.

## Noticed in Phase 2
- **`sidecrew verify` is still a stub.** ~~Nothing on the CLI reaches the verifier and no
  `.sidecrew/runs/<id>/` artefacts are written.~~ Done in Phase 4: `sidecrew verify`, `sidecrew run`,
  `sidecrew generate`, and one JSON per task, candidate and verdict under the run id.
- **`verifyTs` takes an explicit target because there is no plan to read one from.** `TsTarget` carries
  `sourceFile`, `functionName` and an optional `lineRange` that Phase 5's `TestPlan` will supply. When
  it does, `deriveLineRange` should become the fallback for a stale or missing `line_range` rather than
  the normal path — and a stale range now mutates the *wrong lines*, which raises the stakes on
  `source_sha` and `ValidationReport.stale`.
- **Stryker concurrency is a constant.** ~~It should come from the same memory-aware calculation as
  worker concurrency, not from two places.~~ Done in Phase 4: `planConcurrency` is the one calculation
  and `DEFAULT_STRYKER_CONCURRENCY` is an alias for its default.
- **Mutation timeouts are charged to the candidate.** A mutant that hangs costs `timeoutMS` (10 s) of
  wall clock each; the `boundary` candidate's three timeouts are why its verdict costs 15 s against a
  7 s median. Worth revisiting with `--ignoreStatic` or a shorter factor once Phase 6 has a real
  distribution.
- **The detector has a known gap, on purpose.** A real assertion no mutant can break —
  `expect(typeof f(x)).toBe("string")` — passes every static rule. Only `killed ≥ 1` stops it. It is in
  ADR-0006's cheap-pass list and in the slow test; the adversarial-mutant idea above is the eventual
  answer.
- **`doctor` probes the toolchain of the current directory, not of the project being verified.**
  ~~It reports `stryker MISSING` on this repo while the verifier runs Stryker in
  `fixtures/ts-fixture`, which has it.~~ Done in Phase 4: `sidecrew doctor --project DIR` and
  `sidecrew_status`'s `project` both report `tsc`, `vitest` and `stryker` from that package's
  `node_modules`. Still open, from the Phase 3 note: the row does not report the *Muter version*, and
  ADR-0005 is a fact about muter 16.
- **The copy is per candidate.** Cheap on the fixture and on any normal repo, but it is a whole working
  tree each time. If it ever shows up in a profile, the fix is one sandbox per module with the test file
  rewritten between candidates — never a shared Stryker cache (ADR-0004).

## Noticed in Phase 3
- **The Swift `killed` count is a lower bound, and the fix is one more grep.** Swift Testing runs a
  suite in one process, so a mutant that crashes takes down tests that had already recorded failures —
  and `sidecrew-test.sh` greps for the *completed-run* line, which never gets printed. Gating instead
  on `recorded an issue`, which Swift Testing prints as each failure happens, would recover those kills
  without weakening what a kill means. Deliberately not done in Phase 3: it changes the number the
  whole project rests on, and it deserves its own before/after measurement rather than a late edit to a
  phase that had already measured itself (ADR-0005).
- **`DEFAULT_MUTANT_TIMEOUT_S` is a constant, and an expensive one.** 60 s per mutant turns the
  `chunk` candidate's verdict from ~40 s into ~95 s, because one mutant of its guard loops for ever.
  It should come from the baseline run the pass stage already measured — Stryker's `timeoutFactor`
  shape — rather than from a number picked to be safe on one fixture.
- **Mutation cost is whole-file on Swift and there is no flag that changes it.** ADR-0013 bought
  TypeScript 3.3× *and* a usable score; Muter has no `--mutate file:from-to`, so Swift gets the score
  only. The lever that would work is splitting the source copy in the sandbox so only the function
  under test is present — invasive, and worth doing only if Phase 6 says the wall clock is what stops
  Swift being viable.
- **Muter's four operators are thin.** `RelationalOperatorReplacement`, `RemoveSideEffects`,
  `ChangeLogicalConnector`, `SwapTernary` — against Stryker's several dozen. Some perfectly ordinary
  Swift functions have no mutants at all, so `killed ≥ 1` cannot be reached and the verdict has to say
  so rather than blame the test. Phase 5's planner should prefer functions that *can* be mutated, and
  the LLM-proposed-mutants idea in ADR-0006 is worth more on Swift than on TypeScript for this reason.
- **The sandbox copies the package per candidate and the build is cold every time.** A Swift verdict is
  dominated by two from-scratch builds — ours in `<sandbox>-build`, and Muter's in `<sandbox>_mutated`.
  Neither can be shared between candidates without risking exactly the contamination ADR-0004 is about,
  but a per-*module* sandbox with the test file rewritten between candidates would pay for itself here
  far faster than it would on TypeScript.
- **`doctor` still answers about the wrong project, and Swift makes it worse.** It already reported
  `stryker missing` on this repo while the verifier ran Stryker in `fixtures/ts-fixture`. The Swift
  verifier adds `muter` and `swift` to the same confusion, and the Muter *version* now matters to the
  verdict (ADR-0005 is a fact about muter 16), so `doctor --project` should report the version it found
  and not merely that it found one.
- **Nothing checks that the two verifiers agree.** `verifyTs` and `verifySwift` return the same
  `Verdict` shape and are asserted separately. A shared test that runs the same *conceptual* candidate
  through both and compares the verdict field by field would catch a divergence that two green suites
  will not.
- ~~**The skill's reference docs are not covered by anything.**~~ Done in Phase 7:
  `test/skill-docs.test.ts` greps `references/verifier.md` for the survival rule, the score formula, the
  stage names, the conditions that skip the retry and the review thresholds, and checks that SKILL.md
  names no MCP tool the server does not register. It took three phases of noticing the same thing by
  reading before it was written.

## Noticed in Phase 4
- ~~**One failed task fails the whole batch.**~~ Done in Phase 7, and exactly the smallest honest
  version this note proposed: a per-task catch records the exception as that task's last attempt,
  escalates it and keeps going, while a `VerifierSetupError` or a `PlanError` still stops everything —
  those are true of every remaining task too. It is only honest because ADR-0023's queue is written as
  the run goes rather than at the end.
- **A slot is a worker's footprint used as a proxy for a verifier's.** `planConcurrency` divides free
  RAM by `ram_gb + 2`, which is the only per-process memory figure this project has measured — and a
  Stryker run forking vitest, or `swift build`, has never been put on a scale. It is deliberately
  conservative, so the error is in the safe direction, but on a 64 GB machine it is leaving parallelism
  on the table. Measuring the verifier's peak RSS is a `measure:` script and an afternoon.
- ~~**Nothing tests `claude/skills/`.**~~ Done in Phase 7 — `test/skill-docs.test.ts`, and it asserts
  exactly the thing this note names: that `verifier.md` says a tautology **is** retried. Original note:
  Phase 3 noticed it; Phase 4 found *two* more stale lines the same way, by reading. `verifier.md` said a
  tautology gets no retry, which contradicts ADR-0012 and would have had an orchestrator escalating
  candidates the retry can actually fix.
- **Multi-worker concurrency has never actually run.** The pool, the round-robin and
  `workers × verifier ≤ slots` are all tested, but every real run so far has had one worker up, so
  `concurrency: 2` is arithmetic rather than a measurement. `sidecrew serve --port 8001` plus
  `SIDECREW_PORTS=8000,8001` is the experiment, and Phase 6 needs the number anyway.
- **`PoolRss` samples only workers `serve` started.** A worker someone else launched has no pid on
  disk and is silently not counted, so `peak_rss_mb` would understate a mixed pool. `BatchResult` has
  no way to say "partly measured", which is why it is silent rather than wrong — but a run that could
  not measure what it claims to measure should probably say so.
- **The `api` tier is still inert, and now it is load-bearing that it is** — **promoted to Phase 13 by
  ADR-0045 (16 Sep 2026): Haiku, pinned by model id, before publish.** `runBatch` hard-codes
  `worker_kind: "local"` and refuses to start without a local worker. ADR-0009 says 16 GB machines fall
  back to the Anthropic API; nothing implements that path, so on those machines `sidecrew run` simply
  does not run. Phase 6 measured the fallback as configuration C3. **Phase 7 did not build the client**:
  it is a worker implementation rather than hardening, and Phase 6's note stands that C3's token figures
  are upper bounds from a subagent harness and must not be quoted as what that tier would cost.
- ~~**A retry reuses the same seed.**~~ Done in Phase 7 (ADR-0022): `runBatch` compares the two
  rendered prompts and escalates instead of spending the retry when they are identical. The note was
  right about the mechanism and understated the cost — it is 7 s of Stryker on TypeScript and 28 s on
  Swift for a verdict we already have.

## Noticed in Phase 5
- **`meta.planner_tokens` has no honest answer for a multi-module planning pass.** Four plans were
  written in one pass over the whole fixture — the modules were read together, the shapes chosen
  together — so the cost is genuinely not separable per plan. The number recorded is the measured window
  divided by four: an **allocation**, chosen because the only consumer sums it
  (`BatchResult.stats.claude_tokens.planning`, one per run) and an even split makes that sum correct. A
  contract that could say "this cost was shared with these other plans" would not need the allocation.
- **`validatePlan` verifies exemplars serially.** Four TypeScript shapes is ~40 s; a six-shape Swift plan
  would be several minutes of one core. They are independent and `planConcurrency` already knows how many
  may run at once.
- **`stateful_sequence` and `property_like` are in the taxonomy and unexercised.** The TS fixture's only
  stateful module has no plan (ADR-0016) and nothing in it has a worth-asserting invariant that is not
  also a tautology. The Swift fixture has `Machine.swift` and Muter mutates it differently; Phase 6
  should either cover both shapes there or record that the taxonomy has two untested members.
- **The ablation is one worker, one seed, one machine.** Three variants × 20 tasks at temperature 0 is a
  single sample per cell, so a two-point difference between variants is not a result. The gaps it did
  find are large enough not to care; a future run that compares closer variants needs several seeds and
  a statement of variance, which is a different experiment from this one.
- **`sidecrew plan` cannot write a plan, only check one.** Writing one is Opus's job by design, but that
  means the CLI's `plan` verb does the opposite of what its name suggests to anyone who has not read
  `claude/agents/test-planner.md`. A `--init` that emits a skeleton with ranges and shas filled in would
  be a fair amount of the planner's mechanical work, and none of its judgement.
- **The ablation that would actually test research §B.** ADR-0017 found the exemplar worth nothing over
  one sentence on a fixture of 14 small pure functions. The claim it was meant to confirm is about code
  with mocks, setup and lifecycle — where a worker has to copy structure it cannot derive from a
  signature. That experiment needs a second fixture module with those things in it, several seeds, and a
  statement of variance. Until it exists, the exemplar is kept for survivor quality and token cost, which
  are measured, rather than for survival rate, which is not.
- **Should the shipped prompt also name the framework import?** `bare+import` scored 16/20 on one
  sentence. With the exemplar present everything compiled anyway, so adding it is unmeasured — and an
  unmeasured edit to `src/prompts/worker.md` now fails `test/prompt.test.ts` by design. If it is added,
  it is a fourth arm of the ablation, not a tweak.
- **Both fixtures' `planner_tokens` are upper bounds.** Each is the measured token window of the session
  stretch that planned that fixture, split evenly across its plans — and those stretches also contain the
  planner's own tooling and several ADRs. The sum is right and the per-plan number is an allocation, so
  the figure is comparable between go/no-go configurations (identical for all of them) and not between
  the two fixtures. The fix is one clean re-plan of one module with `planner-tokens.mjs --mark` around it
  and nothing else in the window; it would cost one session and would make the one Claude-side number in
  a `BatchResult` mean what it says.

## From Phase 6 (the go/no-go)

- ~~**Name the fourth decision cell**~~ — done: CONDITIONAL GO with a mutation-score guard (ADR-0020),
  amended into the protocol below the frozen rule, and applied by `--report`. Original note: TypeScript landed at 0.85 of Haiku with a 14B that
  scored the identical 0.85, and the frozen rule has no verdict for "in the 75–89 % band, and the
  bigger model does not help". Deciding it needs evidence this phase does not have: C2's TypeScript
  survivors score a median mutation **1.00** against C3's **0.917**, so survival rate alone cannot say
  whether 17 sharper tests beat 20 blunter ones. ADR-0006's review routing is where the answer lands.
- ~~**Render the enclosing type in the Swift worker prompt.**~~ — done and measured (ADR-0021): Swift
  4 → 9 of 18 through the full pipeline, TypeScript unchanged, conditional on the signature being
  qualified rather than on the language. Original note: `TestPlan.functions[].signature` already
  carries `Numbers.percentChange(from:to:)`; `src/prompts/worker.md` never renders it, and the 7B spent
  most of its Swift failures inventing a type (`SwiftFixture.percentChange`, `Statistics`, `Order`).
  One line, with an ablation behind it — the Phase 5 lesson (ADR-0017) is that a prompt change with an
  obvious explanation still has to be measured, and that the *bare+import* row is the one that stops a
  fix being credited with more than it did.
- ~~**`generate`'s usage guard does not catch zeros**~~ — done: non-empty output cannot report zero
  completion tokens (ADR-0019), with a fake-worker case for it. Original note: It refuses a completion with no usage
  block, which is the honest failure; a server that reports `{prompt_tokens: 0, completion_tokens: 0}`
  for a 600-character answer satisfies it and puts a fiction into `Candidate.usage`. Measured on the
  Apple shim. The fix is a floor, not a new contract: output that is not empty cannot have cost zero
  completion tokens.
- **Peak worker RSS is not measurable with `ps` under memory pressure**, confirmed from the opposite
  direction to ADR-0011: 205 MB reported for a 7B whose weights are 4.0 GB, while the machine held
  6.6–9.5 GB of swap. `PoolRss` should either say "not trustworthy, the machine was swapping" or read a
  footprint that survives compression. Until then no phase should quote a peak-RAM number taken on a
  loaded machine.
- **C3 through a subagent cannot report prompt/completion tokens separately.** The Agent tool returns
  one `subagent_tokens` figure per invocation, ~48 k of which is the subagent's own system prompt and
  tool definitions. If the `api` tier of ADR-0009 ever ships, its accounting should come from the API
  response, and this phase's 957 k / 1.12 M should not be quoted as what that tier would cost.

## From Phase 7 (hardening)

- **The retry prompt has never been measured.** ADR-0022 split it out of `worker.md` precisely so that it
  could be, and then did not — a retry ablation is its own experiment: the same tasks, the same seed, two
  retry wordings, and the number that matters is survival *among the tasks that reached a retry*, which on
  the TypeScript fixture is three. Three tasks is not a result, so this needs the Swift fixture (fourteen
  retries in Phase 6's C2) or a fixture built to fail first attempts on purpose.
- ~~**The thermal guard has never fired on a real run.**~~ Half closed by `npm run measure:thermal`
  (`experiments/thermal/`): 22 minutes of continuous generation on mains held the baseline exactly, so
  research §E's sag did not reproduce and the guard correctly did nothing. **Still open, and now
  specific:**
  - **On battery is the condition that was not tested**, and it is where macOS throttles hardest. The
    soak cannot arrange it; somebody has to unplug the machine and run `npm run measure:thermal --
    --tag battery`. Everything the run says is conditional on mains until that exists.
  - **Nothing downstream of a back-off has ever executed.** No back-off was produced, so the runner
    standing down and a batch finishing at lower concurrency are untested. They cannot be tested on CI:
    `readMemory` returns `null` there, `planConcurrency` returns 1, and a guard with one slot has nothing
    to retire. The options are a fake memory reader injected into `runBatch` (test-only surface in
    production code, which this repo has avoided so far) or a slow-worker integration test gated behind
    `SIDECREW_SLOW=1` on a machine with room for two workers. Worth doing before anyone relies on the
    back-off; not worth a fragile CI test.
  - **One dip, and it recovered.** A 90-second drop to 25.8 tok/s at minute four with four requests below
    the floor, then seventeen clean minutes. Contention, not heat — but it is the only real evidence about
    what this machine's decode rate does under load, and one dip is not a distribution.
- **No recovery from a back-off, on purpose, and it may be the wrong call.** ADR-0025's argument is that a
  guard which oscillates costs more in restarted work than the slot is worth. That argument has no
  measurement behind it. A long run that sags once during an unrelated build and then runs cool for forty
  minutes finishes at half concurrency for no reason, and nothing says so afterwards except
  `throttle.json`.
- **The Swift review threshold of 1.0 is a rule derived from a distribution, not a tuned number.** It
  follows from "nine of fifteen survivable functions have exactly one mutant", which is a fact about
  `fixtures/swift-fixture`. A real Swift package with larger functions would have larger denominators and
  1.0 would route almost everything. The threshold should probably be a function of the *denominator* —
  "left a mutant alive when it had fewer than N" — and that needs a mutant-count distribution from a real
  package rather than from a fixture built to be small.
- **The audit fraction is 10 % because the research said 10 %.** Nothing has measured what it catches. The
  experiment is cheap and worth doing once there are enough reviewed survivors to have a base rate: how
  often does an audited survivor get rejected, against a below-threshold one? If the two rates are equal
  the threshold is not routing anything.
- **`estimateTokens` is characters ÷ 4, and the review cap is applied to it.** Fine for deciding how many
  test files fit in a batch, and wrong by enough to matter if the cap is ever tightened. The real count is
  available from the model that reads the batch, after the fact; nothing records it.
- **`sidecrew escalate` and `sidecrew review` assemble and stop.** They cannot apply what Claude decides,
  so the last step of both — writing the accepted test into the project — is still the skill's, by hand,
  with `references/conventions.md` as the only thing keeping the naming consistent. A `sidecrew apply`
  taking the reviewer's JSON would close that loop and would need a very careful answer to "what happens
  when the file already exists".
- **Nothing checks that `escalations.jsonl` and `result.json` agree except a slow test.** The fast suite
  builds a run whose every task throws, which exercises the append path but not the verdict path. The
  disagreement worth catching is a task that escalated with a *verdict* and landed differently in the two
  files, and that needs the toolchain.

## From Phase 9 (runners)

- **Whether `jest-expo` survives Stryker is the open question, not whether Jest does.** The fixture is
  plain ts-jest. A React Native project brings a preset, `setupFiles`, native module mocks and a wide
  `transformIgnorePatterns`, any of which could make Stryker's sandbox unable to run a single test.
  `experiments/real-world/README.md` is the protocol; until it has a result, "sidecrew supports React
  Native" is not a sentence anyone should write.
- **Nest is untried entirely.** It defaults to Jest with `.spec.ts` under `src/`, which
  `--runTestsByPath` should handle, but Nest services are classes with constructor injection — so the
  worker has to construct a subject with mocked dependencies, which is exactly the code shape ADR-0017
  says the exemplar has never been measured on.
- **`testDirFor` still guesses.** It picks the first of `test/ tests/ __tests__/ src/__tests__/` that
  exists and falls back to `test/`. Harmless now that `--runTestsByPath` means the candidate does not
  have to match `testMatch`, but on a project whose convention is co-located `foo.test.ts` next to
  `foo.ts` it writes the test somewhere nobody keeps tests, and `/sidecrew review` then has to move it.
  The plan should be able to say where tests go.
- **The compile stage is the cost, and it is unmeasured on a real project.** `tsc --noEmit -p tsconfig.json`
  runs over the *whole project* per candidate: 0.44 s on the fixture, **9.8 s** on one workspace of
  project-c. `tsc --incremental` with the build info inside the sandbox, or type-checking only the
  candidate and its imports, would both work and both need measuring before either is chosen.
- **Two type checks might be one too many.** The compile stage runs `tsc`, and Stryker's
  `checkers: ["typescript"]` type-checks every mutant. On a 9.8 s project the second is the expensive one,
  and ADR-0016 is the reason it exists — dropping it would put uncompilable mutants back in the
  denominator. Worth measuring what it actually costs before defending it further.
- **Vitest and jest both report "missing" in `doctor` on a project that uses the other.** Correct, and it
  reads like two problems. The row could name the project's own runner and report only that one.

## From the first real-world trial (project-c, 15 Sep 2026)

- **Stryker's instrumenter cannot parse a project whose Babel config loads
  `@babel/plugin-proposal-decorators`.** `ERR_REQUIRE_ESM`: Stryker's nested `@babel/core` `require()`s
  the plugin and resolves an ESM-only build. This is the structural blocker, it stopped the trial, and it
  is **not worked around**. Any React Native project using MobX-State-Tree — or NestJS, whose decorators
  are the whole framework — will hit it. Three possible directions, none measured: pin Stryker's babel
  dependency range; have the verifier write a `babelrc`-neutralising Stryker config into the sandbox; or
  strip the project's babel config from the sandbox copy, which changes what the mutants mean. The middle
  one means sidecrew starts owning somebody else's Babel setup, which is a decision, not a patch.
- **No mutant-density denominator exists for any real project.** The probe could not run (fixed now), so
  the trial's rates are over candidates rather than over mutable functions. `capitalizeFirstLetter` in the
  module it tested is `return name` — exactly the ADR-0016 zero-mutant case — and went uncounted. The next
  trial should run step 2 first and report the four-way split.
- **`doctor` reports `node ok` while the installed Stryker refuses to start on that node.** Stryker 10
  requires node ≥ 22; sidecrew's `engines` says ≥ 20; the trial had to switch node mid-run. The node row
  should check against what the project's own Stryker needs, not only against sidecrew's floor.
- **Run artefacts and worker state share one directory and should not.** `.sidecrew/runs/` belongs to the
  project being tested; `worker-<port>.json` belongs to the machine. Phase 7 put both under one resolved
  path, which is coherent but means a run against somebody else's repo can write its runs into sidecrew's
  own `.sidecrew`. Splitting them is a contract-shaped decision.
- **A project whose tests are `*.spec.ts` cannot be mutated, and it is predicted rather than observed.**
  sidecrew writes its candidate as `test/<task_id>.test.ts`. The pass stage is fine — `--runTestsByPath`
  takes the path literally — but Stryker's jest-runner runs jest under the *project's* config, and a
  `testRegex` of `.*\.spec\.ts$` (NestJS's default, and what `project-a` uses) will not match it. Jest
  finds nothing, every mutant is `NoCoverage`, `killed` is 0, and nothing can ever survive while looking
  exactly like a test that covers nothing. Same hazard ADR-0028 named when it turned
  `enableFindRelatedTests` off, through a different door. The sandbox holds exactly one test file, so the
  fix is for the generated Stryker config to override jest's discovery and name it — but that should wait
  for a run that confirms the prediction, per `experiments/recon/project-a-and-b.md`.
- **Exemplars placed inside a workspace join that project's test suite.** `jest-expo` matches any
  `*.test.ts` anywhere, so a plan's exemplars — which import as if they were at `test/` — become failing
  members of the host project's suite. Harmless on a throwaway branch; not harmless on a real one. The
  plan should be able to say where exemplars live, or they should live outside the project entirely.
- **The tool has never been run by anyone who did not write it, until now, and four defects fell out of
  one afternoon.** All four were rules already written down in this repo and not applied in one of the
  places they applied to. That ratio is the argument for the next trial being on a third machine.

## From the second real-world trial (project-b, 15 Sep 2026)

- **Should the generated Stryker config name its plugins explicitly?** Under pnpm, Stryker loads none of
  them — core cannot resolve its peers from `.pnpm/`, and hoisting them did not help. An explicit
  `plugins: ["@stryker-mutator/jest-runner", "@stryker-mutator/typescript-checker"]` would probably fix
  it. It is a verifier change and should be made with a measurement, not on that reasoning. Until then
  **sidecrew does not work on pnpm projects**, which is most of the modern React ecosystem.
- **`doctor` reports `stryker 10.0.0` as `ok` when Stryker 10 cannot instrument anything** (ADR-0030).
  The version row should know the versions that are known-broken, the way the mlx_lm note in Phase 1's
  backlog wants a known-good range. Both fixtures now pin `^8` with the reason in `package.json`.
- **Nothing lets a plan or a call site set stage environment**, and a 577k-line project needs
  `NODE_OPTIONS=--max-old-space-size=8192` for its typecheck — its own script says so. sidecrew gives
  `tsc` node's default heap, it OOMs at ~52 s, and the verdict is indistinguishable from a candidate that
  does not compile. `exec.run` already merges the parent environment, so the caller can work around it;
  nothing reports that it is needed. The fix is contract-shaped: `TestPlan` or `TsTarget` carrying stage
  env.
- **The compile stage is only as strong as the project's tsconfig `include`.** project-b's is
  `["src", …]`; `testDirFor` falls back to `test/`, which that excludes. `tsc --noEmit -p tsconfig.json`
  would then type-check the project and not the candidate — and with `diagnostics: false` in their
  ts-jest, a type-broken candidate would pass compile *and* pass. Predicted before the run and never
  reached, so it is still a prediction. It makes the "where does the candidate go" question (already in
  BACKLOG from the mobile trial) a soundness issue rather than a tidiness one.
- **Two real projects, zero candidates.** Neither trial has produced a single piece of evidence about
  whether a local model writes good tests on real code. Every finding so far is about memory limits,
  module resolution and dependency layout. The headline claim still rests entirely on two fixtures
  written by the author. A third trial should pick a project on **npm or yarn with Stryker 8** — the
  configuration both fixtures already prove works — so that the harness gets out of its own way and the
  question can actually be asked.

## From the third real-world trial (project-a, 15 Sep 2026)

- ~~**The sandbox's symlinked `node_modules` makes `tsc` fail on the project's own code.**~~ Fixed in
  ADR-0034 by cloning on TS2883 rather than always. **`--preserveSymlinks` remains the cheaper fix** — it
  costs nothing where the clone costs a compile — and was not chosen because it changes module resolution
  for every project, including pnpm ones that depend on symlink resolution. Worth measuring. Original
  note: **The sandbox's symlinked `node_modules` makes `tsc` fail on the project's own code.** `TS2883`: an
  inferred type cannot be named without a relative path climbing out of `/var/folders/…` and across the
  filesystem. The trial's control is decisive — symlink fails at 15.3 s, a real APFS clone passes at
  17.7 s — but the remedy is a trade nobody has measured: clone per candidate (~18 s each), clone once per
  run and share it read-only, or pass `--preserveSymlinks` and accept the resolution change. Measure
  before choosing; ADR-0004 chose the symlink for a reason that still holds.
- **ts-jest with diagnostics on cannot be mutated at all**, which is the NestJS default. ADR-0028 found
  this and put the fix in a *fixture's* jest config, reasoning that it is a fact about ts-jest rather than
  about sidecrew. That does not survive contact: an unmodified project cannot be mutated, and the protocol
  forbids changing the project. Whether sidecrew writes the transform it needs into the sandbox is a
  design decision. **And ADR-0028's specific option is already stale** — TypeScript 6 makes
  `isolatedModules: true` demand a `rootDir`, while `diagnostics: false` still works. A workaround
  recorded in a fixture comment has nowhere to be re-tested.
- **`TEST_FILE_PATTERN` removes source files that happen to be named like tests.**
  `src/modules/auth/auth.config.test.ts` is a source file the project's own test setup imports. Removing
  the project's tests is ADR-0004's core mechanism and must keep working for co-located tests, so "do not
  remove anything under `src/`" is the wrong fix — most React projects co-locate. The narrower rule is
  probably "do not remove a file that a non-test file imports", which costs a pass over the copy.
- **Stryker's sandbox cannot copy symlinked directories** (`ENOTSUP … copyfile` on `.claude/skills`).
  sidecrew's generated config sets no `ignorePatterns`. Cheap to add; needs a real run to confirm the
  pattern is right.
- **`dist/` can be stale, and the protocol does not check it.** The trial began with a binary that
  predated the fix it was testing, and the stale binary reproduced a bug the repo had already fixed. Every
  ADR here is a claim about behaviour, and behaviour comes from `dist`. Step 0 should compare the built
  output against HEAD — the protocol verifies the worker's revision to twelve hex digits and not this.
- **`detectJestConfig` looks only at the project root**, so a project whose jest config is passed with
  `--config test/jest-unit.ts` gets no `configFile` and Stryker falls back to jest's own resolution. It
  worked by accident on this project (a `package.json` `jest` key existed), but it means the mutation
  stage ran under a **different config from the project's own `yarn test`**, and nothing said so.
- **Planning cost is still unmeasured on real code.** Three trials, and the `test-planner` agent has never
  been invoked on somebody else's project — twice because the run never got that far, once because
  hand-writing the plan was the better use of the budget. It is the number the protocol calls the most
  transferable and the only one still missing.

## Noticed in the project-a re-run (15 Sep 2026) — deliberately not fixed
Each of these has a measurement behind it in
`experiments/real-world/results/project-a-2026-09-15-rerun.md`. They are here rather than in ADR-0035
because each is a contract, prompt or tooling change, not a sandbox rule.

- **The prompt cannot name a type the signature depends on.** All four `getSpendVsReplacement` attempts
  died at compile guessing where `InsightsColorEnum` lives (TS2339, TS2614, an invented filename). The
  plan's `notes` for that function says verbatim *"imported from ../src/common/insights.color.enum"* —
  **and `notes` is never rendered into the prompt.** The planner knew and had nowhere to put it. Worth
  ~12 % of the survival rate on that module. Cheapest fix: render `notes`. Sharper: a second import hint
  derived from the source's own imports. Either changes the prompt, so it needs its own before/after.
- **`Verdict.mutation` has no `compile_error`.** The probe's four-way split is
  `killed + survived + timeout + no_coverage`, so type-checker-rejected mutants vanish. They are still
  happening — `getSpendVsReplacement`'s `killed_ids` run `1..17, 19`, so id 18 was rejected. That is
  positive evidence Stryker's typescript-checker is alive on TypeScript 6.0.3, and no report can say so.
  A contract change: needs an ADR and a `docs/specs/pipeline.md` edit in the same commit.
- **A plan whose `signature` is unqualified on a class member should be a validation warning.** The
  `{{#function_qualified}}` line is worth a great deal — 16/16 correct call sites — and fires **only** if
  the planner wrote the owning type into `signature`. Nothing checks that it did, so two independent
  things have to be right and only one of them is `exportStyleFor`.
- **`scripts/planner-tokens.mjs` cannot produce `meta.planner_tokens`, twice over.** (a) its slug is
  `dir.replace(/\//g, "-")` and does not map `_` to `-`, so it exits ENOENT on any path with an
  underscore — project-a's checkout sits under one. (b) patched, it undercounts a subagent planner ~5× because
  subagent messages are not in the main transcript (zero `isSidechain` entries). This is the one number
  `docs/specs/pipeline.md` says sidecrew cannot measure for itself, and on the one project where somebody
  tried, the shipped tool could not supply it.
- **The import-graph rescue does not resolve path aliases** (ADR-0035). A project that imports a
  test-named file through `@app/...` rather than a relative path still loses it. Not seen in the wild yet;
  fixing it means reading the project's own `tsconfig.paths`.
- **The generate stage regressed 6.3 s → 16.7 s** (completion tokens 228 → 560) between the two
  project-a runs. Partly better tests, partly the exemplar's fake-timer scaffolding being copied into
  three tasks that do not need a clock. Still only ~9 % of a candidate, so it is a watch item, not a fix.
- **The `test-planner` agent is not registered as an agent type in a Claude Code session.** It ships at
  `claude/agents/test-planner.md` to be copied into a project's `.claude/agents/`; step 3 of the protocol
  says "invoke the agent" and no trial has been able to do that literally.

## Noticed while reproducing the pnpm blocker (15 Sep 2026)
- **A strict (pnpm) layout breaks the candidate's own imports.** `import { describe, it, expect } from
  "@jest/globals"` does not resolve unless the project declares `@jest/globals` itself, and neither does
  `@types/node` for the compile stage. Both are the project's dependency hygiene rather than sidecrew's,
  and both arrive at the verdict looking exactly like a candidate that does not compile. The fix is
  probably a `doctor` row that answers it before a plan is written, in the way `stryker-runner` does.
- **Neither ADR-0036 fix has met a real project.** Both were built against reproductions in this repo:
  a six-file pnpm project, and the jest fixture with ts-jest at its default. That is a better position
  than fixing from reading a config and a worse one than fixing against the project that broke.

## Noticed in the fifth trial (15 Sep 2026)
- **`deriveLineRange` should read the TypeScript AST, not guess.** Four patches now (ADR-0033, ADR-0035,
  ADR-0039, and the return-type case inside ADR-0035), and "no mutants at all" has been wrong every one
  of the four times anybody checked it. `typescript` is resolvable from every project sidecrew verifies,
  and the compiler cannot be wrong about where a function body starts. It is a change to how the verifier
  reads code, so it needs its own measurement — but it should be the next thing done to that function
  rather than a fifth special case.
- **`doctor` cannot see the pre-flight questions that now fail per candidate.** Three of them: whether
  the tsconfig's `include` covers the directory `testDirFor` picked (ADR-0037), whether the ts-jest shim
  is available on this layout (ADR-0038), and how much heap `tsc` needs (project-b OOMs at 48.9 s on
  node's default). All three are facts about a project's layout, which is what `doctor` is for. The OOM
  message is the template: it names the cause as a machine limit, disclaims the candidate, and prints the
  exact remedy.
- **`planner-tokens.mjs` undercounts a subagent planner** — measured again at ~2.7x here (44,598 reported
  against 120,407 from the Agent tool), having been ~5x on the previous trial. `meta.planner_tokens` is
  therefore wrong in any plan written by a subagent planner, and it is still the one field in a
  `BatchResult` sidecrew cannot measure for itself.
- **Mutant density varies enough between modules that rates should not be pooled silently.** One-line
  helpers carry 1-5 mutants against `assetUtil`'s 12-19, so `killed >= 1` is a much lower bar on the
  former and a function with one mutant scores 1.00 or 0.00 with nothing in between. Report per module,
  and say so when combining.

## Noticed in the sixth trial (15 Sep 2026)
- **`peak_rss_mb` is not a footprint and its name says it is.** ADR-0011 established that macOS shrinks
  resident memory under pressure and that peak RSS "cannot detect the condition that invalidates peak
  RSS" — and then the field kept being read as the worker's size. Same pinned 7B: 4538 MB on a quiet
  machine, 170–243 MB on a busy one. The `run` summary line now says "resident" rather than "peak worker
  RSS", which is the cheap half; the field itself should probably carry the free-memory reading beside it
  the way `swapped_out_mb` already sits next to bench's copy.
- **The prompt shows a body and never what the body's meaning depends on.** Three shapes across three
  projects now: `InsightsColorEnum` (a sibling module), `randomUUID` (the module's *own* import, which
  killed `buildReportFileName`), and `isSubsetDeep`'s multiset rule, which the planner wrote into `notes`
  — and `notes` is still never rendered. This has been in BACKLOG since the fourth trial and is now the
  best-evidenced prompt change available.
- **Sample the module, do not choose it.** The sixth trial cut project-b to 5 of 11 functions on a cost
  projection that was 13 % pessimistic; the ten-function plan was affordable. The five span the mutant
  density range (31/16/12/6/2) but were picked, not sampled, so the 4/10 is over a chosen subset.
- **`.stryker-tmp/` can be left behind in a target.** The protocol's cleanup line names `.sidecrew/` and
  nothing else, and an empty `.stryker-tmp/` from the fifth trial survived into the sixth. Untracked, so
  `git status` never shows it.

## Noticed during Phase 11b's overnight runs (19 Sep 2026) — owner's ideas, ranked by what they buy

Four ideas from the owner while the arms ran, kept with the reasoning that ranks them, because the
ranking is the useful part: three of them are cheap and one of them is a trap that looks cheap.

### 1. Best-of-n against the staged gate · the one that moves the user-facing number

**The measured problem:** on project-b, **4 of 19 tasks needed a human**, and the mechanical retry
rescued **none** of them — all four retry candidates were **byte-identical** to the first attempt,
because temperature 0 and an identical prompt produce an identical answer. The retry as built only
rescues *environmental* failures (a memory false negative, ADR-0066), never a defect.

**The idea:** generate `k` candidates per task and let the gate pick. This is affordable here and
almost nowhere else, because ADR-0048's stages are already cost-ordered and the front of the funnel
is free:

| stage | cost | what it caught on project-b |
|---|---|---|
| confinement | ~0 | `multi-06` (renamed the file) |
| `tsc` | 4.5 s warm, 70 s cold | `rename-02`, `multi-04` |
| the suite | ~200 s | — |

Three of the four failures died before the expensive stage. So `k=5` costs roughly `5 × 15 s` of
generation plus a handful of cheap checks, and **the 200 s suite runs once, for a candidate that
already compiles** — about 300 s against today's 216 s. Forty per cent more wall clock, at **zero
token cost**, for four extra attempts at every task.

**What it needs, and it is an ADR not a rewrite:** non-negotiable #4 is temperature 0 with a fixed
seed. Sampling needs temperature > 0, which looks like it breaks reproducibility and does not if the
seeds are derived rather than random — `seed_i = hash(run_id, task_id, i)` makes the *set* of five
candidates exactly reproducible. Measure it against project-b's plan, which now has four known
failures to rescue.

**Why it is interesting beyond the number:** it turns the gate from a filter into a *search
mechanism*. Best-of-n normally needs an expensive judge to pick; here the compiler picks, for free.

### 2. The worker endpoint should be a URL, not a port · the one you can do tonight

`baseUrlFor` hardcodes `http://localhost:${port}/v1` (`doctor.ts:37`) and only the port is
configurable (`SIDECREW_PORTS`). The wire protocol is plain OpenAI-compatible SSE
(`POST {base}/chat/completions`), which llama.cpp, Ollama, LM Studio and vLLM all speak, so **a
worker on another machine already works today via `ssh -N -L 8000:localhost:8000 host`** — sidecrew
cannot tell the difference.

**Why bother:** not speed. Generation is 15 s of a 216–268 s task, so offloading it saves ~6 %. The
real gain is that **the worker stops sharing a memory budget with the gate**, which is ADR-0066's root
cause. Measured on 18 Sep: stopping the 7B before arm D dropped swap from **4.8 GB to 3.1 GB** and
returned free RAM to 21 GB, instantly.

**Three things that will bite:** `probeWorker` reads identity from `/v1/models`, which other servers
answer differently; ADR-0027 makes an unpinned worker a *refusal* and a GGUF has no HF revision, so it
needs `--allow-unpinned` and an honestly non-reproducible mark; and a different runtime means
different numerics, so the byte-identical determinism the measurements lean on would need
recalibrating.

**Do not extend this to `k` remote workers without doing item 4 first** — see why there.

### 3. Trustless verification · not buildable, but the best sentence of the night

> **A mechanical gate is the only kind of work you can safely hand to a machine you do not trust,
> because the result is checkable.**

You could never distribute *"review this diff"* to an untrusted node. You can distribute *"does this
compile, and do these 8,795 tests still pass"*, because a lie is detectable for the cost of running it
again. That is the sharpest argument available for mechanical arbitration over LLM-as-judge, and it is
a property this design already has rather than one it would need to acquire.

**Why it is not a feature:** verification requires the source, so a participant is inside the trust
boundary by definition. Trustless *execution* does not buy trustless *participation*. It belongs in
the writing, not the roadmap.

### 4. Distributed gates · real, and strictly worse than more RAM at this scale

The obvious scaling idea — fan candidates out to `n` machines, collect verdicts — and the naive
version produces confidently wrong numbers. Two reasons, both **measured in Phase 11b** rather than
anticipated:

1. **Baselines do not agree across machines.** A verdict means "no test that passed *here* now fails
   *here*", and a baseline drifts for reasons unrelated to the code: memory pressure (ADR-0066),
   something still undiagnosed (README O8), and **crossing midnight** (ADR-0069), where the same suite
   gave 8788 then 8787 passing. Three nodes in three timezones give three incomparable rates, and no
   field in the verdict says so.
2. **The step boundary needs one canonical tree.** Survivors apply cumulatively and the union has to
   be verified somewhere — and that check is not ceremonial: project-b's combined state showed
   `combined_regressions: 2` that **every per-candidate verdict had passed**. So a distributed design
   cannot be pure fan-out; it needs one machine to verify the union.

**And the alternative wins on effort.** One 64 GB machine runs ~3 gates locally with no protocol, no
baseline reconciliation, no source distribution, and no new failure modes. Distribution only pays at
200-task runs, which is not this year.

**Also considered and rejected: blockchain.** Consensus mechanisms exist to let distrusting parties
agree when there is *no external arbiter*. This design's entire thesis is that there is one — the
compiler and the suite. You do not vote on whether the code compiles, and re-execution beats consensus
on both cost and certainty. Worse, a signature is only worth what the claim is worth: Phase 11b found
three ways the same bytes produce different verdicts, so notarising one today would make
irreproducibility permanent and official. Earn reproducibility first (ADR-0066, ADR-0069); the
provenance that is actually wanted is tamper-evidence, which a signed log — or git — already provides.

## The measurement this repository most needs (19 Sep 2026) — the gate's own error rate

Every survival number here carries the same caveat: **a lower bound of unknown tightness.** Phase 11b
found three independent ways the gate contradicts itself on identical input, and only one is
understood:

| | mechanism | rescued by the mechanical retry? |
|---|---|---|
| ADR-0066 | memory pressure — the gate fails closed, indistinguishably from a real defect | yes |
| README O8 | undiagnosed; a quiet machine, 12 regressions, gone on retry | yes (did) |
| ADR-0069 | the baseline was captured on a different calendar day | **no** |

That caveat is the largest single weakness in the project's claims, and it is **not a caveat, it is an
unmeasured quantity.** Point the instrument at the gate instead of at the worker and it becomes a
number.

### The experiment

Take the candidates that are **known-good** — arm A's, written by Opus, already survived once — and
put each through the gate **three times**, unchanged. The input never varies, so **every disagreement
is a false negative by construction.**

```
19 candidates × 3 evaluations × ~215 s  ≈  3.5 h, unattended, zero tokens
```

Out comes the number nobody has: *the gate contradicts itself X % of the time.* With it, `15/19` stops
being a lower bound and becomes a rate with a known error term, and **every survival figure in the
README gains a confidence it currently cannot claim.**

### Why it is worth more than a feature

- **It is already instrumented.** The pressure recorder (`results/pressure-*.csv`) runs alongside, so
  each disagreement can be attributed to a mechanism rather than merely counted — memory, date
  boundary, or the O8 class that is still unexplained.
- **It needs no new code.** `scripts/arm-d-11b.ts` already replays a recorded candidate through the
  production gate. Loop it.
- **It sets ADR-0066's threshold.** That ADR recommends *record now, gate later*, explicitly because
  option A's threshold cannot be chosen from data nobody has collected. This is that data.
- **It converts the project's central weakness into a measured quantity**, which is the difference
  between a research artefact and a demo.

### Design notes, so the run is not wasted

- **Same calendar day, or the result is ADR-0069 rather than the rate** — 3.5 h of gate crosses
  midnight easily. Start in the morning.
- **Vary one thing deliberately in a second pass:** the same 19 candidates on a *deliberately loaded*
  machine. The difference between the quiet rate and the loaded rate is ADR-0066's effect size, which
  is the number its option A needs.
- **Report per project.** project-a's suite has 209 pre-existing failures and project-b's has 7; there
  is no reason to expect the same rate, and §4 forbids pooling anyway.

### Cheap companion: gate regression fixtures from real defects

Phase 11b produced **four real, diagnosed failures** — a seven-symbol over-rename (5 errors), a rename
that hit a type, a module path and a public property key (122 errors), a candidate that renamed the
file it was given (`path_outside_task`), and one that a frontier model reproduced byte-for-byte.

ADR-0067 and ADR-0068 **changed the gate** on 18 Sep and nothing re-verified that it still catches what
it caught before. Those four candidates are a better regression suite than anything synthetic: store
them as fixtures and assert the gate rejects each **for the right reason and at the right stage**.
Cheap, and it protects the one component every other number depends on.

## Noticed while fixing CI (20 Sep 2026) — DECIDED the same day, see ADR-0078

**DECIDED 20 Sep 2026 by the owner: the floor applies to every run, `--dry-run` included (ADR-0078).**
No code changed — it confirms existing behaviour. The rest of this entry is the question as it was
put, kept because the reasoning is the useful part.

**Should the 24 GB floor (ADR-0073) fire on a run that never starts a worker?**

`runBatch` and `fix` call `assertSupportedMachine` before they know whether the run will generate
anything, so `sidecrew run --dry-run` is refused on a 16 GB laptop. A dry run stops before the first
token and picks no worker: it renders tasks and prompts and counts estimated tokens, none of which
needs RAM sidecrew does not have.

That is arguably wrong — *"what would this cost me?"* is exactly the question somebody on an
unsupported machine wants to ask before buying a supported one, and refusing it is a worse first
experience than answering it. It is arguably right too: a floor that holds everywhere is one rule, and
a floor with an exception is two, and the exception is the kind that grows.

**Not decided here, and not decided by the CI fix.** The five tests that hit this now pass
`workerKind: "local"` explicitly — the bypass `assertSupportedMachine`'s own docstring already blesses
for a harness — which moves the tests off the floor without moving the floor. Whoever takes this
should decide the product question on its merits and write the ADR, not inherit it from a test.

**Do not reach for `SIDECREW_TIER=api` as the answer.** It opts into a tier ADR-0073 descoped and
whose survival and cost figures were never measured.

## From the `v0.1.0` release runs (21 Sep 2026)

- **`test/cache.test.ts`'s *"does not throw when it cannot write"* times out on Linux.** It builds a
  `CandidateCache` at `/proc/nonexistent/forbidden` and expects `write` to swallow the failure. On
  macOS there is no `/proc`, so the `mkdir` fails immediately; on `ubuntu-latest` the test hit
  vitest's 5 s timeout. `write` has no retry and no backoff — `mkdir`, `writeFile`, `rename`, one
  `try`/`catch` — so what is slow is the filesystem call itself, and nothing here explains five
  seconds. **Not reproduced locally: there is no Linux box and no container runtime on this machine.**
  Sidestepped rather than fixed: the `npm` job moved to `macos-latest` (ADR-0080), which is right for
  its own reasons, so nothing in CI runs the suite on Linux any more. Worth knowing before anybody
  proposes supporting another platform — the path is chosen for being unwritable, and it is unwritable
  in a different way on each OS. An `mkdtemp` directory with its mode cleared would be portable, but
  it also does not fail as root, which is how a container commonly runs.
- **`package-lock.json` is still a sixth version place that neither workflow gates.** `release.yml`
  compares the tag against five values, `ci.yml` against four. It read `0.0.1` once while the others
  had moved. Cheap to add; nobody has.

## Noticed while fixing ADR-0081 (21 Sep 2026)

- **A test *directory* is still not a test artefact unless the filename says so.** ADR-0081 widened the
  filename pattern and deliberately did not add `test/`, `tests/`, `e2e/`, `cypress/` or `spec/` as
  directory names beside `__tests__`/`__mocks__`/`__snapshots__`. The measured gap was the separator,
  and there is no evidence for the directory rule — a `test/helpers/build-order.ts` may be
  infrastructure a change legitimately needs to touch, and refusing it costs a task. Worth revisiting
  with a count from both projects rather than from an opinion: how many files live under such a
  directory *without* a test-shaped name, and how many of those would a plan ever list.
- **`fix-validate`'s `FORBIDDEN` is private, so the two refusals ADR-0048 wants cannot be asserted to
  agree from a unit test.** The `isToolConfig` comment claims *"a test asserts the two agree"*; what
  exists tests the shared predicate, not the two call sites. Exporting `FORBIDDEN` or driving
  `validateChangePlan` over a fixture plan would close it. ADR-0081's no-second-copy scan is the cheap
  half of the same guarantee.

- **`npm test` leaves one empty `sidecrew-nm-*` directory in the temp dir per run.** 0 B, harmless, and
  it makes the *"no sandboxes left behind"* check that every experiment script runs on exit report a
  non-zero count that has nothing to do with the experiment — which cost a few minutes of a wrong
  suspicion on 21 Sep. A teardown in whichever test builds a sandbox, or a name that the sweep
  distinguishes from a real one.

## Noticed while building ADR-0077 option B (22 Sep 2026)

- **Nothing runs the slow suite, so its assertions rot silently.** `test/fix.slow.test.ts`'s
  *"is off by default, so the task escalates"* had been failing since **ADR-0054** landed — it expected
  `{ suppression_added: 2 }` and the gate now also reports `documentation_changed: 2`, because the
  control's suppression is a `// @ts-ignore` and that is a comment line added. The gate was right the
  whole time; the expectation was stale, and `ci.yml` runs the fast set by design (the slow files need
  real toolchains). **The same shape as CI being red from 18–20 Sep with nobody looking.** Options: a
  scheduled workflow that runs `SIDECREW_SLOW=1` on the fixture only — it needs no client project and
  took 67 s here — or a release-gate step, or a documented "run it before a phase ends". The first is
  cheapest and would have caught this within a day.
- **A suppression is counted twice in `confinement_breaks`.** ADR-0054 counts comment lines and a
  `// @ts-ignore` is one, so every `suppression_added` also reports `documentation_changed`. Harmless
  for the gate — both are breaches, the candidate is refused either way — but the *stat* over-reports
  documentation changes, and Phase 11b's numbers are read off that stat. Whether ADR-0054's rule should
  exclude suppression comments is a decision, not a fix.
