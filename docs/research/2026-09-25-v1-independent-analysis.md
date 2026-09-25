# sidecrew toward v1.0: an independent analysis of the bar, the levers, and the shape

sidecrew should not ship v1.0 against "R ≤ 1.0 at N = 12". Your own measurements show the bar fails because of a large fixed planning cost per job. The per-task cost is low. The bar also mixes a token count with a dollar question. So the honest move is to keep the old bar and report it as failed. Then replace it with a dated, pre-registered dollar bar, set before new data comes in, that compares against an Opus-alone baseline that also pays its own fixed cost. Define v1.0 by what the tool guarantees, not by what it saves.

## TL;DR
- **The cost problem is fixed overhead, not per-task cost.** A straight-line fit through the measured points gives about 156k (with retrieval) to 222k (without) Opus tokens per job before any task is planned. After that each task adds only ~0.7k–1.9k, against W_upper = 7,794. Break-even is ~27–31 tasks against W_upper. It is ~51–69 tasks against the Opus-direct cost Phase 11b actually measured (4.2k–5.0k tokens per task). Counted per task that survives the gate, even the N≈45 arm only breaks even (R ≈ 1.02). Retrieval, the 7B reader and graphify all go after the wrong term. The levers that matter are the planner's thinking effort, machine-made plans, and a different comparator.
- **Replace the frozen bar honestly, not on the score.** Follow registered-report practice: report the original bar's result, state the deviation and why, and report both versions. Justify the change by what the metric fails to measure (it gives an output token and a cache-read token the same weight, though Opus 4.8 prices them $25 vs $0.50 per million), not by the number you got. The session's proposed replacement, "R ≤ 1 at the median plan size after routing", is circular and should be dropped. v1.0 should mean a stable interface plus proven safety: the project is never damaged, the tool refuses honestly, and gate soundness is shown on planted traps. Cost should be a reported number, not a condition for release.
- **The design may need a new shape, not more tuning.** For the shapes that survive the gate today (rename, unused import, dead code, lint fixes), deterministic tools (the TypeScript language service, ESLint --fix, Knip) are likely to match the 7B at zero inference cost. That would make the gate and the compiler-backed query layer the product, and the 7B optional. It is also the cheapest thing to test. The faster gate should be two stages: static affected-test selection per candidate, then batched full-suite confirmation. It stays sound only if every final state still gets a full-suite run. Feature work should stay out of v1. If it is ever built, Opus or Sonnet should write the spec test, not the 7B.

## How to read this report

Every claim is tagged as one of three kinds. **(i) Measured by the brief:** numbers the Phase 11b/14c/14d session reports. **(ii) External evidence:** documentation or published research. **(iii) My reasoning:** arithmetic or inference, labelled as such.

Several conclusions depend on repository files I have not seen. They are flagged inline and collected here.
- **The exact wording of the frozen bar** (prompts/phase-14d-retrieval.md, PHASES.md § 14d). This decides whether "N = 12" is the planned task count or the realised one, and whether survival enters R.
- **How W_upper = 7,794 was derived.** Phase 11b measured 4,217 and 5,018 Opus tokens per task on renames (80,131/19 and 95,335/19). Those are well below W_upper. I cannot tell whether W_upper includes Opus's own fixed session cost, its test runs, or a different tokenizer.
- **How tokens are "normalised" in experiments/planner-cost/ and ADR-0090.** In particular, which usage fields (input, cache_creation, cache_read, output, thinking) are summed and with what weights.
- **Which Opus model and version the planners ran on.** This matters because Claude 4.7 and later use a tokenizer that, per Anthropic's pricing page, "produces approximately 30% more tokens for the same text." Token counts from different model generations can't be compared directly.
- **ADR-0082 D's protocol behind Y = 2/20**, and **ADR-0089 option F's exact kill criterion.**

## The arithmetic that reframes the cost question

**(i) Measured:** with retrieval, 177,203 normalised Opus tokens at N = 11 and 225,691 at N = 36. Without retrieval, 229,830 at N = 11 and 254,933 at N = 45. W_upper = 7,794.

**(iii) Fit.** Model the total planning cost as P(N) = A + b·N, so R(N) = (A/N + b)/W.
- **With retrieval:** b = (225,691 − 177,203)/(36 − 11) = 48,488/25 = 1,940 tokens per task. A = 177,203 − 11 × 1,940 = 155,868 tokens per job. Break-even is where A/N + b = W, so N* = A/(W − b) = 155,868/5,854 ≈ 26.6 tasks.
- **Without retrieval:** b = (254,933 − 229,830)/(45 − 11) = 25,103/34 = 738 tokens per task. A = 229,830 − 11 × 738 = 221,709. N* = 221,709/7,056 ≈ 31.4 tasks.
- **Check against the brief:** 177,203/11/7,794 = 2.07 and 254,933/45/7,794 = 0.73. Both reproduce the reported values.

What the fit implies:
1. **The fixed term is 80–120 times the per-task term.** At N = 12, fixed cost is 87–96 % of planning spend. The ~46k fixed harness explains only a quarter to a third of A. The rest is thinking and orientation that Opus does once per job whatever N is. The "~49 % output (mostly thinking)" in ADR-0090 is therefore mostly a fixed cost, not a per-task one. So the target is "make orientation and deliberation cheap per job", not "make each task cheaper".
2. **Retrieval moved cost from the fixed term to the per-task term.** It lowered A by ~66k but raised b by ~1.2k. The two arms cross at (221,709 − 155,868)/(1,940 − 738) ≈ 55 tasks. Above that, retrieval costs more. This fits planners that query per task instead of orienting once.
3. **The per-task cost b is well below W,** 9–25 % of W_upper. The central economic claim, that Opus plans cheaply per task and local workers do the heavy work, has not been falsified. What fails is the per-job entry fee.
4. **The comparator matters as much as the fit.**
   - Against the Opus-direct per-task cost Phase 11b measured, break-even moves to 51–69 tasks. With retrieval: 155,868/(5,018 − 1,940) ≈ 51 and 155,868/(4,217 − 1,940) ≈ 68. Without: 221,709/(5,018 − 738) ≈ 52 and 221,709/(4,217 − 738) ≈ 64.
   - The other way round: if Opus working alone also pays a fixed session cost A_d, the true break-even is (A − A_d)/(W − b). With an illustrative A_d of 46k (the size of sidecrew's own harness), it is ≈ 19 tasks with retrieval.
   - The bar, as far as I can tell from the brief, charges sidecrew a fixed cost and Opus none. That is a construct error, whatever the score. **(Needs W_upper's derivation to confirm.)**
5. **Survival changes the picture a lot.** The base arm's survival was 9/11 and 32/45 **(i)**. Cost per surviving task is 229,830/9 = 25,537 (R ≈ 3.28) and 254,933/32 = 7,967 (R ≈ 1.02). Phase 11b found no defect in Opus's own output. If the direct comparator delivers every task, per-delivered-task R is the fair number, and even the large job barely breaks even. Whether R already accounts for survival depends on the frozen wording **(not provided)**.
6. **The data can't support much weight.** There are two points per arm, one run each, no variance, and different task mixes at each N. N is also an outcome of the planner, not a controlled variable (36 vs 45 at "N≈40"). A planner that splits work more finely lowers R without delivering more. That is a Goodhart hazard built into "tokens per task".

**(ii) Dollars, not tokens.** Anthropic's current pricing page lists:
- Claude Opus 5.5 at $4 input / $20 output per million tokens, with cache hits at $0.20.
- Claude Opus 5 and Opus 4.8 at $5 / $25, with cache hits at $0.50.
- Claude Sonnet 5 at $2 / $10, and Sonnet 4.6 at $3 / $15.
- Claude Haiku 4.5 at $1 / $5, with cache hits at $0.10.
- 5-minute cache writes at 1.25× the input price and 1-hour writes at 2×.

Anthropic's thinking docs say thinking tokens "are billed as output tokens". On Opus 4.5 and later, "the API keeps previous thinking blocks by default, and they count toward the context window like any other input tokens." So the "counted twice" in ADR-0090 is real in billing, but the two counts are priced 10–50× apart. A token-count R gives a $25-per-million output token and a $0.50-per-million cache read the same weight.

**(iii)** An illustration, with the assumptions stated: take the N = 11 retrieval run (177k normalised) at Opus 4.8 prices, with ~43k real output tokens appearing twice.
- Output: ≈ $1.09.
- The re-read of that output as cache reads: ≈ $0.02.
- ~64k of tool results at input or cache-write rates: $0.32–0.40.
- The cached harness: cents.

Output is likely 60–75 % of the dollars but only ~49 % of the tokens. This is an estimate. The real split needs the raw usage fields, which the harness should log.

## §9 answers

### Q1. Is the v1 bar right, and how should a frozen bar be revised?

**Bottom line.** No. The bar is not wrong because it is hard. It is wrong because it measures the wrong thing: a token count, against a comparator that seems to pay no fixed cost, per planned rather than delivered task. And it gates v1.0 on cost when v1.0 is, by the usual meaning, a stability promise. Keep the old bar, publish that it failed, and adopt a new, dated bar. The new bar should be justified by these construct flaws alone and tested on fresh data. v1.0 itself should be capability-first.

**What 1.0 means (ii).** In SemVer, the major version tracks public API compatibility. Its FAQ says: "If your software is being used in production, it should probably already be 1.0.0. If you have a stable API on which users have come to depend, you should be 1.0.0." sidecrew is published as 0.2.0 with provenance on npm and the MCP Registry. For outside users, 1.0 will read as "the CLI/MCP interface and its guarantees are stable", not "we hit a cost ratio".

**(iii)** Tying the version number to a research milestone mixes two promises. It also pushes the team to redefine the milestone until it passes. A better split:
- **v1.0 = the guarantees:**
  - Byte-for-byte project integrity on every job.
  - One iff gate per workload, with its soundness shown on planted traps.
  - Honest refusal, with the reason stated.
  - Determinism.
  - No worker traffic to the Anthropic API on the local tier.
  - A stable CLI/MCP interface.
  - Published, reproducible cost and survival numbers per shape, whatever they are.
- **The "90 % bar" (Reach, Shapes, Cost, Trust)** should be a product claim with its own dated scorecard, advertised only where met.

**How to revise honestly (ii).**
- The Journal of Politics registered-report guidelines say: "Reasonable deviations from the plans are permissible but these must be made transparent and justified." Also: "authors should report in an appendix the results of the analyses as originally planned and as revised."
- The Collabra: Psychology guidance on deviating from a preregistration asks authors to "evaluate the possibility that the deviation from the preregistered analysis plan reduces the severity of the test."
- Willroth and Atherton's 2024 guide recommends a standard deviation report: the original plan, the deviation, and its effect on interpretation.

**Applied to sidecrew (iii):**
1. **Report R = 2.07/2.68 at N = 12 as a fail** under the frozen rule, in the release notes and in DECISIONS.md.
2. **Write an ADR that names the construct defects** without reference to the score:
   - token-count weighting versus billed dollars;
   - a comparator with no fixed session cost (if W_upper's derivation confirms it);
   - per-planned-task rather than per-delivered-task;
   - tokenizer drift across model versions.
3. **Pre-register the new bar before any new measurement.** Suggested form: dollars per delivered (gate-surviving) task, sidecrew versus Opus-alone. Both should run the same task list on the same project, with Opus-alone including its own session overhead and test runs. Measure at stated N values (for example 5, 12, 25, 50) with replicates.
4. **Check severity.** The new bar must be one the current design could fail on fresh data: a new night, a new directory, ideally project-b.

A bar redefined on data already seen is a goalpost move, however well argued.

**Whether cost should gate v1 at all (iii).** The owner's measure was "fewer tokens, faster, more precise". "More precise" is where sidecrew has an advantage no competitor can easily copy: a machine-checked iff gate and a guaranteed-intact project. Phase 11b's gate found no defect in Opus's output on renames, so that precision advantage over Opus has not yet been shown either. A capability-first v1 is still the one sidecrew can defend today, because its guarantees are about the process, not a comparison.

### Q2. The highest-leverage path to a v1 worth shipping, ranked by value per effort

**Bottom line.** Fix the instrument first; it is nearly free and may change the verdict. Next, run the deterministic-executor experiment; it is cheap and may simplify the product. Then cut the fixed planning cost with thinking effort and machine plans. Then fix the gate's wall-clock and memory. Leave reader work last. Each step comes with the measurement that would prove or refute it.

1. **Re-score existing transcripts in dollars, by token class, against a fair comparator.** *Effort: hours. Value: may move the bar by 2×.*
   - Log input, cache_creation, cache_read, output and thinking tokens separately. Anthropic's docs point to `usage.output_tokens_details.thinking_tokens`.
   - Run the matched Opus-alone arm the brief admits it never ran, on the same 11 and 45 tasks. It also gives the missing wall-clock head-to-head.
   - *Proof:* dollars per delivered task for both arms, three replicates each.
2. **Deterministic-executor arm for the shapes that already survive.** *Effort: days. Value: could remove the 7B from those shapes and most of the planning.*
   - Rename via the TypeScript language service. Unused imports and lint-shaped flags via ESLint --fix or tsc diagnostics. Unreferenced exports via Knip. Each goes through the unchanged gate.
   - *Proof:* survival, false-refusal rate and byte-diff versus the 7B arm on the same plans. If deterministic tools match on rename (Phase 11b: the 7B was byte-identical to Opus on 18/19), the 7B's value lies only in the shapes where it is weakest.
3. **A thinking-effort sweep on the planner.** *Effort: a day. Value: attacks the output-dominated fixed term directly.*
   - Opus 4.8 exposes effort controls (low/high/xhigh/max). Anthropic docs say that on these models "at lower effort settings it may skip thinking entirely on easy inputs."
   - Anthropic also warns that "Changes to thinking parameters ... invalidate message cache breakpoints". Hold effort constant within a session.
   - *Proof:* A (fixed tokens and dollars) and survival at each setting, N = 11, three replicates. Pre-register a non-inferiority margin on survival, for example no more than 5 points worse.
4. **Machine-generated plans for predicate-shaped jobs,** with Opus reviewing one compact plan in one call instead of orienting from scratch (see §10.2). *Proof:* A and survival compared with the current planner.
5. **Memory admission control.** *Effort: small. Value: turns 9-of-11 timeouts into real results.*
   - Count the measured suite footprint (~8.2 GB per project-a suite) in the concurrency ceiling.
   - Use jest's `--maxWorkers` and `workerIdleMemoryLimit`. Per the docs, a worker that exceeds the limit after a test "is stopped and restarted".
   - Make back-off trigger on memory pressure by name.
   - *Proof:* zero swap-induced timeouts over a full night at the chosen concurrency.
6. **A two-stage gate** (Q6). *Proof:* planted-regression recall of 100 %, plus measured tasks per hour.
7. **A reflective-reference guard for deletion shapes,** an integrity fix the brief does not list.
   - "Every test that passed before still passes" is only as strong as the tests. Code reached only through TypeORM entity globs or DI tokens can be deleted with tsc clean and every test green if no test exercises it.
   - Deletion tasks should be refused when the target file matches any runtime glob in configuration, or when its symbol name appears as a string literal or is registered through a decorator.
   - *Proof:* planted-trap tasks (an untested glob-loaded entity; a string-token provider) must all be refused.
8. **A Sonnet planner arm.** Sonnet 5 is $2/$10 versus Opus 4.8's $5/$25 (2.5× cheaper), and Opus 5.5 is $4/$20. *Proof:* non-inferior survival at lower dollars per delivered task.
9. **Reader work** (Q5) last. It goes after the smallest dollar term.

**Options this session had not considered (iii):**
- a **verify-only mode**, where Opus edits and sidecrew gates;
- **campaign mode** (Q7);
- **effort control**;
- the **Batch API's 50 % discount** for single-shot plan-review calls in unattended nights. It doesn't suit multi-turn tool loops because of latency.
- **1-hour caching of a per-project orientation prefix** reused across jobs. Anthropic says a 1-hour write "pays off ... after two cache reads".

### Q3. Small jobs: route away, make cheap, or accept a large-jobs tool?

**Bottom line.** Neither routing on N nor accepting a large-jobs-only tool. Keep sidecrew's gate on every job and drop its planner for small ones. Opus, or a deterministic tool, edits directly, and sidecrew verifies and fingerprints. That costs zero planning tokens and keeps the one asset nothing else offers. The planner and worker pipeline takes over above an empirically fitted threshold, currently somewhere between ~20 and ~70 tasks depending on the comparator.

**Reasoning (iii).**
- Routing small jobs "to Opus directly" gives up the guarantees exactly where users run the most jobs.
- A user asking for a one-line change still benefits from "the project is byte-for-byte intact and every previously passing test still passes".
- The fit says the cost of small jobs is the fixed A. So a small-job path must skip the planner entirely rather than run a smaller one.

**External support (ii).** The Minions paper (Narayan et al., ICML 2025) found that a naive local-remote chat protocol cut remote cost 30.4× but kept only 87 % of quality. The small model "struggles to (1) follow the remote model's multi-step instructions and (2) reason over long contexts". Its decomposed MinionS protocol recovered 97.9 % of quality at a 5.7× cost reduction. The lesson for small jobs is that orchestration only pays when there are enough decomposable subtasks to spread the remote model's fixed decomposition cost over.

**What would settle it.** A matched head-to-head at N = 1, 3, 5 and 12 on real tasks, comparing:
- (a) Opus alone;
- (b) Opus plus sidecrew verify-only;
- (c) the full pipeline;
- (d) a deterministic executor plus the gate, where the shape allows.

Measure dollars, wall-clock and delivered-correct counts. The routing threshold should be fitted from those curves, not from two points.

### Q4. Feature work: is there a sound gate, and should it be in v1?

**Bottom line.** No gate can prove that new behaviour is correct. The best available is a gate that proves "the code meets a spec the user approved, and the spec is not trivially satisfiable". The evidence says even that is weaker than it looks. Keep features out of v1. If built later, the spec test should be written by Opus or Sonnet (that is "the smart part"), approved by the user, and strengthened with mutation and held-out checks.

**External evidence (ii):**
- **Smith, Barr, Le Goues and Brun (FSE 2015)** showed that repair tools judged on the same tests they repaired against produce patches that "overfit the available tests and break untested but desired functionality". "For programs that pass most tests, the tools are as likely to break tests as to fix them."
- **Ahmed, Ganhotra, Shinnar and Hirzel (IBM, 2025)** repeated the study with LLMs on SWE-bench-derived tasks. Claude 3.7 Sonnet overfit on 21.8 % of samples. Test-based refinement raised that to 25.5 %: 14 of 22 newly "fixed" pairs failed held-out tests. GPT-4o went from 33.0 % to 35.9 %. The LLMs "almost always chose to modify the code" rather than the test.
- **UTBoost (Yu et al., ACL 2025)** found that the human-written tests in SWE-bench let erroneous patches pass: 28.4 % (170/599) in Lite and 15.7 % (92/584) in Verified, 345 in total.

**(iii) Interpretation.** If tests that humans wrote let through 16–28 % wrong patches on the affected instances, a test a human merely *approved* is a weaker oracle still. Approval checks what the test says, not what it leaves out.

**The smallest honest gate (iii).** All five conditions must hold:
1. **The approved test fails on the pre-change code and passes after** (fail-to-pass). This rules out tests that were already satisfied.
2. **Every previously passing test still passes** (the existing 2a condition).
3. **The new test kills mutants of the new code,** reusing workload #1's machinery including option F's non-crash kill. This rules out tests that only check existence or types.
4. **A second, independently written held-out test must also pass.** A different model writes it, the implementing worker never sees it, and it checks against special-casing.
5. **The diff stays within the files the plan named.**

Even then, the release notes must say "meets the approved specification", not "correct".

**Who writes the spec (iii).** Y = 2/20 **(i)** rules out the 7B as spec author. Using Opus or Sonnet here does not break the vision, which assigns "the smart part" to Opus. It only breaks a metric that counts every Opus token as a cost. *Measurement:* Y for Opus, Sonnet and the 7B on the same 20 NestJS targets, with the IBM-style held-out overfitting rate as a second outcome.

### Q5. Reader and planner models: graphify, the 7B, Haiku, Sonnet

**Bottom line.** Readers attack the smallest dollar term, so none of them is the priority. If one is tried, pick the cheapest that doesn't lie:
- **the compiler-backed query layer**, which the planners already preferred;
- **a token-capped structural map** for orientation only, because it may cut the fixed A;
- **the 7B only on small, verified spans.**

A Haiku reader is cheap in dollars ($1/$5), but it saves at most a few tenths of a dollar per job and costs you the principle that worker inference never touches the Anthropic API. For the planner, test Sonnet against low-effort Opus; that is the larger lever.

**Evidence (ii):**
- **Aider's repository map** uses tree-sitter plus a graph ranking and sends "just the most relevant portions", within a `--map-tokens` budget that "defaults to 1k tokens".
- **RepoGraph (ICLR 2025)** reports an average relative improvement of 32.8 % on SWE-bench Lite. In absolute terms that is 2.00–2.66 points, so the relative figure flatters the effect.
- **A practitioner write-up (agentpatterns.ai, secondary)** advises skipping repo maps in "heavy-metaprogramming codebases" because "AST symbols do not reflect runtime structure". That is exactly the NestJS DI and entity-glob problem the brief describes.
- **Minions** shows small local models degrade on long contexts, which fits the 7B's failures. The 2-of-6 admitted claims that said more than their cited lines is a hallucination rate no citation check fully catches **(i)**.
- **The 7B is weak by current standards.** On the SWE-MERA benchmark, Qwen2.5-Coder-7B-Instruct resolved 4.8 %, against 16.8 % for the 14B and 22.0 % for the 32B.

**(iii) Dollar ceiling on a paid reader.** Reading is ~36 % of normalised tokens, about 64k at N = 11. If Opus read those tokens uncached at $5/M, the most a reader could save is ~$0.32 per job. Haiku reading the same 64k and writing a 5k summary costs ≈ $0.09. The net saving of ≲ $0.25 per job is small next to the ≈ $1 output term. So a paid reader is not worth giving up a non-negotiable. graphify (the owner's skill; I have no external information on it and treat it as a repo-map-like artifact) is worth testing only for whether it shrinks orientation *thinking*.

**Staleness (iii).** A persistent graph is safe if keyed by content hash per file plus a hash of the compiler and lint configuration and of any runtime glob patterns. Answers are served only when every contributing hash matches, the same key discipline ADR-0065 appears to prescribe **(ADR-0065 not provided)**. Mtime-only invalidation is not enough under git checkouts.

**Measurement design.**
- Arms: none, 7B spans, graphify, compiler query only, Haiku reader (dollars only), each crossed with an Opus-at-fixed-effort planner and a Sonnet planner.
- Same frozen task set, three or more replicates per cell, arm order randomised and interleaved across nights.
- A separate API workspace per arm. Anthropic's docs say "Caches are isolated per workspace".
- Outcomes: Opus dollars by token class, reader dollars, survival, refusal rate, and a known-answer set of reference questions (for example "is X referenced via DI?") scored against compiler ground truth.

### Q6. Wall-clock: can the gate be faster without weakening its guarantee?

**Bottom line.** Yes, but not by static test selection alone, which is unsound for this codebase. The sound design has two stages. Stage 1 filters each candidate cheaply with affected tests. Stage 2 runs the full suite on batches of stage-1 survivors and bisects on failure. The guarantee, that every final state passed the full suite, is kept by construction, because nothing is accepted without a full-suite pass. My estimate (not measured) is ~3× more tasks per hour.

**Why static selection is unsound here (ii):**
- Jest's CLI docs say `--onlyChanged` "requires a static dependency graph (ie. no dynamic requires)". `--changedSince` "behaves similarly".
- Jest's default dependency extractor is regex-based. It only records `require`/`import` calls with string-literal arguments.
  - A maintainer described it as "a limitation of how jest-haste-map extracts dependencies from files using regexes".
  - Jest issue #11774 reports that `--changedSince` "does not run anything if a file is changed that is referenced by setupFilesAfterEnv", where the reporter expected "all test suites to be run". It was closed as not planned.
  - Another reports that mapped paths via `moduleNameMapper` were missed.
- TypeORM's `entities` option accepts "directory paths from which to load. Directories support glob patterns". Those strings create no edge in Jest's graph. That is my inference from the extractor source, not a documented statement.
- In the RTS literature, Ekstazi (Gligoric, Eloussi and Marinov, ISSTA 2015) is safe because it tracks *dynamic* file dependencies.
- Even dynamic RTS has DI-specific safety holes. The DIRTS preprint (TU Munich) notes that changing a bean's "injection priority ... may affect the run-time behavior of a test without modifying any of the entities covered by the test before the change."

**Design (iii):**
- **Stage 1 (per candidate, fast):** run the union of
  - Jest's related tests (with a custom `dependencyExtractor` that adds edges for configured entity globs and known DI registries), and
  - a coverage-derived map of which test files executed each source file, recorded on a nightly full run.

  Stryker's `coverageAnalysis: perTest` already does the equivalent for mutants and runs all tests for "static" mutants it cannot attribute. Copy that rule: any change to config, setup files, globs, decorators or module files triggers the full suite.
- **Stage 2 (batched full confirmation):** apply stage-1 survivors together, run the full suite once, and on failure bisect by halving the batch.

**Batch size arithmetic (iii).** Dorfman group testing gives expected full-suite runs per candidate of 1/k + 1 − (1 − p)^k.
- **At today's raw failure rate** (13/45 ≈ 0.29), batching saves almost nothing: 0.975 runs per candidate at k = 3.
- **After stage 1** removes most failures, suppose the residual rate is p ≈ 0.02 (an assumption to measure). Then k = 7 gives 0.143 + 1 − 0.868 = 0.275 runs per candidate, about 3.6× fewer suite runs.
- **Throughput:** 45 tasks took 249 min (≈ 332 s per task) with a ~270 s gate. Suppose stage 1 took ~30 s (unmeasured). Then per-task time ≈ 25 s generation + 30 s stage 1 + 270/7 ≈ 39 s, about 94 s, or ~35–38 tasks per hour.

**Batching hazards (ii).** Najafi, Rigby and Shang (ESEC/FSE 2019), studying batch testing at Ericsson, found batching saves most at low failure rates and that "Flaky tests are exacerbated by batching, as the batch size grows the probability that one or more commits will have a flaky test failure also grows." Google's Flake Aware Culprit Finding (Henderson et al., ICST 2023 Industry Track), evaluated on 13,000+ test breakages at Google, exists because naive bisection is "unreliable if the test being used for the bisection is flaky". Use the ADR-0084 flake diagnosis to re-run regression-only failures before bisecting.

**Is "faster" the right promise? (iii)** For unattended nights, throughput per night and "results ready by morning" matter more than per-task latency. Promise throughput and zero babysitting, and publish per-task latency honestly.

**Measurement.**
- **Planted regressions,** including one reached only through an entity glob, one through setupFilesAfterEnv and one through a DI string token. Stage 2 must catch 100 %; stage 1's miss rate is reported.
- **A night-long A/B** in tasks per hour against the current gate.
- **Periodic full-suite confirmation** of the final tree.

### Q7. What would show the design should change shape rather than be tuned?

**Bottom line.** Three results would each count as a change of shape:
- **(a)** Deterministic tools match the 7B on every surviving shape. Then the 7B is redundant, and the product is "planner plus codemods plus gate".
- **(b)** Even at low effort with machine plans, the fixed cost A stays above ~50k tokens, or its dollar equivalent. Then per-request planning is the wrong unit, and sidecrew should run standing *campaigns* over a measured population instead of user jobs.
- **(c)** A Sonnet-planned or low-effort run is non-inferior at lower dollars. That one is tuning, not a shape change. The architecture is falsified outright only if b ≥ W with zero reading, and today b is 9–25 % of W.

**Reasoning (iii):**
- The shapes where the 7B survives well (rename, unused imports) are the ones deterministic tools solve by construction. The shapes that need judgment (null_guard at 25/83, features at Y = 2/20) are where the 7B is weakest **(i)**. That split is the main warning sign.
- Knip's own docs say that when it reports something unexpected, "it's telling the truth about its module graph: it couldn't reach that code from an entry file". Knip's graph is static, so for NestJS reflection it gives *candidates*, and the gate plus the reflective guard must decide.
- **Campaign mode fits the recon data.** +282 lint-shaped errors (95 % in source) and +11,604 under --strictNullChecks **(i)** form a real population. One orientation cost spread over a population-sized plan is the regime where R already comes in below 1.

**On the worker model (ii).**
- A secondary 2026 guide (codersera) calls Qwen3-Coder-30B-A3B "the MLX-on-Mac coding default" and says "Don't downgrade to Qwen2.5-Coder". Treat that as a pointer, not evidence.
- Qwen3-Coder-Next (80B total, 3B active, Apache-2.0, February 2026) needs about 46 GB of unified memory at 4-bit per Unsloth's run guide (85 GB at 8-bit), so it is out of reach on the 32 GB machine.
- **(iii)** On a 32 GB machine where one suite takes 8.2 GB, a 30B-A3B worker at 4-bit (17.4–19.2 GB for Unsloth's 4-bit GGUF quants; an MLX 4-bit conversion lists ~22–27 GB) would force concurrency 1. Test it at concurrency 1 against the 7B at concurrency 2 on null_guard, the shape where capacity matters. On rename, the 7B's 18/19 byte-identical result says model capacity isn't the bottleneck.

**Comparable systems (ii).** The Minions line of work is the closest published analogue. Its result is that local-remote savings depend on the remote model decomposing tasks into short, local-sized chunks. That supports sidecrew's symbol-scoped tasks and argues against a long-context 7B reader.

## §10 challenged

### 1. "Route by size; below ~30–40 tasks hand the job to Opus directly."

- **Right:** small jobs lose money under the current planner. The fit puts break-even near 27–31 tasks against W_upper.
- **Wrong or unproven:**
  - The threshold rests on two points per arm. It roughly doubles (51–69) against Phase 11b's measured Opus-direct cost, and falls (~19) if Opus-alone pays its own fixed cost.
  - Routing on *planned* N is also exposed to planners that split tasks finely.
  - Worst, routing throws away the gate, fingerprinting and determinism on exactly the jobs users run most.
- **Instead:** route small jobs to Opus-edits plus sidecrew verify-only, or to a deterministic executor plus the gate, and never skip the gate. Estimate N from recon/query counts, which are compiler-backed and cheap.
- **Settle it with** the N = 1/3/5/12 four-arm head-to-head in Q3, in dollars per delivered task.

### 2. "Machine-generated plans for predicate-shaped jobs."

- **Right:** this is the strongest idea in the list. It attacks the fixed A, where the cost actually is.
- **Under-specified:**
  - Predicate tools are static. Knip resolves a static module graph and says dynamic imports cause false positives. Jest's graph misses non-literal requires. TypeORM globs and DI tokens hide real uses.
  - A machine plan for dead_code will propose deleting reflectively used code, and the gate will pass it if no test covers that path.
  - The proposal also keeps the 7B as executor even where a deterministic executor exists.
- **Instead:**
  - Machine plan, then reflective guard, then deterministic executor where one exists (language-service rename, ESLint --fix), the 7B only where none does, then the gate.
  - Opus reviews the compact plan in a single call at low effort, instead of orienting from scratch.
- **Settle it with:**
  - A and dollars per job;
  - survival;
  - planted-trap refusal rate (100 % required);
  - byte-diff agreement between deterministic and 7B executors on the same plan.

### 3. "Keep the gate strict; faster with affected-tests-first plus full-suite confirmation on the combined result."

- **Right:** the structure is correct, and full-suite confirmation is what keeps it sound.
- **Wrong or unproven:**
  - Confirming only "the combined result" hides which candidate broke it, and with today's ~29 % failure rate, combined runs will nearly always fail.
  - Batching also multiplies flake exposure.
  - "Affected tests" computed by jest's static resolver misses setup files, mapped paths, globs and DI.
- **Instead:** the Q6 design.
  - Stage 1 is the union of static and coverage-derived selection, with a full-suite fallback on config, setup, glob or decorator changes.
  - Stage 2 batches sized by the measured residual failure rate (k ≈ 1/√p), with flake-aware bisection.
  - The ADR should state the guarantee positively: every accepted final tree passed the full suite. The only thing given up is how fast a failure is attributed.
- **Settle it with** 100 % planted-regression recall in stage 2, plus tasks per hour over a night.

### 4. "Try graphify (free) before any paid reader; measure a Haiku reader only in dollars."

- **Right:** measuring in dollars is correct, and it applies to *everything*, not just Haiku.
- **Wrong or unproven:**
  - graphify is not free. It costs Opus tokens to consume its output, and ASTs don't see NestJS runtime structure.
  - Readers target the ~36 % reading term, which in dollars is likely the smaller share. The dominant term is output and thinking in the fixed A.
- **Instead:**
  - Run the effort sweep and the Sonnet-planner arm first.
  - Test graphify only for whether it cuts orientation thinking.
  - Extend the compiler-backed query layer, which planners already trusted, rather than improving the 7B reader.
- **Settle it with** the Q5 factorial, in separate workspaces, scored on dollars and survival.

### 5. "Do not put feature work in v1; keep ADR-0082 as the post-1.0 path."

- **Right:** agreed, and the overfitting literature (Smith 2015, Ahmed 2025, UTBoost 2025) supports it.
- **Under-specified:** ADR-0082 as summarised lets the 7B write the test (Y = 2/20), relies on user approval alone, and has no mutation check or held-out test.
- **Instead:** revise ADR-0082 to the five-condition gate in Q4, with Opus or Sonnet as spec author. Say plainly that this spends Claude tokens on the smart part, as the vision intends.
- **Settle it with** Y by author model on the same 20 targets, plus the held-out overfitting rate.

### 6. "Redefine the Cost bar as a new, dated decision, e.g. R ≤ 1.0 at the median plan size after routing."

- **Right:** a new, dated decision, disclosed in the release notes, is the correct procedure.
- **Wrong:** the example bar is circular. Routing sends only jobs where R ≤ 1 to the pipeline, so the median of the accepted jobs passes by construction. A registered-report editor would call that a deviation that removes the test's severity. It also keeps token counting, the comparator without a fixed cost, and per-planned-task counting.
- **Instead:**
  - Keep and report the old bar's failure.
  - Justify the new bar only by construct defects.
  - Define it in dollars per delivered task, against an Opus-alone arm that pays its own session overhead.
  - Pre-register it at fixed N values, and test it on fresh data, ideally project-b.
- **Settle it with** the fresh-data run itself. If the new bar fails too, v1.0 ships on capability and the cost numbers are published as they are.

## Making the next measurement correct by construction

**(ii)/(iii)** Each defect found this week maps to a structural fix:
- **Shared prompt cache between arms:** run one API workspace per arm. Anthropic documents that "Caches are isolated per workspace".
- **Shared scratchpad:** give each arm its own temporary root, and check before the run that no path is shared.
- **Substring classifier:** use structured, schema-validated outputs, plus a known-answer calibration set that the classifier must score perfectly before the run counts.
- **Machine-failure handling decided mid-run:** pre-register the rules (timeout, swap, OOM, gate crash) with the analysis plan, hash the plan and commit it before the run starts, and report deviations in the Willroth-Atherton format.
- **Canaries in every night:**
  - a planted mutant that must be killed;
  - a planted regression reached through an entity glob;
  - a planted flaky test;
  - a planted reflective dead-code trap that must be refused;
  - a trivially correct task that must survive.
- **Replicates and pinning:**
  - Pin model snapshots. Anthropic says dateless IDs from the 4.6 generation on are pinned snapshots.
  - Record the tokenizer generation.
  - Run at least three replicates per arm and interleave arm order.
  - Report intervals, not single values.

## Caveats

- **The regression fit uses two points per arm,** with different task mixes and realised rather than controlled N. Its break-even values could be off by a factor of two and should be read as orders of magnitude.
- **The dollar illustrations assume Opus 4.8 prices and a guessed token-class split.** They need the raw usage logs.
- **Several conclusions depend on unprovided files:** the frozen bar's wording, W_upper's derivation, the normalisation rule, ADR-0065/0082/0089 details, and which Opus model ran.
- **Some model and tool claims come from secondary sources** (the Qwen3-Coder guides, agentpatterns.ai, a self-published JS test-selection tool) and should be checked before anyone relies on them.
- **I found no official Jest documentation** that lists setup files, globs or DI as selection blind spots. Those rest on Jest's source, its issue tracker and my inference.
- **Current Anthropic prices were read from the live pricing page** and may change.