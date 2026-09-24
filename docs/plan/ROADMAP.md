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

## What to do next, in order — decided 20 Sep 2026, **state refreshed 21 Sep**

*The owner's call: publish 14 if nothing gates it, then take the rest in this order. The goal is
restated in their words — **"be able to achieve what Opus does, our way; even 90 % is a win."***

### 0. Phase 14 — publish. **Three things gate it, and two are small**

| gate | state |
|---|---|
| `deriveLineRange` reads the TypeScript AST | **closed** — ADR-0076, on `main`. The regex missed 152 of 436 declarations in our own `src` and got 5 wrong |
| `doctor` learns the pre-flight questions | **closed** — five rows, including `jest ok` on a suite that collects zero tests |
| ADR-0042 — name a self-contradicting candidate | **closed** — option 1, on `main` |
| README numbers vs the gate's own error rate | **closed** — every rate is `k/n` with an exact Clopper–Pearson interval and `D` beside it, which satisfies §4.3's UNACCEPTABLE clause rather than amending it |
| CI green | **closed 20 Sep** — red since 18 Sep on three causes, all fixed. `release.yml`'s gate runs `npm test`, so this blocked the release outright |
| the release itself | **OPEN, owner's, and the order is forced** — **hand-publish `0.1.0` first**, because Trusted Publishing cannot be configured for a package that does not exist (measured 21 Sep: `npm trust` takes the 2FA code and *then* 404s). Then Trusted Publishing, then the `v0.1.0` tag. **Pages is done**; the version places are already at `0.1.0` |
| ~~both tiers~~ | **closed** — ADR-0073 descoped it |
| ~~13b item 1 before publish~~ | **relaxed by the owner, 20 Sep** — it is now item 2 below rather than a publish gate |

**Nothing here was research, and it is all done but the release.** What remains needs an npm account
and a GitHub settings page, not a session.

### 1. The whole-file ceiling — ✅ **DONE, 24 Sep 2026, shipped in `v0.2.0`**

**Measured on project-a:** `Reach` **0.519 → 0.911** (14c), and one-declaration tasks survive **15/41
`[0.221, 0.531]` inside previously refused files against 10/42 `[0.121, 0.395]` in small ones** (14c′,
ADR-0086 §6 B), with no survivor making a file worse. The intervals overlap, so it is a direction. The
rest of this item is the reasoning it was built on, kept as written. **Retrieval, item 2, is next: Phase
14d, where `v1.0.0` is cut.**

*As planned, 20 Sep:* **ADR-0075 accepted (option C)** · the biggest single capability gain available

**Half of a real codebase is unaddressable, and it is the half the work is in** (3.3 % of files,
48.1 % of bytes; every 1000+ line file). That is the *return format*, not the model. Option C —
symbol-scoped return, splice by AST range — moves the boundary from *"the file is big"* to *"the
change is big"*.

It shares a prerequisite with Phase 14's DoD: **`deriveLineRange` on the AST** — **which landed as
ADR-0076**, so the prerequisite is paid and 14c can start directly.

### 2. Retrieval — the half of the vision that is not built

*"The local model scans the code, goes through several files, reports back; Opus says okay."* Its
target is measured: **68 % of planning cost is fixed and overwhelmingly Opus reading** — 15.5M cache
reads against 89k of output.

Needs its own ADR first, because its gate is weaker **in kind**: a machine confirms a symbol
**exists**, never that it is **relevant**, and ten confirmed-useless locations pass while saving
nothing. Then build, then measure against a rule frozen first — the number is the whole justification.

**ADR-0079 (proposed, 20 Sep) is the shape this takes, and it is the owner's own framing.** The loop:
*Opus plans a gathering session → workers report → **Opus asks the user** → Opus plans on the answer →
workers act → repeat until satisfied.* Two things it contributes:

- **A candidate answer to the relevance problem.** *"Opus asks the user"* is a relevance oracle that is
  neither a machine nor Opus. Existence → a machine; **relevance → the user, on a batched summary**;
  correctness → the gate. It does not make retrieval gateable alone; it makes the ungateable half
  somebody's rather than nobody's.
- **A first piece that needs no oracle at all.** *Recon-as-report* — *"your config reports 0 errors,
  `--strictNullChecks` reports 763 files; want to see them?"* — answers a question the user just asked,
  so relevance is not in doubt. Smallest useful piece, independently valuable, ships before the ADR.
  **It must not offer to fix what it counts until ADR-0077 is decided** (see item 3).

**The binding constraint on the whole loop:** the 68 % is a *fixed per-session* term. A loop that
re-plans `n` times risks paying it `n` times. Batched, one round trip per phase, never per task — *a
chatty loop is a more expensive Opus session with extra steps*, and `R` is the number that says so.

### 3. ~~Two probes on the editing ceiling~~ — **DONE, Phase 14b, 20 Sep. The answer was neither option.**

`S₁₄ = 2/30 = 0.067`, 95 % `[0.008, 0.221]` → **PROCEED to 14c** under the rule frozen beforehand.

**Both probes did what they were built to do and neither converted into survival.** The 14B cut
"returned the file unchanged" from 17 tasks to 3; narrowing the ask to one function cut it to 10. So
neither model size nor task size was the binding constraint.

**The limit is the gate's scope** (ADR-0077). Every extra target a worker fixes correctly becomes an
*unsatisfiable* task, one for one: +6 correct → +6 unsatisfiable, +9 → +9. The sinking error is in a
**test file in 21 of 21** cases and in non-test source in **0** — the guard narrows a type, the type
propagates into fixtures, and tests may not be edited because tests *are* the gate. **It gets worse as
the worker improves** (unsatisfiable 12 → 18 → 21), so buying more worker capability on this shape
buys nothing measurable.

**What this leaves open, and it gates item 2's fix half:** ADR-0077's options A/B/C. **Option D is
accepted** — re-gate probe 1's 15 clean-target tasks with test-file *type* errors demoted to
observations, and count how many survive the suite. Candidates are on disk, **no worker, ~1 hour**.
That number decides whether recon-as-report may ever offer to fix what it counts.

### 4. Then, and only then, the ambition

`#2b` (behaviour-changing work) is the majority of what Opus does and is deliberately last: ADR-0031's
economics and its inverted Goodhart direction are both worse, and nothing measured in #1 or #2a says
anything about it.

**ADR-0082 (proposed, 21 Sep 2026) is the first thing that changes that sentence.** The owner's
proposal has **the worker** write a test to the *expected* behaviour before the change, which gives
#2b the oracle it has never had — a machine-checkable *"does the change do what was asked"*, with the
human approving a ten-line expectation instead of a diff. It moves both of ADR-0031's objections and
settles neither: the cost argument now turns on a number nobody has, and Goodhart is mitigated by
holding the test out from the change worker rather than eliminated.

**It does not promote #2b up this list.** What it adds is a **cheap measurement that would**:
ADR-0082's option D — the yield of asking a worker for tests that kill a mutant inside a named line
range. Workload #1's *untargeted* yield on real projects is 3/8, 4/8, 4/10, so the targeted number is
the one every version of this rests on and it is one short run away.

**On the 90 % bar, stated honestly.** Items 1 and 3 are what decide whether that number is reachable
at all. Today the tool does one shape of work well on half a codebase. Item 1 roughly doubles the
surface; item 3 says whether the local model can do more than one shape of work on it. Neither is a
promise, and both are cheap enough to find out.

---

## Capability against the philosophy — an honest assessment, 20 Sep 2026

*Written after Phase 12's four measurements, against the owner's own statement in `VISION.md`
(20 Sep 2026) rather than against a pitch. The point of measuring was to be able to write this.*

### The ambition, and what is actually true today

> *"Anything with the code that Opus does."*

| the work | measured | verdict |
|---|---|---|
| renames, unused imports | 19/19 and 15/19 on unmodified real projects; **byte-identical to Opus on 18 of 19** | **works** |
| null guards, under a stricter compiler | **1/30**, and **16 of 17** workers returned the file unchanged *again* after a note saying that returning it unchanged was the failure | **does not** |
| behaviour-changing work (#2b) | not started, deliberately (ADR-0031) | the majority of what Opus does |

The honest sentence is **"renames and dead imports, reliably; very little else yet."** That is a real
capability — it is exactly the boring, wide, parallel work worth farming out — and it is not *anything*.

### The economics currently run the wrong way at the sizes people try first

> *"Opus does the smart thingies, our local models do the heavy lifting."*

Workers cost **zero**. Coordination costs **8,400–22,100 Opus tokens per task**, and at a 12-task plan
that is **2.84×** what simply handing each task to a paid model would cost. Break-even is somewhere
near 40–50 tasks. So at small jobs **Opus is doing the smart work *and* paying more than the heavy
lifting saves.** The curve is strongly favourable with size; the first thing a new user tries is not.

### The half of the vision that is not built is the half the numbers point at

> *"The local model can scan the code, go through several files looking for something, report back to
> Opus; Opus says okay, let's do this."*

Nothing of this exists. And **68 % of planning cost is fixed, overwhelmingly Opus reading** — 15.5M
cache reads against 89k of output. It is the one term in the cost curve that does not amortise with
plan size.

### The finding that should reorder the work

The philosophy has two halves — *local models read* and *local models edit* — and Phase 12 measured
them differently.

- **The editing half is weaker than hoped, and it is a ceiling rather than a tuning problem.** Given a
  real file and asked for a null guard, the 7B mostly hands the file back unchanged. Not wrong code —
  *no* code. That is why the correction round bought nothing: there was no defect for a note to
  correct.
- **The reading half is untested and the bar is far lower.** Finding where something lives does not
  require writing correct TypeScript. It requires being tireless, which is precisely what a resident
  7B is, and a machine can check the answer cheaply.

> **The measurements argue that the owner's own example — *scan the code, read across files, report
> back* — is the half that works, and *the local model makes the change* is the half that is fragile.**

That inverts the current build order: the tool today is all editing and no reading.

**The caveat that keeps item 1 behind an ADR.** Its gate is weaker *in kind*. A machine can confirm a
symbol **exists**; it cannot confirm it is **relevant**. Ten confirmed, real, useless locations pass
the gate and save nothing — a different Goodhart shape from everywhere else here, where a cheap pass
produces a bad artefact the gate catches.

### Bluntly

The **architecture** matches the philosophy: the gate is real, it is measured, and it now has its own
error rate, which is more than most of this field can say. The **capability** matches it partially —
one shape of work reliably, one not at all, and the half that would fix the economics unbuilt.

Nothing measured says the idea is wrong. What it says is that **the next thing to build is the
reading, not more editing** — which is the owner's own sentence rather than a conclusion imposed on it.

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
- **It does not hold at every `N`, and the second denominator is now measured.** `R = 1.074` at
  `N = 41` — still FAIL, by 7 %, and on a run that was biased *towards* passing (the planner was
  handed two facts the first had to discover). `P_total` grew **1.29× for 3.42× the tasks**, so
  planning is a large fixed cost plus a small per-task one: `F ≈ 233,500` and `v ≈ 2,700`, with the
  fixed term **88 % of the cost at `N = 12` and still 68 % at `N = 41`**.
- **It is measured against the conservative bound** (`W_upper`, which carries the Agent tool's own
  harness overhead). Using the flattering bound would have improved the ratio and §3 forbids it.

**It also settles 13b item 1 in the affirmative, and now gives it a target rather than a premise.**
Planning is expensive and it is mostly Opus *reading* — 15.5M cache reads against 89k of output on the
larger arm. Item 1 attacks the **fixed** term, which is the one part of the curve that does not
amortise on its own. Unblocked, behind its own ADR.

**The sentence the curve makes available, which one denominator could not:**

> Coordination is not worth paying on a dozen tasks, and the economics move sharply in sidecrew's
> favour as the job gets bigger.

That is what the FAIL actually means. A lone `P` at `N = 12` would have supported a harsher and less
true claim — precisely the error §4.4 was written to prevent.

The measurement no longer needs a dedicated session: `planner-tokens.mjs` can read a subagent
transcript, which is a clean window by construction. The three defects that made the old instrument
unusable are in that file's 19 Sep amendment.

Phase 11 had measured the *doing* side completely — generate 13.5 s at **zero** worker tokens, gate
262 s, 95 % of a candidate's cost in a gate that is free and local — and the *deciding* side was a
blank, because the plans were hand-written. Both halves now have a number.

So the claim stops being *"the work is free"* and becomes **"the doing is free and the coordination
is not"**, which is a worse headline and a far more useful one. The honest form of the sentence, at
the only plan size measured:

> At `N = 12`, sidecrew moves the cost from the workers to the planner and does not reduce it — and
> at `N = 41` it very nearly breaks even.

On the two-point line, `R ≤ 1` arrives near `N ≈ 46` and `R ≤ 0.5` near `N ≈ 191`. **Two points is an
interpolation dressed as a model**, and one of them is biased low, so those are the shape of the
answer rather than the answer. A third denominator, planned from scratch, is what would make them
numbers anyone could plan against.

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
7. ~~**A 16 GB machine cannot run sidecrew at all.**~~ → **Descoped by the owner, 20 Sep 2026
   (ADR-0073).** It was built (Phase 13) and then judged out of scope rather than unfinished:
   **sidecrew is a 24 GB+ tool.** Below the floor it now refuses with the machine's RAM, the floor and
   the reason, instead of quietly handing the user a different worker with a different cost model and
   no measured survival rate. The client survives behind `SIDECREW_TIER=api`, unsupported. Phase 13 §5
   is cancelled and publication no longer waits on it. *One supported configuration is a smaller and
   more defensible product than two, one of which was never measured.*

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
  and nothing measured in #1 or #2a says anything about it. **ADR-0082 (proposed) gives it a candidate
  oracle and a short measurement that would price it** — that changes what is *knowable* about #2b, not
  its position here. It stays not-next until option D has a number.
- **More languages.** Python and Kotlin multiply the surface before the shape is proven.
- **More agents.** `VISION.md`: a role earns its place by removing Opus tokens. None currently does.
