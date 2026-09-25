# Where we are — the standing handoff

**Read this first, then `VISION.md` → `ROADMAP.md` → `PHASES.md`.**

> **The direction, so no session drifts from it.** `v1.0` means the claim *"we do what Claude Opus does, in a
> different and cheaper way"* is true — **≥ 80–90 % of Opus-alone's success** on a benchmark of real requests
> (features and bugs included), for **≤ 50 % of its dollars on batch jobs**, as a fitted formula with its margin —
> **and** any user can reproduce it (ADR-0093). The work is divided **mechanical tool → local models → cheaper
> Claude → the user's model**, routed by expected cost per success, every rung behind the gate (ADR-0092, ADR-0094),
> after **triage** splits a request by size and complexity (ADR-0095). **Measure with short probes; spend a night
> only on a number that will be published** (ADR-0091). The road is ROADMAP's capability ladder.

This file is always current; if it disagrees with anything else, it is the thing that was updated
last and the other file is the bug (CLAUDE.md § *Conventions*).

**Last updated: 25 Sep 2026, evening. Everything is committed and pushed to `origin/main`. Nothing is running,
no clone is on disk, no worker is up. Start at §3.**

### What happened on 25 Sep, in one table

| | result | where |
|---|---|---|
| **Phase 14d closed — STOP** by its frozen rule | `R₁` = **2.07** at `N = 11` (retrieval cut planning ~23 %); both arms pay near `N ≈ 40` (0.73, 0.80); night 2 dropped — it could not change the row | `prompts/phase-14d-retrieval.md` § *The result* |
| **v1.0 defined** (owner) | the claim true against Opus-alone, in dollars, on real requests, reproducible; v2 = as fast; v3 = as good or better | ADR-0093 + 3 addenda, ROADMAP, README § Roadmap |
| **ADR-0089 closed** — option F | survival needs a kill that is neither the body removal nor a crash (a second, assertion-stripped mutation pass) | ADR-0089 addenda |
| **reflective-reference gate rule** | no removing/renaming what is decorated, named as a string, or glob-loaded; planted traps; fixture control | `src/reflection.ts` |
| **memory admission control** | the first baseline measures one suite's footprint; only what fits runs at once; back-off named *memory* | `src/suite-gate.ts` |
| **dollar re-score** (tier 0) | **cache reads are the largest planning cost (33–67 %)**, not output; ~$0.22–0.30/task at N≈11, ~$0.07–0.08 at N≈40 (Opus 5.5) | `experiments/planner-cost/results/dollars-2026-09-25.json` |
| **P1 — Sonnet as planner** (tier 1) | **not met**: 7 tasks for $1.93 vs Opus's 11 for $2.39; first run void (read Opus's plan) → isolation by construction | `…/p1-sonnet-planner-2026-09-25.json`, ADR-0094 addendum |
| **new ADRs** | 0091 measurement tiers · 0092 mechanical first · 0093 v1 · 0094 middle tiers + routing rule · 0095 triage (proposed) | DECISIONS.md |
| **independent analysis** of the road to v1 | received and answered; most recommendations adopted, the "guarantees-only v1" not | `docs/research/2026-09-25-v1-independent-analysis.md`, V1-CHALLENGES §11–12 |
| **public roadmap** | README § Roadmap and the docs site | README, `docs/index.md` |

### What happened on 22–24 Sep, in one table

| | result | where |
|---|---|---|
| **14c** — a task may name a declaration (ADR-0086, option C built) | `Reach` **0.519 → 0.911**; file-sized tasks `S_big` 0/9 vs `S_small` 1/18 → **INSERT 14c′** | `prompts/phase-14c-the-reach.md`, ADR-0087 |
| **ADR-0086 §6 option B** — judge a symbol task by its declaration | **built, the default** (`symbol_gate: "declaration"`) | ADR-0086 §6 |
| **14c′** — one declaration per task | `S′_big` **15/41** [0.221, 0.531] vs `S′_small` **10/42** [0.121, 0.395]; safety clean → **PROCEED to 14d** | `prompts/phase-14c-prime.md` §5 |
| **ADR-0088** — sidecrew brings its own pinned Stryker; the project is intact after every job | **built**; working checkout identical across three measurements | ADR-0088 |
| **ADR-0082 D** — can a worker write the test first? | `Y` **2/20** [0.012, 0.317] → **B not affordable as it stands** (principle stays accepted) | `prompts/adr-0082-d.md` §6 |
| **ADR-0089** — a type-only assertion survives workload #1's gate | found, pinned as a KNOWN HOLE test, **a 1.0 prerequisite** (owner) | ADR-0089 |
| **`v0.2.0`** | **published**: npm `latest` with SLSA provenance, MCP Registry, from `v0.2.0` at `61eb7f2` | CHANGELOG |
| **14d built** | **ADR-0090** (relevance: *admitted, never judged*) · exit check **frozen** · **`recon`, `query`, `read`, planner §1′** built · **found:** `P_total` is 17 % harness / 36 % reading / 49 % Opus output, so all-reading-removed gives **`R` = 1.88** | ADR-0090, `prompts/phase-14d-retrieval.md` |

*Verify before trusting it:* `git log -1 --format='%h %s'` should be the commit that last touched
this file. If later commits changed the phase state and this file was not among them, the rule in
CLAUDE.md was missed — trust `PHASES.md` and the ADRs over this page, and fix it.

---

## 1. State, in one table

| | |
|---|---|
| branch | `main` = `origin/main`, **pushed 25 Sep**. 0 client references in anything pushed — **scan blob contents over `origin/main..HEAD` before every push** (§5) |
| tests | `npm run lint && npm test` → **917 passing**, 1 skipped · slow: `verifier-ts` 12 · `fix` 39 · `recon` 1 · `query` 2 — **all green on 25 Sep** · slow sets: `SIDECREW_SLOW=1 npx vitest run test/fix.slow.test.ts` → **38**, `test/verifier-ts.slow.test.ts` → **11** (needs `sidecrew tools install`, not a fixture install) · **run both before a phase ends** · `verifier-jest.slow` needs `npm install` in `fixtures/jest-fixture`, which is a download and has not been run since ADR-0088 |
| version | **`0.2.0`**, published 24 Sep. Six places move together (`package.json`, `server.json` ×2, `plugin.json`, `src/mcp.ts`, `package-lock.json` ×2); use `npm version X --no-git-tag-version` for the first and last. `ci.yml` checks four, `release.yml` five, **neither checks the lockfile** |
| published | `sidecrew@0.2.0` on npm as `latest` with provenance; `io.github.lvlrSajjad/sidecrew` on the MCP Registry lists `0.1.2` and `0.2.0`. Release = green CI on the commit, then `git tag -a vX.Y.Z` and push the tag; `release.yml` has no `workflow_dispatch` (use `gh run rerun <id> --failed`). **Never push `private-history`** |
| tool cache | **`~/.sidecrew/tools/stryker-8.7.1`** is installed on this machine (62 MB, no project-owned tools inside it). `sidecrew tools` reports it |
| clones | **none on disk** (the 14d clone was deleted 25 Sep). Make one with `scripts/pinned-clone.sh` for any measurement |
| supported | **24 GB+ Apple Silicon, local tier only** (ADR-0073) |
| next | **no numbered phase** — §3's working list, in order |
| ADRs | run to **0095**; start new ones at **0096**. Proposed: **0095** (triage). Accepted this week: 0089 (closed by F), 0090, 0091, 0092 (in principle), 0093, 0094 (in principle). Open: **0064** (mostly retired by 0079) |
| running | **nothing.** No worker, no clone, sandboxes swept. **Qwen3-Coder-30B-A3B is not downloaded yet** (the owner will, overnight) |
| CI | **green** on `main` and on the `v0.2.0` release run |
| `gh` | authenticated **per tree**: `~/Coding/ME/*` → `GH_CONFIG_DIR=~/.config/gh-personal`. A bash shell must set it explicitly |
| Phase 14's passive exit check | still live: first-run failures on outside projects, window ends **5 Oct 2026** (item 3 of §3's history, below) |

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

### Starting a fresh session — paste this

> Read `CLAUDE.md`, `docs/plan/HANDOFF.md`, `docs/plan/ROADMAP.md` (the box at the top and § *The capability
> ladder*), and ADRs 0091–0095 in `docs/DECISIONS.md`. Then `git status` and `git log -5`. Do the next open item on
> HANDOFF §3's list, as a tier-1 probe or a daytime build (ADR-0091). Anything that runs on a client project needs a
> pinned clone and the owner's go; nothing is pushed without scanning `origin/main..HEAD`.

### The working list, in order — each item states its tier (ADR-0091)

| | item | tier | needs |
|---|---|---|---|
| 1 | **Design the benchmark** that 1.0 is measured on: real historical changes from **outside open-source TypeScript projects**, the commit's intent as the request, the commit's own tests as the hidden oracle, a blind Opus judge only where there are none; an **Opus-alone arm** with its token classes and dollars; stated job sizes for the cost formula (ADR-0093 addenda 2–3). On paper first: which repos, how commits are sampled and categorised | 0 | nothing — the missing instrument everything else hangs on |
| 2 | **The deterministic-executor probe** (ADR-0092 rung 1 vs rung 2): language-service rename, ESLint `--fix` / `tsc` for lint shapes, behind the unchanged gate, against the 7B on ~10 tasks. Plus the owner's example, an **affected-files** query (reverse import graph, reflection blind spot named) | 1 | a pinned clone |
| 3 | **ADR-0094 P2** — two-level planning: Sonnet builds the dossier and plan, the user's model decides in one short session. *Changes the plan if* total dollars fall below P1's and the top model's share below a third | 1 | a pinned clone; isolation by construction (other arms' outputs moved out) |
| 4 | **ADR-0094 P3** — Qwen3-Coder-30B-A3B on the tasks the 7B failed on 25 Sep, at concurrency 1. First pin it (`mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit`, revision `6e302ea604ad9ab206367e2c501d1571023e7b6d`, Apache-2.0, 17.2 GB) in `src/models.json` and measure its RSS beside a suite | 1 | **the owner's download** |
| 5 | **ADR-0095 triage** — `sidecrew triage` (the mechanical card) and the triage skill; checked on the benchmark's labelled requests before anything is routed by it | 1 | item 1 |
| 6 | **Verify-only mode** for small jobs: the user's model edits, sidecrew gates (Phase 11b's arm D as a product path) — the honest small-job story under ADR-0093 | build | nothing |
| 7 | **Re-score the published workload #1 rates under ADR-0089 F** (3/8, 4/8, 4/10) — a Stryker run on project-a's and project-b's published modules | 1 | **the owner's go** (the classifier blocks sidecrew commands on a client checkout) |
| 8 | **jest `--maxWorkers` from the concurrency** — the other half of memory admission control; it changes how the project's tests run, so it needs its own ADR first | ADR, then build | nothing |
| 9 | **The test-file predicate question** — support files under `test/` count as source (BACKLOG); measure how many #2a survivors touched one, then an ADR | 0, then ADR | nothing |

**Standing rules learned on 25 Sep, apply to every item:** isolation between probe arms is **made true by
construction** (move other arms' outputs out of reach, audit the transcript), never merely asked for; parallel
planners share a prompt cache — launch one at a time or add back the harness; a subagent prompt for sidecrew work
should say the owner confirmed it is business-related tooling (one refused on the org instruction).

### Phase 14d in numbers — history, kept for the curve

| arm | N | Opus new tokens (harness-normalised) | R | first-pass gating | dollars (alone) |
|---|---|---|---|---|---|
| base ≈ 12 | 11 | 229,830 | 2.68 | 9/11 | $3.31 |
| **retrieval ≈ 12** | 11 | 177,203 | **2.07** | 1/11 (9 machine failures) | $2.39 |
| base ≈ 40 | 45 | 254,933 | 0.73 | 32/45 (1 machine failure) | $3.48 |
| retrieval ≈ 40 | 36 | 225,691 | 0.80 | interrupted | $2.67 |
| P1: Sonnet ≈ 12 | 7 | 163,832 (as measured) | — | not gated | $1.93 |

### Earlier completed work (20–22 Sep) — history, not a queue, kept for what each one cost

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

- **`v1.0` is decided** (ADR-0093 and its three addenda) and nothing about it is open; the benchmark design (§3 item 1)
  is how it gets measured. **`v0.3.0`: skipped for now (owner, 25 Sep)** — cutting it is the owner's call, and `main`
  has a release's worth (recon, query, read, the reflective rule, ADR-0089 F, memory admission control).
- **Recon ran on project-a (24 Sep, the owner's run; ADR-0079 addendum).** 1 error as configured;
  `--strictNullChecks` +11,604, `--noImplicitAny` +7,793, and the lint-shaped flags +282 at **95 % in
  source** — so **ADR-0079 option B (fix only the lint shapes) is deliverable on this project**; whether to
  plan it is the owner's call. **Open:** the gate's test predicate calls support files under `test/`
  source (BACKLOG, needs an ADR). Note the auto-mode classifier **blocks** sidecrew commands pointed at a
  client checkout — the owner runs those, or adds a permission rule.
- **ADR-0089 — CLOSED 25 Sep by option F** (A and B beside it), merged. Owed: re-score the published
  workload #1 rates under it (§3 item 7). **The re-score is done (addendum, 24 Sep):** from stored records only an upper
  bound is possible — verdicts keep Stryker ids, not mutator names — and it is **2 of 11** published
  real-project survivors, both tests of one function with a single mutant. Worst case project-a's 4/8 → 2/8.
  Settling it exactly is one daytime Stryker run on one project-a function, **the owner's go**.
- **ADR-0064** — philosophical, blocks nothing, largely retired by ADR-0079. Standing recommendation:
  B now, C not yet.
- **The fixtures' `package.json` still list Stryker as a devDependency.** The verifier no longer reads
  them (ADR-0088); removing them rewrites the fixtures' lockfiles. Cosmetic, the owner's call.
- **`fixtures/jest-fixture` needs `npm install`** for `verifier-jest.slow` to run. That is a download and
  wants the owner's OK. It has not been run since ADR-0088 changed where Stryker comes from.
- **A client symbol name is on public `main`** (`getSpendVsReplacement`, five tracked files, the reduced
  case behind ADR-0035 and ADR-0039). Already pushed, so removing it does not retract it. Flagged, the
  owner's call.

*Decided this week and not to be re-opened:* ADR-0086 §6 (**B**, 23 Sep), ADR-0087 (**A**, amended per
declaration), ADR-0088 (built), ADR-0082 (**accepted in principle as TDD**), `v0.2.0` (**cut**),
ADR-0089 (**a 1.0 prerequisite; option B**), ADR-0090 (**accepted; §5 = B**).

## 5. Standing hazards — all learned expensively

- **npm installs peer dependencies, and that put the wrong compiler into sidecrew's own tool cache**
  (ADR-0088 spike, 23 Sep): `typescript` 7.0.2 and `vitest` 4.1.11, which Stryker then used instead of the
  project's. The cache is installed with `legacy-peer-deps` and `strykerStatus` refuses one holding a
  project-owned tool. **Any future tool cache needs the same guard.**
- **Measure on a pinned clone, never the working checkout** (ADR-0088 addendum). It moved 36 commits in
  one day. `scripts/pinned-clone.sh` refuses when the dependency manifests differ, because the copied
  `node_modules` would then be the wrong one. Fingerprint the working checkout before and after anyway.
- **`git status` from inside a larger repository is the repository's, not the project's.** The integrity
  check's first run raised a false alarm on the in-repo fixtures; it is scoped with `-- .` now. Any
  check that reads status must scope it.
- **A subagent told to run no commands may still run one.** Both D planners made a stray no-op `true`
  call and reported it. Nothing was disturbed, but a background measurement is only protected by the
  instruction, so **do not run planning subagents beside a measurement that a stray command could
  poison** unless their tools are restricted.
- **"No mutant killed" is two situations, and the message used to say the wrong one.** When every
  mutant is a `CompileError`, nothing ran, and the old text said *"the test passes against every changed
  version"*. That misdirected a repair, and it is how ADR-0089 stayed hidden inside the fixture test
  written to catch it. Fixed; `noKillMessage` is the one place that sentence is built.
- **A verdict field must not be derived from how far the candidate got.** `target_scope` was read off
  the compile stage's counts, so 26 confinement failures said `"file"`. Fixed; decide recorded rules
  from the task and the plan.

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
- **Nothing runs the slow suite, so its assertions rot.** `test/fix.slow.test.ts` had a stale
  expectation from the day **ADR-0054** landed and nobody saw it, because `ci.yml` runs the fast set by
  design. **Run `SIDECREW_SLOW=1 npx vitest run test/fix.slow.test.ts` before a phase ends** — it needs
  only the fixture, no client project, and it took 67 s.
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
