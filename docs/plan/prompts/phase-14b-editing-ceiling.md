# Phase 14b — the editing ceiling: is it the model, or the task?

Read `CLAUDE.md`, then `docs/plan/HANDOFF.md`, then `docs/plan/PHASES.md` § *14b* — whose **exit check
was frozen on 20 Sep 2026, before either probe ran, and must not be edited**. Then this.

**Written 20 Sep 2026 by the session that built Phase 14.** Everything below that is not already in the
repository says so.

---

## 0. What this phase is, in one paragraph

The 7B does not *attempt* `null_guard` work. Survival was **1/30** (`[0.001, 0.172]`), and **16 of 17**
tasks where it returned the file unchanged returned it unchanged **again** after a note saying that
returning it unchanged *was* the failure. Not wrong code — no code. Two probes decide whether that is a
capability ceiling or a fixable gap, and the answer decides how the three phases after it are spent.

**One evening. Needs the machine and a worker. No build, no version cut, and — in every branch — no
code.** If you find yourself writing product code, you have left the phase.

## 1. Before anything: the trap that would void this phase

**The 30 tasks are comparable with §2.2 only if they are literally the same 30 tasks**, and the plan
that declares them is **gitignored**:

```
experiments/correction-round/plans/project-a-2026-09-20/change_plan.json   # .gitignore:46
```

It exists **on the owner's machine and nowhere else** — 1 step, 30 tasks, every one `shape:
"null_guard"`, and its `project` key is an absolute path to the client's checkout, which is why it is
ignored and why it may never be committed (CLAUDE.md #7).

- **If it is there, use it unchanged.** Do not regenerate it, do not re-plan, do not "refresh" it.
- **If it is not there, stop and ask the owner.** A regenerated 30-task set is a *different*
  experiment and `S₁₄` computed on it cannot be compared with the 1/30 baseline — which is the only
  thing this phase is for. Quietly rebuilding it is the single most expensive mistake available here.

The baseline to compare against is `experiments/correction-round/results/correction-round-2026-09-20.json`
(`S_c`, `n2`, `n2_by_shape`, `stage_after_correction_vs_after_free_retry`). It is committed.

## 2. The two probes, and the one that is already answered

Same 30 tasks, both of them.

1. **The 14B on the same set.** `qwen2.5-coder-14b-4bit` is in `src/models.json`, pinned. The machine
   hosts one 14B **or** two 7Bs, never both (CLAUDE.md #5), so it is a clean swap and concurrency
   drops to one. Phase 6 measured the 14B *matching* the 7B on TypeScript at 2.2× generation time;
   this asks whether that holds on a shape the 7B cannot do at all.
2. **One task decomposed to a single function** rather than a whole file. Settles whether the failure
   is task **size** rather than task **kind**.

**The third probe is already answered — do not run it.** *"Is it the whole-file return format?"*
**No.** All 30 files were **under** the rewrite ceiling, largest 18.9 KB, with **0 truncated and 0
unparsed**. The format caps what can be *reached* (that is 14c and ADR-0075); it is not why the
reachable ones failed.

## 3. The rule is frozen. Copy it, do not restate it.

`PHASES.md` § *14b* → *Exit check*. `S₁₄` is `null_guard` survival on the 30 tasks, **best of the two
probes**; baseline 1/30 = 0.033.

| | |
|---|---|
| `S₁₄ ≥ 0.30` | **INSERT `14b′`** — make whichever probe won the default, memory arithmetic re-done if it is the 14B |
| `0.10 ≤ S₁₄ < 0.30` | **PROCEED to 14c**, record the shape as *"improvable but not usable"* |
| `S₁₄ < 0.10` | **PROCEED to 14c**, and write the ceiling down as a product fact — `README` then says which shapes sidecrew is *for* rather than implying all of them |

`S₁₄ < 0.10` is **a complete result**, not a failed phase. Report it without going looking for a cut
of the data where it passes — the same sentence §2.2 earned.

## 4. How to run it without poisoning the number

Every one of these was learned expensively; `HANDOFF.md` § *Standing hazards* is the full list.

- **Start from a clean tree.** A `tsx` harness imports `../src/*.js` **from source**, so uncommitted
  edits compile into the run with nothing in any log to show it.
- **One measurement on the machine at a time**, nothing else running. Contention manufactures exactly
  the false negative that ADR-0066 is about — the measurement destroying its own instrument.
- **Report `S₁₄` as `k/30` with its exact interval**, never as a bare fraction. `scripts/results-11b.py`
  has `clopper_pearson`; use it rather than writing a second one. At `n = 30`, 3/30 and 6/30 have
  overlapping intervals, so the 0.30 threshold is a *decision* rule, not a claim of precision.
- **`D = 0.105` applies here too.** It was measured on #2a's gate, and this is #2a's gate.
- **A run crossing local midnight against a stale baseline can lose the whole run** (ADR-0069). The
  warning fires; do not ignore it.
- **project-a's suite needs its own node** (ADR-0049) and **`tsc` needs `--max-old-space-size`** on the
  large project (ADR-0032). `sidecrew doctor --project <dir>` now asks both before you start — read
  the `tsc-heap` and `jest-tests` rows rather than discovering them at minute forty.
- The checkout paths are in this project's memory directory under `~/.claude/projects/<slug>/memory/`,
  **never in a tracked file.** Two similarly-named checkouts on this machine are not these projects.

## 5. What "done" looks like

- `experiments/editing-ceiling/results/*.json` with `"measured": true`, machine info, the commit, both
  probes' per-task outcomes, `S₁₄` with its interval, and **the verdict §3 produced, named**.
- A `README.md` beside it with the rule **copied from `PHASES.md` before the run**, so the file itself
  shows the rule predates the number.
- An ADR if anything was decided; a line in `docs/CHANGELOG.md`; `PHASES.md` § *14b* status updated.
- **`docs/plan/HANDOFF.md` updated before you finish** — CLAUDE.md § *Conventions*. It is the first
  file the next session reads.
- `npm run lint && npm test` green. No product code should have changed; if it did, say why.
