# Phase 14d — retrieval: local models read the codebase · cut `v1.0.0`

**§2 and §3 are the frozen part, written 24 Sep 2026, before any retrieval tool beyond `sidecrew recon`
existed and before any retrieval-arm number existed.** Amend below them, dated, never in place.
**One exception, stated here so it is not a loophole later:** ADR-0090 §5 asks the owner which content
`14d′` has. That answer may be written into §3's `14d′` row **until the first retrieval-arm planner pass
starts**, because the thresholds do not depend on it and no number it could be tuned to exists before
then. After that pass, §3 is closed.

## 0. The question, in one paragraph

Planning costs a large fixed amount per plan. 14d asks whether local workers doing the reading, with a
machine confirming what they cite, make it small enough that coordinating is cheaper than paying a model
per task **at the plan size a new user starts with**, `N = 12`, without making the plans worse.
ADR-0090 is the design, and §1 of it is the measurement this rule has to be read with: of the fixed cost,
about a fifth is harness, a third reading, and half Opus's own output.

## 1. The two arms

- **Base arm, `P₀`.** `claude/agents/change-planner.md` as it stands at the commit that ends 14d's build,
  **with the retrieval tools withheld**. Not the 20 Sep numbers: those plans were gated before ADR-0084,
  ADR-0077 B and ADR-0086 B, and are at an older project commit (HANDOFF §3's first trap).
- **Retrieval arm, `P₁`.** The same planner, the same brief, **with** ADR-0090 §4's pieces 1–4 available
  and piece 5's contract in force.
- **Both arms, at both sizes:** `N ≈ 12` and `N ≈ 40`, the two sizes of `experiments/planner-cost/` §4.4.
  Four planner passes, **each spawned as a subagent** (the 19 Sep amendment: a subagent transcript is a
  clean window by construction), measured with `scripts/planner-tokens.mjs --agents` and split with
  `scripts/planner-decompose.py`.
- **One project, one commit.** `project-a` on a pinned clone (`scripts/pinned-clone.sh`), never the
  working checkout. Both arms plan against the same clone. The commit is recorded in every result file.
- **One brief per size, written before the first pass**, stored gitignored beside the plans (it names the
  project), **identical between arms except for one section** saying which tools exist. Its sha256 goes
  in the result.
- **Every plan validated** (`sidecrew fix --validate`) and **gated** under today's gate: `symbol_gate:
  "declaration"`, `retry_regressions: true`, `demote_test_type_errors: true`, correction off, 2 × 7B.

## 2. The measures — frozen

- **`R₁`** — `P_total(P₁) / N / 7,794` at `N ≈ 12`, exactly `experiments/planner-cost/` §4's quantity:
  new tokens only, cache reads reported and not counted, `N` after §4.1's exclusions and refusals, and
  **`W_upper` = 7,794** unchanged. `R₀` is the same for the base arm. **`R` is never quoted without `N`.**
- **`R` at `N ≈ 40`, both arms**, reported beside it so the curve is comparable with 20 Sep's. It decides
  nothing.
- **Each arm's `P_total` split** into harness, reading and output × 2 (`planner-decompose.py`), reported,
  deciding nothing. It is how a reader tells *retrieval cut the reading* from *retrieval cut the thinking*.
- **Survival**, `S₀` and `S₁`: surviving tasks / validated tasks, **pooled over both sizes per arm**, each
  `k/n` with an exact Clopper–Pearson 95 % interval (`results-11b.py`).
- **The retrieval spend**, reported: worker questions asked, answers admitted and refused under ADR-0090
  §2.2 (by reason), and bytes of admitted answer Opus read. Admission counts are **never** a quality
  number (ADR-0090 §3).

## 3. The fork — frozen

Applied to `R₁` at `N ≈ 12`, **after** the quality veto below.

| | |
|---|---|
| **`R₁ ≤ 1.0`** | **PROCEED: cut `v1.0.0`** — once ADR-0089 is also closed (PHASES.md's second prerequisite; it does not wait on this rule and this rule does not wait on it) |
| **`1.0 < R₁ ≤ 2.0`** | **INSERT `14d′`.** Content: ~~*as PHASES.md names it — cache the reading across runs of one codebase — unless the owner's answer to ADR-0090 §5 replaces it before the first `P₁` pass.*~~ **The owner's answer, 24 Sep 2026, written before any `P₁` pass: ADR-0090 §5 option B — `14d′` attacks the output term: sidecrew expands a compact decision list from Opus into the `ChangePlan`, with the reading cache as its second half.** The thresholds are unchanged. **`1.0` waits** |
| **`R₁ > 2.0`** | **STOP.** Publish `v0.x` describing the plan sizes where coordination does pay, from the curve |

**The quality veto, which overrides every row.** If **`S₁`'s upper 95 % bound is below `S₀`'s point
estimate**, retrieval made the plans measurably worse, and the result is **STOP for retrieval as built**,
whatever `R₁` is: a cheaper plan that produces worse changes is not a saving. Reported with both
intervals. **If either arm's pooled `n` is below 20**, the veto is **INCONCLUSIVE** rather than passed:
the rates are reported and the fork is applied to `R₁` with that stated beside it.

**`R₀` is not a criterion.** It exists so that a moved `R₁` can be attributed: if `R₀` itself has moved
far from 20 Sep's 2.84 at `N = 12`, the report says so and says why, and the fork still reads `R₁` alone.

### Pre-registered prediction — written before any `P₁` pass, and it is not part of the rule

From ADR-0090 §1's measured terms at `N = 12`: harness 45,877, reading 94,978, output × 2 130,164.
**Removing all reading with output unchanged gives `R` = 1.88.** Staying out of STOP with output unchanged
needs reading to fall 88 %. **The prediction: `R₁` lands in `(1.5, 2.3)`, and which side of 2.0 it falls on
depends on whether the planner writes and thinks less when it reads less, not on how much reading
retrieval removes.** Recorded so the outcome can contradict it.

## 4. How to run it without poisoning the number

- **The owner says when it runs.** It is prepared and dry-run, and it waits.
- **Planner passes are daytime and minutes each**; they need no machine quiet. **Do not run them beside
  the gated overnight** — a stray command in a planning subagent is a known hazard (HANDOFF §5).
- **The gated runs are the overnight**: quiet machine, no swapping, start after **02:05** local
  (ADR-0083), clean trees on both sides, both commits recorded.
- **Integrity** (ADR-0088): the clone and the working checkout are both fingerprinted before and after,
  and both fingerprints go in the result.
- **Nothing is re-planned after the first token** of a gated run. A task the validator refuses is removed
  then and counted by code.

## 5. Size — estimated from measured stage costs, not measured

| | how much | from |
|---|---|---|
| planner passes | **4** (2 arms × 2 sizes) | §1 |
| planner wall clock | **~2 h**, daytime: 925 s at `N = 12` and 2,645 s at `N = 41` per arm, 20 Sep | `planner-cost` results |
| planner tokens | base arm **~0.61 M new, ~22 M cache reads** (20 Sep's two passes); retrieval arm by design less | same |
| worker reading, retrieval arm | minutes: 6–17 s per generation, tens of questions per pass | VISION.md, Phase 11 |
| gated tasks | **~106** (≈ 12 + 41, both arms) | HANDOFF §3 |
| gated wall clock | **~5 h**: 14c′ gated 83 tasks in 4 h on the same project and gate | `phase-14c-prime.md` §5 |
| the overnight | **one**, 02:05 → ~07:15, if the plans come out near their target sizes | the two rows above |

**Re-size before scheduling the night**, from the four plans' actual task counts, the way 14c was sized.
A plan that comes out at 60 tasks instead of 41 is an extra ~1.5 h, which does not fit after 02:05.

## 6. What this session left, and in what order the rest goes

1. ~~ADR-0090~~ — written. §5 waits on the owner.
2. ~~This rule~~ — frozen above.
3. ~~ADR-0090 §4 piece 1, `sidecrew recon`~~ — built (ADR-0079 option A).
4. Piece 3: predicate retrieval (piece 2 was dropped — sidecrew's own output is ~1 % of `P_total`,
   ADR-0090 §4). No relevance risk.
5. Piece 4, judgement retrieval under ADR-0090 §2.2's admission rule, with its budget stated here, dated,
   before `P₁` runs. Piece 5, the planner contract. One session.
6. ADR-0089 — a separate daytime session, and a 1.0 prerequisite whatever §3 says.
7. The measurement: four planner passes (day), the gated overnight, the result applied as written.

---

## Amendment, 24 Sep 2026 — piece 4's budget, stated before it was built and before any `P₁` pass

*Not an edit to §2 or §3.* §6 item 5 required judgement retrieval's budget to be written here, dated,
before `P₁` runs. It is written before the code exists, so it cannot have been tuned to anything.

| | the cap | why this number |
|---|---|---|
| admitted claims per answer | **8** | a question asked of a reader has a handful of answers; past eight the answer is a survey, and the planner should narrow the question rather than read one |
| one claim's text | **300 characters** | a sentence and a clause; a longer claim is a summary, and a summary is not checkable |
| one quote | **12–400 characters**, byte-for-byte inside the cited lines | 12 non-space characters is the floor below which a quote could be found almost anywhere; 400 is a short block |
| rendered answer Opus reads | **4,000 characters** (~1,000 tokens) | claims plus `file:lines`, never the quotes: the machine checked them, and re-reading them is the cost 14d is trying to remove |
| files per question | **10**, at most **60,000 characters** in total | what the 7B's context holds with room to answer |
| questions per planner pass | **15** — the change-planner contract states it | **worst case, every answer useless: 15 × ~1,000 = ~15,000 tokens** of irrelevance, against 94,978 tokens of reading measured at `N = 12` (ADR-0090 §2.3's bounded cost) |

**What refusal means here.** A claim is admitted only when every one of its citations verifies. A claim
that fails is **counted by reason and dropped, never shown** (non-negotiable #3); the raw answer is kept
on disk under `.sidecrew/reads/` for diagnosis, where Opus does not read it. An answer with no claims is
`nothing_found`, which tells the planner to read the files itself: it is not a pass.

## Second amendment, 24 Sep 2026 — the quote match, changed after a construction probe and before any `P₁` pass

*Not an edit to §2 or §3, and not a number from either arm.* The first amendment said *"byte-for-byte
inside the cited lines"*. A probe of the real reader (the pinned 7B, five questions over this
repository's own `src/` and `fixtures/fix-fixture` — no client code) refused **9 of 10 claims under that
rule, and most of the refused claims were true**. The 7B joins a multi-line span into one line and drops
comment markers (`// `, ` * `), so its quotes held every word of the file in order and matched no bytes.

**The rule is now: byte for byte, or word for word once layout is removed** — line-leading comment
markers stripped and whitespace collapsed, on both sides, the text still contiguous and in order. Each
citation records which (`match: "exact" | "normalised"`). It is still existence: **elision (`{ ... }`),
paraphrase and a re-spaced token still fail**, and they did in the probe: under the new rule 6 claims
were admitted and 4 refused, and all 4 refusals were elided or invented code.

**What the same probe showed about admitted claims, recorded because it is ADR-0090 §2.3's accepted
weakness made concrete:** 2 of the 6 admitted claims said more than their quote did — one cited a
function's body for a claim that it *"is used in a `finally` block"*, which those lines do not show.
Admission proves the evidence exists, not that it supports the sentence. The MCP tool says so, and the
planner contract (piece 5) must tell the planner to open the cited lines before anything load-bearing.

These are construction observations on 10 claims, not a rate, and nothing in §2 may cite them.

## Note, 24 Sep 2026 — how the base arm's "withheld" is made checkable

*Not an edit to §2 or §3.* §1 withholds the retrieval tools from `P₀` by the brief, and a planner told not
to use a tool may still use one (HANDOFF §5: a subagent told to run no commands ran one). So **`P₀` is
void if its transcript calls `sidecrew_recon`, `sidecrew_query` or `sidecrew_read`, or runs `sidecrew
recon`, `query` or `read`** — checked by a grep of the transcript before its number is read, the way a
void window is discarded rather than adjusted (`planner-cost` §2). The contract's §1′ says the same to
the planner.

## Note, 25 Sep 2026 ~00:20 — two launch artefacts, written before any retrieval-arm number existed

*Not an edit to §2 or §3.* The four planner passes were launched **in parallel** at 00:00, to finish before
02:05. Two consequences, both found in the first finished transcripts, both recorded here before the
retrieval arm reported:

1. **The harness was a shared prompt cache.** The first pass to start (base, `N ≈ 40`) wrote a 30,678-token
   prefix; the other three read it back as a cache read, which `P_total` excludes. So three of the four
   `P_total`s are **30,678 lower** than a pass started alone would be — including both `N ≈ 12` arms,
   equally. **Between arms it cancels at `N ≈ 12`; against §3's absolute thresholds it does not**: it would
   flatter `R₁` by ~0.33. **So §3 is applied to `R₁` harness-normalised** — `P_total` plus that pass's first
   message's cache read, i.e. what a pass started alone pays — and the as-measured `R₁` is reported beside
   it. Choosing the conservative reading before seeing the number is the point of writing this now; if the
   two readings fall in different rows of §3, the report says so and the normalised one decides.
2. **The passes shared one scratchpad folder.** The base `N ≈ 12` pass reports it once saw a recon-format
   file another pass had written, then redid its survey in a private folder; it made no retrieval call
   (`retrieval_calls` = 0), so it is **not void** by the note above, and `R₀` is not a criterion. The
   dangerous direction is the other one — a retrieval pass reading a base pass's files would flatter `R₁` —
   so both retrieval transcripts are audited for reads of files they did not write before `R₁` is read.
   A retrieval pass that relied on one is re-run alone.

## Note, 25 Sep 2026 ~05:30 — machine failures are re-gated once, quietly; written before any re-gate ran

*Not an edit to §2 or §3.* §2 says `S = surviving / validated tasks` and did not say what a **machine
failure** is. The standing rule (ADR-0056, ADR-0066 option C, and the `fix_escalate` tool's own words) is
that a machine failure is not the worker's and is excluded from any quoted rate. Found at 05:20: the
retrieval `N ≈ 12` run gated its candidates under memory pressure **warn**, swap growing from ~6 GB to
**26 GB**, and **9 of 11** tasks ended as machine failures — the project's suite timing out at the 900 s cap
(its baseline, taken alone, ran in 270 s). The base `N ≈ 12` run stayed at **normal** pressure. The cause is
sidecrew's, not either arm's: one project-a suite is **11 jest workers, ~8.2 GB**, and at concurrency 2
two suites plus two 7B workers and `tsc` exceed 32 GB. (The run's "thermal back-off" to concurrency 1 was
that swap slowing the workers, not heat.)

**So, for every arm alike:** after the four runs, each task whose every attempt was a machine failure is
**re-gated once, at concurrency 1, on a quiet machine** — the same task definitions, so the deterministic
worker returns the same candidates (non-negotiable #4). The re-gate's verdict is that task's verdict. A
task that is a machine failure again is **excluded from its arm's denominator** (ADR-0056) and counted in
the report. Only machine failures are re-gated: a real verdict, pass or fail, is never re-read — that is
ADR-0066's *better of two* forbidden move. The first-pass counts are reported beside the result.

## Note, 25 Sep 2026 ~10:00 — the retrieval `N ≈ 40` arm is re-run whole next night; written before it runs

*Not an edit to §2 or §3.* The first night's retrieval `N ≈ 40` run started at 08:50 at concurrency 2 and
swapped 30 GB within the hour (the defect in the 05:30 note); at 09:54, six verdicts in, it was interrupted
because at that rate it would not finish in the owner's window. **Its partial run is kept on disk as
`retr-n40-interrupted` and nothing in it is used.** The arm is **re-run whole, at concurrency 1**, on the
second night — the same plan (its sha256 is logged both nights), the same clone, the same worker. Re-running
the whole arm is not re-reading chosen verdicts: every task of the arm gets exactly one pass, all under the
same conditions. Then every arm's machine failures are re-gated once (the 05:30 note) and §3 is applied.

**What is already known, stated so it cannot be tuned to:** base `N ≈ 12` 9/11, base `N ≈ 40` 32/45 (1
machine failure), retrieval `N ≈ 12` 1/11 with **9 machine failures** awaiting their re-gate. The veto is
not computable until the re-gates exist, and `R₁` is already fixed by the planner transcripts.
