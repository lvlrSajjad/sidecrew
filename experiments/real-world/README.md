# Real-world trial — protocol

**Frozen before the run. Do not edit while a run is in progress.** If something here turns out to be
wrong, record the deviation in the report and change the protocol afterwards, dated, below the original —
the same rule `experiments/go-no-go/README.md` follows and for the same reason: a protocol edited to fit
the result is not a protocol.

Both fixtures sidecrew has measured are toys — 14 and 21 small pure functions, written by us, in projects
configured by us. Every number in `docs/` is conditional on that. This is the experiment that finds out
what changes on somebody's real code.

## What is being asked

Three questions, in order of how much they matter. Answer them separately; a run that answers only the
first is still worth reporting.

1. **Does the pipeline run at all on this project?** Can a plan be written and validated, and can one
   candidate get a verdict — any verdict?
2. **What does it cost?** Wall clock per candidate, split by stage. `experiments/recon/project-c.md`
   projects ≥ 25 s against the fixture's 14.6 s, on a 9.8 s compile stage. Projected is not measured.
3. **What is the survival rate, and are the survivors any good?** Against the fixture's 0.85 of Haiku —
   and with the mutation scores, because ADR-0020's guard is that survival rate alone cannot decide it.

## Rules

- **On a branch, and the branch is never merged.** `git checkout -b sidecrew-trial`. The only commits are
  the experiment's own devDependencies and the tests it produces. Nothing in `src/` is modified — if a
  candidate would require changing the code under test, that is a finding, not a fix.
- **Nothing is installed globally.** Two devDependencies in the target workspace, and they go in the
  branch commit: `@stryker-mutator/core` and `@stryker-mutator/jest-runner` (or `vitest-runner`).
- **No prompt is tuned mid-run and no verifier is touched.** If the prompt looks wrong, finish the run and
  say so. ADR-0017 and ADR-0021 are both about resisting exactly this, and both were right.
- **Report what was discarded.** A discard rate is worth nothing until somebody has looked at what was
  discarded — Phase 4's `<|im_end|>`, Phase 6's empty Apple shim, ADR-0028's ts-jest instrumentation. Read
  at least three failed candidates in full before writing a conclusion about the model.
- **Every number gets the machine it came from**, and `"measured": true` or an explicit "estimated".

## Steps

### 0. Environment
```
sidecrew doctor --project <workspace>
```
Record every row. `stryker-runner` must be `ok` before anything else is worth doing; `tsc`, the test
runner and `stryker` must be `ok` for the workspace being tested, not for the repo root. A worker must be
up (`sidecrew serve`) and **pinned** — `--allow-unpinned` invalidates the comparison with every other
number in this repo.

### 1. Pick the module, and say why
One source file, 5–15 exported functions, from the project's **pure layer** — helpers, formatters,
converters, predicates. Not components, not screens, not hooks, not anything needing a render harness:
nothing in this project has measured a worker against those, and a trial that starts there measures the
hardest case first and learns nothing about the easy one.

State in the report: the file, how many exported functions, and roughly what they do.

### 2. Mutant density — before planning
```
npx tsx scripts/probe-mutants.ts --module <source file> --tests <test dir> \
  --runner jest --out experiments/mutant-probe/<project>.json
```
ADR-0016: under strict TypeScript some functions have **no mutants at all**, and a candidate for one can
never satisfy `killed ≥ 1`. This is the denominator every rate in the report is over, so it is recorded as
a number rather than discovered as a gap. Report the four-way split: mutable / no mutants / crash-only /
unresolved.

### 3. Plan
Invoke the `test-planner` agent. It loops on `sidecrew_plan_validate` until the plan is `valid`, which
includes **every exemplar surviving the verifier for real**.

Record: how many attempts the exemplars needed, and what was wrong with the ones that failed. That number
is the most transferable thing in this experiment — it is how much Claude work a new codebase costs before
a single worker candidate is generated.

### 4. Dry run
```
sidecrew run <plan> --dry-run
```
Read **one rendered prompt in full** from `.sidecrew/runs/<id>/prompts/`. Confirm the import hint is right
for this project's module resolution and that the exemplar is the one intended. A wrong import hint makes
every candidate fail the compile stage and looks exactly like a model that cannot write TypeScript.

### 5. Run
```
sidecrew run <plan>
```
Then `sidecrew review` and `sidecrew escalate`, and read what each returns.

### 6. Report
`experiments/real-world/results/<project>-<date>.md` in the **sidecrew** repo (not the target project),
plus the results JSON. Required sections:

- **The project**: language, framework, test runner, size, existing coverage, and the machine.
- **The funnel**, over tasks at each task's final attempt: tasks → compiled → passed → killed ≥ 1 →
  non-tautological → survived.
- **Cost per candidate**, split into generate / compile / pass / mutation, median and p90.
- **Mutation scores of the survivors**, median. Compared with the fixture's 1.00, because ADR-0020's
  guard is that a configuration surviving less often while writing sharper tests is not obviously worse.
- **Three failed candidates, quoted in full**, with what actually went wrong.
- **What surprised you.** The single most valuable section in every report this project has produced.
- **Threats to these numbers.** n, seeds, what else was running on the machine.

## What would count as a result

- **Works**: a valid plan, ≥ 1 survivor, and a per-candidate cost somebody would accept. The survival rate
  is then a number to compare against 0.85, not a pass mark.
- **Does not work, informatively**: the pipeline runs and the rate is poor. Report *where* the funnel
  collapses — compile, pass, or kill — because each implies a different fix, and Phase 6's Swift arm is
  the worked example (compile, and the cause was one missing sentence about the enclosing type).
- **Does not work, structurally**: it cannot get a verdict at all. Jest-expo under Stryker, a monorepo
  path alias Stryker cannot resolve, a `tsc` that takes four minutes. Say which, in detail. **This is a
  perfectly good outcome** and the most likely one — it is what the experiment is for.

A null result is a result. Do not tune anything to avoid reporting one.

---

## Amendment, 15 Sep 2026 — after the first run

The protocol above is otherwise unchanged. Three things it got wrong, corrected here rather than silently
above, because a run that followed it is on the record:

1. **Step 2's flags were invented.** It said `--project <workspace> --file <source file>`;
   `probe-mutants.ts` takes `--module` and `--tests`. Fixed in place above, since a wrong command is not a
   protocol decision. The script also hard-coded the vitest runner, so step 2 could not execute on a Jest
   project at all; `--runner` now exists (ADR-0028 taught the verifier two runners and never taught the
   probe).
2. **Step 0 said `stryker-runner` must be `ok` before continuing, and `doctor` was wrong about it** on
   every hoisted workspace. A reader following the protocol exactly would have stopped on a false
   negative. Fixed in `doctor` (ADR-0029); the instruction stands.
3. **Nothing told the runner to check which model the worker actually loaded.** It could not have: the
   tool reported one model and used another. Fixed in `discoverWorkers` (ADR-0029). Step 0 now implicitly
   covers it, because a run whose worker cannot be identified refuses instead of guessing.

**Step 0, added (15 Sep, after the third run):** `npm run build` in the sidecrew repo *before anything
else*, and confirm `git status` is clean. The project-a trial began with a `dist/` that predated the fix
it existed to test, and the stale binary reproduced a bug the repo had already fixed. Every ADR here is a
claim about behaviour; behaviour comes from `dist`. This protocol verifies the worker's revision to twelve
hex digits and did not verify that the code under test is the code in the commit.

**Step 0, added:** after `sidecrew serve`, run `sidecrew status` *from the directory you will run from*
and confirm it names the model you expect. If it says `not started by sidecrew`, set `SIDECREW_DIR` to the
`.sidecrew` that `serve` wrote before going further.

**Step 5, added (15 Sep, after the re-run):** when the run produces a number on a *repaired* project,
report the unmodified project's number **first and separately**, and label which is which. The re-run's
report leads with `0/8` and gives `3/8` second, and that ordering is the finding: four confirmed fixes
did not move the number a reader would quote, because a pipeline's result is its weakest sandbox rule
rather than the average of its fixes.

**Step 2, sharpened:** if the probe says a function has **no mutants at all**, do not record it as the
answer until a control has been run with the range set by hand. Three separate defects have now produced
that sentence — ADR-0030 (nothing ran), ADR-0033 #4 (empty array written as measured) and ADR-0035
(the range stopped at the signature) — and it is the one probe output that instructs a planner to discard
work. It has been wrong every time it has been checked.

**Step 0, added (15 Sep, after the sixth run):** when the commit under test changes a **rendered prompt**,
work out which modules it changes *before* the run and report those as fresh draws, not reproductions. The
sixth trial re-ran two modules as a regression check; ADR-0040 is what renders `imports_hint`, so module 2's
prompt bytes changed under the very commit being tested and its 3/8 → 4/8 was not a regression signal at
all. Module 1 hit the pre-existing branch and was the clean check. Temperature 0 licenses an expectation of
identity only when the prompt is identical. Protocol step 4 — read one rendered prompt in full — is what
caught it; without it the second module's result would have been an unresolvable ambiguity.

**Step 6, added:** `peak_rss_mb` in a `BatchResult` is **resident** memory, which macOS shrinks under
pressure — ADR-0011 measured the same 7B at 4540 MB on a quiet machine and the sixth trial measured 4538 MB.
Trials on a busy machine reported 170–243 MB for that same pinned worker and two reports quote it as though
it were the worker's footprint. It is not; the weights alone are ~4.2 GB. Report it as "resident at the
time", or report `ram_gb` from `models.json`, which is what ADR-0011 made the gate value for this reason.
