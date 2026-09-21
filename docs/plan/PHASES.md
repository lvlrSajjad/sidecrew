# Phases

Read `VISION.md` first. It is the destination; this file is the route, and every phase here either moves
towards it or is a detour that has to justify itself.

**`ROADMAP.md` is newer than this file and reorders it** (owner's statement, 18 Sep 2026): the science —
measurements, experiments, numbers, articles — comes first, the tool second, and the tool is judged by
whether a colleague sees an improvement over asking Opus or Sonnet directly. It also names the gap that
outranks everything in this table: **nothing here has ever been compared against not using sidecrew at
all.**

One phase per Opus session (roughly). Each has a prompt in `prompts/`, a definition of done, and a status
you update when finished. Don't start N+1 until N's DoD is met.

| # | Phase | Status | Prompt |
|---|-------|--------|--------|
| 0 | Scaffold, contracts, `doctor` | ✅ done | `prompts/phase-0-scaffold.md` |
| 1 | `serve` + worker client + bench | ✅ done | `prompts/phase-1-worker.md` |
| 2 | Verifier: TypeScript (Stryker) | ✅ done | `prompts/phase-2-verifier-ts.md` |
| 3 | Verifier: Swift (Muter) | ✅ done | `prompts/phase-3-verifier-swift.md` |
| 4 | MCP tools + `run` + skill wiring | ✅ done | `prompts/phase-4-mcp-skill.md` |
| 5 | Planner & exemplars (Opus side) | ✅ done | `prompts/phase-5-planner.md` |
| 6 | Go/no-go experiment | ✅ done | `prompts/phase-6-go-no-go.md` |
| 7 | Hardening | ✅ done | `prompts/phase-7-hardening.md` |
| 9 | Runners: Jest beside Vitest | ✅ done | ADR-0028, ADR-0036 |
| 10 | **Workload #2a: behaviour-preserving changes** — gate, sandbox, task and verdict contracts | ✅ done | `prompts/phase-10-workload-2a.md` |
| 11 | Workload #2a go/no-go: the frozen decision rule and its number | ✅ done | `prompts/phase-11-go-no-go-2a.md` · **§4 frozen 16 Sep 2026** · GO on project-a by zero margin, NO-GO on the fixture, project-b inconclusive |
| **11b** | **sidecrew against not using sidecrew** — Opus alone, Sonnet alone, sidecrew, and the gate applied to Opus's own output | ✅ **done, both projects** — project-a: a local 7B produced **byte-identical output to Opus on 18/19** tasks, arm C **19/19**, arm D 19/19. project-b: the first non-saturated rate, arm C **15/19** `[0.544, 0.939]` with **3 real worker defects** (122 compile errors on one) and 1 failure Opus reproduces exactly — **15/18** worker-attributable. **0 worker tokens** against 80,131/95,335 (Opus). Arm D found **no defect in Opus's output**: the gate's value is making a free worker usable, not second-guessing an expensive one | `prompts/phase-11b-against-the-status-quo.md` · **§4 frozen 18 Sep 2026** · **verdict WITHHELD per §4.4** (19/19 `rename`), declared before the first arm · five defects: ADR-0066/0067/0068/0069 + O8 · `experiments/status-quo/` |
| 12 | Management: the code-change planner, the correction round, what a stuck worker says | ✅ **built and measured** — see 12m | `prompts/phase-12-management.md` · ADR-0044, ADR-0057, ADR-0058 · the four deliverables are done; **§2.1 and §2.2 are a later session's**, against rules frozen 18 Sep before either existed. §2.2's denominator is unblocked by ADR-0063 |
| 13 | ~~The `api` tier~~ — **off the publish path, 20 Sep 2026 (ADR-0073)** | ⬛ **descoped by the owner** | The owner narrowed the supported surface: *24 GB+ laptops*. **§5 is cancelled** — the tier is no longer something publication waits on. The client stays, tested, behind `SIDECREW_TIER=api`, unsupported and unpriced; below 24 GB sidecrew now **refuses with a reason** rather than falling back. `WorkerKind` keeps `"api"` — Phase 11's C3 and 11b's arm D record it, including the corpus `D` was measured on |
| **13b** | **The edge ideas that gate publication** — unattended mode ✅, memoisation ✅, local retrieval | 🔶 **two of three built** · owner's decision 18 Sep 2026 | `BACKLOG.md` § *The edge ideas* items 4, 3, 1 · all three were Phase 12's and were not built. **Item 6 (two-model agreement) was considered and dropped** — its own precondition is untested |
| **12m** | **Phase 12's two measurements, and the two defects that would invalidate them** | 🔶 **19–20 Sep** — ADR-0066 ✅ (C) · ADR-0069 ✅ (A) · instrument ✅ · **§2.1: `R = 2.84` at `N = 12` and `1.07` at `N = 41`, FAIL at both** · **gate error rate: `D = 2/19 = 0.105`, UNACCEPTABLE** · **§2.2: `S_c = 0/29`, OFF BY DEFAULT** · ✅ **all four measured** | `prompts/phase-12-measurements.md` · the instrument was wrong **three** ways, not one — blind to subagents, double-counting every message (median 1.89×), and ENOENT on any path with an underscore. Two were in `BACKLOG.md` unacted on |
| 14 | **Publish**: npm + MCP Registry, docs site — includes the workload #1 hardening items below | ⬜ **next** · **cut `v0.1.0`** | `prompts/phase-8-publish.md` · no overnight run · gates: `deriveLineRange` on the AST, `doctor`'s pre-flight questions, ADR-0042, and the owner's sentence on publishing rates as intervals |
| **14b** | **The editing ceiling: is it the model or the task?** — two probes on §2.2's declared task set | ✅ **`S₁₄ = 2/30`, both probes < 0.10 → PROCEED to 14c.** Neither: the workers do the work, the gate cannot credit it (**ADR-0077**, proposed) | **one evening · needs the machine** · no build, no version. Decides whether "any shape of change" is reachable at all |
| **14c** | **The reach: symbol-scoped return** (ADR-0075 option C) — half a codebase is currently unaddressable | ⬜ · **cut `v0.2.0`** | 2–3 sessions · **one overnight run** · needs ADR-0075 decided, and the AST work from 14 |
| **14d** | **Retrieval: local models read the codebase** — the other half of the vision | ⬜ · **cut `v1.0.0`** | 3–4 sessions · **one overnight run** · needs its own ADR first: a machine confirms a symbol *exists*, not that it is *relevant* |
| 15 | Workload #2b: behaviour-changing changes | 🔷 proposed · **post-1.0** · **ADR-0082 gives it a candidate oracle for the first time** | ADR-0031 options B/C · the remaining slice of the 90 %, and the one nothing measured so far says anything about. **ADR-0082 (proposed, 21 Sep) is the missing instrument**: a test written to the *expected* behaviour, by the worker, before the change. Needs its option D measured first |
| 16 | Python + Kotlin verifiers | ⬜ | (write when publish is done) |
| 17 | The edge ideas: fine-tune on survivors, worker pooling, two-model agreement | 🔷 proposed | `BACKLOG.md` § *The edge ideas* |

**The path to publish is 10 → 11 → 11b → 12 → 14**, and **the path to the 90 % bar is 14 → 14b → 14c → 14d**, in that order, and numbers are the order ("don't start
N+1 until N's DoD is met"). Workload #2b is behind publish on purpose: the owner's bar is the worked
example in `VISION.md`, which is #2a with the management loop on the supported tier. 2b is in the vision and is
not in the bar.

## Publishing moved, twice, and the second move is the owner's decision of 16 Sep 2026

**First move:** behind runner support — releasing a tool that cannot verify a React Native or Nest project
is releasing it for the fixtures rather than for the users.

**Second move, and the one that matters:** behind **workload #2**. From the owner:

> I prefer to make it public when it does my vision. I don't want to make something half baked as my
> final product.

That is a correct reading of what this is. A tool that only writes unit tests is a **waypoint**, and
publishing it as a final product would name the project after its first workload — a label that is much
harder to escape later than it is to broaden now. Phase 14 is the old Phase 8 prompt, unchanged.

**Refined later the same day**, and now the bar `VISION.md` spells out: *"everything should be published
when what I proposed works properly and people can use it on their code base with no problem."* That
sentence added one phase — 13, the Haiku tier — because a tool that does not run on a 16 GB laptop was
judged not to be one people can use (ADR-0045). **The owner reversed that on 20 Sep 2026 (ADR-0073):
sidecrew is a 24 GB+ tool, it refuses below the floor with a reason, and Phase 13 leaves the publish
path.** The reversal is kept visible rather than edited away — the original judgement was reasonable
and the scope decision is the owner's to make.

**What this decision costs, stated honestly:** workload #1 is finished, measured on unmodified real
projects, and will sit unreleased for the length of Phases 10–13 and the publish phase itself. Nobody else gets to use it or find its
next defect in the meantime, and six trials have shown that real users find things no amount of reading
finds. That is a real price and the owner has chosen to pay it.

## Where the numbers stand today (16 Sep 2026)

Workload #1, on **unmodified** real projects, after ADR-0033 through ADR-0041:

| project | stack | rate | median survivor score | n |
|---|---|---|---|---|
| project-a `assetUtil` | Nest | 3/8 | 1.00 | 13 attempts |
| project-a `import.file.utils` | Nest | 4/8 | — | 12 attempts |
| project-b `array` | React | 4/10 | 0.871 | 16 attempts |

Workload **#2a**, on **unmodified** real projects, 18 Sep 2026 — `experiments/go-no-go-2a/results/REPORT.md`:

| input | S(C2) | S(C3) | A(C2) | A(C3) | §4.3 |
|---|---|---|---|---|---|
| fixture | 3/3 | 3/3 | **1/3** | 3/3 | **NO-GO** — the approval veto |
| project-a (Nest) | **12/12** | 12/12 | **9/10** | 10/10 | **GO, zero margin** |
| project-b (React) | **11/12** | 12/12 | **9/10** | 10/10 | **GO, zero margin** |

Survival was at its ceiling in every cell it could be measured, so **the approval rate decided the
phase on its own**. Both times it bound, it was the same behaviour: the local 7B edits documentation
it was not asked to touch, and the gate cannot see prose. That is ADR-0054, proposed with the count
attached. `edit_parse_failed` and `edit_truncated` were **0** everywhere, so §4.4 did not fire and
whole-file rewriting is vindicated. Zero confinement breaks in ~60 attempts: the Goodhart surface
ADR-0048 was built against did not appear.

The gate costs **~260 s a candidate** on both real projects and is 95 % of a candidate's cost — the
number ADR-0044 §4's correction round has to be budgeted against. The gate's known hole, measured:
**2 of 12 survivors (0.167) changed lines no test executed**, identical on both arms, so those were
admitted by `tsc` alone. Mild for a rename, where the compiler proves completeness; much weaker for
a null guard or an API migration, and the figure belongs beside any rate quoted publicly.

**Six defects** were found on the first two real projects, and none was visible in a summary
statistic (ADR-0049, ADR-0050, ADR-0052, ADR-0053, ADR-0055, ADR-0056). The two worst corrupted the
gate's *inputs* rather than the gate: a launcher's environment reaching into the project's toolchain,
and one run's test-runner cache reaching into the next. Both left the gate working, proving it ran,
and quietly requiring less.

Across three inputs and two task shapes the local 7B had exactly one measurable weakness: **4 of 23
sampled survivors made unrequested cosmetic edits** — a deleted docblock, a reworded comment, a stray
blank line — against **0 of 23** for the control. The gate cannot see any of it.

Rates, not a rate: one module each, one machine, one seed, and 4/10 has an exact 95 % interval of roughly
0.12–0.74. Not pooled. The fixture's 0.85 is **not** comparable — it is 21 small pure functions in a
project we configured, and it overstates real-world by more than 2×.

# ▶ Prioritised next steps

The order is by evidence, not by appetite. Each item says what it unblocks and what it would cost to be
wrong about it.

### 1. Phase 11 — the go/no-go for workload #2a, against a rule that is already frozen
`prompts/phase-11-go-no-go-2a.md` §4 was written during Phase 10, **before `sidecrew fix` had produced a
single verdict**, which is the whole point of it: a rule written after a number is a description of that
number. It adds two things Phase 6's rule did not have and both are deliberate —

- **a blind approval rate `A(x)`** as a veto alongside the survival rate. A 2a survivor is *edited
  source*, and the headline claim is "the same quality Opus would produce"; ADR-0020 had to be written
  after Phase 6 because survival rate alone could not separate "survived" from "survived by not testing
  the thing", and the 2a form of that failure ships;
- **a clause that says the number is not about the model**: at or above a quarter of attempts failing to
  parse or truncating, the run is inconclusive and the next action is an edit-format experiment rather
  than a verdict on the workload (ADR-0047 §2).

It also asks for the gate's known hole as a reported number — the fraction of survivors whose changed
lines no test that ran executed. Those survivors were admitted by `tsc` alone, and a rate printed without
that figure reads as a stronger claim than it is.

### 2. ~~Phase 10 — workload #2a, behaviour-preserving changes~~ — **done, 16 Sep 2026**
The apparatus exists and the gate has been shown to be honest on a fixture. **No survival rate** — that
is item 1, deliberately. See the section below for what it delivered and what it found.

### 3. Fix workload #1's one remaining known softness — `deriveLineRange` should read the TypeScript AST
Four patches now (ADR-0033, ADR-0035, ADR-0039, and the return-type case inside ADR-0035), and *"no
mutants at all"* has been wrong **all four times** anybody checked it. `typescript` is already resolvable
from every project sidecrew verifies and the compiler cannot be wrong about where a body starts. Cost of
being wrong about this: a planner silently drops functions it should have planned, which is invisible in
every report.

### 4. `doctor` learns the three pre-flight questions that now fail per candidate
Whether the tsconfig's `include` covers the directory `testDirFor` picked (ADR-0037), whether the ts-jest
shim is available on this layout (ADR-0038), and how much heap `tsc` needs. All three are facts about a
project's layout, which is what `doctor` is for. The OOM message is the template: it names the cause as a
machine limit, disclaims the candidate, and prints the exact remedy.

### 5. Render what the body's meaning depends on
Three shapes across three projects now — a sibling module's enum, the module's *own* import, and a rule
the planner wrote into `notes`, which is never rendered. Best-evidenced prompt change available, and it
transfers directly to workload #2, where a worker reading unfamiliar code needs it more than a worker
writing a test does.

### 6. ADR-0042 — name a self-contradicting candidate, do not salvage it
Escalation reason only. Deleting the contradicted assertions and calling the remainder a survivor is a
different decision, needs its own ADR and a fresh baseline, and is explicitly not recommended.

### After 11, in this order
- **Phase 12 — the management side.** The planner that turns "refactor the project" into grouped, ordered
  tasks; the correction round (Opus reads the verdict, writes one note, the worker tries once more, against
  a per-run budget); and the stuck signal. ADR-0044 §3–4. It waits for 11's number because the correction
  round is only worth building if the *uncorrected* survival rate leaves room for it to matter, and its own
  value is a measurement — corrected-attempt survival against the tokens each correction cost.
- **Phase 13 — Haiku on 16 GB machines. BUILT, then DESCOPED by the owner (20 Sep 2026, ADR-0073).**
  *Everything below describes the phase as it stood; it is kept because the reasoning was sound and the
  scope call is the owner's, not the phase's.* The `api` client that
  ADR-0009 decided and nothing built now exists: `src/api-worker.ts`, tier selection from *installed*
  RAM, `runBatch`/`runFix` no longer hard-coding `local`, accounting from the API's own usage fields,
  and a tier row in `doctor`. Three ADRs settled §2's open decisions — **ADR-0059** (a `fetch` client,
  so the one-runtime-dependency rule holds, with the retry rule stated because it is the thing that can
  double a bill), **ADR-0060** (pinned to `claude-haiku-4-5`, and the pin is weaker than a revision
  sha), **ADR-0061** (the number is taken fresh on the current tool, not against Phase 11's arms).
  - **§5 was deliberately not run.** It spends real money on the owner's account, so the phase stops at
    the measurement's edge. The tier therefore has **no survival rate, no approval rate and no price**,
    and Phase 6's C3 figures remain an upper bound from a subagent harness that cannot be quoted as
    what the tier costs (ADR-0045 §7). What §5 needs to run is in the phase prompt and in the handoff.
  - Also found, and **not fixed here**: **ADR-0062 (PROPOSED)** — a refusal on a single-file task is
    swallowed by `parseEdits`' bare-answer fallback, on both tiers, so `refusals` is structurally 0 in
    the only configuration anything has been measured in.

### Not next, and why
- **Publish (Phase 14).** The owner's decision above, and its refinement: the supported tier, unmodified projects,
  `doctor` naming every remaining failure with its fix. Items 3–6 above are workload #1 hardening with no
  phase of their own; they are part of Phase 14's DoD, because "no problem on their code base" is what
  each of them is about.
- **Python and Kotlin (Phase 16).** More languages multiplies the surface before the second workload has
  proven the shape. TypeScript is where all six trials are.
- **Workload #2b (Phase 15).** Not on the publish path. Needs 2a's number first, and its economics and its Goodhart direction are
  both worse — ADR-0031 has the argument.

## 9 — Runners
Jest beside Vitest, so React Native and Nest can be verified at all. ADR-0028.

**Done** (2026-09-16). Delivered: `TsTarget.runner`, `runnerFor` off the plan's `test_framework`,
`jest --ci --runTestsByPath`, a `jest` block in the generated Stryker config, a `stryker-runner` row in
`doctor`, `fixtures/jest-fixture` with its own plan and exemplars, fast tests and a slow test, and a
latent circular import fixed on the way (`doctor → verifier/ts → concurrency → serve → doctor` made
`DEFAULT_VERIFIER_CONCURRENCY` undefined at import time).

**Measured: the runner is a seam.** Same plan, same model and revision, same seed, one runner swapped —
**3/5 either way, the same three survivors at the same scores (1.00, 1.00, 0.80), the same two
escalations.** Identical verdicts, not a similar rate.

**The thing that did not work is the thing worth remembering.** The first end-to-end attempt failed every
candidate with type errors about code nobody wrote: ts-jest type-checks by default, and Stryker
instruments the source it mutates, so ts-jest was type-checking Stryker's instrumentation. Transpile-only
fixes it and costs nothing, because the pipeline already type-checks twice elsewhere. That is Phase 4's
`<|im_end|>` and Phase 6's empty shim a third time — **the gate is only as honest as what reaches it** —
and it is now four for four that the first real run of anything finds one of these.

**Not done**: whether a *React Native* project's Jest setup survives Stryker. `jest-expo` brings a preset,
`setupFiles`, native mocks and a wide `transformIgnorePatterns`, and the fixture is plain ts-jest. That is
`experiments/real-world/README.md`, deliberately a separate experiment with a frozen protocol, because the
honest version of this phase's claim is "Jest is supported" and not "React Native works".

### The four real-world trials, and what each cost
Three trials produced zero verdicts; the fourth produced the first. What they bought, in order:
ADR-0029 (the run guessed which model was loaded), ADR-0030 (Stryker 10 breaks on every project; pnpm
loads no plugins; `classifyProbe` reported a falsehood), ADR-0033 and ADR-0034 (six things sidecrew
believed about what a project looks like), ADR-0035 (the sandbox deleted a source file, and the range
finder hid an 18-mutant function), ADR-0036 (the two blockers below).

### What blocked workload #1 on real projects, and its state — all closed
| | | |
|---|---|---|
| **ts-jest cannot be mutated** | Nest, and anything on ts-jest | **fixed**, ADR-0036 — reproduced on `fixtures/jest-fixture/jest.diagnostics-on.config.js` and asserted in the slow suite |
| **Stryker loads no plugins under pnpm** | React, and anything on pnpm | **fixed**, ADR-0036 — reproduced in `experiments/pnpm-plugin-loading/`, mechanism identified in Stryker's own source |
| **an unmodified real project reaching a verdict** | Nest | **done**, 15 Sep — project-a, nothing changed in it: **3/8 survived, median mutation score 1.00**, and a second module independently 3/8 for **6/16 across two modules**. The run reproduced the previous repaired run attempt-for-attempt, so 0/8 → 3/8 is the fixes and not variance |
| **the compile stage actually compiling** | all | **fixed after the trial**, ADR-0037 — it could report `compile ok` on a candidate it never opened, and did |
| **an unmodified real project reaching a verdict** | React | **done**, 16 Sep — project-b `array`, **4/10 at a median survivor mutation score of 0.871**, on the sixth trial, after ADR-0037 closed the gate |

The numbers are in the table at the top of this file. **Workload #1 is finished**, and by the owner's
decision of the same day it is not what gets published — see `VISION.md` and the prioritised next steps.

**The finding worth carrying into workload #2.** The sixth trial measured ADR-0037's fail-open hole on
*real worker output* rather than a planted control: `isSubsetDeep:happy_path:0` fails `tsc` on a genuine
generic-inference trap and passes the project's own jest 7/7. Under the old gate it would have been
`compile ok · pass ok` and `killed ≥ 1` was near-certain, so the broken gate would have printed **5/10
where the fixed gate prints 4/10**.

Workload #2a's gate is the project's existing suite, which is somebody else's code that sidecrew does not
control — so the same question has to be asked of it before any number is believed: **can this gate prove
it actually ran, on the thing it claims to have checked?** That is a DoD line in Phase 10, not an
afterthought.

## 0 — Scaffold, contracts, doctor
**DoD:** `src/schemas.ts` covers every shape in `docs/specs/pipeline.md` and round-trips the spec examples in tests; `sidecrew doctor` reports node / mlx_lm / worker / memory / tsc+vitest+stryker / swift+muter each as ok / missing / degraded; `npm run lint && npm test` green; fixture shells exist.

**Done** (2026-09-10). All nine shapes in zod; the test extracts every json block from the spec and parses it, and fails if blocks and schemas ever diverge (ADR-0007). `src/exec.ts` is the single shell-out, with a process-group kill on timeout. `doctor` exits non-zero only on node or memory. Fixture shells build and their test targets run. Not done, deliberately: `serve`, the worker client, verifiers and MCP tools still throw with their phase name; there is no CI workflow yet (BACKLOG).

## 1 — serve + worker client + bench
**DoD:** `sidecrew serve` starts `mlx_lm.server` with the pinned revision from `src/models.json`, pidfile + log under `.sidecrew/`; `sidecrew stop`; `src/worker.ts` completes a chat at temp 0 + seed and returns identical output 5/5 (ADR-0003 if batching interferes); `sidecrew bench` writes `experiments/go-no-go/results/bench-<date>.json` (tok/s, TTFT, peak RSS, machine) for 7B and, if it fits with Xcode open, 14B; revisions pinned.

**Done** (2026-09-11). Both revisions pinned — and pinning turned out to mean something other than the
prompt assumed: mlx_lm 0.31 has no `--revision`, so `serve` passes the cached snapshot *path*, which is
one immutable commit that cannot reach the network (ADR-0010).

Measured on the baseline M2 Pro / 32 GB, macOS 26.6.2, mlx_lm 0.31.3, mains, Xcode **and** a simulator
open (`experiments/go-no-go/results/bench-2026-09-11.json`, `"measured": true`):

| model | decode | TTFT warm | peak RSS | swapped | determinism |
|---|---|---|---|---|---|
| qwen2.5-coder-7b-4bit | **40.5 tok/s** | 159 ms | 4527 MB | 0 MB | 5/5 byte-identical |
| qwen2.5-coder-14b-4bit | **21.1 tok/s** | 199 ms | 8258 MB | 0 MB | 5/5 byte-identical |

Quiet-machine comparison in `bench-2026-09-11-quiet.json`: 42.3 and 21.2 tok/s. So the whole Xcode +
simulator working set costs the 7B about 4 % and the 14B almost nothing — the constraint it imposes is
memory, not speed. Cold TTFT on a fresh worker is ~4 s of graph compilation; warm TTFT is what the table
shows, and after the readiness fix below it is no longer charged to the first request.

**Does the 14B fit with Xcode open? It depends on free RAM at that instant, and that is the answer.**
With Xcode and a simulator open this machine sits anywhere from 9.1 GB free (just after booting the
simulator) to 14.1 GB (settled). At 14.1 GB the 14B runs clean — 0 swapouts, 21.1 tok/s, and its true
footprint is 8.06 GiB. At 9.1 GB the same run **swapped out 3.2 GB**, and *reported a lower peak RSS
while doing it*, because macOS compresses under pressure. The 7B swapped 0 MB in every configuration
measured, at 4.42 GiB. So the 7B stays the default; the 14B is allowed only when the gate says there is
room at that moment (`ram_gb` 8.2 + 2 GB headroom = 10.2 GB free), and `ram_gb` is a measured
steady-state footprint rather than a research estimate (ADR-0011).

Determinism: 5/5 byte-identical on both models in every configuration, and the reason is in the source
rather than in the luck — mlx_lm excludes any seeded request from its batch (ADR-0003). A negative
result is recorded there too: unseeded *concurrent* requests also came back identical, so this run did
not reproduce the divergence research §C warned about and cannot be cited as proof the seed is required.

Fixed in review before Phase 2, each with a regression test: `serve` treated "`/v1/models` answers" as
ready, but mlx_lm serves that endpoint from the Hugging Face cache while the model is still loading —
measured 1.9 s early on a warm 14B, and the whole load when cold. Readiness now means the worker
generated a token. That also fixed the footprint numbers above, since the RSS sampler had been measuring
a model on its way up. A `serve` that failed readiness deleted its pidfile *without killing the worker*,
leaking a process holding the port and several GB with nothing left to find it by. `stop` would signal a
whole process group on a pid read off disk without checking it was still ours — a stale pidfile plus pid
reuse put somebody else's work in the blast radius. And the new swap flag fired at >0 MB, which on a
system-wide counter means it fired on 10.8 MB of background noise; it now has a floor calibrated between
that and the 3197 MB that mattered. CI (`.github/workflows/ci.yml`) runs the fast set on macOS for node
20 and 22, and fails if the two versions disagree or a shipped model is unpinned or non-permissive.

Not done, deliberately: no `api`-tier client (ADR-0009 decided the tier; nothing calls it, so the
fallback is documented and inert). No `sidecrew models --download`; getting weights into the cache is
still mlx_lm's job or the user's. Verifiers, planner and MCP tools still throw with their phase name.

## 2 — Verifier: TypeScript
**DoD:** `fixtures/ts-fixture` (~20 pure functions, Vitest, strict, one planted off-by-one); Stryker config scoped to one file, incremental; `verifyTs` → `Verdict` with stage, error (≤ 2 KB), mutation score, killed ids, per-stage ms; tautology detector separates 4 tautology / 4 legit fixtures; cost per candidate recorded.

**Done** (2026-09-12). 21 functions across five files; `verifyTs` runs tautology → `tsc --noEmit` →
`vitest run <file>` → `stryker run` and returns a parsed `Verdict`. The detector separates all eight
fixtures and names a different reason for each of the four tautologies.

Measured on the baseline M2 Pro / 32 GB with Xcode open
(`experiments/go-no-go/results/verifier-ts-cost.json`, `"measured": true`):

| | median | p90 |
|---|---|---|
| a surviving candidate | **7.2 s** | 15.5 s |
| a tautological candidate | **0.80 s** | — |
| compile / pass / mutation | 0.44 s · 0.36 s · 6.4 s | — |

The mutation stage is ~90 % of a verdict, which is why the static check runs first and short-circuits it:
a tautology costs 0.8 s instead of 8 s, and nothing that cannot survive ever reaches the expensive stage.

**Three things the prompt did not ask for, each because measuring turned one up.** *(a)* The sandbox
excludes the project's own tests (ADR-0004) — otherwise, in any repo that already has a suite, every
candidate inherits kills earned by tests that were there first and `killed ≥ 1` stops meaning anything.
*(b)* Stryker's incremental cache is per candidate and therefore always cold: with a shared cache, a
candidate whose only assertion was `expect(true).toBe(true)` was credited with the previous candidate's
6 kills — measured, with the mechanism quoted from Stryker's source. *(c)* Mutation is scoped to the
function's line range rather than the file (ADR-0013): 7.2 s against 23.4 s, and a median score of 0.83
against 0.19, because a whole-file score is mostly a report on functions nobody was asked to test — and
ADR-0006 routes review by that score.

`stage_reached` gained a meaning it did not have (ADR-0012): `done` is a completed pipeline and
`mutation` is now reserved for a mutation run that broke, which is not the candidate's fault and must
not consume the single retry. One contract example changed with it, in the same commit as the ADR.

Not done, deliberately: no `sidecrew verify` CLI subcommand and no `.sidecrew/runs/<id>/` artefacts —
Phase 4 owns both, and `verifyTs` takes an explicit target because there is no `TestPlan` to read one
from yet. `deriveLineRange` is the stand-in for `TestPlan.functions[].line_range` and says so. The Swift
verifier, the planner and the MCP tools still throw with their phase name.

## 3 — Verifier: Swift
**DoD:** `fixtures/swift-fixture` (SwiftPM, XCTest + Swift Testing targets); Muter scoped via `--files-to-mutate`, `SWIFT_TREAT_WARNINGS_AS_ERRORS=NO`; `Verdict` parity with TS; Swift Testing attribution handled or ADR-0005; cost recorded.

**Done** (2026-09-12). 21 functions mirroring the TypeScript fixture, nine candidates — four legitimate
and five tautological, across both frameworks — and `verifySwift` runs tautology → `swift build
--build-tests` → `swift test` → `muter run` and returns the same `Verdict` as `verifyTs`. All nine are
classified correctly and the detector names four different reasons for the five tautologies.

Measured on the baseline M2 Pro / 32 GB with Xcode **and** a simulator open
(`experiments/go-no-go/results/verifier-swift-cost.json`, `"measured": true`, muter 16, Swift 6.3.3):

| | median | p90 |
|---|---|---|
| a surviving candidate | **28.0 s** | 92.6 s |
| a tautological candidate | **8.3 s** | — |
| compile / pass / mutation | 7.9 s · 1.1 s · 18.8 s | — |

Against TypeScript's 7.2 s and 0.80 s, so a Swift verdict costs roughly **4× a TypeScript one**, and a
Swift *tautology* costs 10× — because the static check still cannot save the compile and run stages,
only the mutation stage, and on Swift compile alone is 7.9 s. **No simulator is involved**: it is a
macOS SwiftPM package and nothing boots a device, which the results file records as a field rather than
as a claim.

**Swift Testing was broken and would have shipped broken.** Muter decides a mutant was killed by
matching `with ([1-9]{1}[0-9]{0,}) failure` — XCTest's summary line, which Swift Testing never prints.
Read out of the installed binary. Every detected mutant of a `@Test` came back `runtimeError`, which is
also what a crash looks like, so no Swift Testing candidate could ever have survived anything. ADR-0005
is the whole story; the fix is a generated wrapper that appends the sentence Muter reads, and only when
Swift Testing actually reported a failed run. `swift_testing_kills` in the results file is **2** and
would be 0 without it.

**Four more things the prompt did not ask for, each because running it turned one up.** *(a)* Muter has
no per-mutant timeout, and one mutant of `chunk` never finishes — the first attempt had to be killed by
hand. *(b)* The watchdog for it does not work the obvious way: SwiftPM runs the built `xctest` binary
in a process group of its own, so `set -m` plus a group kill left two orphans at 99.9 % CPU with
`PPID 1`, still running after the verdicts they belonged to had been returned and looked correct. It
now kills by working directory first. *(c)* `.build` must never enter the sandbox: Muter copies the
package to a sibling directory and a copied module cache names the path it was built at, so every
mutant fails with `missing required module 'SwiftShims'`. *(d)* **`swift test` exits 0 when it runs
nothing** — a new cheap pass in ADR-0006's sense that the exit code cannot see, so the run stage now
counts the tests both frameworks report.

ADR-0013's function scoping arrives through a different door, because Muter has no
`--mutate file:from-to`: the scope is applied to its **report**. Measured, that moves the median score
from 0.125 to **1.00** and the wall clock not at all — the mutation stage is the same run either way.
Swift gets ADR-0013's score and not its 3.3×. It also gets a *coarser* score: a function-scoped Swift
verdict is computed over one or two mutants against TypeScript's six to twelve, because Muter's whole
operator set is four rules. Some perfectly ordinary Swift has no mutants at all, so the verdict
distinguishes "your test killed nothing" from "nothing here can be mutated" — the single retry must not
be spent rewriting a test that was never the problem.

Not done, deliberately: no `sidecrew verify` CLI subcommand and no `.sidecrew/runs/<id>/` artefacts —
Phase 4 owns both, and `verifySwift` takes an explicit target for the same reason `verifyTs` does. The
Swift `killed` count is a known lower bound and the sharper gate is in BACKLOG rather than in a late
edit to a phase that had already measured itself. The planner and the MCP tools still throw with their
phase name.

## 4 — MCP tools + run + skill wiring
**DoD:** `sidecrew mcp` exposes `sidecrew_status/generate/verify/run_batch`; `sidecrew run plan.json` does generate → verify → retry once → escalate with memory-aware concurrency and writes `.sidecrew/runs/<id>/`; `claude mcp add … npx -y sidecrew mcp` works from a clean checkout via `npm link`; `claude/skills/sidecrew/SKILL.md` drives `/sidecrew run` on the TS fixture and returns only survivors.

**Done** (2026-09-14). All four tools, all three CLI subcommands, and the loop between them. Verified
from a clean install: `npm run build && npm link && claude mcp add --scope user sidecrew -- sidecrew
mcp`, `claude mcp list` ✔ Connected, and a real `tools/call` over stdio returning a `StatusReport` with
the loaded model and its pinned revision.

Measured on the baseline M2 Pro / 32 GB with Xcode open and one 7B worker, six tasks over
`fixtures/ts-fixture/src/strings.ts`
(`.sidecrew/runs/2026-09-14T10-24-26Z-strings/result.json`):

| | |
|---|---|
| survived | **6/6**, 0 retried, 0 escalated |
| per task, end to end | **13.8 s** median · 28.7 s p90 |
| peak worker RSS | 4467 MB, concurrency 1 |
| Claude tokens for generation | **0**, and the schema is what enforces it |

13.8 s against the 7.2 s a Phase 2 verdict cost alone, so generation is roughly half a task.

**6/6 is not the good news it looks like.** `truncate`'s boundary candidate survived at 0.92 without
ever testing the boundary that carries the fixture's planted off-by-one: it asserts
`truncate("Hello", 4) === "Hel…"` and never asks what happens at `text.length === maxLength`, which is
the one input class the source gets wrong. ADR-0006's argument arrived on its own in the first real
run, which is why the skill now says not to report a survivor as a good test.

**The first attempt failed 6/6 for a reason that was not the model.** mlx_lm 0.31.3 streams
`<|im_end|>` as content, so every candidate arrived with the end-of-turn token after its closing
markdown fence, the fence stripper's anchor missed, and six verdicts came back looking exactly like a
7B that cannot write TypeScript. Stripping the marker before unwrapping the fence took the same six
candidates from 0/6 to 6/6 with nothing else changed. That is the measurement this phase would most
like the next one to remember: the gate is only as honest as what reaches it.

ADR-0014 decided, as the prompt required, before the dispatch was written: `TestPlan.test_target`,
optional and Swift only, with the verifier's "one target, or refuse by name" as the fallback and
`--test-target` as the call-site override. Schema, spec and ADR in one commit.

`planConcurrency` replaces the deleted `max_concurrency_32gb` *and* `DEFAULT_STRYKER_CONCURRENCY`:
one slot is the model's measured footprint plus `serve`'s 2 GB headroom, free RAM at the instant the
run starts divides into slots, and `workers × verifier ≤ slots`. On the baseline machine with one
worker up that is 1 × 2 — arriving at the 2 Phase 2 measured with rather than hard-coding it twice.

Not done, deliberately: no `sidecrew_plan_validate` and no `sidecrew plan --validate` — Phase 5 owns
both, and the skill no longer names a tool that does not exist; a run does its own staleness check
instead. No planner, so `fixtures/ts-fixture/test_plan.json` is hand-written (its exemplars were
verified, not assumed). The Swift path is wired and unexercised by this phase's acceptance, which is on
the TypeScript fixture: a multi-target package with no `test_target` raises a `VerifierSetupError`
naming the targets, which is the deliberate landing point ADR-0014 chose. The `api` tier of ADR-0009 is
still documented and inert. A worker or verifier exception still fails the whole batch rather than the
one task — Phase 7's hardening owns that, and it is in BACKLOG.

## 5 — Planner & exemplars
**DoD:** shape taxonomy fixed in the spec; `test-planner` agent produces a valid `TestPlan` + exemplars that survive; `sidecrew plan --validate`; prompt ablation (bare / +exemplar / +exemplar+rules) measured on the TS fixture; `source_sha` staleness check.

**Done** (2026-09-14). The taxonomy is six kinds with the question each one asks, and 1–3 shapes per
function is now in `zod` rather than in prose. `sidecrew plan <plan>` and `sidecrew_plan_validate` are
the same check — fourteen typed codes, every problem reported at once rather than the first one — and it
is `valid` only when every exemplar has itself compiled, passed, killed a mutant and come back
non-tautological. Four plans over the TS fixture: **14 functions, 20 tasks, 8 exemplars, all surviving.**

**The ablation did not confirm the thing this phase exists to exploit.** 20 tasks, qwen2.5-coder-7b-4bit,
temperature 0, seed 42, no retry
(`experiments/go-no-go/results/prompt-ablation-2026-09-14.json`, `"measured": true`):

| variant | survived | compiled | median score of survivors | completion tokens | generate |
|---|---|---|---|---|---|
| bare | **4/20** | 5/20 | 0.93 | 248 | 7.7 s |
| bare + one sentence: import the test framework | **16/20** | 20/20 | 0.93 | 258 | 9.6 s |
| bare + the exemplar | **15/20** | 20/20 | **1.00** | 218 | 6.9 s |
| bare + the exemplar + the shape rules | **17/20** | 20/20 | **1.00** | **150** | **5.3 s** |

Every one of bare's 15 compile failures was the same missing line, `import { describe, it, expect } from
"vitest"` — exactly the five candidates that had it are the five that compiled. So the 4 → 15 that reads
like "the exemplar makes a 7B usable" is the exemplar happening to carry an import nobody asked for. The
fourth row was added after that was found, to separate the two claims, and one sentence scores **16** —
one *above* the full exemplar. `exemplar+rules` still wins at 17 and is what ships unchanged, but it is
kept for the two things the survival column does not show: survivors score **1.00** against 0.93, at
**150** completion tokens against 258 and 5.3 s of generation against 9.6 s. ADR-0017 has the argument
and the caveats; the headline one is that 16/15/17 is one or two tasks at n = 1 and is not a ranking.

**Two contract-level findings, each because running it turned one up.** *(a)* ADR-0015: an exemplar has
to name the function it tests. Verifying one means mutating a function's lines, and the exemplar is
deliberately about a function `functions[]` omits — so nothing in the plan said which lines, and
ADR-0013 is the ADR about how expensive mutating the wrong ones is. `TestShape.exemplar_function`, and
`WorkerShape` omits it so the worker never sees a second function name. *(b)* ADR-0016: under strict
TypeScript some functions have **no mutants at all**. `machine.ts`'s `nextState` and `applyAll` have
zero — Stryker generates mutants and its type checker drops every one as a type error — so only
`canTransition` is mutation-testable there, it cannot both host the exemplars and be planned, and the
module has no plan. That is ADR-0005's Swift finding arriving on TypeScript through the opposite door,
and it is pinned as a test rather than as prose.

`meta.planner_tokens` is measured rather than guessed: `scripts/planner-tokens.mjs` reads Claude Code's
own usage record. **129,234 tokens** for the pass, excluding cache reads — which are the same context
re-sent, and were 5.4 M. The four plans were written in one pass over the fixture, so the per-plan number
is that total split four ways: an allocation, not a measurement, and BACKLOG says so.

**The Swift fixture was planned too, after the phase closed, as Phase 6's prerequisite.** Its 21
functions were probed for mutants first (`scripts/probe-mutants.ts`, now `npm run measure:mutant-probe`)
and the result rewrote the rule: **15 of 21 are survivable**, and the six that are not fail in three
different ways. Two have no mutants. **Three have only mutants that crash** — `killed` counts mutants a
test reported a *failure* against, so a crash counts towards the score and never towards survival
(ADR-0005 §2), and `Machine.nextState`'s single `SwapTernary` mutant force-unwraps nil. One is
unresolved. That killed the first version of the probe, which called anything with a mutant plannable;
`classifyProbe` is four-valued and tested.

Nine of the fifteen survivable Swift functions have **exactly one mutant**, so `killed ≥ 1` demands a
perfect score there against a TypeScript median of about eight. ADR-0018: the survival rule is unchanged,
but a Swift rate and a TypeScript rate are not the same measurement and the two fixtures' rates are never
averaged. The go/no-go's decision rule is now explicitly per fixture.

Five Swift plans, all valid: **10 functions, 18 tasks** against TypeScript's 14 and 20. `Strings`,
`Numbers` and `Arrays` plan XCTest; `Machine` and `Async` plan Swift Testing, so ADR-0005's
kill-attribution wrapper is exercised end to end rather than only in a slow test. `stateful_sequence` is
exercised at last — on `Machine.applyAll`, since the Swift module is plannable where the TypeScript one
was not.

One fixture asymmetry was found and removed in the process: `Strings.swift` spelled out the planted
off-by-one in `truncate`'s own doc comment, and `line_range` starts at the doc comment, so that sentence
would have reached the Swift worker in `WorkerTask.function.source` while the TypeScript worker got
nothing. It now lives in the Swift fixture's README, where the TypeScript one has always kept it.

Still not done: `property_like` is in the taxonomy and exercised by nothing, because neither fixture has
a function with an invariant that is not also a tautology.

## 6 — Go/no-go
Run `experiments/go-no-go/README.md` as written. Output: results JSON + one-page REPORT.md with the decision.

**Done** (2026-09-14). Four configurations × two fixtures, the protocol unedited, all nine Phase 5
plans re-validated before the first token. `experiments/go-no-go/results/go-no-go-2026-09-14.json`
(`"measured": true`), `results/REPORT.md`, a partial per cell, every candidate kept on disk.

| | TypeScript (20 tasks) | Swift (18 tasks) |
|---|---|---|
| C1 Apple Foundation Models | **3/20** · 0.15 | **0/18** · 0.00 |
| C2 qwen2.5-coder-7b-4bit | **17/20** · 0.85 | **4/18** · 0.22 |
| C2b qwen2.5-coder-14b-4bit | **17/20** · 0.85 | **2/18** · 0.11 |
| C3 Claude Haiku | **20/20** · 1.00 | **14/18** · 0.78 |

Worker tokens 0 for C1/C2/C2b, enforced by the schema. Median end to end per candidate: C2 14.6 s /
38.8 s against C3 27.5 s / 67.0 s, so `L(C2) ≤ L(C3)` holds on both fixtures and decides nothing —
accuracy is the whole question.

**Swift is a NO-GO (revisit)**: 0.29 of Haiku, below the 0.75 floor, and the 14B does not fix it — it is
worse. Thirteen of eighteen C2 candidates never compiled, and the 14B managed fourteen. **TypeScript is not a go, and it is a hole in the rule**
(ADR-0020): 0.85 puts it in the 75–89 % band whose escape hatch is a 14B clearing 0.90, and the 14B
scored the identical 0.85 on the identical three tasks. Recorded as a gap rather than rounded.

**Which result should make us pick the bigger model over speed? None.** The 14B matched the 7B on
TypeScript, lost on Swift, and cost 2.2× the generation time and 8.2 GB against 4.5 GB. The README's
preference for 7B × N now has a measurement behind it rather than a throughput argument.

**Three things the run turned up that the funnel does not show.** *(a)* The Swift collapse is a
capability difference, not a missing instruction: given the same prompt, whose exemplar calls
`Numbers.clamp(...)`, Haiku writes `Numbers.percentChange(...)` and the 7B writes
`SwiftFixture.percentChange(...)` — the module name from the import hint. Genuine Swift errors remain
behind it, so no one sentence rescues the fixture. *(b)* C3's 20/20 includes `truncate:boundary`, which
it survived by never asserting `text.length === maxLength` — the one input class the planted off-by-one
gets wrong — while C2 failed it by asserting the correct answer; C2's survivors score a median 1.00
against C3's 0.917. ADR-0006's warning as a difference *between* configurations. *(c)* ADR-0019: the
recommended Apple shim streams no content at all, so the first C1 attempt was 0/20 with every candidate
empty and `--determinism` passed 3/3 on empty strings — Phase 4's `<|im_end|>` lesson again. Its
non-streaming path reports `{prompt_tokens: 0, completion_tokens: 0}` for a real answer, a fiction that
`generate`'s usage guard would accept.

Apple FM is finished as a candidate: it copies the exemplar, overflows its 4K context on our smallest
prompts (four HTTP 500s), and is **not deterministic** — three runs of one task at temperature 0 with
`seed: 42` gave three different files. The 14B, checked identically, was 3/3 byte-identical.

Not done during the run, deliberately: no prompt was tuned and no verifier touched, which the protocol
forbids mid-run. **Both were done immediately afterwards, measured** — ADR-0021 renders the owning type
in the worker prompt (Swift 4 → 9 of 18 through the full pipeline, compiles 5 → 14, **still a NO-GO** at
0.64 of Haiku; TypeScript unchanged by construction), and ADR-0020 names the fourth decision cell
**CONDITIONAL GO** with a mutation-score guard, as a dated amendment below the frozen rule. The frozen
record is untouched: `--tag` keeps the re-measurement beside it and `--report` reads only the eight
cells the protocol defines. **No peak-RAM claim is made from this run**: under 6.6–9.5 GB of swap `ps` RSS
reported 205 MB for the 7B and 718 MB for the 14B, which is ADR-0011 from the other side; every partial
records `machine_before` / `machine_after` instead.

**Before the protocol starts, one thing Phase 5 leaves owing: the Swift fixture has no plan**, and this
phase lists one per fixture as an input. Three steps, in this order, because the third depends on the
first: probe which of its 21 functions have mutants at all (ADR-0016 — Muter's four operators make this
more likely to bite than TypeScript's type checker did, and `Machine.swift` mirrors the TS module that
turned out unplannable); name a `test_target`, since the package has two on purpose (ADR-0014) and
`sidecrew plan` now refuses an ambiguous one before the first token rather than after the first
candidate; then plan and validate. The result decides the denominator every survival rate in this phase
is over, so it is worth recording as a number rather than discovering as a gap.

`sidecrew bench` no longer overwrites a results file: an existing one is an error naming `--tag`, so a
forgotten flag costs a rerun rather than a measurement this phase then compares against itself.

## 7 — Hardening
Retry template, escalation queue + `/sidecrew escalate`, survivor review batching by mutation score + audit sample, memory guard, thermal back-off, revision pinning check, `--dry-run`.

**Done** (2026-09-14). All eight items, six ADRs (0022–0027), two new contracts in the spec, two new MCP
tools — seven in all — and 401 fast tests. Nothing here was measured on a machine under load, because
nothing here *produces* a number: this phase is about what the pipeline does when the machine, the worker
or a task misbehaves, and every one of those is a thing that had not happened yet.

**The two items that turned out to be about something other than what they said.**

*(a)* "Make the retry prompt a separate template" reads like tidying. It is not: `worker.md`'s rendered
bytes are pinned to the ablation variants that measured them (ADR-0017, ADR-0021), so the retry wording —
which **neither ablation measures**, both being first-attempt only on purpose — lived inside the one file
nobody may edit without rerunning a measurement that would not cover the edit. Splitting it unblocks a
measurement that has not been taken. The composed first-attempt prompt is asserted byte-identical to the
pre-split variant, so nothing that was measured moved.

*(b)* "Exactly one local retry" was already true, and looking at it turned up a case where the one retry
is **guaranteed** to be wasted (ADR-0022). Generation is deterministic at temperature 0 with a fixed seed;
if the retry prompt comes out byte-identical to the first attempt's — which happens when the verifier had
nothing quotable to say — the second candidate *is* the first one and the second verdict *is* the first
one. Phase 4's BACKLOG had written it down and nothing had acted. It costs 7 s of Stryker on TypeScript
and 28 s on Swift, and it is now a comparison of two strings.

**The review threshold could not be one number, and finding that out is what the phase bought.** The
prompt says "below `review_threshold` (default 0.6)". On Swift that selects **nothing at all**: nine of the
fifteen survivable fixture functions have exactly one mutant (ADR-0018), so a Swift survivor scores 1.00
by construction and the measured median is 1.00. `references/verifier.md` has said "do not use one
threshold for both" since Phase 3 and nothing enforced it. ADR-0024 makes it per language — 0.6
TypeScript, **1.0 Swift**, which reads "it left a mutant alive out of the one or two it had" — and makes
the audit sample a hash of `run_id:task_id` rather than `Math.random`, because `sidecrew review` is
re-runnable and a fresh draw per call makes "I reviewed that run" an unrepeatable claim.

**The memory guard needed a second opinion, and the phase prompt did not ask for it.** "Free memory ≥
model RAM + 2 GB" is what `serve` has always done. It is necessary and not sufficient: under pressure
macOS compresses and evicts, so `vm_stat`'s reclaimable count **rises while the machine gets worse** —
ADR-0011 from the direction Phase 6 hit it, where `ps` reported 205 MB for a 7B whose weights are 4.0 GB.
So ADR-0026 adds `kern.memorystatus_vm_pressure_level`, refuses at warn or critical however free the
machine claims to be, and treats `unknown` as neither a pass nor a refusal. "Otherwise queue" is
`--wait SECONDS`, which polls the same gate and never lowers it.

**The thermal back-off is the one piece shipped untested against the thing it exists for**, and it was
measured after the phase closed rather than left that way. The rule is research §E's, literally: median
decode rate more than 30 % below the bench baseline for two minutes retires one worker slot.

*Measured* (`npm run measure:thermal`, 22 min, `experiments/thermal/results/thermal-2026-09-14.json`):
this M2 Pro **on mains** with Xcode and a simulator open held a median of **40.5 tok/s** across 129
requests — the baseline to the decimal — so **research §E's sag did not reproduce**. One 90-second dip to
as low as 25.8 tok/s arrived at minute four and left, and **four of its seven requests were below the
28.3 tok/s floor on their own**; the guard declined because the two-minute *median* only reached 30.5,
75 % against a 70 % floor. A rule reading single samples would have retired a slot for the rest of the run
on ninety seconds that went away. No back-off was produced, so the wiring downstream of one — the runner
standing down — is still untested and cannot be tested on CI, where `readMemory` is null and concurrency
is therefore 1. Original note: it had never fired on a real run — the machine did not sag during a
twenty-task run — so what is tested is the window logic and the three false positives it declines to have (one slow
candidate, a guard that has not been watching for two minutes, and a second step arriving on the next
sample). The first implementation of that second condition **could not fire at all** — it asked whether
the retained window spanned two minutes, which the window filter makes impossible except by luck of
sample spacing, and it passed a suite that fed samples on a grid landing exactly on the boundary. Found
by reading it back, fixed, and pinned with realistic spacing (ADR-0025).
The baseline is `sidecrew bench`'s own `decode_tok_s` for that model, skipping any row `bench` flagged
untrustworthy (ADR-0011), and **no bench means no guard** rather than a baseline invented from the run's
first candidates — which would calibrate on the ~4 s of graph compilation Phase 1 measured and the bench's
warm-up request exists to exclude.

**Pinning became a refusal** (ADR-0027). `resolveForServe` has always computed the right answer; `serve`
printed it as a warning above several minutes of model loading, where nobody reads it. What the warning
says is that every number the worker produces is incomparable with every number the last one produced,
which is non-negotiable #4 and not a warning-shaped fact. `--allow-unpinned` exists because the first run
on a new machine has an empty cache by definition, and `test/serve.test.ts`'s lifecycle cases pass it —
every CI runner has an empty cache, and making the pin a precondition of those nine tests would test it
nine times and the lifecycle zero.

**Two things were fixed that the prompt did not list, both because this phase's own work made them
unavoidable.** A task that throws is now escalated rather than failing the whole batch — Phase 4's note,
assigned there to Phase 7, and only honest because ADR-0023's queue is on disk as the run goes. And
`test/skill-docs.test.ts` finally greps `claude/skills/` for the things it is supposed to agree with:
Phases 3, 4 and 5 each found a stale line in `references/verifier.md` **by reading**, one of which told an
orchestrator not to retry a tautology when the code always has.

`plugin.json` did not exist. The prompt says to bump its version, so it was created —
`claude/.claude-plugin/plugin.json`, the manifest that makes `claude/` an installable plugin — and CI now
checks it against `package.json` and `server.json`. All three at 0.0.2, plus a test pinning
`SERVER_VERSION`, which is the copy a compiler cannot see.

Not done, deliberately: the `api` tier of ADR-0009 is still documented and inert, so a 16 GB machine still
cannot run a batch — Phase 4 assigned the client to Phase 7 in BACKLOG, and it is a worker implementation
rather than hardening, so it stays in BACKLOG rather than arriving as a ninth item. No retry-prompt
ablation was run: the split is what makes one possible, and running one is an experiment with its own
protocol. `PoolRss` still cannot say "the machine was swapping, do not trust this" (Phase 6's note).

## 10 — Workload #2a: behaviour-preserving changes
**DoD:** `sidecrew fix` takes a plan of behaviour-preserving tasks and produces verdicts; a fixture with
planted errors of ≥ 3 kinds and a control for each cheap way to pass, each of which fails the gate with a
test asserting it; the gate proves the suite ran and the diff was confined; a slow test that does the
whole loop for real; ADRs for the sandbox change and the contract change; **no survival rate claimed.**

**Done** (2026-09-16). `sidecrew fix <change_plan.json>`, six new contracts in `schemas.ts` and
`pipeline.md` (`ChangePlan`, `ChangeBaseline`, `ChangeTask`, `ChangeCandidate`, `ChangeVerdict`,
`FixResult`), `src/change.ts` (the gate), `src/confinement.ts` (the seven rules), `src/diff.ts`,
`src/prompts/fixer.md`, `fixtures/fix-fixture` with its plan and seven controls, and three ADRs:
**0046** the sandbox keeps the tests, **0047** the contract, **0048** the gate.

**The contract is ADR-0044 §1–2, built.** A task is a group of files; a plan has ordered `steps` and the
run re-captures the baseline between them; `attempt ∈ {0,1,2}` and `ChangeTask.correction` exist with
nothing filling them, so Phase 12 is a fill rather than a migration. **There is no `workers` field and
that is now a refusal** — `ChangePlan` is a `strict` zod object, so a plan carrying one does not parse.
ADR-0044 §3 was a sentence in a document; it is a test.

**The gate is an iff in `schemas.ts`, and a stronger one than workload #1's.** `survived` must equal
`confined ∧ compile_ok ∧ tests_ok`; `tests_ok` cannot be true without a report, without at least as many
tests running as the baseline ran, without `ran_after > 0`, or with anything in `regressed`. *A suite
that collected zero tests was never going to be allowed to read as a green suite.*

**What the controls bought, measured on the fixture.** Four of the seven — `suppression_added`,
`any_escape_added`, `build_config_edited`, `no_edit_at_all` — leave a project that **`tsc` is completely
happy with**, and the slow test asserts that rather than asserting it. Nothing but the confinement
checker stands between those four and a survivor, which is the argument for having enumerated the cheap
passes by name instead of trusting "compiles ∧ tests pass".

**The thing that did not work is the thing worth remembering — and it is now five for five.** The first
real run of the gate produced *zero `tsc` errors* on a project with three planted ones. The project path
was relative, `binary()` built `<projectDir>/node_modules/.bin/tsc`, the command ran with `cwd` inside
the sandbox, the spawn failed with ENOENT, `run` returned an empty stdout because it never throws — and
`parseTscErrors` read that as a clean compile. **`compile ok` on something the compiler never opened, in
the gate written to be paranoid about exactly that (ADR-0037).** `--listFiles` is what makes it
detectable: every real invocation lists at least the TypeScript lib files, so `typecheck` now refuses an
empty program outright. Phase 4's `<|im_end|>`, Phase 6's empty shim, Phase 9's ts-jest instrumentation,
ADR-0037 itself, and now this: the first real run of anything finds one of these, every time.

**Not done, on purpose:**
- **no survival rate, and no local model has been pointed at this workload at all.** Phase 11 is the
  first time, against a rule frozen on the same day by somebody who had not seen a number. A number
  produced during construction is a number produced by somebody who wanted it to be good.
- **no planner.** Plans are hand-written here; the agent that writes them is Phase 12 (ADR-0044 §1–2).
- **no correction round.** One mechanical retry carrying the gate's own words (ADR-0022), then escalate.
- **no MCP tool, no skill wiring, no 2a escalation queue.** `sidecrew escalate` joins a queue back to
  `WorkerTask`s, which a `ChangeTask` is not, and nothing writes change plans for Claude to hand to a
  tool until Phase 12. Every verdict and diff is on disk as it is produced, so a run that dies still has
  the record (ADR-0023). `BACKLOG.md` has all three against Phase 12.
- **TypeScript only.** `loadChangePlan` refuses anything else where the reason lives.

**History.** This phase was first listed as "Workload #2 (proposed, not agreed)" and gated on two
preconditions: workload #1 completing on one real project, and ADR-0031's option being chosen. Both are
met — six trials, three measured rates on unmodified Nest and React projects (15–16 Sep 2026), and option
A by ADR-0043.

## 11 — Workload #2a go/no-go
Prompt: `prompts/phase-11-go-no-go-2a.md`, **written during Phase 10 and §4 frozen 16 Sep 2026, before
`sidecrew fix` had produced a single verdict.** Phase 6's bar again — a rule before the run, a fixture, a
control, a rate — per tier once Phase 13 exists, plus three things Phase 6's rule did not have: a **blind
approval rate** as a veto (a 2a survivor is edited source, and ADR-0020 had to be written after Phase 6
because a rate alone could not see quality); an **absolute floor** of 0.25, because a good ratio against
a weak control is not the same as a workload that pays for itself; and a clause making a run **about the
edit format rather than about the model** when a quarter of attempts fail to parse or truncate
(ADR-0047 §2). Do not edit §4 — amend below it, dated, the way ADR-0020 amended Phase 6's.

## 12 — Management: planner, correction round, stuck signal

**Status, 20 Sep 2026: both numbers exist, and both are negative results reported as complete ones.**
§2.2 is `S_c = 0/29` → **OFF BY DEFAULT** (§4.2), with `n₂ = 29` clearing §4.3's floor so it is a
verdict rather than an INCONCLUSIVE. The correction round ships switched off, the docs say why, and
the tail escalates as it does today — which is exactly what ADR-0044 §4 rule 2 specified in advance.

**The number that carries the most is not `S_c`.** 27 of the 29 corrected attempts landed at exactly
the same gate stage as the free mechanical retry; two moved, both sideways. And in the clean subset —
17 tasks whose briefs name the file and the rule, with nothing structural against them — **16 of 17
returned the file byte-identical *again*** after being told specifically that returning it unchanged
was the failure. That is a finding about the **worker**: on `null_guard` work a 7B mostly declines to
attempt the change, which reframes pass 1's `1/30` as a model that did not try rather than a gate
that was harsh. The measurement that could still change the verdict is a task set where the worker
*attempts* the change and gets it wrong — every `no_edit_at_all` is a task with no defect to correct.

**Status, 19 Sep 2026: §2.1 is measured and it FAILS.** `R = 2.84` at `N = 12` — 265,607 new Opus
tokens for a validated 12-task plan on project-a, **22,134 per task planned** against a paid worker's
7,794. §4.3's FAIL clause applies and is reported as written: *the design's economics do not work at
this plan size, and the phase reports that in as many words rather than looking for a plan size where
they do.* Result in `experiments/planner-cost/results/planner-cost-2026-09-19.json`. §2.2 is still
open.

**The "clean window" problem dissolved rather than being solved**, and that is the useful half.
§2.1's instrument was thought to need a session that did nothing but plan, because it summed a whole
transcript. It turned out it could not see the planner **at all**: the planners are subagents, and a
subagent's transcript is a separate file the script never opened. Inverted, that is the answer — **a
subagent transcript is a clean window by construction**, holding that agent's work and nothing else,
so no dedicated session is needed and the one that spawned it is irrelevant. Two further defects came
out of the same look: every assistant message was counted about twice (median **1.89×** inflation over
177 transcripts) and the slug dropped underscores. Every figure the script ever produced is void and
**not rescalable** — one defect omits a transcript, the other multiplies what is left.

**And §2.2 has no denominator yet, which is a finding rather than a delay.** *No task Phase 11 ever ran
reached a second attempt* — `retried = 0` in all six arms across 54 tasks — so the correction round
cannot be measured on renames and unused-import removals at any run length. It needs null guards, API
migrations and dead code, which is the same task set Phase 11b §4.4 demands. One set serves both;
neither phase's verdict may assume the other ran.


ADR-0044. The code-change planner (Opus decides groups and steps); the correction round (one Opus-written
note per task after the mechanical retry, fed by the verdict and never by raw worker output, against a
per-run budget, with a kill switch if corrected attempts do not survive often enough to pay for
themselves); and what a worker returns when it cannot do the task. Write the prompt when Phase 11 has a
number, because that number is what says whether the correction round has room to matter.

Two of the owner's edge ideas (BACKLOG § *The edge ideas*, 16 Sep 2026) live here because the planner
cannot be built without them: **local models read the codebase for Opus** — the planner's retrieval step
returns locations a machine confirms before Opus reads them, and the measurement is Opus planning tokens
per task with and without it — and **unattended mode** — a stepped run that survives a closed lid and
ends in a report, measured as Opus tokens spent between filing the plan and reading the report.

## 13 — ~~The `api` tier: Haiku on machines with 16 GB or less~~ — **descoped, 20 Sep 2026**

> **ADR-0073, the owner's call: sidecrew is a 24 GB+ tool.** §5 is cancelled, Phase 13 is off the
> publish path, and below the floor sidecrew refuses with a reason instead of falling back. The client
> remains behind `SIDECREW_TIER=api` — tested, unsupported, unpriced. `WorkerKind` keeps `"api"`
> because Phase 11's C3 control and Phase 11b's arm D record it, including the corpus the gate's own
> error rate was measured on.
>
> **The rest of this section is the phase as it was built and is kept unedited.** Its reasoning was
> good and its defect (ADR-0062) was real and is still fixed; what changed is the product's scope.

**Status, 18 Sep 2026: built, merged, unmeasured.** A `fetch` client with its own `assertApiTier` guard
(`assertLocalTier` untouched, and a test asserts the two are **disjoint** — one client with a flag would
be one edit from having neither), tier selection from installed RAM, `runBatch`/`runFix` dispatching on
tier, accounting from the API's own usage fields, and 49 tests. It **strengthened** the schema rather
than relaxing it: an `api` run that produced outcomes and reports `workers: 0` no longer serialises,
which is the other half of the local-tier guarantee.

Building it found **ADR-0062**, which is the more valuable output: a refusal on a single-file task was
swallowed by `parseEdits`' bare-answer fallback, so `stats.refusals` was structurally zero in *every
configuration this repository has numbers for*. That is a workload-#2a defect on the local tier, found
by a phase that was not looking at the local tier, in a test the agent declined to write off as a bad
fixture.

**§5 waits on API credits and nothing else.** The Console account has none; the cost is not the obstacle
(~$0.002 a task, under $0.25 for the whole shape, ~$0.015 for the fixture arm alone). A subagent
substitute was considered and **refused** — see §5's dated amendment: it cannot satisfy §5.0.2, it never
executes `api-worker.ts`, and it would largely re-derive Phase 11's C3 numbers. When credits exist, the
fixture arm is the place to start, because it is our own code and sends nobody else's source anywhere.

Prompt: `prompts/phase-13-api-tier.md`, written 18 Sep 2026 with **§5 frozen before any `api`-tier
candidate existed**, the same discipline Phases 6, 11 and 11b used.

**It is handed over with three decisions deliberately left open**, because each is an ADR rather than an
implementation detail and taking the first option would have been a decision made by whoever wrote the
prompt: how the client talks to the API — which **collides with CLAUDE.md's "only runtime dependency"
rule** and so cannot be settled quietly; the pinned Haiku model id (ADR-0045 §2); and what the tier's
number is comparable to, which ADR-0045 §7 answered before `fixer.md` changed and before Phase 11b
decided not to pin the old template.

**The rule is not "is Haiku better than the 7B".** It is "is this good enough to ship to a user who has
no alternative", because on a 16 GB machine the alternative is that sidecrew does not run. §5.2 is
written on that asymmetry, with precision as the veto and a dollars-per-surviving-task figure the local
tier has no equivalent of.


ADR-0009 decided it; ADR-0045 makes it a phase because the publication bar is "people can use it on their
code base" and a 16 GB laptop where `sidecrew run` refuses to start is not that. The client, the tier's
concurrency rule (rate limits, not RAM), pinned model id in `models.json`, accounting from the API's own
usage fields, and the tier's own run through Phase 11's protocol.

## 13b — The four edge ideas that gate publication
**Owner's decision, 18 Sep 2026: three of these land before publish.** They are `BACKLOG.md` § *The edge
ideas* items 4, 3 and 1, and the owner's measure for all of them is unchanged — *fewer Opus tokens,
faster, more precise, when users use Opus on its own.*

**Item 6, two-model agreement, was considered and dropped the same day** — the owner's call, on the
grounds below: its own entry makes it conditional on evidence that the two models disagree, and that
evidence does not exist because Phase 11 never ran the 14B. Building a consumer for a signal nobody has
observed is the shape this project refuses everywhere else.

**Three of them were Phase 12's and were not built.** Items 1, 3 and 4 name Phase 12 as their owner in
the backlog; Phase 12 built the four deliverables in its prompt and never reconciled them against that.
Recorded as a miss rather than as a scope change, because the reason matters: a phase prompt and a
backlog entry disagreed and nothing checked.

Ranked by value per session, which is **not** the order they are listed in:

**4 — unattended mode. ✅ Built, 18 Sep 2026.** `--resume <run_id>`, `--report`, and `--sweep`. Building it found a
Phase 12 bug nothing else would have: a real run never wrote attempt 0's task, so `fix-escalate` — which
joins its queue to those files and drops what it cannot join — silently returned a short batch for every
first-attempt escalation. `FixResult.escalations` is built in memory, so headline numbers were never
wrong, which is exactly why it was invisible. **One limit, learned the same day:** resume reuses any
*terminal* verdict, and a gate starved of memory fails closed with a false negative that is perfectly
terminal — so a run discarded for environmental reasons must be restarted, never resumed.

**`--sweep` was not in the backlog entry and belongs to this item anyway.** A run removes its own
sandbox in a `finally`, so orphans come only from runs that were *killed* — which is precisely what
unattended mode makes ordinary. Phase 11b lost about **4.5 GB to nine orphans** in one afternoon of
restarts, on a machine that was already thrashing; a full disk is one of the ways a gate starts failing
for reasons that have nothing to do with the change. It is explicit, never automatic, and never touches
anything younger than 12 h — two runs share a machine routinely and a live step sandbox is written only
at step boundaries, so recency cannot tell "in use" from "idle".

*Original assessment, kept:* **the best of the four and the most nearly done.** *"Opus files a stepped plan,
walks away, and reads a step report."* Ordered steps exist (ADR-0044 §2), and every run already writes
one file per task as it goes (ADR-0023), so what is missing is a **resume** from `.sidecrew/runs/<id>/`
and a report that says what to read first. It is also the only one of the four whose measure is
unambiguous — *Opus tokens spent between filing the plan and reading the report, target zero* — and it
is the product shape the vision describes rather than an optimisation of it.

**3 — memoise task → candidate. ✅ Built, 18 Sep 2026, behind ADR-0065.** `sidecrew fix --cache`, off by
default and local-tier only. `FixResult.stats.cache` records whether it was on, and the schema refuses a
run reporting hits it never enabled — because **a cached run's `generate_ms` is not a measurement** and
an `experiments/` figure has to come from a run that asked no worker to repeat itself. Two things were settled
before any code: the key is the **rendered prompt** and not the task, because the prompt *template* is an
input and it changed today (`6c161de`) — a task-keyed cache would have served candidates from the old
template indefinitely with the task bytes identical; and **verdicts are never cached**, which Phase 11b
measured rather than argued, with a byte-identical candidate producing `tests_ok: false` with 155 named
regressions under swap and `survived` on a rerun. A verdict cache would make a transient environmental
failure permanent, in the direction that makes the tool look stricter than it is.

*Original assessment, kept:* **cheapest to build, smallest measured win.** Determinism is already
guaranteed on the local tier (ADR-0003), so the cache is sound by construction. But **the backlog's
claim that a re-run "costs nothing" is false against Phase 11's numbers**: generation is 13.5 s of a
~275 s candidate and the gate is 95 % of the cost, so memoising generation saves about **5 %**. The
valuable version caches *verdicts*, and that is the dangerous one — a verdict depends on the candidate
**and** the baseline **and** the state of the whole project, so a key that misses one serves a stale
pass, which is precisely ADR-0037's failure mode. **An ADR on what goes in the key comes first.**
Local tier only; the api tier has no seed (ADR-0045 §5), and that branch is now real code.

**1 — local models read the codebase. §2.1 did not kill it; it confirmed the premise and then gave
it a target.** The curve says planning is a large **fixed** cost (`F ≈ 233,500`, 68 % of the total
even at `N = 41`) plus a small per-task one, and the fixed part is overwhelmingly Opus reading —
15.5M cache reads against 89k of output. Item 1 attacks `F`, the one term that does not amortise by
itself. The item
rested on planning being expensive and mostly Opus reading code. Measured 19 Sep 2026: **22,134 Opus
tokens per task planned** at `N = 12`, with **6.3M cache reads against 65k of output** — a planner
that reads far more than it writes, which is the shape the item is aimed at. §2.1 was its go/no-go
rather than its baseline and the answer is go. Phase 5's contaminated 120–145k is superseded.
It also needs an ADR first, because **its gate is weaker in kind than the other two**: confirming a
symbol exists at a location proves existence, not *relevance*. A local model can return ten real,
confirmed, irrelevant locations and Opus reads ten files it did not need — the gate passes and the
saving does not happen. That is a different Goodhart shape from #1 and #2a, where a cheap pass produces
a bad artefact the gate catches; here it produces a valid artefact that fails to help.

**6 — two-model agreement: dropped, 18 Sep 2026.** Kept here with its reasoning because a dropped idea
with a reason is worth more than a silent removal. The backlog makes it conditional in as many words —
*"only worth it if Phase 11 shows the two models disagree on real projects"* — and **Phase 11 never ran
C2b**, because §4.3 only called for the 14B if C2 landed in the 0.75–0.90 band and it did not. At
`S(C2) = 12/12` and `11/12` there is barely room for disagreement to appear, and running both models
doubles wall clock on a machine that hosts *either* two 7Bs or one 14B, not both (CLAUDE.md #5). If it
returns, it returns behind a measurement that the two models actually disagree.

### What this costs, stated plainly
Two to three sessions of build, plus measurement, **on top of** §2.1, §2.2, Phase 11b, Phase 13's §5
and the priority-4 scrub — all of which are already between here and publish. This is the owner's call
and it is recorded as one; the estimate is here so it is a decision rather than a discovery.

### Order that wastes least
~~**Item 4 first**~~ ✅ · ~~**Item 3** behind its key ADR~~ ✅ · **Item 1 remains**, and only if §2.1 says
there is anything to save — §2.1 needs a fresh session and is owed anyway.

## 14 — Publish

**Status, 20 Sep 2026: the code and the release machinery are done; the release itself waits on the
owner.** Everything the DoD asks for is on `main` — the three hardening items, `v0.1.0` in all four
places, `release.yml`, the `docs/` site, and every published rate restated as an interval with `D`
beside it. **Three things are deliberately not done here and all three are the owner's:** tagging
`v0.1.0` and pushing the tag, configuring npm **Trusted Publishing** on npmjs.com (no repository secret — npm is ending token publishing), and turning GitHub Pages on
(Settings → Pages → `main` / `docs`). **`release.yml` has never run**, because nothing has been
tagged; its npm and registry jobs are unverified against the live services and the gate job's steps
are each verified locally instead. The exit check below starts its two-week window at the tag, not at
this commit.

What landed, with what it was worth:

| | |
|---|---|
| `deriveLineRange` on the AST (ADR-0076) | the scanner missed **152 of 436** declarations in our own `src` and got **5** wrong, all by cutting a body short |
| `doctor`'s pre-flight rows | five, including the fourth found this week — `jest ok` on a suite collecting zero tests |
| ADR-0042 | option 1 implemented; no verdict, survival or score changes |
| every rate → interval + `D` | the frozen rule's UNACCEPTABLE clause, satisfied rather than amended |
| `npm pack` | 87 files, 317.8 kB, allowlist clean, `doctor` verified out of the installed tarball |

`npm publish` dry-run, `server.json` validated against the registry schema, release workflow green on a
`v0.1.0` tag, docs site (`docs/` → GitHub Pages like simframe), README numbers replaced with measured ones
— from Phases 11/11b/12 on the supported tier, not from Phase 6.

**Two things changed under this DoD on 19–20 Sep 2026 and a reader should meet them before planning
the release:**

- **"Both tiers" is gone** (ADR-0073). One supported configuration: 24 GB+, local worker.
- **"README numbers replaced with measured ones" now collides with the gate's own error rate.**
  `D = 2/19 = 0.105` triggered `experiments/gate-error-rate/README.md` §4.3's UNACCEPTABLE clause,
  which says **no survival rate may be published as a point estimate until the cause is diagnosed**.
  That is not a reason to delay publication and it is a reason the README cannot say what this line
  originally imagined. Three ways out, and it is the owner's call: diagnose O8 first; publish the
  rates **as intervals with `D` beside them**; or amend §4.3 in the open. Doing none of them and
  printing a bare `15/19` is the one option the frozen rule forecloses. The DoD includes the four "people can use it" lines from
`VISION.md`, **and the workload #1 hardening items from the prioritised list** (`deriveLineRange` on the
AST, `doctor`'s three pre-flight questions, rendering what a body's meaning depends on, ADR-0042), because
each is a way a stranger's project fails today. The README and the Claude skill are rewritten to lead
with the worked example, not with unit tests.

### Exit check — frozen 20 Sep 2026, before publication

Publication is the first time this tool meets a project nobody here chose, so the exit check is about
**strangers' projects**, not about the release mechanics.

Let `F` be the number of distinct *first-run* failures reported or reproduced on projects outside
`project-a`/`project-b` within the first two weeks, where a first-run failure is one that stops a user
before a single candidate is generated — `doctor` clean, plan refused, baseline uncapturable.

- **`F ≤ 2` → PROCEED to 14b.** The pre-flight questions cover what they need to.
- **`F ≥ 3` → INSERT `14a′` — "what a stranger's project does that ours does not."** Named now: each
  failure becomes a `doctor` row in ADR-0032's shape — the cause, whose fault it is, and the exact fix
  — and a fixture reproducing it. Six trials produced this list once already; a seventh source of
  them outranks new capability, because a tool that does not start is not measured by any of the four
  scorecard numbers.
- **Any failure that produces a *wrong verdict* rather than a refusal → STOP and fix immediately**,
  whatever `F` is. A tool that refuses loudly is usable; one that quietly scores a bad candidate as a
  survivor is ADR-0037 again, and that is the failure this whole architecture is paranoid about.

**Two weeks is the window and it is deliberate**: long enough for someone other than us to try it,
short enough that 14b is not blocked indefinitely waiting for users who may not arrive.

## The road to the 90 % bar — 14 → 14b → 14c → 14d, decided 20 Sep 2026

**The owner's goal, in their words:** *"be able to achieve what Opus does, our way — even 90 % is a
win."* Phases 14b–14d are that road. They are numbered with letters for the same reason 11b and 13b
were: numbers are the order, and these sit between publish and everything already numbered after it.

### The framework these phases are building toward — read this before planning any of them

**Stated by the owner, 20 Sep 2026, and it is the thing a new session must not drift from:**

> Opus receives the task and **plans a session to gather the info needed**. Opus receives the info from
> the workers. **Opus asks the user if needed**, and plans based on what the user decides and what the
> workers found. Opus asks the workers to act on that. **The loop continues until what was asked is
> satisfied.**

This is `VISION.md`'s philosophy section — *"the local model can scan the code, go through several
files looking for something, report back to Opus; Opus says okay, let's do this"* — and **the phases
below are the order in which its parts become true**, not a list of features:

| the loop's step | what it needs | phase |
|---|---|---|
| Opus plans a gathering session, workers read and report | retrieval on the contract, and a gate for it | **14d** (ADR-0079) |
| Opus asks the **user**, and plans on the answer | the negotiation surface — *"your config reports 0, this flag reports 763"* | **14d**, and ADR-0079 option A can ship before the rest |
| workers act on any part of the codebase | symbol-scoped return, so file size stops deciding | **14c** (ADR-0075, accepted) |
| a machine decides what Opus sees | built, both workloads | done (ADR-0046, ADR-0048) |
| the loop terminates when *satisfied* | a machine-checkable definition of satisfied | per workload — see below |
| the loop works where the **project's own tests do not** | an oracle sidecrew manufactures rather than borrows | **ADR-0082** (proposed) — not a phase yet; option D is one short run |

**Two constraints that come from measurements and bind every phase here.**

1. **Each cycle must be cheap for Opus.** Planning is **233,500 fixed tokens, 68 % of the total even
   at 41 tasks**, overwhelmingly Opus *reading*. A loop that re-plans `n` times risks paying that `n`
   times, which inverts the product. Batched, one round trip per phase over a summary, **never per
   task**. *A chatty loop is a more expensive Opus session with extra steps*, and `R` would say so.
2. **"Until satisfied" needs a machine-checkable definition, or the loop cannot terminate honestly.**
   It exists for every workload that belongs here and for none that does not: type errors → *zero
   under the agreed flag*; lint → *clean exit*; tests → *a mutation threshold*; a bug → *the
   reproducing test passes*. **A feature has no termination condition for the same reason it has no
   gate** (CLAUDE.md), which is why Phase 15 is post-1.0 and narrow.

   **ADR-0082 (proposed, 21 Sep 2026) proposes one for a feature, and it is worth reading before
   anyone treats that sentence as final**: a test written to the *expected* behaviour **is** a
   termination condition, and it is machine-checkable. What it does not settle is whether the test
   says what the user meant — which stays human, but lands on a ten-line artefact instead of a diff.

### Every phase ends with an exit check, and the fork is named before the phase runs

**The owner's process decision, 20 Sep 2026.** A phase does not simply finish. It ends by
re-measuring the scorecard below and applying a rule that was **written before the phase started**,
which produces exactly one of:

- **PROCEED** — the next phase as planned;
- **INSERT `Nx`** — a named phase, described in advance, that this result makes necessary;
- **STOP** — the phase's premise did not hold, and the plan after it is wrong rather than late.

**The rule is frozen before the number exists**, for the reason every `§4` in `experiments/` is: a
fork chosen after seeing the result is a description of how somebody felt about the result. Naming
the inserted phase in advance is the other half — *"insert something here"* is not a plan, and under
pressure it becomes whatever is easiest.

### The scorecard — four numbers, re-measured at every phase exit

This is what *"90 %"* means operationally. Without it the bar is a feeling.

| | what it measures | today (20 Sep 2026) | at the 90 % bar |
|---|---|---|---|
| **Reach** | share of a real codebase **by bytes** that a task may touch | **51.9 %** | ≥ 90 % |
| **Shapes** | behaviour-preserving shapes surviving at a usable rate | **1 of 5** (`rename`, `unused_import`; `null_guard` **2/30** measured by 14b, and ADR-0077 found the limit is the **gate's scope**, not the model; `api_migration` and `dead_code` unmeasured) | ≥ 4 of 5 |
| **Cost** | `R` — Opus tokens to plan ÷ what a paid model would cost per task | **2.84** at `N = 12`, **1.07** at `N = 41` | ≤ 1.0 at `N = 12` |
| **Trust** | `D` — how often the gate disagrees with itself | **2/19 ≈ 0.105** | ≤ 0.02, or diagnosed |

Three of the four are already measured, so re-measuring is cheap — Reach is one script, Cost is two
planner passes, Trust is a replay. **Shapes is the expensive one and 14b is the phase that buys it.**

**The honest reading of the table**: the bar is not one number away. It is four, and only one of them
(Cost) improves on its own as plans get bigger.

### What "90 % of what Opus does" decomposes into, and where each part stands

| what Opus can do to a codebase | sidecrew today | fixed by |
|---|---|---|
| edit a file **of any size** | **~52 % of a codebase by bytes**; every 1000+ line file is refused | **14c** |
| do **any shape** of behaviour-preserving change | renames and dead imports well; null guards **2/30** | **14b** measured it — the ceiling is the **gate's scope**, not the model (ADR-0077). A/B/C wait on D's counterfactual; **more worker capability buys nothing here** |
| **read** the codebase to decide what to do | Opus does it, and it is **68 % of planning cost** | **14d**, and **ADR-0079** is the shape it takes |
| behaviour-**changing** work | not attempted, deliberately | **15**, and it is post-1.0 |

The first three are the 90 %. The fourth is the rest, and ADR-0031 says why it is last.

---

## 14b — The editing ceiling: is it the model, or the task?

**One evening. Needs the machine. No build. Cuts no version.**

The 7B returns files **unchanged** on `null_guard` work — 1/30, and 16 of 17 did it again after a note
saying that returning it unchanged *was* the failure (§2.2). Whether that is a capability ceiling or a
fixable gap decides whether the second row of the table above is reachable at all, and it is worth one
evening of measurement rather than a campaign of tuning.

Two probes, on the **same 30 declared tasks** so they are comparable with §2.2:

1. **The 14B on the same set.** Settles model size in one run. The machine hosts one 14B *or* two 7Bs
   (CLAUDE.md #5), so it is a clean swap, and Phase 6 measured the 14B matching the 7B on TypeScript
   at 2.2× the generation time — this asks whether that holds on a shape the 7B cannot do at all.
2. **One task decomposed to a single function** rather than a whole file. Settles whether the failure
   is task *size* rather than task *kind*.

**A third probe is already answered and is recorded here so nobody runs it:** *"is it the whole-file
format?"* — **no.** Every one of those 30 files was **under** the rewrite ceiling, the largest at
18.9 KB, with 0 truncated and 0 unparsed. The format caps what can be **reached** (14c); it is not why
the reachable ones failed.

**Freeze the rule first**, as every measurement here does: what result would mean *ceiling*, what
would mean *gap*, before either number exists.

### Exit check — frozen 20 Sep 2026, before either probe ran

Let `S₁₄` be `null_guard` survival on the 30 declared tasks, best of the two probes. Today's baseline
is **1/30 = 0.033**.

- **`S₁₄ ≥ 0.30` → INSERT `14b′` — "make the thing that worked the default."** A shape going from
  unusable to usable changes the product more than 14c does, and it would be wrong to ship 14c first
  on the grounds that it was already planned. `14b′` is: whichever of the two probes won (a 14B
  worker, or planner-side decomposition into single-function tasks) becomes the default, with the
  memory arithmetic re-done if it is the 14B — CLAUDE.md #5 is not negotiable, and one 14B means one
  worker rather than two.
- **`0.10 ≤ S₁₄ < 0.30` → PROCEED to 14c, and record the shape as *"improvable but not usable"*.**
  Worth returning to after the reach work, not worth reordering for.
- **`S₁₄ < 0.10` → PROCEED to 14c, and write the ceiling down as a product fact.** The Shapes row
  stops being a thing to fix by tuning, the 90 % bar rests on Reach + Cost + a narrower shape list,
  and `README` says which shapes sidecrew is for rather than implying all of them. **This is a
  complete result**, and the same sentence §2.2 earned: a negative result reported without looking
  for a cut of the data where it passes.

**In every branch, 14b cuts no version and adds no code.** It is one evening that decides how three
later phases are spent.

### Result — 20 Sep 2026. `S₁₄ = 2/30 = 0.067`, 95 % `[0.008, 0.221]`

**Third branch: PROCEED to 14c, and write the ceiling down as a product fact.** Both probes agree;
neither reaches 0.10. Full result in `experiments/editing-ceiling/`, rule copied and committed before
either probe ran.

| arm | declined | **target fixed correctly** | unsatisfiable | survived |
|---|---|---|---|---|
| pass 1 — 7B, whole-file | 17 | **8** | 12 | 1 |
| probe 2 — 7B, ask narrowed to one function | 10 | **14** | 18 | 1 |
| probe 1 — 14B, whole-file | 3 | **17** | 21 | **2** |

**The question had a third answer.** It is not the model and it is not the task size — both probes
moved the thing they targeted, and the 14B nearly eliminated the decline behaviour. It is the **gate's
scope**: +6 correct targets bought +6 unsatisfiable tasks on probe 2, +9 bought +9 on probe 1, one to
one. The sinking error is in a **test file in 21 of 21** of probe 1's unsatisfiable tasks and in
non-test source in **0** — a narrowed type propagates into fixtures, and tests may not be edited
because tests *are* the gate (ADR-0046).

**It worsens with capability** (12 → 18 → 21), because a file nobody edits breaks nothing downstream.
So `14b′` would have been the wrong insert even had the threshold been met, and the Shapes row now
reads *"the worker can do it, the gate cannot credit it"* — which **ADR-0077 (proposed)** asks the
owner to resolve, recommending the counterfactual run before choosing.

---

## 14c — The reach: symbol-scoped return · **cut `v0.2.0`**

**2–3 sessions. One overnight run. ADR-0075 is DECIDED — option C, accepted by the owner 20 Sep
2026 — so this phase is unblocked and can start.**

**Half of a real codebase is unaddressable and it is the half the work is in** — 3.3 % of files are
48.1 % of the bytes, and every 1000+ line file is refused. That is the *return format*, not the model
(ADR-0075).

Option C: the task names a declaration, the worker returns **that declaration's new text**, and
sidecrew splices it back by AST range. The model never writes a line number, so the hunk failure mode
ADR-0047 §2 rejected does not arise; confinement stays decidable before a byte is written.

**It needs `deriveLineRange` reading the TypeScript AST — which is Phase 14's own DoD item.** Doing
that for publication and building on it here is the cheapest ordering available, and it is why 14c
follows 14 rather than replacing part of it.

**Definition of done**
- ~~ADR-0075 decided~~ **done, 20 Sep**; the contract change lands with a spec update in the same
  commit (CLAUDE.md).
- Confinement is still decidable **before** anything is written, and a test asserts it.
- A control fixture per new failure mode, as the coverage test demands.
- **Measured, against a rule frozen first**: survival on tasks in files that were previously refused.
  That run is the overnight one — it is a full gated run on a real project.
- The addressable share of a real codebase is re-measured and published as a number.

**Why cut a version here.** It roughly doubles what the tool can touch, which is the first change
since publication that a user would feel without reading the changelog.

### Exit check — to be frozen **before** 14c starts, in this shape

Two numbers, and the second is the one people forget: reach is worthless if what it reaches cannot be
changed. Let `Reach` be the addressable share by bytes, and `S_big` survival on tasks in files that
were previously refused, against `S_small` on files that were always in reach.

- **`Reach ≥ 0.85` and `S_big ≥ 0.75 × S_small` → PROCEED to 14d.** The surface grew and the tool
  works on the new part.
- **`Reach ≥ 0.85` but `S_big < 0.75 × S_small` → INSERT `14c′` — "a big change is not a big file."**
  The symbol-scoped return moved the boundary from *the file is big* to *the change is big*, and the
  remaining failures are the second thing, which is a planner problem rather than a format one:
  splitting one ask across several declarations, and an ordering between them. Named now so it is not
  invented later.
- **`Reach < 0.85` → STOP and re-open ADR-0075.** Option C did not do what it claimed; option D (a
  larger-context local model, with the memory cost it implies) is the remaining candidate and it is a
  different phase, not a patch to this one.

`S_big` is measured on the **same** project and the same declared task set as `S_small`, or the two
are not comparable — the mistake §4.4 exists to prevent, one level up.

---

## 14d — Retrieval: the other half of the vision · **cut `v1.0.0`**

**3–4 sessions. One overnight run. Needs its own ADR first.**

> *"The local model can scan the code, go through several files looking for something, report back to
> Opus; Opus says okay, let's do this."* — the owner, `VISION.md`, 20 Sep 2026

This is the half of the philosophy that is not built, and the measurements point straight at it:
**68 % of planning cost is fixed and overwhelmingly Opus reading** — 15.5M cache reads against 89k of
output. It is the one term in the cost curve that does not amortise with plan size, so it is the only
thing that can move `R` below 1 at the plan sizes people actually start with.

**The ADR comes first, because this gate is weaker in kind than every other one here.** A machine can
confirm a symbol **exists**; it cannot confirm it is **relevant**. Ten confirmed, real, useless
locations pass the gate and save nothing — a Goodhart shape the rest of this design does not have,
where a cheap pass yields a *valid* artefact that fails to help. Decide what makes a retrieval answer
checkable before building anything.

**ADR-0079 is that ADR's starting point, and it carries a candidate answer.** The owner's *"Opus asks
the user if needed"* supplies a relevance oracle that is **neither a machine nor Opus** — the person
who asked. The division it proposes:

| question | who decides | cost |
|---|---|---|
| does this location **exist** | a machine — `tsc`, the AST, a grep | free |
| is it **relevant** | the **user**, on a batched summary | one question |
| is the change **correct** | the gate (ADR-0046, ADR-0048) | the suite |

This does not make retrieval gateable on its own. It makes the ungateable half *somebody's* rather
than nobody's, and whether that is sufficient is exactly what the ADR has to settle.

**Ship ADR-0079 option A first — it needs no oracle at all.** *Recon-as-report* answers *"your config
reports 0 errors, `--strictNullChecks` reports 763 files — do you want to see them?"*. The user asked
the question the report answers, so relevance is not in doubt and the Goodhart shape above does not
arise. It is the smallest useful piece of the framework, it is independently valuable (it answers
*"how many issues are there?"* completely), and it can land before the ADR that the rest waits on.

**What it must not do yet:** offer to *fix* what it counts. ADR-0077 measured `null_guard` under
`--strictNullChecks` at **2/30**, sunk by errors landing in test files in 21 of 21 cases. **A report
that quantifies work the gate cannot then deliver is worse than no report**, because it converts a
quiet limitation into a loud broken promise. Fixing follows ADR-0077's A/B/C, and its D
counterfactual is on the critical path.

**Definition of done**
- The ADR, with the relevance problem answered rather than noted.
- A retrieval task and result on the contract; the worker prompt; the machine confirmation step; the
  planner using it.
- **Measured against a rule frozen first**: planning tokens for the same job with and without
  retrieval, per `experiments/planner-cost/` §4's method and its 19 Sep amendment. Two planner passes
  plus the gated runs behind them — that is the overnight.
- `R` reported at both plan sizes again, so the curve is comparable with 20 Sep's.

**Why cut 1.0 here.** `VISION.md`'s bar for publication was *"when it does the vision"*; the owner
moved first release earlier, which was right. This is the phase where the worked example actually runs
end to end — **Opus decides, local models read *and* write, a mechanical gate judges, and the user
sees only what survived.** That is the product the vision describes, and it is a fair `1.0`.

### Exit check — to be frozen **before** 14d starts, in this shape

`R` at `N = 12`, the plan size a new user actually starts with, re-measured by
`experiments/planner-cost/` §4's method with retrieval on.

- **`R ≤ 1.0` → PROCEED: cut `v1.0.0`.** Coordination finally costs less than paying per task at the
  size people begin with, and the whole scorecard is defensible.
- **`1.0 < R ≤ 2.0` → INSERT `14d′` — "the second lever."** Retrieval helped and did not close it.
  `14d′` is the remaining fixed-cost reduction named in advance: cache the *reading* across runs of
  the same project, so the 233k-token survey is paid once per codebase rather than once per plan.
  ADR-0065's key discipline applies — a cache whose key misses an input serves a stale answer.
  **`1.0` waits**, because cutting it on a tool that costs more than it saves at the starting size is
  the one thing the whole measurement programme exists to stop.
- **`R > 2.0` → STOP.** Retrieval was the best idea available for the fixed term and it did not move
  it. The honest response is to say the coordination model does not pay at small plan sizes and to
  publish `v0.x` describing the sizes where it does — which the curve already shows is real.

**The quality veto applies to all three branches**, as it does in `experiments/correction-round/`
§4.3: if retrieval makes Opus read *fewer of the right files*, survival or blind approval will fall,
and a cheaper plan that produces worse changes is not a saving. Measure both, and let precision
override the token number.

---

## 15 — Workload #2b: behaviour-changing changes · **post-1.0** · proposed
ADR-0031 options B and C. Opus writes the specification; the Goodhart direction inverts; held-out tests
double the expensive half. Not before 2a has a number, and the argument for not doing it at all is in the
ADR.

**ADR-0082 (proposed, 21 Sep 2026) moves both of those objections and settles neither**, which is why
this row now points at two ADRs rather than one. **The worker** writes the specification-as-test, not
Opus, so the cost argument becomes an open question rather than a closed one — it is sidecrew's own
premise applied to the spec-writing step. And the tests are **held out by construction and for free**,
because writing the test and making the change are separate worker invocations and the change worker is
never shown the test; Goodhart needs the measure to be visible.

**What it does not remove is intent.** *Does the change do what was asked* becomes machine-checkable
against a test written first; *was that the right thing to ask for* does not, and the user approves a
ten-line expectation instead of auditing a diff. **Do not plan this phase before ADR-0082 option D is
measured** — the yield of region-targeted test generation is the number every version of it rests on,
and workload #1's untargeted yield on real projects is 3/8, 4/8 and 4/10.

## 16 — Python + Kotlin verifiers · **post-1.0** · each language is its own `v1.x` minor
After publish. mutmut / cosmic-ray and PIT; BACKLOG has the notes.

## 17 — The edge ideas · **post-1.0, and 14b decides whether the first of them is worth anything** (proposed)
The owner's measure for all of them: *fewer Opus tokens, faster, more precise, when users use Opus on its
own.* Fine-tune the 7B on its own survivors (needs Phase 11's baseline, and only post-ADR-0037 survivors
qualify); pool workers across a team's machines (needs an ADR on trust and cross-machine determinism);
two-model agreement as a review signal (only if Phase 11 shows the models disagree on real projects).
Each is in `BACKLOG.md` § *The edge ideas* with the measurement it needs. Memoising task → candidate by
content hash is on the same list and is small enough that Phase 10 or 12 may take it.
