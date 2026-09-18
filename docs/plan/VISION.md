# Vision — what sidecrew is for

**Owner's statement, 16 Sep 2026.** This is the destination. `PHASES.md` is the route; every phase in it
either moves towards this or is a detour that has to justify itself.

> From outside, the user wants to change x, y, z in their source code, and the change gets done **with
> the same quality Opus itself would produce**. From inside, it is not just Opus — it is Opus with its
> local model employees.

## The shape

1. The user asks Claude for something real: a feature, a refactor, a bug fix, *fix every TypeScript error
   in this codebase*.
2. Claude does the thinking — the planning, the supervision, the management, the **hiring** of local
   models that are individually much less capable. Planning means deciding *what* has to change, in *how
   many steps*, and *how the work is grouped* so that each piece is small enough for a weak model.
3. Local models take their piece of the plan, do it, report back, and can say something when they need to.
4. Claude checks each piece. What is right is approved. What is wrong goes back with a note saying what
   is wrong, and the worker tries again.

The point is not that a 7B is good. It is that **a 7B behind a mechanical gate, managed by something that
is good, can be trusted with work that would otherwise cost Claude tokens** — and the user never sees the
difference, because the output is held to the same bar either way.

### The owner's worked example

> Say I want a major refactor across the whole project. Opus lists what needs to be done, in how many
> steps, and how many smaller local model instances each step needs. It hires them and gives each the
> prompt for its part — if 100 files need to change, one worker is responsible for maybe 5–10 files,
> grouped in a way that makes sense. Each reports back when it is finished; Opus confirms the job was done
> properly, and if not, gives it the prompt to fix it.

Every clause of that is a design requirement, and each one is either built, planned, or an open decision:

| clause | where it stands |
|---|---|
| Opus lists what has to be done and in how many steps | **ordered steps built** (ADR-0044 §2, Phase 10); the **planner** that writes them is Phase 12 |
| how the files are grouped, 5–10 per worker | **built** — `ChangeTask.files`, `max_group_size` default 10 (ADR-0044 §1); *who* groups them is Phase 12 |
| how many instances each step needs | see *where the machine bends the picture*, below — and there is no `workers` field, enforced |
| each reports back | **built** — the code-change verdict is ADR-0047 §3 |
| Opus confirms the job was done properly | the gate decides what Opus sees; Opus approves — **built for both workloads** (ADR-0048) |
| if not, gives it the prompt to fix it | the **correction round** — ADR-0044 §4, Phase 12; today the only retry is mechanical |

### Where the machine bends the picture

"How many instances" is the one clause the hardware rewrites. A 32 GB Mac hosts **one or two** resident
7B workers (measured, Phase 1); a 24 GB Mac one. So "hire ten workers for this step" cannot mean ten
processes. It means **ten tasks**, queued against the workers that are up, and the run decides how many
run at once from free RAM at that instant (ADR-0011, ADR-0025). Opus decides the *shape* of the work —
how it is cut and grouped and ordered. The machine decides the process count, and nothing in the plan
pretends otherwise.

### Edge computing, with models

The intelligence stays central and the compute moves to the machine on the desk. That is the analogy the
owner reaches for and it is a fair one: what is expensive and scarce (Opus judgement) is spent on
deciding, and what is cheap and local (a resident 7B, a CPU, a disk) is spent on doing. The economics
only work if the deciding is *much* smaller than the doing — which is a constraint on the design, not a
hope. See "What this rules out".

**Not every desk has the room.** A machine with 16 GB or less cannot host a 7B beside a normal working
set (ADR-0009, measured). On those machines the worker is **Haiku**, reached over the API, doing exactly
the same small pieces behind exactly the same gate (ADR-0045). The contract does not change; what changes
is that the zero-worker-tokens guarantee does not hold there, and `BatchResult` records which tier ran so
that nobody has to remember. The analogy survives: the compute moves to the cheapest place that can do
the work, and on a 16 GB laptop that is the cheapest model, not the local one.

**The measure, in the owner's words (16 Sep 2026):**

> All I want is to use the edge computing capacity — maybe in future with multiple agents, if it helps —
> to improve what happens when users use Claude Opus on its own: fewer tokens, faster, more precise.

Three goals, and how each is served — because "faster" in particular has to be said carefully:

- **Fewer tokens.** Workers cost zero on the local tier; Opus spends on deciding and on reading survivors.
  The next lever is Opus reading less: local models find the locations, a machine confirms they exist,
  and Opus reads only those (`BACKLOG.md` § *The edge ideas*, item 1).
- **Faster.** Not per unit — see "What this rules out". Faster as the user feels it: N tasks in parallel
  against a free gate, work that happens while Opus is not there, and a deterministic cache so nothing is
  generated twice (items 3 and 4).
- **More precise.** The gate, first and always. Then a 7B that learns from its own verified output on
  this repository (item 2), and two models disagreeing as a reason to look closer (item 6).

More agents are not a goal. A role earns its place by removing Opus tokens; the design has two, and the
only third one on the list is the reader in item 1.

## Why the quality claim is not a wish

Everything in this repo exists to make "the same quality as Opus" a checkable statement rather than a
marketing one. The mechanism is always the same and it is the only real idea here:

> **A local model's output is never trusted. It is admitted only by a gate that a machine can run, and
> Claude only ever sees what got through.**

For workload #1 (unit tests) that gate is `compiles ∧ passes ∧ kills ≥ 1 mutant ∧ non-tautological`
(CLAUDE.md #2). Six real-world trials were spent making that gate honest, and the most important thing
any of them found was a case where it **silently was not** (ADR-0037): a candidate that did not compile
was scored a survivor. That is the failure mode this whole architecture has to be paranoid about, because
a gate that passes quietly turns "same quality as Opus" into a lie that nothing detects.

So the unit of progress towards this vision is **not** "more workloads". It is **one honest gate per
workload**, and a workload with no mechanical gate does not belong in sidecrew at any price.

## The three kinds of work, in order of how well this works

| | the work | the oracle | status |
|---|---|---|---|
| **#1** | write a unit test for an existing function | mutation testing — ADR-0016 | **built and measured** on real projects |
| **#2a** | behaviour-preserving change: type errors, lint, renames, null guards, API migrations, dead code | **the project's own test suite + `tsc`** — free, exact, already written by the user | **built, not yet measured** — `sidecrew fix`, Phase 10; the number is Phase 11's, against a rule frozen first |
| **#2b** | behaviour-changing change: implement this, fix this bug | nothing in the repo knows the answer; Claude has to write the spec | after 2a, and not cheaply — ADR-0031 options B/C |

**The owner's own example — "fix all the TypeScript errors in a large codebase" — is #2a**, and it is the
best-fitting workload in the entire design. The gate costs nothing because the user already wrote it. The
planning is cheap because there are no shapes, no exemplars, no per-function specification. And it is
exactly the kind of large, boring, parallel job that a resident local model should be doing while Claude
does something else. A major refactor is #2a too, as long as the suite is meant to stay green through it.

### Why 2b is genuinely harder, stated now so it is not a surprise later

When there is no oracle, Claude has to write one — which in practice means writing the tests first (the
owner's own TDD-inversion idea). Two things then go wrong at once, both already written up in ADR-0031:

1. **The economics invert.** Planning already costs 120–145k Opus tokens for 8–14 units, and that is only
   choosing *shapes*. Writing a full specification per unit costs more than writing the small
   implementation would have.
2. **Goodhart flips the wrong way** (ADR-0006). Today the cheapest way for a worker to pass the gate is a
   tautological test, and the gate throws it away — the damage is a wasted verdict. With implementations,
   the cheapest way to pass a visible test is `if (x === 3) return 7`, and **that ships**. The known
   countermeasure is held-out tests, which doubles the expensive half.

2b is in the vision. It is not the next thing, and no number from #1 or #2a will say anything about it.

## What has to be built that does not exist

Most of the machine transfers — the contract (`WorkerTask → Candidate → Verdict → BatchResult`),
determinism, the zero-worker-tokens guarantee enforced in `schemas.ts`, the memory gate, the queue,
thermal back-off, the retry rule, the escalation queue, review routing. All of it is about *outcomes*
rather than about what the outcome is made of. So is six trials' worth of knowledge about real projects:
sandboxing, monorepos, pnpm, ts-jest, module resolution.

Seven things did not. **The first four were the gate side and Phase 10 built them** (16 Sep 2026,
ADR-0046 through ADR-0048); the next three are the management side — the half of the vision the owner's
worked example is mostly about — and they are ADR-0044. Each is left here with what it turned into,
because the argument for why it did not transfer is the reason the answer looks the way it does:

- **The sandbox keeps the project's tests — built, ADR-0046.** ADR-0004 deletes them, on purpose, because
  a mutant killed by a pre-existing test is not evidence about the candidate. For #2a the existing suite
  **is** the gate. The opposite rule, and a design change rather than a flag — and ADR-0004 turned out not
  to be wrong: its rule is *"the sandbox contains nothing that could satisfy the gate except the
  candidate"*, which says delete when a test is the confound and keep when a test is the instrument. What
  makes keeping them safe is the **baseline**, captured before the change in the same sandbox: *every test
  that passed before still passes*, never *everything is green*.
- **A verdict that is not mutation-shaped — built, ADR-0047 §3.** `ChangeVerdict` says which `tsc` errors
  are left in which file, which files gained one, which tests regressed by name, and which confinement
  rule the diff broke. It is designed for a reader who arrives two phases later: ADR-0044 §4's correction
  round writes its note from the **verdict** and never from the candidate's diff, which is the line
  between "Opus corrects a worker" and "Opus reviews everything".
- **The diff is the artefact, not a file — built, ADR-0047 §2.** Workload #1's worker writes a whole new
  file that nothing had before; a code change touches something that exists, so what a worker returns was
  a contract question rather than an implementation detail. It returns **whole files** and sidecrew
  derives the change itself. A 7B emitting correct `@@` hunk headers against code it is reading for the
  first time fails in a way that says nothing about whether it understood the change, and it adds a whole
  stage — *the patch did not apply* — for a verdict to represent. Deriving it buys the property the gate
  needs most: **confinement is decidable before a byte is written**, because it is a pure function of the
  task's sources and the candidate's. The gate then judges **the change** — confined, compiles, suite
  still green — and the unified diff it writes to the run directory is what a reviewer reads; nothing
  gates on that text, so no verdict depends on which alignment a diff algorithm happened to pick
  (ADR-0048).
- **A task that is a group of files, not a function — built, ADR-0044 §1.** Workload #1's task is one
  function × one shape; the owner's picture is one worker per 5–10 related files. The group is the
  dispatch unit *and* what the gate judges, with the `tsc` error count recorded **per file** so per-file
  reporting costs no extra verifier run. `max_group_size` is a plan field with a default of 10, never a
  constant, because the right number is what Phase 11 measures.
- **Ordered steps — built, ADR-0044 §2.** A refactor has waves — rename the type, then fix the call sites
  — and step N+1's baseline is the project after step N. `ChangePlan.steps` is ordered, tasks inside a
  step run in parallel, and the run applies that step's survivors and re-captures the baseline at the
  boundary without waiting for Opus.
- **A planner for code changes.** There is a test planner that decomposes by function and shape. Nothing
  turns "refactor the whole project" into grouped, ordered tasks. That is Opus's job in the vision and
  it has no spec. ADR-0044 §1–2, Phase 12.
- **Workers that can be corrected, and that can say something.** Today a worker is one-shot: one request,
  one candidate, one retry carrying the compiler's own words, then escalation — where Claude does the
  work *itself* rather than telling the worker what was wrong. "If not, gives it the prompt to fix it" is
  a real addition and it has a tension in it — every correction Claude writes costs the tokens this whole
  design exists to save, so it needs a budget and a measurement, not a chat loop. "Communicate when they
  need to" is the other direction, and the likely answer there is still that workers do not chat: they
  **escalate**, structurally and in batches, which is what `escalations.jsonl` and `sidecrew escalate`
  already do. ADR-0044 §4, Phase 12.

## What this rules out

Said plainly, because a vision that rules nothing out is a slogan:

- **No workload without a mechanical gate.** If a machine cannot decide whether the work is right, sidecrew
  does not farm it out. "Claude reads it and it looks fine" is not a gate.
- **No unsupervised merging.** Claude approves. The gate decides what Claude is allowed to *see*, not what
  ships.
- **No unbounded conversation with a worker.** A correction round is a bounded number of Opus-written
  notes per task against a per-run budget, and it is fed by the gate's report, never by raw worker output
  (non-negotiable #3). If corrected attempts do not survive often enough to pay for themselves, the round
  is switched off and the task escalates, as today.
- **No claim of being faster than Opus per unit.** Measured: the generate stage is 6–17 s while
  verification is 70–80 % of a candidate's cost. The win is **throughput and token cost** — N workers
  grinding in parallel against a free gate — not latency. A claim of speed invites a benchmark we lose.
- **No pretending the local model is good.** It is not. Measured on unmodified real projects, roughly
  0.40 of planned tasks survive, and the funnel collapses at `pass` — candidates that compile and assert
  something untrue. The product is the gate; the local model is how the gate gets fed cheaply.

## What "ready to publish" means

The owner's call, 16 Sep 2026: **sidecrew goes public when it does the vision, not before.** A tool that
only writes unit tests is a waypoint and would be published as a final product, which is not what it is.
Later the same day, the bar in the owner's words:

> Everything should be published when what I proposed works properly and people can use it on their code
> base with no problem.

"Works properly" is the worked example above running end to end, with the correction round of ADR-0044 in
it. "People can use it on their code base" means all of the following, and each is a definition-of-done
line in Phase 14 rather than a sentiment:

- it has run on **unmodified** real projects, on both stacks sidecrew supports, and the number it prints
  is one a frozen decision rule (Phase 11) produced rather than one chosen during construction;
- it has run on **both tiers** — the local 7B and Haiku on a 16 GB machine (Phase 13) — because a tool
  that cannot run on half the laptops is not one people can use;
- every failure a user would hit on a project sidecrew has not seen before is either fixed or named by
  `doctor` with its remedy, in the shape ADR-0032 set: the cause, whose fault it is, and the exact fix;
- it does not need the user to change their project to be verified. Six trials say this is the hard part.

Workload #2a is the first form of that sentence that is true, and it is the gate for Phase 10. Publication
is Phase 14, behind Phases 10–13. Workload #2b (Phase 15) is in the vision and behind publish.
