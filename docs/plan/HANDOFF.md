# Where we are — the standing handoff

**Read this first, then `VISION.md` → `ROADMAP.md` → `PHASES.md`.** This file is always current; if it
disagrees with anything else, it is the thing that was updated last and the other file is the bug
(CLAUDE.md § *Conventions*).

**Last updated: 20 Sep 2026**, end of the session that took Phase 12's four measurements and phased
the road to the 90 % bar.

*Verify before trusting it:* `git log -1 --format='%h %s'` should be the commit that last touched
this file. If later commits changed the phase state and this file was not among them, the rule in
CLAUDE.md was missed — trust `PHASES.md` and the ADRs over this page, and fix it.

---

## 1. State, in one table

| | |
|---|---|
| branch | `main`, clean, **0 client references in the tracked tree** |
| tests | `npm run lint && npm test` → **710 passing**, 1 skipped |
| published | `origin/main` is public and scrubbed. **Never push `private-history`; never merge it into `main`** |
| supported | **24 GB+ Apple Silicon, local tier only.** The `api` tier was descoped (ADR-0073) |
| next phase | **14 — publish, cut `v0.1.0`.** No overnight run needed |
| ADRs | run to **0075**; start new ones at 0076. **0064 and 0075 are PROPOSED and need the owner** |
| running | **nothing.** No worker, no background run, no scratch process. Start a worker with `sidecrew serve` only when a phase needs one |

## 2. What is done, and what each thing is worth

Phase 12's measurement programme is **complete — four numbers, three of them negative**, each against
a rule frozen before the number existed:

| | result | where |
|---|---|---|
| §2.1 planning cost | `R = 2.84` at `N = 12`, **`1.07` at `N = 41`** — FAIL at both | `experiments/planner-cost/` |
| the gate's own error rate | **`D = 2/19 ≈ 0.105`** — UNACCEPTABLE | `experiments/gate-error-rate/` |
| §2.2 correction round | **`S_c = 0/29`** — OFF BY DEFAULT | `experiments/correction-round/` |
| ADR-0066 / ADR-0069 | accepted (C, A) and implemented — the verdict records what invalidates it | `src/schemas.ts` |

**The two findings that matter more than the verdicts:**

- **The 7B does not *attempt* `null_guard` work.** 1/30, and **16 of 17 returned the file unchanged
  again** after a note saying that returning it unchanged *was* the failure. Not wrong code — no code.
  That is why the correction round bought nothing, and it is a capability ceiling rather than a
  prompting problem.
- **Half a real codebase is unaddressable, and it is the half the work is in.** 3.3 % of files are
  **48.1 % of the bytes**, and every 1000+ line file is refused. That is the *return format*, not the
  model (ADR-0075).

## 3. What to do next

**Phase 14 — publish, `v0.1.0`.** One session, no machine. Its gates:

1. `deriveLineRange` reads the TypeScript AST — still a regex, patched four times, *"no mutants at
   all"* wrong every time. **Also the prerequisite for 14c**, so it pays twice.
2. `doctor` learns the pre-flight questions — and a fourth found this week: it reports `jest ok` on a
   project whose suite collects **zero tests** under the wrong node.
3. ADR-0042 — decided, never implemented.
4. **The owner's sentence**: §4.3 forbids publishing a survival rate as a bare point estimate until O8
   is diagnosed. Publishing them **as intervals with `D` beside them** satisfies the rule and costs
   nothing. That is the recommendation.

Then `14b → 14c → 14d` (`PHASES.md`), each ending with an **exit check whose fork is named in
advance**. 14's and 14b's rules are frozen; 14c's and 14d's are deliberately not, and should be frozen
before those phases start rather than now.

## 4. Open decisions, waiting on the owner

- **ADR-0075** — symbol-scoped return. **The one that unlocks the other half of the codebase**, and
  14c cannot start without it. Recommendation: option C.
- **ADR-0064** — what #2a can address is a property of a project's *configuration*, not its code.
  Philosophical, blocks nothing, and the owner asked to discuss it.

## 5. Standing hazards — all learned expensively

- **Stage explicit paths. Never `git add -A` or `git commit -a`.** Peer sessions share this worktree.
- **Scan every diff for the client's names before committing**, including context lines. Caught twice
  in this session alone: once in a results JSON (a run id is built from the project directory's name)
  and once in a code comment.
- **`safeName` rewrites `snc-02#1` as `snc-02.1.json`.** A harness that re-derives a filename instead
  of using the writer's function reported `n₂ = 0` with a *plausible* reason and a confident, wrong
  INCONCLUSIVE.
- **A `tsx` harness imports `../src/*.js` from source**, so uncommitted edits compile into a run with
  nothing in any log to show it. Start runs from a clean tree.
- **Anything this tool truncates for display, it also truncates for diagnosis** — four defects of that
  shape in eight days (the 1 MB `run` cap, ADR-0072, ADR-0074, ADR-0071's blind spot).
- **A run crossing local midnight against a stale baseline can lose the whole run**, not one task
  (ADR-0069). The warning now fires; the verdict records both timestamps.

## 6. Where the local projects are

**Not here, and never here.** The two real projects the experiments run against are a client's, and
CLAUDE.md #7 forbids naming them or their paths anywhere in this repository — *"local paths stay
local"*. They are `project-a` (NestJS + jest, ~2,160 `src` files) and `project-b` (React + jest, 764
specs), and that is all a tracked file may say.

The machine-local mapping — which checkout is which, and which node build their suites need — is in
this project's memory directory under `~/.claude/projects/<slug>/memory/`. A session that cannot
reach it should ask the owner rather than guess: two similarly-named checkouts on this machine are
**not** these projects, and running against the wrong one produces numbers that look fine.

*(This section was itself a near-miss: its first draft put the paths in a tracked file. That is the
third catch of this class in one session — the other two were a run id built from the project
directory's name, and a client directory name in a code comment.)*
