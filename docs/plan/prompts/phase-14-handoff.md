# Handoff into Phase 14 — publish

**Written 18 Sep 2026 by the Phase 11b session.** Phase 14 is the old Phase 8 prompt, unchanged
(`prompts/phase-8-publish.md`). This file is the diff against the world that prompt assumes, plus the
one job that stands between here and it.

Read `prompts/phase-8-publish.md`, then `docs/plan/ROADMAP.md` Priority 4, then this.

---

> **Superseded in part, 19 Sep 2026: the scrub is done and the repository is published.**
> `origin/main` is `6e841c8`, 19 commits, **0 client references in any commit or object path**.
> §1 below is kept as the record of what was removed and why, because Phase 14 has to know what is
> *not* in the repository it is publishing. The live rule now is narrower and sharper:
> **the local `private-history` branch carries 44 contaminated files across 107 commits and must
> never be pushed or merged into `main`.** The offline copy is
> `~/sidecrew-history-backup/sidecrew-full-history-20260919-0142.bundle`, verified by restoring it.

## 1. What was removed, and the one case that decided the method

`origin/main` is **84 commits behind and clean. Nothing has leaked.** That is the good news and it is
the whole reason a careful scrub is still possible.

Measured 18 Sep 2026, so the size of the job is known:

| | |
|---|---|
| tracked files naming the client | **44** |
| commits whose diff touches that name | **31 of 102** |
| largest clusters | 15 in `experiments/real-world/results`, 6 in `experiments/mutant-probe` |

**It was a rebuild, not a filter or a `sed`.** With 76 of 89 local commits contaminated there was
little intact history left to preserve, so the content was replayed onto the last published commit as
one clean tree: **325 files kept, 629 dropped, 14 renamed, 32 anonymised.**

**The case that justified the allowlist**, and Phase 14 should keep it in mind for anything it adds:
45 generated test files under `experiments/mutant-probe/*/` imported the client's modules and encoded
their business rules, and **contained the client's name nowhere in their contents**. Every name-based
scrub would have published all 45. An allowlist miss loses a file; a denylist miss publishes one.

The original reasoning, kept: A push distributes every blob in history; `git rm` in a
later commit does not remove it; forks, caches and code search pick it up within hours. CLAUDE.md #7
is the rule and ROADMAP Priority 4 is the method: **an allowlist rebuild, never a denylist** — a
denylist that misses one blob has failed completely while appearing to work.

**The hardest cluster is `experiments/mutant-probe`.** Those are generated tests that encode the
client's business rules. They remain client IP with the name stripped, so they cannot be anonymised —
only removed.

**A verified history bundle exists** (it did not before today; ROADMAP promised one and none was
there):

```
~/sidecrew-history-backup/sidecrew-full-history-20260918-1650.bundle    1.6 MB
```

Verified by **restoring it into a scratch clone and comparing** — `HEAD a4d2232`, 102 commits, both
matching. Not by `git bundle verify`, which only proves internal consistency. **Re-verify by restore
before the rewrite rather than trusting this paragraph**: a bundle that exists and does not restore is
the same failure as a guard wired into one call site, in the one place with no second chance.

---

## 2. What is measured, what is not, and what was decided not to measure

Phase 8's prompt will want numbers for the README. These are the ones that exist.

**Measured and solid:**

- **Workload #2a, project-a** (`experiments/status-quo/`): a local 7B produced **byte-identical output
  to Opus on 18 of 19 tasks**, arm C survived **19/19 at zero worker tokens** against 80,131 (Opus) and
  88,820 (Sonnet). Generate 15.9 s, gate 255 s — **94 % of a candidate's cost is free and local.**
- **Workload #2a, project-b**: arms A and B measured; C and D were running when this was written —
  **check `experiments/status-quo/results/` before quoting anything for project-b.**
- Phase 11's go/no-go, with the caveats in §3.

**Deliberately not measured, by the owner's decision of 18 Sep 2026:** Phase 13 §5, the `api` tier's
price. It spends real money. The tier ships **buildable and unpriced**, and the README must say that
as a decision rather than leave it looking like a gap.

**Never pool across projects.** §4 forbids it, and 11b produced the first *measured* reason: the
cost ordering between Opus and Sonnet **reversed** between the two projects (Opus 10.8 % cheaper on
project-a, 7.0 % dearer on project-b). A single-project number would have reported the wrong sign.

---

## 3. Five defects found in 11b — three fixed, two open — and what they do to a published claim

| | direction | state |
|---|---|---|
| **ADR-0066** — a memory-starved gate fails closed, indistinguishably from a real failure | rejects good work | **PROPOSED, needs the owner** |
| **ADR-0067** — the gate compared test identity, not counts | **admits broken work** | fixed, `7d13ddf` |
| **ADR-0068** — `observations` counted comment lines, so a reword was invisible | missed its only case | fixed, `7d13ddf` |
| **O8** — a second non-determinism source, on a quiet machine | rejects good work | **open, undiagnosed** |
| replay-arm tier mismatch — neither `local` nor `api` | schema refuses it, correctly | open |

**What a published README may and may not say.** Survival rates in this repository are **lower bounds
of unknown tightness**, because two independent sources of false negatives exist and only one is
understood. The mechanical retry is currently the only thing between them and the reported number.
Do not publish a survival rate without that sentence somewhere near it.

**ADR-0066's recommendation is C-then-A and the order matters:** record pressure on the verdict first,
gate on it later, because A's threshold cannot be set from data nobody has collected. The recorder
exists (`scripts/run-11b-*.sh` write `results/pressure-*.csv`) and should move into the product.

---

## 4. Things that will bite you, learned the expensive way

1. **The Agent harness's token floor is ~90 % of a subagent's total, is per model, and drifts between
   sessions.** Measured twice this session: Opus 48,088, Sonnet 53,597 — up +162 and +178 from the
   morning's figures. Spread within a session is 2 tokens. **Re-measure the floor in the session you
   use it**; reusing an old one is a systematic inflation.
2. **A harness that imports our contracts must assert against them, not merely import them.** Arm D
   threw on all 19 tasks because ADR-0062 made `refusal` required-nullable after that script was
   written. Importing a module proves it loads, not that its schema accepts your data. Validate a real
   payload through `safeParse` before starting a long run.
3. **Never stage a directory.** 38 client-source diffs were committed that way once.
4. **Run experiments from a pinned worktree, not the shared tree.** The gate changed on `main` twice
   mid-run and could not reach the arms because they ran from a detached worktree verified at launch by
   commit, `src` cleanliness and `dist` md5. This makes the shared-worktree hazard structural rather
   than a promise two sessions have to keep.
5. **`--validate` does not check that a task's file set covers every reference to its symbol.** It
   checks tsconfig membership, pre-existing errors, file size and task-to-task sharing. A plan can pass
   validation and still be impossible. Phase 12's planner has the same blind spot.
6. **project-b's `tsc` needs `NODE_OPTIONS=--max-old-space-size=8192`** or it OOMs. Its own `checkTs`
   script sets exactly that.

---

## 5. Two things Phase 8's prompt will not have anticipated

**First-run experience is unmeasured and probably rough.** `npm install` succeeds with no Python at
all; the failure surfaces later at `doctor` or `serve`. The weights (~4 GB for the 7B) download inside
`serve` with no size warning first — on a slow connection that looks like a hang. Neither is a bug in
the architecture (external capabilities are shelled out and reported by `doctor`, never bundled), but
both belong in the README's first paragraph rather than in a user's afternoon.

**`P(x)` has reviewer variance on the behaviour that distinguishes the local tier.** Phase 11's blind
reviewer rejected a doc-comment reword by the 7B; the owner judged the same behaviour, by the same
model, on the same word, acceptable. Phase 11's GO had **zero margin** and turned on that single
judgement. Before any published claim leans on `P(x)`, the disputed class needs more than one
reviewer — otherwise the number is measuring the reviewer.
