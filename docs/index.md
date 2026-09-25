# sidecrew

**You ask for a change to your source code, and you get it — made on your Mac, by models that cost
you no Claude tokens, and only after a machine has checked it.**

Claude Opus plans the work and reviews what came back. Small models running locally (MLX, no network)
do the narrow parts. Between them sits a gate a machine can run, and Claude never sees anything that
did not survive it.

- For a **code change**: the diff stayed where it was asked to, `tsc` is clean, and every test that
  passed before still passes.
- For a **unit test**: it compiles, it passes against the original code, it kills at least one mutant
  of the function under test, and it is not tautological.

One honest gate per workload is the unit of progress here. A workload a machine cannot check does not
belong in this tool at any price.

---

## Install

Requires **macOS on Apple silicon with at least 24 GB of installed RAM**. Below that a 7B worker
cannot sit beside a normal working set, and sidecrew refuses to start rather than quietly becoming a
different tool.

```
npm install -g sidecrew
pip install mlx-lm
sidecrew doctor
```

`doctor` is the first thing to run and the first thing to read. It reports each capability separately
— and, below the capabilities, five **pre-flight questions** that are not "is it installed" but "will
it do the thing". Each of those five was a real project that failed, or worse, one that quietly
succeeded.

For Claude Code:

```
claude mcp add --scope user sidecrew -- npx -y sidecrew mcp
```

---

## The numbers

**Read the intervals, not the fractions.** Every rate below is `k/n` with its exact 95 % interval,
and none of them is published as a point. The reason is measured: replaying a frontier model's own
diffs through the gate a second time, **the gate disagreed with itself on 2 of 19 candidates** —
`D = 0.105`, interval `[0.013, 0.331]`.

That number counts the gate **refusing changes that were fine**. Nothing in it is evidence of the
gate admitting something bad. So *the gate admits nothing that fails* stands; *the gate refuses only
things that fail* is measured false at roughly one evaluation in ten.

### Behaviour-preserving code changes, on two unmodified commercial codebases

| input | survived, local 7B | survived, Haiku control | blind approval, 7B | blind approval, control |
|---|---|---|---|---|
| a Nest/jest codebase | 12/12 `[0.735, 1.000]` | 12/12 `[0.735, 1.000]` | 9/10 `[0.555, 0.997]` | 10/10 `[0.692, 1.000]` |
| a React/jest codebase | 11/12 `[0.615, 0.998]` | 12/12 `[0.735, 1.000]` | 9/10 `[0.555, 0.997]` | 10/10 `[0.692, 1.000]` |

At these sample sizes `12/12` and `11/12` are not distinguishable, and neither is the local model
from the network control. Both projects passed the frozen decision rule by a margin of exactly zero.

### Against the thing you would otherwise do

Asking a frontier model directly, one task at a time, no plan and no gate. Same 19 hand-written
tasks, same two codebases.

| | Opus alone | Sonnet alone | sidecrew |
|---|---|---|---|
| tokens, 19 tasks, Nest | 80,131 | 88,820 | **0** |
| tokens, 19 tasks, React | 95,335 | 88,680 | **0** |
| output vs Opus, Nest | — | identical 19/19 | identical on 18 of 19 |
| delivered **and verified**, Nest | 19, unverified | 19, unverified | 19/19 `[0.824, 1.000]` |
| delivered **and verified**, React | 19, unverified | 19, unverified | 15/19 `[0.544, 0.939]` |

### What it costs to run

The workers are free. The coordination is not, and this is the number that says by how much — Opus
planning, measured on an unmodified commercial Nest codebase:

| plan size | Opus tokens to plan | per task | vs. paying a model per task |
|---|---|---|---|
| 12 tasks (20 Sep, Opus 5) | 265,607 | 22,134 | 2.84× |
| 41 tasks (20 Sep, Opus 5) | 343,144 | 8,369 | 1.07× |
| 11 tasks, with retrieval tools (25 Sep, Opus 5.5) | 177,203 | 16,109 | 2.07× |
| 36 tasks, with retrieval tools (25 Sep, Opus 5.5) | 225,691 | 6,269 | 0.80× |

Planning cost barely moves with the size of the job: it is a large **fixed** cost per job plus a small
per-task one. So sidecrew's coordination is not worth paying for on a dozen tasks, and the economics move
sharply in its favour as the job gets bigger. Giving the planner compiler-backed tools to read with cut it
~23 % — not enough at 12 tasks, by the rule frozen before it was measured. **In dollars, most of a planner's
bill is re-reading its own growing context** (cache reads, 33–67 %), not thinking: about **$2.4–3.3 for a
~12-task job and $2.7–3.5 for a ~40-task one** on Opus 5.5 (measured, 25 Sep).

And it costs wall clock: ~25 s per task interactively with Opus, **216–271 s** with sidecrew. It is
free and unattended, not fast.

---

## Where it is going

**The claim it is working towards: *"we do what Claude Opus does, in a different and cheaper way"* — and any
user can get that result on their own code.** 1.0 means sidecrew's success is at least 80–90 % of Opus-alone's
on a benchmark of real requests, features and bug fixes included, for at most half its dollars on batch jobs —
stated as a formula with its error margin, never a single number. 2.0 is as fast as Opus; 3.0 as good or better.
Until then each 0.x release adds a category of work, claimed only once measured. The full roadmap and today's
scorecard are in the [README](https://github.com/lvlrSajjad/sidecrew#roadmap) and [the roadmap](plan/ROADMAP.md).

---

## How it works

```
Claude (Opus)          sidecrew                        local worker (mlx_lm.server)
  reads the module ──► plan + one exemplar per shape
                        per task ──► prompt = source + exemplar ──► candidate
                        gate: confined? · tsc clean? · every test that passed still passes?
                           survive? ── yes ──► Claude reviews the weakest survivors
                                    ── no  ──► retry once with the error ──► escalate
```

- **The gate is the product.** It is an iff in `src/schemas.ts`, not a convention: a verdict that
  claims a survival its own fields do not support does not serialise.
- **Worker inference never touches the Anthropic API.** A local run that spent Claude tokens on
  worker inference does not serialise either.
- **Workers are deterministic** — temperature 0, fixed seed, pinned model revision.
- **Memory-aware in two senses.** *Installed* RAM picks the tier; *free* RAM at the instant a run
  starts decides how many candidates may be in flight. A worker that starts into swap does not merely
  run slowly, it poisons every number measured afterwards.

---

## Read before believing any of it

Everything here was measured against a rule written **before** the number existed, and the rules and
the raw results are in the repository:

| | |
|---|---|
| [Decisions](DECISIONS.md) | every architectural decision, with the evidence and the options rejected |
| [Vision](plan/VISION.md) | what this is for, in the owner's words |
| [Phases](plan/PHASES.md) | where it is, what each step buys, and the exit rule frozen before each one runs |
| [Roadmap](plan/ROADMAP.md) | the capability ladder to 1.0, and what 1.0, 2.0 and 3.0 mean |
| [What stands between it and 1.0](plan/V1-CHALLENGES.md) | the challenges, stated for an independent reviewer — and [the review](research/2026-09-25-v1-independent-analysis.md) |
| [The pipeline contracts](specs/pipeline.md) | the JSON between planner, workers, verifier, reviewer |
| [Research](research/) | why the design looks like this — including why a worker cannot be a subagent |
| [Changelog](CHANGELOG.md) | |

The experiments themselves — the frozen rules, the funnels, the defects each measurement cost — are
under `experiments/` in the repository. The projects they ran against are a client's and are named
only as `project-a` and `project-b`; the rates, funnels and costs are ours and are all here.

---

MIT. Worker models and tools have their own licences, and only Apache-2.0 / MIT ones are shipped or
downloaded by default — `research/licences.md` is the audit, read off the installed artefact rather
than off a website.
