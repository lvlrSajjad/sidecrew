# Phase 12's measurements, and the two defects that would invalidate them

Read `docs/plan/VISION.md`, then `docs/plan/ROADMAP.md` (newer than `PHASES.md` and it reorders it),
then `docs/plan/PHASES.md` for where things stand. Then this.

**Written 19 Sep 2026 by the session that built Phases 12, 13 and 13b**, and handed over because that
session's context had grown too large to do the work well. Everything it knew that is not already in the
repository is below; where something is only in this file, it says so.

---

## 0. State, so you are not guessing

**The repository is public.** `origin/main` is clean — the scrub was an allowlist rebuild, 19 commits,
zero client references in any commit or object path. Normal work on `main` now.

**Never push `private-history`, and never merge it into `main`.** It holds 44 contaminated files across
107 commits. An offline bundle is at `~/sidecrew-history-backup/`. This is the one rule that replaced
"never push sidecrew".

**Never name the client.** `project-a` (Nest/jest), `project-b` (React/jest), `project-c` (mobile).
CLAUDE.md #7 is the rule and it now protects a public repo, so scan every diff before committing —
including context lines, which is how seven mentions were caught in `src/` on 18 Sep.

| phase | state |
|---|---|
| 11, 11b | ✅ complete and measured |
| 12 | 🔶 built, **both its numbers missing** — that is §2 and §3 below |
| 13 (`api` tier) | 🔶 built and merged; its §5 needs API credits and is **explicitly skipped for now** |
| 13b | unattended mode ✅, memoisation ✅, **local retrieval outstanding** and gated on §2.1 |
| 14 (publish the package) | not started; needs both tiers measured |

ADRs run to **0069**; start new ones at 0070. ADR-0066, 0067, 0068, 0069 came out of Phase 11b;
0067 and 0068 are accepted and implemented, 0066 and 0069 are **proposed and need deciding**.

---

## 1. Do these in order, and the order is not arbitrary

1. **ADR-0069** — a stale baseline. Cheap, and it protects every measurement after it.
2. **The `planner-tokens.mjs` defect, then §2.1.** The instrument is broken; §2.1 cannot be taken until
   it is fixed, and §2.1 is also 13b item 1's go/no-go.
3. **The gate's own error rate.** The owner approved this on 19 Sep. It is the highest-value item here.
4. **§2.2** — the correction round. Longest, needs an overnight run, do it last.

Items 1 and 2 are roughly two hours together. **Do not reorder them after the long runs**; the entire
point of 1 is that it stops a long run being silently invalidated.

---

## 2. ADR-0069 — a baseline has a shelf life

**Read ADR-0069 in `docs/DECISIONS.md`.** It is proposed, measured in Phase 11b, and needs a decision.

The measurement, in one line: a candidate **byte-identical** to one that survived failed at `tests` with
one regression, on a pristine machine, because the run crossed midnight and the regressed test asserts on
what was tracked *today*. The mechanical retry cannot rescue this class — a retry minutes later is still
on the wrong side of midnight.

**The outgoing session's recommendation is option A**, and the reasoning is worth having:

- **A — record the baseline's `captured_at` and the verification time on the verdict.** Both timestamps
  already exist (`baselines/*.json` has one); the verdict does not carry them, so the gap is invisible
  where the verdict is read. Changes no decision, cannot bias anything, and makes the condition
  detectable after the fact.
- **B** needs a staleness threshold nobody has a number for — the same objection that pushed ADR-0066 to
  its option C, and for the same reason: a machine or a project at the boundary converts real failures
  into machine failures, which is the same bug with the sign flipped.
- **D — freeze the clock** removes the class entirely, and it changes the environment the project's own
  suite runs in. That crosses the "the user should not have to change their project to be verified" line
  in `VISION.md`. Worth revisiting as an opt-in, not as a default.

**A composes with ADR-0066's recommended option C** — both are *record, don't gate* — and together they
make two of the three known false-negative sources detectable rather than merely suspected. Decide both
in one sitting; they are the same shape.

Add a warning when the two timestamps fall on different calendar days. Do **not** gate on it.

---

## 3. `planner-tokens.mjs` is blind to the planner, and §2.1 depends on it

**This is the finding that exists nowhere else. Read it carefully — it changes §2.1's design.**

`scripts/planner-tokens.mjs` reads the newest `*.jsonl` in `~/.claude/projects/<slug>/`. Subagent
transcripts are **not there** — they are in `~/.claude/projects/<slug>/<session-id>/subagents/agent-*.jsonl`,
a subdirectory the script's `readdirSync(...).filter(f => f.endsWith(".jsonl"))` never descends into.

Measured on 19 Sep 2026: a subagent spent **871,579 new tokens** (input + output + cache creation,
excluding 49.9M cache reads) across 239 assistant messages. The parent transcript recorded **1704
entries, every one `isSidechain: false`, and none of that usage**.

Three consequences, and the third is the useful one:

1. **`change-planner` and `test-planner` are subagents by design** (`claude/agents/*.md`, `model: opus`).
   So the instrument cannot see the planner it exists to measure.
2. **`meta.planner_tokens` is suspect wherever a planner ran as a subagent.** It is the one number
   `BatchResult`/`FixResult` copies rather than measures. Phase 5's figures were already labelled
   contaminated for a different reason; this is a second, independent one. Say so rather than quietly
   re-measuring.
3. **The "clean window" problem dissolves.** Every previous plan assumed §2.1 needed a *fresh session*
   because the script sums a whole transcript. It does not need one: **a subagent transcript is a clean
   window by construction** — it contains that agent's work and nothing else. Measure the subagent
   directly and the session it was spawned from is irrelevant.

### What to build

Teach the script about subagent transcripts. Suggested shape, not prescribed:

- `--agent <id>` sums one subagent transcript;
- `--agents` sums all subagent transcripts under the newest session;
- the default stays what it is, so nothing already written changes meaning;
- the output says **which transcript(s)** it summed, because a number whose provenance is ambiguous is
  the thing this whole file is about.

Keep the cache-read exclusion exactly as it is, and keep printing both totals. `total_excluding_cache_reads`
is the figure that belongs in `meta.planner_tokens`.

### Then take §2.1

`experiments/planner-cost/README.md` — **§4 is frozen, do not edit it; amend below it, dated.** Its §2
describes the fresh-session protocol and its appendix gives a step-by-step; **both are superseded by the
finding above**, and that supersession is itself an amendment to write.

The measurement is **Opus tokens per task planned**, `P = P_total / N`, against what a paid worker would
cost per task. §4.1 says which tasks count in `N`, §4.3 is the rule, and §4.4 forbids reporting `P`
without `N` because planning cost is not linear in tasks.

**§2.1 is also 13b item 1's go/no-go, not merely its baseline.** Item 1 ("local models read the codebase
so Opus does not have to") rests on planning being expensive. If `P` is small, the item is solving a
problem that does not exist and should be closed with that number attached. Check `PHASES.md` §13b for
the argument, including the separate reason item 1 needs an ADR first: its gate confirms a symbol
*exists*, not that it is *relevant*, so ten confirmed-but-irrelevant locations pass while saving nothing.

---

## 4. The gate's own error rate — the owner approved this, and it is the most valuable item here

Every survival number in this repository is **a lower bound of unknown tightness**. Three independent
sources of false negatives are known and only one is understood:

| source | state |
|---|---|
| memory pressure (ADR-0066) | diagnosed, measured once, proposed fix not applied |
| a stale baseline (ADR-0069) | diagnosed, measured once, §2 above |
| `experiments/status-quo/README.md` **O8** | **undiagnosed** |

The method is simple and nobody has run it: **replay known-good candidates through the gate and count
disagreements.** Phase 11b's arm A diffs are the ideal input — they are Opus's own output, 18 of 19
byte-identical to the local worker's, and arm D already established the gate finds no defect in them.
Any rejection on a replay is a false negative by construction.

Budget roughly 262 s per replay. Nineteen candidates is about 85 minutes of machine time.

Two design notes from the outgoing session:

- **Run replays one at a time and record machine pressure throughout.** Phase 11b built a pressure
  recorder that samples every 20 s and agrees with `parseMemory` to the decimal; ask for it or rebuild
  it. Replaying under contention would manufacture the exact false negative you are trying to count.
- **Freeze the rule before the first replay.** Same discipline as every other number here, and it is
  cheap: what counts as a disagreement, what the denominator is, and what result would make the gate's
  error rate unacceptable.

This turns the project's biggest caveat into a number, which is the move that has paid every time here.

---

## 5. §2.2 — does the correction round pay for itself

`experiments/correction-round/README.md` — **§4 is frozen**, with a dated amendment below it. Read both.

Do this last. It needs an overnight run and three things have to be true before it starts:

- **A task set the worker actually fails.** `retried = 0` across all 54 of Phase 11's tasks: renames and
  unused-import removals are too easy to fail. ADR-0063 is what unblocks this — an experiment may compile
  a project at a stricter setting than the project's own, **declared in the protocol**, with the baseline
  captured under the same flag. Measured availability on project-a with `--strictNullChecks`: 763 files
  with an error, **417 with few enough for one ask to cover them all, 401 of those inside the whole-file
  ceiling, 22 pure null-shaped**.
- **n₂ ≥ 8** per project or the project is INCONCLUSIVE — §4.3's floor.
- **The quality veto is live.** If corrected survivors are approved at a lower blind rate than
  uncorrected ones, the round is off regardless of tokens. Budget for the blind pass from the start.

One measurement from Phase 11b that reframes the question: **the mechanical retry rescued none of the
four real worker defects** — all four retry candidates were byte-identical to their first attempt. It
rescues environmental failures only. So §2.2's question — *what does an Opus note buy over the free
retry* — now starts from "the free retry buys nothing on real defects", which makes the round's case
stronger and the measurement more interesting, not less.

---

## 6. Standing hazards, all of them learned expensively on 18–19 Sep

- **Stage explicit paths. Never `git add -A` or `git commit -a`.** One session's `git add -A` swept 97
  lines of another's staged work into the wrong commit.
- **Run experiments from a detached worktree pinned to a commit**, `node_modules` and `.sidecrew`
  symlinked. This is structural isolation and it replaces every "please don't rebuild while I run"
  agreement. It was tested literally: a gate change landed mid-experiment and could not reach the run.
- **A `tsx` harness imports `../src/*.js` from source.** "I only edited source, I did not rebuild" is not
  a safety argument — uncommitted edits compile into a run at the moment it starts, with nothing in any
  log to show it.
- **A harness that imports these contracts should assert against them**, not merely import them. Making
  `refusal` required-nullable broke a go/no-go script whose pre-flight only checked that modules loaded.
- **Verdicts are not the record; the run is.** `ChangeVerdict` and `FixResult` carry different things,
  and a check that looks impossible from one is often free from the other.
- **The fixtures' `node_modules` are not in the repository.** A clean clone skips a few cases; each skip
  names the command that enables it. `README.md` has the one-liner.

## 7. Definition of done

- ADR-0069 decided and implemented; ADR-0066 decided in the same sitting.
- `planner-tokens.mjs` can measure a subagent, and says which transcript it summed.
- **§2.1 measured**, in `experiments/planner-cost/results/` with `"measured": true` and machine info,
  against §4 unedited — and 13b item 1 either unblocked or closed with the number that closed it.
- The gate's error rate measured against a rule frozen first, in `experiments/`.
- **§2.2 measured** against its frozen §4, including the outcome "it does not pay", which is a complete
  result.
- `npm run lint && npm test` green, `PHASES.md` and `ROADMAP.md` updated, a line in `docs/CHANGELOG.md`,
  an ADR for anything decided.

## 8. Do not

- Do not edit a frozen §4. Amend below it, dated.
- Do not run two measurements on one machine at once. Contention manufactures the false negatives §4 is
  trying to count.
- Do not quote a `generate_ms` from a run with `stats.cache.enabled` true, and do not enable the cache
  for any figure that reaches `experiments/`.
- Do not start Phase 13's §5. It needs API credits and the owner has deferred it.
- Do not treat Phase 11's or 11b's rates as post-ADR-0067 numbers. Both were measured under the lenient
  gate, and for Phase 11 that cannot be checked retroactively — its run directories are gone.
