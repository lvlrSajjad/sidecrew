# What Phase 12 changed under Phase 11b

**Written 18 Sep 2026 by the Phase 12 session, for whoever runs 11b.** Not part of the prompt and it
amends nothing: `phase-11b-against-the-status-quo.md` §4 is frozen and this file does not touch it. It
exists because Phase 12 landed between 11b's prompt being written and 11b being run, and three of its
changes are things you would otherwise hit mid-run.

Read `phase-11b-against-the-status-quo.md` first. This is the diff against the world it assumes.

---

## 1. Read this before you touch the plans

**`experiments/go-no-go-2a/plans/` is now untracked, and the files were renamed.**

- The two plan files are now **`project-a.json`** and **`project-b.json`**, renamed from names that
  identified the client. That is the name the results already referenced (`partials/c2-api.json` has
  `"plan": ".../plans/project-a.json"`), so the rename also closes a reference that had been dangling
  since Phase 11.
- They are **gitignored** (CLAUDE.md #7): `project` is an absolute path into a client checkout, and a
  rename ask quotes the client's own symbols by construction. They are on disk and the harness reads
  them; do not re-add them.
- **Every task now carries a `shape`**, because Phase 12 made it required. Migrated from the task ids:
  project-a is 12 × `rename`, project-b is 6 × `unused_import` + 6 × `rename`. Both parse — checked.

**When you extend them to 40 tasks (§2), the new tasks need a `shape` too**, and §4.4's bar is stated in
those terms: at least half must be `null_guard`, `api_migration` or `dead_code`. `sidecrew fix
--validate` prints the mix and tells you whether §4.4 is satisfied, so you do not have to count by hand.

## 2. Build the extended plans with the planner, not by hand

Phase 12 exists partly to make your §2 affordable. Use it:

```bash
sidecrew fix experiments/go-no-go-2a/plans/project-a.json --validate
```

or the `change-planner` agent (`claude/agents/change-planner.md`) for the new tasks.

**What it will refuse, and why you want it to.** A task whose files already carry a `tsc` error its ask
does not cover cannot be passed by anyone — `compile_ok` requires zero errors there (ADR-0048,
ADR-0050 option C). At 262 s of gate per attempt, each refusal saves about nine minutes. Three more:
files too large for a worker to return whole (ADR-0047 §2's ceiling), a file outside the tsconfig's
program where `compile_ok` passes vacuously, and two tasks in one step sharing a file — which is the one
failure mode **no per-task verdict can see**, because both candidates survive and the second to land at
the step boundary silently drops the first.

That last one matters more at 40 tasks than it did at 12. §2's "disjoint files" discipline is now
machine-checked; let the validator do it.

**A refused task is not a planned task.** Report refusals separately and keep them out of any
denominator — the same rule `experiments/planner-cost/README.md` §4.1 applies to `N`.

## 3. The two fields your funnel needs, and the denominator

Already in your §5, repeated here with the exact names:

| field | grain | what it is |
|---|---|---|
| `FixResult.stats.refusals` | run, **per task** | the worker said it could not do the task |
| `FixResult.stats.machine_failures` | run, per task | the sandbox or the runner broke (ADR-0012, ADR-0056) |
| `ChangeVerdict.refused` | per attempt | the worker's own sentence |
| `ChangeEscalation.refused` / `.machine_failure` | per escalation | the same, joined to the task |

**The denominator that actually reached the gate and failed it:**

```
tasks − survived − refusals − machine_failures
```

Dividing by `tasks` understates the worker.

**A refusal never reaches the gate.** It short-circuits at `generate` — no sandbox, no `tsc`, no suite —
so it costs ~13.5 s against 262 s. Two consequences for arm C, and both are ways it can look like a win
that is really an abstention:

1. a rising refusal rate **lowers survival and raises precision** (your §2.1's confound);
2. it **also lowers cost per task**, because the gate is 95 % of a candidate's cost and a refusal skips
   it entirely.

So refusal rate belongs next to `S` **and** next to `T`, not only next to `S`.

One thing that is now safe and was not when your prompt was written: a refusal **does not spend the
retry**. It did — it fell through to the compile branch and came back "tsc is not satisfied", naming a
stage that never ran, so a task could be counted in `refusals` *and* reach the gate on the retry, which
would have double-counted it in the denominator above. Fixed in `5a4ac14`; you found it.

## 4. `observations` are on every verdict now, and they are not a gate

ADR-0057. `ChangeVerdict.observations` records unrequested cosmetic edits — comment lines removed,
blank-line churn — and **nothing gates on them**. `changeSurvives` does not read the field and a schema
refinement asserts that, specifically so **your arms stay comparable with Phase 11's**. No candidate's
fate changes.

Two ways this touches 11b:

- **Your blind pack is unaffected** — reviewers see diffs, and observations are not in them. Do not add
  them to the pack; that would unblind a known quality gap on one arm.
- **But they are the cheapest read on `E(x)`.** Phase 11 measured cosmetic edits in 4 of 23 sampled
  survivors for the local tier against 0 of 23 for the control, and it took a human to see it. If arm C
  produces observations that arms A/B's diffs do not, that is a signal you get for free — **reported
  beside your blind rate, never folded into it**, because a line delta is blind to a comment reworded at
  the same length (1 of Phase 11's 4 cases).

## 5. What Phase 12 did *not* settle, that you might assume it did

- **Neither of Phase 12's numbers exists.** The planner is built and unmeasured; the correction round is
  built, budgeted and **off by default**. Nothing in `FixResult.stats.corrections` will be non-zero
  unless a plan turns the round on, and arm C should almost certainly leave it off — measuring the
  correction round inside 11b would confound two mechanisms in one arm.
- **`max_group_size` is still unmeasured.** Phase 11 ran one file per task and so does every number in
  the repo. If your 40-task plans group files, that is a new variable in an experiment that already has
  four arms — I would keep one file per task unless you have a reason.
- **The prompt bytes changed** (`fixer.md` gained the refusal form, `6c161de`). Your §2.1 already decided
  not to pin, which I think is right; this is just the commit to cite.

## 6. What I would watch for

Phase 11 surfaced six defects on the first two real projects and not one was visible in a summary
statistic. Phase 12 surfaced two more — the refusal retry bug above, and a `doctor` slow test stale since
Phase 9 — and both were found by reading something rather than by a failing number.

At 40 tasks × 4 arms × 2 projects you will be generating far more discarded output than Phase 11 did.
**Read some of it.** The funnel will not tell you what you most need to know.
