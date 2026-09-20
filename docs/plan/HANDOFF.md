# Where we are — the standing handoff

**Read this first, then `VISION.md` → `ROADMAP.md` → `PHASES.md`.** This file is always current; if it
disagrees with anything else, it is the thing that was updated last and the other file is the bug
(CLAUDE.md § *Conventions*).

**Last updated: 20 Sep 2026**, end of the session that built Phase 14 — the three hardening items, the
release machinery, and every published rate restated as an interval.

*Verify before trusting it:* `git log -1 --format='%h %s'` should be the commit that last touched
this file. If later commits changed the phase state and this file was not among them, the rule in
CLAUDE.md was missed — trust `PHASES.md` and the ADRs over this page, and fix it.

---

## 1. State, in one table

| | |
|---|---|
| branch | `main`, clean, **0 client references in the tracked tree** |
| tests | `npm run lint && npm test` → **769 passing**, 1 skipped |
| version | **0.1.0** in `package.json`, `server.json` (twice), `plugin.json` **and `src/mcp.ts`** — four places, all checked by CI now |
| pushed | **no — `main` is well ahead of `origin/main`** (`git log --oneline origin/main..HEAD | wc -l`), including all of Phase 14 |
| published | `origin/main` is public and scrubbed. **Never push `private-history`; never merge it into `main`** |
| supported | **24 GB+ Apple Silicon, local tier only.** The `api` tier was descoped (ADR-0073) |
| next phase | **14c — the reach.** Blocked on **ADR-0075**. 14b is done. Three owner actions still precede the release, §3 |
| ADRs | run to **0077**; start new ones at 0078. **0064, 0075 and 0077 are PROPOSED and need the owner** |
| running | **nothing.** Both 14b probes finished 20 Sep; worker stopped, sandboxes swept, the checkout byte-identical before and after |

## 2. Phase 14 is built. The release is not cut.

**Everything in the DoD is on `main`:**

| | what it was worth |
|---|---|
| `deriveLineRange` reads the TypeScript AST (**ADR-0076**) | the scanner **missed 152 of 436** declarations in our own `src` and got **5 wrong**, all by cutting a body short. `typescript` is loaded from the project, never added as a dependency; `via` says which engine answered |
| `doctor`'s five pre-flight rows | ADR-0037's `include`, ADR-0038's shim, ADR-0032's heap, which range engine, and the fourth found this week: **`jest ok` on a suite that collects zero tests** |
| **ADR-0042** option 1 | a self-contradicting candidate is named instead of pasting a jest failure. No verdict, survival or score changes |
| every rate → **interval + `D`** | `D = 0.105` triggered UNACCEPTABLE, which forbids point estimates. Publishing `k/n` with exact Clopper–Pearson intervals **satisfies the frozen rule rather than amending it** |
| `release.yml`, `docs/` Pages site, `npm pack` | 87 files, 317.8 kB, allowlist clean; `doctor` verified out of the installed tarball, including the ADR-0076 fallback |

**What is deliberately not done, because it is the owner's:**

1. **Tag `v0.1.0` and push it.** Nothing publishes until a tag exists.
2. **Add `NPM_TOKEN`** to the repository's secrets. The registry needs no secret (OIDC); npm does.
3. **Turn GitHub Pages on** — Settings → Pages → `main` / `docs`. Adding the files does not turn it on.

**`release.yml` has never run.** Every step of its `gate` job was verified by hand locally — the
version agreement, the pack allowlist, `doctor` out of the tarball. Its **`npm` and `registry` jobs
are unverified** against the live services; the MCP publisher's asset URL and the `login github-oidc`
flow in particular are written from documentation, not from a green run. Expect to iterate on the
first tag, and tag a throwaway `v0.1.0-rc.1` first if that matters.

## 3. What to do next

**In this order.**

0. **Push `main`.** Nothing — tag, npm, Pages — can happen until it is. The pre-push scan CLAUDE.md
   #7 demands **was run on 20 Sep and was clean**: 0 hits over the *contents* of every object in
   `origin/main..HEAD`, not merely over the diffs, which is the distinction ADR-0051 was written
   about. **Re-run it for anything committed after that**, with the names from this project's memory
   directory:

   ```
   git rev-list origin/main..HEAD --objects | awk '{print $1}' \
     | while read o; do [ "$(git cat-file -t $o)" = blob ] && git cat-file -p $o; done \
     | grep -icE '<names>'
   ```
1. **The three owner actions above**, which cut the release.
2. **Phase 14's exit check runs for two weeks from the tag**, not from today. `F` = distinct
   *first-run* failures on projects outside `project-a`/`project-b`. `F ≤ 2` → 14b. `F ≥ 3` → insert
   `14a′`. **Any failure producing a *wrong verdict* rather than a refusal → STOP and fix**, whatever
   `F` is.
3. **Phase 14b is DONE, 20 Sep.** `S₁₄ = 2/30 = 0.067`, 95 % `[0.008, 0.221]`, both probes below
   0.10 → **PROCEED to 14c**. No code changed, no version cut. `experiments/editing-ceiling/`.

   **The question had a third answer, and it is the thing to carry forward.** Not the model, not the
   task size — both probes moved what they targeted (declines 17 → 3 on the 14B, 17 → 10 on the
   narrowed ask). It is the **gate's scope**. Every extra target a worker fixes correctly becomes an
   *unsatisfiable* task, one for one: +6 correct → +6 unsatisfiable on probe 2, +9 → +9 on probe 1.
   The sinking error is in a **test file in 21 of 21** cases and in non-test source in **0** — a
   narrowed type propagates into fixtures, and tests may not be edited because tests *are* the gate.
   **It gets worse as the worker gets better** (unsatisfiable 12 → 18 → 21), so buying more worker
   capability on this shape buys nothing measurable.

   **This needs the owner: ADR-0077 (proposed)**, four options, recommending option D first — one
   short run of the counterfactual, because 15 tasks had a clean target and only test-file errors and
   would have *reached* the suite under a differently scoped gate. Whether they survive it is the
   number every other option is betting on, and nobody has it.

   **It has a trap that would void it, and the prompt opens with it:** the 30 declared `null_guard`
   tasks live in `experiments/correction-round/plans/project-a-2026-09-20/change_plan.json`, which is
   **gitignored** (it carries an absolute path to the client's checkout) and therefore exists on the
   owner's machine and nowhere else. Comparability with the 1/30 baseline requires *those* 30 tasks.
   A regenerated set is a different experiment. If the file is gone, ask — do not rebuild it.

`14c` needs **ADR-0075** decided first and cannot start without it.

## 4. Open decisions, waiting on the owner

- **ADR-0075** — symbol-scoped return. **The one that unlocks the other half of the codebase**, and
  14c cannot start without it. Recommendation: option C. **ADR-0076 landed its prerequisite** — the
  AST range finder — so the cost of option C is lower than when it was written.
- **ADR-0064** — what #2a can address is a property of a project's *configuration*, not its code.
  Philosophical, blocks nothing, and the owner asked to discuss it.
- **A client symbol name is in the tracked tree, and on public `main`.**
  `getSpendVsReplacement` appears in five tracked files — a test comment, `BACKLOG`, `CHANGELOG` and
  `DECISIONS` — as the reduced case that ADR-0035 and ADR-0039 were written about. It is the client's
  code, not their name, and it survived the ADR-0051 allowlist rebuild. **It is already pushed, so
  removing it now does not retract it**, and rewriting those four documents costs the diagnostic
  history that makes them worth having. Flagged rather than fixed: the call is the owner's.

## 5. Standing hazards — all learned expensively

- **Stage explicit paths. Never `git add -A` or `git commit -a`.** Peer sessions share this worktree.
- **Scan every diff for the client's names before committing**, including context lines. The names to
  scan for are in this project's memory directory, never in a tracked file.
- **An import cycle here is a wrong number, not a crash.** `doctor` reaching into `plan.ts` closed
  `concurrency → serve → doctor → plan → verifier/ts → concurrency`, which under ESM made
  `DEFAULT_STRYKER_CONCURRENCY` **`undefined`**. One assertion written for a different reason caught
  it. `verifier/shared.ts` imports nothing of ours and is where a shared helper belongs.
- **The version lives in four places**, and the fourth (`src/mcp.ts`) was held only by one test. Both
  workflows check all four now.
- **`safeName` rewrites `snc-02#1` as `snc-02.1.json`.** A harness that re-derives a filename instead
  of using the writer's function reported `n₂ = 0` with a *plausible* reason and a confident, wrong
  INCONCLUSIVE.
- **A `tsx` harness imports `../src/*.js` from source**, so uncommitted edits compile into a run with
  nothing in any log to show it. Start runs from a clean tree.
- **Anything this tool truncates for display, it also truncates for diagnosis** — five defects of that
  shape now (the 1 MB `run` cap, ADR-0072, ADR-0074, ADR-0071's blind spot, and the scanner's own
  silence).
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
