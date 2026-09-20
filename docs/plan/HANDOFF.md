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
| published | `origin/main` is public and scrubbed. **Never push `private-history`; never merge it into `main`** |
| supported | **24 GB+ Apple Silicon, local tier only.** The `api` tier was descoped (ADR-0073) |
| next phase | **14b — the editing ceiling.** But first: three owner actions, §3 |
| ADRs | run to **0076**; start new ones at 0077. **0064 and 0075 are PROPOSED and need the owner** |
| running | **nothing.** No worker, no background run, no scratch process |

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

1. **The three owner actions above**, which cut the release.
2. **Phase 14's exit check runs for two weeks from the tag**, not from today. `F` = distinct
   *first-run* failures on projects outside `project-a`/`project-b`. `F ≤ 2` → 14b. `F ≥ 3` → insert
   `14a′`. **Any failure producing a *wrong verdict* rather than a refusal → STOP and fix**, whatever
   `F` is.
3. **Phase 14b — the editing ceiling**, whose rule is already frozen (`PHASES.md`). It is the phase
   that buys **Shapes**, the one scorecard number nobody has measured and the expensive one.

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
