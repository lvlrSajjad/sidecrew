# The cost of deciding (Phase 12 §2.1)

**Question:** what does it cost Opus to *decide* what the workers should do, per task decided — and is
that much smaller than the doing, which is what `VISION.md`'s economics rest on?

This file is the **frozen artefact**. §4 below was written on 2026-09-18, during Phase 12, **before the
change planner existed and before any planning window had been marked**. `docs/plan/prompts/phase-12-management.md`
§2.1 is only how it got here.

**Do not edit §4.** If it turns out to be the wrong rule, append an amendment *below* it, dated, the way
ADR-0020 amended Phase 6's and Phase 11's REPORT amended its own — so the run stays readable against the
rule that was in force when it ran.

## 1. Why no existing number answers it

Phase 11 measured the **doing** side completely: generate 13.5 s at **zero** worker tokens, the gate
262 s, and the gate is **95 %** of a candidate's cost and free. The **deciding** side is a blank, because
Phase 11's plans were hand-written by Opus inside a session that was also building the harness.

Two earlier numbers exist and neither is usable:

- **Phase 5's 120–145k for 8–14 units** is an upper bound contaminated by tooling built in the same
  session. `scripts/planner-tokens.mjs`'s own docstring says so.
- **Phase 11 could not supply one at all**, because planning was interleaved with debugging four voided
  arms, six defects and a 3.8 GB jest cache.

Without this number the project's claim is *"the work is free"*, which is true and uninteresting. With it
the claim is *"coordination costs X and buys Y"*, which is the whole argument.

## 2. The instrument, and what voids a run

`scripts/planner-tokens.mjs`, unchanged. It sums every assistant message's usage block in the newest
session transcript, so the window between `--mark` and `--since` must contain **planning and nothing
else**.

### The clean-window protocol

1. Start a **fresh Claude Code session** in this repository. Do not reuse the session that built the
   planner; that is exactly how Phase 5's number was spoiled.
2. `node scripts/planner-tokens.mjs --mark` as the **first action of the session**, before reading any
   file. Keep `messages`.
3. Invoke the change planner on **one module of one project**, and do nothing else. No lint, no tests,
   no unrelated reads, no commits, no answering a question about something else.
4. `node scripts/planner-tokens.mjs --since <mark>`. `total_excluding_cache_reads` is **P_total**.
5. Record the plan's task count as **N**. `P = P_total / N`.

**A window containing anything but planning is void, and a void window is discarded rather than
adjusted.** This is Phase 11's amendment applied one level down: a number repaired after the fact is a
description of the repair. If step 3 is interrupted, start again from step 1.

**Cache reads are reported and not counted**, for the reason the script gives: a cache read is the same
context re-sent, not new work, and `planning` is compared against a worker count of zero.

## 3. The comparison quantity

`P` alone says nothing. It is measured against **what the tasks would have cost a paid model to do**,
and there are two honest bounds, both from Phase 11's own run:

- **W_upper = 7,794 tokens/task.** Phase 11's C3 control spent 93,532 Claude tokens on 12 tasks of
  `project-a`. It is the Agent tool's own total, so it carries the harness's overhead — an **upper**
  bound on what a paid worker costs per task, and explicitly **not** the `api` tier's price (ADR-0045 §7).
- **W_lower = the candidate's own `usage`**, summed. `ChangeCandidate.usage.prompt_tokens +
  completion_tokens`, median over the same plan's tasks: the tokens a paid model would have had to
  process to do the identical work, with no harness around it.

Both are reported. The rule in §4 is applied against **W_upper**, because it is the number a colleague
would actually pay, and applying a rule against the flattering bound is how a measurement becomes an
advertisement.

## 4. The decision rule — frozen 2026-09-18, before the planner existed

### 4.0 Precondition

A run is read only if all of these hold. Any one failing makes the run **void**, not marginal:

1. **The window was clean** — §2's protocol, with the mark as the session's first action and nothing but
   planning between the two calls.
2. **The plan validates.** `sidecrew fix --validate` reports `valid`, with §4.1's exclusions applied, so
   `N` counts tasks a run could actually have spent tokens on rather than tasks that were written down.
3. **The denominator is stated with the number.** `P` is `P_total / N` and both halves travel together,
   for the reason in §4.4.

### 4.1 What counts in N

A task counts towards `N` only if it is one the gate could have passed. The three exclusions are Phase
11 §2's, applied by the validator rather than by hand this time:

1. A task whose correct fix needs a file it does not list — the diff would break confinement.
2. A task whose own files have zero `tsc` errors at the baseline and whose ask is error-driven: nothing
   to do.
3. A task whose own files carry a **pre-existing** `tsc` error the ask does not cover — the gate's
   `compile_ok` requires *zero* errors in the task's files, so such a task is unsatisfiable through no
   fault of a worker (ADR-0050 option C).

A task the planner **refused** does not count towards `N` and its refusal is reported separately: a
planner that refuses well is doing work, and hiding those in the denominator would make a careful planner
look expensive.

### 4.2 The measured quantities

- **P** — Opus tokens per task planned, new tokens only, `P_total / N`.
- **P_total**, **N**, and the refusal count, separately.
- **W_upper**, **W_lower** — §3.
- **R = P / W_upper** — the ratio the rule is stated in.
- Wall clock of the planning pass, **reported, never a criterion**. Phase 11 §4.2's reasoning holds: the
  expensive stage is the project's own suite and it is identical whoever planned.

### 4.3 The rule

`VISION.md`: *"the economics only work if the deciding is much smaller than the doing — which is a
constraint on the design, not a hope."* This is that constraint, given a number.

- **PASS — `R ≤ 0.5`.** Coordination costs at most half of what paying a model per task would. The claim
  that the deciding is much smaller than the doing holds, and the README may say so with this number.
- **MARGINAL — `0.5 < R ≤ 1.0`.** Planning is cheaper than doing, but not by the margin the word "much"
  claims. Report the ratio; the README drops "much"; and the retrieval step (`BACKLOG.md` § *The edge
  ideas*, item 1 — local models find the locations, a machine confirms them, Opus reads only those)
  stops being an idea and becomes the next phase's work, because it is the lever aimed at exactly this
  number.
- **FAIL — `R > 1.0`.** Planning costs more than having a paid model do every task outright. The design's
  economics do not work at this plan size, and the phase reports that in as many words rather than
  looking for a plan size where they do.

**`R > 1.0` is not a reason to stop.** It is a reason to say so, and then to measure §4.4, because the
one thing that can rescue it is a denominator the first run was too small to show.

### 4.4 The clause that says the number is not about the planner

**Planning cost is not linear in tasks, and `P` is a per-task figure, so `P` depends on `N`.** A module
Opus read once serves twelve tasks or forty; the reading is paid once and the grouping is paid per task.
A `P` taken at `N = 12` and quoted as though it were a constant is the same error as quoting the
fixture's 0.85 without saying real projects come in near 0.40.

So:

- **`P` is never reported without `N`.** Not in the README, not in an article, not in a table cell.
- **Two plan sizes if affordable** — one small (`N ≈ 12`, matching Phase 11's, so the two are comparable)
  and one at Phase 11b's target (`N ≈ 40`). Each in its own clean session. Reporting `P` at both is what
  turns a number into a curve, and the curve is the claim.
- If only one size is affordable, **the run says which, and §4.3's verdict is stated as holding at that
  `N` and no other.**

### 4.5 What this phase does not answer

`W_upper` is Phase 11's C3 control — a paid model doing the same tasks **inside sidecrew, behind the
gate**. It is not a person asking Opus directly with no plan and no gate. That comparison is **Phase
11b** (`docs/plan/prompts/phase-11b-against-the-status-quo.md`, §4 frozen 18 Sep 2026), it outranks this
phase by `ROADMAP.md`, and nothing measured here may be quoted as though it answered it.

## 5. What is written down

`results/planner-cost-<date>.json`, with `"measured": true`, machine info, the commit, the transcript
path, the mark and the `--since` output verbatim, `N`, the refusal list, and the verdict §4.3 produced.

**Machine for this phase:** Mac14,10 · Apple M2 Pro · 32 GB · macOS 26.6.2 · node v20.20.0.

Plans and results name `project-a` and `project-b` and never the client (CLAUDE.md #7). Absolute paths
are local configuration and stay out of anything committed.

---

## Appendix — the exact procedure, written 2026-09-18 by the session that built the planner

*Not part of §4. This is operational detail, added so the measurement is a checklist rather than a
reconstruction, and it changes no threshold.*

The build session cannot take this measurement: it contains the building. What follows is what to do in
a fresh one.

1. **Open a new Claude Code session in this repository.** Nothing else in it.
2. First action, before reading any file:
   ```bash
   node scripts/planner-tokens.mjs --mark
   ```
   Keep `messages` — call it `M`.
3. Invoke the **`change-planner`** agent with one ask against one project, and nothing else. Two asks
   worth taking, in this order:
   - `N ≈ 12` on `project-a`, matching Phase 11's plan size, so the two are comparable;
   - `N ≈ 40` with mixed shapes, which is what Phase 11b §4.4 needs and what §4.4 here calls the curve.
   Each in **its own** session: two plans in one window gives one number over two denominators.
4. Let it finish, including its `sidecrew fix --validate` loop. The validation is part of planning and
   its tokens belong in the window.
5. ```bash
   node scripts/planner-tokens.mjs --since M
   ```
   `total_excluding_cache_reads` is `P_total`.
6. `N` is the plan's task count **after** refusals are removed; the refusals are reported beside it
   (§4.1). `W_lower` comes from the candidates' own `usage` once a run exists; until then report `R`
   against `W_upper` alone and say so.
7. Write `results/planner-cost-<date>.json` per §5.

**If anything else happens in that window — a question answered, a file fixed, a test run — the window
is void.** Start again at step 1. §2 says this and it is repeated here because the temptation at that
moment is to subtract the interruption, which is precisely the repair §2 forbids.

---

## Amendment, 2026-09-19 — §2's clean-window protocol and the appendix are superseded, and the instrument they name was broken three ways

*Not an edit to §4. §4's rule, thresholds and preconditions stand exactly as frozen on 2026-09-18.
What changes below is **how §4.0.1's precondition is satisfied**, and the reason is that the
instrument §2 names could not see the thing it was pointed at.*

### The instrument was wrong in three independent directions

Found 19 Sep 2026, before any window was marked:

1. **It could not see a subagent.** `change-planner` and `test-planner` are subagents by design
   (`claude/agents/*.md`, `model: opus`). A subagent's transcript is not a `*.jsonl` beside the
   session's — it is `<session-id>/subagents/agent-*.jsonl`, a subdirectory the old
   `readdirSync(...).filter(f => f.endsWith(".jsonl"))` never descended into. Measured: one subagent
   spent **871,579** new tokens across 239 assistant messages while the parent transcript recorded
   1,704 entries, every one `isSidechain: false`, and none of that usage.
2. **It counted each assistant message about twice.** Claude Code writes a usage record per message
   more than once — a partial with `stop_reason: null`, then the final one — and the old code summed
   every record it found. The partials repeat `input_tokens`, `cache_creation_input_tokens` and
   `cache_read_input_tokens` verbatim. Measured over **177 transcripts** in this project: the naive
   sum inflates new tokens by a **median of 1.89×**, up to 4.18×.
3. **Its slug dropped `_` and `.`**, so it exited ENOENT on any project path containing one — which
   the paths this is measured on do.

Defects 1 and 3 were already in `BACKLOG.md`, one of them measured twice (2.7× and 5× wrong) and
neither acted on. Defect 2 is new and was found by checking the shape of the records rather than by
trusting the field names.

**Consequence, stated rather than quietly repaired:** every figure this script produced before today
is void, and it is *not* rescalable. Defect 1 omits a whole transcript and defect 2 multiplies what is
left, so the two do not compose into a correction factor. `meta.planner_tokens` is suspect wherever a
planner ran as a subagent — Phase 5's figures were already labelled contaminated for a different
reason, and this is a second, independent one. **Re-measure; do not rescale.**

### What replaces §2's clean-window protocol

§2 and the appendix required a **fresh session** whose entire window contained planning and nothing
else, because the script summed a whole transcript. **That requirement is gone**, and the reason is
defect 1 turned upside down:

> **A subagent transcript is a clean window by construction.** It contains that agent's work and
> nothing else, so the session it was spawned from is irrelevant.

So the protocol is now:

1. Invoke `change-planner` on one ask against one project. Nothing else about the session matters.
2. `node scripts/planner-tokens.mjs --agents` (or `--agent <id>`) once it returns.
   `total_excluding_cache_reads` for that transcript is **P_total**.
3. `N`, the refusals, `W_upper`, `W_lower` and §4.3's verdict are unchanged.

**This satisfies §4.0.1 more strictly than the protocol it replaces, and that is the claim being
made.** §4.0.1 requires that the window contain planning and nothing else. The fresh-session protocol
achieved that by *discipline* — a human refraining from asking anything else — and §2 had to write
down what voids a run precisely because discipline can fail. A subagent transcript achieves it by
*construction*: there is no way for an unrelated message to enter it. The precondition is met; the
means changed; the threshold did not.

**What the new protocol cannot do**, said plainly: it measures a planner that runs **as a subagent**.
A planner run inline in a session is still subject to §2's original objection and still needs §2's
original protocol, and the number from one is not comparable with the number from the other.

### One change made to the planners before measuring, and why it is not a thumb on the scale

`claude/agents/change-planner.md` §0/§7 and `claude/agents/test-planner.md` §0/§6 told the planner to
`--mark` and `--since` around its own work. That instruction was measuring the parent's transcript and
could not see the planner at all, so it produced a wrong `meta.planner_tokens` at cost. Both now say
the planner does **not** measure itself, leaves `meta.planner_tokens` at 0, says so in its report, and
the spawning session fills it from `--agents`.

This was done **before** the first measurement rather than after seeing a number, which is the whole of
the discipline §4 exists to enforce. It removes two `Bash` calls from the planner's window. The
direction of that effect is *downward* on `P_total` and it is small, and it is recorded here so nobody
has to infer it from a diff: what is now measured is planning, not planning plus self-instrumentation
that did not work.

### Machine and provenance for this amendment

Same machine as §5. The measurement taken under this amendment is written to
`results/planner-cost-2026-09-19.json` with `"measured": true`, and it names the subagent transcript
it summed — a total whose provenance is a count rather than a list is the failure this whole file is
about.
