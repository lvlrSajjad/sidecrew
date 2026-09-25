# sidecrew — the ideal, what is built, and what stands between it and v1.0

*A brief for independent research.*

**Written 25 Sep 2026 by the session that built and measured Phase 14d, for a fresh researcher (Fable) to
think about without the owner's or this session's opinions leading.** Every number here is labelled
measured or estimated and cites where it lives. **My own recommendations are at the end, in their own
section, so they can be argued with rather than inherited.**

## 0. Our ideal — what the owner wants, and what v1.0 was defined to mean

- **The ideal, in the owner's words** (`docs/plan/VISION.md`): *"From outside, the user wants to change x, y,
  z in their source code, and the change gets done with the same quality Opus itself would produce. From
  inside, it is not just Opus — it is Opus with its local model employees."* And: *"do anything with the code
  that Opus does — the difference is the way. Opus does the smart part, local models do the heavy lifting."*
- **The loop the owner described** (20 Sep): Opus receives a task and plans a session to gather what it
  needs; workers read and report; Opus asks the user where a machine cannot decide; workers act; the loop
  repeats until a machine-checkable definition of *satisfied* is met. Opus plans; local MLX workers (a pinned
  Qwen2.5-Coder 7B) do the work; **a mechanical gate decides what Opus and the user ever see.** The owner's
  bar for the road to v1: *"even 90 % of what Opus does is a win."*
- **The measure** (owner, 16 Sep): *"fewer tokens, faster, more precise"* than using Opus on its own.
- **v1.0 as currently defined** (`docs/plan/PHASES.md` § 14d, frozen in `prompts/phase-14d-retrieval.md`):
  1. **Cost:** `R ≤ 1.0` at `N = 12` — Opus planning tokens per task ÷ what a paid model costs per task
     (`W_upper` = 7,794 tokens/task), at the plan size a new user starts with.
  2. **ADR-0089 closed** — the workload #1 gate hole (see §6).
- **The four-number scorecard** (PHASES § *The road to the 90 % bar*): Reach ≥ 0.90, Shapes ≥ 4 of 5,
  Cost `R ≤ 1.0` at `N = 12`, Trust `D ≤ 0.02` or diagnosed.

**The non-negotiables** (`CLAUDE.md`) are constraints on any answer: one machine-checkable gate per
workload, as an iff in `src/schemas.ts`; worker inference never touches the Anthropic API on the local tier;
Claude never sees raw worker output; determinism; a project is byte-for-byte intact after every job; and
**no client code or name ever leaves the repository** (the two real projects are `project-a`, an unmodified
commercial NestJS/jest service of ~2,160 files and 6,765 tests, and `project-b`, React/jest).

## 1. What has been built and measured (16–25 Sep 2026)

**Built — one npm package, `sidecrew`, CLI + MCP server, published `v0.2.0` on npm with provenance and on the
MCP Registry** (`docs/CHANGELOG.md`):

| | what it is | status |
|---|---|---|
| local workers | a pinned MLX Qwen2.5-Coder 7B (and 14B), `serve`/`status`/`bench`, temperature 0, fixed seed, memory-aware; refuses below 24 GB installed | built (Phases 1, 13) |
| workload #1 — unit tests | Opus plans function × test shape with one exemplar; a worker writes the test; gate: compiles ∧ passes ∧ kills a real mutant ∧ not tautological (Stryker for TS, Muter for Swift) | built and measured on real projects: **3/8, 4/8, 4/10** survival (Phases 2–9) |
| workload #2a — behaviour-preserving changes | Opus plans grouped, ordered tasks; a worker returns whole files or single declarations; gate: diff confined ∧ `tsc` clean with none introduced ∧ every test that passed before still passes | built (Phases 10–12, 14c): the main workload |
| the management side | change planner, ordered steps, a budgeted correction round, escalation queue, review queue, unattended mode, resume, a task→candidate cache | built (Phases 12, 13b) |
| reach | symbol-scoped tasks, so a 4,000-line file is addressable one declaration at a time | built: **0.519 → 0.911** of a codebase by bytes (14c) |
| safety | the project is fingerprinted before and after every job; sidecrew brings its own pinned Stryker; nothing is installed into a project | built (ADR-0088) |
| retrieval (14d) | `recon` (errors per strictness flag), `query` (refs / unreferenced / sizes / diagnostics from the project's compiler), `read` (the 7B reads, claims admitted only by verified citation), a planner contract that uses them | built 24 Sep; being measured (§3) |

**Measured against the status quo — Phase 11b** (the direct comparison with Opus, on renames): on project-a
the 7B's output was **byte-identical to Opus's on 18 of 19 tasks**, and every task passed the gate
(19/19); on project-b, **15/19** passed, 15/18 attributable to the worker. **0 worker tokens against
80,131 and 95,335 Opus tokens** for the same tasks. The gate found no defect in Opus's own output. The verdict
was **withheld by its own rule**: 19/19 renames is not a claim about harder shapes.

**Measured on 25 Sep (night 1 of Phase 14d):** survival **9/11** and **32/45** on the base arm's dead-code and
rename plans; planning cost in §3.

## 2. Where the scorecard stands (25 Sep 2026)

| | bar | now | status |
|---|---|---|---|
| Reach | ≥ 0.90 of a codebase by bytes a task may touch | **0.911** (measured, 14c, ADR-0086) | met |
| Shapes | ≥ 4 of 5 behaviour-preserving shapes at a usable rate | **1 of 5 formally** (20 Sep); since then indicative only — see §4 | open |
| Cost | `R ≤ 1.0` at `N = 12` | **2.07** with retrieval, 2.68 without (measured 25 Sep, harness-normalised; §3) | **far off** |
| Trust | `D ≤ 0.02`, or diagnosed | `D` diagnosed as the project suite's own flake rate (ADR-0084), mitigated by re-reading regression-only failures | met by diagnosis |
| ADR-0089 | closed | **closed by option F on 25 Sep** (branch `adr-0089`); published workload #1 rates still to be re-scored under it (§7) | nearly |

*Pending tonight (night 2 of Phase 14d):* the retrieval arm at `N ≈ 40` and the quality veto. `R₁` at
`N ≈ 12` is already fixed by the planner transcripts; tonight decides only whether the veto fires first.

## 3. Challenge 1 — planning costs more than the work it plans, on small jobs

**Measured** (`experiments/planner-cost/`, `prompts/phase-14d-retrieval.md`, ADR-0090):

| planner arm | N | Opus new tokens (normalised) | R |
|---|---|---|---|
| no retrieval, `N ≈ 12` | 11 | 229,830 | **2.68** |
| with retrieval, `N ≈ 12` | 11 | 177,203 | **2.07** |
| no retrieval, `N ≈ 40` | 45 | 254,933 | **0.73** |
| with retrieval, `N ≈ 40` | 36 | 225,691 | **0.80** |

- **Where planning tokens go** (ADR-0090 §1, measured on 20 Sep's planners): ~17 % fixed harness (system
  prompt, tools, brief — ~46k), ~36 % reading tool results, **~49 % Opus's own output** (mostly thinking),
  counted twice under the metric (once as output, once re-cached).
- **Consequence, arithmetic not measurement:** removing *all* reading with output unchanged gives
  `R = 1.88` at `N = 12`. Retrieval cut planning by ~23 % and cannot reach 1.0 alone.
- **At `N ≈ 40` both arms already pay** (`R < 1`). The design works on large jobs and not on small ones.
- **What "small job" means to a user**: anything from a one-line change (where planning is pure overhead)
  to a dozen-task cleanup of one directory.

**Open questions:** Is `R ≤ 1.0 at N = 12` the right bar for v1, or a bar written before anyone knew the
cost structure? What is the honest way to change a frozen bar? Which levers attack the output term —
a cheaper planner model, a machine-generated plan for predicate-shaped jobs, a much shorter planner
contract, routing small jobs to Opus directly? What does the curve look like between `N = 12` and 40?

## 4. Challenge 2 — wall-clock: the gate runs the whole suite per candidate

**Measured:** on `project-a`, the gate is **~260–280 s per candidate** (the project's full 6,765-test
suite), generation 13–40 s; a night gated **~11 tasks/hour** (`N ≈ 40` arm: 45 tasks in 4 h 09 m).
**Estimated, not measured:** Opus making the same mechanical edits directly takes ~0.5–1 min each plus one
suite run — so sidecrew is **roughly 4–8× slower** in wall-clock. Phase 11b compared *output and tokens*
with Opus directly (§1); **no wall-clock head-to-head has been measured.**

**Open questions:** Can the gate run only affected tests (jest `--findRelatedTests`, an import graph) without
losing soundness — dynamic imports, DI containers and entity globs hide dependencies? Can candidates be
batched into one suite run and bisected on failure? Is "faster" even the right promise, when the owner's
measure said *"faster as the user feels it"* — parallel, unattended — rather than per task?

## 5. Challenge 3 — which work sidecrew can do at all

**Behaviour-preserving (workload #2a)** — *measured*:
- `rename`, `unused_import`: survive well (Phase 11). `unused_import` barely exists on project-a.
- `dead_code`: **32/45** and **9/11** survived on 25 Sep's plans (indicative; the formal Shapes re-score
  has not been run). Planners refuse a lot because reflection (DI, entity globs, dynamic `this[...]`) hides
  references from any count.
- `null_guard` under `--strictNullChecks`: **2/30** as whole-file tasks (ADR-0077); with ADR-0077 B and one
  declaration per task, **25/83** (14c′). The narrowed type propagates into test files a task may not edit.
- `api_migration`: unmeasured.
- On project-a, `recon` measured **+11,604** errors under `--strictNullChecks` (40 % in test files) and
  **+282** from three lint-shaped flags, **95 % in source** — a real, deliverable population.

**Behaviour-changing (features, bug fixes — workload #2b)** — *not built*. No gate exists: nothing in the repo
knows what the new behaviour should be. ADR-0082 proposes test-first (a worker writes the test, the user
approves it, another worker makes it pass). **Measured: the 7B wrote a usable test against a NestJS service
2 times in 20** (`Y = 2/20`, ADR-0082 D).

**Open questions:** What is the smallest honest gate for a feature? Is a human-approved test acceptable as
the oracle? Which model should write specification tests — and does that break the zero-token premise?
Should v1 promise features at all?

## 6. Challenge 4 — the local model as a reader

**Measured / observed on 25 Sep** (construction probes and the planner reports, not a rate):
- The 7B's quotes only verified after layout was tolerated; then **2 of 6 admitted claims said more than
  their cited lines did**. Both retrieval planners reported the reader as not decision-grade and leaned on
  the compiler-backed tools (`recon`, `query`) instead.
- Reading **file contents is ~23 % of planning tokens at `N ≈ 12`**, the largest reading term.

**Candidates:** `graphify` (the owner's skill: AST-built knowledge graph with community detection, no LLM for
code, token-capped queries) for orientation; the 7B restricted to small targeted spans; a Haiku or Sonnet
reader — which costs Claude tokens and would need non-negotiable #1 revisited and the metric moved from
Opus tokens to dollars.

**Open questions:** Which of these reduces Opus's reading *and* thinking the most, per dollar? Can a
persistent graph be the "cache the reading across runs" lever (14d′'s second half) without serving stale
answers (ADR-0065's key discipline)?

## 7. Challenge 5 — gate integrity and operational hazards

- **ADR-0089** (workload #1): a test that only checks type or existence used to survive. Found on 25 Sep
  that the real hole was **crash kills** — a test that merely calls the function kills every mutant that
  makes it throw. **Closed by option F**: a second mutation pass with the assertions stripped; survival needs
  a kill that is neither a crash nor the body removal. **Costs one extra mutation pass** per candidate that
  reaches a kill. Published rates (3/8, 4/8, 4/10) still to be re-scored under it.
- **Memory at concurrency 2** (25 Sep, measured): one project-a suite is ~8.2 GB of jest workers; two plus
  two 7B workers swapped the 32 GB machine to 26–30 GB of swap and turned 9 of 11 candidates into
  timeouts. The concurrency ceiling does not count the suite. The "thermal back-off" fired on swap, not heat.
- **The gate's test-file predicate** calls support files under `test/` "source", so a task may edit test
  infrastructure (BACKLOG, needs an ADR).
- **Machine-failure handling** in measurements was underspecified and had to be decided mid-run (dated notes).

## 8. Challenge 6 — the measurement programme itself

- Frozen decision rules have kept the numbers honest, and they have also produced a v1 bar that the
  arithmetic now says the current design cannot meet. Is there a principled way to revise a bar without it
  becoming *"move the goalposts after seeing the score"*?
- Instrument defects found this week: a substring classifier; parallel planners sharing a 30,678-token
  prompt cache that lowered `P_total`; a shared scratchpad between arms. Each was caught and noted before the
  number it affected. What would make the next measurement correct by construction?

## 9. What the owner is asking for

Research and thinking, not code. Specifically:

1. **Is the v1 bar right?** What should "v1.0" mean for a tool with this cost curve, and how should a frozen
   bar be revised honestly (or kept)?
2. **The highest-leverage path to a v1 worth shipping**, ranked by value per effort, with the measurement
   that would prove each step — including options this session has not thought of.
3. **Small jobs:** route them away, make them cheap, or accept that sidecrew is for large jobs?
4. **Feature work:** is there a sound gate, and should it be in v1?
5. **Reader and planner models:** graphify, the 7B, Haiku, Sonnet — which combination, measured how?
6. **Wall-clock:** is a faster gate possible without weakening what it guarantees?
7. **What would make you conclude the design should change shape**, rather than be tuned?

## 10. This session's own recommendations — to be challenged, not adopted

- **Route by size.** A cheap `recon`/`query` pass estimates `N` before planning; below ~30–40 tasks, hand the
  job to Opus directly. sidecrew is for large, mechanical, verifiable batches, and should say so.
- **Machine-generated plans for predicate-shaped jobs** (unused locals, lint-flag fixes, unreferenced
  exports): the plan comes from `query` output with near-zero Opus planning — the output term, attacked.
- **Keep the gate strict; make it faster** with affected-tests-first plus a full-suite confirmation on the
  combined result, behind an ADR that states what soundness it gives up.
- **Try graphify (free) before any paid reader;** measure a Haiku reader only in dollars.
- **Do not put feature work in v1**; keep ADR-0082 as the post-1.0 path.
- **Redefine the Cost bar as a new, dated decision** (for example `R ≤ 1.0` at the median plan size of the
  jobs sidecrew accepts after routing), stated in the release notes as changed after measurement.

## Where everything is

`docs/plan/VISION.md` · `docs/plan/PHASES.md` · `docs/plan/HANDOFF.md` · `docs/DECISIONS.md` (ADR-0077,
0079, 0082, 0084, 0086, 0089, 0090) · `docs/plan/prompts/phase-14d-retrieval.md` (the frozen rule and its
dated notes) · `experiments/planner-cost/README.md` and `results/` · `docs/plan/BACKLOG.md`.

## 11. The independent analysis came back — 25 Sep 2026

`docs/research/2026-09-25-v1-independent-analysis.md` (Fable, verbatim). Its headline: **don't ship v1.0 against
`R ≤ 1.0 at N = 12`** — keep that bar, report it as failed, and pre-register a new one in **dollars per
delivered task against an Opus-alone arm**; **define v1.0 by the guarantees**, with cost a published number
rather than a release condition; and test whether **deterministic tools** (the TypeScript language service,
ESLint `--fix`, Knip) match the 7B on the shapes that survive today, because that would change the product's
shape more than any tuning.

### The points it could not see, answered from the repository

| it asked | the repository says |
|---|---|
| how `W_upper` = 7,794 was derived | Phase 11's **C3 control: Claude Haiku**, the `haiku-worker` agent harness, **93,532 tokens over 12 tasks**, harness included (`prompts/phase-11-go-no-go-2a.md`, `experiments/go-no-go-2a/results/go-no-go-2a-2026-09-18.json`). So R divides **Opus** planning tokens by **Haiku** doing tokens. In dollars the comparator is ~4× cheaper per token again — the construct defect it names is real, and larger than it assumed. Each Haiku task paid its own agent harness; nothing paid a planning session. |
| which model the planners ran on | **`claude-opus-5`** on 20 Sep, **`claude-opus-5-5`** on 25 Sep (read from the transcripts). All four 25 Sep arms share one model, so they compare with each other; 20 Sep's numbers are across a model change. |
| the frozen bar's wording | `R = P_total / N / 7,794`, `N` = **planned, validated** tasks after refusals, not delivered ones. Survival enters only through the quality veto. |
| what "normalised" means | New tokens only — input + output + cache_creation, cache reads excluded (`planner-cost` §2) — plus, for the 25 Sep arms, the first message's cache read added back, because parallel planners shared a prompt cache (`phase-14d-retrieval.md`, note of 25 Sep ~00:20). Output is counted once as output and once as the next message's cache write. |
| ADR-0089 option F's kill criterion | Built 25 Sep: a second Stryker pass with the candidate's assertions stripped; a kill that pass also makes is a crash kill; survival needs a kill that is neither a crash nor the body removal. Verified on the fixture. |

### Where this session agrees, and where it adds something

- **Agree — v1.0 means the guarantees.** That is the owner's to decide, as a new ADR, and it is the cleanest
  way to stop redefining a research milestone until it passes. The old bar's result gets reported as failed.
- **Agree — the dollar re-score of existing transcripts comes first.** It is hours, needs no run, and may
  move the verdict by 2×. The transcripts hold every usage field.
- **Agree, and it is urgent — the reflective-reference guard.** Last night's dead-code survivors (32/45, 9/11)
  passed a gate that cannot see code reached only through DI or an entity glob when no test covers it. **No
  survivor was applied to any real checkout** — they exist only as verdicts on the pinned clone — but no
  dead-code survivor should be offered to a user until the guard exists.
- **Agree — verify-only mode for small jobs.** It partly exists: Phase 11b's arm D was *the gate applied to
  Opus's own output*. Turning it into a product path is small.
- **Agree — memory admission control before anything else runs at concurrency 2.**
- **Adds:** the deterministic-executor experiment is cheap because the pieces exist — `sidecrew query refs`
  already drives the TypeScript language service, which can rename, and `recon`/`query diagnostics` already
  enumerate lint-shaped fixes. And it may conflict with the owner's premise that local models do the
  heavy lifting; that is a finding worth having, not a reason to skip the test.

### Proposed order — for the owner to approve, change or reject

1. **Tonight: finish Phase 14d as frozen** (`scripts/retrieval-night2.sh`). The old bar's result has to be
   complete to be reported honestly, and the machine is idle overnight.
2. **ADR-0091 (owner): what v1.0 means** — the guarantees; the cost bar reported, not gating; a new dollar bar
   pre-registered on fresh data.
3. **Daytime, hours:** the dollar re-score by token class, and the Opus-alone comparator's design.
4. **Daytime, small, safety first:** the reflective-reference guard with planted traps; memory admission
   control; merge ADR-0089 F and re-score the published workload #1 rates under it.
5. **Days:** the deterministic-executor arm on the shapes that survive today; verify-only mode for small jobs;
   the planner effort sweep and a Sonnet-planner arm.
6. **Later:** the two-stage gate; readers (graphify, the 7B on spans) only if the dollar re-score says reading
   is worth attacking.


## 12. What changed after the analysis — 25 Sep 2026

- **v1.0 is defined** by the owner (ADR-0093 and its addenda): the claim true against Opus-alone — ≥ 80–90 % of its
  success on a benchmark of real requests, ≤ 50 % of its dollars on batch jobs as a formula with its margin — and
  reproducible by any user. v2 = as fast; v3 = as good or better. So the analysis's "guarantees-only 1.0" was not
  taken; cost stays a condition, measured in dollars against Opus-alone, as it recommended.
- **Measured:** planning dollars by token class — **cache reads are the largest term (33–67 %)**, not output, which
  corrects both this brief's and the analysis's estimate. P1 — Sonnet as planner — **not met** (7 tasks for $1.93 vs
  Opus's 11 for $2.39).
- **Built:** the reflective-reference guard (§11's urgent item), memory admission control, ADR-0089 option F.
- **Decided:** ADR-0091 (measurement tiers), ADR-0092 (mechanical first), ADR-0094 (the middle tiers, routed by
  expected cost per success rather than cheapest-first), ADR-0095 (triage, proposed).
- **Still the missing instrument:** the benchmark of real requests with an Opus-alone arm (ADR-0093 addendum 2).
