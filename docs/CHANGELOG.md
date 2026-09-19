# Changelog
## Unreleased — §2.1 measured, and it fails its own frozen rule (2026-09-19)
- **Planning costs 2.84x what paying a model per task would. `R = 2.84` at `N = 12` → FAIL (§4.3).**
  `P_total = 265,607` new Opus tokens for a validated 12-task plan on project-a, so `P = 22,134`
  tokens per task planned against `W_upper = 7,794`. Reported against the conservative bound,
  because §3 forbids applying the rule to the flattering one. The verdict holds at `N = 12` and no
  other `N` — §4.4's second plan size was not taken.
- **13b item 1 is unblocked, and this number is its go/no-go rather than its baseline.** Its premise
  was that planning is expensive and mostly Opus reading code. Measured: 6.3M cache reads against
  65k of output. It still needs its own ADR first — its gate confirms a symbol exists, not that it
  is relevant.
- **Phase 5's 120–145k figure is superseded**, and was contaminated three ways rather than one: the
  original same-session window, plus both defects of the instrument that produced it.
- **The planner refused 11 tasks to plan 12**, and three of those refusals share one cause worth
  knowing: project-a's tsconfig declares no `include`/`exclude`, so its program covers the test
  directory — any rename with a test-file reference introduces a `tsc` error outside the task's
  files and fails `compile_ok` by construction.
- **A false-positive class in the validator's forbidden-file rule**: ordinary application source in a
  dotted-name convention matches a tool-config pattern that accepts any extension, and two real
  tasks were dropped by it. The planner fixed the plan rather than the gate, which is correct.
- Refusals are recorded by rule and count only. Each one names a client symbol, and a client symbol
  name is client IP — the same reason change plans are gitignored (CLAUDE.md #7).

## Unreleased — the verdict records what invalidates it (2026-09-19)
- **ADR-0066 accepted at option C and ADR-0069 at option A, decided together.** Both are *record,
  don't gate*. `ChangeVerdict` now carries `baseline_captured_at`, `verified_at` and `machine` —
  pressure, free, swap and compressed, sampled **before and after** the gate — and `changeSurvives`
  reads none of them. Two of the three known sources of #2a false negatives become detectable in the
  artefact instead of suspected; the third is undiagnosed and is being measured directly.
- **`machine` is a pair of samples because the signal is a delta.** ADR-0066's amendment ruled out the
  pressure level as a threshold — a large suite reaches `warn` unaided on the baseline machine — and
  named swap *growth* instead. One sample cannot express growth. `swapGrowthGb` is the reader, and a
  corpus of these is how option A's threshold stops being a guess.
- **`sidecrew fix` warns once per run when the baseline and a verdict fall on different calendar
  days**, and does not stop. `crossesCalendarDay` compares days rather than elapsed hours: the
  measured case was 37 minutes apart and already poisoned.
- **Null means one thing: the verdict predates the field.** A machine that could not be asked is a
  present `machine` with null members. The refusal path records a sample for that reason alone.
- `readMachineState`, `parseSwapUsage` and `parseCompressed` in `doctor.ts`; spec updated in the same
  commit; 691 fast tests green.

## Unreleased — Phase 11b completes on both projects (2026-09-19)
- **project-b, the first non-saturated survival rate in the project.** Arm C **15/19**
  `[0.544, 0.939]` against project-a's 19/19, and the four failures are individually diagnosed rather
  than being a number: a 7-symbol over-rename, a rename that also hit a type, a module path and a
  public property key (**122 compile errors**), a candidate that renamed the file it was given, and
  one that a frontier model reproduces byte-for-byte. One mechanism explains the three real ones —
  **the 7B substitutes text where a frontier model renames a symbol.**
- **Arm D found no defect in Opus's output** (19/19 and 18/19). §4.3 predicted arm D was where the
  thesis would show; it did not. The gate does not improve on a frontier model here. **Its value is
  that it makes a free worker usable** — and that it separates worker defects from project defects:
  three of arm C's four failures vanish when Opus writes the diff, so worker-attributable survival is
  **15/18**, not 15/19. Three such predictions were written down before arm D reached those tasks and
  all three held.
- **The cost ordering between frontier models reverses between projects** — Opus 10.8 % cheaper on
  project-a, 7.0 % dearer on project-b. First *measured* reason §4 forbids pooling.
- **ADR-0069 — a baseline has a shelf life.** A run crossed midnight, a date-dependent test began
  failing on *unmodified* code, and from that point every candidate inherited the regression. One
  stale baseline becomes a total run failure, and the mechanical retry cannot rescue this class. Arm D
  was discarded at 10/19 and restarted on a same-day baseline.
- **Three false-negative sources now known and only one understood**, so every survival rate here is a
  lower bound of unknown tightness. Measuring that tightness is written up in `BACKLOG.md` as the most
  valuable experiment left.
- README leads with the status-quo comparison, a requirements table and per-RAM expectations;
  `doctor` gained a `platform` row so a non-Apple machine is told rather than left to fail oddly.

## Unreleased — Phase 11b measures sidecrew against not using it (2026-09-18)
- **A local 7B produced byte-identical output to Opus on 18 of 19 real tasks**, and to Sonnet on
  19/19, on an unmodified commercial Nest codebase (352 suites, 6,368 tests). Not a saturated metric —
  the artefacts are the same file. Arm C (7B behind the gate) survived **19/19** at **zero worker
  tokens**, against 80,131 marginal tokens for Opus and 88,820 for Sonnet. Generate 15.9 s, gate 255 s:
  94 % of a candidate's cost is in a stage that is free and local.
- **§4.2's WIN condition is satisfied and deliberately not applied.** §4.4 requires at least half the
  tasks to be null guards, API migrations or dead-code removal; the mix is 19/19 `rename`. The verdict
  is **WITHHELD**, as declared before the first arm ran. The clause was written on a suspicion and is
  now over-determined: a task set on which three different models emit identical bytes cannot rank
  anything.
- **Three gate defects found, all by reading artefacts rather than by a failing number.** ADR-0066 — a
  memory-starved gate fails closed and the false negative is indistinguishable from a real one
  (reproduced across a restart on byte-identical candidates). ADR-0067 — the gate compared test
  identity, not counts, so a broken `test.each` case passed silently; the first defect erring towards
  *leniency*. ADR-0068 — `observations` counted comment lines, so the one behaviour distinguishing the
  local tier was invisible to the mechanism built to see it.
- **Two open, recorded not repaired.** A second source of gate non-determinism on a quiet machine
  (O8), located and undiagnosed; and arm D's tier mismatch — a replay arm is neither `local` nor
  `api`, and the schema correctly refused its zero-token `api` result.
- **Pressure telemetry is now recorded for a run** (`results/pressure-*.csv`, 594 samples), which is
  what makes a starved verdict identifiable after the fact. ADR-0066 recommends recording before
  gating, because the threshold cannot be set from data nobody has taken.

## Unreleased — Phase 13 builds the `api` tier (2026-09-18)
- **A 16 GB machine can run sidecrew.** `runBatch` and `runFix` no longer hard-code `worker_kind:
  "local"`; the tier comes from **installed** RAM (ADR-0045 §4) and a machine under 24 GB gets
  `claude-haiku-4-5` over the Anthropic API, doing the same small tasks behind the same gate. Until
  now `sidecrew run` simply did not start there, which failed `VISION.md`'s publication bar on its own.
- **No measurement was taken.** The tier is built and tested; Phase 13 §5's survival rate, blind
  approval rate and dollar-per-surviving-task do not exist. §5 spends real money and was left for the
  owner. Phase 6's Haiku figures remain an upper bound from a subagent harness and are not this tier's
  cost (ADR-0045 §7) — the README says so.
- **ADR-0059** — the client is `fetch` against the Messages API, **not** `@anthropic-ai/sdk`. The
  dependency rule (`@modelcontextprotocol/sdk` + `zod`) survives unamended. The deciding argument was
  not bundle size: adding the SDK makes every local-tier user install a path they will never take, in
  order to buy capabilities ADR-0045 §5 forbids this tier from using, and an optional peer dependency
  charges the extra step to the one user who has no alternative.
  - **The retry rule is the part that can double a bill, so it is stated rather than inherited.** 429
    and 5xx are retried, because the server refused before producing anything and nothing was billed;
    **a timeout or a dropped connection is never retried**, because that is exactly the case where the
    completion may already have been produced and paid for. An SDK that retries connection errors by
    default does the one thing this tier most needs not to do. Both directions are tested.
  - **`assertLocalTier` was not touched.** The api path has its own guard, `assertApiTier`, an
    allowlist of one host over https — and a test asserts the two guards are **disjoint**, because one
    client with a flag would be one edit from having neither.
- **ADR-0060** — pinned to `claude-haiku-4-5`, **and the pin is weaker than a revision sha**, which is
  said where the number will be rather than only in the ADR: a local pin is an immutable commit on
  disk, a hosted id is a name the provider resolves. A finding that makes the pin load-bearing:
  `temperature` is accepted on this generation and **returns a 400 on the 4.6-and-later families**, so
  a silent upgrade would not merely make two survival rates incomparable — it would make the request
  fail, on the one machine with no fallback. `models.json` gains an `api` block with the id, the 200K
  context window and the per-MTok rates with the date they were true.
- **ADR-0061** — the tier's number is taken **fresh on the current tool**, not against Phase 11's arms.
  ADR-0045 §7 said "Phase 11's protocol" before `fixer.md` changed in `6c161de` and before Phase 11b
  declined to pin the old template; following it literally now would measure a sidecrew nobody ships.
  The cost is stated rather than hidden: §5.2's bar is `0.90 · A(C2)` and `A(C2)` was measured on
  different prompt bytes. A same-commit local arm redoes the comparison and becomes the headline.
- **Accounting is the API's own usage, never an estimate** (ADR-0045 §6). `claude_tokens.workers` is
  summed from each candidate's usage block, and `generateApi`/`generateApiChange` refuse a completion
  whose usage was not measured — the same refusal the local tier already makes (ADR-0019), where it
  now guards a **price** rather than a statistic.
- **The guarantee is now checked from both sides** (`docs/specs/pipeline.md` updated in the same
  commit). The refinement refusing a `local` run that spent worker tokens is untouched. Added: an
  `api` run that produced outcomes and reports `workers: 0` does **not** serialise, because that is
  lost or estimated usage and Phase 13 §5.0.2 voids exactly that run. A free-looking api run used to
  serialise happily.
- **`doctor` has a tier row**, in ADR-0032's shape — the cause, whose it is, the exact fix — and it is
  **fatal** on an api machine with no key, because there is no local tier to degrade to. `memoryCheck`
  no longer sizes an api machine's free RAM against a 7B it will never host. `serve` says there is
  nothing to serve on that tier rather than advising the user to close Xcode.
- **Concurrency on the api tier is bounded by the rate limit, not by RAM** (ADR-0045 §5) — the worker
  is a network call. The **verifier is held at one process**, and deliberately not a computed number:
  the gate is 70–80 % of a candidate's cost and still runs locally, on the smallest machine sidecrew
  supports, and a verifier process tree has never been put on a scale (`slotGb`'s own docstring). The
  thermal guard is off there: decode happens on somebody else's hardware.
- **ADR-0062 (PROPOSED, not decided)** — found by reading a test failure rather than a statistic. **On a
  single-file task a worker's refusal is swallowed**: `parseEdits`' bare-answer fallback claims any
  non-empty text as the file's new contents, so `edits.length` is never 0 and `parseRefusal` is never
  reached. The refusal becomes a candidate that fails `tsc` and is counted as a worker failure. This is
  the **local** path's behaviour too, and **Phase 11 measured only single-file tasks** — so the refusal
  shape Phase 12 built is inert in exactly the configuration everything has been measured in, and
  `refusals: 0` is a constant rather than an observation. Options written up; not fixed here, because
  the fix is a contract decision and Phase 11b is running against those same plans.

## Unreleased — Phase 12 builds the management side (2026-09-18)
- **Both of Phase 12's rules are frozen before the things they measure exist**
  (`experiments/planner-cost/`, `experiments/correction-round/`), which is Phase 11's discipline
  applied on time rather than in retrospect.
- **The finding that shaped the phase: no task Phase 11 ever ran reached a second attempt.**
  `retried = 0` in all six arms across 54 tasks. So the correction round has a denominator of **zero**
  on every task this repository has measured, and §2.2 is unmeasurable on renames and unused-import
  removals at any run length. It needs the shapes nobody has measured — null guards, API migrations,
  dead code — which are the same shapes **Phase 11b §4.4** requires before its own verdict applies.
  One extended task set serves both, and that is the only coupling between them.
- **ADR-0057** — the correction round could not reach the one defect it was meant to prove itself on.
  A cosmetic edit *survives*, so its verdict says `survived: true` and carries nothing to write a note
  from, and ADR-0044 §4 rule 1 forbids reading the diff. That also corrects an ordering error:
  **ADR-0054 is upstream of §2.2's number, not downstream.** Decided option D — the verdict carries
  non-gating `observations`, `changeSurvives` is untouched and a refinement asserts it, so survival
  stays comparable with Phase 11's.
- **The contracts** (`docs/specs/pipeline.md` in the same commit): `shape` on every task, required with
  no default, because the shape is the caveat on every number — `tsc` proves a rename complete and
  proves nothing about a null guard's behaviour; `observations`; `refusal`; a `CorrectionBudget` that
  defaults to off everywhere; `ChangeEscalation`; and `machine_failures`, which is what Phase 11 lacked
  when an ENOTEMPTY teardown sat in `escalated` looking exactly like a worker that could not do the job.
- **ADR-0058** — the planner's real output is **refusal**, and `shape` is a contract field because the
  shape is the caveat on every number. Also records that the library does not call a model to write a
  correction, and what `max_group_size` is still not known to be.
- **The planner** — `claude/agents/change-planner.md` + `sidecrew fix --validate` /
  `sidecrew_fix_plan_validate`. Its most useful output is a **refusal**: a task whose files already
  carry a `tsc` error the ask does not cover cannot be passed by anyone at any temperature, because the
  gate demands zero there (ADR-0050 option C). At 262 s of gate per attempt, one refusal saves nine
  minutes. Also refused: files too large to return whole (ADR-0047 §2's wall, which Phase 11 hit before
  it hit the model's ability), a file outside the tsconfig's program where `compile_ok` passes
  vacuously, and two tasks in one step sharing a file — the one failure mode no per-task verdict can
  see, since both candidates survive and the second to land drops the first.
- **The correction round** (ADR-0044 §4 option B), built, budgeted and **off by default**. Rule 1 is a
  function signature rather than a promise: `src/correction.ts` takes a verdict and a shape, and
  `ChangeCandidate` is not in the module — a test asserts it over the source. It does not call a model
  either; Opus supplies the writer, so a local-tier run never spends Claude tokens from inside the
  library, and what it does spend is accounted where the schema can refuse a result that hides it.
  Verified end to end on the fixture: a worker that keeps adding `@ts-ignore` is refused twice, gets one
  note written from the gate's own findings, and survives on attempt 2.
- **A worker can say it cannot do the task** — `--- CANNOT: reason ---`, short-circuiting at `generate`
  rather than spending 262 s failing at `compile` for a reason nobody can read. This changes the prompt
  Phase 11 measured against, so future runs are not byte-comparable with its arms.
- **`sidecrew_fix`, `sidecrew_fix_plan_validate`, `sidecrew_fix_escalate`** and the skill's #2a section.
  `BACKLOG.md` held these back from Phase 10 because a tool Claude can call is useless until something
  writes plans for it. The skill leads with what the gate *cannot* see, because a human approving a diff
  is the last place either known gap gets caught.
- **Unattended mode is built** (`BACKLOG.md` item 4, which was Phase 12's): `sidecrew fix --resume
  <run_id>` continues a run that stopped, and `sidecrew fix --report` orders what to read first.
  Building it found a Phase 12 bug nothing else would have — a real run never wrote attempt 0's task, so
  `fix-escalate` silently returned a short batch for every first-attempt escalation while headline
  numbers stayed correct, which is exactly why it was invisible.
- **A gate defect that erred towards leniency, found by Phase 11b and fixed on `main` (ADR-0067).**
  `regressed` is computed by set membership over test ids, and a `test.each` block gives every case the
  same `fullName` — so breaking one of nine left the id in the passing set, recorded no regression, and
  passed `ran_after >= ran_before` because the failing case still ran. **It admitted broken changes.**
  `tests_ok` now also requires `passed_after >= passed_before`, and the verdict carries both counts so
  the **schema** enforces it rather than the runner alone.
- **`observations` can see a reword now (ADR-0068), and the measurement is the reason.** Phase 11b found
  a local 7B produced **byte-identical output to Opus on 18 of 19 real tasks**; the single divergence was
  rewording a doc comment to match a renamed symbol — precisely the case ADR-0057's line delta could not
  see, with all 19 verdicts reporting `observations: []`. Sensitivity 0/1 on the only case in its
  dataset, aimed at the worker's one reproducible behaviour. Still non-gating.
- **The candidate cache is built** (`sidecrew fix --cache`), behind ADR-0065 and **off by default**.
  Local tier only, because the `api` tier has no seed and a "hit" there would be a coincidence. A second
  identical run asks no worker for anything and reaches the same outcome, which makes ADR-0003's
  determinism claim load-bearing rather than asserted once in Phase 1 — and the gate still runs, which
  is why the win is ~5 % and not "nothing".
- **ADR-0065** — memoise candidates, never verdicts, and key on the **rendered prompt** rather than on
  the task, because the prompt template is an input and it changed today. The verdict half is settled by
  measurement rather than argument: Phase 11b saw a byte-identical candidate produce `tests_ok: false`
  with 155 named regressions on a swapping machine and `survived` on a rerun, so a verdict is **not a
  pure function of its inputs** and caching one would make a transient environmental failure permanent.
  The ADR also states plainly that the backlog's "a re-run costs nothing" is false — it is about **5 %**
  — and that a cached run's `generate_ms` is not a measurement.
- **Phase 13b exists: four edge ideas now gate publication** (owner, 18 Sep 2026) — local retrieval,
  memoisation, unattended mode, two-model agreement. **Three of them were Phase 12's and were not
  built**: items 1, 3 and 4 name Phase 12 as owner in `BACKLOG.md`, and Phase 12 built the four
  deliverables in its prompt without ever reconciling them against that. Recorded as a miss, because a
  phase prompt and a backlog entry disagreed and nothing checked.
  Each is now carried with what is actually known about it rather than its original pitch: memoisation
  saves about **5 %**, not "nothing" — generation is 13.5 s of a ~275 s candidate and the gate is 95 %
  of it; retrieval's premise rests on a contaminated Phase 5 figure, so **§2.1 is its go/no-go rather
  than its baseline**; and two-model agreement's own precondition — *"only worth it if Phase 11 shows
  the two models disagree"* — **was never tested**, because Phase 11 never ran the 14B.
- **ADR-0063 (accepted)** — an experiment may run `tsc` stricter than the project does, and must declare
  it. This unblocks Phase 11b §4.4 and Phase 12 §2.2, which were blocked on the same missing input. The
  survey that reported the harder shapes as absent was measuring something that could only return zero:
  `project-a` compiles with `strictNullChecks: false`, and with it off **nobody writes `!`**, so a search
  for `!.` dereferences was structurally incapable of finding a null guard. With the flag on — no file in
  the client's repo changed — 763 files have an error, **417 have few enough for one ask to cover them
  all, 401 of those fit the whole-file ceiling**, and 22 are pure null-shaped.
- **ADR-0064 (proposed)** — the finding underneath, which bears on `VISION.md` rather than on a phase:
  **#2a's addressable surface is whatever the compiler is currently asked to report**, which is a
  property of configuration rather than of code. So the vision's headline example — *"fix every
  TypeScript error in this codebase"* — has an **empty task list on a well-maintained project, by
  construction**, and a large one a notch above it. Where #2a actually pays is a project mid-migration or
  one that has just raised its own bar, which is narrower than the vision implies and more useful.
- **A refusal was swallowed on single-file tasks**, found by the Phase 13 session. `parseEdits`'
  bare-answer fallback claimed the refusal text as the file's new contents, so `parseRefusal` was never
  consulted and the refusal became a candidate that overwrote the file and failed `tsc`. Phase 11
  measured only single-file tasks and 11b reuses those plans, so `stats.refusals` was a **constant zero
  in every configuration this repository has numbers for** — a field reporting nothing while looking
  like it reported something.
- **Phase 13 is built, merged and unmeasured.** The `fetch` client, `assertApiTier` (disjoint from
  `assertLocalTier`, asserted by a test), tier selection from installed RAM, and accounting from the
  API's own usage fields. **ADR-0062** — found while building it, and a local-tier defect rather than an
  api-tier one — is accepted at option B.
- **§5 waits on API credits, and a subagent substitute was refused** rather than quietly used: it cannot
  satisfy §5.0.2, never executes the client, and would re-derive Phase 11's C3 numbers. Recorded as a
  dated amendment below §5 so the next session does not rediscover the argument. Phase 13 stays at
  "built, unmeasured" alongside Phase 12, which blocks nothing before publish.
- **Phase 13's prompt is written and its §5 frozen** (`prompts/phase-13-api-tier.md`), handed over with
  three decisions deliberately open: the API client vs CLAUDE.md's "only runtime dependency" rule, the
  pinned model id, and what the tier's number is comparable to now that `fixer.md` has changed. Its rule
  turns on an asymmetry the local tier does not have — on a 16 GB machine the alternative to a mediocre
  tier is no tool at all — so it measures **dollars per surviving task** and keeps precision as the veto.
- **A handoff note for Phase 11b** (`prompts/phase-11b-handoff-from-12.md`), which amends nothing and
  says what moved under it: the renamed and now-untracked plans, the refusal and machine-failure fields
  with the denominator that uses them, and that observations must stay out of its blind pack.
- **Phase 11's plans were unparseable for a few hours and are fixed.** Making `shape` required broke the
  exact plans Phase 11b §2 says to reuse; ADR-0058's bullet claiming they did not need migrating was
  wrong and is corrected in place. They are also now **untracked** — `project` is an absolute path into a
  client checkout and a rename ask quotes the client's own symbols by construction (CLAUDE.md #7) — and
  renamed to the names the results already referenced.
- **The client's name is out of `src/`, the contracts and the recon notes** — seven mentions plus two
  filenames, found by scanning a diff. 47 files still name them; that is ROADMAP priority 4's
  allowlist rebuild, not this phase's, and nothing has been pushed.

## Unreleased — the roadmap is reordered around the science, and Phase 12 is written (2026-09-18)
- **`docs/plan/ROADMAP.md`** — the owner's statement of 18 Sep reorders the plan: measurements,
  experiments, numbers and writing first; the tool second, judged by whether a colleague sees an
  improvement over asking Opus or Sonnet directly. "Edge computing" is a metaphor for one property,
  not the thesis.
- **The gap that outranks everything, named**: every number in this repository compares a 7B against
  Haiku *inside* sidecrew, behind the same gate. **Nothing has ever been compared against not using
  sidecrew at all**, which is the only comparison that supports a claim of improvement over the
  status quo — and the strongest thing the scientific half could publish, because the literature
  compares models rather than *model + verification harness* against *model alone*. Frozen-rule
  discipline applies: the success condition is the owner's own — equal precision at lower tokens is
  a win, higher precision at equal tokens is a win, only lower precision loses.
- **`docs/plan/prompts/phase-12-management.md`** — the planner, the correction round, the refusal
  shape and the MCP tool, with the two measurements that decide whether any of it was worth having:
  the cost of *deciding* (Phase 11 measured *doing* completely and deciding not at all), and whether
  a correction pays for itself against escalation. Both against rules frozen first.
- **README** leads with #2a's measured numbers instead of "has no measured number yet".
- Two articles published: the frozen rule and the perfect score it vetoed, and the gate-reference
  taxonomy — *a broken gate announces itself; a gate whose baseline is corrupted keeps passing and
  quietly asks for less.*

## Unreleased — Phase 11: workload #2a measured against a rule frozen first (2026-09-18)
- **The number, per project, never pooled** (`experiments/go-no-go-2a/results/REPORT.md`). On an
  unmodified commercial Nest codebase: `S(C2) = S(C3) = 12/12`, `A(C2) = 9/10` against `A(C3) = 10/10`
  — a **GO by exactly zero margin**, on an interval of `[0.555, 0.997]`. On the fixture: `3/3` survival
  both arms and **NO-GO**, because the approval guard is a veto. A React codebase is **inconclusive**
  for a harness reason, not a model one.
- **Survival rate decided nothing.** Four of five measurable cells are at 1.00. The phase turned
  entirely on `A`, the blind approval rate that §4.1 added as a veto and that I had privately called
  gold-plating. Both times it bound, the cause was the same: the local 7B edits documentation it was
  not asked to touch — a 7-line docblock deleted in 2 of 3 fixture tasks, a doc comment reworded in 1
  of 10 on the real project — and `survives ⇔ confined ∧ compile_ok ∧ tests_ok` cannot see prose.
  ADR-0054 proposes the eighth rule, with the count attached, and does not apply it (§6).
- **Whole-file rewriting is vindicated.** `edit_parse_failed = 0` and `edit_truncated = 0` in every
  configuration, over 30 real-file rewrites. ADR-0047 §2's recorded risk, and §4.4's inconclusive
  clause, did not fire once.
- **The Goodhart surface did not appear.** Zero confinement breaks in ~60 attempts. Every cheap pass
  ADR-0048 blocks was available and neither worker reached for one.
- **The gate costs ~260 s a candidate** on both real projects — 95 % of a candidate's cost, and
  identical across configurations, which is why §4.2 was right to refuse latency as a criterion. It is
  the budget ADR-0044 §4's correction round must be argued against.
- **Four defects, found on the first two real projects, and the worst was invisible.** ADR-0049
  (`doctor` checks node against sidecrew's floor, never the project's `engines` — every suite failed
  to load and jest collected zero tests). ADR-0050 (the #2a sandbox does reach ADR-0034's TS2883 case,
  contrary to its own comment). **ADR-0052** (`npx` exports npm's state; a test dependency resolved a
  different cache and ~170 suites died — this corrupted the **baseline**, so the gate did not break, it
  quietly required less, and a rate taken against it would have been an overstatement nothing could
  detect). ADR-0053 (a test whose name is generated read as a regression, which would have failed every
  candidate on one project for a property of its test titles).
- **§4 was not edited.** The amendment below it is dated and says what this run learned: §4.0's three
  bullets are necessary and **not sufficient**, because all three held on four arms whose baselines
  were silently wrong. A fourth is proposed — the baseline must match a quiet-machine reference at the
  same commit, and a run that does not match is discarded rather than repaired.

## Unreleased — workload #2a: local models making behaviour-preserving changes (2026-09-16)
- **`sidecrew fix <change_plan.json>`** — the second workload, and the first thing in this repo whose
  output is a sentence from `VISION.md` rather than a step towards one: *the user asks for a change to
  their source code and gets it.* Ordered steps of grouped-file tasks, generated by the local worker,
  gated by **the project's own test suite plus `tsc`**. `--dry-run` captures the first step's baseline
  and stops before the first token.
- **Six new contracts**, in `schemas.ts` and `docs/specs/pipeline.md` together: `ChangePlan`,
  `ChangeBaseline`, `ChangeTask`, `ChangeCandidate`, `ChangeVerdict`, `FixResult`. **ADR-0047.** A task
  is a group of files (ADR-0044 §1), a plan has ordered `steps` whose baseline is re-captured between
  them (§2), and **there is no `workers` field — `ChangePlan` is `strict`, so a plan carrying one does
  not parse.** §3 was a sentence in a document; it is now a test. `attempt ∈ {0,1,2}` and
  `ChangeTask.correction` exist with nothing filling them, so Phase 12's correction round is a fill
  rather than a migration.
- **ADR-0046 — the #2a sandbox keeps the project's tests**, which is the exact opposite of ADR-0004 and
  for the exact same reason. ADR-0004's rule is *"the sandbox contains nothing that could satisfy the
  gate except the candidate"*; in workload #1 a pre-existing test is the confound, and here the suite
  **is** the gate. So it is kept, and the candidate is forbidden from touching it instead. What makes
  that safe is the **baseline**: captured before the change, in the same sandbox, in the same way — the
  rule is *every test that passed before still passes*, never *everything is green*, because a project
  with pre-existing failures is the normal case.
- **ADR-0048 — the gate, and the seven cheap ways to pass it, blocked by name.** `survives ⇔ confined ∧
  compile_ok ∧ tests_ok`, and it is an **iff in `schemas.ts`**, stricter than workload #1's: `tests_ok`
  cannot be true without a report, without at least as many tests running as the baseline ran, without
  `ran_after > 0`, or with anything in `regressed`. *A suite that collected zero tests was never going
  to be allowed to read as a green suite.* `compile_ok` is two conditions — zero errors in the task's
  files, none introduced anywhere — and *strictly fewer errors overall* is a **theorem** rather than a
  third condition, which is what makes the gate monotone and lets a long job converge over many tasks.
- **Whole files, not patches** (ADR-0047 §2). A 7B emitting correct `@@` hunk headers fails in a way that
  says nothing about whether it understood the change, and it adds a stage — *the patch did not apply* —
  for a verdict to represent. Whole contents apply mechanically, the diff is computed exactly rather
  than trusted, and **confinement is decidable before a byte is written**. The cost is recorded rather
  than discovered: `truncated` and `unparsed` are counted by name, and Phase 11's frozen rule turns a
  quarter of attempts there into a verdict about the *format* instead of about the model.
- **`fixtures/fix-fixture`** — three planted errors of three kinds, a real Vitest suite, **one test that
  has always failed on purpose** (so the baseline rule and "everything is green" cannot be confused), and
  `controls/`: one candidate per confinement rule. A fast test asserts every rule has a control and each
  is refused; the slow test puts all seven through the real gate. **Four of them leave a project `tsc` is
  completely happy with** — and the slow test measures that rather than asserting it. Nothing but the
  confinement checker stands between those four and a survivor.
- **`docs/plan/prompts/phase-11-go-no-go-2a.md`, §4 frozen the same day, before `sidecrew fix` had
  produced a single verdict.** Phase 6's shape plus three things it lacked: a **blind approval rate** as
  a veto, because a 2a survivor is edited source and ADR-0020 exists because a survival rate alone could
  not see quality; an **absolute floor of 0.25**, because a good ratio against a weak control is not a
  workload that pays for itself; and a clause that makes an unreadable-answer run inconclusive **about
  the model** rather than a no-go on the workload. It also asks for the gate's known hole as a reported
  number: the fraction of survivors whose changed lines no test that ran executed.
- **The first real run of the gate found the gate lying, which makes it five for five.** A relative
  project path made `tsc` unspawnable; `run` returns an empty stdout rather than throwing; and
  `parseTscErrors` read that as **zero errors on a project with three planted ones** — `compile ok` on
  something the compiler never opened, which is ADR-0037 inside the gate written to be paranoid about
  ADR-0037. `--listFiles` makes it detectable (every real invocation lists the TypeScript lib files), so
  `typecheck` now refuses an empty program outright, and there is a test that builds a broken `tsc` to
  prove it. Phase 4's `<|im_end|>`, Phase 6's empty shim, Phase 9's ts-jest instrumentation, ADR-0037,
  and now this.
- **No survival rate, and no local model has been pointed at this workload at all.** That is Phase 11,
  against the frozen rule. `CLAUDE.md` non-negotiable #2 now states both gates.
- Not built on purpose, all noted in `BACKLOG.md` against Phase 12: the code-change planner, the
  correction round, the `sidecrew_fix` MCP tool and skill wiring, and a 2a escalation queue.
## Unreleased — the vision is written down, and publication moves behind it (2026-09-16)
- **The management half of the vision is now planned, not just named.** `VISION.md` quotes the owner's
  worked example — Opus decomposes, groups 5–10 files per worker, hires, confirms, corrects — and maps
  each clause to where it stands. **ADR-0044** (accepted the same day, on the recommendation) lays out the options and picks: what one task is for a
  code change (recommendation: a group of files as the dispatch unit, per-file counts in the verdict),
  ordered steps with the baseline re-captured between them, "how many workers" meaning tasks rather than
  processes, and the **correction round** — one Opus-written note per task after the mechanical retry,
  fed by the verdict and never by raw output, against a per-run budget with a kill switch. Phase 10 owns
  the contract fields; Phase 12 owns the planner and the correction round. The Phase 10 prompt says so.
- **ADR-0045 — Haiku is the worker on machines with less than 24 GB installed**, and the `api` tier is a
  phase (13) before publish rather than a backlog item, because the owner's bar is *"people can use it on
  their code base with no problem"* and a 16 GB laptop where `sidecrew run` refuses is not that. Pinned by
  full model id; tier decided by installed RAM, never free RAM; accounting from the API's usage fields;
  its own Phase 11 run. `CLAUDE.md` #1 and `models.json` reworded to match.
- **The publication bar is now four DoD lines** in `VISION.md`: unmodified projects on both stacks with
  a frozen-rule number, both tiers, `doctor` naming every remaining failure with its remedy, and no
  changes required to the user's project. Phases renumbered again: 13 Haiku tier, 14 publish, 15 workload #2b
  (behind publish, since it is not in the bar), 16 more languages. Publish's DoD absorbs the four
  workload #1 hardening items from the prioritised list.
- **The edge ideas** — six ways to spend local compute so Opus spends less, ranked by whether a machine
  can check the result, each with its measurement and owner phase: local models read the codebase for
  Opus (Phase 12), fine-tune the 7B on its own survivors (17), memoise task → candidate by content hash
  (10 or 12), unattended mode (12), pool workers across a team's machines (17), two-model agreement as a
  review signal (17). `BACKLOG.md` § *The edge ideas*; Phase 17 added to the table; the owner's measure
  for all of them — *fewer tokens, faster, more precise, when users use Opus on its own* — is in
  `VISION.md` with "faster" said carefully.
- `PHASES.md`: the stale trailing sections ("12 — Workload #2 (proposed, not agreed)", which still said
  workload #1 had never completed on a real project, and "8 — Publish") are replaced with one section per
  phase 10–16.
- **`docs/plan/VISION.md`** — the destination, in the owner's words: the user asks for a change to their
  source and gets it at a quality the gate can vouch for; from inside it is Opus with local model
  employees. Unit tests are workload #1, not the product. `CLAUDE.md` now points at it first.
- **Publication moves behind workload #2** (ADR-0043), at the owner's call — "I don't want to make
  something half baked as my final product." Phases renumbered: 10 workload #2a, 11 its go/no-go, 12
  supervision, 13 workload #2b, 14 publish, 15 more languages. The cost is recorded rather than glossed:
  workload #1 sits unreleased, and six trials have each found something no amount of reading found.
- **`docs/plan/prompts/phase-10-workload-2a.md`** — behaviour-preserving changes, gated by the project's
  own suite plus `tsc`. The owner's example, *fix every TypeScript error in a large codebase*, is the
  best-fitting job in the design, so it is the one to build against. Its DoD includes controls for each
  cheap way to defeat the gate — `@ts-ignore`, deleting the line, editing the tsconfig — because that is
  the Goodhart surface for this workload.
- **Prioritised next steps** now live at the top of `PHASES.md`, ordered by evidence.
- `CLAUDE.md`'s opening states the general rule instead of the first workload: **one honest gate per
  workload is the unit of progress**, and a workload a machine cannot check does not belong here.

## Unreleased — the first React measurement, and the gate's hole measured on real output (2026-09-15)
The sixth trial confirmed there is no regression on project-a (module 1 reproduced attempt-for-attempt)
and produced **project-b at 4/10 = 0.40, median survivor mutation score 0.871** — the first survival
rate anyone has measured on a React project.

**ADR-0037's hole is now measured on real worker output, not a planted control.** `isSubsetDeep:happy_path:0`
— a candidate the worker actually wrote — fails `tsc` with TS2345 on a genuine generic-inference trap, and
**passes the project's own jest 7/7**. Under the old gate it would have been `compile ok · pass ok`, gone
to mutation, and `killed >= 1` was near-certain: the probe's far weaker test already killed 13 of that
function's 16 mutants. So the broken gate would have printed **5/10 where the fixed gate prints 4/10** —
one task in ten, on the first real plan. Withholding the rate last time was load-bearing rather than
cautious.

- **The derived-tsconfig path is no longer paid twice per candidate.** Whether a project needs widening is
  a property of the project, so it is learnt from the first candidate and reused; and a *failed* first run
  no longer triggers a widened re-run, which produced the same project errors for no information. Measured
  on a React project at ~40 s per `tsc`, that was the whole compile stage doubled for every attempt.
- **Errors from a program the candidate is not in now say so.** Reporting them as "did not compile" is the
  lie ADR-0033 was written about, arriving through a different door.
- **ADR-0041 — the exemplar host rule guarded the wrong kind of leakage.** It excludes a host that hands
  the worker *the answer*; a host that hands over *the opposite answer* is worse and does not look like
  leakage. Measured: a planner correctly refused two hosts as too close to `intersection` and chose its
  **complement**, whose four attempts all copied the exemplar's test verbatim — correct for intersection,
  `[]` for set difference. 0/2, reading as model error. A leaked right answer inflates a rate; a leaked
  wrong answer destroys a function's tasks and leaves nothing to tell you which happened.
- **ADR-0042 proposed, not implemented** — two of the ten `pass` failures assert contradictory results for
  the same call, which is checkable without running anything. Recommended: name it as an escalation
  reason. Explicitly *not* recommended without a separate decision: deleting the contradicted assertions
  and calling what is left a survivor.
- **`peak_rss_mb` is resident memory, not a footprint**, and the `run` summary said "peak worker RSS".
  ADR-0011 established this in Phase 1 and the field kept being read as the worker's size: the same pinned
  7B measures 4538 MB on a quiet machine and 170–243 MB on a busy one, while its weights alone are ~4.2 GB.

## Unreleased — the gate could pass a candidate it never checked (2026-09-15)
The fifth real-world trial produced the number the project has been working towards — **3/8 on an
project-a with nothing changed in it, median mutation score 1.00, and a second module independently at
3/8 for 6/16 across two modules and two export styles** — and, on the other project, found the worst
defect sidecrew has had.

- **ADR-0037 — the compile stage failed OPEN.** `testDirFor` picked `test/`; the project's tsconfig
  `include` was `["src", …]`; nothing had ever checked that the second covers the first. So
  `tsc --noEmit -p tsconfig.json` type-checked the project, **never opened the candidate**, and reported
  `compile ok` regardless. Reproduced here on `fixtures/ts-fixture/tsconfig.narrow-include.json`: a
  candidate carrying two `TS2322`s and a `TS2554` **survived with a mutation score of 0.8.** Every
  blocker before this failed closed — a crash, a missing plugin, zero candidates. This one manufactured
  a survivor and would have handed it to Claude as work that passed a real gate. `tsc` now runs with
  `--listFiles` and the candidate's path has to be in the program; when it is not, sidecrew writes a
  tsconfig extending the project's with the candidate added and checks again, and refuses loudly if it
  still cannot. A good candidate on that same project still survives at the same score.
- **ADR-0038 — the two ADR-0036 fixes did not compose.** The ts-jest shim guarded itself on
  `jest-config` resolving from the project root, and `jest-config` is a *transitive* dependency of jest,
  which pnpm's strict layout hides — so the fix was silently off on exactly the package manager the
  other fix exists to support. It now resolves in one hop from jest's own location, and the path is
  baked into the shim so the guard and the shim cannot disagree. When the mutation stage dies on
  Stryker's instrumentation anyway, the message names ts-jest as the cause instead of printing a page
  of errors about `stryMutAct_9fa48`.
- **ADR-0039 — `TYPE_POSITION` was a set of characters and a generic constraint opens its brace after a
  word.** `static isValidationError<T extends { isValid: boolean }>(` derived as the signature line
  alone, and the probe reported `NOT PLANNABLE — no mutants at all` about a function whose control
  kills a mutant. **That sentence has now been checked four times and been wrong four times.** Fixed,
  and flagged: the next time it is wrong, take the range from the TypeScript AST instead of patching
  the guess a fifth time.
- **ADR-0040 — `exportStyleFor` had no branch for `export class C { static f() {} }`**, so all 8 tasks
  of one module carried an import line that cannot compile. Fixed with a third export style. The
  trial's own workaround is the more useful finding: one sentence in the plan's `rules` beat the false
  hint **13/13**, so the baseline's "an imperative beats an example" is really imperative-versus-
  imperative, and `rules` is a usable lever.

## Unreleased — the fifth trial: a number on an unmodified project, and a gate that fails open (2026-09-15)
Two trials, one per stack, both against projects with **nothing changed in them**. Reports:
`experiments/real-world/results/project-a-2026-09-15-unmodified.md` and
`experiments/real-world/results/project-b-2026-09-15-unmodified.md`.

- **project-a: `3 / 8 survived, median mutation score 1.00`, on the unmodified project** — the number
  the previous trial could only reach by repairing the target, and the first quotable survival rate this
  project has produced. A second module, planned fresh, returned `3 / 8` independently: **6 / 16 = 0.375**
  over two modules, two export styles and two function shapes. All six predicted fixes confirmed by
  observation: the sandbox keeps `auth.config.test.ts` (352 files absent, all of them tests, zero source
  files); the probe finds `getSpendVsReplacement` at `[100,124]` with 18 mutants and 5/5 plannable;
  `plan-ranges.mjs` works on 5/5; Stryker survives the `.claude` symlinks via `ignorePatterns`;
  `.sidecrew-jest.config.cjs` runs the mutation stage with the project's own ts-jest untouched; and the
  TS2883 clone fires unaided at 32.4 s against a predicted 32.6 s. The run reproduced the previous
  trial's repaired run **attempt for attempt**, so the move from 0/8 to 3/8 is the fixes and not variance.
  The funnel now collapses at `pass` on both modules — 13 of the 19 attempts that compiled asserted
  something untrue, which is the model's fault and the failure mode worth having.
- **project-b: the pipeline runs end to end for the first time** — two earlier attempts produced zero
  candidates ever. Plugins load under pnpm by absolute path (ADR-0036 fix 2, built against six files,
  transferred to 576,606 lines unchanged), mutants are generated and killed, and the probe reports
  **11/11 plannable, 96 mutants** — the first measurement anyone has taken on that project.
- **…and the compile stage fails open there (proposed ADR-0037).** `testDirFor` resolves to `test/`,
  which the project's `tsconfig.json` does not `include`, so `tsc --noEmit -p tsconfig.json` type-checks
  the project and never opens the candidate. A candidate carrying two deliberate type errors came back
  **`SURVIVED`, `compile ok`, score 1.00**. The `compiles` conjunct of the survive contract is not
  enforced on such a project, and the verdict claims it is. **No survival rate is reported for
  project-b** for exactly this reason. Every earlier blocker on both stacks failed closed; this one
  fails open, which is worse for a tool whose whole claim is that Claude only sees what survived a gate.
- **Three more proposed ADRs, none fixed during the run** (no verifier was touched mid-trial):
  **ADR-0038**, ADR-0036's two fixes do not compose — the ts-jest shim is gated on `isResolvable("jest-config")`,
  which pnpm's strict layout hides, so fix 1 is disabled on exactly the package manager fix 2 exists for.
  **ADR-0039**, `TYPE_POSITION` does not know `extends`: `isValidationError<T extends { isValid: boolean }>`
  derives as a one-line range and the probe calls it unplannable; the hand-ranged control kills its mutant.
  That sentence — *"no mutants at all"* — has now been checked four times and been wrong four times.
  **ADR-0040**, `exportStyleFor` has no branch for a named `export class`, so all 8 tasks of the second
  module carried an uncompilable import hint — and one sentence of `rules` beat it **13/13**, which
  inverts the baseline's "an explicit imperative beats a demonstrated example" into a usable mitigation.
- Hygiene, both projects: throwaway branches never pushed, never merged, deleted; restored to
  `ai_optimization` with clean trees and byte-identical lockfiles; `node_modules` reinstalled from the
  committed lockfiles; **1,094 project-a tests (41 suites) and 544 project-b tests (20 suites) green
  afterwards**; `.sidecrew/` removed from both.
## Unreleased — an unmodified project, on both of the stacks that could not run one (2026-09-15)
Two blockers stood between sidecrew and somebody's untouched repo, one per stack. Both are now
**reproduced on fixtures in this repo** rather than only on a private codebase, which is what three real
trials never managed, and both are fixed (ADR-0036). Across three layouts — hoisted with ts-jest in
transpile-only mode, hoisted with ts-jest at its own default, and pnpm — the verdict is now the same one,
down to the mutant ids: `score 0.7, killed 5, survived 3, timeout 2, killed_ids [2,6,7,8,10]`.

- **ts-jest type-checked Stryker's instrumentation, so a stock NestJS project could not be mutated at
  all.** ADR-0028 found this and told the project to fix itself; two project-a trials then showed what
  that costs — the only run that produced a number had to edit the project to get it. sidecrew now writes
  a jest config **into its own sandbox** that loads the project's own config and turns ts-jest's
  diagnostics off, and nothing else. Nothing is lost: `tsc --noEmit` is the compile stage and Stryker's
  typescript checker filters the mutants, so the redundant third type check was the only one breaking.
  `fixtures/jest-fixture/jest.diagnostics-on.config.js` is the blocker, kept, and the slow suite asserts
  the verdict through it is identical to the verdict without it.
- **Stryker loads no plugins under pnpm, and it is not about hoisting.** Its glob resolves against
  **its own install directory** — under pnpm that is `.pnpm/@stryker-mutator+core@…/node_modules/
  @stryker-mutator/`, which holds `api`, `core`, `instrumenter`, `util` and neither the runner nor the
  checker. That is why the project-b trial's `public-hoist-pattern` attempt changed nothing: the glob
  never looks at the project's `node_modules`. sidecrew now names the plugins by absolute path, read from
  each package's own manifest because both are ESM-only, and **only when the glob cannot see them** — a
  hoisted project's config is byte-identical to what it was.

## Unreleased — the sandbox stops deleting the project's source (2026-09-15)
The project-a **re-run** confirmed, by observation on the project that motivated them, every fix
ADR-0033 and ADR-0034 made — `deriveLineRange` from 1.5 % to 99.2 % of that codebase's declarations, the
import hint from 2/20 to **16/16**, `src/modules/reports/` intact, the TS2883 clone firing unprompted —
and still reported **0/8**, because of one line ADR-0033 left as a footnote. With that one line fixed the
same run gives **3/8 at a median mutation score of 1.00**, sidecrew's own verdicts, no candidate edited,
against the baseline's hand-derived 4/10 at 0.774. The survival rate is flat; the survivors are not
(ADR-0035).

- **A test is a file nothing imports, not a file named like one** (ADR-0035). `TEST_FILE_PATTERN` matched
  a basename at any depth, so the sandbox deleted `src/modules/auth/auth.config.test.ts` — a NestJS config
  module the project's own `test/util/test.setup.ts` imports. `tsc` then failed on the project's own code
  and **12 of 16 attempts died on that one line and nothing else**, every one reported as "did not
  compile" about a candidate nobody read. The sandbox now follows the import graph and keeps whatever
  reaches a test-named file: measured at **1 rescued of 353 test-named, in 449 ms**, on 2,590 files.
- **`bodyRange` stopped at the return type.** `): { percentage: string; color: Colour } => {` balances on
  its own line, so the range closed at the signature — and the probe then said `NOT PLANNABLE — no
  mutants at all`, ADR-0016's own words for *drop this function*, about the most survivable function in
  the module (18 mutants, all 18 killed). A `{` after `:`, `|`, `&`, `<` or `,` is a type; skip the group
  and keep looking.
- **`scripts/plan-ranges.mjs` now calls `deriveLineRange`** instead of carrying the `export function`
  regex ADR-0033 replaced, which failed on 5 of 5 functions of that module. It is the script the planner
  agent is told to run. The fixture plans' committed `source_sha` values are unchanged.
- **Symlinked directories go into Stryker's `ignorePatterns`**, which is the blocker ADR-0033 enumerated
  and then neither fixed nor recorded: `ENOTSUP … copyfile '.claude/skills'` is a hard stop for any
  project that symlinks a directory, seen on both runs of this one.

## Unreleased — the sandbox repairs itself when TypeScript says it must (2026-09-15)
- **`node_modules` is cloned into the sandbox when, and only when, `tsc` emits TS2883** (ADR-0034).
  ADR-0004 symlinked it because "a copy per candidate would cost more than the mutation run"; the
  project-a control shows both that claim and its opposite are true of different projects — the clone
  is 18 s against that project's 104 s mutation stage and 6 s against the fixture's 6 s one. Cloning
  always took a fixture verdict from 10.9 s to 17.5 s. So: symlink first, upgrade on the one error that
  is about the sandbox rather than the candidate, and re-measured at 11.1 s for projects that never trip
  it. Without this the affected project scores 0 % and reports it as twenty compile failures.

## Unreleased — what the third real project broke (2026-09-15)
The project-a trial produced the first candidates sidecrew has ever had on somebody else's code, and
scored **0/10, every one "did not compile"** — with not one of the twenty failing because of anything in
the candidate. Six blockers, four of them sidecrew deciding what a project looks like (ADR-0033). With
them neutralised and only the import line rewritten, the same twenty give **20/20 compile and 0.40
survival at a median mutation score of 0.774**.

- **`deriveLineRange` knew one way to declare a function** — `export function NAME`, which is **23 of
  ~1,504 declarations (1.5 %)** on a NestJS codebase. Now eight shapes: exported and plain functions,
  `const` arrows, class methods, class properties holding functions. A *concise* arrow body is bounded at
  its own statement rather than brace-matched into the next function, which is the mistake ADR-0013 made
  expensive.
- **`importsHint` always wrote a named import**, so on a `export default class` module the prompt
  contradicted itself — a false `Import it like this:` line above an exemplar importing correctly. The
  measured result: **18 of 20 candidates followed the wrong instruction over the right example**, and the
  2 that did not were copies of that task's own exemplar. An explicit imperative beats a demonstrated
  example, essentially always — which qualifies ADR-0017's whole subject. `exportStyleFor` now reads the
  module.
- **The sandbox deleted `src/modules/reports/`** — five source files — because `NEVER_COPY` matched a
  directory name at any depth. Split: `node_modules`, `.git`, `.stryker-tmp`, `__snapshots__` nest and are
  skipped anywhere; `reports`, `dist`, `coverage`, `.nyc_output` are output only at the root. sidecrew's
  own mutation output moves to `.sidecrew-mutation/`, removing the collision entirely.
- **The probe could certify nothing, twice over**: `classifyProbe` never read `no_coverage`, so an
  all-`NoCoverage` result — "the runner never found the test" — printed as a weak probe; the probe
  hard-coded `.test.ts` and never called ADR-0032's `testSuffixFor`; and it wrote `"measured": true` over
  an empty array. All three fixed; the last one now refuses to write the file.
- **A candidate byte-identical to its exemplar counted as a survivor.** One did, and it would have been
  the run's headline result. `copied_exemplar` is a sixth tautology code, so the retry rule, the
  escalation queue and the review threshold all handle it without knowing about it.
- **Not fixed, deliberately**: the symlinked `node_modules` making `tsc` fail with TS2883 (the trial's
  control is decisive but the remedy is a trade nobody has measured), and ts-jest with diagnostics on
  being unable to mutate at all — where TypeScript 6 has since broken the very option ADR-0028 named.
- **Both fixes made on thin evidence held.** ADR-0032's `.spec.ts` naming, made from reading a `testRegex`
  rather than seeing it fail, produced **0 `NoCoverage` across 85 mutants**. Stryker's typescript-checker
  survives TypeScript 6.0.3.

## Unreleased — clearing the way for the third trial (2026-09-15)
- **The candidate is named the way the project names tests** (ADR-0032). `testSuffixFor` counts existing
  `*.test.*` against `*.spec.*` and follows the majority. Not cosmetic: the mutation stage runs jest under
  the project's own config, and a NestJS `testRegex: '.*\.spec\.ts$'` never matches `foo.test.ts` — jest
  finds nothing, every mutant is `NoCoverage`, nothing can survive, and it looks exactly like a test that
  covers nothing. Predicted in the recon before any run.
- **An out-of-memory stage is now a setup error naming the fix**, not a verdict. `tsc` on a 577k-line
  project dies at ~52 s on node's default heap while the project's own script asks for 8 GB; untreated it
  reads as "did not compile" and the retry rule pays for it twice.
- **Workload #2 is in the README**, where a reader will find it, with its honest label.

## Unreleased — workload #2 written down as a proposal (2026-09-15)
- **ADR-0031, proposed and not decided**: local models making code changes, which is the owner's stated
  direction and had existed only in conversation. Four options, the argument for each, and the two things
  that have to happen first — workload #1 completing on one real project, and the option being chosen,
  because A and B are different products with different gates. Phase 12 exists as a number, not a plan.
- The distinction the proposal turns on: **behaviour-preserving** changes (rename, null guard, migration)
  have a **free** oracle — the project's own existing test suite — while **behaviour-changing** ones need
  Opus to write a specification, which inverts the token economics *and* flips ADR-0006's Goodhart
  asymmetry the wrong way. A bad test is discarded by the gate; a bad implementation that passes the tests
  it was shown ships.

## Unreleased — the second real project, and the first one's diagnosis was wrong (2026-09-15)
- **The mobile trial blamed the project; it is Stryker** (ADR-0030). `ERR_REQUIRE_ESM` on
  `@babel/plugin-proposal-decorators` was attributed to the React Native project's Babel config, and
  `experiments/recon/` built a prediction on that attribution. project-b's Babel config has no such
  plugin and hit the identical error. One `pnpm why`: the plugin is a **direct dependency of
  `@stryker-mutator/instrumenter@10`**, at an ESM-only major, `require()`d through Stryker's own nested
  `@babel/core`. **Stryker 10 fails on every project.** 8.7.1 uses the CommonJS 7.24.7 and works, which is
  why both fixtures always have. Both fixtures now pin `^8` with the reason in `package.json`.
- **sidecrew does not work on pnpm projects.** With Stryker 8 the Babel error is replaced by "no Checker
  plugins were loaded": core lives in `.pnpm/` and cannot resolve its peers. Hoisting them does not fix
  it. **The sandbox is innocent** — reproduced running Stryker directly in the project, no sandbox, no
  symlink, which is the test worth copying when the tool and the environment are both suspects.
- **`classifyProbe` called a broken machine a function with no mutants.** Eleven pure array helpers came
  back "NOT PLANNABLE — no mutants at all"; what had happened was `tsc` running out of heap, with the
  mutation stage never reached. All four counts are zero in both cases, so the counts cannot tell them
  apart — and they mean opposite things: *do not plan this* against *fix your machine*. It now takes the
  stage and returns `not_measured`, quoting the error. This is the project's own failure mode in the
  project's own diagnostic, and it was caught only because the functions obviously had mutants.
- **The compile stage gets whatever heap node defaults to**, and this 577k-line project's own script says
  it needs 8 GB. `tsc` dies at ~52 s per candidate and the verdict is indistinguishable from a candidate
  that does not compile. `NODE_OPTIONS` from the caller does reach the stage; nothing reports that it is
  needed. In BACKLOG as a contract-shaped fix.
- **Two real projects, zero candidates.** Neither trial has produced a single piece of evidence about
  whether a local model writes good tests on real code — everything found is memory, module resolution
  and dependency layout. The headline claim still rests on two fixtures written by the author.

## Unreleased — what the first real project broke (2026-09-15)
- **`run` guessed which model a worker had loaded, and the guess swapped the weights** (ADR-0029). `serve`
  writes its record relative to the directory it ran in; `discoverWorkers` read it relative to *its*
  directory; with no record it fell back to the first entry of `/v1/models` — which is the Hugging Face
  cache catalogue, not the loaded model, and which lists the **14B first** on this machine. The first real
  trial therefore generated all 23 candidates on an unpinned 14B, on a machine `doctor` had just told it
  had no room for one, with every candidate recording the wrong model and an empty revision.
  `doctor.ts` and `bench.ts` both carry comments explaining exactly this mechanism. Neither was applied in
  `batch.ts`. Now: the record is the only authority, a single-model catalogue is still usable, and anything
  ambiguous **refuses** and names the way out. `SIDECREW_DIR` points at worker state across trees.
- **Every hoisted workspace looked empty.** `doctor` checked `<project>/node_modules/<pkg>` as a path and
  the verifier demanded a `node_modules` inside the project. npm/yarn/pnpm workspaces hoist — the trial's
  workspace had *zero* entries of its own and resolved everything from the repo root. So doctor reported
  every dependency missing and the verifier refused to run, and the protocol says to stop when that
  happens. Now resolution is `createRequire().resolve` from the project, the sandbox symlinks the resolved
  `node_modules`, and a hoisted binary reports "resolves, version not read" rather than missing.
- **`probe-mutants` could not run on a Jest project** — it passed `vitest` unconditionally, so the
  protocol step that establishes the denominator was unexecutable. `--runner` now exists. The trial has no
  mutant-density number as a result, and says so.
- **A run no longer spends twelve minutes on a plan already reported invalid.** `runBatch` does the
  structural half of validation first — the half that costs nothing. Exemplar verification stays
  `sidecrew plan`'s job, because it costs a verdict per shape.
- **`sidecrew serve --help` started a worker.** Asking a question performed the action.
- **The trial's structural blocker is not fixed and not worked around**: Stryker's instrumenter
  `require()`s `@babel/plugin-proposal-decorators` through its own nested `@babel/core` and gets an
  ESM-only build. Every React Native project with MobX-State-Tree and every NestJS project will hit it.
  In BACKLOG with the error and three possible directions, none measured.
- **What worked, on a real 452k-line monorepo**: compile **23/23** at a 10.8 s median (the recon projected
  9.8 s), 0 tautologies, 12 min 08 s for 18 tasks. The ten pass failures cluster on four functions whose
  *source* is surprising — one has a special-case branch its own regex makes unreachable. The model wrote
  the test the code looks like it deserves.

## Unreleased — Phase 9, runners (2026-09-15)
- **Jest beside Vitest, because two of the three stacks this is for default to it** (ADR-0028). React
  Native and Nest both use Jest; `verifyTs` hard-coded `vitest run <file>` and `testRunner: "vitest"`, so
  sidecrew could not have verified a single candidate in either. `TsTarget.runner` comes off the plan's
  `test_framework` through `runnerFor`, which refuses a framework the verifier cannot drive **by name**
  rather than failing three stages later looking like a bad candidate.
- **`jest --ci --runTestsByPath <file>`.** The flag is load-bearing: it takes the path literally instead
  of matching the project's `testMatch`, which is the difference between working on any project and
  working on projects whose config happens to agree with where sidecrew writes the candidate. No
  `--passWithNoTests` — a run that executed nothing must fail (ADR-0006).
- **`enableFindRelatedTests: false`**, because a project whose module resolution jest cannot follow
  relates the mutant to no tests and returns `NoCoverage` for every one — indistinguishable from a test
  that covers nothing.
- **`doctor` gained a `stryker-runner` row.** Stryker drives a runner through a separate plugin package
  that must be installed in the *target* project; without it a mutation run dies minutes in with an error
  about Stryker. `verifyTs` now refuses up front as a setup error, so the retry loop cannot spend an
  attempt on it.
- **Measured: the runner is a seam.** Same plan, model, revision and seed, one runner swapped — 3/5 either
  way, the same three survivors at the same scores, the same two escalations. `fixtures/jest-fixture` is
  deliberately CommonJS/Node against ts-fixture's ESNext/Bundler, so this is not a vitest-shaped project
  with one field changed.
- **ts-jest was type-checking Stryker's own instrumentation**, and every candidate failed the run stage
  with a page of errors about a file nobody wrote. Transpile-only fixes it and costs nothing — the
  pipeline type-checks in a stage of its own and Stryker type-checks the mutants. Fourth time the first
  real run of something has found a fault that looked exactly like model failure.
- **A latent circular import is gone**: `doctor → verifier/ts → concurrency → serve → doctor` left
  `DEFAULT_VERIFIER_CONCURRENCY` undefined at import time. `TestRunner` and `STRYKER_PLUGIN` moved to
  `verifier/shared.ts`.
- **`experiments/recon/project-c-mobile.md`** — a real React Native monorepo, surveyed read-only: 452,464
  lines across 2,358 files, Jest 30 with `jest-expo` everywhere, no Vitest, no Stryker, ~5 % coverage, and
  574 exported functions in its utility layer. `tsc --noEmit` over one workspace costs **9.8 s**, which is
  22× the fixture's compile stage and re-prices the whole pipeline.
- **`experiments/real-world/README.md`** — a frozen protocol for running sidecrew against somebody's real
  codebase on a throwaway branch, written before any such run so that its result cannot be chosen after
  the fact.
- **Publishing moved behind runner support**, at the owner's call. Phase 8 is now Phase 10.

## Unreleased — Phase 7, hardening (2026-09-14)
- **The retry prompt is its own template, and a retry that would ask the same question is not spent**
  (ADR-0022). `src/prompts/retry.md` holds the failure block; the prompt is `worker.md` rendered plus
  `retry.md` rendered, so a first attempt is byte-identical to what one template produced before the
  split — asserted against the pre-split ablation variant rather than claimed. That matters because
  `worker.md` is pinned to the variants that measured it (ADR-0017, ADR-0021), which meant the retry
  wording lived inside a file nothing may edit without rerunning an ablation that does not measure it.
  And `runBatch` now compares the two rendered prompts before spending the retry: generation is
  deterministic, so an identical prompt yields an identical candidate and an identical verdict — 7 s of
  Stryker on TypeScript, 28 s on Swift, for a foregone conclusion. Phase 4's BACKLOG noticed it; nothing
  had acted.
- **The escalation queue is appended as the run goes** — `.sidecrew/runs/<id>/escalations.jsonl`, one
  JSON object per line (ADR-0023). `BatchResult.escalations` is written when the run finishes, and Phase
  4's own note has the failure mode: an exception rejected the `Promise.all` and twenty minutes of Swift
  left no result at all. A line is atomic enough that a run killed mid-append loses one escalation rather
  than the queue, and `readEscalations` skips what it cannot parse for the same reason.
- **A task that throws no longer takes the run with it.** It is recorded as that task's last attempt,
  escalated, and the queue keeps moving — honest only because the queue is on disk as it happens. A
  `VerifierSetupError` or a `PlanError` still stops everything, because those are true of every remaining
  task too, and finding that out twenty times is not resilience.
- **`sidecrew escalate` / `sidecrew_escalate`** join the queue back to the tasks and hand Claude the
  question the worker was asked — the *first* attempt's `WorkerTask`, never the retry's, which already
  carries a compiler error. `suggested_model` is `sonnet`. It does not call Claude and will not: sidecrew
  has no Anthropic client, and ADR-0001 is that it must never grow one by accident.
- **Survivor review is routed rather than dumped** (ADR-0024). `sidecrew review` / `sidecrew_review`
  select survivors below a mutation-score threshold plus a deterministic 10 % audit sample of the rest,
  weakest first, batched under a token cap. Three decisions a sentence of prose had been hiding:
  **the threshold is per language** — 0.6 on TypeScript, **1.0 on Swift**, because nine of fifteen
  survivable Swift fixture functions have exactly one mutant so a Swift survivor scores 1.00 by
  construction and 0.6 there selects nothing; **the audit sample is `sha256(run_id:task_id)`**, not
  `Math.random`, so asking twice about one run asks about the same tests; and **the cap splits rather
  than drops**, because the item it would drop is the longest survivor, which is the one most likely to
  be doing something odd.
- **The memory gate asks the kernel too** (ADR-0026). `vm_stat`'s free pages are necessary and not
  sufficient: under pressure macOS compresses and evicts, so the free count *rises* while the machine
  gets worse — ADR-0011 from the direction Phase 6 hit it, where `ps` reported 205 MB for a 7B under
  9.5 GB of swap. `serve` now refuses at `kern.memorystatus_vm_pressure_level` warn or critical however
  free the machine claims to be, and `unknown` is neither a pass nor a refusal. **`--wait SECONDS`
  queues** for room instead of refusing once; it never lowers the bar, because a queue that eventually
  says yes to a machine with no room is a gate with a timeout.
- **Thermal back-off, with a measured baseline or not at all** (ADR-0025). Decode rate more than 30 %
  below `sidecrew bench`'s `decode_tok_s` for a rolling two minutes retires one worker slot, and the
  retired runner stands down after finishing what it holds. No bench for that model means no guard, said
  in one line — calibrating on the run's own first candidates would calibrate on the ~4 s of graph
  compilation the bench's warm-up request exists to exclude. Three guards against a false positive: at
  least three samples, a window that actually spans two minutes, and a back-off that clears the window so
  the second step costs another two minutes of evidence. Concurrency never goes back up, and
  `throttle.json` records every event.

  **Measured afterwards** (`npm run measure:thermal`, 22 minutes, `experiments/thermal/`): this M2 Pro
  **on mains** held a median of 40.5 tok/s across 129 requests — the baseline to the decimal — so research
  §E's sag did not reproduce and the guard correctly did nothing. One 90-second dip to 25.8 tok/s arrived
  at minute four and left; **four of its seven requests were below the 28.3 tok/s floor on their own** and
  the guard still declined, because the two-minute *median* only reached 30.5. That is the window earning
  its place on real data: a rule reading single samples would have retired a worker slot for the rest of a
  run on ninety seconds that went away. **It has still never fired**, so nothing downstream of a back-off
  has executed — BACKLOG now says exactly what that leaves untested and why CI cannot cover it. The first version of the
  two-minute check **could not fire at all** — it asked whether the *retained* window spanned two
  minutes, which the window filter makes impossible except by luck of sample spacing, and it passed a
  suite that fed samples on a grid landing exactly on the boundary. Found by reading it back — and the
  soak above is the run it could not have survived, since its worst window is exactly the kind of
  irregular spacing that check got wrong.
- **An unpinned revision is a refusal, not a warning** (ADR-0027). `resolveForServe` has always computed
  the right answer; `serve` printed it above several minutes of model loading, where nobody reads it.
  What it says is that every number this worker produces is incomparable with every number the last one
  produced (non-negotiable #4). `--allow-unpinned` is the escape — the first run on a new machine has an
  empty cache by definition — and it says in as many words that the worker is not reproducible.
  `bench --allow-unpinned` threads the same flag.
- **`--dry-run` now builds the prompts too**, to `.sidecrew/runs/<id>/prompts/`, and reports the estimated
  prompt tokens. A `WorkerTask` says what the worker will be told; the prompt is what it receives, and the
  two differ by every conditional in the template.
- **Two new contracts in the spec**, `EscalationBatch` and `ReviewQueue`, parsed by `test/schemas.test.ts`
  like every other shape. Two new MCP tools, seven in all.
- **`claude/.claude-plugin/plugin.json` exists**, which it did not; CI now checks `package.json`,
  `server.json` and it agree, and a test pins the MCP server's `SERVER_VERSION` to the package's — the one
  copy a compiler cannot see. All four at **0.0.2**.
- **Something finally tests `claude/skills/`.** Phases 3, 4 and 5 each noticed the same gap by reading:
  `references/verifier.md` carried a superseded score formula for two phases, and said a tautology gets no
  retry when the code has always retried one. `test/skill-docs.test.ts` greps the reference docs for the
  survival rule, the score formula, the stage names, the conditions that skip the retry and the review
  thresholds, and checks that SKILL.md names no MCP tool the server does not register.

## Unreleased — after the go/no-go, before Phase 7 (2026-09-14)
- **The worker prompt names the owning type, and only when that is not already obvious** (ADR-0021).
  Phase 6's Swift collapse was the 7B inventing where a function lives — `SwiftFixture.percentChange`
  from the import hint, where the exemplar plainly showed `Numbers.clamp(...)`. `signature` has carried
  the qualified name since Phase 0 and the prompt never rendered it. Measured before shipping, same
  tasks, seed 42, no retry:

  | fixture | shipped | + qualified name |
  |---|---|---|
  | Swift (18) | 4 · 0.222, 6 compiled | **7 · 0.389, 12 compiled** |
  | TypeScript (20) | **17 · 0.850** | 16 · 0.800 |

  So it is conditional on the *mechanism*, not the language: the clause renders when the signature is
  qualified with an owner and vanishes when the function is top-level, because on TypeScript's
  unqualified signatures the line repeats what the source and the import hint already said — and that
  redundancy cost a task. A TypeScript class method gets the line for the same reason Swift does.
  The clause is an inline section, so the rendered bytes are *exactly* one of the two arms that were
  measured; `test/prompt.test.ts` asserts that byte-equality rather than claiming it, and Phase 5's
  "the shipped prompt is the ablation winner" guard is narrowed to the unqualified rendering rather
  than deleted.
- **Through the whole pipeline, Swift goes 4/18 → 9/18** (`partials/c2-swift-signature.json`), compiles
  5 → 14. **It is still a NO-GO**: 0.500 against Haiku's 0.778 is 0.64, short of the 0.75 floor. The
  largest single cause is fixed and the language still does not clear the bar; what is left mostly
  fails at `pass`, so the 7B now writes Swift that builds and asserts the wrong answers.
- **`--tag` keeps a re-measurement beside the frozen record instead of on top of it.** `--report` and
  `--recompute` read only the eight cells the protocol defines, so a follow-up run cannot quietly
  rewrite the verdict the experiment was frozen to produce.
- **The decision rule's fourth cell is named: CONDITIONAL GO** (ADR-0020), as a dated amendment *below*
  the frozen rule in `experiments/go-no-go/README.md`, which is left byte-for-byte intact so Phase 6
  stays readable against the rule in force when it ran. In the 75–89 % band with the 14B failing to
  rescue it: ship the local tier with the measured rate in the README, keep the api tier as the
  documented escape — and **do not call it a GO**, because the bar was 0.90 and a bar that relocates to
  wherever the result landed is not a bar. It carries a guard: it holds only while the local tier's
  survivors score no lower than the control's on mutation, because this run showed survival rate alone
  scoring a test that agrees with the bug above one that catches it. `--report` applies the cell, so a
  future run in it gets a verdict instead of a gap. **TypeScript is CONDITIONAL GO; Swift stays NO-GO.**
- **`generate` now refuses zero completion tokens for output it actually received** (ADR-0019). The old
  guard asked "did the server send usage?", which the Apple shim answers yes to while reporting
  `{0, 0}` for a 600-character test file — a fiction that reached `Candidate.usage` looking exactly like
  a measurement. The floor is arithmetic, not judgement: non-empty output cannot have cost zero tokens.
  An empty answer reporting zero is still accepted, because that one is consistent and fails the compile
  stage on its own.
- `scripts/signature-ablation.ts` (`npm run measure:signature-ablation -- --fixture swift|ts`) recomputes
  Phase 6's **first-attempt** numbers from its stored records for the comparison, rather than quoting
  headline figures that included the retry — the ablation is no-retry, and comparing across that
  difference would credit the wording with what the retry did.

## Unreleased — Phase 6: the go/no-go (2026-09-14)
- **The experiment ran, on both fixtures, in four configurations.** `scripts/go-no-go.ts`, the protocol
  in `experiments/go-no-go/README.md` unedited, all nine Phase 5 plans re-validated before the first
  token. Results in `experiments/go-no-go/results/go-no-go-2026-09-14.json` (`"measured": true`), one
  page in `results/REPORT.md`, one partial per configuration × fixture, and every candidate kept.

  | | TypeScript (20 tasks) | Swift (18 tasks) |
  |---|---|---|
  | C1 Apple Foundation Models | **3/20** · 0.15 | **0/18** · 0.00 |
  | C2 Qwen2.5-Coder-7B-4bit | **17/20** · 0.85 | **4/18** · 0.22 |
  | C2b Qwen2.5-Coder-14B-4bit | **17/20** · 0.85 | **2/18** · 0.11 |
  | C3 Claude Haiku (network control) | **20/20** · 1.00 | **14/18** · 0.78 |

  Worker tokens: **0** for C1, C2 and C2b, enforced by the schema rather than asserted. Median
  end-to-end per candidate: C2 14.6 s / 38.8 s against C3 27.5 s / 67.0 s, so `L(C2) ≤ L(C3)` holds on
  both fixtures and contributes nothing to the decision.
- **Swift: NO-GO (revisit).** 0.29 of Haiku, below the 0.75 floor, and the 14B does not fix it — it is
  worse. Thirteen of eighteen C2 candidates never compiled, and the 14B managed fourteen.
- **TypeScript: not a go, and a hole in the rule (ADR-0020).** 0.85 of Haiku puts it in the 75–89 %
  band, where the rule's escape hatch is a 14B that clears 0.90 — and the 14B scored the identical
  0.85, on the identical three tasks. No named outcome covers "in the band, and the bigger model does
  not help". Recorded as a gap rather than rounded to the nearest verdict; the protocol stays frozen.
- **The 14B is never the right trade on this evidence.** Same score on TypeScript, worse on Swift,
  2.2× the generation time (11.8 s against 5.3 s median) and 8.2 GB against 4.5 GB. The README's
  standing preference for 7B × N now has a measurement behind it.
- **The Swift collapse is a capability difference, not a missing instruction.** Every fixture function
  is a static member of an enum. Given the same prompt — whose exemplar calls `Numbers.clamp(...)` in
  plain sight — Haiku writes `Numbers.percentChange(...)` and the 7B writes
  `SwiftFixture.percentChange(...)`, reaching for the module name in the import hint. Genuine Swift
  errors remain behind it (`type 'Any' cannot conform to 'Equatable'`, an invented `expectThrows`
  macro), so no one sentence would have rescued the fixture. `signature` already carries the enclosing
  type and `src/prompts/worker.md` never renders it: a Phase 7 change with an ablation behind it, not a
  mid-run tune (BACKLOG).
- **C3's 20/20 includes a task it survived by not doing it.** Haiku's `truncate:boundary` never asserts
  `text.length === maxLength` — the one input class the fixture's planted off-by-one gets wrong — so it
  survives by agreeing with the bug, while C2 failed the same task by asserting the correct answer.
  C2's TypeScript survivors score a median **1.00** against C3's 0.917. ADR-0006's warning, now visible
  as a difference *between* configurations.
- **Apple Foundation Models fails by copying the exemplar**, returning the exemplar's `slugify` test
  when asked for `titleCase`. The 4K context is the second problem, not the first: four generations
  returned HTTP 500 `Exceeded model context window size`. It is also **not deterministic** — three runs
  of one task at temperature 0 with `seed: 42` gave three different files, because Apple's API has no
  seed. The 14B, checked the same way, was 3/3 byte-identical.
- **ADR-0019: the shim's streaming endpoint returns no content at all** — one empty delta and `[DONE]`.
  The first C1 attempt was 0/20 with every candidate empty and the determinism check passed 3/3 on
  empty strings. Its non-streaming path works but reports `{prompt_tokens: 0, completion_tokens: 0}`
  for a 600-character answer, which would sail past `generate`'s "no usage block" guard and land in
  `Candidate.usage` as a measurement. C1 runs non-streamed in the experiment script only — never in
  `src/worker.ts` — has no TTFT, and its token columns are null. Hardening the production guard against
  zeros is Phase 7's (BACKLOG).
- **A latency definition bug, found and fixed before the report.** End-to-end latency was wall-clocked
  around the verify pass, which for C3 — whose generation happens in a subagent beforehand — left
  generation out and reported the slowest configuration as the fastest (9.7 s against a true 27.5 s).
  It is now the sum of a task's attempts' generate + verify, one definition for every configuration,
  and `--recompute` re-derives it from per-attempt numbers already measured rather than re-running the
  verifier for noisier ones.
- **No peak-RAM claim should be taken from this run**, and the run is why. `ps` RSS came back as 205 MB
  for the 7B and 718 MB for the 14B, models whose weights are 4.0 and 7.7 GB. The machine held
  5.5–13.8 GB free and 6.6–9.5 GB of swap throughout, with Xcode and two simulators open as the
  protocol asks, and under that pressure macOS compresses and RSS falls — ADR-0011 observed from the
  opposite side. Every partial records `machine_before` / `machine_after` so the variance is visible
  rather than averaged away.
- `.claude/agents/haiku-worker.md` registers the agent C3 names. An agent file added mid-session is not
  picked up by a session already running, so this run went through `general-purpose` with
  `model: haiku` carrying the same role text; a fresh session runs the named agent.

## Unreleased — Phase 6 prerequisites (2026-09-14)
- **The Swift fixture is planned.** Five plans — `Strings`, `Numbers`, `Arrays` on XCTest, `Machine` and
  `Async` on Swift Testing — covering **10 functions in 18 tasks**, every exemplar verified. Both
  frameworks on purpose: ADR-0005's kill-attribution wrapper is the most expensive thing in the Swift
  verifier and a plan set that never used Swift Testing would leave it unexercised outside a slow test.
  `stateful_sequence` is exercised at last, on `Machine.applyAll`.
- **`scripts/probe-mutants.ts` (`npm run measure:mutant-probe`)** answers the question ADR-0016 left the
  planner unable to answer: which functions can be survived at all. **15 of the Swift fixture's 21**,
  and the six that cannot fail in three different ways —
  `experiments/mutant-probe/results/swift-*.json`, `"measured": true`.
- **The first version of that probe was wrong, and the way it was wrong is the finding.** It called
  anything with a mutant plannable, which marked `gcd`, `rotate` and `nextState` plannable on zero kills.
  They are not: their only mutant **crashes**, and `killed` counts only mutants a test reported a
  *failure* against — a crash lands in `timeout`, counts towards the score and never towards survival
  (ADR-0005 §2). `Machine.nextState`'s single `SwapTernary` mutant force-unwraps nil, so no test of it
  could ever survive. `classifyProbe` is now four-valued — `yes` / `no_mutants` / `crash_only` /
  `unknown` — lives in `src/verifier/probe.ts`, and has its own tests.
- **A Swift survival rate and a TypeScript one are not the same measurement** (ADR-0018). Nine of the
  fifteen survivable Swift functions have **exactly one** mutant, so `killed ≥ 1` demands a perfect
  score; the TypeScript median is about eight and killing any one suffices. The survival rule is
  unchanged — weakening it per language would make every number incomparable with itself over time — but
  the go/no-go's decision rule is now explicitly per fixture and the two rates are never averaged.
- **A fixture asymmetry that would have biased the comparison.** `Strings.swift` spelled out the planted
  off-by-one in `truncate`'s own doc comment, and `line_range` starts at the doc comment — so that
  sentence would have reached the Swift worker in `WorkerTask.function.source` while the TypeScript
  worker got nothing. It now lives in the Swift fixture's README, where the TypeScript one has always
  kept it, for the reason that README already gave: a worker model reads the source.
- **An exemplar must not advance itself through a sibling the mutant can crash.** The first
  `stateful_sequence` exemplar walked the machine by calling `Machine.nextState`, which force-unwraps
  behind a `canTransition` guard; the mutant of `canTransition` crashed it, the process died before the
  already-failing `#expect` was reported, and a correct test came back `killed 0`. `sidecrew plan`
  caught it before a token was spent, which is what it is for.
- **`sidecrew bench` no longer overwrites a measurement.** `refuseToClobber` turns an existing results
  file into an error naming `--tag`. Phase 6 runs three or four configurations, mostly on one day, and
  then compares them; a forgotten flag used to mean comparing a number against itself.
- `experiments/go-no-go/README.md` now states the inputs that exist, the denominators and why they are
  not 21, and that `S(x)` is per fixture.

## Unreleased — Phase 5 (2026-09-14)
- **The shape taxonomy is fixed and small.** Six kinds in `docs/specs/pipeline.md`, each with the
  question it asks and what its `rules` string should say, and **1–3 shapes per function** now enforced
  by `zod` rather than requested in prose — one because a function nobody asks a question about does not
  belong in a plan, three because the fourth shape on a small pure function is where a planner starts
  inventing questions and every shape costs a generate → verify round.
- **`sidecrew plan <plan>` / `sidecrew_plan_validate`.** `src/validate.ts` reports where `loadPlan`
  throws: fourteen typed codes, every problem at once rather than the first, and `valid` only when every
  exemplar has itself compiled, passed, killed a mutant and come back non-tautological. `verify_exemplars:
  false` is the fast structural pass and the report *says so* — `checked.exemplars: 0` on its own would
  read as "there were none". A stale `source_sha` is a **warning** here and a refusal in
  `sidecrew_run_batch`: validation describes, the thing about to spend tokens decides.
- **Four plans over the TS fixture, written by the planner and validated for real**: 14 functions, 20
  function × shape tasks, 8 exemplars, all surviving. `meta.planner_tokens` is read out of Claude Code's
  own usage record by `scripts/planner-tokens.mjs` — **129,234** for the pass, excluding cache reads,
  which were 5.4 M and are the same context re-sent rather than new work.
- **The prompt ablation contradicted the assumption the phase exists to exploit** — 20 tasks,
  qwen2.5-coder-7b-4bit, temperature 0, seed 42, no retry
  (`experiments/go-no-go/results/prompt-ablation-2026-09-14.json`, `"measured": true`):

  | variant | survived | compiled | median score of survivors | completion tokens | generate |
  |---|---|---|---|---|---|
  | bare | **4/20** | 5/20 | 0.93 | 248 | 7.7 s |
  | bare + one sentence: import the test framework | **16/20** | 20/20 | 0.93 | 258 | 9.6 s |
  | bare + the exemplar | **15/20** | 20/20 | **1.00** | 218 | 6.9 s |
  | bare + the exemplar + the shape rules | **17/20** | 20/20 | **1.00** | **150** | **5.3 s** |

  Every one of bare's 15 compile failures was the same missing line — `import { describe, it, expect }
  from "vitest"` — and exactly the five candidates that had it are the five that compiled. The fourth row
  did not exist until that was found; it is one sentence and nothing else, and it scores **one above the
  full exemplar**. `exemplar+rules` still wins and ships unchanged, but the reason to keep it is no longer
  the survival rate: survivors score 1.00 against 0.93, on 150 completion tokens against 258 and 5.3 s of
  generation against 9.6 s. ADR-0017; 16/15/17 is one or two tasks at n = 1 and is not a ranking.
  `test/prompt.test.ts` now asserts `src/prompts/worker.md` is byte-identical to the winning variant, so
  editing the prompt without rerunning the ablation fails a test.
- **An exemplar names the function it tests** (ADR-0015). Verifying one means mutating that function's
  lines, and an exemplar is deliberately about a function `functions[]` omits, so nothing in the plan
  said which. `TestShape.exemplar_function`, required; `WorkerShape` omits it alongside `exemplar`, so
  the worker never receives a second function name to confuse with the one it was asked about. Every plan
  written before today stops parsing, which cost exactly one plan.
- **Under strict TypeScript, some functions have no mutants at all** (ADR-0016). Measured on
  `fixtures/ts-fixture/src/machine.ts`: `canTransition` has 3 mutants and all 3 die; `nextState` and
  `applyAll` have **zero** — Stryker generates them and its type checker drops every one as a type error,
  because `?? → &&` changes the return type and an emptied body returns nothing. So only one function
  there is mutation-testable, it cannot both host the exemplars and be planned, and **the module has no
  plan**. ADR-0005 predicted this was reachable on TypeScript; it is pinned in
  `verifier-ts.slow.test.ts` so a future Stryker or tsconfig change shows up as a failed test rather than
  as an unexplained improvement in survival rate.
- **`scripts/plan-ranges.mjs`** computes `line_range` and `source_sha` together, starting at the doc
  comment: comments carry no mutants so the scope is unchanged, and `WorkerTask.function.source` is
  sliced from the same range, which hands the worker the sentence stating the contract. Typing either by
  hand is how a run ends up mutating the wrong lines.
- `fixtures/ts-fixture/test_plan.json` and `exemplars/` moved to `plans/<module>/`, one plan per module.
  `claude/agents/test-planner.md` is the loop that produces them; `sidecrew plan` is what it is held to.

## Unreleased — Phase 4 (2026-09-14)
- **The pipeline runs end to end.** `runBatch(planPath, {concurrency, dryRun})` walks a `TestPlan`
  function × shape, generating on a local worker and verifying each candidate, retrying once with the
  error appended and escalating what is left. `.sidecrew/runs/<id>/` holds one JSON per task, candidate
  and verdict plus `result.json`; the MCP tool returns only the `BatchResult`, so Claude sees survivors
  and escalations and never raw worker output (CLAUDE.md #3).
- **Measured, on the baseline M2 Pro / 32 GB with one 7B worker up and Xcode open** — six tasks over
  `fixtures/ts-fixture/src/strings.ts`, `.sidecrew/runs/2026-09-14T10-24-26Z-strings/result.json`:

  ```json
  "config": { "worker_kind": "local", "worker_model": "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
              "concurrency": 1, "retry": 1 },
  "stats": {
    "tasks": 6, "survived": 6, "retried": 0, "escalated": 0,
    "funnel": { "compiled": 6, "passed": 6, "killed_ge_1": 6, "non_tautological": 6 },
    "latency_ms": { "median": 13751, "p90": 28745 },
    "peak_rss_mb": 4467.4,
    "claude_tokens": { "planning": 0, "workers": 0, "review": null }
  }
  ```

  13.8 s median per task end to end — generation *and* a verdict — against the 7.2 s a verdict alone
  cost in Phase 2, so generation is roughly half a task. **Zero Claude tokens for generation**, and the
  schema is what enforces that rather than the sentence: a `local` run with a non-zero
  `claude_tokens.workers` does not serialise.
- **6/6 is not the good news it looks like, and the run says so if you read it.** `truncate`'s boundary
  candidate survived with a score of 0.92 while never testing the boundary that carries the fixture's
  planted off-by-one — it asserts `truncate("Hello", 4) === "Hel…"` and never asks what happens at
  `text.length === maxLength`, which is the one input class the source gets wrong. A test can kill
  every mutant of a function and still say nothing about its bug. This is ADR-0006's argument arriving
  on its own, in the first real run, which is why survivors below the review threshold still get
  Claude's eyes and why `/sidecrew run` is told not to report a survivor as a good test.
- **The first run failed 6/6 for a reason that had nothing to do with the model.** mlx_lm 0.31.3
  streams `<|im_end|>` as *content* at the end of every Qwen completion, so every candidate arrived
  with the end-of-turn token appended after its closing markdown fence; the fence stripper's anchor
  missed, the fence stayed, and six verdicts came back reading exactly like a 7B that cannot write
  TypeScript. `extractTestSource` now strips the end-of-turn markers before unwrapping a fence, and
  `test/batch.test.ts` has the case. Left alone it would have been a discard rate reporting on a
  serving detail — the same failure mode `fixtures/ts-fixture/README.md` avoids by choosing a module
  resolution the model was not told about. Worth stating plainly: nothing in the code changed about
  generation between 0/6 and 6/6.
- **ADR-0014 is decided: a Swift candidate's test target is named in the plan.** `TestPlan.test_target`
  is optional and Swift only, `sidecrew verify --test-target` overrides it, and `verifySwift` keeps
  refusing a multi-target package that nobody named a target for rather than picking one. The schema,
  the spec and the ADR moved in one commit, as CLAUDE.md asks. `test/schemas.test.ts` pins the field
  directly rather than by adding a Swift-only key to a TypeScript example.
- **Concurrency is a function now, not a constant in two places.** `planConcurrency` takes the model's
  measured footprint plus `serve`'s own 2 GB headroom as one slot (ADR-0011), divides free RAM at the
  instant the run starts by it, and splits the result between candidates in flight and test processes
  per verification — `workers × verifier ≤ slots`. On the baseline machine with one worker up that is
  1 × 2, which is exactly the 2 `DEFAULT_STRYKER_CONCURRENCY` was measured at in Phase 2; that constant
  is now an alias for the same definition rather than a second copy of the number.
- **Four MCP tools**, `sidecrew_status/generate/verify/run_batch`, with the contract's own zod schemas
  as their inputs so a tool cannot accept something the pipeline would later refuse. Verified from a
  clean install — `npm run build && npm link && claude mcp add --scope user sidecrew -- sidecrew mcp`,
  then `claude mcp list` reporting ✔ Connected and a real `tools/call` over stdio returning a
  `StatusReport` with the loaded model and its pinned revision.
- `sidecrew run`, `sidecrew verify` and `sidecrew generate` on the CLI, over the same functions.
  `verify` exits non-zero on a candidate that did not survive, because it is what a planner loop and a
  pre-commit hook both need in an exit code. `--dry-run` writes the tasks, reports the concurrency and
  the reason for it, and stops before the first token.
- **A run refuses a stale plan before it spends a token.** `source_sha` is defined in the spec as the
  sha-256 of the function's text as `line_range` slices it, and `runBatch` recomputes it: ADR-0013
  scopes mutation to that range, so a stale range does not merely describe the wrong function, it
  mutates the wrong lines and returns a verdict about code nobody asked to test.
- **`doctor` and `sidecrew_status` answer about the project they are pointed at.** `--project` /
  `project` reports `tsc`, `vitest` and `stryker` from *that* package's `node_modules` — the toolchain
  a verdict actually depends on (ADR-0004's sandbox symlinks it). The lie noted at the end of Phases 2
  and 3 is fixed: on this repo `doctor` said `stryker MISSING` while the verifier was running Stryker
  in `fixtures/ts-fixture`, which has it. `sidecrew_status` also reports the loaded model and revision
  from the worker record, which `doctor`'s own row never could — `/v1/models` lists the Hugging Face
  cache, not what is resident.
- `fixtures/ts-fixture/test_plan.json` and `exemplars/`: six tasks over four functions and two shapes,
  with both exemplars verified through `sidecrew verify` (0.83 and 0.75 mutation score) rather than
  assumed to survive.
- Two stale lines in the skill's reference docs, which nothing tests: `verifier.md` said a tautology
  meant "no retry, escalate", which contradicts ADR-0012 and ADR-0005 — there are exactly two failures
  that do not get the retry, and a tautology is not one of them, because the detector's finding names
  the line and the reason. `conventions.md` still called ADR-0014 proposed.

## Unreleased — Phase 3 (2026-09-12)
- `verifySwift(candidate, { target })`: tautology → `swift build --build-tests` → `swift test` →
  `muter run`, returning the **same `Verdict`** as `verifyTs` and parsed before it is returned. Stages
  after a decisive failure are skipped, and so is the mutation stage for a candidate already known to
  be tautological.
- **Measured, on the baseline M2 Pro / 32 GB with Xcode and a simulator open**
  (`verifier-swift-cost.json`): a surviving candidate costs **28.0 s** median, 92.6 s p90 (compile
  7.9 s, pass 1.1 s, mutation 18.8 s); a tautological one costs **8.3 s**. Roughly 4× a TypeScript
  verdict, and 10× for a tautology — the static check saves the mutation stage, and on Swift the
  compile stage alone is 7.9 s. **No simulator is involved**, and the results file records that as a
  field rather than as a claim.
- `fixtures/swift-fixture`: 21 pure functions mirroring the TypeScript fixture one for one, the same
  planted off-by-one in `truncate`, two test targets (XCTest and Swift Testing), and nine candidates —
  four legitimate, five tautological — catalogued in `candidates.json`. Foundation only, macOS only,
  **no simulator**.
- **ADR-0005, and it is the reason this phase took the shape it did: Muter cannot see a Swift Testing
  failure.** It decides a mutant was killed by matching `with ([1-9]{1}[0-9]{0,}) failure` against the
  test output — XCTest's summary line, which Swift Testing never prints. Read out of the installed
  binary rather than inferred. Every detected mutant of a `@Test` came back `runtimeError`,
  indistinguishable from a crash, so **no Swift Testing candidate could ever have survived**.
  `sidecrew-test.sh` — generated per candidate, checked in to the fixture, unit-tested against the
  generator — appends the one sentence Muter reads, and only when Swift Testing actually reported a
  failed run. The slow test asserts `killed ≥ 1` *and* `timeout === 0` for both `@Test` candidates,
  which is the regression: without the wrapper both numbers swap.
- The same wrapper gives every mutant a deadline, because **Muter 16 has none**. One mutant of `chunk`
  turns `size < 1` into `size > 1`, `i += size` steps by zero, and the run never ends — the first
  attempt had to be killed by hand. The watchdog kills by **working directory** and then by process
  group, because the group kill alone silently does not work: SwiftPM runs the built `xctest` binary in
  a process group of its own, and the first version left two orphans at 99.9 % CPU with `PPID 1`, still
  running minutes after the verdicts they belonged to were returned.
- `runtimeError` counts towards the mutation score and never towards survival, which is ADR-0012's rule
  for a Stryker `Timeout` applied to the outcome Swift makes common. Counting it as a kill would have
  let a candidate earn its survival from a crash it never asserted about.
- **`swift test` exits 0 when it runs nothing.** A `--filter` that matches no test, or an `XCTestCase`
  whose methods are not named `test…`, passes the run stage without evaluating a single assertion.
  `executedTests()` reads both frameworks' summary lines and the stage now requires at least one test
  to have run. New entry in ADR-0006's cheap-pass list, with a slow test for it.
- Mutation is scoped to the function under test, as ADR-0013 requires — but Muter has no
  `--mutate file:from-to`, so the scope is applied to its **report** rather than to its run. Measured,
  that moves the median score from 0.125 to **1.00** and the wall clock not at all: it is the same run
  either way. Swift gets ADR-0013's score and not its 3.3×. `killed_ids` carries
  `<operator>@<line>:<column>` because Muter has no mutant ids.
- A Swift mutation score is **coarser** than a TypeScript one and ADR-0006's routing should know it: a
  function-scoped Swift verdict is computed over one or two mutants against TypeScript's six to twelve,
  because Muter's whole operator set is four rules. `muter run --skip-coverage` was measured and left
  alone — 28.1 s against 28.0 s, which is no argument for a deviation.
- The sandbox is ADR-0004's, plus one thing Swift forces: **`.build` never goes into it**. Muter copies
  the package to a sibling `<name>_mutated/`, and a copied module cache names the path it was built at,
  so every mutant fails with `missing required module 'SwiftShims'`. `--scratch-path <sandbox>-build`
  keeps our build outside; cleanup removes three directories rather than one.
- Muter's whole operator set is four rules, so some perfectly ordinary Swift has **no mutants at all**
  and `killed ≥ 1` is unreachable for reasons that have nothing to do with the test. The verdict says
  which of the two happened — "muter generated no mutants … this is not a fault in the test" — so the
  single retry is not spent rewriting a good test. `Arrays.unique` is left unmutatable on purpose and
  the slow test pins the message.
- The tautology detector grew a **Swift dialect** (`XCTAssert…`, `#expect`, `#require`), which the
  comment at the bottom of that file had been promising since Phase 0. The rules did not change; only
  the syntax they scan did. Swift's `import` has no `from` clause to end on, so the TypeScript
  "keep blanking until the `from`" rule would have blanked the rest of every candidate — that branch is
  real, and tested.
- `src/verifier/shared.ts`: `VerifierSetupError`, `truncateError`, `deriveLineRange` and the output
  helpers now live in one place instead of two. `ts.ts` re-exports them, so nothing that imported them
  had to move. The brace matcher is one function with a per-dialect declaration pattern.
- `docs/research/licences.md`: the audit the phase prompt asked for. **Muter 16 is MIT**, read out of
  `/opt/homebrew/Cellar/muter/16/LICENSE`, so recommending `brew install` stays inside non-negotiable
  #6. Shipped code, downloaded weights and merely-recommended tools are listed separately, each checked
  against the installed artefact rather than a website.
- **Handover fixes for Phase 4, all of them things that had gone stale rather than new work.**
  `claude/skills/sidecrew/references/verifier.md` still said the score was `killed / (killed + survived)`
  — wrong since ADR-0012, and it is the file Claude reads to route survivors to review, so a stale
  formula there is a wrong routing decision on every run. It now carries the standard score, the
  `stage_reached` table, the two readings of `killed == 0`, and the warning that a Swift score and a
  TypeScript score are not comparable. `conventions.md` still described whole-file mutation.
  `SKILL.md` had a doubled `experiments/go-no-go/` path and named a `sidecrew_plan_validate` tool that
  Phase 4's DoD does not build.
- The Phase 4 prompt pointed at `max_concurrency_32gb`, a field ADR-0009 deleted, and said nothing about
  there now being two verifiers to dispatch between. Both fixed, along with the two verdicts that must
  not consume the single retry.
- `docs/specs/pipeline.md` gained the `killed == 0` table: all four mutation counts at zero means nothing
  in that function could be mutated, which is derivable from the existing contract and needs no new
  field — but a retry loop has to know to look.
- **ADR-0014 is proposed, not decided**: `TestPlan` has no home for a Swift candidate's test target, and
  a package with more than one cannot be guessed at. Four options and a recommendation are written up;
  Phase 4 or 5 settles it, with the spec update in the same commit, because it is a contract change.
- Tests: 223 fast tests, none needing Swift or Muter. `test/verifier-swift.slow.test.ts` covers the
  real pipeline under `SIDECREW_SLOW=1` and needs a Swift toolchain and `muter`.

## Unreleased — Phase 2 (2026-09-12)
- `verifyTs(candidate, { target })`: tautology → `tsc --noEmit` → `vitest run <file>` → `stryker run`,
  returning a `Verdict` that is parsed before it is returned, so an invalid one cannot leave the
  function. Stages after a decisive failure are skipped, and so is the mutation stage for a candidate
  already known to be tautological — it is ~90 % of the cost and cannot rescue a test that asserts
  nothing.
- **Measured, on the baseline M2 Pro / 32 GB with Xcode open** (`verifier-ts-cost.json`): a surviving
  candidate costs **7.2 s** median, 15.5 s p90 (compile 0.44 s, pass 0.36 s, mutation 6.4 s); a
  tautological one costs **0.80 s**, because it never reaches Stryker.
- Each candidate is verified in its own temp copy of the project **with the project's own tests
  removed** (ADR-0004). Without that, every candidate in a repo that already has a suite inherits kills
  earned by tests that were there first, and `killed ≥ 1` stops being evidence about the candidate.
  `node_modules` is symlinked; `reports/`, `coverage/`, `.stryker-tmp/` and `__snapshots__/` are left
  behind. `CI=true` during the run stages stops vitest writing a snapshot file that does not exist yet,
  which closes the second door on the snapshot cheap pass.
- Stryker's incremental cache lives inside the sandbox and is therefore always cold. Shared, it is a
  correctness bug and not a cache: measured, a candidate asserting only `expect(true).toBe(true)` was
  credited with the previous candidate's 6 kills and its 0.67 score. The mechanism is quoted from
  Stryker's `incremental-differ.ts` in ADR-0004, and there is a regression test.
- Mutation is scoped to the function's line range, not the file (ADR-0013): 7.2 s against 23.4 s per
  candidate, and a median score of **0.83 against 0.19** — a whole-file score is mostly a report on
  functions nobody was asked to test, and ADR-0006 routes review by that score. `deriveLineRange` finds
  the range by brace matching until `TestPlan.functions[].line_range` exists to supply it.
- `src/verifier/tautology.ts`: constant assertions, `x` compared with itself, snapshot-only, and never
  calling the function under test. It masks comments and string contents first, so
  `it("expect(true).toBe(true)", …)` is a test name and not an assertion. Findings carry a line and a
  sentence written to be read by the worker on its single retry.
- `fixtures/ts-fixture` filled in: 21 pure functions across five files, and eight candidates that all
  compile and all pass — four legitimate, four tautological — catalogued in `candidates.json`, which the
  slow test and the cost script both read. `truncate` carries a planted off-by-one that is wrong on
  exactly one input class; a test asserting the correct answer fails the pass stage, and one asserting
  the buggy answer survives with a perfect score. Both are asserted, because that is ADR-0006's
  snapshot-of-current-bug made reproducible.
- The fixture uses `moduleResolution: "Bundler"`: under NodeNext a worker that omits a `.js` extension
  fails the compile stage for a convention nobody told it about, and the discard rate would then be
  measuring our tsconfig.
- ADR-0012, with the spec change in the same commit: `stage_reached` is progress, not a failure code.
  `done` is a completed pipeline; `mutation` now means the mutation run itself broke — a verdict that is
  otherwise indistinguishable from "killed nothing", and which Phase 4 must not spend the single retry
  on. `mutation.score` is pinned to the mutation-testing standard `(killed + timeout) / (killed +
  timeout + survived + no_coverage)`, while survival still requires a real `Killed`.
- `npm run measure:verifier-ts` writes `experiments/go-no-go/results/verifier-ts-cost.json` with
  `"measured": true` and the machine, like `bench` does.
- Tests: the parser, the detector, the sandbox rules and the range finder in the fast set; the whole
  pipeline against the real fixture in `test/verifier-ts.slow.test.ts` under `SIDECREW_SLOW=1`,
  including the two cases that justify the design — a candidate that passes and asserts something real
  but kills nothing, and a candidate that must not inherit the previous one's kills.

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
