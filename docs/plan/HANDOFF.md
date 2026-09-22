# Where we are — the standing handoff

**Read this first, then `VISION.md` → `ROADMAP.md` → `PHASES.md`.**

> **The direction, so no session drifts from it.** Opus receives a task and **plans a session to
> gather the info needed**; workers read and report; **Opus asks the user** where a machine cannot
> decide; Opus plans on the answer; workers act; the loop repeats **until a machine-checkable
> definition of *satisfied*** is met. That is `VISION.md`'s philosophy and the owner's own framing
> (20 Sep 2026). **`PHASES.md` § *The framework these phases are building toward* is the table of
> which phase makes which step true** — read it before planning 14c or 14d. ADR-0079 is the write-up;
> ADR-0075 (accepted) is the *act on any file* half; 14d is the *read and ask* half.

This file is always current; if it disagrees with anything else, it is the thing that was updated
last and the other file is the bug (CLAUDE.md § *Conventions*).

**Last updated: 22 Sep 2026** — overnight, on an idle machine the owner handed over. **The headline is
ADR-0084: `D` is the suite's flake rate, not the gate's.** 50 runs of an unmodified suite found 11
tests each failing once, and `3/50 = 0.060 [0.013, 0.165]` against `D`'s `2/19 = 0.105 [0.013, 0.331]`
— indistinguishable. The mitigation (re-run once before recording a regression-only failure) is
**proposed and needs the owner**. Measured that
`project-a`'s **unmodified** suite moves three tests at **00:00 UTC**, which exposed **ADR-0083**:
`crossesCalendarDay` watched local midnight only, and so did its Python copy and its own test. Fixed.
A 55-run control across a boundary-free window is in §3 § *Start here*. **ADR-0082 option D could not
be run — stryker is installed in neither tree**, and that is an owner decision.

**Last updated: 21 Sep 2026.** That session, in order: re-ran the `v0.1.0` release and found three
defects in the pipeline, then two more (**ADR-0080**); **published `0.1.2` to npm and the MCP
Registry**, which is Phase 14 finished; found and fixed **a hole in the gate** — `*.e2e-spec.ts` was
not a test file to any of the four copies of the rule that says what one is (**ADR-0081**); **measured
ADR-0077's option D at `14/15`**, retiring A and C and putting **B in front of the owner**; and wrote
**ADR-0082** from the owner's proposal, *sidecrew writes the oracle it is judged by*.

The session before it got `main` green for the first time since 18 Sep, took three owner decisions
(**ADR-0075** option C, **ADR-0078**, the ADR-0064 discussion) and wrote **ADR-0079**.

*Verify before trusting it:* `git log -1 --format='%h %s'` should be the commit that last touched
this file. If later commits changed the phase state and this file was not among them, the rule in
CLAUDE.md was missed — trust `PHASES.md` and the ADRs over this page, and fix it.

---

## 1. State, in one table

| | |
|---|---|
| branch | `main`, clean, **0 client references in the tracked tree** |
| tests | `npm run lint && npm test` → **774 passing**, 1 skipped |
| version | **`0.1.2`** — all six places move together (`package.json`, `server.json` ×2, `plugin.json`, `src/mcp.ts`, `package-lock.json` ×2), `dist` rebuilt. `ci.yml` checks four of the six, `release.yml` five; **the lockfile is checked by neither** |
| pushed | **yes, and routinely now.** Every push is preceded by a blob-contents scan over `origin/main..HEAD`; it has caught a real leak twice, most recently **21 Sep, in this file, from pasting a `.sidecrew/runs/` path** — those directory names are built from the project's own name, §5. Tags: `v0.1.0-rc.1`, `-rc.2` (both failed, published nothing), `v0.1.0`, `v0.1.1`, `v0.1.2` |
| published | **DONE, 21 Sep. `sidecrew@0.1.2` is on npm as `latest` with a SLSA provenance attestation, and `io.github.lvlrSajjad/sidecrew` is active on the MCP Registry at `0.1.2`.** Published by the workflow over Trusted Publishing — no token exists anywhere. `0.1.0` (hand-published, **unsigned, cannot gain an attestation**) and `0.1.1` are also on npm. **GitHub Pages is on.** `origin/main` is public and scrubbed. **Never push `private-history`; never merge it into `main`** |
| supported | **24 GB+ Apple Silicon, local tier only.** The `api` tier was descoped (ADR-0073) |
| next phase | **14c — the reach. UNBLOCKED and nothing is queued ahead of it.** ADR-0075 accepted (option C) 20 Sep; 14b done; Phase 14 published; ADR-0077's counterfactual done. **§3 § *Start here* lists the live options in cost order** — 14c is the default, and two owner decisions and one short run sit beside it |
| ADRs | run to **0085**; start new ones at 0086. **0084's mitigation needs the owner.** **Four need the owner: 0082, 0077-B, 0079, 0064** — §4, in that order. 0077's option D is **measured** (14/15), so A and C are retired and **B is the live question**; 0082 is the owner's own proposal and its option D is one short run. 0079 largely retires 0064. Accepted this week: 0075 (option C), 0078, 0080, 0081 |
| running | **nothing locally.** Both 14b probes finished; worker stopped, sandboxes swept, the checkout byte-identical before and after |
| CI | **GREEN on `main`** — `test (20)`, `test (22)` and `contracts` all pass. Red from 18 Sep to 20 Sep; **three** causes, not the two that had been diagnosed, §3.0. Nothing product-side changed |
| `gh` | authenticated **per tree**, not globally: `~/Coding/ME/*` → `GH_CONFIG_DIR=~/.config/gh-personal`. A zsh `chpwd` hook exports it; a **bash** shell never runs the hook, so set it explicitly |

## 2. Phase 14 — PUBLISHED. How it got there, and what each step cost.

> **Everything in this section is done.** `sidecrew@0.1.2` is on npm with provenance and
> `io.github.lvlrSajjad/sidecrew` is active on the MCP Registry. It is kept in full because the
> pipeline cost **five defects of five different shapes in one day** and the next release meets the
> same machinery. **Nothing below is an instruction** — it is a record, and some of it is written in
> the tense it was written in.

**Everything in the DoD is on `main`:**

| | what it was worth |
|---|---|
| `deriveLineRange` reads the TypeScript AST (**ADR-0076**) | the scanner **missed 152 of 436** declarations in our own `src` and got **5 wrong**, all by cutting a body short. `typescript` is loaded from the project, never added as a dependency; `via` says which engine answered |
| `doctor`'s five pre-flight rows | ADR-0037's `include`, ADR-0038's shim, ADR-0032's heap, which range engine, and the fourth found this week: **`jest ok` on a suite that collects zero tests** |
| **ADR-0042** option 1 | a self-contradicting candidate is named instead of pasting a jest failure. No verdict, survival or score changes |
| every rate → **interval + `D`** | `D = 0.105` triggered UNACCEPTABLE, which forbids point estimates. Publishing `k/n` with exact Clopper–Pearson intervals **satisfies the frozen rule rather than amending it** |
| `release.yml`, `docs/` Pages site, `npm pack` | 87 files, 317.8 kB, allowlist clean; `doctor` verified out of the installed tarball, including the ADR-0076 fallback |

**The owner's four actions are all DONE as of 21 Sep** — kept below because each one cost a measured
finding, and a future release will need them again. What is *not* done is the MCP Registry entry, §3.0′.

1. ~~**Publish `0.1.0` to npm by hand**~~ — **DONE.** It had to come first, and that is the durable
   part: **Trusted Publishing cannot be configured for a package that does not exist.**
   **Trusted Publishing cannot be configured for a package that does not exist.** Measured on
   21 Sep: `npm trust github sidecrew --file release.yml --allow-publish` prompts, **takes the 2FA
   code**, and only then fails
   `npm error 404 Not Found - POST https://registry.npmjs.org/-/package/sidecrew/trust`. The CLI
   validates existence *after* authenticating, so reaching the prompt proves nothing — do not read it
   as progress. *(At the time of writing, `sidecrew` was a 404 and the name was unclaimed.)*
2. ~~**Then configure npm Trusted Publishing**~~ — **DONE.** **Not** a token; npm is ending token publishing, so
   there is no secret to add to this repository at all. Either `npm trust github sidecrew --file
   release.yml --allow-publish` (needs npm ≥ 11.5.1 — the machine is on **11.19.1** as of 21 Sep) or
   npmjs.com → the package → Settings → Trusted Publisher → GitHub Actions, with
   org `lvlrSajjad`, repo `sidecrew`, workflow `release.yml`, **environment blank** (`release.yml`
   declares none), allowed action `npm publish`. Until that entry exists the *workflow's* publish
   fails `ENEEDAUTH`, **which looks exactly like a missing token and is not one.**
   `~/Coding/ME/simframe` publishes this way and its `release.yml` is the reference.
3. ~~**Turn GitHub Pages on**~~ — **DONE, 21 Sep.**
4. ~~**Tag `v0.1.0`**~~ — **DONE, and moved once.** The tag was first cut at `962d6a3`, one commit
   *before* the tarball-smoke fix, so it replayed the same `gate` failure; it was deleted and re-cut at
   `b0f7a85`. **`release.yml` has no `workflow_dispatch` trigger** — only `on: push: tags` — so
   `gh workflow run release.yml --ref <tag>` does not work, and delete-and-re-push is the only re-run
   path. An earlier version of this file said otherwise; that was wrong. The `npm` job's
   already-published **skip** arm turned out to be unreachable dead code (ADR-0080), so the
   "hand-publish then tag" path was never actually exercised the way it was designed.

**`release.yml` ran for the first time on 20 Sep**, twice, and **both runs failed** — which is the
whole reason to have tagged a release candidate rather than `v0.1.0`.

| tag | got as far as | what it found |
|---|---|---|
| `v0.1.0-rc.1` | died at step 1 of `gate` | **a false pass in the version check**, below |
| `v0.1.0-rc.2` | `gate`: version ✓ schema ✓ lint ✓ · **`npm test` ✗** | **CI has been red since 18 Sep**, §3.0 |

**The publish path was also wrong in a way no tag would have revealed, and is now ported from
`~/Coding/ME/simframe`, which publishes this way today.** npm is ending token publishing, so
`NPM_TOKEN` was never going to be the answer; the job now authenticates by **Trusted Publishing**
over the workflow's own OIDC identity. Three things came with it, each of which cost simframe a
release to learn:

- **npm must be upgraded to `>=11.5.1 <13`, and Node must be 22.** Trusted Publishing is not
  recognised by older npm, and npm 12 requires Node >= 22. simframe pinned Node 20, npm 12 shipped
  between two releases a day apart, and the upgrade died with `EBADENGINE` *before* the publish step
  — so a version was tagged, released on GitHub, and **never published**, silently. The range, not
  `@latest`, is the fix: `@latest` is a clock in the pipeline rather than a version.
- **`mcp-publisher` is pinned** (`v1.8.1`), not floated to `releases/latest`. It runs in a job
  holding `id-token: write`. It also `validate`s `server.json` before publishing.
- **An already-published version is a skip, not a failure**, so a hand publish followed by a tag does
  not stop the run before the registry step.

Nothing was published by either rc. **All three unknowns named here were resolved on 21 Sep**: npm
Trusted Publishing authenticated, `--provenance` wrote a SLSA statement to the sigstore transparency
log, and the registry's `login github-oidc` reported `✓ Successfully logged in`. §3.0′ has what it
took.

**The version check had a false pass, and it is the one the workflow's own comment calls the failure
a second release cannot fix.** It extracted `src/mcp.ts`'s version with
`grep -oE '[0-9]+\.[0-9]+\.[0-9]+'`, which silently drops a prerelease suffix **from one side of the
comparison**: tagging `v0.1.0` against an `mcp.ts` still reading `0.1.0-rc.1` extracts `0.1.0`, the
comparison succeeds, and npm gets a release whose MCP server announces itself to every client as a
release candidate. Fixed — it takes the string literal whole, and both shapes are verified.

**Reading the workflow before tagging found two more, both of which only bite on a prerelease, both
now fixed, and neither of which the gate would ever have caught:**

- `npm publish` had **no `--tag`**, and npm writes `latest` when none is given — *including for a
  prerelease*. `v0.1.0-rc.1` would have made `npm i sidecrew` serve a release candidate to everyone.
  The dist-tag is now derived from the version's shape: anything with a hyphen goes to `next`.
- The **`registry` job would have published the rc as the entry MCP clients resolve** the server name
  to. It carries no dist-tag and there is no way to mark an entry provisional, so it is releases-only
  now.

## 3. What to do next

### Start here — everything live, in cost order

**Nothing is blocked and nothing is half-finished.** Phase 14 is published, CI is green, the tree is
clean. Items **0 → 2** below are completed work, kept because each cost a finding; **they are history,
not a queue.** These are the live options:

| | what | cost | needs |
|---|---|---|---|
| **A** | **Phase 14c — symbol-scoped return** (ADR-0075, accepted). Half a codebase is unaddressable and it is the half the work is in | 2–3 sessions · **one overnight run** | nothing. **Freeze its exit check before starting**, §PHASES |
| **B** | **Decide ADR-0084's mitigation** — re-run the suite once before recording a regression-only failure | a decision, then a `ChangeVerdict` change | the owner. Measured: project-a's suite fails 11 tests at **3/50** of runs, indistinguishable from `D`. project-b showed 0/15, which **cannot** distinguish 0 % from 6 % — that arm needs ~50 runs, ~3.5 h |
| **C** | **Decide ADR-0077 option B** — the gate accepts a test file that no longer type-checks but still passes | a decision, then an implementation | the owner. Measured at **14/15** |
| **D** | **Decide ADR-0082** in principle — manufacture the oracle instead of borrowing it | a decision | the owner |
| **E** | **ADR-0082 option D** — the yield of tests that kill a mutant **inside a named line range** | one run | **BLOCKED: stryker is installed in neither tree.** Adding `@stryker-mutator/core` is the owner's call — a devDependency in a client repo, or a new one here |
| **F** | **Phase 14's exit check** — passive, §3.3. Window ends **5 Oct 2026** | watching | nothing |

**If no one says otherwise, do A.** It is the largest capability gain available, it is unblocked, and
it is the only item whose absence blocks anything else.

**The one run worth doing unattended next:** 50 runs of project-b's suite (`scripts/suite-reproducibility.sh`
with `PLAN` pointing at a project-b plan and `OUT` set), ~3.5 h, no worker and no model. It closes
ADR-0084's only open caveat — whether the 6 % floor is project-a's or everyone's.

**Three decisions (B, C, D) are stacked and none blocks another.** B is the cheapest and rests on the
firmest number. C is measured and ready. D is the biggest idea and its measurement is E, which is the
one thing here that needs a dependency decision before it can run at all.

**Do not start 14c or 14d against a stale plan** — `PHASES.md` § *The framework these phases are
building toward* is the table of which phase makes which step of the vision true, and it has a row for
ADR-0082.

---

### This week's completed work, kept for what each one cost

**0. Fix CI — DONE, 20 Sep.** `main` is green on `d71edbe`: `test (20)`, `test (22)` and
`contracts` all pass. It had been red on every push since at least 18 Sep and went unnoticed because
nobody looked — the local suite was green at 769 passing and `release.yml` had never run. No product
code changed; the whole fix is two test files and one workflow.

**There were three causes, not the two that had been diagnosed**, and the third had been missed
because the diagnosis read only the `test` job's log and never the `contracts` job's:

- **The 24 GB floor refused the runner.** `assertSupportedMachine` (ADR-0073) throws below 24 GB and a
  GitHub macOS runner has 7.0. Five `runBatch` tests died on it. They now pass `workerKind: "local"`,
  the bypass that function's own docstring blesses for a harness — the tests move off the floor and
  the floor does not move. **Whether `--dry-run` should be subject to the floor at all is a product
  question, it is still open, and a test fix was the wrong place to answer it.** It is written up in
  `BACKLOG.md`, with the note that `SIDECREW_TIER=api` is not the answer.
- **One test asserted on ambient state.** `test/serve.test.ts`'s *"finds the nearest .sidecrew…"*
  expected `sidecrewDir(process.cwd(), {})` to end in `.sidecrew`, which holds only once somebody has
  run sidecrew in this tree. It builds its own tree now.
- **`ci.yml`'s version check had the truncating grep `release.yml` had just been fixed for.** It
  extracted `src/mcp.ts` with `grep -oE '[0-9]+\.[0-9]+\.[0-9]+'`, dropping the prerelease suffix,
  and compared `0.1.0` against a `package.json` correctly reading `0.1.0-rc.2`. Nothing was out of
  step. **The fix landed in `release.yml` in `4ac0f8c` and was not carried across**, which is the
  lesson worth keeping: the two workflows duplicate this check and a fix to one is not a fix to both.

**The first two were found by tagging the rc, which is what the rc was for. The third was found by
pushing the fix for the first two and reading the job that had never been read.**

**Two things this left behind, neither of them blocking:**

- **`package-lock.json` is a fifth version place that neither workflow gates.** `release.yml` compares
  the tag against five values and `ci.yml` compares four; the lockfile is in neither, and it is the
  one that was found reading `0.0.1` while the others had moved.
- **The verification that matters here is against the runner's conditions, not the developer's** —
  that is the whole class of bug. Both were checked that way before pushing: the floor bypass
  exercised directly at `total_gb: 7.0`, and both test files run green in a tracked-files-only copy of
  the tree with no `.sidecrew` in it.

**0′. The release is DONE — nothing here is owed.** `sidecrew@0.1.2` is on npm as `latest`, signed;
`io.github.lvlrSajjad/sidecrew` is active on the MCP Registry at `0.1.2`. Kept as a section because the
pipeline cost **four defects in one day, of four different shapes**, and the next release will meet the
same machinery. ADR-0080 and its addendum are the write-up.

| what failed | shape | fixed by |
|---|---|---|
| `server.json` pinned to a superseded schema | a check reading its expectations **out of the artefact under test** | `2025-12-11` + camelCase; `mcp-publisher validate` moved **into the gate** |
| `npm publish \| tee` reported failure as success | a shell **pipeline's status is its last command's** | capture the status, branch on it |
| the suite ran on Linux, where it had never run | a gate on **a platform we do not ship to** | `npm` job on `macos-latest` |
| `package.json` had no `mcpName` | the registry validates the **published package**, which cannot be asked before publishing | a local copy of its rule, in the gate, knowingly (addendum) |
| the registry 404'd a version npm had just accepted | **a race between two systems with no shared clock** — fails *sometimes* | the job polls npm before claiming the entry |

**Three flows are now proved that never had been:** npm Trusted Publishing, `--provenance` (a SLSA
statement in the sigstore transparency log) and the registry's `login github-oidc`.

**Two things worth keeping for next time.** `release.yml` has **no `workflow_dispatch`** — only
`on: push: tags` — so `gh workflow run --ref <tag>` does not work; **`gh run rerun <id> --failed`**
re-runs one job against the same tag and is what got past both transient failures without tag churn.
And the `npm` job's already-published **skip** arm has still never executed, because every release so
far published a new version.

**1. The owner actions are all done.** Pages is on, Trusted Publishing is registered, and the
versions are at **`0.1.2`** — `0.1.0` was hand-published (unsigned), `0.1.1` and `0.1.2` by the
workflow with provenance. `v0.1.0-rc.1` and `-rc.2`
both failed and published nothing. What remains of the release is §3.0′, and it is not an owner action
— it is a commit, a push and a re-cut tag.

**2. ADR-0077's counterfactual — DONE, 21 Sep. `14/15`, and option B needs the owner.**

| | k/n | 95 % exact |
|---|---|---|
| the counterfactual | **14/15** | **[0.681, 0.998]** |
| `S₁₄`, unchanged | 2/30 | [0.008, 0.221] |

**All 15 reached the suite; 14 passed it.** The intervals do not overlap, which is what makes it an
answer. Every one of the 15 demoted exactly one error and all 15 were in a test file, re-measured from
a fresh `tsc`. On the same 30 a B-shaped gate scores **16** — the other 14 fail for reasons a
test-file demotion does not touch. **That is a counterfactual and `S₁₄` stays `2/30`.**
`experiments/editing-ceiling/results/adr-0077-counterfactual-2026-09-21.json`.

**The one failure is the finding to carry.** `snc-27` failed with 82 regressions and **passed a second
reading of the same bytes with 0** — same baseline to the test, machine `pressure: normal` and swap
flat on both sides of both verdicts. **A third instance of the gate disagreeing with itself, and the
first where pressure is excluded rather than suspected** (ADR-0066 addendum, 21 Sep). It is reported
as 14/15 — the *failing* reading — because taking the better of two is what ADR-0066 forbids, and the
conclusion holds either way.

**Recommendation: B, and the measurement names B's own weak point.** B gates on the tests *still
passing* rather than still type-checking; `snc-27` is that clause disagreeing with itself inside an
hour on an idle machine. B moves weight off a deterministic check onto a non-deterministic one, so
**characterising `D` on a corpus where pressure is excluded is now on the critical path to B** rather
than a loose end. **A is retired** by the number — it would write off work the gate can be shown to
credit. **C is retired more firmly**: it would have pre-filtered away all 15, 14 of which pass.

**How to re-run any of it.** `scripts/adr-0077-counterfactual.sh` (~80 min, no worker, no model) and
`--only <task_id>` for a single-task second opinion (~8 min). Both take the project path from the
plan's `project` field and refuse to write a payload containing any segment of it.

**But it will not reproduce as-is, and this is the thing to know before trying.** Both runs described
`project-a` at **`77953e627f`**; that checkout was **pulled forward 50 commits at 16:24 the same day**,
about 1.5 hours after the second run finished. A replay today describes a different tree and is not
comparable with probe 1's. Check the project out at that commit first.
**Neither result file records the commit** — the harness does now, and refuses to start on a dirty
tree, but the two existing files predate the field and were deliberately **not** back-filled. What
ties them to one tree is that three independent baseline captures agree exactly at 6159/6368 passing
and 11,412 `tsc` errors. `experiments/editing-ceiling/README.md` has it written down.

**What ADR-0081 cost, and why it was not optional.** The first attempt was stopped at task 1 of 15:
the gate did not think `*.e2e-spec.ts` was a test file, so nothing was demoted and the run would have
answered *0 of 15* for a reason unrelated to the question. See §2 of ADR-0081 for why fixing the gate
first is not what ADR-0077's first constraint forbids.

**3. Phase 14's exit check runs for two weeks from the real tag — `v0.1.2`, 21 Sep 2026, so the
window ends 5 Oct 2026.** Not from an rc and not from today.
`F` = distinct *first-run* failures on projects outside `project-a`/`project-b`. `F ≤ 2` → fine.
`F ≥ 3` → insert `14a′`. **Any failure producing a *wrong verdict* rather than a refusal → STOP and
fix**, whatever `F` is.

**Phase 14b is DONE, 20 Sep.** `S₁₄ = 2/30 = 0.067`, 95 % `[0.008, 0.221]`, both probes below 0.10 →
**PROCEED to 14c**. No product code changed. `experiments/editing-ceiling/`.

**The question had a third answer, and it is the thing to carry forward.** Not the model, not the task
size — both probes moved what they targeted (declines 17 → 3 on the 14B, 17 → 10 on the narrowed ask).
It is the **gate's scope**. Every extra target a worker fixes correctly becomes an *unsatisfiable*
task, one for one: +6 correct → +6 unsatisfiable on probe 2, +9 → +9 on probe 1. The sinking error is
in a **test file in 21 of 21** cases and in non-test source in **0** — a narrowed type propagates into
fixtures, and tests may not be edited because tests *are* the gate. **It gets worse as the worker gets
better** (unsatisfiable 12 → 18 → 21), so buying more worker capability on this shape buys nothing
measurable, and `14b′` would have been the wrong insert even had the threshold been met.

**The 30 declared tasks are gitignored and exist on one machine** —
`experiments/correction-round/plans/project-a-2026-09-20/change_plan.json`. Comparability with the
1/30 baseline requires *those* 30. A regenerated set is a different experiment. **If the file is gone,
ask — do not rebuild it.** The decomposed variant probe 2 used is beside it under
`experiments/editing-ceiling/plans/`, also gitignored, and is reproducible with
`scripts/editing-ceiling-decompose.ts`.

`14c` needs **ADR-0075** decided first and cannot start without it.

## 4. Open decisions, waiting on the owner

- **ADR-0082 — sidecrew writes the oracle it is judged by (proposed, 21 Sep, the owner's own
  proposal).** Every step of the loop but two is already `VISION.md`'s; **the delta is that the oracle
  stops being borrowed from the project and starts being manufactured** — the worker writes tests
  covering the region about to change, gated by workload #1, *before* the change exists. It is not
  circular: the ordering plus ADR-0016's gate pins the test to the old behaviour before there is a
  change to accommodate. **For #2b it is the first candidate oracle that has ever existed**, which is
  the part worth the owner's time.
  **Recommendation: D, then B, then C.** D is one short run — the yield of asking a worker for tests
  that kill a mutant **inside a named line range** (ADR-0013 already scopes mutation that way).
  Workload #1's *untargeted* yield on real projects is 3/8, 4/8, 4/10, so the targeted number is what
  every version of this rests on and nobody has it. **Freeze D's rule before running it.**
  Does not block, and does not block ADR-0077-B either; that one is the cheaper win and is available
  now.

- **ADR-0084's mitigation — re-run the suite once before recording a regression-only failure.**
  Measured overnight: this project's suite fails 11 tests intermittently, at **3/50 = 0.060**
  `[0.013, 0.165]` of runs — statistically indistinguishable from `D = 2/19 = 0.105` `[0.013, 0.331]`.
  **So `D` was most likely never the gate's error**; `verifyChange` reported what it saw and the suite
  moved underneath it.
  **The mitigation is free on the happy path** (only a candidate that already failed on `tests_ok`
  pays), **cannot rescue a candidate that genuinely breaks tests** (those break twice), and is the
  standard already applied by hand to `snc-27`. **Against:** it makes a verdict a function of two runs,
  which is a `ChangeVerdict` contract change, and a 6 % floor is a property of *this* project.
  Recommendation: **do it, behind a flag defaulting on, recording both readings rather than collapsing
  them** — ADR-0066's rule is that the recorded disagreement is the output, not the better number.
  **It does not block ADR-0077 option B and B does not block it**; B adds no exposure to the suite that
  today's gate does not already have.
- **ADR-0077 option B — MEASURED and waiting on a yes or no.** Should the gate accept a change whose
  only remaining problem is a **type error in a test file**, provided every test still *passes*?
  Measured 21 Sep: **14 of 15** such changes pass the project's own suite, 95 % `[0.681, 0.998]`,
  against `S₁₄`'s `[0.008, 0.221]` — **the intervals do not overlap.** On the same 30 tasks a B-shaped
  gate scores **16** where today's scores 2.
  **A and C are retired** by that number. **What B costs** is the gate's simplest sentence: *"the
  tests were not touched, at all"* becomes *"the tests still pass, though some no longer type-check"*.
  **And the same run named B's own weak point** — `snc-27` failed with 82 regressions and passed a
  second reading of the same bytes with 0, on an idle machine. B leans the gate onto the clause that
  did that, so **characterising `D` where pressure is excluded is on B's critical path**, §ADR-0066
  addendum. Recommendation: **yes in principle, and find out what causes the 82-vs-0 before shipping
  it.** ADR-0082 would make B matter less but does not replace it.
- **ADR-0075 — DECIDED 20 Sep: option C, symbol-scoped return.** The worker returns one
  declaration's new text and sidecrew splices it back by AST range, so the bound becomes the *symbol*
  rather than the file and a 60-line method inside a 4,000-line service comes into reach. **ADR-0076
  had already landed its prerequisite**, the AST range finder, so 14c can start on it directly.
  Nothing further is owed here; it is listed only so the next session does not re-open it.
- **ADR-0079 — recon before planning + the framework it belongs to** (addendum, 20 Sep). The owner's
  generalised loop — Opus plans a gathering session, workers report, Opus asks the user, workers act,
  repeat — **is `VISION.md`'s philosophy section and `BACKLOG` edge idea 1 (Phase 13b)**, which still
  owes its own ADR. Target: planning is **233,500 fixed tokens, 68 % of the total even at 41 tasks**,
  overwhelmingly Opus *reading*. Open problem, in the vision's words: *existence is checkable by
  machine; relevance is not*. The owner's *"ask the user"* step is a candidate answer — the **user as
  relevance oracle** — and the constraint is that each cycle must be batched and cheap, or the loop
  pays the 68 % `n` times. The proposal proper: sidecrew reports *"your
  config says 0 errors, `--strictNullChecks` says 763 files — want to fix them?"*, fixes them, then
  offers to turn the flag on. Recommendation: **A now** (recon only), **B next** (fix, scoped to
  shapes that survive today), **C once ADR-0077 is decided**, never D. The blocker on C is honest and
  specific: on the flagship example the gate currently clears 2/30, so recon-then-fix would quantify
  work the tool cannot do. **It also supplies the consent argument ADR-0077 option B was missing.**
- **ADR-0064** — what #2a can address is a property of a project's *configuration*, not its code.
  Philosophical, blocks nothing, and the owner asked to discuss it. **Largely retired by ADR-0079**:
  recon makes the fact a behaviour rather than a caveat, so B and C here matter much less. Discussed
  20 Sep; the standing recommendation is **B now, C not yet** — `strictNullChecks` migrations are
  exactly where ADR-0077 says the gate cannot credit the work, though `noUnusedLocals`-style
  raised-bar work does survive and a narrower C could be defended on it.
- **The personal site's employer/testbed inference — handled 21 Sep.** `lvlrsajjad.github.io` names
  the employer on its homepage (`worksFor`, and an experience entry) and described sidecrew's
  measurements as taken on *"commercial"* codebases *"neither of them mine"*. Fine apart; together an
  inference nobody decided to publish. **Owner's call: drop "commercial"** — it breaks the chain and
  costs nothing, because *"not written by me, not modified to make this work"* is what makes the
  measurement honest and is equally true of an open-source codebase. Done in three files, committed,
  **not pushed** — that repo is the owner's. **sidecrew's own `docs/` site deliberately keeps
  "commercial"**: it names no employer, so the word carries no inference there, and CLAUDE.md blesses
  it as exactly as strong a claim as naming the client and publishable.
- **A client symbol name is in the tracked tree, and on public `main`.**
  `getSpendVsReplacement` appears in five tracked files — a test comment, `BACKLOG`, `CHANGELOG` and
  `DECISIONS` — as the reduced case that ADR-0035 and ADR-0039 were written about. It is the client's
  code, not their name, and it survived the ADR-0051 allowlist rebuild. **It is already pushed, so
  removing it now does not retract it**, and rewriting those four documents costs the diagnostic
  history that makes them worth having. Flagged rather than fixed: the call is the owner's.

## 5. Standing hazards — all learned expensively

- **Stage explicit paths. Never `git add -A` or `git commit -a`.** Peer sessions share this worktree.
- **The pre-push scan stopped a real leak on 20 Sep, and the leak was in a *safety check*.** An
  intermediate commit of `scripts/results-14b.py` spelled the client's names out in a denylist — the
  check meant to prevent exactly that. A later commit fixed the file, **which does not help**: the
  blob is still in the history a push would send (ADR-0051). It was scrubbed by `git filter-branch`
  over the 9 unpushed commits, replacing the literal names with an environment read, and
  `prepush-backup-14b` still points at the pre-rewrite HEAD if anything looks wrong.
  **Two lessons.** Scan **blob contents over `origin/main..HEAD`**, never the diffs — a diff-only
  scan would have missed this, because the names arrive and leave inside the range. And when the
  aggregate scan and a per-blob loop disagree, **believe the one that found something** and keep
  looking: `git grep -i <names> $(git rev-list origin/main..HEAD)` is what located the commit.
- **A `.sidecrew/runs/` directory name contains the project's name, so pasting a run path into a
  tracked file leaks the client.** Caught 21 Sep by the pre-push scan, in `HANDOFF.md`, written by
  the session that was documenting the scan. `.sidecrew/` is gitignored (`.gitignore:3`) and nothing
  under it is tracked, so the *files* are safe — **the hazard is quoting a path, not committing one**.
  Refer to a run as `probe1-report.json`'s `run_dir` instead of reproducing it. The commit was
  unpushed, so `git commit --amend` removed the blob from the range before it could travel; that only
  works **before** a push (ADR-0051).
- **`gh` is authenticated per tree, not globally** (several orgs). `~/Coding/ME/*` and `OSS/*` →
  `~/.config/gh-personal`; `Coding/ET/*` → `gh-et`; `RZT/*` → `gh-rzt`; anything else → an empty
  `gh-none` that fails loudly. A zsh `chpwd` hook exports `GH_CONFIG_DIR`, so **a bash shell has to
  set it explicitly** or `gh` reports "not authenticated".
- **Scan every diff for the client's names before committing**, including context lines. The names to
  scan for are in this project's memory directory, never in a tracked file.
- **An exception in a `finally` replaces the value the block was returning**, so a sandbox teardown
  that throws destroys a verdict that was already computed (ADR-0085). `rm`'s `force` covers `ENOENT`
  and **not** `ENOTEMPTY`, which is what a jest worker outliving its run produces. Two measurements on
  two projects both died at run 9 on it. Every teardown goes through `removeSandbox` now; do not spell
  the options again at a new call site.
- **An import cycle here is a wrong number, not a crash.** `doctor` reaching into `plan.ts` closed
  `concurrency → serve → doctor → plan → verifier/ts → concurrency`, which under ESM made
  `DEFAULT_STRYKER_CONCURRENCY` **`undefined`**. One assertion written for a different reason caught
  it. `verifier/shared.ts` imports nothing of ours and is where a shared helper belongs.
- **The version lives in five places**, and `src/mcp.ts` was once held only by one test. `release.yml`
  checks five and `ci.yml` four; **`package-lock.json` is gated by neither**, and it is the one found
  reading `0.0.1` while the rest had moved. **The two workflows duplicate this check, and a fix to one
  is not a fix to both** — the truncating-grep fix landed in `release.yml` on 20 Sep and sat broken in
  `ci.yml` until the next push, where it failed `contracts` in the opposite direction.
- **A shell pipeline reports its LAST command's status, so `cmd | tee log` always succeeds.** It hid a
  failed `npm publish` behind a green step in the one job that publishes irreversibly (ADR-0080), and
  the error-handling branch below it had been unreachable dead code since it was written. `set -o
  pipefail` would have caught it; capturing the status into a variable is what the workflow does now,
  because it also has to read the log either way.
- **A check that reads its expectations out of the artefact under test can only catch invalidity,
  never staleness.** The release gate validated `server.json` against the schema `server.json` itself
  names. Ask the system that will refuse you (ADR-0080).
- **`safeName` rewrites `snc-02#1` as `snc-02.1.json`.** A harness that re-derives a filename instead
  of using the writer's function reported `n₂ = 0` with a *plausible* reason and a confident, wrong
  INCONCLUSIVE.
- **A `tsx` harness imports `../src/*.js` from source**, so uncommitted edits compile into a run with
  nothing in any log to show it. Start runs from a clean tree.
- **The *project's* tree is the other half of that, and it moves without warning.** `project-a` was
  pulled forward 50 commits on 21 Sep, hours after a measurement, by a normal day's work in another
  window. **Record the project's commit in every result** — the counterfactual harness does now and
  refuses to start on a dirty one — because a measured number whose subject is not recorded cannot be
  reproduced *or* contradicted, and re-running is the only way to contradict one here.
- **Anything this tool truncates for display, it also truncates for diagnosis** — five defects of that
  shape now (the 1 MB `run` cap, ADR-0072, ADR-0074, ADR-0071's blind spot, and the scanner's own
  silence).
- **A run crossing a calendar boundary against a stale baseline can lose the whole run**, not one task
  (ADR-0069). The warning fires; the verdict records both timestamps. **It is LOCAL *or* UTC midnight
  (ADR-0083)** — `project-a` was measured moving three tests at **00:00 UTC** with the local clock
  reading 01:55 → 02:02 and the local day unchanged. The guard watched local only and stayed silent.
  Any run between 01:00 and 03:00 local in a UTC+2 summer sits in that gap.

## 6. Where the local projects are

**Not here, and never here.** The two real projects the experiments run against are a client's, and
CLAUDE.md #7 forbids naming them or their paths anywhere in this repository — *"local paths stay
local"*. They are `project-a` (NestJS + jest, ~2,160 `src` files) and `project-b` (React + jest, 764
specs), and that is all a tracked file may say.

The machine-local mapping — which checkout is which, and which node build their suites need — is in
this project's memory directory under `~/.claude/projects/<slug>/memory/`. A session that cannot
reach it should ask the owner rather than guess: two similarly-named checkouts on this machine are
**not** these projects, and running against the wrong one produces numbers that look fine.
