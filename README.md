# sidecrew

**You ask for a change to your source code, and you get it — made on your Mac, by models that cost you
no Claude tokens, and only after a machine has checked it.**

Claude Opus plans the work and reviews what came back. Small models running **locally** (MLX, no
network) do the narrow parts. Between them sits a gate a machine can run — for a code change: the diff
stayed where it was asked to, `tsc` is clean, and every test that passed before still passes. **Claude
never sees anything that did not survive it.**

```console
$ sidecrew fix change_plan.json
fix 2026-09-20T09-14-02Z-rename: 1 step, 12 tasks, 13.0 GB free ÷ 6.5 GB per slot = 2; 1 worker up
step 1/1 "rename the helper": capturing the baseline
rename-01: survived (src/util/asset.util.ts)
rename-02: survived (src/util/asset.util.ts, src/util/asset.util.spec.ts)
…
multi-06: failed at compile · escalating — renamed the symbol 7 times over, 5 compile errors
11/12 survived · 0 → 0 tsc errors · .sidecrew/runs/2026-09-20T09-14-02Z-rename/result.json
```

*Illustrative shape, not a captured transcript* — it is the real output format with the counts from the
React measurement below, and no client's file names. **11 of 12 with a
95 % interval of `[0.615, 0.998]`** is the number; the line above is what it looks like while it runs.

**Unit tests are workload #1** — the same shape with a mutation-kill gate instead — and the numbers for
both are below, each with its interval.

**sidecrew needs 24 GB of installed RAM.** Below that a 7B cannot sit beside a normal working set
(measured), so sidecrew **refuses to run and tells you why** rather than quietly becoming a different
tool (ADR-0073). `sidecrew doctor` answers this before you plan anything.

**And the other half of the ledger, measured 19–20 Sep 2026:** the workers are free, the
*coordination* is not. Opus planning costs **8,400–22,100 tokens per task**, depending almost entirely
on how many tasks are in the plan — see *What this costs to run* below. A page that says "the work is
free" without saying that is telling you half of it.

### Before any number below: how tightly to read it

Every rate on this page is **an interval, never a point**, and the reason is measured. Replaying a
frontier model's own diffs — which the gate finds no defect in — through the gate a second time, **it
disagreed with itself on 2 of 19 candidates**: `D = 0.105`, 95 % interval `[0.013, 0.331]`
(`experiments/gate-error-rate/`, against a rule frozen before the first replay). That rule's own
verdict at `D > 0.10` is **UNACCEPTABLE**, and its consequence is this paragraph: no survival rate here
is published as a bare fraction, `D` travels beside each of them, and no two of our rates are compared
without asking whether their difference survives it.

**What that does and does not damage.** `D` counts the gate **refusing changes that were fine**.
Nothing in it is evidence of the gate *admitting* something bad. So:

> *The gate admits nothing that fails* — **stands.**
> *The gate refuses only things that fail* — **measured false, at roughly one evaluation in ten, and
> unproven at any tighter bound.**

Two of the three known causes are now recorded on every verdict — memory pressure (ADR-0066) and a
baseline captured on a different calendar day (ADR-0069). The third is undiagnosed, and both measured
disagreements happened on a quiet machine, so it is neither of the first two. `D` was measured on
workload #2a's gate; it says nothing about workload #1's mutation gate, which is a different oracle
(§4.4 of the rule).

### Workload #2a — behaviour-preserving changes, measured

Against a decision rule frozen before the tool had produced a single verdict
(`experiments/go-no-go-2a/results/REPORT.md`). `S` is survival, `A` is a blind reviewer's approval of
the diff. Every cell is `k/n` with its exact 95 % interval; `D = 0.105 [0.013, 0.331]` applies to
every `S`.

| input | `S`, local 7B | `S`, Haiku control | `A`, local 7B | `A`, control |
|---|---|---|---|---|
| fixture | 3/3 `[0.292, 1.000]` | 3/3 `[0.292, 1.000]` | **1/3 `[0.008, 0.906]`** | 3/3 `[0.292, 1.000]` |
| a commercial Nest/jest codebase | 12/12 `[0.735, 1.000]` | 12/12 `[0.735, 1.000]` | 9/10 `[0.555, 0.997]` | 10/10 `[0.692, 1.000]` |
| a commercial React/jest codebase | 11/12 `[0.615, 0.998]` | 12/12 `[0.735, 1.000]` | 9/10 `[0.555, 0.997]` | 10/10 `[0.692, 1.000]` |

Read the intervals, not the fractions: at these sample sizes `12/12` and `11/12` are **not
distinguishable**, and neither is the 7B from the control on `A`. Both real projects passed the frozen
rule by a margin of exactly zero, on a sample of ten. **The survival rate decided nothing** — five of
six measurable cells sit at or above 0.917, so the rule's ratio clauses were inert, and the only thing
that separated a local 7B from a network model was the approval rate.

What that approval rate is about, measured: the local model makes **unrequested cosmetic edits** — a
deleted docblock, a reworded comment, a stray blank line — in **4 of 23 `[0.050, 0.388]`** sampled
survivors, against the control's **0 of 23 `[0.000, 0.148]`**. `confined ∧ compiles ∧ tests pass`
cannot see any of it, which is the point.

### What you gain over just asking Opus

Measured 18–19 Sep 2026 against the thing a colleague actually does today — asking a frontier model
directly, one task at a time, with no plan and no gate. Same 19 hand-written tasks, same two
codebases, four arms.

| | Opus alone | Sonnet alone | **sidecrew** |
|---|---|---|---|
| tokens, 19 tasks, Nest codebase | 80,131 | 88,820 | **0** |
| tokens, 19 tasks, React codebase | 95,335 | 88,680 | **0** |
| output vs Opus, Nest codebase | — | identical 19/19 | **identical on 18 of 19** |
| changes delivered and verified, Nest | 19 (unverified) | 19 (unverified) | **19/19 `[0.824, 1.000]` survived** |
| changes delivered and verified, React | 19 (unverified) | 19 (unverified) | **15/19 `[0.544, 0.939]` survived; 4 escalated** |

The token columns are counts and are exact. The survival rows are rates, so they carry their
intervals, and `D = 0.105 [0.013, 0.331]` applies to both of them.

A fourth arm ran the **same gate over Opus's own diffs**, to separate the gate's contribution from the
worker's: **19/19 `[0.824, 1.000]`** on the Nest codebase and **18/19 `[0.740, 0.999]`** on the React
one. Two things follow, and the second is the more useful.

**The gate found nothing wrong with a frontier model's work.** Its single rejection there is a
`tsc` fragility it rejects from *both* arms — so on these tasks the gate adds no safety on top of
Opus. **Its entire value is that it makes the free worker usable**, not that it second-guesses the
expensive one.

**And it is what separates a worker defect from a project defect.** Of the four React failures, three
vanish when Opus writes the diff — genuine worker defects — and one reproduces exactly, because the
7B's output for that task was *byte-identical* to Opus's. Worker-attributable survival is therefore
**15/18 `[0.586, 0.964]`**, not 15/19. Without that control the small model would have been blamed for
a third more failures than it caused — and note that the two intervals overlap almost entirely, so the
correction changes the *attribution* rather than the number.

**Three things that buys you, and one it costs.**

1. **The work is free.** Not cheaper — zero worker tokens. Opus plans and reviews survivors; the
   editing happens on your Mac.
2. **On work a compiler and a suite can check, you give up nothing for it.** Eighteen of nineteen
   diffs were *byte-identical* to what Opus produced. Not "comparable quality" — the same file.
3. **When it is wrong, you get told, loudly, and nothing is applied.** The four React failures were a
   symbol renamed seven times over (5 compile errors), a rename that also hit a type, a module path
   and a public property key (**122 compile errors**), a change that renamed the file it was given,
   and one that a frontier model produced identically. Each printed as `escalated`, each with the
   exact errors, none merged. Asking Opus directly gives you a diff and the sentence *"nothing else
   changed"* — accurate here, and unverified.
4. **It costs wall-clock.** ~25 s per task interactively with Opus; **216–271 s** with sidecrew
   (15 s to generate, 200–255 s for the project's own suite and `tsc`). It is free and unattended,
   not fast.

**What is not claimed.** The frozen rule's verdict is **WITHHELD**: every task in these runs is a
rename, and the rule refuses a verdict until at least half are null guards, API migrations or
dead-code removal. The measurement vindicated that clause rather than surviving it — two frontier
models and a 7B emitted *identical bytes* on 18 of 19 Nest tasks, so that task set cannot rank
anything. `experiments/status-quo/` has the arms, the protocol frozen before they ran, and the
defects.

### Requirements

| | |
|---|---|
| **OS** | **macOS on Apple silicon.** The local worker is MLX, which is Apple's. Not a port away — a different inference stack. |
| **RAM** | **24 GB installed or more** for the local tier and everything this page measures. The threshold is on *installed* RAM, never free, so a machine that can host a worker never falls back silently. |
| **Node** | ≥ 20. A project whose own `engines` demands newer is honoured — run sidecrew under the project's Node (ADR-0049 cost a night to learn). |
| **Python** | `mlx-lm`, installed by you: `pip install mlx-lm`. Deliberately not bundled — external capabilities are shelled out and reported by `doctor`, never vendored. |
| **Disk** | ~4 GB for the 7B (downloaded on first `sidecrew serve`, pinned revision), plus ~500 MB per verification sandbox while a run is in flight. |
| **The project** | TypeScript with a green-ish `tsc` and a test suite that runs. Workload #1 also does Swift/XCTest. |

**Under 24 GB**: sidecrew still runs, on the `api` tier, with Haiku as the worker **billed to your key**
— and none of the numbers on this page describe that tier, because they have not been measured
(Phase 13 §5). Supported, and unpriced. If that matters to you, 24 GB is the line.

**Windows and Linux**: no. The TypeScript verifier would port, but the worker would not, and memory
and pressure detection are `sysctl`/`vm_stat`. `sidecrew doctor` tells you rather than failing oddly.

### What to expect on your machine

The check is on **installed** RAM, never free RAM — free RAM swings by 8 GB when you open Xcode, and a
tool that changes what it is based on that is a tool you cannot reason about. The floor is **24 GB**
and below it sidecrew refuses (ADR-0073).

| installed | tier | worker | gates in flight | what that means for you |
|---|---|---|---|---|
| **under 24 GB** | — | **none: sidecrew refuses** | — | A 7B cannot sit beside a normal working set here (measured), and trying anyway means swapping — which makes the gate reject changes that were fine (ADR-0066). You are told your RAM, the floor and the reason. There is an unsupported escape hatch (`SIDECREW_TIER=api`, Haiku over the network, billed to your key, **never measured**); it is not what any number on this page describes. |
| **24–32 GB** | `local` | 7B on your Mac | **1** | Everything on this page was measured here. Worker tokens are zero. One task at a time: **~4 min each**, so a 19-task plan is **~70 min**, unattended. Memory is the binding constraint — see the false-negative note below. |
| **48–64 GB** | `local` | 7B, or a 14B comfortably | ~3 *(estimated)* | The gate stops competing with the model for memory. The same 19-task plan should land nearer **~25 min** *(estimated)*, and ADR-0066's whole false-negative class — a starved gate failing closed — stops applying. You can keep using the machine. |

**Measured vs estimated, because it matters here.** The 24–32 GB row is measured: 15 s to generate,
200–255 s of the project's own `tsc` and suite, per task, on a 32 GB M2 Pro. The 48–64 GB row is an
**estimate** derived from two measured quantities — the per-task gate cost above, and the memory a
single gate actually holds (up to 8 GB of `tsc` on a large React project, plus 7–10 GB of jest
workers). Nobody has run sidecrew on 64 GB. The concurrency arithmetic is the tool's own
(`slot_gb = model.ram_gb + headroom`), so `doctor` will tell your machine what it can do.

**More RAM buys wall clock and reliability — not better changes.** Of the four failures the gate
caught on the React codebase, **none** would have been prevented by more memory: one was a symbol
renamed seven times over, one renamed a file it was given, one touched a type declared in a file the
worker was never shown, and one was byte-identical to what Opus produced. The first two are the
model; the third wants retrieval, not RAM.

**How loosely to read every survival number here** is the top of this page — `D = 0.105
[0.013, 0.331]`, the gate disagreeing with itself. It is repeated there rather than here because it
governs every rate below it, not just this table.

Two further defects changed the gate itself (ADR-0067, ADR-0068), so the Phase 11 table above was
measured on a gate that has since been fixed in two ways.

---

Both real projects are **unmodified and neither of them ours**, and every arm above ran on the
**local tier** at zero worker tokens. The `api` tier has no survival, approval or dollar figure of its
own — Phase 13 §5 was never run, and nothing on this page describes it.
`experiments/go-no-go-2a/results/REPORT.md` has the funnel, the frozen rule, and the six defects it
cost to get a number at all.

Not a test framework. Vitest, Jest and XCTest run the tests; StrykerJS/Muter mutate the code. sidecrew
orchestrates. The runner is a seam: same plan, same seed, Vitest and Jest return **identical verdicts**
(ADR-0028).

## What this costs to run

**Workers are free. Coordination is not, and this is the number that says by how much.**

Measured 19–20 September 2026 on an unmodified commercial Nest/jest codebase, against a rule frozen
before the planner existed (`experiments/planner-cost/`):

| plan size | Opus tokens to plan | **per task** | vs. paying a model per task |
|---|---|---|---|
| 12 tasks | 265,607 | **22,134** | 2.84× |
| 41 tasks | 343,144 | **8,369** | 1.07× |

**Planning cost barely moved for 3.4× the work** — 1.29×. It is a large *fixed* cost (reading the
codebase, ~233k tokens) plus a small per-task one (~2,700). So:

> **sidecrew's coordination is not worth paying for on a dozen tasks, and the economics move sharply
> in its favour as the job gets bigger.**

Both rows are above 1.0, so by the frozen rule both **fail** — planning still costs more than handing
each task to a paid model would. The honest reading is the sentence above, not "it fails": one plan
size would have supported a much harsher and much less true claim, which is exactly why the rule
demands two.

**Never quote a per-task figure without the plan size.** Same planner, same project, same week, 2.6×
apart.

**The correction round is off, and that is measured too.** Giving a failing worker one Opus-written
note — after the free retry that already carries the compiler's own words — rescued **0 of 29
`[0.000, 0.119]`** tasks,
and 27 of 29 landed at exactly the same gate stage as the free retry had
(`experiments/correction-round/`). On the tasks where the worker simply returned the file unchanged,
**16 of 17 did it again** after being told specifically that returning it unchanged was the failure.
On the shape that work belongs to — adding a null guard — the local 7B **survived**
**1 of 30 `[0.001, 0.172]`** tasks, and returned the file unchanged on 17 of them. Rewording an
instruction does not move that, which is why `sidecrew fix` ships with the round switched off.

**It is not, however, a capability ceiling, and a later measurement says so.** Phase 14b put a 14B on
the same 30 tasks and narrowed the asks to a single named function on another pass. Both cut the
"returned it unchanged" failure sharply — 17 tasks → 3 on the 14B, 17 → 10 on the narrowed ask — and
neither moved survival, which went 1 → 2 `[0.008, 0.221]`. The workers do the work; the **gate cannot
credit it**. See *What v0.1.0 does not have* below.

## Why, on workload #1 (tests)

| | Claude writes every test | sidecrew |
|---|---|---|
| Tokens per test | full generation, every function | planning + one exemplar per shape + review of survivors |
| Latency bound | API | your hardware — **40 tok/s** per 7B worker, measured below |
| What Claude reads | raw output | only tests that compiled, passed and killed ≥ 1 mutant |
| Network for generation | yes | none |

The token and survival columns were measured in Phase 6 and the answer is not a clean yes:
`experiments/go-no-go/results/REPORT.md` has the funnel, the decision rule that was frozen before the run,
and the cell it could not name. **TypeScript is a conditional go; Swift is a no-go.** The speed column:

**M2 Pro, 32 GB, macOS 26.6.2, mlx_lm 0.31.3, with Xcode *and* a simulator open** —
`experiments/go-no-go/results/bench-2026-09-11.json`, every field `"measured": true`:

| model | decode | TTFT (warm) | peak RSS | swapped | 5× same prompt |
|---|---|---|---|---|---|
| Qwen2.5-Coder-7B-Instruct-4bit | **40.5 tok/s** | 159 ms | 4.4 GB | 0 | byte-identical |
| Qwen2.5-Coder-14B-Instruct-4bit | **21.1 tok/s** | 199 ms | 8.1 GB | 0 | byte-identical |

On a quiet machine: 42.3 and 21.2 tok/s — a full Xcode working set costs the 7B about 4 % and the 14B
almost nothing. What Xcode costs is memory, not speed: at 9.1 GB free the 14B swapped 3.2 GB. That is
why the 7B is the default and why starting a worker is gated on free RAM at that instant (ADR-0011).

## Install

**Requirement: an Apple Silicon Mac with at least 24 GB of installed RAM.** Below that a 7B cannot sit
beside a normal working set (ADR-0009, measured), and sidecrew **refuses to start**, naming your RAM,
the floor and the reason. `sidecrew doctor` answers it before you plan anything.

Refusing is deliberate rather than lazy. Running anyway means swapping, and swapping makes this gate
reject changes that were fine, in a way its own verdict cannot distinguish from a real defect
(ADR-0066, measured). Handing that to the users least able to spot it is worse than saying no.

**There is one escape hatch and it is unsupported.** `SIDECREW_TIER=api` runs the worker as
`claude-haiku-4-5` over the Anthropic API, behind the same gate, billed to your key. It is built and
tested, its survival and dollar-per-task figures have **never been measured**, and no number on this
page describes it (ADR-0073). `doctor` labels it *unsupported, opted in*.

Everything except generation (planning, validating, verifying) works anywhere node does.

```
npm install -g sidecrew
sidecrew doctor
```

`doctor` checks each capability separately:

```
ok       platform         darwin/arm64
ok       node             v20.20.0
ok       tier             32.0 GB installed → local tier · qwen2.5-coder-7b-4bit
ok       mlx_lm           python3 -m mlx_lm server available
MISSING  worker           nothing on http://localhost:8000/v1 — start one with: sidecrew serve
ok       memory           32.0 GB total · 12.5 GB free
ok       tsc              Version 5.9.3
ok       vitest           vitest/2.1.9 darwin-arm64 node-v20.20.0
MISSING  stryker          @stryker-mutator/core is not resolvable from this project — npm i -D @stryker-mutator/core
ok       swift            Apple Swift version 6.3.3
MISSING  muter            not installed — brew install muter-mutation-testing/formulae/muter
ok       line-ranges      from the TypeScript compiler's own tree (ADR-0076)
DEGRADED tsconfig-include sidecrew writes candidates to test/, and no file there is in the program
                          tsconfig.json builds — every candidate would be compiled by a stage that
                          never opens it (ADR-0037)
ok       ts-jest          ts-jest does not resolve here — the shim is not needed
ok       tsc-heap         this project's own scripts ask for no extra heap
ok       jest-tests       jest does not resolve here — not this project's runner
```

**The bottom five rows are the ones worth reading**, and each was a run that failed — or worse, one
that quietly succeeded. "Is it installed" answers yes for all of them; the defect is one layer down,
in how a particular project is laid out. `tsconfig-include` is the worst of the six real-world
blockers and the only one that ever failed *open*: a compile stage that type-checked the project
without ever opening the candidate, and said `compile ok` about a file with three type errors in it.

### Claude Code

```
claude mcp add --scope user sidecrew -- npx -y sidecrew mcp
```

Then `claude mcp list` should say `sidecrew: … ✔ Connected`, and `sidecrew_status` is callable from a
new Claude Code session. Installing the skill and agents adds `/sidecrew plan|run|review|escalate`:

```
cp -r $(npm root -g)/sidecrew/claude/skills/sidecrew ~/.claude/skills/
cp    $(npm root -g)/sidecrew/claude/agents/*.md     ~/.claude/agents/
```

The same files are a Claude Code plugin — `claude/.claude-plugin/plugin.json` is its manifest, and its
version moves with `package.json` and `server.json`.

The skill is what keeps generation on the local worker: a Claude Code subagent can only pick
haiku/sonnet/opus on the session endpoint, so workers cannot be subagents and the skill says so in as
many words (ADR-0001).

### Any other MCP client

```json
{ "mcpServers": { "sidecrew": { "command": "npx", "args": ["-y", "sidecrew", "mcp"] } } }
```

## Capabilities are independent

| Capability | Needs | Without it |
|---|---|---|
| Plan, validate, verify TypeScript | node, `tsc`, **`vitest` or `jest`**, `stryker` + its runner plugin | — |
| Verify Swift | Xcode CLT, `muter` | TS only |
| Local workers | `pip install mlx-lm` (Apple Silicon) | verify-only; Claude writes tests itself |

```
pip install mlx-lm                                          # workers
brew install muter-mutation-testing/formulae/muter          # Swift mutation

# in the project being tested — Stryker drives the runner through a plugin
npm i -D @stryker-mutator/core @stryker-mutator/vitest-runner   # or @stryker-mutator/jest-runner
```

`sidecrew doctor --project <dir>` reports which of the two runner plugins that project has, because
`stryker` alone cannot mutate anything.

## The tools

| Tool | What it does |
|---|---|
| `sidecrew_status` | Worker up? Which model, revision, free RAM, which verifiers are available. |
| `sidecrew_generate` | One `WorkerTask` → one candidate test from the local model. Never touches the Anthropic API. |
| `sidecrew_verify` | compile → run → mutate one file → `Verdict`. |
| `sidecrew_run_batch` | Whole plan: generate → verify → retry once with the error → escalate. Returns survivors and escalations only. |
| `sidecrew_plan_validate` | A plan, before anything spends on it: schema, line ranges, `source_sha`, and every exemplar run through the verifier for real. |
| `sidecrew_escalate` | What the workers could not do, with the exemplar and rules they had and both attempts' errors. Reads a finished run off disk. |
| `sidecrew_review` | Which survivors are worth reading: below the per-language mutation-score threshold, plus a deterministic audit sample, batched under a token cap. |

## How it works

```
Claude (Opus)          sidecrew                       local worker (mlx_lm.server)
  reads module ──► test_plan.json + one exemplar/shape
                     for each function × shape ──► prompt = source + exemplar ──► candidate
                     verifier: tsc/swift build → vitest/swift test → stryker/muter
                        survive? ── yes ──► survivors (Claude reviews low mutation-score ones)
                                 ── no  ──► retry once with error ──► escalate to Claude
```

- **The verifier is the product.** Survive ⇔ compiles ∧ passes ∧ kills ≥ 1 mutant ∧ not tautological.
- **Workers are deterministic.** temperature 0, fixed seed, pinned model revision. The seed is also what
  keeps a request out of `mlx_lm.server`'s batch — it decides batchability as `is_batchable and
  args.seed is None`, so sending one serialises the request by construction (ADR-0003).
- **Workers are a separate process, not a Claude Code subagent.** Subagents can only pick haiku/sonnet/opus on the session endpoint, so local routing has to go through MCP. See `docs/research/`.
- **Memory-aware, in two different senses.** *Installed* RAM picks the tier — 24 GB and up host a local
  worker. **Below 24 GB sidecrew refuses**, naming your RAM, the floor and the reason (ADR-0073). The
  `api` tier ADR-0009 designed for those machines was built in Phase 13 and then taken off the
  supported path, because no survival, approval or price figure for it exists; it survives only as
  `SIDECREW_TIER=api`, labelled unsupported by `doctor`. *Free* RAM decides whether one may start right
  now: `serve` refuses below the model's footprint + 2 GB, because a worker that starts into swap does not
  merely run slowly, it poisons every number measured afterwards. It also asks the kernel's own
  memory-pressure level, because under pressure macOS compresses and the free count rises while the
  machine gets worse (ADR-0026) — `--wait` queues for room rather than refusing.

## CLI

```
sidecrew doctor                                  what this machine can do
sidecrew models [--pin [KEY]]                    pinned revisions, what is downloaded, this machine's tier
sidecrew serve [--model qwen2.5-coder-7b-4bit] [--port 8000] [--force] [--wait N] [--allow-unpinned]
sidecrew status / stop
sidecrew bench [--determinism]                   tok/s, TTFT, peak RSS → experiments/go-no-go/results/
sidecrew plan test_plan.json [--quick]                        validate a plan; non-zero if it is not valid
sidecrew run test_plan.json [--concurrency N] [--dry-run]     whole plan, survivors out
sidecrew verify <test-file> --plan test_plan.json            one file, one Verdict, non-zero if it failed
sidecrew generate --plan P --function F --shape S            one candidate, for looking at
sidecrew escalate [RUN_ID]                                   what the workers could not do, for Claude
sidecrew review [RUN_ID]                                     which survivors are worth Claude's eyes
sidecrew mcp
```

`doctor`, `status` and `verify` all answer about the project they are pointed at, not about sidecrew's
own directory: `sidecrew doctor --project fixtures/ts-fixture` reports *that* package's `tsc`, `vitest`
and `stryker`, which are the ones a verdict depends on.

### A run

```
sidecrew serve                                   # one 7B worker, gated on free RAM
sidecrew run fixtures/ts-fixture/plans/strings/test_plan.json --dry-run   # tasks, concurrency, stale check — no tokens
sidecrew run fixtures/ts-fixture/plans/strings/test_plan.json
```

```
run 2026-09-14T10-24-26Z-strings: 6 tasks, 13.0 GB free ÷ 6.5 GB per slot = 2; 1 worker up, so 1 in flight and 2 test processes each
titleCase:happy_path:0: survived (score 0.88)
…
6/6 survived · 0 escalated · .sidecrew/runs/2026-09-14T10-24-26Z-strings/result.json
```

Concurrency is a function, not a setting: installed RAM picks the tier, free RAM at the instant the run
starts picks how many candidates may be in flight, and `--concurrency` is a ceiling that cannot talk the
machine into memory it does not have.

### Pinning a model

mlx_lm has no `--revision`, so a repo id means "whatever `main` is today". `sidecrew models --pin` writes
the commit that is actually in your Hugging Face cache into `src/models.json`, and `serve` then passes the
snapshot *path* — one immutable commit that cannot reach the network (ADR-0010).

```
sidecrew serve                 # downloads on first run
sidecrew models --pin          # writes the commit it downloaded
sidecrew bench --determinism   # 5× the same prompt: byte-identical, or non-zero exit
```

## Status

**Phase 14 — the first public release.** The pipeline runs end to end for both workloads: plan,
generate on a local worker, verify, retry once, escalate; and `sidecrew fix` does the same for
behaviour-preserving code changes. Five measurements have been taken against rules frozen before any
number existed, and the honest summary is that **three of them said no**:

| | verdict | where |
|---|---|---|
| workload #1, TypeScript | **conditional go** — 0.85 of Haiku on the fixture, at zero worker tokens and half the latency (ADR-0020) | `experiments/go-no-go/` |
| workload #1, Swift | **no-go** — 0.64 of Haiku even after the prompt fix that more than doubled it (ADR-0021) | `experiments/go-no-go/` |
| workload #2a | **go on both real projects, by a margin of exactly zero**, and WITHHELD on the task mix (every task was a rename) | `experiments/go-no-go-2a/`, `experiments/status-quo/` |
| planning cost `R` | **fail at both plan sizes** — 2.84 at 12 tasks, 1.07 at 41 | `experiments/planner-cost/` |
| the gate's own error rate `D` | **UNACCEPTABLE** — 0.105 `[0.013, 0.331]` | `experiments/gate-error-rate/` |

> **That 0.85 is a fixture number and it overstates by more than 2×.** Measured afterwards on
> unmodified real projects, workload #1's survival was **3/8 `[0.085, 0.755]`** and **4/8
> `[0.157, 0.843]`** on a Nest codebase and **4/10 `[0.122, 0.738]`** on a React one. Those
> intervals overlap each other and the fixture's, so *nothing* here is ranked by them; what they
> rule out is planning against 0.85. The fixture's functions are small, self-contained and free of
> the imports, shared types and framework scaffolding that real code is mostly made of.
> `D` was measured on workload #2a's gate and does not apply to these — mutation testing is a
> different oracle with different failure modes.

The 14B is never the right trade on this evidence — it matched the 7B on TypeScript, lost on Swift,
and cost 2.2× the generation time.

**What v0.1.0 does not have.** Half a real codebase is out of reach: 3.3 % of a project's files are
48.1 % of its bytes, and every file over 1,000 lines is refused, because a worker returns a whole file
and a whole file has to fit (ADR-0075 — symbol-scoped return is the proposed fix and it is not in this
release).

**Which shapes this is actually for.** Of the five behaviour-preserving shapes, **one — renames and
dead-import removal — works at a usable rate.** `null_guard` does not, and Phase 14b measured *why*,
which changes what to do about it: **`S₁₄ = 2/30 `[0.008, 0.221]`, best of a 14B worker and
single-function asks.** Neither model size nor task size is the obstacle — both probes moved what they
targeted. **Every additional file a worker fixed correctly became a task nobody can pass**, one for
one: +6 correct → +6 unsatisfiable, +9 → +9. The reason is in the gate's own fields — the error that
sinks those tasks is in a **test file in 21 of 21** cases and in non-test source in **0**. A null guard
narrows a type, the narrowed type propagates into fixtures and mocks, and `sidecrew` may not edit tests
because **the tests are the gate**.

So the honest statement is not "small models cannot do this". It is: **under a strictness flag on a
project whose tests touch the types being tightened, this shape is unpassable however good the worker
is — and it gets worse as the worker gets better** (12 → 18 → 21 unsatisfiable across the three arms).
`api_migration` and `dead_code` remain **unmeasured**. ADR-0077 records the options and the owner has
taken the one that measures the counterfactual before choosing between them.

`docs/plan/PHASES.md` is the road from here and names what each step buys.

**One measurement worth reading before believing the pitch above.** The design says exemplars are what
make a small model usable (research §B). Our own ablation says otherwise: bare scores 4/20, and *every*
one of its 15 compile failures is a missing `import { describe, it, expect } from "vitest"`. Adding one
sentence about that import — no exemplar — scores 16/20, one *above* the full exemplar. The exemplar is
kept because it buys survivor mutation score (1.00 against 0.93) and cost (150 completion tokens against
258), not because it gets candidates through the gate. ADR-0017 has the table and the caveats, the
loudest being that 16/15/17 is one or two tasks at n = 1.

### What a long run does to a machine, and what sidecrew does about it

Phase 7's hardening, each with the ADR that argued it:

- **The single retry is spent only when it can help.** A failure the mutation *tool* caused, a function
  with no mutants at all, and a retry whose prompt would be byte-identical to the first attempt's are all
  escalated rather than retried (ADR-0012, ADR-0005, ADR-0022). The retry prompt is its own template.
- **Escalations are written as they happen**, to `.sidecrew/runs/<id>/escalations.jsonl`, so a run killed
  at minute forty still has the record of what its attempts bought (ADR-0023). A task that throws is
  escalated and the other nineteen keep running; a setup error still stops everything.
- **Claude reads the weakest survivors, not all of them** — below a per-language score threshold plus a
  deterministic 10 % audit sample, batched under a token cap (ADR-0024). 0.6 on TypeScript, 1.0 on Swift,
  because a Swift verdict is computed over one or two mutants against TypeScript's six to twelve.
- **A worker does not start into swap.** Free RAM *and* the kernel's own memory-pressure level, because
  under pressure macOS compresses and the free count rises while the machine gets worse (ADR-0026).
  `--wait` queues for room instead of refusing.
- **A machine that sags loses a slot.** Decode rate more than **30 %** below the `sidecrew bench` baseline
  for two minutes drops worker concurrency by one, and no bench means no guard rather than a guess
  (ADR-0025).
- **An unpinned revision is refused**, not warned about, because two survival rates taken on two commits
  of the same repo are not comparable and nothing downstream can tell (ADR-0027).

`sidecrew run --dry-run` writes every task *and* every rendered prompt and stops before the first token.

### Where this is going

**The bar, in the owner's words: *"be able to achieve what Opus does, our way — even 90 % is a win."***
That decomposes into four numbers, all re-measured at the end of every phase so the bar is a
scorecard rather than a feeling:

| | what it measures | today | at the bar |
|---|---|---|---|
| **Reach** | share of a real codebase **by bytes** a task may touch | **51.9 %** | ≥ 90 % |
| **Shapes** | behaviour-preserving shapes surviving at a usable rate | **1 of 5** | ≥ 4 of 5 |
| **Cost** | `R` — Opus tokens to plan ÷ paying a model per task | **2.84** at 12 tasks, **1.07** at 41 | ≤ 1.0 at 12 |
| **Trust** | `D` — how often the gate disagrees with itself | **0.105** `[0.013, 0.331]` | ≤ 0.02, or diagnosed |

Only Cost improves on its own as jobs get bigger. Reach is ADR-0075's symbol-scoped return; Shapes has
now been measured once (Phase 14b) and the ceiling turned out to be the gate's scope rather than the
worker's, which is ADR-0077's to resolve; Trust needs a diagnosis, not a threshold. `docs/plan/PHASES.md` has
the phase for each, and **every one of them ends with a rule written before the phase runs** — a fork
chosen after seeing a result is a description of how somebody felt about the result.

**Workload #2b — behaviour-*changing* work — is deliberately last**, and
[ADR-0031](docs/DECISIONS.md) says why: behaviour-preserving changes already have a free oracle, the
project's own suite, while behaviour-changing ones need Opus to write a specification. That inverts
the token economics and flips ADR-0006's Goodhart problem the wrong way — a bad test gets discarded
by the gate, but a bad implementation that passes the tests it was shown ships.

What is not here: the `api` tier **runs** (Phase 13) and is unsupported (ADR-0073) because it has no
measurement of its own — no survival rate, no approval rate, no price. The thermal guard has still
never *fired*; the soak says the machine gave it no reason to, which is not the same as saying a
back-off would land correctly. `docs/research/` is why the design looks like this.

## Working on sidecrew itself

```bash
npm i && npm run lint && npm test
```

**The fixtures under `fixtures/` have their own dependencies and they are not in the repository** — they
are build artefacts. A clean clone therefore runs the suite with a handful of fixture-dependent cases
**skipped**, and each skip says which command enables it. To run everything:

```bash
for f in fixtures/*/; do [ -f "$f/package.json" ] && npm --prefix "$f" i; done
```

Tests that need a real toolchain — a live worker, Stryker, Muter, a project's own suite — are
`*.slow.test.ts` and run only with `SIDECREW_SLOW=1`. CI runs the fast set.

## Releasing

Same as simframe: bump `package.json`, `server.json` and `claude/.claude-plugin/plugin.json` together, tag, push; CI checks all three agree and the release workflow publishes to npm and the MCP Registry.

## License

MIT. Worker models and tools have their own licences; only Apache-2.0 / MIT ones are on the shortlist.
`docs/research/licences.md` is the audit — what is shipped, what is downloaded, and what is merely
recommended, each read off the installed artefact rather than off a website.
