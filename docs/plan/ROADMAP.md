# Roadmap — prioritised by what this project is for

**Owner's statement, 18 Sep 2026**, and it reorders everything below it:

> What matters to me is science and the scientific edge of this project. In the scientific part we
> produce measurements, experiment results, numbers, articles, ideas and philosophy. […] And a tool
> that can be used by regular coders in my company — where people are impressed by the improvement
> they see over using Opus or Sonnet without this tool. Improvements in performance, precision, and
> token usage. **If performance and precision increase with the same token usage it's still a win.**

Two products, not one, and they are ranked in that order. `VISION.md` is still the destination;
this file is what to do next and why, and `PHASES.md` remains the route.

**"Edge computing" is a metaphor for one property — the compute moves to the cheapest place that can
do the work — and not the thesis.** The thesis is that *a mechanical gate lets a weak model be
trusted with work it could not otherwise be trusted with, and the gate is what makes the claim
checkable.* Don't let the label narrow the framing.

---

## The gap that outranks everything

**Nothing here has ever been compared against just asking Opus.**

Every number in this repository compares a 7B against Haiku **inside** sidecrew, behind the same
gate. That answers "which worker", and it is the wrong axis for the second product. The question a
colleague asks is *"is this better than what I do now?"*, and "what I do now" is asking Opus or
Sonnet directly, in Claude Code, with no gate.

Until that comparison exists there is no defensible claim of improvement over the status quo — only
a claim about the inside of the tool. **This is experiment #1 below**, and it is also the strongest
thing the scientific half could publish, because nobody runs it: the literature compares models, not
*model + verification harness* against *model alone*.

---

## The caveat that now has a number — and it applies to every rate below

**Measured 19 Sep 2026: `D = 2/19 = 0.105`.** Replaying a frontier model's own diffs — which the gate
finds no defect in — through the gate a second time, it disagreed with itself on 2 of 19 candidates.
`experiments/gate-error-rate/README.md`, against a rule frozen before the first replay.

Three things to carry, in this order:

1. **It is an order of magnitude, not a point.** At 19 pairs one disagreement either way moves `D`
   between 0.053 and 0.158, across two of the three decision bands. Never quote `0.105` bare.
2. **The safety property is untouched.** `D` measures the gate **refusing changes that were fine**.
   Nothing measured here is evidence of the gate *admitting* something it should not, and this corpus
   cannot produce such evidence. *The gate admits nothing that fails* still stands; *it refuses only
   things that fail* is now measured false at roughly one in ten.
3. **So no survival rate in this repository may be published as a point estimate** until the cause is
   diagnosed — Phase 11's and Phase 11b's included. They were always described as lower bounds of
   unknown tightness; the tightness is now known to about a factor this large.

Neither diagnosed cause explains it: both disagreements happened at pressure normal with swap flat or
falling (not ADR-0066) and on the same calendar day as their baseline (not ADR-0069). The one lead is
that **every verdict on disk recording a regression has all of its regressed tests inside a single
suite file** — six for six, across two orders of magnitude of count — which points at a suite-level
failure rather than a test-level one. It discriminates nothing yet: there is no true `tests`-stage
negative in the corpus to contrast against.

---

## Priority 1 — the two measurements that turn a tool into a result

### 1.1 Head-to-head against the status quo · **the highest-value thing left**

The frozen-rule discipline applies: **write the decision rule before any number exists.**

Three arms on the same tasks, on unmodified real projects:

| arm | what it is | what it costs |
|---|---|---|
| **A** | Opus alone, in Claude Code, no gate — "what I do now" | Opus tokens, all of it |
| **B** | Sonnet alone, no gate | Sonnet tokens |
| **C** | sidecrew: local 7B behind the gate, Opus plans and reviews survivors | planning + review only; workers are free |

Measured per arm, per project: **precision** (the blind approval rate — the same `A(x)` §4.1 already
defines, reviewer blind to arm), **tokens** (split planning / doing / review), **wall clock**, and
**defects reaching the human** (changes accepted that a reviewer would not have).

The owner's bar makes the success condition unusually clean, and it should be frozen in those words:
*equal precision at lower token cost is a win; higher precision at equal token cost is also a win.*
Only **lower precision** loses.

Honest risk, stated up front: on the 2a tasks measured so far, Opus alone will very likely match or
beat C on precision. The interesting quantity is therefore **the price of that precision**, and
whether the gap survives at 100 tasks rather than 12 — which is where a human's attention, not the
model's ability, becomes the binding constraint. Say so in the rule before running it.

### 1.2 The cost of deciding · closes the economics

**Status 19 Sep 2026: measured, and it FAILS its own frozen rule.** `R = 2.84` at `N = 12` —
planning cost **265,607** new Opus tokens for a validated 12-task plan, so **22,134 tokens per task
planned** against a paid worker's 7,794. §4.3's verdict at `R > 1.0` is FAIL: *the design's economics
do not work at this plan size, and the phase reports that in as many words rather than looking for a
plan size where they do.*

Three things that verdict does **not** mean, said here because this is the file people read first:

- **It is not a verdict on the doing side.** Workers remain free on the local tier and the gate
  remains 95 % of a candidate's cost. What is expensive is the *deciding*, which is the half nobody
  had measured.
- **It holds at `N = 12` and no other `N`** (§4.4). Planning cost is not linear in tasks — a module
  read once serves twelve tasks or forty — and the `N ≈ 40` arm has not been run. That arm is now the
  single most valuable measurement left, because it is the one thing that can move this number.
- **It is measured against the conservative bound** (`W_upper`, which carries the Agent tool's own
  harness overhead). Using the flattering bound would have improved the ratio and §3 forbids it.

**It also settles 13b item 1 in the affirmative**: planning is expensive and it is mostly Opus
reading — 6.3M cache reads against 65k of output. *"Local models read the codebase so Opus does not
have to"* is aimed at exactly this number and is unblocked, behind its own ADR.

The measurement no longer needs a dedicated session: `planner-tokens.mjs` can read a subagent
transcript, which is a clean window by construction. The three defects that made the old instrument
unusable are in that file's 19 Sep amendment.

Phase 11 had measured the *doing* side completely — generate 13.5 s at **zero** worker tokens, gate
262 s, 95 % of a candidate's cost in a gate that is free and local — and the *deciding* side was a
blank, because the plans were hand-written. Both halves now have a number.

So the claim stops being *"the work is free"* and becomes **"the doing is free and the coordination
is not"**, which is a worse headline and a far more useful one. The honest form of the sentence, at
the only plan size measured:

> At `N = 12`, sidecrew moves the cost from the workers to the planner and does not reduce it.

Whether that survives at `N ≈ 40` is unmeasured and is the next thing to run.

---

### 1.3 The correction round — measured, and it does not pay

**20 Sep 2026: `S_c = 0/29` → OFF BY DEFAULT.** `experiments/correction-round/`, against a §4 frozen
before the round existed. It ships switched off and the tail escalates, as ADR-0044 §4 rule 2 said it
would if the number came out this way.

The useful part is underneath the verdict. **27 of 29 corrected attempts reached exactly the same
gate stage as the free mechanical retry**, and in the clean subset **16 of 17 workers returned the
file byte-identical again** after a note saying that returning it unchanged was the failure. So the
binding constraint on `null_guard` work is not the quality of the instruction — it is that the 7B
**does not attempt the change**. That is a different problem from the one the correction round was
built to solve, and no rewording is the lever for it.

It also puts a number on something `VISION.md` has always said carefully: *"no pretending the local
model is good."* On renames the 7B reached 0.40–1.00. On null guards, under a stricter compiler, it
reached **1/30** — and most of that gap is refusal to edit rather than bad edits.

---

## Priority 2 — writing, while the material is fresh

Three published so far: the frozen rule and the score it vetoed; the gate-reference taxonomy; and
the earlier workload-#1 notes.

- **The four workload-#1 notes are stale in one specific way.** They quote 0.85 without saying that
  unmodified real projects came in near 0.40 and that the fixture overstates by more than 2×. One
  correction paragraph each, or one note that supersedes them.
- **"A metric that saturates cannot rank anything"** — unwritten and, on reflection, the sharpest
  methodological result of Phase 11. Five of six cells at or above 0.917 made the decision rule's
  primary clauses inert, and the whole verdict fell to the clause added last and least confidently.
  Generalises to anyone choosing an eval metric.
- **The head-to-head (1.1), once it has numbers.** That is the note with an audience outside this
  project.

**Keep current as you go**: `README.md` leads with measured numbers (done for #2a), `PHASES.md`
carries the table, every number is labelled measured or estimated, and an article that quotes a
number carries its interval.

---

## Priority 3 — the tool, for people who are not us

Ranked by what stops a colleague using it, from six trials and Phase 11's six defects. **Items 1–4 were
done by Phase 12 on 18 Sep 2026**, and are kept with their outcomes because the reasons are the record:

1. ~~**`sidecrew fix` has no MCP tool and no skill wiring.**~~ **Done** — `sidecrew_fix`,
   `sidecrew_fix_plan_validate`, `sidecrew_fix_escalate`, and the skill's #2a section.
2. ~~**Nothing writes a change plan.**~~ **Done** — `claude/agents/change-planner.md`. Its most useful
   output turned out to be **refusal**, not planning: four kinds of task the gate could never pass.
3. ~~**ADR-0056**~~ — **`machine_failures` is in the contract**, with the spec updated in the same
   commit. A rate's denominator can now exclude what was never the worker's to answer.
4. ~~**ADR-0054**~~ — **settled by ADR-0057, and not the way this line expected.** The correction round
   could not be the cheaper answer, because a cosmetic edit *survives*: its verdict carries nothing to
   write a note from, and rule 1 forbids reading the diff. So ADR-0054 is **upstream** of that
   measurement rather than downstream. Decided: non-gating `observations` on the verdict, with the
   refusal options A and B still available if corrections turn out not to change the behaviour.
5. **ADR-0050** — **half done.** Refusing a plan whose task files carry a pre-existing error is built
   (`validateChangePlan`, Phase 12), which is the half that stops a run spending 262 s per attempt on a
   task no worker could pass. Cloning `node_modules` when TS2883 appears is still open.
6. **`doctor` learns what Phase 11 found**: the project's `engines.node` (ADR-0049, built), a large
   shared runner cache (ADR-0055), and the three pre-flight questions from workload #1.
7. ~~**A 16 GB machine cannot run sidecrew at all.**~~ **Built, 18 Sep 2026 (Phase 13)** — the `api`
   tier runs both workloads with `claude-haiku-4-5` as the worker behind the same gate, and `doctor`
   names the tier and why. **Its number does not exist**: Phase 13 §5 spends real money and was left
   for the owner, so the tier ships buildable and unpriced. ADR-0059 kept the one-runtime-dependency
   rule; ADR-0060 pinned the id and said plainly that the pin is weaker than a commit sha; ADR-0061
   decided the number is taken fresh on the current tool rather than against Phase 11's arms — which
   means **a same-commit local arm would remove the one caveat on it**, and Phase 11b is the phase that
   would produce one.
8. **ADR-0062 (PROPOSED)** — a refusal on a **single-file** task is swallowed by the bare-answer
   fallback, on both tiers. Phase 11 measured only single-file tasks, so Phase 12's refusal shape is
   inert in every configuration this repository has numbers for and `refusals: 0` is a constant. It
   bears directly on 1.1 and on Phase 11b, which reuse those plans; the options are in `DECISIONS.md`
   and it is the owner's call.

---

## Priority 4 — before any of it goes public

**The repository cannot be pushed as it stands.** Files contain a client's source verbatim or name
them: the #2a handshake quotes whole files three times over by construction, the mutant-probe artefacts
are generated tests encoding their business rules, and plans hold absolute paths into their checkout.
`origin/main` is clean and many commits behind; **nothing has leaked.**

**Count as of 18 Sep 2026: 47 tracked files**, down from ~54 — Phase 12 cleared the seven mentions in
`src/` and `docs/specs/` and renamed the two recon notes, because a `git diff` surfaced the client on a
context line of a contract file. That is *not* progress on this item. The rest is the
`experiments/go-no-go-2a/c3/` prompts and answers, which quote whole client files by construction, and
it needs the allowlist rebuild rather than more `sed`.

CLAUDE.md #7 is the rule. The scrub is an allowlist rebuild, not a search-and-remove — a denylist
that misses one blob has failed completely while appearing to work.

**The bundle this line used to promise did not exist. It does now** — 18 Sep 2026:

```
~/sidecrew-history-backup/sidecrew-full-history-20260918-1650.bundle    1.6 MB
```

Verified by **restoring it**, not by `git bundle verify`, which only proves a bundle is internally
consistent: cloned into a scratch directory and compared — `HEAD a4d2232`, 102 commits, matching the
original on both. Kept outside the repo so a rewrite cannot reach it.

This matters more than a housekeeping note. The scrub rewrites **31 of 102 commits**, and the line
above was the only thing standing between that operation and irreversibility. Anyone re-reading this
before a rewrite should re-verify by restore rather than trust the path: a bundle that exists and does
not restore is the same failure as a guard wired into one call site (ADR-0066), in a place where there
is no second chance.

**Measured 18 Sep 2026, so the size of the job is known rather than estimated:** 44 tracked files name
the client, 31 of 102 commits touch that string, and `origin/main` is 84 commits behind and clean —
**nothing has leaked.** The bulk is concentrated: 15 files in `experiments/real-world/results`, 6 in
`experiments/mutant-probe`. The mutant-probe artefacts are the hardest of these, because they are
generated tests encoding the client's business rules and remain client IP with the name stripped.

---

## What is explicitly not next

- **Workload #2b** (behaviour-changing). ADR-0031's economics and Goodhart direction are both worse,
  and nothing measured in #1 or #2a says anything about it.
- **More languages.** Python and Kotlin multiply the surface before the shape is proven.
- **More agents.** `VISION.md`: a role earns its place by removing Opus tokens. None currently does.
