# sidecrew

**Local workers for Claude Code, behind a verifier.**

Claude Opus plans, writes one exemplar per kind of task, and reviews. Small models running **on your Mac**
(MLX, no network) do the narrow work in parallel. A mechanical gate — compile → run → mutation-kill — decides
what Claude ever sees. **On the local tier, workers cost zero Claude tokens** — that headline is a
local-tier headline (ADR-0045). On machines with under 24 GB of RAM, which cannot host a local model,
the worker is Haiku over the API and it is billed; `sidecrew doctor` says which tier you are on and why.

First workload: **unit tests for an existing Swift or TypeScript project**, and the benchmark numbers
below are about that one.

A second workload — **behaviour-preserving changes** to TypeScript that already exists, gated by the
project's own test suite plus `tsc` (`sidecrew fix`) — is built **and measured**, against a decision
rule frozen before the tool had produced a single verdict:

| input | survived (local 7B) | survived (Haiku control) | blind approval (7B) | blind approval (control) |
|---|---|---|---|---|
| fixture | 3/3 | 3/3 | **1/3** | 3/3 |
| a commercial Nest/jest codebase | **12/12** | 12/12 | **9/10** | 10/10 |
| a commercial React/jest codebase | **11/12** | 12/12 | **9/10** | 10/10 |

### What you gain over just asking Opus

Measured 18–19 Sep 2026 against the thing a colleague actually does today — asking a frontier model
directly, one task at a time, with no plan and no gate. Same 19 hand-written tasks, same two
codebases, four arms.

| | Opus alone | Sonnet alone | **sidecrew** |
|---|---|---|---|
| tokens, 19 tasks, Nest codebase | 80,131 | 88,820 | **0** |
| tokens, 19 tasks, React codebase | 95,335 | 88,680 | **0** |
| output vs Opus, Nest codebase | — | identical 19/19 | **identical on 18 of 19** |
| changes delivered and verified, Nest | 19 (unverified) | 19 (unverified) | **19/19 survived the gate** |
| changes delivered and verified, React | 19 (unverified) | 19 (unverified) | **15/19 survived; 4 escalated** |

A fourth arm ran the **same gate over Opus's own diffs**, to separate the gate's contribution from the
worker's: **19/19** on the Nest codebase and **18/19** on the React one. Two things follow, and the
second is the more useful.

**The gate found nothing wrong with a frontier model's work.** Its single rejection there is a
`tsc` fragility it rejects from *both* arms — so on these tasks the gate adds no safety on top of
Opus. **Its entire value is that it makes the free worker usable**, not that it second-guesses the
expensive one.

**And it is what separates a worker defect from a project defect.** Of the four React failures, three
vanish when Opus writes the diff — genuine worker defects — and one reproduces exactly, because the
7B's output for that task was *byte-identical* to Opus's. Worker-attributable survival is therefore
**15/18**, not 15/19. Without that control the small model would have been blamed for a third more
failures than it caused.

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

The tier is decided by **installed** RAM, never by free RAM, so a machine that can host a worker never
falls back silently (`sidecrew doctor` names your tier and why). The threshold is **24 GB**.

| installed | tier | worker | gates in flight | what that means for you |
|---|---|---|---|---|
| **16 GB** | `api` | Haiku, over the network | 1 | It runs, and **the worker is billed** — the zero-token headline is a local-tier claim. Its survival, approval and dollar-per-task figures **have never been measured** (Phase 13 §5). Treat this tier as supported and unpriced. |
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

**Read the survival numbers below as lower bounds.** Phase 11b found three independent sources of
false negatives in the gate — memory pressure (ADR-0066), a still-undiagnosed one on an idle machine,
and a baseline captured on a different calendar day (ADR-0069) — and only one is understood. Two
further defects changed the gate itself (ADR-0067, ADR-0068), so the Phase 11 table above was
measured on a gate that has since been fixed in two ways.

---

Unmodified projects, neither of them ours, at **zero worker tokens — on the local tier**, which is what
these arms ran on. The `api` tier's own survival, approval and dollar-per-survivor figures are Phase 13
§5's and **have not been measured**; nothing here is them. Both real projects pass the
frozen rule — each by a margin of exactly zero, on a sample of ten, so read them with their intervals
(`[0.555, 0.997]` on the approval rate). `experiments/go-no-go-2a/results/REPORT.md` has the funnel,
the rule, and the six defects it cost to get a number.

**The survival rate decided nothing**, and that is the phase's most useful result. Five of six
measurable cells sit at or above 0.917, so the rule's ratio clauses were inert; the only thing that
separated a 7B from a network model was a blind approval rate on a sample of diffs — the local model
makes unrequested cosmetic edits (a deleted docblock, a reworded comment, a stray blank line) in
**4 of 23** sampled survivors against the control's **0 of 23**, and `confined ∧ compiles ∧ tests
pass` cannot see any of it.

Not a test framework. Vitest, Jest and XCTest run the tests; StrykerJS/Muter mutate the code. sidecrew
orchestrates. The runner is a seam: same plan, same seed, Vitest and Jest return **identical verdicts**
(ADR-0028).

## Why

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

**An Apple Silicon Mac with ≥ 24 GB of RAM runs workers locally.** 16 GB is not enough to host a 7B next
to a normal working set, so those machines are the **`api` tier**: the worker is `claude-haiku-4-5` over
the Anthropic API, doing the same small tasks behind the same gate (ADR-0009, ADR-0045, ADR-0060). Set
`ANTHROPIC_API_KEY` and it runs; worker inference is then **billed to you**, and `BatchResult`/`FixResult`
record which tier ran. `sidecrew doctor` tells you which side of the line you are on, why, and what to do.

**The api tier's numbers do not exist yet.** It is built and tested; its survival rate, blind approval
rate and dollar-per-surviving-task are Phase 13 §5's measurement and have not been run. Phase 6's Haiku
figures are an upper bound from a subagent harness and are not this tier's cost (ADR-0045 §7).

Everything except generation (planning, validating, verifying) works anywhere node does.

```
npm install -g sidecrew
sidecrew doctor
```

`doctor` checks each capability separately:

```
ok       node       v20.20.0
ok       mlx_lm     python3 -m mlx_lm server available
MISSING  worker     nothing on http://localhost:8000/v1 — start one with: sidecrew serve
DEGRADED memory     32.0 GB total · 12.9 GB free — room for one qwen2.5-coder-7b-4bit, not two workers or a 14B
ok       tsc        Version 5.9.3
ok       vitest     vitest/2.1.9 darwin-arm64 node-v20.20.0
MISSING  stryker    not in this project's node_modules — npm i -D @stryker-mutator/core
ok       swift      Apple Swift version 6.3.3
MISSING  muter      not installed — brew install muter-mutation-testing/formulae/muter
```

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
  worker. **16 GB machines cannot**, and the API fallback ADR-0009 designed for them is documented and
  **not implemented**, so on those machines `sidecrew run` does not run. *Free* RAM decides whether one may start right
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

Phase 7. The pipeline runs end to end — plan, generate on a local worker, verify, retry once, escalate —
and the go/no-go has been run. **Read `experiments/go-no-go/results/REPORT.md` before believing anything
here.** Its verdict is split: TypeScript is a **conditional go** at 0.85 of Haiku for zero worker tokens
and half the latency (ADR-0020), and Swift is a **no-go** at 0.64 of Haiku even after the prompt fix that
more than doubled it (ADR-0021). The 14B is never the right trade on this evidence — it matched the 7B on
TypeScript, lost on Swift, and cost 2.2× the generation time.

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

**Workload #2: local models making the code changes, not just the tests.** Opus plans and breaks the work
down, local workers make small changes, Opus approves. The contract was built for it — `docs/specs/pipeline.md`
has said "test generation is workload #1" since the first commit, and the `WorkerTask → Candidate → Verdict`
triple is deliberately generic.

It is **proposed, not decided**: [ADR-0031](docs/DECISIONS.md) has four options and the argument for each.
The distinction it turns on is that *behaviour-preserving* changes (a rename, a null guard, an API
migration) already have a free oracle — the project's own test suite — while *behaviour-changing* ones need
Opus to write a specification, which inverts the token economics and flips ADR-0006's Goodhart problem the
wrong way: a bad test gets discarded by the gate, but a bad implementation that passes the tests it was
shown ships.

What is not here: the `api` tier now **runs** (Phase 13), but it has no measurement of its own — no
survival rate, no approval rate, no price. The thermal guard has still never *fired* — the soak above says the machine
gave it no reason to, which is not the same as saying a back-off would land correctly. `docs/plan/PHASES.md` is
the roadmap; `docs/research/` is why it looks like this.

## Releasing

Same as simframe: bump `package.json`, `server.json` and `claude/.claude-plugin/plugin.json` together, tag, push; CI checks all three agree and the release workflow publishes to npm and the MCP Registry.

## License

MIT. Worker models and tools have their own licences; only Apache-2.0 / MIT ones are on the shortlist.
`docs/research/licences.md` is the audit — what is shipped, what is downloaded, and what is merely
recommended, each read off the installed artefact rather than off a website.
