# Where we are — the standing handoff

**Read this first, then `VISION.md` → `ROADMAP.md` → `PHASES.md`.**

> **The direction, so no session drifts from it.** Opus receives a task and **plans a session to
> gather the info needed**; workers read and report; **Opus asks the user** where a machine cannot
> decide; Opus plans on the answer; workers act; the loop repeats **until a machine-checkable
> definition of *satisfied*** is met. That is `VISION.md`'s philosophy and the owner's own framing
> (20 Sep 2026). **Phases 14c and 14c′ built the *act on any file* half. 14d is the *read and ask*
> half, and it is where `v1.0.0` is cut.**

This file is always current; if it disagrees with anything else, it is the thing that was updated
last and the other file is the bug (CLAUDE.md § *Conventions*).

**Last updated: 25 Sep 2026, ~11:00. Phase 14d is CLOSED — STOP by its frozen rule (`R₁` = 2.07 at `N = 11`).
ADR-0089 is closed by option F and merged. Two new owner decisions change how work proceeds: ADR-0091
(measure cheaply; a night only for a claim) and ADR-0092 (mechanical first, never mechanical only). The one
open decision is what `v1.0` means — §4. Nothing is running; no clone on disk; nothing pushed since `v0.2.0`.**

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
| branch | `main`. Everything since `v0.2.0` is **committed locally, not pushed**; `origin/main` is `7ec88df`. 0 client references in the tracked tree — **scan before any push** (§5) |
| tests | `npm run lint && npm test` → **901 passing**, 1 skipped · slow: `verifier-ts` 12 · `fix` 38 · `recon` 1 · `query` 2 — **53, all green on 25 Sep** · slow sets: `SIDECREW_SLOW=1 npx vitest run test/fix.slow.test.ts` → **38**, `test/verifier-ts.slow.test.ts` → **11** (needs `sidecrew tools install`, not a fixture install) · **run both before a phase ends** · `verifier-jest.slow` needs `npm install` in `fixtures/jest-fixture`, which is a download and has not been run since ADR-0088 |
| version | **`0.2.0`**, published 24 Sep. Six places move together (`package.json`, `server.json` ×2, `plugin.json`, `src/mcp.ts`, `package-lock.json` ×2); use `npm version X --no-git-tag-version` for the first and last. `ci.yml` checks four, `release.yml` five, **neither checks the lockfile** |
| published | `sidecrew@0.2.0` on npm as `latest` with provenance; `io.github.lvlrSajjad/sidecrew` on the MCP Registry lists `0.1.2` and `0.2.0`. Release = green CI on the commit, then `git tag -a vX.Y.Z` and push the tag; `release.yml` has no `workflow_dispatch` (use `gh run rerun <id> --failed`). **Never push `private-history`** |
| tool cache | **`~/.sidecrew/tools/stryker-8.7.1`** is installed on this machine (62 MB, no project-owned tools inside it). `sidecrew tools` reports it |
| clones | **none on disk** (the 14d clone was deleted 25 Sep). Make one with `scripts/pinned-clone.sh` for any measurement |
| supported | **24 GB+ Apple Silicon, local tier only** (ADR-0073) |
| next phase | **no numbered phase** — the daytime list in §3, and the owner's v1.0 decision (§4) |
| ADRs | run to **0092**; start new ones at **0094**. **0093** defines v1.0 (owner) — its conditions await confirmation. Decided 25 Sep: **0090** (accepted; §5 = B), **0089** (closed by F, merged), **0091** (measurement tiers), **0092** (mechanical first, in principle). Open: **0064** (mostly retired by 0079) |
| running | **nothing.** Workers stopped, sandboxes swept, clones deleted |
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

### What to do next — daytime, tier 0–1 (ADR-0091), in this order unless the owner reorders it

Start a fresh session with: *"Read `CLAUDE.md`, `docs/plan/HANDOFF.md`, `docs/plan/V1-CHALLENGES.md` (especially
§11) and ADR-0091/0092. Then do the next item on HANDOFF §3's list."*

1. **Dollar re-score** of the eight planner transcripts (20 and 25 Sep) by token class — input, cache write,
   cache read, output — at the pricing of each transcript's own model. Tier 0: minutes, no run.
2. **Reflective-reference guard** for deletion shapes, with planted traps (an untested entity loaded by a
   glob, a string-token DI provider): a dead-code task touching one is refused. **No dead-code survivor goes
   to a user before this exists.** Tier 1.
3. **Memory admission control**: count the project suite's measured footprint in the concurrency ceiling,
   pass jest `--maxWorkers`, and back off on memory pressure by name rather than on token rate. Tier 1.
4. **Re-score the published workload #1 rates under ADR-0089 F** (3/8, 4/8, 4/10) — a Stryker run on
   project-a and project-b's published modules, **the owner's go** (the classifier blocks sidecrew commands on
   a client checkout; the owner runs them, or adds a permission rule).
5. **The deterministic-executor probe (ADR-0092 rung 1 vs 2)**: language-service rename, ESLint `--fix` /
   `tsc` for lint shapes, behind the unchanged gate, against the 7B on ~10 tasks. Tier 1. Plus the owner's
   own example: an *affected files* query (reverse import graph, reflection blind spot named).
6. **Verify-only mode** for small jobs: Opus edits, sidecrew gates (Phase 11b's arm D, as a product path).

**Phase 14d in numbers** (the rule file's dated notes say how each was handled; night 2 was dropped under ADR-0091):

| arm | N | `P_total` → normalised | R (normalised) | gated so far |
|---|---|---|---|---|
| base ≈ 12 | 11 | 199,152 → 229,830 | 2.68 | **9/11** |
| **retrieval ≈ 12** | 11 | 146,525 → 177,203 | **2.07** | 1/11 — **9 machine failures** (swap), not re-gated |
| base ≈ 40 | 45 | 254,933 (paid its own harness) | 0.73 | **32/45**, 1 machine failure |
| retrieval ≈ 40 | 36 | 195,013 → 225,691 | 0.80 | interrupted, not re-run (cannot change the fork) |

**Three instrument findings from night 1, each written into the rule file before the number it affects:**
parallel planners shared a 30,678-token prompt cache (R is read with it added back); two project-a suites at
concurrency 2 are ~16 GB of jest workers and swap the machine (machine failures re-gated at concurrency 1;
BACKLOG item for the ceiling); and sidecrew's "thermal back-off" fired on swap, not heat.

**What the build established, so the measurement session does not re-derive it:**

| | |
|---|---|
| the relevance answer | **admitted, never judged** (ADR-0090 §2): predicate answers are exact by construction; judgement answers are admitted iff every claim cites a byte-checked span within a budget; irrelevance is bounded and shows up in `R`; omission shows up as lower survival; neither can make a wrong change survive |
| what `P_total` is made of | `N = 12`: harness **45,877** · reading **94,978** · output × 2 **130,164** (`scripts/planner-decompose.py`, `experiments/planner-cost/results/decomposition-2026-09-24.json`) |
| the ceiling | all reading removed, output unchanged → **`R` = 1.88**; staying out of STOP with output unchanged needs reading **−88 %** |
| what is built | `sidecrew recon` · `sidecrew query refs\|unreferenced\|sizes\|diagnostics` · `sidecrew read` (admitted by citation; budget in the prompt file) · change-planner §1′ switched by the brief · `planner-decompose.py` counts retrieval calls |
| the reader, probed | on the real 7B over sidecrew's own code: byte equality refused 9/10 (it joins lines), so quotes match word-for-word with layout removed; then 6 admitted, 4 refused, **2 of the 6 said more than their quote** — admitted ≠ true |
| the reading, by tool (`N = 12` / `N = 41`) | file contents 65 % / 37 % · grep 18 % / 25 % · **the planner's own analysis scripts 10 % / 12 %** · listings 4 % / 18 % · sidecrew's output 2 % / 3 % (an earlier count of 12 % / 33 % was a classifier bug, corrected before commit) |
| the frozen fork | `R₁ ≤ 1.0` PROCEED (cut 1.0, with ADR-0089) · `(1.0, 2.0]` INSERT `14d′` · `> 2.0` STOP · quality veto: `S₁`'s upper bound < `S₀` → STOP for retrieval as built |
| the size | 4 planner passes (~2 h, day) + ~106 gated tasks (~5 h, one night after 02:05) — re-size from the real plans |

**The numbers it will otherwise go hunting for** (`experiments/planner-cost/`, measured 19–20 Sep):

| | |
|---|---|
| `R` at `N = 12` / `N = 41` | **2.84** / **1.07** (both FAIL; 1.0 needs `R ≤ 1.0` at `N = 12`) |
| `P_total` at 12 / 41 tasks | 265,607 / 343,144 Opus tokens |
| fixed planning cost `F` | **≈ 233,500 tokens**, 88 % of the total at `N = 12` and 68 % at `N = 41`; the per-task term is ≈ 2,700 |
| what the fixed cost is | **corrected 24 Sep (ADR-0090 §1):** ~17 % harness, ~36 % reading, ~49 % Opus's own output paid twice. The old *"overwhelmingly reading: 15.5 M cache reads"* counted cache reads, which `P_total` excludes |
| instrument | `scripts/planner-tokens.mjs`, dedup by `message.id` keeping the last; subagent transcripts are in `<session>/subagents/`. **A subagent transcript is a clean window by construction**, so spawn planners as subagents and read `--agents` |

**The traps, each already paid for once:**

- **Re-plan and re-gate both arms under today's gate.** The 20 Sep plans were gated before ADR-0084,
  ADR-0077 B and ADR-0086 B. An old arm against a new one would measure this phase plus three gate
  changes, which is 14c's §2 trap one level up. The 20 Sep plans are also at an older project commit.
- **Measure on a pinned clone** (`scripts/pinned-clone.sh`), never the working checkout, which moves
  daily. **Refuse if the dependency manifests differ**, and the script does.
- **The quality veto is what makes it an overnight.** `R` itself is planning tokens (daytime, minutes
  per pass). The veto needs the plans gated: an estimated **~106 gated tasks** (12 + 41, both arms), which is
  **5–6 h** going by 14c′ (83 tasks in 4 h), an estimate until the plans exist. Start after **02:05** (ADR-0083).
- **Relevance is not machine-checkable.** A machine confirms a location *exists*; the user is the
  proposed relevance oracle (ADR-0079), batched, once per cycle, or the loop pays the fixed cost `n` times.

**The expected number of overnights to `v1.0.0`: 1 (14d), 2 if `R` lands in (1.0, 2.0] and inserts
14d′, and one contingency.** ADR-0089 needs no overnight: the re-score is done and B is chosen, so it is a daytime build.

### The board — everything live, in order

| | what | cost | needs |
|---|---|---|---|
| **A** | **Phase 14d** — retrieval, cut `v1.0.0` | **built**; the measurement is left: ~2 h of planner passes by day + one ~5 h gated night | the owner naming a night (§5 is decided: B) |
| **B** | **ADR-0089** — close the type-only-assertion hole; **a 1.0 prerequisite** | ~1 session, no overnight | **option B chosen 24 Sep**; build it with a control fixture and mutator names in verdicts. One daytime Stryker run would settle the ≤ 2/11 bound (owner's go) Recommendation: **B** (require a kill other than the whole-body removal), with **A** as the detector's cheap first line |
| **C** | **What raises ADR-0082 D's `Y`** | a probe | not scheduled. D's funnel says the worker cannot build a test against a NestJS service (2/14 ever passed on the original code; both then killed). The candidate levers are the service's own specs as context, or a larger worker |
| **D** | Phase 14's passive exit check | watching | nothing; window ends 5 Oct |

**Do not re-open** ADR-0075, ADR-0086 or ADR-0087 (decided, built, measured), or ADR-0088 (built and
proven on three runs).

---

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

- **`v1.0` is DEFINED (owner, 25 Sep; ADR-0093):** the claim *"we do what Opus does, in a different and cheaper
  way"* is true **and** any user can get it. **Open: confirm ADR-0093's four conditions** (quality vs an
  Opus-alone arm on listed job types; dollars per delivered task, never more expensive than Opus at any size;
  the gated pipeline; reproduction on two outside projects with the guarantees holding). **0.x releases
  continue** — cutting `v0.3.0` is the owner's call.
- **Recon ran on project-a (24 Sep, the owner's run; ADR-0079 addendum).** 1 error as configured;
  `--strictNullChecks` +11,604, `--noImplicitAny` +7,793, and the lint-shaped flags +282 at **95 % in
  source** — so **ADR-0079 option B (fix only the lint shapes) is deliverable on this project**; whether to
  plan it is the owner's call. **Open:** the gate's test predicate calls support files under `test/`
  source (BACKLOG, needs an ADR). Note the auto-mode classifier **blocks** sidecrew commands pointed at a
  client checkout — the owner runs those, or adds a permission rule.
- **ADR-0089 — CLOSED 25 Sep by option F** (A and B beside it), merged. Owed: re-score the published
  workload #1 rates under it (§3 item 4). **The re-score is done (addendum, 24 Sep):** from stored records only an upper
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
