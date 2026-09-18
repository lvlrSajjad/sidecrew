# Phase 11b — sidecrew against not using sidecrew, on project-a

**Measured 18 September 2026.** Protocol frozen at `../README.md` §4, written before any arm ran.
Verdict **WITHHELD** under §4.4, declared before the first arm and confirmed by the measurement.

§4 forbids pooling, so this half of the report is **project-a only** — an unmodified commercial
Nest/jest codebase, 352 suites, 6,368 tests, 209 of which fail before anything is changed. project-b
ran on 18–19 September and has **its own section below**; the two are never combined, and the reason
is no longer merely procedural: the cost ordering between the two frontier models *reverses* between
them.

Arms C and D here ran the gate as it stood at `2e7aa1e`. project-b's ran `a4d2232`, after ADR-0067 and
ADR-0068 fixed two defects this phase found. That difference is recorded rather than smoothed over.

---

## The answer, in one table

Four arms, 19 hand-written rename tasks, identical inputs.

| arm | what it is | delivered | P(x) | worker tokens |
|---|---|---|---|---|
| **A** | Opus alone, no gate | 19 | 1.0 | 80,131 |
| **B** | Sonnet alone, no gate | 19 | 1.0 | 88,820 |
| **C** | **sidecrew** — local 7B behind the gate | **19/19 survived** | **1.0** | **0** |
| **D** | the gate applied to arm A's own diffs | 19/19 survived | 1.0 | 0 (A paid) |

**And the arms produced the same bytes.**

| comparison | byte-identical |
|---|---|
| Opus vs Sonnet | **19 / 19** |
| Opus vs the local 7B | **18 / 19** |

That is the result, and it is not a saturated metric. Phase 11's problem was that every cell sat at
the top of a rate and could rank nothing. This is a stronger and simpler statement: **on 18 of these
19 tasks there is only one artefact.** No reviewer, blind or otherwise, can distinguish arms that
emitted identical files.

---

## Why §4.2 is not applied, although it is satisfied

With every delivered change accepted, §4.2's first clause reads **WIN** — `P(C) >= P(A)` and
`T(C) < T(A)`. Both hold, and not marginally: equal precision at zero worker tokens against 80,131.

**§4.4 forbids evaluating §4.2 at all.** At least half the tasks must be null guards, API migrations
or dead-code removal; the shape mix is **19/19 `rename`**. So the verdict is WITHHELD.

That clause was written on a suspicion — that an all-rename task set would make a WIN meaningless —
and the measurement turned the suspicion into a demonstration. A task set on which two frontier models
and a 7B emit identical bytes cannot rank anything at all. A WIN computed over it would say only that
sidecrew is competitive on changes admitting one correct answer, which nobody doubted.

**What this phase does claim**, which is narrower and holds:

> On fully-determined single-symbol renames in a commercial Nest codebase, a local 7B behind a
> mechanical gate produced output byte-identical to Opus on 18 of 19 tasks, at zero worker tokens, and
> every delivered change was accepted on review.

---

## The one divergence, and the judgement it needed

Ask: *rename a symbol, update every reference, **change nothing else***. Opus renamed the symbol. The
7B renamed the symbol **and** updated the function's doc comment so the prose matched the new name.

The owner judged it **acceptable**: the rename made the comment describe a name that no longer
existed, so updating it completes the ask rather than exceeding it.

**Phase 11's blind reviewer judged the same behaviour, by the same model, on the same word, a
defect** — and that single rejection drove `A(C2)` to 0.900 against a 0.900 bar, leaving that phase's
GO with zero margin.

Neither judgement is wrong, and that is the finding: **`P(x)` has reviewer variance on exactly the
behaviour that distinguishes the local tier.** Had Phase 11's reviewer leaned the other way its margin
would have been comfortable rather than nil. Before `P(x)` is used as a veto again, the disputed class
needs more than one judgement, or it is measuring the reviewer.

**Blindness, stated rather than claimed.** §4.0 requires the reviewer be blind to the arm. This
session could not be: it ran the arms and found the divergence. It is largely moot — there is one
artefact on 18 of 19 tasks — but the judgement above is the owner's, recorded as non-blind, and it is
not `A(x)` as Phase 11 defined it.

---

## Cost

| | |
|---|---|
| generate (7B, local) | **15.9 s** median |
| gate (`tsc` + the project's own suite) | **255.0 s** median |
| worker tokens, arm C | **0** |
| marginal tokens, arm A / arm B | 80,131 / 88,820 |

**94 % of a candidate's cost is in a stage that is free and local.** Wall clock is reported and is
never a criterion (§4.1): the expensive stage is the project's own suite, and every gated arm pays it
identically.

**The cheaper model was not cheaper.** Sonnet cost **10.8 % more** than Opus for byte-identical
output. On fully-determined tasks in this harness, choosing the cheaper model buys nothing.

**Token calibration matters more than it sounds.** The agent harness's own overhead is ~90 % of a
subagent's reported total and the floor is **per model** — 47,927 (Opus), 53,420 (Sonnet), each
measured twice to a two-token spread. Uncorrected, arm A reads 990,744 instead of 80,131, a 12.4×
inflation; using Opus's floor for Sonnet would add a 2.3× error.

---

## Five defects, none visible in a summary statistic

Every one was found by reading an artefact. Not one would have shown up in a rate.

| | direction | status |
|---|---|---|
| **ADR-0066** — a memory-starved gate fails closed, and the false negative is indistinguishable from a real one | rejects good work | proposed |
| **ADR-0067** — the gate compared test *identity*, not counts, so a broken `test.each` case passed silently | **admits broken work** | fixed on `main` |
| **ADR-0068** — `observations` counted comment lines, so a reworded comment was invisible | missed the only case | fixed on `main` |
| **O8** — a second non-determinism source, on a quiet machine | rejects good work | open, undiagnosed |
| arm D's tier mismatch — a replay arm is neither `local` nor `api` | schema refused it, correctly | open |

**ADR-0066 is the one to carry.** A byte-identical candidate produced two different verdicts; the
failing one named 155 specific tests in one spec file with a confined diff and a clean compile, and
read exactly like a renamed runtime-resolved identifier. It was memory pressure. Reproduced across a
restart: four evaluations of the same bytes, one failure, and the failure is the one taken while the
machine was paging.

The guard for it already existed. `kern.memorystatus_vm_pressure_level` was identified in Phase 6 and
documented in ADR-0011, and it is wired into `serve.ts` and neither `fix.ts` nor `batch.ts`. **Not a
missing guard — an unfinished one**, which is worse, because a guard that exists stops anyone looking.

**O8 says ADR-0066 is not the whole story.** Arm D's `multi-06` failed with 12 regressions and
survived the retry on identical bytes, with the machine at its quietest reading of the day. So there
are **two independent sources of false negatives and only one is understood.** Every survival rate in
this repository is a lower bound of unknown tightness, and the mechanical retry is currently the only
thing between those sources and the reported number.

---

## What the discipline bought, concretely

- **A frozen §4.4 stopped a WIN the numbers supported.** Written on a hunch, vindicated by
  measurement.
- **A recorded prediction was falsified and that was the point.** O2 named a pressure false negative
  as the first hypothesis for any arm-D rejection and required it be *tested*. It was, and it did not
  hold — which is how O8 was found rather than mislabelled.
- **A pinned worktree insulated the experiment from its own repository.** The gate changed on `main`
  mid-run, twice, and could not reach arms C or D. Verified at launch by commit, `src` cleanliness and
  `dist` md5 rather than by anyone remembering.
- **Restarting rather than resuming cost four tasks and was right.** Resume reuses any *terminal*
  verdict, and a false negative is perfectly terminal.

---

## Not measured, and it should be said plainly

- **project-b.** Not run. Its configuration differs in a way ADR-0064 says matters (`strict: true`),
  so it may not behave like this at all.
- **The harder task shapes.** Zero null guards, API migrations or dead-code removal. This is the
  binding constraint on every verdict here, and ADR-0063 is the route to generating them.
- **Per-candidate conformance to the post-ADR-0067 gate.** Arms C and D ran the lenient gate. The
  *combined* final state satisfies the stricter clause on disk (`6159 >= 6159`, `combined_regressions
  0`), so the residue is per-candidate isolation — and O8 means the count clause's no-drift assumption
  is qualified rather than clean.
- **Any refusal rate.** `refusals: 0` across 19 tasks; §5's worker-quality denominator
  (`tasks - survived - refusals - machine_failures`) is **zero**. Nothing reached the gate and failed
  it, so there is no failure population to characterise.
- **Phase 11's numbers under the stricter gate.** Its run directories are gone and its partials carry
  no baseline, so the cheap check is unavailable there. `12/12` and `11/12` remain "measured under the
  gate as it stood".

---

## What I would tell someone reading this cold

The headline is not that sidecrew won. The verdict is withheld and the honest claim is narrow.

The headline is that **a 7B running locally, for free, produced the same bytes as Opus on 18 of 19
real tasks in a commercial codebase** — and that the interesting question is therefore not *which
model*, but *which tasks*. On work that admits one correct answer, model choice is a cost decision and
nothing else. Whether that survives contact with null guards and API migrations is the experiment this
one could not run, and it is the next thing worth doing.

The second headline is for anyone who builds a verification gate: **two of the five defects here make
the gate wrong in ways its own output cannot express.** A gate that rejects good work names the tests
it thinks broke. A gate that admits broken work says `survived`. Neither has a field for *"and I may
be wrong about that."*

---

# project-b, and what a second project changed

**Measured 18–19 September 2026.** Unmodified commercial React/jest codebase: 772 suites, 8,795
tests, 2,867 source files, 7 pre-existing failures. Same four arms, 19 tasks mirroring project-a's
shape mix so the projects are comparable task-for-task. Arms C and D ran the **post-ADR-0067 gate**
(`a4d2232`) where project-a's ran `2e7aa1e` — recorded rather than smoothed over.

## The cells

| arm | delivered | survived | worker tokens | changed lines |
|---|---|---|---|---|
| **A** Opus alone | 19 | — (ungated) | 95,335 | 123 |
| **B** Sonnet alone | 19 | — (ungated) | 88,680 | 118 |
| **C** sidecrew | 19 | **15/19** | **0** | — |
| **D** gate on A's diffs | 19 | **18/19** | 0 (A paid) | — |

**This is the first non-saturated survival rate the project has produced.** `S(C) = 15/19 = 0.789`,
95 % CI `[0.544, 0.939]`. Every previous cell in every phase sat at or near 1.0 and could rank
nothing.

## Why project-b was worth more than project-a

project-a's 19 tasks were fully determinate — three different models emitted **identical bytes** on 18
of them. Nothing could be distinguished because there was nothing to distinguish. project-b has files
where several symbols share a prefix, and a codebase that enforces its own formatting, and both turn
out to matter:

**1. The arms stop agreeing.** Opus and Sonnet differ on 2 of 26 files, and both differences are
formatting: the longer symbol name crosses an 80-column `prettier` limit the project enforces as an
**error**, Opus reflowed, Sonnet did not. *"Change nothing else"* is not satisfiable here, and each
model resolved the conflict differently unasked. The gate cannot see any of it.

**2. The cost ordering reverses.** Opus was 10.8 % cheaper than Sonnet on project-a and **7.0 % dearer**
on project-b, because Opus explores more — repo-wide greps, the formatting judgement above. *Which
model is cheaper is a property of the model and the codebase together*, and a single-project
measurement reports the wrong sign. This is the first measured reason §4 forbids pooling.

**3. The worker finally fails, and diagnosably.**

| task | stage | what the 7B did | worker's fault? |
|---|---|---|---|
| `rename-02` | compile | renamed **7 sibling symbols** sharing a prefix; asked for 1 | **yes** — 5 errors in 4 files |
| `multi-04` | compile | renamed a type from an unseen file, a module path, **and a public property key** | **yes** — **122 errors** |
| `multi-06` | confinement | renamed **the file**, emitting a path that does not exist | **yes** — `path_outside_task` |
| `multi-02` | compile | nothing wrong — **byte-identical to Opus's diff** | **no** |

One mechanism explains all three real failures: **the 7B substitutes text where a frontier model
renames a symbol.** It cannot tell a symbol from a module path, a property key, or a type declared
elsewhere. Both frontier arms named those exact traps in their own reports and avoided them.

## Arm D, and the thesis test

Arm D replays arm A's diffs through the same gate, holding the model fixed and varying only the gate.
**19/19 on project-a, 18/19 on project-b.**

**The gate found no defect in a frontier model's output.** Its single project-b rejection is
`multi-02`, which it rejects from both arms identically. So on this workload the gate does **not**
improve on Opus — §4.3's recorded prediction was that arm D would be where the thesis showed, and the
honest result is that it did not. The gate's value is not that it second-guesses an expensive model.
**Its value is that it makes a free one usable.**

**And it is the instrument that separates worker defects from project defects.** Three of arm C's four
failures vanish when Opus writes the diff; one reproduces exactly. Worker-attributable survival is
**15/18 = 0.833** `[0.586, 0.964]`, not 15/19. Without the control the 7B carries a third more blame
than it earned.

Three predictions were written into `../README.md` (O14, O15) **before arm D reached those tasks**, and
all three held: `multi-02` must fail with the same errors, `multi-04` and `multi-06` must survive.

## What it cost to get these numbers

Three false-negative sources surfaced, only one understood, and **the mechanical retry rescued none of
the real defects** — all four retry candidates were byte-identical to their first attempt, because
temperature 0 and an identical prompt produce an identical answer:

- **ADR-0066** — memory pressure; a starved gate fails closed and the verdict cannot say so;
- **README O8** — a quiet machine, 12 regressions, gone on retry, still undiagnosed;
- **ADR-0069** — the baseline crossed midnight, a date-dependent test flipped on *unmodified* code, and
  from that moment every candidate inherited the regression. One stale baseline converts into a total
  run failure, not an occasional one. Arm D was discarded at 10/19 and restarted on a same-day
  baseline; the retry cannot rescue this class.

**So every survival rate here remains a lower bound of unknown tightness**, and measuring that
tightness — running known-good candidates through the gate repeatedly and counting disagreements — is
the most valuable experiment left. It is written up in `docs/plan/BACKLOG.md`.

## Verdict

**WITHHELD**, per §4.4, on both projects. The shape mix is 19/19 `rename`; the rule requires at least
half to be null guards, API migrations or dead-code removal before §4.2 may be applied at all. On
project-a §4.2's WIN condition is satisfied and deliberately not applied.

What the phase supports, stated narrowly enough to defend:

> On changes a compiler and a test suite can check, a local 7B produced output **byte-identical to
> Opus on 18 of 19 tasks** in one commercial codebase at **zero worker tokens**; in a second, harder
> codebase it failed **3 of 18** attributable tasks, and every failure was caught mechanically, named
> precisely, and never applied.
