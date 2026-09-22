# Architecture decisions

## ADR-0001 — Workers are a separate local process behind MCP, not Claude Code subagents
Context: subagents can only choose haiku/sonnet/opus on the session's endpoint; `ANTHROPIC_BASE_URL` is session-wide; per-subagent local routing is an open request (anthropics/claude-code #38698). Research §C.
Decision: workers = `mlx_lm.server` (OpenAI-compatible) reached through the `sidecrew` MCP server / CLI. Subagents only for planning (Opus), review (Sonnet), and the Haiku experiment control.
Consequences: zero Claude tokens for workers by construction; one extra process (`sidecrew serve`); we own retry/concurrency.

## ADR-0002 — TypeScript npm package, no Python helper
Context: simframe ships as `npx -y simframe mcp`; mlx_lm.server already speaks HTTP; verifiers are shell-outs.
Decision: single Node package; `mlx_lm` is an external capability like `idb` is for simframe, checked by `doctor`.
Consequences: one toolchain to install; Python appears only as `python3 -m mlx_lm.server` spawned by `serve`.

## ADR-0003 — Determinism under mlx_lm.server: the seed is the batching opt-out
Context: research §C flagged the risk that "batched serving may ignore per-request seeds", which would
make non-negotiable #4 unenforceable and turn every survival rate into a sample from a distribution we
never characterised. Phase 1 had to find the flag, serialise requests, or write this ADR. mlx_lm 0.31.3
has `--decode-concurrency` (default 32) and `--prompt-concurrency` (default 8), so the server does batch
by default, and there is no `--no-batching` flag to turn it off.

Decision: send `seed` on every request and rely on it, because in mlx_lm 0.31 the seed *is* the opt-out.
`server.py` decides batchability as:

```python
def _is_batchable(self, args):
    return self.model_provider.is_batchable and args.seed is None
```

A request that carries a seed is excluded from the batch and served on its own. This is verified in the
source of the pinned version rather than inferred from behaviour, because "we ran it five times and it
matched" is evidence about five runs, not about a scheduler.

Measured on the baseline machine (2026-09-11, mlx_lm 0.31.3, both models, Xcode open and closed):
**5/5 byte-identical, every time** — 1889 bytes per response at temperature 0, seed 42.

One negative result, recorded because it qualifies the claim rather than supporting it: four *concurrent*
requests sent **without** a seed — the case that should have been batched — also came back identical.
So this experiment did not reproduce the divergence research §C warned about, and it is not evidence
that the seed is *necessary*; it may be that those four were never actually batched. The seed's
guarantee here is structural, from `_is_batchable`, and we do not rely on the observation either way.
The 5× check in `sidecrew bench --determinism` exits non-zero when it fails — it is the check to run
before trusting any number a worker produced.

Consequences:
- `src/worker.ts` has no un-seeded path. `CompleteOpts.seed` is required, not optional, so a caller
  cannot accidentally opt back into batching by leaving it out; `Candidate.worker.seed` records what
  was sent.
- Concurrency across workers is unaffected: two seeded requests to one server are simply not merged
  into one batch, which is what non-negotiable #4's "one in-flight request per worker process" asks
  for anyway. Phase 4 gets its parallelism from several worker processes, not from batching one.
- This is a fact about mlx_lm 0.31.3, and `_is_batchable` is internal. Pinning the mlx_lm version is
  now load-bearing, not hygiene — `bench` records `machine.mlx_lm` in every results file so a run
  taken under a version where this changed is identifiable after the fact (BACKLOG: assert the version
  in `doctor`).
- The api tier (ADR-0009) has no seed and cannot be checked this way; determinism there is temperature
  0 and nothing more, as that ADR already states.

## ADR-0004 — The sandbox is a per-candidate temp copy with the project's own tests removed
Context: a candidate has to be compiled and run somewhere. The Phase 2 prompt offered two options — a
temp copy of the package or a git worktree — and measuring them turned up a third question nobody had
asked, which turned out to be the one that mattered.

**A git worktree cannot do this job.** A worktree contains committed content; the code a developer wants
tests for is usually the code they just wrote. It has no `node_modules`, so every stage would need one
symlinked in anyway, and it requires the target to be a git repository at all. It answers a question
about HEAD when the question is about the working tree.

**Running in place is worse than it looks.** It writes into the user's own `test/` directory, cannot run
two candidates at once, and leaves files behind when a run is killed.

**The third question: who gets credit for the kill?** Stryker reports a mutant as killed by whatever test
killed it. Our verdict is a *count*. Point the verifier at a project with a real suite and every
candidate inherits a full set of kills earned by tests that were there before it — `killed ≥ 1` would be
satisfied by a candidate that asserts nothing, in every repo that already has tests. This is not a
hypothetical: it is the default outcome of the obvious implementation.

### Decision
The sandbox is `mkdtemp` outside the project, holding a copy of it with

- **every test file removed** (`*.{test,spec}.{js,ts,…}`) and the candidate written in as the only one,
  so a kill can only have come from the candidate;
- **`node_modules` symlinked**, not copied — the stages only read it, and a copy per candidate would
  cost more than the mutation run;
- **`reports/`, `.stryker-tmp/`, `coverage/` and `__snapshots__/` left behind**: generated output, and
  in the snapshot case a recorded answer that a candidate must not be graded against.

### The incremental cache, measured
`incremental: true` is in the config, and it is safe **only** because the incremental file lives inside
the sandbox and is therefore always cold. Pointed at a shared location it hands one candidate another's
kills. Measured on the fixture, `src/strings.ts`, same machine, minutes apart:

| run | test file | killed | survived |
|---|---|---|---|
| A | a real test of `commonPrefix` | 6 | 3 |
| B | `expect(true).toBe(true)`, shared cache | **6** | 3 |

Candidate B asserts nothing and was credited with candidate A's entire result. The mechanism is in
Stryker's own source (`incremental-differ.ts`): when the new test run reports no coverage at all,
`if (!testCoverage.hasCoverage) return true` reuses every previous result. A candidate that covers
nothing is exactly the candidate that must not inherit anything. With coverage present the kills are
recomputed correctly, but the `Survived` / `NoCoverage` bookkeeping still carries over (4 + 36 against a
cold 1 + 40 for the same candidate), which moves the score.

So the cache is not shared, and the reuse it was enabled for does not happen in this loop — every
candidate brings a new test file, so there is nothing to reuse. It stays on because it costs nothing
cold and a human running Stryker by hand in the same project wants it. `test/verifier-ts.slow.test.ts`
has the regression: a candidate is verified immediately after one that earned kills on the same lines,
and must come back with none.

Consequences:
- Verifying a candidate copies the project's source once (milliseconds on the fixture, and `node_modules`
  is not part of it). A repository with a large working tree will notice; if it ever matters, the fix is
  to copy once per *module* and rewrite only the test file, not to share a cache.
- The verifier never writes into the project it is pointed at. `keepSandbox` prints the path for a
  verdict you do not believe.
- `CI=true` is set for the run stages so vitest cannot write a snapshot file for a snapshot that does
  not exist yet. Without it a candidate whose only assertion is `toMatchSnapshot()` records its own
  answer and passes, and the verifier blesses the output instead of checking it.


## ADR-0005 — Muter cannot see a Swift Testing failure, so sidecrew gives it a sentence it can read
Context: the Phase 3 prompt said to "check Muter's current Swift Testing support first; if it can't
attribute failures, fall back to running the test command yourself per mutant and document it". It
cannot, and the fallback turned out to be unnecessary — but the check turned up four *more* things
about Muter 16, and together they are why `src/verifier/swift.ts` does not simply mirror
`src/verifier/ts.ts`. Each is measured on the baseline M2 Pro / 32 GB, macOS 26.6.2, Swift 6.3.3,
muter 16 from `muter-mutation-testing/formulae`.

### 1. The finding: every Swift Testing kill was invisible

Muter decides a mutant was killed by matching this regex against the test output — read out of the
installed binary, not inferred from behaviour, in the manner ADR-0003 established:

```
with ([1-9]{1}[0-9]{0,}) failure
```

That is XCTest's summary line, `Executed 3 tests, with 3 failures`. **Swift Testing never prints it.**
A failing `@Test` prints `✘ Test run with 4 tests in 1 suite failed`, and under `swift test` the XCTest
half of the same run prints `Executed 0 tests, with 0 failures` — so the regex matches nothing, the
process exits non-zero, and Muter falls back to `runtimeError`.

Measured, on `Sources/SwiftFixture/Numbers.swift` with a Swift Testing test of `gcd` and `mean`:

| mutant | what the test did | Muter said |
|---|---|---|
| `while y != 0` → `==` | expectation failed | **runtimeError** |
| `values.count == 0` → `!=` | expectation failed | **runtimeError** |

Not one `failed` in any Swift Testing run, on any candidate, before the fix. Since `runtimeError` is
also what a crash looks like, this is not a cosmetic mislabelling: it is the difference between
evidence that a test caught something and evidence that a process died.

### 2. Why `runtimeError` could not simply be counted as a kill
The obvious one-line fix — treat `runtimeError` as `killed` — was rejected, and ADR-0012 is why. Our
`killed` is the number CLAUDE.md #2 rests on, and it means *a test reported a failure*. A crash and a
hang are neither; they are what ADR-0012 put in the `timeout` bucket for Stryker, counted towards the
score and never towards survival. Counting `runtimeError` as a kill on Swift would have made
`killed ≥ 1` satisfiable by a candidate that calls a function with an input that happens to make some
mutant crash — ADR-0006's cheapest pass, handed to the worker on the one language where the detector
cannot see it coming. It would also have counted every hung mutant as a kill.

### Decision: a wrapper that translates, rather than a mutation loop of our own
Muter runs `sh ./sidecrew-test.sh /usr/bin/xcrun swift test` instead of `xcrun swift test`. The wrapper
is generated per candidate by `testRunnerScript()`, checked in at `fixtures/swift-fixture/sidecrew-test.sh`
for a human running `muter run` by hand, and a unit test fails if the two drift apart. It does exactly
two things, and the first one is the whole of the translation:

- when the run's output says Swift Testing reported failures, it appends one line spelled the way
  Muter reads — and *only* then, so a mutant that crashed or was killed by the clock prints no such
  line and stays `runtimeError`;
- it gives every mutant a deadline (finding 3).

This is the prompt's fallback with the expensive half removed: Muter still applies the mutants, still
runs the suite, still writes the report. We own one sentence of vocabulary, not a mutation engine.
After it, the two mutants in the table above come back `failed`, and both Swift Testing candidates in
the fixture survive with `killed: 1`. `verifier-swift.slow.test.ts` asserts `killed ≥ 1` **and**
`timeout === 0` for them, which is the regression: without the wrapper, both numbers swap.

**A known conservative bias, recorded rather than fixed.** Swift Testing runs a suite in one process,
so a mutant that makes the code crash takes down tests that had already recorded failures — and the
completed-run line the wrapper greps for is never printed. Our Swift `killed` is therefore a lower
bound. It fails candidates safely rather than passing them wrongly, which is the direction ADR-0006
asks us to err in, and the sharper gate is in BACKLOG.

### 3. Muter has no per-mutant timeout, and one mutant of the fixture never finishes
`chunk` guards with `if size < 1 { throw }`. `RelationalOperatorReplacement` turns that into
`size > 1`, so the boundary candidate's own `size: 0` case reaches `i += size` and steps by zero. Muter
waits for it for ever: there is no `timeoutMS` equivalent to the one the Stryker config sets at 10 s,
and the first run of that candidate had to be killed by hand.

The wrapper's watchdog is the fix, and **the obvious watchdog does not work**, which is worth recording
because it failed silently. `xcrun` spawns `swift-test` spawns the built `xctest` binary; the first
version put the run in its own process group with `set -m` and killed the group, which is the right
instinct and reaches the two launchers only — **SwiftPM runs the test binary in a process group of its
own**. The verdict came back on time and looked correct, and the test binary carried on. It was found
as two orphaned `xctest` processes at 99.9 % CPU with `PPID 1` and `PGID` equal to their own pid,
minutes after the runs they belonged to had finished. So the watchdog kills by *working directory*
first — Muter gives each mutant its own `<sandbox>_mutated` copy, every process in that tree names the
path in its command line, and nothing else on the machine does — and by process group second.

`DEFAULT_MUTANT_TIMEOUT_S` is 60. It is a constant and it is not free: it turns that one candidate's
verdict from ~40 s into ~95 s, so on the fixture the deadline is the single largest line item in the
slowest verdict. It stays generous because a mutant killed by the clock is a mutant we learn nothing
from, and because the first mutant after Muter's copy pays for a cold build. Deriving it from the
measured baseline run is in BACKLOG.

### 4. `.build` must not be inside the sandbox
Muter copies the project to a **sibling** `<name>_mutated/` directory and works there. A `.build`
copied along with it carries a module cache that names the path it was built at, and every mutant then
fails with `missing required module 'SwiftShims'` — an entire run, reported as eight build errors,
caused by the compile stage having done its job first. So `swift build` and `swift test` are given
`--scratch-path <sandbox>-build`, a sibling of the sandbox rather than a child, and `.build` is in
`NEVER_COPY`. The verifier removes three directories at the end, not one: Muter and SwiftPM each put
theirs beside the sandbox.

### 5. `swift test` exits 0 when it runs nothing
A `--filter` that matches no test, or a class with no `test`-prefixed method, produces
`Executed 0 tests, with 0 failures` and **exit status 0**. A candidate whose tests are never selected
would pass the run stage without a single assertion being evaluated — a new entry in ADR-0006's
cheap-pass list, and one the exit code cannot see. `executedTests()` reads both frameworks' summary
lines and the run stage requires at least one test to have run. It is also why `deriveTestFilter`
returns `null` rather than guessing: a filter guessed wrong selects nothing, and nothing passes.

### 6. Muter cannot be told a line range, so the scope moves to the report
Stryker takes `--mutate src/strings.ts:20-25`; Muter takes `--files-to-mutate <file>` and nothing
finer. ADR-0013's rule — a candidate is graded only on mutants of the function it was asked to test —
is therefore applied to Muter's JSON instead of to Muter's run, using the `position.line` each mutant
carries. `killed_ids` carries `<operator>@<line>:<column>`, because Muter has no mutant ids.

Measured on the four surviving candidates (`verifier-swift-cost.json`, `"measured": true`). The
prediction was that the score would move and the clock would not, and that is exactly what happened —
the mutation stage is the *same run* either way:

| candidate | mutants counted | score | mutation stage |
|---|---|---|---|
| `slugify` | 2 → 8 | 0.50 → 0.13 | 22.07 s → 22.12 s |
| `chunk` | 2 → 5 | 1.00 → 0.40 | 78.11 s → 77.97 s |
| `percentChange` | 1 → 11 | 1.00 → 0.09 | 18.81 s → 22.02 s |
| `mapSeries` | 1 → 2 | 1.00 → 0.50 | 9.79 s → 9.72 s |

(function-scoped → whole-file). Median score **1.00 against 0.125**; median wall clock 28.0 s against
33.2 s, which is ordering noise across four candidates rather than a saving. Where ADR-0013 bought
TypeScript 3.3× *and* a usable score, Swift gets the score alone.

**And the score is a coarser signal here than it is on TypeScript, which matters to ADR-0006.** A
function-scoped Swift score is computed over **one or two mutants** — the median is 1 — because four
operators do not find much in a small function. A TypeScript candidate's score comes from 6 to 12. So
"mutation score routes survivors to review" has much less resolution on Swift: the scores above are
1.00, 1.00, 1.00, 0.50, which is nearly a boolean. Phase 7's review batching should not assume the two
languages' scores mean the same thing, and the LLM-proposed-mutants idea in ADR-0006 is worth more here
than it is on TypeScript.

One flag was measured and deliberately left alone: `muter run --skip-coverage` saves nothing. Median
28.1 s against 28.0 s with the coverage pass on. It stays available as `skipCoverage` and defaults to
Muter's own behaviour, because a deviation that buys 0.1 s is a deviation with no argument for it.

### 7. Four operators, and functions that cannot be mutated at all
Muter's whole operator set is `RelationalOperatorReplacement`, `RemoveSideEffects`,
`ChangeLogicalConnector`, `SwapTernary`. A function with no branch, no connector and no ternary — say
`Array(Set(xs))` — has **no mutants**, so `killed ≥ 1` is unreachable for a reason that has nothing to
do with the test. `verifySwift` distinguishes the two cases in the `error` text, because the single
retry must not be spent rewriting a test that was never the problem, and the fixture's functions are
written with explicit loops so that the fixture measures the verifier rather than Muter's operator set.
Both are stated in `fixtures/swift-fixture/README.md`, in the open.

### Consequences
- **The `Verdict` shape is unchanged and so is its meaning.** `failed` → `killed`, `passed` →
  `survived`, `runtimeError` → `timeout`, `noCoverage` → `no_coverage`, `buildError` counted nowhere —
  the same asymmetry, through a different tool.
- **The tautology detector gained a second dialect** (`src/verifier/tautology.ts`). The rules did not
  change; only the syntax they scan did. Swift's `import` has no `from` clause to end on, which the
  TypeScript rule would have read as "blank the rest of the file", so that branch is real.
- **`muter.conf.yml` uses `executable: /bin/sh`, not the `/usr/bin/xcrun` the prompt specified.** xcrun
  is one line down, inside the wrapper. That is the whole of the deviation.
- **Phase 4 gets two new reasons not to retry a candidate**: `stage_reached === "mutation"` already
  meant "the tool broke", and now "muter generated no mutants of this function" is a verdict the retry
  cannot improve on either.
- **This is a fact about muter 16.** The regex is internal. `verifier-swift-cost.json` records the
  muter and Swift versions in every run, so a measurement taken under a version where this changed is
  identifiable after the fact — the same protection ADR-0003 gives the mlx_lm finding.


## ADR-0006 — The verifier is a scoring rule; design it against Goodhart, not just against bugs
Context: the worker is an optimizer pointed at the verifier. The cheapest way to score well is not to write a good test but to satisfy the gate: `assert true`, `expect(x).toBe(x)`, a snapshot that pins today's (possibly wrong) output, or one weak assertion that happens to kill a single trivial mutant. This becomes acute if we ever fine-tune or select a worker on its own survivors.
Decision: every gate we add is judged by "what is the cheapest way to pass it without the test being useful?" before it ships. Current gates and their known cheap passes:
- compile / pass → tautological tests. Countered by the static tautology check.
- killed ≥ 1 → a test that kills one trivial mutant (e.g. removes a `return`) while asserting nothing about the interesting logic. Countered only partially; hence mutation *score* drives review, not survival alone.
- mutation score → snapshot-of-current-bug kills mutants and encodes the bug. Countered by review of low-score survivors and, later, LLM-proposed mutants (BACKLOG).
- equivalent mutants inflate "survived" and depress the score for good tests. Accept; treat score as a review signal, not a pass/fail.
- **New, Phase 2:** a real assertion no mutant can break — `expect(typeof applyAll("draft", [])).toBe("string")`.
  It calls the function, it is not constant, it is not a self-comparison, and the static check passes it.
  Only `killed ≥ 1` stops it, and it is in `verifier-ts.slow.test.ts` as the case that proves the
  mutation stage is not redundant with the detector.
- **New, Phase 2:** the snapshot cheap pass has a second door — writing a snapshot file that does not
  exist yet. The static check catches snapshot-only tests; `CI=true` during verification (ADR-0004)
  stops vitest recording the answer in the first place.
- **New, Phase 3:** *a test suite that runs nothing.* `swift test` exits **0** after executing zero
  tests — a `--filter` that matches nothing, or an `XCTestCase` whose methods are not named `test…`.
  The file compiles, calls the function and even asserts; no assertion is ever evaluated. The exit code
  cannot see this, so `executedTests()` counts the tests both frameworks report and the run stage
  requires at least one. It is in `verifier-swift.slow.test.ts` as the case the exit code gets wrong.
- **New, Phase 3:** *a kill earned by a crash rather than by an assertion.* Muter reports a mutant that
  killed the test process as `runtimeError`, and the cheapest way to produce one is to call a function
  with an input that makes a mutated bounds check fail — no assertion required. `runtimeError` is
  therefore counted towards the score and never towards survival (ADR-0005 §2), which is ADR-0012's
  rule for a Stryker `Timeout` applied to the outcome Swift makes common.
- **New, Phase 3, and not a cheap pass but its mirror image:** *a function Muter cannot mutate at all.*
  Four operators mean `killed ≥ 1` is unreachable for some perfectly ordinary Swift, so "your test
  killed nothing" would be a false accusation. The verdict says which of the two happened. A gate that
  cannot fire is worth naming in the same list as a gate that fires too easily.
Consequences: no single metric is the objective; survival is a filter, score is a router to review, and Claude still sees the low-confidence tail. Any new metric gets a "cheap pass" line added here before it is used for anything.

## ADR-0007 — StatusReport and ValidationReport are defined in the spec, and the spec is executable
Context: `docs/specs/pipeline.md` named `StatusReport` and `ValidationReport` in the MCP tool signatures
but never gave them a shape, so Phase 0 could not implement them "exactly as in the spec" — there was no
spec to be exact about. Separately, the phase-0 prompt asked for this decision to be recorded as ADR-0006;
that number was already taken by the Goodhart ADR, hence 0007.
Decision: (a) define both shapes in the spec, with a json example, before writing the zod for them;
(b) make `test/schemas.test.ts` extract every ```json block from the spec markdown and parse it with the
matching schema, and fail if the set of blocks and the set of schemas ever differ. The spec is now the
test fixture, so it cannot drift from the code in either direction.
Also fixed while there: the spec claimed "Pydantic models live in src/schemas.ts", a leftover from a
Python draft. Added the `Language` / `TestFramework` / `CapabilityStatus` enums the shapes were already
using implicitly.
Consequences: adding a shape means adding a spec example, not just a schema. Two invariants moved from
prose into the type system — a `Verdict` whose `survived` disagrees with its own fields does not parse,
and `BatchResult.stats.claude_tokens.workers` is a literal `0`, so a run that spent Claude tokens on
worker inference cannot be serialised. 
Amended same day: `TestFramework` is an open string, not the closed enum this ADR first shipped. The
enum would have rejected a real project at parse time, before the verifier got to say whether it could
handle it — and the verifier is what actually knows, since it has to recognise the framework to build a
run command at all. `KNOWN_TEST_FRAMEWORKS` keeps the four we can drive today as documentation.

## ADR-0008 — `doctor` fails on the machine, not on the moment
Context: the memory row failed the command whenever free RAM was below the default model's footprint.
On the baseline 32 GB machine with Xcode and a simulator open that is an ordinary Tuesday: 8.6 GB free
against a 6.5 GB need is one browser away from red, and the state clears by itself when Xcode closes.
Decision: total RAM is a property of the machine and can fail `doctor`; free RAM is a property of the
moment and only degrades it. A machine that could never fit the default model fails, as does one whose
memory we cannot read; a machine that is merely busy reports the number and the remedy and exits 0. The
run refuses on its own when there is no room at the instant it asks — that check belongs to Phase 4's
memory-aware concurrency, where the answer is still true a second later.
Consequences: the DoD still holds — memory can fail the command — but red now means something a person
has to act on. A diagnostic that goes red for a condition that fixes itself is one people learn to
ignore, and then it is not there for the case it exists for.

## ADR-0009 — Model tier by installed RAM; 16 GB machines fall back to the API
Context: sidecrew runs the worker on the user's own machine, so the machine is part of the product.
A team poll puts most machines at 24–32 GB and some at 16 GB. `src/models.json` currently offers one
`default` and two entries, both sized for 32 GB, and carries a `max_concurrency_32gb` field that bakes
one tier into its own name. Three facts constrain the answer, and two of them are uncomfortable.

**1. The obvious 16 GB model is blocked by our own licence rule.** Research §E: "Qwen2.5-Coder (except
3B) and Devstral Apache-2.0". The 3B is the exception — Qwen Research License, not Apache-2.0 — and it
is exactly the model anyone would reach for when the 7B does not fit. Non-negotiable #6 (Apache-2.0 /
MIT only for anything downloaded by default) rules it out. Any 16 GB tier needs a different model, and
picking one is a research task, not a guess: the permissive candidates our own research names in
passing (Granite Code 3B, Phi-4 family, Qwen2.5-Coder-1.5B) are all recorded as trailing Qwen2.5-Coder
at equal size, and none has a measured survival rate through our verifier.

**2. The 16 GB tier may not exist at all with Xcode open.** Research estimated ~14–18 GB usable on a
32 GB machine; `doctor` on the 32 GB baseline measures 7.0–9.5 GB actually free with the normal working
set. macOS plus Xcode plus a simulator is a roughly fixed cost, so a 16 GB machine pays it out of half
the budget and is left with very little. The 7B needs ~6.5 GB including KV. A 16 GB tier that assumes
Xcode is open is likely to be a tier that fails in the field, and shipping it would be worse than
saying no.

**3. Which model a machine may run and how many it may run are different questions.** ADR-0008 split
these for `doctor`: total RAM is a property of the machine, free RAM a property of the moment. The same
split applies here — installed RAM decides tier eligibility and therefore what gets downloaded (stable,
decidable once); free RAM decides concurrency at the instant a run starts (Phase 4's memory-aware
concurrency). `max_concurrency_32gb` should become a function of `ram_gb` and free RAM, not a field.

### Options for the 16 GB tier
- **A — a smaller permissive model.** Requires finding one that is Apache-2.0/MIT, ~2 GB at 4-bit, and
  not useless at test generation. Adds a research pass and a fourth go/no-go configuration. Highest
  effort, and may still end in "not good enough".
- **B — 16 GB means a quiet machine.** No new model. The tier exists but `doctor` tells the user to
  close Xcode, which it already measures honestly. Cheapest; narrows who can use sidecrew mid-workday.
- **C — 16 GB machines use Haiku as the worker.** The pipeline is already model-agnostic: C3 in the
  go/no-go runs Haiku through the identical funnel, and the verifier is what creates the value. Costs
  goal 3 (zero worker tokens) for those users, and **contradicts a Phase 0 contract decision** —
  `BatchResult.stats.claude_tokens.workers` is a literal `0`, so this option requires changing the
  schema that currently makes a paid worker unrepresentable.
- **D — no 16 GB tier.** `doctor` already reports that such a machine cannot host a worker. Honest, and
  free, but tells part of the team the tool is not for them.

### Also affected
The go/no-go protocol is written for one machine ("M2 Pro, 32 GB") and its decision rule produces one
verdict. If sidecrew ships tiers, the decision becomes per-tier — 32 GB could be GO while 16 GB is
NO-GO — and the 24 GB tier is currently measured by nothing at all.

### Decision — option C: 16 GB machines use the Anthropic API as the worker
Installed RAM picks the tier, free RAM picks the concurrency. 32 and 24 GB machines run the local 7B;
16 GB machines, which cannot host one alongside Xcode, fall back to the API. This trades goal 3 for
those users and is the reason non-negotiable #1 in `CLAUDE.md` is now scoped to the local tier rather
than absolute. It avoids both the licence problem and the search for a small model none of our evidence
says is good enough: the value of sidecrew is the verifier, and the verifier does not care where a
candidate came from. The go/no-go already runs Haiku through the identical funnel as C3, so the
fallback tier is the one configuration we will have measured before shipping it.

Consequences, in the order they bite:
- **The contract changed, and the guarantee with it.** `BatchResult.stats.claude_tokens.workers` was
  `z.literal(0)`, which made a paid worker unrepresentable. It is now `NonNegInt` plus a refinement:
  zero whenever `config.worker_kind` is `local`. Deleting the literal without re-stating the rule would
  have quietly downgraded the project's headline claim to a comment.
- **`Candidate` records its tier.** `worker.kind` is `local` | `api`, and `worker.seed` is nullable
  because the Anthropic API offers no seed. A `local` candidate without a seed does not parse, so
  non-negotiable #4 still holds exactly where it can. Determinism on the `api` tier is temperature 0
  and nothing more — Phase 1's 5/5 identical-output check is a local-tier test and cannot be run
  against the fallback.
- **The API tier is opt-in, never a silent default.** A 32 GB machine that happens to be busy must not
  quietly start billing; that is the free-RAM/installed-RAM distinction from ADR-0008 doing its job.
- **Non-negotiable #3 is unaffected.** Claude still reviews survivors only. That the fallback worker is
  also Claude does not make raw worker output reviewable — different call, different context, and the
  verifier sits between them either way.
- **Still open for Phase 6:** the decision rule produces one verdict for one machine, and 24 GB — the
  most common tier in the team poll — is measured by nothing. The rule needs to become per-tier.

## ADR-0010 — A pinned revision is a snapshot path, because mlx_lm has no `--revision`
Context: non-negotiable #4 says to pin HF revisions in `src/models.json`, and the Phase 1 prompt asked
`serve` to pass `--revision` to `mlx_lm.server`. It has no such flag (mlx_lm 0.31.3: `--model`,
`--adapter-path`, `--draft-model`, and sampling/concurrency options). Passing a repo id therefore always
means "whatever `main` is today", which is exactly the model-churn risk research §E names: two survival
rates taken a month apart would not be comparable, and nothing would say so.

Decision: the pin is the path. `sidecrew models --pin` resolves the commit actually in the Hugging Face
cache (`refs/main`, falling back to a single cached snapshot) and writes it into `revision`; `serve`
then passes the *snapshot directory* as `--model`. A snapshot directory is one immutable commit and
cannot reach the network, which is a stronger guarantee than a `--revision` flag would have been.

Consequences:
- Pinning requires the model to be downloaded once. Until then `serve` passes the repo id and prints a
  warning naming the exact `--pin` command; the state is visible in `sidecrew models` and in
  `WorkerRecord.pinned`, and `bench` records `pinned` per model so an unpinned measurement is never
  mistaken for a pinned one.
- A cache holding a commit other than the pinned one is reported as a mismatch and serves the cached
  one rather than silently downloading — refusing outright would strand a user whose cache was
  populated by something else, and pretending would be worse.
- The pin travels in git; the weights do not. A second machine downloads `main` and, if that has moved,
  gets the mismatch warning rather than a quiet difference.
- `pinRevision` edits the text of models.json rather than round-tripping it through JSON, so a pin
  diffs as one sha on one line; `writePin` re-parses and refuses to write if anything but that field
  changed.

## ADR-0011 — `ram_gb` is a gate value taken from the weights, not from measured peak RSS
Context: `models.json` carried research estimates (7B 5.0, 14B 9.0) that Phase 1 was meant to replace
with measurements. `sidecrew bench` measures peak RSS, so the obvious move is to write that number back.
Doing so would have been wrong in a way that is worth writing down, because the measurement is
self-undermining exactly where it matters.

Measured on the baseline M2 Pro / 32 GB, Xcode and a simulator open (`bench-2026-09-11*.json`):

| | quiet | Xcode open, 12.3 GB free | Xcode open, 9.1 GB free |
|---|---|---|---|
| 7B peak RSS | 4540 MB | 3118–4530 MB | 4530 MB |
| 7B swapped out | — | 0 MB | **0 MB** |
| 14B peak RSS | 6947 MB | 6935 MB | **4364 MB** |
| 14B swapped out | — | 0 MB | **3197 MB** |

Read the 14B column again: under memory pressure its peak RSS *fell* by 2.5 GB, while the kernel wrote
3.2 GB to disk. macOS compresses and evicts pages, so RSS stops describing what the model needs and
starts describing what the machine was willing to give it. **Peak RSS cannot detect the condition that
invalidates peak RSS**, and a gate fed from it would be loosest precisely when the machine was least
able to afford the model.

Decision, in two parts:
1. **`ram_gb` is the measured steady-state peak RSS, floored by the weight size on disk** — 7B 4.5
   (measured 4.42 GiB, weights 4.0), 14B 8.2 (measured 8.06 GiB with Xcode open, 8.17 GiB quiet; weights 7.7). Two conditions make that
   measurement meaningful, and both are load-bearing: it is taken *after* the model is fully loaded, and
   only from a run that swapped nothing. The weight size is the floor because weights must be resident
   to be used, and no amount of memory pressure can talk that number down.

   *Amended the same day, and the amendment is the interesting part.* This ADR first said "the weight
   size on disk, **not** the measured peak", because every 14B peak we had was lower than the weights
   themselves — which is impossible, and should have been read as a broken measurement rather than a
   surprising fact. It was: `serve` returned as soon as `/v1/models` answered, which mlx_lm serves from
   the Hugging Face cache while the model is still loading, so the RSS sampler was measuring a model on
   its way up. With readiness redefined as "can generate one token", the 14B measures 8.06–8.17 GiB — above
   its weights, where a footprint belongs. The original rule was right about not trusting RSS under
   pressure and wrong about why this particular number was low.
2. **`bench` records the swapout delta per model** and marks a row `trustworthy: false` once it passes
   `SWAP_NOISE_FLOOR_MB` (100 MB), so a number taken under duress is labelled rather than filed next to
   honest ones. The threshold is not zero because `vm_stat` counts swapouts system-wide: a 14B run that
   fitted comfortably still picked up 10.8 MB from unrelated processes, against 3197 MB for one that did
   not fit. A flag that fires on 10.8 MB is a flag people learn to ignore — ADR-0008's argument again.
   The exact figure is always recorded; the threshold only decides what we call it. Recording only — the
   *back-off* that reacts to this is still Phase 7's, and nothing reads the field at runtime.

Consequences:
- The gate (`ram_gb + 2 GB` free) now refuses the 14B at 9.1 GB free and allows it at 12.3 GB, which
  matches what actually happens. ADR-0008's free-vs-installed distinction is doing real work: with Xcode
  and a simulator open this machine swings across that boundary depending on what Xcode is doing, so
  "does the 14B fit alongside Xcode" has no single answer and the gate has to be asked each time.
- Peak RSS stays in the results file. It is a useful number on a quiet machine and a misleading one
  otherwise, which is why `swapped_out_mb` now sits beside it.
- The 7B is unaffected and remains the default: 0 swapouts in every configuration measured, and 37 tok/s
  with Xcode and a simulator open against 38.5 quiet — a 4 % cost for the whole working set.

## ADR-0012 — `stage_reached` is progress, not a failure code; the score is the standard one
Context: `Verdict.stage_reached` is `compile | pass | mutation | done`, and the spec's own example used
`mutation` for a run that completed the whole pipeline, which left `done` meaning nothing at all. Two of
the four values were therefore unusable, and one real situation had no name: **the mutation run itself
breaking**. A Stryker crash or timeout produces a verdict with `compile_ok`, `pass_ok` and no mutation
data — which is indistinguishable, field by field, from a test that killed nothing. Phase 4's retry loop
would retry a machine problem as though the worker had written a bad test, twice, and then escalate it
to Claude.

Decision, and it changes a contract example, so it is here rather than in a commit message:
`stage_reached` is how far the pipeline got. `compile` and `pass` mean it stopped there; `pass` also
covers "skipped mutation because the verdict was already settled", which is what a tautology does.
`mutation` means the stage ran and produced no report. `done` means every stage ran. The spec example
becomes `done`, and `docs/specs/pipeline.md` gains the table.

The same section pins the score, which had been described in a comment as `killed / (killed + survived)`.
It is the mutation-testing standard instead — `(killed + timeout) / (killed + timeout + survived +
no_coverage)`, 0 when that denominator is 0 — so a sidecrew number can be compared with a published one.
Survival does **not** follow it: `killed ≥ 1` counts the `Killed` status alone, because a mutant that
hung the suite is a mutant nothing asserted about, and CLAUDE.md #2 asks for a kill. The asymmetry is
deliberate and both halves are in the spec.

Consequences:
- `error` is still the retry's only reading material, so the most actionable sentence goes first: it is
  the one that survives the 2 KB truncation. A tautology finding names the function and the line.
- The four spec examples still parse (`done` was always in the enum), so `test/schemas.test.ts` needed no
  change — which is the point of it being executable.
- Phase 4 gets an explicit rule it would otherwise have had to invent: `stage_reached === "mutation"` is
  not a candidate failure and must not consume the single retry.

## ADR-0013 — Mutation is scoped to the function under test, not to the file
Context: the Phase 2 prompt says to point `--mutate` at the single source file. CLAUDE.md #2 is stricter
than that — "kills ≥ 1 mutant **of the function under test**" — and the fixture made the gap visible: a
candidate testing one of five functions in `strings.ts` is graded against mutants of the other four,
which no test of it could ever reach.

Decision: mutate the function's line range (`--mutate src/strings.ts:20-25`, Stryker's mutation-range
syntax) whenever the range is known. `TestPlan.functions[].line_range` carries it from Phase 5; until
then `deriveLineRange` finds it by brace matching, and finding nothing means the whole file is mutated
and the caller pays for it.

Measured on the fixture, same machine, `"measured": true` in `verifier-ts-cost.json`:

| | function-scoped | whole file |
|---|---|---|
| median wall clock per survivor | **7.2 s** | 23.4 s |
| median mutation score | **0.83** | 0.19 |

The 3.3× is the smaller half of the argument. The score is the larger one: at 0.19 the number is mostly
a report on functions nobody was asked to test, and ADR-0006 uses the score to route survivors to
review. A router fed by that signal would send everything to Claude and call it a threshold.

Consequences:
- A candidate can no longer earn its survival on a neighbouring function. It also can no longer be
  blamed for one.
- The range has to be right. A stale `line_range` from an edited module mutates the wrong lines, which
  is what `ValidationReport.stale` and the `source_sha` check exist for — Phase 5 now has a second
  reason to take them seriously.
- Whole-file mutation stays reachable (`lineRange: null`) and is what the cost script compares against.

## ADR-0014 — A Swift candidate's test target is named in the plan, because only the planner has read the package
**Status: accepted (Phase 4, 2026-09-14).** It changes `TestPlan`, so the schema and the spec move in the
same commit as this ADR.

Context: `verifySwift` needs a `SwiftTarget`, and Phase 4 has to build one from a `TestPlan`. Every field
has a source except one:

| `SwiftTarget` | from `TestPlan` |
|---|---|
| `sourceFile` | `module` |
| `functionName` | `functions[].name` |
| `lineRange` | `functions[].line_range` |
| `framework` | `test_framework` (`xctest` \| `swift-testing`) |
| `projectDir` | **nothing** — `module` is a file path, so the package root has to be found or passed |
| `testTarget` | **nothing** |

`projectDir` is the smaller problem and affects both languages: walking up from `module` to the nearest
`package.json` / `Package.swift` is unambiguous in every layout we have, and needs no contract change.

`testTarget` is the real one. A SwiftPM package with one test target needs no answer — `verifySwift`
defaults to the only one. A package with several cannot be guessed at, and guessing is the failure mode
this project keeps running into: it is right until it is silently wrong, and a candidate written into the
wrong target compiles, runs, and tests nothing anybody asked about. `verifySwift` therefore refuses and
says so, which is correct behaviour and not an answer.

### Options
- **A — add `test_target` to `TestPlan`, optional.** The planner reads the package and names the target.
  Honest and explicit; costs a contract change, a spec example, and a `ValidationReport` rule (a plan
  naming a target the package does not have is invalid). Optional keeps every existing plan parsing.
- **B — derive it from `test_framework`.** The fixture happens to have one target per framework, so this
  would work today and only today. It is the guess described above, and it would be wrong in the common
  real layout — one test target using both frameworks, which Swift 6 allows.
- **C — leave it out of the contract and pass it at the call site** (`sidecrew verify --test-target`,
  `runBatch` option). No contract change; moves the problem to whoever invokes a batch, and `BatchResult`
  then does not record what was actually verified against.
- **D — make the verifier pick when the package has exactly one test target and refuse otherwise**, which
  is what it does now, and treat multi-target packages as out of scope until a real one turns up.

### Decision — A, with D as the fallback it already implements
`TestPlan` gains an optional `test_target`. The planner is the only component that has read the package,
so it is the only one that can answer without guessing — `line_range` and `source_sha` are already in
`TestPlan` for exactly that reason. When it is absent, `verifySwift` keeps doing what it does now: it
takes the only test target if there is one, and refuses with a `VerifierSetupError` naming the targets it
found if there are several. Option C survives as an *override* rather than as the source of truth —
`sidecrew verify --test-target` and `runBatch({ testTarget })` win over the plan, because a human
verifying one file by hand should not have to edit a plan to do it.

D alone was tempting, because the fixture is the only multi-target package this repo has. But the fixture
has two targets *on purpose*, to keep the Swift Testing question answerable (ADR-0005), so "no real
multi-target package has turned up" is not something this repo can claim about its own fixtures.

Optional, not required, and that is the whole reason this is cheap: every plan written before today still
parses, and TypeScript plans never carry the field at all. The spec's `TestPlan` example stays
TypeScript and documents the field in prose; `test/schemas.test.ts` pins it with its own case rather than
by putting a Swift-only key into a TypeScript example, which would have made the example lie to make the
test pass.

Consequences:
- `sidecrew_run_batch` on a multi-target Swift package with no `test_target` in the plan fails with a
  setup error naming the targets, not with a verdict. That is the correct answer and Phase 4's
  acceptance is on the TypeScript fixture, so it is a deliberate landing point rather than a discovery.
- Phase 5's `ValidationReport` gains a rule: a plan naming a target the package does not have is
  **invalid**, not merely stale. `verifySwift` already refuses it; validating earlier turns a failure
  after the first candidate into a failure before the first token.
- A `test_target` on a TypeScript plan is meaningless rather than illegal. The schema does not reject it
  — a language-conditional required field is a refinement that would make every future language pay for
  Swift's problem — and the TypeScript dispatch ignores it.

## ADR-0015 — An exemplar names the function it tests, because verifying it means mutating that function
Context: Phase 5 made `sidecrew_plan_validate` run every exemplar through the verifier — an exemplar the
worker copies structurally is only an exemplar if it survives, and one that does not teaches twenty
candidates not to survive, quietly, in numbers that look like a bad model. But verification needs a
function to mutate. `verifyCandidate` normally takes it from `task_id`, which for a real candidate is
`<function>:<shape>:<attempt>`. An exemplar has no task, and — by design — is about a function
`functions[]` deliberately does **not** list, because listing it would hand the worker the answer for
that task and make its survival say nothing about the model.

So there was no field that said which lines to mutate, and ADR-0013 is exactly the ADR that says
mutating the wrong lines produces a verdict about code nobody asked to test.

### Options
- **A. Infer it from the exemplar's source** — read the named import, or intersect the identifiers in
  the file with the module's function names. Works on TypeScript and not on Swift, where `@testable
  import Mod` names a module and nothing finer. An inference that is right most of the time is the worst
  shape for this: it fails by mutating a different function and returning a plausible verdict.
- **B. Mutate the whole module for an exemplar.** Gives up ADR-0013's scope for one verdict per shape.
  It also changes what "survived" means for exemplars only — an exemplar could survive by killing a
  mutant of a function it never calls, which is the cheap pass ADR-0006 exists to hunt.
- **C. Name it in the plan.** One required string per shape.

### Decision — C: `TestShape.exemplar_function`, required
Required rather than optional. The field has exactly one job — making the exemplar verifiable — and an
optional version would mean `plan_validate` sometimes silently skips the check it exists to perform,
which is the failure mode this whole phase was built to remove. There was one plan in the repo when this
landed, and it was the fixture's.

`WorkerShape` omits it alongside `exemplar`, so the worker never sees it: it already has the exemplar's
text, and a second function name in the prompt is one more thing for a 7B to confuse with the function it
was actually asked about.

Consequences:
- `rangeFor`'s fallback — plan first, then `deriveLineRange` over the module — stops being a loophole and
  becomes the documented path for exemplars. It was written for this in Phase 2 and now has a caller.
- The planner has a rule it can be held to: pick one function per module to host the exemplars, and leave
  it out of `functions[]`. Measured cost of that rule, in Phase 5: a module needs **two**
  mutation-testable functions before it can have a plan at all, and `fixtures/ts-fixture/src/machine.ts`
  does not have two.
- A plan written before today does not parse. Deliberate, and cheap at one plan.

## ADR-0016 — Under strict TypeScript some functions have no mutants at all, and it is not rare
Context: ADR-0005 established, on Swift, that `killed == 0` is two different situations — the test caught
nothing, or nothing could be mutated — and said the second was "reachable on TypeScript too". That was a
prediction. Phase 5 hit it on the first module it planned.

`fixtures/ts-fixture/src/machine.ts` has three functions. Measured, with a correct and thorough test of
each: `canTransition` has 3 mutants and all 3 die. `nextState` and `applyAll` have **zero** — all four
mutation counts, not merely `killed`. Stryker generates mutants for both; its `typescript-checker` then
drops every one as a type error:

```ts
export function nextState(state: OrderState, event: OrderEvent): OrderState {
  return TRANSITIONS[state][event] ?? state;      // ?? → && gives OrderState | undefined
}                                                  // emptied body returns undefined
```

The stronger the types, the more of the mutation operator set is unreachable. This is the TypeScript
mirror of Swift's four-operator problem (ADR-0005 §7), arriving through a completely different door —
there the tool has few operators, here the tool has many and the type checker rejects them.

Decision: no code change. The verdict already distinguishes the two cases and `shouldRetry` already
refuses to spend the retry on this one; both were built for Swift and both are correct here. What
changes is what we claim and what we plan:
- The finding is pinned as a test rather than as prose (`verifier-ts.slow.test.ts`), against the fixture,
  so a future Stryker or tsconfig change that silently makes those functions mutable shows up as a failed
  test rather than as a mysterious improvement in survival rate.
- **The planner does not plan a function with no mutants**, and does not plan a module that has fewer
  than two mutation-testable functions, since one of them has to host the exemplars (ADR-0015). The TS
  fixture's `machine.ts` therefore has no plan, and `fixtures/ts-fixture/README.md` says why.
- Any survival rate reported by this project is over *plannable* functions. A go/no-go run that quietly
  included unmutable ones would report a ceiling below 100 % that has nothing to do with the model, and
  would move with the strictness of somebody's tsconfig.

Consequences: the fixture's 21 functions are not 21 tasks. Phase 5's ablation is 20 tasks over 14
functions — five host the exemplars, and two cannot be mutated. Stating the denominator is part of
stating the number.

## ADR-0017 — The exemplar's measured contribution on the TS fixture is one missing import, and we keep it anyway
Context: research §B is the evidence the planner phase rests on — human-written exemplars give the best
coverage and correctness (ICPC 2026, arXiv:2602.12256; Ahmed & Devanbu, ASE 2022) — and `CLAUDE.md`
turns that into a design: Opus writes one exemplar per shape, workers generate by analogy. Phase 5 was
supposed to confirm it on our own workload. It did not.

Measured, `experiments/go-no-go/results/prompt-ablation-2026-09-14.json`, 20 tasks over 14 functions,
qwen2.5-coder-7b-4bit, temperature 0, seed 42, one retry never used:

| variant | survived | compiled | median score of survivors | completion tokens | generate |
|---|---|---|---|---|---|
| bare | **4/20** | 5/20 | 0.93 | 248 | 7.7 s |
| bare + one sentence about the framework import | **16/20** | 20/20 | 0.93 | 258 | 9.6 s |
| bare + the exemplar | **15/20** | 20/20 | **1.00** | 218 | 6.9 s |
| bare + the exemplar + the shape rules | **17/20** | 20/20 | **1.00** | **150** | **5.3 s** |

**Every one of `bare`'s 15 compile failures was the same missing line** — `import { describe, it, expect }
from "vitest"`. Exactly the five candidates that happened to include it are the five that compiled. So
the 4 → 15 jump that looked like "the exemplar makes a small model usable" is, on this fixture, the
exemplar happening to contain an import we never asked for. The `bare+import` row was added after the
fact to separate the two claims, and it settles it: one sentence scores **16**, one *above* the full
exemplar.

Decision: **keep `exemplar+rules` as the shipped prompt** — it is what already ships, so nothing changes
— but stop claiming the exemplar is what makes the gate passable, and say what it is actually worth
here.

The reasons to keep it are real and are not the survival rate:
- **Survivor quality.** Median mutation score of survivors is **1.00** with an exemplar and **0.93**
  without. Survival is a filter; the score is what routes review (ADR-0006), and the exemplar moves the
  metric survival deliberately does not measure.
- **Cost.** 150 completion tokens against 258, and 5.3 s of generation against 9.6 s. The exemplar makes
  the model write a shorter, more focused file *faster*, which on a 20-task plan is minutes.
- **It generalises and a sentence does not.** "Import the test framework" is a fact about this project's
  vitest config. The next project has a different one, and `imports_hint` already exists because guessing
  a convention is how a discard rate ends up reporting on our tsconfig
  (`fixtures/ts-fixture/README.md`). An exemplar carries every such convention by demonstration without
  anyone having to enumerate them.

What this does **not** license:
- 16 / 15 / 17 is one or two tasks at n = 1 per cell — one seed, one model, one fixture. It is not a
  ranking, and no number in that spread should be quoted as a difference.
- The fixture is 14 small pure functions: no mocks, no setup, no lifecycle, no fakes. That is the case
  where a 7B needs structural guidance least. This experiment says nothing about what an exemplar is
  worth on code with any of those, which is most code.

Consequences:
- `docs/specs/pipeline.md` and `claude/agents/test-planner.md` point at this file for what the exemplar
  and the rules are each worth, rather than asserting it.
- Phase 6 must not report a survival rate as evidence for the exemplar mechanism. Its comparison is
  between *workers* at a fixed prompt, which is unaffected — but the README's framing of why the
  pipeline is shaped this way now has a measurement under it that is weaker than the research it cites.
- The obvious follow-up is in BACKLOG: the same ablation on a module with mocks and setup, and with
  several seeds, which is the experiment that would actually test research §B's claim for this workload.

## ADR-0018 — A Swift survival rate and a TypeScript survival rate are not the same measurement
Context: ADR-0005 established that a Swift mutation *score* is coarser than a TypeScript one and that any
threshold routing survivors to review has to be per language. Phase 5 measured the thing that ADR did not
claim, and it is worse: the **survival rule itself** is not equally hard in the two languages, so the
go/no-go's `S(C2) ≥ 0.90 · S(C3)` compares two numbers that mean different things whenever it is applied
across fixtures.

Measured — `experiments/mutant-probe/results/swift-*.json`, `"measured": true`, one throwaway test per
function through the real verifier:

| | TypeScript fixture | Swift fixture |
|---|---|---|
| functions | 21 | 21 |
| demonstrably survivable | 19 (14 planned + 5 exemplar hosts) | **15** (10 planned + 5 hosts) |
| no mutants at all | 2 (`nextState`, `applyAll` — ADR-0016) | 2 (`titleCase`, `unique`) |
| every mutant crashes instead of failing an assertion | 0 | **3** (`gcd`, `rotate`, `nextState`) |
| mutants survived the probe, killability unknown | 0 | 1 (`roundTo`) |
| mutants per survivable function | 1–14, median ~8 | 1–3, **median 1** |

Two consequences, and the second is the one that bites:

1. **`crash_only` is a Swift-shaped failure.** `killed` counts only mutants a test reported a *failure*
   against; a mutant that crashes the process lands in `timeout`, counts towards the score and never
   towards survival (ADR-0005 §2, ADR-0012). Muter's `SwapTernary` on `Machine.nextState` force-unwraps
   nil, so its single mutant can only ever crash — the function has a mutant and no test can survive it.
   Three of 21 Swift functions are like this and none of the 21 TypeScript ones are.
2. **Nine of the fifteen survivable Swift functions have exactly one mutant.** For those, `killed ≥ 1`
   *is* a mutation score of 1.00 — survival demands a perfect kill. On TypeScript, with a median of
   eight, killing any one of them suffices. The same rule is a much harder gate on Swift, and the gap is
   the tool's operator set rather than anything about the test or the model.

Decision: no change to the survival rule. It is the project's one non-negotiable and weakening it per
language would make every number incomparable with itself over time, which is worse than being
incomparable across languages. Instead:
- **Every survival rate is reported with its denominator and its language, and the two fixtures' rates
  are never averaged into one number.** Phase 6 compares configurations *within* a fixture, which is
  unaffected — C1/C2/C3 see identical tasks — and must not present a combined "sidecrew survives N %".
- `probe-mutants.ts` is run before a fixture is planned, and its `plannable` classification is what
  decides the denominator. `yes` is the only value that may be planned; `unknown` means somebody has to
  look at the surviving mutants before it can be.
- The Swift fixture's `Strings.swift` already uses explicit loops rather than Foundation chains for this
  reason (ADR-0005). It was not enough — three functions still ended up unplannable — and that is the
  fixture's finding, not the model's.

Consequences: the Swift plans cover **10 functions in 18 tasks** against TypeScript's 14 in 20. Phase 6's
Swift arm therefore has a smaller n, and a difference between configurations there needs more care than
the same difference on TypeScript, not less.

## ADR-0019 — What the go/no-go does when a configuration is not an mlx_lm.server
Context: Phase 6 compares three workers through one pipeline, and two of them are not the thing the
pipeline was built for. C1 is Apple Foundation Models behind a third-party OpenAI shim; C3 is a Claude
Code subagent, which is not an HTTP endpoint at all. Three of the harness's assumptions broke, each
quietly, and each would have produced a number that looked like a model result.

**1. The shim's streaming endpoint returns no content.** `@meridius-labs/apple-on-device-ai` 1.6.2
answers a streamed request with a single `{"delta":{},"finish_reason":"stop"}` frame and `[DONE]`.
`src/worker.ts` streams — for TTFT — so the first C1 attempt was 0/20 with every candidate the empty
string, and `--determinism` passed 3/3 on nothing. The same prompt on the same shim's non-streaming
endpoint returns a complete test file.

**2. That endpoint reports `{"prompt_tokens": 0, "completion_tokens": 0}`.** `generate` refuses a
completion with *no* usage block, because an estimate recorded as a measurement puts a fiction into
`Candidate.usage`. Zeros are worse than absent: they satisfy the guard.

**3. A subagent reports one token figure, not two.** The Agent tool returns `subagent_tokens` — about
48 k per invocation, dominated by the subagent's own system prompt and tool definitions, with no
prompt/completion split and no cache breakdown.

### Decision
- **C1 generates non-streamed**, in the experiment script, never in `src/worker.ts`. The shipped client
  streams because TTFT is a number this project reports, and growing a production code path to
  accommodate an experiment's third-party shim would put the shim's bug in the product. The cost is
  recorded rather than hidden: **C1 has no TTFT**, and `ttft_ms` equals `wall_ms` and says so.
- **A zero token count from a server that produced output is "not measured", not zero.** C1's
  per-candidate token columns are `null`. `usage_measured` is the flag, and it is checked in the
  harness rather than trusted from the wire.
- **C3's worker tokens are summed into `claude_tokens.workers` as a total** and never written into
  `Candidate.usage`, because inventing the two halves to satisfy a schema is the same sin as (2). The
  results file and REPORT label them an **upper bound** on a purpose-built API worker.
- **End-to-end latency is the sum of a task's attempts' generate + verify**, defined once for every
  configuration. The first cut wall-clocked the verify pass, which for C3 — whose generation happens in
  a subagent before the verifier ever runs — left generation out entirely and reported the *slowest*
  configuration as the fastest, 9.7 s against a true 27.5 s. `--recompute` re-derives the aggregate from
  per-attempt numbers already measured rather than re-running the verifier for noisier timings.

Consequences: C1's row is comparable with the others on survival, funnel and wall clock, and is
explicitly not comparable on TTFT or tokens. The zero-worker-tokens guarantee is untouched — C1 still
goes through `assertLocalTier`, and `BatchResult`'s refinement still makes a paid `local` run
unserialisable. The finding that matters beyond this phase is (2): a guard that asks "did the server
send usage?" does not catch a server that sends zeros, and `src/batch.ts` carries that guard today.
Hardening it is Phase 7's, in BACKLOG.

## ADR-0020 — The decision rule has a cell it cannot name, and TypeScript landed in it
Context: the go/no-go's rule, frozen before the run, names three outcomes: **GO** at
S(C2) ≥ 0.90·S(C3), **GO-WITH-14B** at 0.75–0.89 *if* S(C2b) ≥ 0.90·S(C3), and **NO-GO** below 0.75
*if* the 14B does not fix it. Measured: TypeScript S(C2) = 0.85, S(C3) = 1.00, ratio **0.85** — in the
band — with S(C2b) = **0.85**, which refutes the 14B branch rather than confirming it. No named outcome
covers "in the band, and the bigger model does not help".

The gap is not academic. It is the most likely real result for any 7B on any fixture: close enough to
be tempting, short of the bar that was set before anyone saw a number, with no bigger model to escape
to. Rounding it to GO would be picking the outcome after seeing the data, which is the one thing
writing the rule down first was meant to prevent. Rounding it to NO-GO would throw away a configuration
that reached 0.85 of Haiku at zero worker tokens and half the latency.

### Decision
Record it as **not a go** and as a hole in the rule, in both the results JSON (`verdict: "in the
75–89 % band; 14B not shown to fix it"`) and the REPORT, and change nothing in
`experiments/go-no-go/README.md` — the protocol was frozen and stays frozen for this run's record.

The fourth cell needs a name and a threshold before the next run, and that decision needs evidence this
phase does not have: whether 0.85 with a mutation-score median of **1.00** (C2's TypeScript survivors,
against C3's 0.917) is worth more or less than 1.00 with 0.917. Survival rate alone cannot answer it,
which is itself the argument that the rule was underspecified. Proposed for Phase 7, with ADR-0006's
review routing as the place the answer would land.

Consequences: Swift is a clean **NO-GO (revisit)** by the rule as written — 0.29 of Haiku, and the 14B
is *worse* at 0.11 — and that verdict needs no new cell. Only TypeScript is unresolved, and it is
unresolved in the record rather than silently resolved in whichever direction the reader prefers.

### Resolved, after the run (2026-09-14)
The fourth cell is **CONDITIONAL GO**, and it needs a second axis to be decidable at all.

**The name.** `0.75 · S(C3) ≤ S(C2) < 0.90 · S(C3)` with `S(C2b)` failing to reach `0.90 · S(C3)` is
**CONDITIONAL GO**: ship the local tier for that language, with the measured survival rate in the
README, and keep the api tier (ADR-0009) as the documented escape for anyone who wants Haiku's extra
points. It is not a GO — the bar was 0.90 and 0.85 is under it, and calling it one after the fact is
exactly the move the frozen rule exists to prevent. It is not a NO-GO either: refusing to ship a
configuration that reached 0.85 of Haiku at **zero worker tokens and half the latency** would be
throwing away the thing the project was built to find out.

**The second axis, and why the cell needed one.** Survival rate alone cannot compare these two
configurations honestly, and Phase 6 produced the counterexample rather than a hypothetical: C3 scored
20/20 on TypeScript, and one of those twenty is `truncate:boundary`, which it survived by never
asserting `text.length === maxLength` — the single input class the fixture's planted off-by-one gets
wrong. C2 *failed* that task by asserting the correct answer. A rule that reads only the survival
column scores the test that agrees with the bug above the test that catches it. So the cell carries a
**guard**: CONDITIONAL GO holds only while the median mutation score of the local tier's survivors is
**not below** the control's. Measured here: C2 **1.00** against C3 **0.917**, comfortably satisfied.

If a future run is in the band *and* its survivors score below the control's, that is a NO-GO and not a
conditional anything — it would mean the local tier is surviving less often *and* writing blunter tests
when it does, which is the case the mutation score exists to detect (ADR-0006).

**What this does not change.** The 0.90 bar stays where it is. The temptation was to move it to 0.85
because 0.85 is what we measured; a bar that relocates to wherever the result landed is not a bar.
**TypeScript is therefore CONDITIONAL GO and Swift stays NO-GO (revisit)** — 0.29 is not in the band
and no second axis rescues it.

`experiments/go-no-go/README.md` carries this as a dated amendment *below* the original rule, which is
left byte-for-byte intact: the Phase 6 record has to stay readable against the rule that was actually
in force when it ran.

## ADR-0021 — The prompt says which type a function lives in, and only when that is not already obvious
Context: Phase 6's Swift arm collapsed at the compile stage — 13 of 18 candidates never built, against
2 of 20 on TypeScript. The failures were not syntax. Every fixture function is a static member of an
enum, `line_range` slices it out of that enum, and so the worker sees

    public static func percentChange(from: Double, to: Double) throws -> Double

with `@testable import SwiftFixture` as the import hint and an exemplar that calls `Numbers.clamp(...)`.
Haiku, given those exact bytes, writes `Numbers.percentChange(...)`. The 7B writes
`SwiftFixture.percentChange(...)` — the module name from the import hint. Eight more failures in the
14B's run are the same mistake wearing different names (`Statistics`, `Order`, `String.countOccurrences`).

`TestPlan.functions[].signature` has carried the qualified name since Phase 0 —
`Numbers.percentChange(from: Double, to: Double) throws -> Double` — and `src/prompts/worker.md` has
never rendered it. The obvious fix was therefore "render the signature", and ADR-0017 is the reason not
to ship an obvious fix on the strength of its explanation.

### Measured
`scripts/signature-ablation.ts` (`npm run measure:signature-ablation -- --fixture swift|ts`), same
tasks, seed 42, temperature 0, verifier concurrency 1, **no retry** — first-attempt survival, the same
convention ADR-0017 used, so the effect is the wording's and not a second attempt's.

| fixture | variant | survived | compiled | passed | killed ≥ 1 |
|---|---|---|---|---|---|
| Swift (18) | shipped | 4 · 0.222 | 6 | 4 | 4 |
| Swift (18) | **+ qualified name** | **7 · 0.389** | **12** | 9 | 7 |
| TypeScript (20) | shipped | **17 · 0.850** | 20 | 17 | 17 |
| TypeScript (20) | + qualified name | 16 · 0.800 | 20 | 16 | 16 |

The Swift gain is the mechanism, not a coincidence: compiles nearly double, and `cannot find 'X' in
scope` / `module 'SwiftFixture' has no member named …` disappear from the error histogram, leaving
genuine Swift errors behind (`type '(Int, String)' cannot conform to 'Equatable'`). The `shipped` arm
reproduced Phase 6's first-attempt numbers exactly — 4/18 survived, 6 compiled — which is what makes
the comparison a comparison.

TypeScript **lost** a task, 17 → 16, with two lost and one gained: churn at n = 1 rather than a signal,
but not evidence of neutrality either. And there is a reason to expect a cost rather than nothing: the
TypeScript fixture's signatures are *unqualified* (`roundTo(value: number, decimals: number): number`),
so the line repeats what `function_source` and `imports_hint` already said. Redundancy is not free.

### Decision
Render it **conditionally**, on the mechanism rather than on the language: the prompt names the owning
type exactly when the signature is qualified with one, and says nothing when the function is top-level.
A TypeScript class method (`Cart.total(...)`) gets the line for the same reason Swift does; a top-level
Swift function does not.

The clause is an inline `{{#function_qualified}}` section, so **the rendered bytes are exactly one of
the two arms that were measured** — `variants/signature.md` with an owner, `variants/shipped.md`
without. That is a test (`test/prompt.test.ts`), not a claim, and it is what lets Swift's 7/18 and
TypeScript's 17/20 carry over to the shipped prompt instead of being numbers about two files nobody
ships. Phase 5's guard — "the shipped prompt is byte-identical to the ablation winner" — is kept and
narrowed to the unqualified rendering rather than deleted.

### Confirmed through the whole pipeline
The ablation is first-attempt only, so the shipped prompt was then run through the full C2 Swift
configuration — retry, escalation and all — beside the frozen record rather than on top of it
(`partials/c2-swift-signature.json`; `--tag` exists so a re-measurement cannot quietly rewrite the
verdict the experiment was frozen to produce).

| C2 · Swift, full pipeline | survived | compiled | passed | killed ≥ 1 | retried |
|---|---|---|---|---|---|
| Phase 6, shipped prompt | 4/18 · 0.222 | 5 | 4 | 4 | 14 |
| **with the qualified name** | **9/18 · 0.500** | **14** | 10 | 9 | 11 |

Consequences: **Swift is still a NO-GO, and it more than doubled.** 0.500 against Haiku's 0.778 is
**0.64**, short of the 0.75 floor — so the verdict does not change, and the honest summary is that the
largest single cause of the collapse is fixed and the language still does not clear the bar. Compiles
went 5 → 14 of 18, which is where the whole gain is; what is left fails at `pass`, meaning the 7B now
writes Swift that builds and still asserts the wrong answers. The remaining compile failures are tuple
`Equatable` conformance, invented `swift-testing` macros and `NSError` out of scope — a different
problem, needing a different fix, and not one more sentence in the prompt.

TypeScript is unaffected by construction, and that is the byte-equality test rather than an argument.
Phase 6's own verdicts stand untouched: they were taken against the prompt that shipped at the time,
and `go-no-go-2026-09-14.json` still reads the eight frozen cells and nothing else.

## ADR-0022 — The retry prompt is its own template, and a retry that would ask the same question is not spent
Context: the single retry has been in `src/prompts/worker.md` since Phase 1, as a
`{{#previous_error}}` section at the end. Two things about that turned out to be wrong in different ways.

**The wording could not be edited.** `test/prompt.test.ts` pins `worker.md`'s rendered bytes to the
ablation variants that measured them — ADR-0017 for the exemplar and the shape rules, ADR-0021 for the
owner clause — because a prompt that ships without a measurement behind it is exactly what those two ADRs
exist to prevent. The retry wording was never measured by either ablation (both are first-attempt only,
deliberately, so the effect is the wording's and not a second attempt's), and yet it lived inside the file
nothing may touch. So "improve the retry prompt" was blocked on rerunning an ablation that does not
measure it.

**A retry can be guaranteed to waste a verdict.** Phase 4's BACKLOG noticed it and nothing acted: the
retry reuses the run seed, which is right — but generation is deterministic at temperature 0 with a fixed
seed, so if the retry prompt ever comes out byte-identical to the first attempt's, the second candidate is
the first one again and the second verdict is the first one again. On TypeScript that is 7 s of Stryker
for a foregone conclusion; on Swift it is 28 s. It happens when the verifier had nothing quotable to
say — an `error` that truncates to nothing — and nothing detected it.

### Decision
`src/prompts/retry.md` holds the failure block and nothing else, and the prompt is `worker.md` rendered
plus `retry.md` rendered. On a first attempt `retry.md` renders to the empty string, so the composed
prompt is byte-identical to what one template produced before the split — which is a test
(`test/prompt.test.ts` renders the pre-split ablation variant and compares), not a claim. Every measured
byte stays attached to the measurement that produced it, and the retry wording is now a file somebody can
change and measure on its own.

Concatenation rather than a second template that repeats the instructions: the retry prompt therefore
*contains* the first attempt's prompt verbatim. The worker is being asked to fix a file it wrote, and
rearranging the instructions between attempts would vary two things at once.

And `runBatch` compares the two rendered prompts before spending the retry. Identical means escalate
immediately, with the reason saying why — the most expensive stage in the pipeline does not get to run
for an answer we already have.

Consequences: `buildPrompt(task, opts)` takes both templates as overrides, so an ablation can vary either.
`promptText` is the new seam and is what the dry run writes. The identical-prompt case has never been
observed in a real run; it is cheap to check and expensive to find out about from a latency column.

## ADR-0023 — The escalation queue is appended as the run goes, one JSON object per line
Context: `BatchResult.escalations` has existed since Phase 0 and is written when the run finishes. Phase
4's own notes have the failure mode: *"A `VerifierSetupError`, a worker that goes away mid-run or a
verifier exception rejects the `Promise.all` and the run stops with nothing written to `result.json` — the
per-task files are still on disk, but the batch has no result."* A Swift run over eighteen tasks is
twenty minutes; a plan over two hundred functions is an afternoon. The state in which that work is lost
is not rare, it is the state every interrupted run is in.

### Decision
`.sidecrew/runs/<id>/escalations.jsonl`, appended **when a task gives up** rather than assembled at the
end. One JSON object per line, because appending to a JSON array means rewriting it and a partial rewrite
is a corrupt file — a truncated last line costs one escalation rather than the queue. `readEscalations`
skips a line it cannot parse for the same reason.

`sidecrew escalate` joins the queue back to the tasks on disk and returns an `EscalationBatch`: each
failed task with **the first attempt's `WorkerTask`** — the same function source, exemplar and rules the
local worker had — plus the attempt history. Not the retry's task, which carries `previous_error`:
handing Claude a prompt that already contains a compiler error is handing it the worker's second guess
rather than the question.

**A task that throws is now contained.** It is recorded as that task's last attempt, escalated, and the
queue keeps moving — which is only honest because the queue is on disk as it happens. A
`VerifierSetupError` or a `PlanError` still stops the whole run, because those are true of every
remaining task too: a missing `stryker`, an ambiguous Swift test target or a plan that does not describe
the code will fail the next nineteen candidates exactly as it failed this one, and finding that out
twenty times is not resilience.

**`sidecrew escalate` does not call Claude, and will not.** sidecrew has no Anthropic client — ADR-0001 is
that the local tier must never grow a way to spend tokens by accident — so what it can honestly do is
build the batch. `/sidecrew escalate` in the skill is what hands it to Sonnet, and `suggested_model`
records that choice in the batch rather than in prose.

Consequences: two files now say what was escalated, and `test/batch.slow.test.ts` asserts they agree on a
run that finished — a disagreement would otherwise only show up on the run that died, which is too late.
`Escalation` and `EscalationBatch` are in `docs/specs/pipeline.md` and in `src/schemas.ts`, so the spec
test parses them like every other shape.

## ADR-0024 — Review routing: per-language threshold, a deterministic audit sample, and a cap that splits
Context: ADR-0006 says survival is a filter and the mutation score is the router; research §E says review
low-score survivors plus a random audit sample. Phase 6 then produced the argument rather than the
hypothesis — Haiku's 20/20 on TypeScript includes `truncate:boundary`, which it survived by never
asserting the boundary the planted off-by-one lives on. The routing had never been implemented, and
implementing it turned up three decisions that a sentence of prose had been hiding.

**The threshold cannot be one number.** `references/verifier.md` has said "do not use one threshold for
both" since Phase 3 and nothing enforced it. Measured: a function-scoped Swift verdict is computed over
one or two mutants (nine of the fifteen survivable fixture functions have exactly one, ADR-0018), so a
Swift survivor scores **1.00 by construction** whenever the denominator is 1, and the measured median is
1.00. A 0.6 threshold on Swift is a router wired to no destination.

**"Random 10 %" cannot mean `Math.random`.** `sidecrew review` is re-runnable on a finished run, and a
fresh draw each time means it asks about different survivors every call — which is the opposite of what
non-negotiable #4 is for, and makes "I reviewed that run" an unrepeatable claim.

**A token cap can drop the wrong thing.** The obvious implementation truncates the queue, which silently
omits the longest survivor — the one most likely to be doing something odd.

### Decision
- **Threshold per language**: TypeScript **0.6** (the phase's default, and a genuine tail against a
  measured median of 1.00 over six-to-twelve mutants), Swift **1.0** — which reads "it left a mutant alive
  out of the one or two it had", the strongest signal a four-operator mutation run can give. Both are
  defaults; `--threshold` overrides, and the queue records what was used.
- **The audit sample is a hash**, `sha256(run_id:task_id)`, taking the lowest draws among the survivors
  the threshold did *not* select. Deterministic per run, independent of arrival order, and a different
  run draws differently because the id carries the timestamp. `ceil` rather than `round`, so a six-
  survivor run audits one rather than none — those are the runs nobody checks.
- **The cap splits into batches and never drops.** An item over the cap on its own gets a batch to itself,
  over the cap, and the queue says so.

Consequences: `ReviewQueue` is in the spec and the schemas. `sidecrew review` and `sidecrew_review`
assemble it and hand it over; like `escalate`, they do not call Claude. The `survivor-reviewer` agent's
"only the ones below the threshold plus the audit sample already selected for you" is now a thing that
actually happens rather than an instruction the orchestrator had to honour by hand.

Cheap pass, in ADR-0006's sense, added before this is used for anything: **a worker that learns the
threshold could aim just above it.** Nothing selects or tunes a worker on its own review outcomes today,
and if that ever changes, the audit sample — which is drawn from exactly the survivors the threshold
passed over — is the part that stops the aim being free.

## ADR-0025 — Thermal back-off needs a measured baseline, or it does not run
Context: research §E — "sustained batches on a laptop M2 Pro sag; back off concurrency when tok/s drops".
The failure this prevents is not an error. Every candidate still generates, still verifies, still survives
or does not; the run simply takes twice as long and its `latency_ms` column describes a hot machine rather
than a model. Non-negotiable #5 covers memory; this is the other resource that degrades silently.

The tempting implementation calibrates against the run's own first few candidates. It is wrong, and
Phase 1 already measured why: **cold TTFT on a fresh worker is ~4 s of graph compilation**, which is
exactly what `sidecrew bench`'s warm-up request exists to exclude. A guard calibrated on that fires on
every run, one step per window, until concurrency is 1.

### Decision
The baseline is `decode_tok_s` for this model from the most recent `experiments/go-no-go/results/bench-*.json`
whose row is `trustworthy` — `bench`'s own flag for a run that swapped past the 100 MB noise floor
(ADR-0011), because a baseline taken while the machine was thrashing is low and a low baseline makes the
guard blind to the condition it exists to catch. **No bench, no guard**, and the run says which it is in
one line naming `sidecrew bench --model <key>`.

The rule is research §E's: the median decode rate over a **rolling two-minute window** more than **30 %**
below the baseline reduces worker concurrency by **one**. Three conditions before it fires, each of which
is a false positive it is declining to have:

- at least three samples — one slow candidate is a long prompt or a page fault, not a temperature;
- the guard must have been *watching* for two minutes — five fast samples in ten seconds are a sample of
  ten seconds;
- a back-off resets both the window and that clock, so the second step down costs another two minutes of
  evidence.

The second condition is tracked as "when did this guard start collecting", and the first implementation
got it wrong in a way worth recording because it was silent: it asked whether the *retained* window
spanned two minutes, and the window filter has already dropped everything older than two minutes — so the
retained span is whatever the sample spacing happens to make it. At ~25 s per TypeScript candidate the
oldest retained sample is 100 s old, the check never passed, and **the guard could not fire at all**. It
passed a test suite that fed samples on a tidy grid landing exactly on the boundary. There is now a test
with realistic spacing.

Stated precisely, because the loose phrasing promises more than this delivers: it is the **median of the
trailing window**, not "every sample for two minutes" — one fast candidate in the middle of a sag should
not reset anything. A machine that sags from a standing start therefore trips it after roughly *one*
window of sag rather than two, which is when half the window is slow. That is the ordinary shape of a
rolling alarm, and it is what the tests pin.

Decode rate rather than wall clock, from `decodeTokensPerSecond` — the same function `bench` used, made
structural so it takes a `Candidate`. A task's wall time is 90 % verifier on TypeScript and is bound by
Stryker, not by the GPU; comparing it against a bench number would be comparing two quantities.

**Concurrency never goes back up.** A machine that cooled enough to take the slot back will heat up again
on the next sustained stretch, and a guard that oscillates costs more in restarted work than the slot is
worth. The retired runner stands down after finishing what it is holding — killing an in-flight candidate
throws away a generation that has already been paid for. The next run re-reads free RAM and starts from
the top.

Consequences: `throttle.json` is written under the run id when anything fired, with the baseline, its
source file and every event. `BatchResult` is unchanged — the contract has no field for this and inventing
one for a diagnostic would be a contract change in the wrong direction.

### Measured, after the fact (2026-09-14)
`npm run measure:thermal`, 22 minutes of continuous generation, `experiments/thermal/results/thermal-2026-09-14.json`,
`"measured": true`. M2 Pro / 32 GB **on mains**, Xcode and a simulator open, 129 requests.

**The machine did not thermally throttle.** Median decode over the soak was **40.5 tok/s** — the baseline
to the decimal — with per-five-minute medians of 40.1, 40.5, 40.8, 40.7, 40.1. Research §E's "sustained
batches on a laptop M2 Pro sag" **did not reproduce**, under the condition that matters most: on mains.
Nothing here says what happens on battery, which this experiment cannot arrange.

**It did not hold perfectly still either, and the near-miss is the useful part.** Seven consecutive
requests between t = 237 s and t = 322 s fell to 31.4, 28.7, 25.8, 26.7, 26.7, 30.5 and 32.9 tok/s, then
the machine recovered completely for seventeen minutes. Four of those seven are **below the 28.3 tok/s
floor on their own**. The guard declined, because the quantity it tests is the median of the trailing two
minutes, which bottomed out at 30.5 — 75 % of baseline against a 70 % floor.

So the window is not decoration: a rule reading single samples would have retired a worker slot for the
rest of a run on the strength of ninety seconds that then went away. And the threshold is not set absurdly
far from what this machine does — another minute of that dip and it would have fired. That shape,
arriving and leaving, is contention rather than heat; throttling is progressive and it stays.

**What this still does not show.** No back-off was produced, so nothing downstream of one has run: the
runner standing down and the batch finishing at lower concurrency are untested, and cannot be tested on
CI, where `readMemory` returns `null`, `planConcurrency` returns 1 and the guard therefore has no slot to
give up. `ThermalGuard`'s own decision is covered against synthetic sags in `test/throttle.test.ts`.
BACKLOG carries the gap.

## ADR-0026 — The memory gate asks the kernel, not only `vm_stat`
Context: `serve` has refused below `ram_gb + 2` since Phase 1, on `free_gb` computed from `vm_stat`'s
reclaimable pages. ADR-0011 established that peak RSS is untrustworthy under pressure because macOS
compresses; Phase 6 ran into the same thing from the other side and worse — `ps` reported **205 MB** for a
7B whose weights are 4.0 GB while the machine held 6.6–9.5 GB of swap. The reclaimable-pages count moves
the same way: under pressure the kernel compresses and evicts, so **free pages go up while the machine
gets worse**. `free_gb ≥ need` is therefore necessary and not sufficient, and the gate had no second
opinion.

### Decision
`memoryGate` takes a pressure level as well, read from `kern.memorystatus_vm_pressure_level` (1 normal, 2
warn, 4 critical) — a sysctl rather than the `memory_pressure` command, which walks the whole VM to print
the same conclusion. `warn` or `critical` refuses however much memory is reported free: non-negotiable #5
says never swap, not swap a little. `unknown` — a missing sysctl, a machine that is not macOS — is neither
a pass nor a refusal: the free-RAM half still decides and the reason says only what was measured. Guessing
"normal" would claim a check that never ran; guessing "warn" would refuse every run on a machine with
plenty of room.

**And the gate can queue.** `--wait SECONDS` polls the same gate instead of refusing once. It never lowers
the bar — a queue that eventually says yes to a machine with no room is a gate with a timeout — so the
guarantee is unchanged and only the failure mode is kinder. It matters because the advice the refusal
gives is "close Xcode", and a script has no hands to close anything with.

Consequences: `bench` gates on the same function, so a bench taken under pressure is refused rather than
recorded — which is the direction ADR-0011 wanted and Phase 6 could not get. `doctor`'s memory row is
deliberately *not* changed: it describes a machine and should not go red because a browser is open
(ADR-0008), and the pressure level is a property of the moment.

## ADR-0027 — An unpinned revision is a refusal, not a warning
Context: ADR-0010 established that a pin is a cached snapshot *path*, because mlx_lm has no `--revision`.
`resolveForServe` already computes exactly the right answer and returns a `warning` for each of the three
ways a pin can fail: nothing in the cache (mlx_lm will download whatever `main` is today), a cache holding
a different commit, or no pinned revision in `models.json` at all. `serve` printed that warning and then
spent up to several minutes loading the model, so the warning scrolled off above the thing everyone
watches.

What the warning is warning about is that **every number the worker produces is incomparable with every
number the last one produced** — which is non-negotiable #4, and the reason `bench` records
`machine.mlx_lm` and `models --pin` exists at all. That is not a warning-shaped fact.

### Decision
`serve` refuses to start a worker it cannot pin, with a message naming the fix (`sidecrew models --pin
<key>`) and the escape (`--allow-unpinned`). The escape exists because the first run on a new machine has
an empty cache by definition, and because someone benching a model they are evaluating should not have to
edit `models.json` first. With it, `serve` says in as many words that this worker is not reproducible, and
`WorkerRecord.pinned` is `false` — which travels into `Candidate.worker.revision` for every candidate, so
the evidence is attached to the results rather than to a terminal that has since been closed.

Consequences: `bench --allow-unpinned` threads the same flag, since `benchOne` starts its own worker.
`test/serve.test.ts`'s lifecycle cases pass `allowUnpinned: true` — every CI runner has an empty Hugging
Face cache, and making the pin a precondition of those nine tests would test it nine times and the
lifecycle zero. The refusal has three tests of its own, driven by pointing `HF_HUB_CACHE` at an empty
directory, which needs no network and no weights.

## ADR-0028 — The test runner is a seam: Jest beside Vitest
Context: `jest` has been in `KNOWN_TEST_FRAMEWORKS` since Phase 0 as an advisory string, and nothing has
ever driven it. `verifyTs` hard-coded `vitest run <file>` and `testRunner: "vitest"`. That reads as a
preference and was actually a blocker: **React Native defaults to Jest and Nest defaults to Jest**, so
two of the three stacks this project is meant to serve could not be verified at all.

The reconnaissance that forced it (`experiments/recon/project-c-mobile.md`, measured): a real
React Native monorepo, 452,464 lines of TS/TSX across 2,358 files, **Jest 30 with a `jest-expo` preset in
every workspace, no Vitest anywhere, no Stryker anywhere**, and ~5 % line coverage with 574 exported
functions in its utility layer alone. sidecrew could not have said a single useful thing about it.

### Decision
`TsTarget.runner` is `"vitest" | "jest"`, filled from `TestPlan.test_framework` by `runnerFor`, and three
things change with it: the run stage's command, Stryker's `testRunner` plus a `jest` block, and a
pre-flight check that the matching Stryker plugin is installed.

**The command is `jest --ci --runTestsByPath <file>`**, and `--runTestsByPath` is the load-bearing flag.
It takes the path literally instead of matching it against the project's `testMatch` — a `jest-expo`
preset matches any `.test.ts` anywhere, a Nest app matches `.spec.ts` under `src/`, and a candidate
written to `test/` satisfies one and not the other. Without it, sidecrew would work on projects whose
config happened to agree with `testDirFor`. There is deliberately **no** `--passWithNoTests`: a run that
executed nothing must fail, which is ADR-0006's Swift finding applied before it could happen again.

**`enableFindRelatedTests` is off.** It is a performance optimisation worth nothing here — ADR-0004's
sandbox contains exactly one test — and it carries a specific risk: a project whose module resolution
jest cannot follow (path aliases, a monorepo, `jest-expo`) relates the mutant to *no* tests, and every
mutant returns `NoCoverage`. That reads as "your test covers nothing" when what happened is that jest
could not find it, and it would have been indistinguishable from a bad candidate.

**Stryker's runner is a separate plugin**, `@stryker-mutator/jest-runner` or `@stryker-mutator/vitest-runner`,
and it has to be installed in the *target* project. Missing, the failure is a Stryker error several
minutes into a mutation run. `verifyTs` now refuses up front with a `VerifierSetupError` — so the retry
loop cannot spend an attempt on it — and `doctor` gained a `stryker-runner` row that answers it before a
plan is written.

### The thing that did not work, and why it is in the fixture's config
The first end-to-end attempt failed every candidate with a page of type errors about code nobody wrote:
`Parameter 'id' implicitly has an 'any' type`, `Cannot assign to 'stryMutAct_9fa48' because it is a
function`. **ts-jest type-checks by default, and Stryker instruments the source it mutates** — so ts-jest
was type-checking Stryker's instrumentation.

`isolatedModules: true` (transpile-only) fixes it and costs nothing, because sidecrew type-checks in a
stage of its own: `tsc --noEmit` over the whole project *is* the compile stage and runs first, and the
mutants' type checking is Stryker's `checkers: ["typescript"]`, which is what keeps uncompilable mutants
out of the denominator (ADR-0016). Two type checks remain. The redundant third was the one breaking.

This is a fact about ts-jest rather than about sidecrew, so it lives in `fixtures/jest-fixture/jest.config.js`
with the reason next to it — any project adopting sidecrew under ts-jest will hit it.

### Measured: the runner is a seam
Same plan, same model and revision, same seed, same functions, one runner swapped:

| | ts-fixture (Vitest) | jest-fixture (Jest) |
|---|---|---|
| survived | 3/5 | **3/5** |
| survivors and scores | countOccurrences:happy_path 1.00 · countOccurrences:boundary 1.00 · commonPrefix:boundary 0.80 | **identical** |
| escalated | truncate:boundary · titleCase:happy_path | **identical** |

Identical verdicts, not merely a similar rate. `fixtures/jest-fixture` is deliberately **CommonJS/Node**
against ts-fixture's ESNext/Bundler — a copy of the vitest project with one field changed would only have
shown the runner is a seam in a project that was already vitest-shaped.

Consequences: `TestFramework` stays an open string in the contract — refusing in the schema would refuse a
project before the verifier had a chance to say whether it could handle it — and `runnerFor` is where the
verifier says no, by name, listing what there is. A latent **circular import** surfaced while wiring this
and is fixed: `doctor → verifier/ts → concurrency → serve → doctor` made `DEFAULT_VERIFIER_CONCURRENCY`
undefined at import time. `TestRunner` and `STRYKER_PLUGIN` moved to `verifier/shared.ts`, which is where
Phase 3 put the things both verifiers need for exactly this reason.

**What this does not do.** It makes Jest a supported runner; it says nothing about whether a *React Native*
project's Jest setup survives Stryker. `jest-expo` brings a preset, `setupFiles`, native module mocks and
a large `transformIgnorePatterns`, and none of that is in this fixture. That is the next experiment, and
it is deliberately not claimed here.

## ADR-0029 — What the first real project broke, and the rule each break was missing
Context: `experiments/real-world/results/project-c-2026-09-15.md` — the frozen protocol run against a
private React Native monorepo, 452k lines, Jest 30 with `jest-expo`, yarn 4 workspaces. The headline is a
clean structural null result: **Stryker's instrumenter cannot parse the project**, because its nested
`@babel/core` `require()`s `@babel/plugin-proposal-decorators` (the project needs legacy decorators for
MobX-State-Tree) and resolves an ESM-only build. `ERR_REQUIRE_ESM`, every candidate, before the test
runner is ever reached.

That answers the recon's open question in the negative and **not** where the recon expected. It asked
whether `jest-expo` survives Stryker; jest-expo was never the problem — it ran 23 candidate suites at a
2.0 s median. The blocker is the project's Babel plugin set, one layer earlier.

Four of sidecrew's own defects had to be worked around before that blocker could even be reached. Each is
fixed here, and each was a rule that had been stated somewhere in this repo and not applied.

### 1. `run` guessed which model was loaded, and the guess swapped the weights
The worst of the four, because it produces a plausible answer rather than an error.

`serve` writes `.sidecrew/worker-<port>.json` relative to the directory it ran in. `discoverWorkers` read
it relative to *its* directory. Run `serve` in the sidecrew repo and `run` in the target project — which
is the only way this tool is ever used — and there is no record, so it fell back to `probe.available[0]`:
the first entry of `/v1/models`.

**`/v1/models` is the Hugging Face cache, not the loaded model.** `doctor.ts` says so in a comment.
`bench.ts` goes further and names the consequence: *"mlx_lm reloads whenever the requested name differs
from the loaded key (`ModelProvider.load`: `if self.model_key != model_key: self._load(...)`), so guessing
wrong does not fail loudly, it quietly swaps several GB of weights."* Both comments were written by this
project. Neither was applied in `batch.ts`.

Measured on this machine: the catalogue lists the **14B first** while the pinned 7B is resident. So the
trial generated all 23 candidates on an **unpinned 14B**, on a machine where `doctor` had said in the same
session "room for one 7B, not a 14B", with every candidate recording the 14B and an empty revision, and
`--allow-unpinned` never passed. ADR-0027 made `serve` refuse an unpinned model and `run` walked straight
around it.

**Decision.** The record `serve` wrote is the only authority on what is loaded. Without one:
- exactly one model in the catalogue → use it. Nothing else could load, so the name cannot trigger a swap,
  and a worker somebody else started stays usable.
- more than one → **refuse** (`AnonymousWorkerError`), naming the models, the cause (two directories) and
  the way out.

And `sidecrewDir()` resolves worker state from `SIDECREW_DIR`, else the nearest `.sidecrew` at or above the
current directory, else `.sidecrew` here. The env var is the part that matters: walking up cannot reach a
`.sidecrew` in a *different tree*, which is the normal case.

### 2. Every hoisted workspace looked like it had nothing installed
`doctor` checked `<project>/node_modules/<pkg>` as a path and `verifyTs` required a `node_modules`
directory inside `projectDir`. npm, yarn and pnpm workspaces hoist: the trial's `packages/shared` has
**zero** entries in its own `node_modules`, and Node resolves everything from the repo root perfectly well.

So `doctor` reported every dependency of every workspace package missing, and the verifier refused to run
at all — and the protocol's step 0 says to stop if `stryker-runner` is not `ok`. **A reader following the
protocol exactly stops on a false negative.** The run only happened because the peer verified with
`require.resolve` that both packages were installed and deviated deliberately.

**Decision.** Ask Node, not the filesystem. `isResolvable(pkg, projectDir)` uses `createRequire().resolve`
from the project, which is the same question Node will ask at runtime — right in a hoisted workspace,
right with a symlinked package, right for a transitive dependency. `resolveNodeModules(projectDir)` walks
up, and the sandbox symlinks **that** rather than a path that may not exist. `doctor`'s binary rows report
"resolves, version not read" when the package loads but no `.bin` entry is reachable, which is the honest
description of a hoisted install rather than a second false negative.

### 3. The mutant probe could not run on a Jest project
`probe-mutants.ts` passed `framework: "vitest"` unconditionally. ADR-0028 taught the verifier two runners
and never taught the probe, so protocol step 2 — the step that establishes the denominator every survival
rate is over — was unexecutable on any Jest project, refusing with a message naming a plugin the project
had no reason to install. **Consequence: the trial has no mutant-density denominator, and says so.**
`--runner` now exists.

### 4. A run spent twelve minutes on a plan that had already been reported invalid
`sidecrew plan` returned INVALID; `sidecrew run` on the same plan generated and verified all 18 tasks
without comment. `runBatch` checked staleness (ADR-0013) and nothing else.

**Decision.** `runBatch` runs the **structural half** of validation first — the half that costs nothing.
Exemplar verification stays `sidecrew plan`'s job, because it costs a verdict per shape and a run should
not silently pay for it. A missing exemplar, a line range that is not the function it names, a shape no
exemplar defines: each makes every candidate fail for a reason that is not the candidate's.

Also fixed, from the same report: `sidecrew serve --help` started a worker, because every subcommand reads
its flags positionally and none looked for that one.

### What the trial measured that was not a defect
Worth recording, because three stages nobody was worried about all worked on a real 452k-line codebase:

| | |
|---|---|
| compile | **23/23**, median **10.8 s** — against the recon's 9.8 s projection, which held |
| pass | 13/23 |
| tautologies | 0/23 |
| whole run | 12 min 08 s for 18 tasks |

A **100 % compile rate** against a monorepo with path aliases, a custom tsconfig and an import hint the
model had to take on trust. And the ten pass failures cluster on four functions whose *source* is
surprising — `camelCaseToWords` has a special-case branch that its own regex makes unreachable. The model
wrote the test the code looks like it deserves. That is a different failure mode from "a 7B cannot write
TypeScript", and it suggests a use nobody designed for: which of your functions mislead a careful reader.

None of the generate-stage numbers are usable, because of defect 1.

Consequences: the protocol carries a dated amendment rather than a silent edit, since a run followed it as
written. The Stryker/Babel blocker is **not** worked around — it would mean changing the Stryker config the
verifier writes, and whether sidecrew should own that is a separate decision with a measurement in front of
it. It is in BACKLOG with the error and the mechanism.

## ADR-0030 — Stryker is the blocker, not the projects; and a zero count is not a measurement
Context: the second real-world trial (`experiments/real-world/results/project-b-2026-09-15.md`), against
a private React + Vite codebase of 576,606 lines on pnpm. It corrects the first trial's diagnosis and one
of this repo's own diagnostics.

### The mobile trial blamed the wrong layer, and so did the recon built on it
project-c failed with `ERR_REQUIRE_ESM` on `@babel/plugin-proposal-decorators`, attributed to the
project: MobX-State-Tree needs legacy decorators and the plugin is in its `babel.config.js`.
`experiments/recon/project-a-and-b.md` reasoned from that attribution to a prediction —
projects without the plugin in their Babel config would not hit it — and named project-b the most likely
of three to work.

project-b's Babel config is `preset-env` and `preset-react`. It hit the identical error. One command:

```
@stryker-mutator/core 10.0.0
└─┬ @stryker-mutator/instrumenter 10.0.0
  └── @babel/plugin-proposal-decorators 8.0.2
```

**The plugin is Stryker's own direct dependency**, pinned at a major version that is ESM-only, `require()`d
through Stryker's nested `@babel/core`. It is unrelated to the project, its decorators or its framework.
**Stryker 10 fails on every project.** Stryker 8.7.1 depends on the same plugin at 7.24.7, which is
CommonJS, and the error does not occur — which is why both fixtures have always worked.

Consequence: **the fixtures pin `@stryker-mutator/*@^8` and that is now load-bearing rather than
incidental.** ADR-0028 was developed against 8 and never saw this; the peer's trial installed `^10` because
that is what `npm i -D` gives you, and `doctor` reported `stryker 10.0.0` as `ok`.

### The real blocker for pnpm: Stryker loads none of its plugins
With Stryker 8 the Babel error is replaced by `Cannot find Checker plugin "typescript". In fact, no Checker
plugins were loaded`, and a warning that the `jest` option is unknown — the runner plugin is absent too.

`@stryker-mutator/core` sits in `.pnpm/@stryker-mutator+core@8.7.1/` and can resolve only its own declared
dependencies. The runner and the checker are **peers**, not dependencies, so core cannot reach them under
pnpm's strict layout. `public-hoist-pattern[]=@stryker-mutator/*` plus a reinstall does not fix it.

**sidecrew's sandbox is not the cause**, which was the obvious suspicion given ADR-0004 symlinks
`node_modules`: the failure reproduces running Stryker directly in the project, no sandbox involved. That
test is the most valuable thing the trial did, and it is the shape to copy — when the tool and the
environment are both suspects, take the tool out.

Not decided here: whether sidecrew should write an explicit `plugins` list into the Stryker config it
generates. It would likely fix pnpm, it is a change to the verifier, and it should be made with a
measurement rather than on this reasoning. BACKLOG.

### A zero count is not a measurement
The trial's first probe reported, for all eleven functions of a pure array-helper module:

```
  not                NOT PLANNABLE — no mutants at all
  … ×11
0/11 demonstrably survivable in array.ts
```

ADR-0016 makes that actionable: a function with no mutants can never be survived, so the planner drops it.
Dropping the whole module would have been the wrong call, because nothing of the sort had happened —
**`tsc --noEmit` had run out of heap**, `stage_reached` was `compile`, and the mutation stage never ran.
Later the same output appeared again with `stage_reached: "mutation"` when Stryker crashed.

`classifyProbe` read only the mutant counts. All four are zero when there are no mutants **and** when
nothing ran, so the counts cannot distinguish them — and the two conclusions are opposite: *do not plan
this function* against *fix your machine*.

**Decision.** `classifyProbe(counts, stageReached)` returns `not_measured` for any stage short of `done`,
and the probe prints the stage and the first line of the error. The default stays `done`, so existing
callers keep their meaning.

This is the project's own failure mode, in the project's own diagnostic: a plausible, precise, confidently
formatted number about something other than what it claims. It was caught only because eleven functions
containing `indexOf(value) === -1` obviously have mutants.

### The compile stage gets whatever heap node defaults to
The project's own script is `NODE_OPTIONS=--max-old-space-size=8192 tsc --noEmit`. sidecrew runs `tsc`
with node's default and it dies at ~52 s per candidate on a machine with 13 GB free, producing a verdict
that reads exactly like a candidate that does not compile.

`exec.run` merges the parent environment, so `NODE_OPTIONS` set by the caller does reach the stage — that
is how the rest of the trial ran. Nothing in sidecrew sets it, reports it, or can see it coming. Left in
BACKLOG rather than guessed at: the right fix is probably for the plan or the call site to carry stage
environment, and that is a contract-shaped decision.

### What neither trial has produced
Two real projects, and **zero candidates' worth of evidence about whether a local model writes good tests**
on real code. Everything found so far is about memory limits, module resolution and dependency layout.
That is worth stating plainly, because the project's headline claim still rests entirely on two fixtures
its author wrote.

## ADR-0031 — Workload #2: local models making code changes (PROPOSED, not decided)

> **Status: proposed.** Nothing here is built and nothing here is agreed. It is written down because the
> owner has stated it as the direction and it existed only in conversation, which means it did not exist.
> CLAUDE.md: a decision bigger than a function signature goes here as a proposal, with options, and gets
> asked about rather than assumed.

Context: the owner's statement of intent — *Opus plans, work is broken into small pieces, local models
make the code changes, Opus approves.* Today sidecrew has exactly one workload, unit tests for existing
code, and workers never modify source. The contract anticipated a second one from the start
(`docs/specs/pipeline.md`: "Test generation is workload #1. The `WorkerTask → Candidate → Verdict` triple
is meant to stay generic; only the verifier and the shape taxonomy are test-specific"), and PHASES lists
"second workload" against a far phase without naming it. This names it.

### What transfers unchanged
More than one would expect, which is the argument for taking it seriously:

- the whole contract — `WorkerTask → Candidate → Verdict → BatchResult`;
- determinism (temperature 0, fixed seed, pinned revision, one in-flight request);
- the zero-worker-tokens guarantee and the schema that enforces it;
- the memory gate, the queue and the thermal back-off;
- the retry rule, the escalation queue, and review routing — all of which are about *outcomes*, not about
  what the outcome is made of.

### What does not transfer, and it is the important half
**The gate.** Mutation testing exists because we generate *tests* and there is nothing to check a test
against. A code change has an obvious oracle instead, and which one depends on a distinction the phrase
"small code changes" hides:

**(a) Behaviour-preserving changes** — a rename, a null guard, a doc comment, an API migration, a lint
fix. The oracle is **the project's own existing test suite plus `tsc`**: the change survives if everything
still compiles and every test that passed before still passes. That gate is *free* — it already exists, in
the user's repo, and it is exactly what ADR-0004's sandbox currently throws away. No mutation run, no
exemplars, no planner cost per function. This is much cheaper than workload #1 and is where the idea is
strongest.

**(b) Behaviour-changing changes** — implement this function, fix this bug. Nothing in the repo knows what
the new behaviour should be, so Opus has to write the specification, which in practice means writing the
tests. And then two things go wrong at once:

1. **The economics invert.** Measured: planning cost 129,234 Claude tokens for 14 functions — and that was
   only choosing *shapes*, not writing suites. Opus writing a full spec per unit costs more than Opus
   writing the small implementation itself, unless implementations are much larger than their specs.
2. **The Goodhart asymmetry flips the wrong way.** ADR-0006 is a whole document about workers optimising
   against the gate. Today the cheapest way to pass is a tautological test, which the gate discards — the
   damage is a wasted verdict. With implementations, the cheapest way to pass a visible test is
   `if (x === 3) return 7`, and **that ships**. "Passes the tests you were shown" is not "correct". The
   known countermeasure is held-out tests, which doubles the expensive half.

### Options
- **A — behaviour-preserving changes only.** Workload #2 is refactors and migrations, gated by the
  project's existing suite. Cheapest, safest, and the gate is already written by someone else. Needs the
  sandbox to *keep* the project's tests rather than remove them — the opposite of ADR-0004, and therefore
  a real design change rather than a flag.
- **B — spec-first, visible tests only.** Opus writes the tests, workers write the implementation, the
  gate is "passes". Simple, and exposed to (b2) above. Should not ship without a measurement of how often
  a 7B special-cases.
- **C — spec-first with held-out tests.** Opus writes N visible and M hidden; the worker sees N; the gate
  runs N+M. Closes the special-casing hole. Doubles Opus's cost, which was already the expensive half.
- **D — don't.** One workload, done properly.

### What would have to be true before any of them
The same bar Phase 6 set for workload #1, and it is not rhetorical: **a frozen decision rule written
before the run, a fixture, a control, and a survival rate against it.** The failure modes differ enough
from test generation that none of Phase 6's numbers carry over — a 0.85 survival rate on writing tests
says nothing about writing implementations.

And one precondition that is not about this workload at all: **sidecrew cannot currently complete workload
#1 on any real project.** Two trials, zero candidates (ADR-0029, ADR-0030). Starting a second workload
before the first one works on somebody's code would be building on a foundation that has never held
weight.

### Recommendation, for the decision that has not been made
Option **A** first, and separately from B/C. It is a different and smaller thing than the owner described,
it reuses a gate that already exists, it has no Goodhart inversion, and it would answer the question the
vision actually turns on — *can a 7B make a correct small change to unfamiliar code at all* — without
paying for a specification to find out. B or C only afterwards, and only with A's number in hand.

## ADR-0032 — Two fixes the second trial predicted, made before the third trial rather than after it
Context: `experiments/recon/project-a-and-b.md` and `experiments/real-world/results/project-b-2026-09-15.md`
each named a defect with its mechanism and could not reach it — one because the run stopped earlier, one
because the protocol forbids touching the verifier mid-run. Both are fixed here, before the next trial, so
that trial tests them rather than rediscovering them.

### 1. The candidate is named the way the project names tests
sidecrew wrote `test/<task_id>.test.ts` always. The **pass** stage survives any convention because
`jest --ci --runTestsByPath` takes the path literally (ADR-0028). The **mutation** stage does not: Stryker
runs jest under the *project's own* config, and a NestJS `testRegex: '.*\.spec\.ts$'` — which is the
default and is what `project-a` uses — does not match a file called `foo.test.ts`. Jest finds nothing,
every mutant returns `NoCoverage`, `killed` is 0, **nothing can ever survive**, and the verdict is
indistinguishable from a test that covers nothing.

That is the same hazard ADR-0028 named when it disabled `enableFindRelatedTests`, arriving through a
different door, and it was predicted in the recon before any run.

**Decision.** `testSuffixFor(projectDir)` counts the project's existing `*.test.*` against `*.spec.*` and
names the candidate to match, defaulting to `.test.ts` on a tie or an empty project because that is both
runners' own default. Measured on the four projects to hand: `.spec.ts` for the NestJS API, `.test.ts` for
the other three.

Counting files rather than parsing a jest config, because the config may be TypeScript, may live in
`package.json`, may set neither key and rely on defaults — and because the files are what a human will
compare the candidate against when they decide whether to keep it.

### 2. An out-of-memory stage is a machine problem, not a failed candidate
`tsc --noEmit` on a 576,606-line project needs more heap than node's ~4 GB default and dies at ~52 s. The
project's own script already says the number: `NODE_OPTIONS=--max-old-space-size=8192 tsc --noEmit`.

Untreated this is the worst failure shape this project has: `compile_ok: false` with a compiler error
attached, which reads exactly like a candidate that does not compile — and the retry rule spends a second
attempt on it before escalating, so it costs twice.

**Decision.** `looksLikeOom` recognises node's three ways of saying it, and the compile and pass stages
throw a `VerifierSetupError` naming the fix rather than returning a verdict. Thrown, so the retry loop
never spends an attempt: "your toolchain cannot run this" and "your test is bad" must not reach it wearing
the same clothes.

`NODE_OPTIONS` already reaches every stage — `exec.run` merges the parent environment — so the fix is
something a caller can do today. What was missing was anything telling them to. A plan-level or
target-level stage environment is the fuller answer and stays in BACKLOG; this is the part that turns a
silent wrong verdict into an instruction.

Consequences: both are pre-conditions for the third trial rather than results of it. The prediction behind
(1) has still never been *observed* — it was fixed on the strength of reading a `testRegex`, which is
weaker evidence than this project usually acts on, and the honest note is that the next trial confirms the
fix rather than the diagnosis.

## ADR-0033 — sidecrew had a picture of what a project looks like, and a real one did not match it
Context: the project-a trial (`experiments/real-world/results/project-a-2026-09-15.md`) — NestJS 11,
TypeScript 6.0.3, 2,132 source files. The first trial to produce candidates on anybody else's code: 10
tasks, 20 candidates, 6 min 08 s.

**sidecrew's own result was 0/10, every one "did not compile", and not one of the twenty failed because
of anything in the candidate.** With the defects below neutralised by hand and only the import line
rewritten mechanically, the same twenty candidates give **20/20 compile and 0.40 survival at a median
mutation score of 0.774**.

Four of six blockers are the same mistake: sidecrew deciding what a project looks like, correctly for both
fixtures and wrongly here, and each failing in the same disguise — a compile error attributed to the
candidate, paid for twice because the retry rule spends an attempt on it.

### 1. `deriveLineRange` knew one way to declare a function
It matched `export function NAME` and nothing else. Counted across the trial's codebase:

| shape | count |
|---|---|
| `export function NAME` — the only one recognised | **23** |
| `static NAME(` | 1,429 |
| `static NAME = (` | 36 |
| `export const NAME = (` | 16 |

**1.5 %.** The idiom in NestJS, and in most of the framework world, is a class of static methods. The
run survived only because `rangeFor` prefers the plan's own `line_range` and the plan was hand-written;
`probe-mutants` has no such fallback, so protocol step 2 was unexecutable.

**Decision.** Eight patterns, ordered most-specific first, covering exported and unexported functions,
`const` arrow assignments, class methods, and class properties holding functions. Plus `bodyRange`, which
bounds a *concise* arrow body (`const f = (n) => n * 2;`) at its statement instead of brace-matching into
whatever follows — the naive version returns a range spanning several unrelated functions, which is the
one mistake ADR-0013 made expensive.

### 2. `importsHint` always wrote a named import
`import { foo } from "…"` unconditionally. The trial's module is `export default class AssetUtil` with
static methods and **no named export at all**, so the prompt contradicted itself: a false
`Import it like this:` line with, ten lines below, an exemplar importing correctly.

**The measured consequence is the most useful number in the trial:**

| | count |
|---|---|
| followed the hint (wrong) | **18 / 20** |
| followed the exemplar (right) | 2 / 20 |

and both of those two are the one task whose exemplar demonstrates that exact function, where copying it
wholesale happens to be correct — so the honest reading is **0 of 20 reasoned it out**. An explicit
imperative beats a demonstrated example, essentially always. That qualifies ADR-0017's entire subject:
the exemplar is not competing with nothing, it is competing with the instructions beside it.

**Decision.** `exportStyleFor` reads the module's own source: a named export wins where one exists, a
`export default class X` or `export default X` yields `import X from "…"`, and an unrecognisable module
falls back to a named import — a fallback now rather than an assumption.

### 3. The sandbox deleted a source directory called `reports`
`NEVER_COPY` matched a directory name **at any depth**, which is right for `node_modules` and
catastrophic for the rest. `src/modules/reports/` — a controller, a service, a module, two entities —
was deleted, and `tsc` failed with `TS2307` naming the project's own files.

**Decision.** `skipFromSandbox` splits the list: `node_modules`, `.git`, `.stryker-tmp` and
`__snapshots__` nest legitimately and are skipped at any depth; `reports`, `dist`, `coverage`,
`.nyc_output` and `.sidecrew` are output directories *only at the project root*. And sidecrew's own
mutation output moves from `reports/mutation/` to `.sidecrew-mutation/`, which removes the collision that
put `reports` on the list in the first place.

### 4. The probe could certify nothing, twice over
Three faults, all in the diagnostic rather than in the pipeline, and all of the family ADR-0030 named:

- `classifyProbe` read `killed`, `mutants`, `survived` and `timeout` but never `no_coverage`, so an
  **all-`NoCoverage`** result — the exact shape of "the runner never found the test file" — printed
  *"0 mutant(s) survived this probe; weak probe, or equivalent"*. A statement about the test, when
  nothing about the test was exercised. It now returns `not_measured`, as it does for a stage that never
  completed.
- The probe hard-coded `test/probe.<name>.test.ts` and never called `testSuffixFor`, so ADR-0032's fix —
  written for exactly this project — was not in the one place that most needed it.
- The probe wrote `"measured": true` over an **empty** `probes` array. That marker is this repo's word for
  "a machine produced this, not a projection", and over nothing it certifies nothing. It now refuses to
  write a results file with no probes in it.

### 5. A candidate byte-identical to its exemplar counted as a survivor
One did. It compiled, passed, killed 10 mutants, and was non-tautological by every existing rule — so it
would have been the run's headline survivor. It is the example, returned unchanged.

**Decision.** `copied_exemplar`, a sixth tautology code. It belongs in the detector rather than in the
batch loop because "this is not a test of the function you were asked about" is the same kind of statement
as the other five — and routing it through `tautological` means the retry rule, the escalation queue and
the review threshold all keep working without knowing about it. Whitespace-insensitive; inert when no
exemplar is supplied, which is the `sidecrew verify` case.

### Recorded and deliberately not fixed
Two blockers need a measurement this repo does not have, and guessing at a verifier change is what its own
rules forbid:

- **The symlinked `node_modules` makes `tsc` fail on the project's own code** (`TS2883`, an inferred type
  that cannot be named without a path climbing out of the sandbox). The trial's control is decisive —
  symlink fails, a real APFS clone passes, 15.3 s against 17.7 s — but whether sidecrew should clone per
  candidate, clone per run, or pass `--preserveSymlinks` is a trade nobody has measured.
- **ts-jest with diagnostics on cannot mutate at all** (ADR-0028's finding, on a project that has not
  applied ADR-0028's fix — which is the normal case, since that fix lives in a *fixture's* config).
  Worse: TypeScript 6 has broken the specific option ADR-0028 names (`isolatedModules` now demands a
  `rootDir`), while the option it did not name (`diagnostics: false`) still works. Whether sidecrew should
  write a transform into the sandbox is a design decision, not a patch.

Consequences: `MutantCounts.no_coverage` and `TautologyCode` both gained a member, and
`analyseTautology`'s third parameter now takes either a language string or an options object, so every
existing caller is unchanged. The two questions the trial was set up to answer were both answered *by
observation*: ADR-0032's `.spec.ts` fix works (0 `NoCoverage` across 85 mutants) and Stryker's
typescript-checker survives TypeScript 6.0.3 (5 `CompileError` of 85). **Both were fixes made on thinner
evidence than this project usually accepts, and both held.**

## ADR-0034 — The sandbox clones `node_modules` only when TypeScript proves it must
Context: ADR-0004 symlinked `node_modules` into each sandbox, reasoning that *"a 200 MB copy per candidate
would cost more than the mutation run"*. The project-a trial produced the control that tests it, and the
answer is that **both the original claim and its opposite are true, of different projects**.

On that project the symlink cost the entire run. TypeScript resolves a symlink to its real path, so an
inferred type in the project's own code could not be named without a relative path climbing out of
`/var/folders/…` and across the filesystem:

```
error TS2883: The inferred type of 'getWinstonConfig' cannot be named without a reference to
'../../../../../../../../../../Users/…/node_modules/logform'. This is likely not portable.
```

Every candidate, `compile_ok: false`, reported as "did not compile" — about the *project's* code, never
about the candidate. The trial's control: same sandbox, symlink replaced by a real APFS clone, nothing
else changed — **exit 2 at 15.3 s becomes exit 0 at 17.7 s**, against a 104 s mutation stage.

So cloning is obviously right there. Measured on the fixtures, it is obviously wrong: cloning
unconditionally took a verdict from **10.9 s to 17.5 s**, because their mutation stage is 6 s and the
clone is 6 s. A 60 % tax on every project to rescue the projects that need it.

### Decision
Symlink first, exactly as ADR-0004 does. If `tsc` fails **and** the output contains `TS2883`, replace the
symlink with a copy-on-write clone (`cp -Rc`) and type-check once more. Anything else about the failure,
and the verdict stands untouched.

A project that does not trip it pays nothing — re-measured at **11.1 s**, unchanged. A project that does
pays one extra compile and then works, instead of scoring zero.

The trigger is deliberately the narrowest signal available. TS2883 is emitted for exactly this situation,
it names the path that climbs out of the sandbox, and it is never about the candidate — so acting on it
cannot mask a real failure. Non-darwin, or a filesystem that cannot clone: the symlink goes back and the
original verdict stands, because a slow correct answer is better than an unavailable one.

### What this says about ADR-0004
Its reasoning was sound and its measurement was of the wrong thing — the cost of a copy, on a project
whose mutation stage is six seconds. What it could not have known is that the copy was also buying
*correctness* on projects it had not met. The symlink is still the default and this ADR does not overturn
it; it adds the case where the default is wrong and makes the tool notice by itself.

Consequences: the clone is `cp -Rc`, which on APFS shares blocks, so it is cheap in space as well as time.
`--preserveSymlinks` is the other candidate remedy, costs nothing at all, and was **not** chosen because
it changes module resolution semantics for every project — including pnpm ones, which depend on symlink
resolution — and nobody has measured what that does. It stays in BACKLOG as the cheaper fix if anyone
measures it.

---

## ADR-0035 — a file is a test when nothing imports it, not when it is spelled like one

**Status:** accepted · 15 Sep 2026 · supersedes the `TEST_FILE_PATTERN` half of ADR-0004, extends ADR-0033

### Context
The project-a re-run (`experiments/real-world/results/project-a-2026-09-15-rerun.md`) confirmed every
fix ADR-0033 and ADR-0034 made, by observation, on the project that motivated them — and still reported
**0 / 8**. One unfixed line did it, and ADR-0033 had listed it as a footnote behind five louder problems.

Four findings, each with a measurement, all from that one run:

1. **`TEST_FILE_PATTERN` matches a basename anywhere.** `src/modules/auth/auth.config.test.ts` is a NestJS
   configuration module that `test/util/test.setup.ts` imports. The sandbox deleted it, `tsc` failed on
   the project's own code, and **12 of 16 attempts died on that line and nothing else** — reported as
   "did not compile", about candidates nobody ever read. The same run with that one file restored:
   **3 / 8 survived, median mutation score 1.00**, sidecrew's own verdicts, no candidate edited.
2. **`bodyRange` brace-matches into a return-type annotation.** `): { percentage: string; color: Colour }
   => {` balances on its own line, so the range closed at the signature. The probe then printed
   `NOT PLANNABLE — no mutants at all`, which is ADR-0016's own wording for *drop this function*, about a
   function with **18 mutants, all 18 killable** — the most survivable in the module.
3. **`scripts/plan-ranges.mjs` still carried the `export function` regex ADR-0033 replaced**, and failed
   on 5 of 5 functions with "has no function called X". It is the script the planner agent is told to run.
4. **Stryker dies with `ENOTSUP … copyfile '.claude/skills'`** on a symlinked directory. Observed on both
   project-a runs. ADR-0033 enumerated it and then neither fixed it nor recorded it as unfixed; it fell
   through the write-up entirely.

### Decision

**1. A test is a leaf of the import graph.** Before copying, walk the project, follow every relative
import from everything *not* named like a test, and keep any test-named file they reach — transitively.
Removing the project's own tests is still right and is what ADR-0004 is about; the rule it was reaching
for was never "named like a test", it was "nothing that stays imports it", which is exactly why removing
tests is safe and why removing this file was not.

Measured on project-a: 2,590 code files, 353 test-named, **1 rescued** — the right one — in **449 ms**,
against a compile stage of 11.5 s and a mutation stage of 130–200 s. Path aliases are not resolved; that
is in BACKLOG. Nothing tells jest to ignore a rescued file, deliberately: the sandbox runs the project's
*own* jest config (ADR-0028), so a project whose jest would choke on that file already excludes it.

**2. A `{` in a type position does not open a body.** After `:`, `|`, `&`, `<` or `,` it is a type, so
skip the balanced group and keep looking. Checking the preceding character rather than skipping one group
is what makes `): A | { b } | { c } {` work. Verified against the real module: `getSpendVsReplacement`
now derives `[100, 124]`, the range whose control produced 18 mutants and 18 kills.

**3. `plan-ranges.mjs` imports `deriveLineRange` from the built package** instead of keeping a second
implementation of it. Checked: the fixture plans' committed `source_sha` values are unchanged, so this
fixes the real project and moves nothing else.

**4. Symlinked directories go into Stryker's `ignorePatterns`**, not out of the sandbox. `tsc` reads
through a symlink and still type-checks what is behind it, so the compile stage is unchanged and only
Stryker's own copy skips them. A project that symlinks a directory its mutants need would then get a
compile error from Stryker rather than a crash — worse to read, but scoped to that project, where the
crash is unconditional and stops the run before any candidate is judged.

### What this says about ADR-0033
It deferred two blockers on the same stated grounds — "needs a measurement nobody has". That was right
for TS2883, and ADR-0034 then made the measurement and the fix works. It was **wrong here**: no trade-off
was being weighed. A file under `src/` that the project's own `tsc` requires is not a test file, and
saying so needed no number. The number it produced instead was the entire run.

The recurring shape, now three ADRs deep (0030, 0033 #4, and finding 2 above): **a confidently formatted
claim about the code that is really a claim about the tool.** ADR-0030 hardened `classifyProbe` against
saying "no mutants" when nothing had run, and it said it anyway — because this time the falsehood entered
upstream of the classifier, in the range. Hardening the reporter does not help when the lie is in its
input.

---

## ADR-0036 — the two things that stop sidecrew running on an unmodified project

**Status:** accepted · 15 Sep 2026 · extends ADR-0028, answers the project-b blocker of ADR-0030

### Context
After ADR-0035 the sandbox no longer breaks anybody's project, and two blockers remained — one per stack.
Neither is sidecrew's bug; both are sidecrew's problem, because the tool's whole claim is *your project,
unmodified*. Both are now **reproduced on fixtures in this repo** rather than only on a private codebase,
which is the thing three trials never managed.

**Nest, and anything else on ts-jest.** ts-jest type-checks by default. Stryker instruments the source it
mutates. So ts-jest type-checks Stryker's instrumentation, and the dry run dies:

```
src/strings.ts:49:3 - error TS2630: Cannot assign to 'stryMutAct_9fa48' because it is a function.
src/strings.ts:38:27 - error TS7006: Parameter 'id' implicitly has an 'any' type.
```

ADR-0028 found this and put the remedy in *the project's own* config, reasoning that it "is a fact about
ts-jest rather than about sidecrew". Two project-a trials then showed what that reasoning costs: a stock
NestJS project cannot be mutated at all, and the one trial that produced a number had to edit the project
to get it. A tool that requires a change to the repo it is measuring has not measured that repo.

**React, and anything else on pnpm.** Stryker's plugin loader globs for plugins relative to **its own
install directory**:

```js
const pluginDirectory = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)), org);
```

Under npm or yarn that is the project's `node_modules/@stryker-mutator/`. Under pnpm it is
`.pnpm/@stryker-mutator+core@8.7.1/node_modules/@stryker-mutator/`, which contains `api`, `core`,
`instrumenter`, `util` — and not the runner or the checker, which are the *project's* dependencies rather
than core's. Reproduced here in a six-file pnpm project, sandbox out of the picture:

```
WARN OptionsValidator Unknown stryker config option "jest" … Stryker loaded plugins from: ["@stryker-mutator/*"]
ERROR Stryker Cannot find Checker plugin "typescript". In fact, no Checker plugins were loaded.
```

This also explains the observation that made no sense in ADR-0030: the project-b trial added
`public-hoist-pattern[]=@stryker-mutator/*`, reinstalled, saw the plugins appear in the project's
`node_modules/@stryker-mutator/` — and Stryker still loaded none, **because the glob never looks there.**

### Decision

**1. sidecrew writes a jest config into its own sandbox** — `.sidecrew-jest.config.cjs` — that loads the
project's config through `jest-config`'s own `readInitialOptions` and spreads it, adding only
`globals["ts-jest"].diagnostics = false`. Stryker is pointed at that file instead of the project's.

- *Why `globals` and not the transform.* It reaches ts-jest however the project configured it: an explicit
  `transform`, a `preset: "ts-jest"`, or a `jest` key in `package.json`. Patching the transform can only
  reach what it can see, which excludes presets.
- *Why a file and not Stryker's `jest.config` key.* That key is a **shallow** override —
  `{...fromFile, ...config}` in the runner — so writing `globals` through it silently drops whatever else
  the project had there, and `__DEV__` in `globals` is every React Native project.
- *Why this costs nothing.* `tsc --noEmit` over the whole project is the compile stage and runs first;
  the mutants' type checking is Stryker's `checkers: ["typescript"]` (ADR-0016). Two type checks remain
  and the redundant third is the one that breaks. **Measured**, not argued: the fixture with ts-jest at
  its own default produced *no mutation report at all* before this, and afterwards produces
  `score 0.7, killed 5, survived 3, timeout 2, killed_ids [2,6,7,8,10]` — identical to the same fixture
  under its own `isolatedModules` config, down to the mutant ids.
- It is applied only where it can apply: the runner is jest, and both `ts-jest` and `jest-config` resolve
  from the project. Otherwise the config is exactly what it was.

**2. sidecrew names the Stryker plugins by absolute path, and only when Stryker's glob cannot see them.**
The check is the semantic one — is the plugin in the directory core sits in? — rather than a replay of
Stryker's path arithmetic. A hoisted project gets `[]` and a byte-identical config, so the layout that
already worked carries no risk at all.

Bare specifiers do **not** work: `importModule` is a plain `import(name)` from inside core, so pnpm refuses
a package core does not declare. The absolute-path branch, which Stryker turns into a `file://` URL and
imports directly, is the only one that escapes. The entry point is read from the package's own manifest,
because both packages are ESM-only: `jest-runner` maps `require` to a CJS jest-environment shim, and
`typescript-checker` declares no `require` condition at all, so `require.resolve` returns the wrong file
for one and throws for the other. The default glob stays first in the list so a project's other plugins
still load.

**Measured:** the pnpm project went from `Cannot find Checker plugin "typescript"` to
`score 0.7, killed 5, survived 3, timeout 2, killed_ids [2,6,7,8,10]` — the same verdict, again, on a
third layout.

### What this does not say
Neither fix has met a real project yet. Both were built against reproductions in this repo, which is a
better position than ADR-0032's (fixed from reading a config) and a worse one than ADR-0034's (fixed
against the project that broke). The pnpm reproduction is a six-file project, not project-b's 576,606
lines, and it does not exercise Vite, path aliases, or a 763-test suite. The ts-jest reproduction is the
jest fixture's five pure functions, not a Nest service with injected dependencies.

Two smaller things the pnpm reproduction surfaced and this ADR does not fix: under a strict layout the
candidate's `import { … } from "@jest/globals"` does not resolve unless the project declares it, and
neither does `@types/node`. Both are the project's own dependency hygiene rather than sidecrew's, and both
would look like a candidate that does not compile. In BACKLOG.

---

## ADR-0037 — the compile stage can fail open, and did

**Status:** accepted · 15 Sep 2026 · found by the project-b trial
(`experiments/real-world/results/project-b-2026-09-15-unmodified.md`), fixed after it

### Context
`CLAUDE.md` non-negotiable 2 says survival is `compiles ∧ passes ∧ kills ≥ 1 ∧ non-tautological`. On
project-b the first conjunct is not evaluated, and the verdict reports `compile ok` regardless.

```
testDirFor(project-b)  →  "test"      ← does not exist; the project's tests live in src/utils/tests/
tsconfig.json include    →  ["src", "internals/startingTemplate/**/*", "src/types/**/*"]
candidate written to     →  test/<name>.test.ts        ← outside every include glob
```

So `tsc --noEmit -p tsconfig.json` type-checks the project and never opens the candidate. Two controls,
both hand-written so the answer was known in advance:

1. `const x: string = 42;` plus a call to an undefined function → **`compile ok`**, caught only at the
   pass stage and only because that particular mistake throws at runtime.
2. Two type errors that are silent at runtime → **`SURVIVED`, `compile ok`, `pass ok`, score 1.00.**

**A candidate that does not type-check survived the gate with a perfect score.**

### Why this is worse than the failures that came before it
Every earlier blocker on both stacks failed *closed*: a crash, a missing plugin, a deleted source file,
zero candidates. Loud, and fixed within a trial or two. This one fails **open** — it produces a
survivor, scores it, and `sidecrew review` would present it to Claude as verified work that a reviewer
could merge and CI would then reject. A pipeline whose entire claim is *only show Claude what survived a
real gate* is damaged more by a gate that silently passes than by one that crashes.

It also inflates any survival rate measured on such a project, by the fraction of candidates whose only
defect is a type error that does not throw. **The project-b trial therefore reports no survival rate
at all**, which is the right call and also the reason this needs fixing before that project is measured.

### Reproduced before it was fixed
`fixtures/ts-fixture/tsconfig.narrow-include.json` is the fixture with `include: ["src"]`, and
`fixtures/ts-fixture/illtyped/silent-type-errors.test.ts` is a candidate that passes and does not
type-check. Independently reproduced: **survived, `compile ok`, `pass ok`, mutation score 0.8.**

### Decision
Both halves, because either alone is wrong.

**The stage proves it did its job.** `tsc` is run with `--listFiles`, which is free — the same
invocation, with the program's file list on stdout — and the candidate's path has to be in it. This is
the assertion, and the thing it guards against is the stage passing quietly.

**And then it makes it true.** When the candidate is *not* in the program, sidecrew writes
`.sidecrew-tsconfig.json` — `{"extends": "./tsconfig.json", "files": ["<candidate>"]}` — and checks
again. `extends` inherits `include` and `exclude` when the child does not restate them, and a `files`
entry is additive, so the program grows by exactly one file and nothing else changes. Same shape as
ADR-0034's TS2883 clone: notice, widen by the minimum, check again. A project whose config already
covers the test directory never sees it.

Only if the candidate is *still* absent does it throw `VerifierSetupError`. That branch has never fired.
It is there because the alternative to failing loudly is passing quietly, and this ADR exists because
the stage did the second one.

`--listFiles` output is stripped from what the retry and the escalation queue read: a diagnostic carries
`(line,col): error TS…` and a file-list entry is a bare path. The compile stage's output is not a log.

**Measured, same fixture, same candidate:** before, `survived` at score 0.8; after, `compile_ok: false`
naming all three errors — two `TS2322` and one `TS2554`. A legitimate candidate on that same project
still survives at the same score, so the fix widens the gate's reach rather than refusing the project.

### Why this one mattered more than the rest
Every earlier blocker on both stacks failed *closed*: a crash, a missing plugin, a deleted source file,
zero candidates. Loud, and fixed within a trial or two. This one failed **open** — it manufactured a
survivor, scored it, and `sidecrew review` would have handed it to Claude as work that passed a real
gate. A tool whose entire claim is *Claude only sees what survived compile → run → mutation* is damaged
far more by a gate that silently does not check than by one that crashes.

### Consequences
`doctor` still cannot see this coming: it reports `tsc ok` without knowing the relationship between the
test directory and the tsconfig's `include`. The verifier now catches it per candidate instead, which is
later than a pre-flight check and is at least not silent. In BACKLOG.

The project-b trial deliberately reported **no survival rate**, which was the right call: any rate
measured through a fail-open gate is inflated by the fraction of candidates whose only defect is a type
error that does not throw. That project should be measured again now.

---

## ADR-0038 — ADR-0036's two fixes do not compose

**Status:** accepted · 15 Sep 2026 · found by the project-b trial, fixed after it

### Context
`src/verifier/ts.ts:776`:

```ts
const shim = runner === "jest" && isResolvable("ts-jest", projectDir) && isResolvable("jest-config", projectDir);
```

Measured on project-b (pnpm 8.15.8):

```
ts-jest      → …/node_modules/.pnpm/ts-jest@29.3.2_…/node_modules/ts-jest/dist/index.js    ✓
jest-config  → throws                                                                       ✗
```

`jest-config` is a **transitive** dependency of `jest`. pnpm's strict layout does not expose transitive
dependencies at the project root, so the shim's own guard disables it.

ADR-0036 fix 2 exists to make pnpm projects reach the mutation stage at all. ADR-0036 fix 1 exists to
stop ts-jest type-checking Stryker's instrumentation once they arrive. **Fix 1 is silently unavailable
on precisely the package manager fix 2 was written for.**

project-b is not bitten, because it sets `diagnostics: false` in its own config for unrelated reasons
(its comment says type checking is a separate CI step). A pnpm project on ts-jest at the default would
load its plugins, begin mutating, and die the ADR-0028 death with nothing explaining why.

### Decision
Option 1, confirmed by measurement on a pnpm project before it was written: `jest-config` throws from the
project root and resolves **in one hop** from `jest`'s own location, because pnpm puts a package's
dependencies next to it. `jestConfigEntry` tries the project root, then `jest`, then `jest-cli`, then
`@jest/core`, and returns the resolved path — which is **baked into the generated shim**, so the guard
and the shim cannot disagree about whether the fix is available. That was the real defect: two places
deciding the same thing by different means.

And option 3 alongside it, because a fix that turns itself off must not do it quietly. When the mutation
stage produces no report and the output contains Stryker's own instrumentation identifiers
(`stryMutAct_…`, `stryCov_…`, `stryNS_…`), the message now names the cause — ts-jest type-checking
Stryker's instrumentation — says whether the shim was written, and gives the remedy. Modelled on the OOM
message from ADR-0032, which the trial singled out as the best error in the tool.

There is no environment variable to reach for: ts-jest reads `TS_JEST`, `TS_JEST_DEBUG`, `TS_JEST_HOOKS`
and `TS_JEST_LOG`, and none of them is diagnostics. Checked rather than assumed.

### What this says about the pair
ADR-0036 closes by noting neither fix had met a real project. Both have now. The fix built against a
**six-file** reproduction (plugins) transferred to 576,606 lines unchanged; the fix built against a
**real fixture** (the ts-jest shim) is the one that turned out to be unreachable. The reproduction that
felt weaker produced the more robust fix, because it reproduced the *mechanism* rather than the symptom.

---

## ADR-0039 — `TYPE_POSITION` does not know `extends`

**Status:** accepted · 15 Sep 2026 · found by the project-a unmodified trial, fixed after it

### Context
ADR-0035 decision 2 taught `bodyRange` that a `{` after `:`, `|`, `&`, `<` or `,` is a type rather than a
body. `TYPE_POSITION` is a set of **characters**. A generic constraint opens its brace after a **word**:

```ts
145  static isValidationError<T extends { isValid: boolean }>(     ← latches here
146    result: T,
147  ): result is Extract<T, { isValid: false }> {
148    return !result.isValid;                                      ← the body
149  }
```

`previousSignificant` returns `s`, the last character of `extends`, which is not in the set. The range
closes at 145 and the body is outside the mutation scope. `scripts/plan-ranges.mjs` derives `[145,145]`,
and the probe prints:

```
isValidationError  NOT PLANNABLE — no mutants at all
```

**Control** (protocol Step 2 as sharpened), same probe test, same sandbox, range hand-written `[145,149]`:

```
SURVIVED · mutants: 1 killed · 0 survived · score 1.00
```

The module is 7/7 plannable with 14 mutants, not 6/7. The `test-planner` agent, following its own
instructions, read the probe output and dropped a function it should have planned.

### The tally that matters more than the fix
This is the **fourth** time a confidently-worded *"no mutants at all"* has been checked and been wrong —
ADR-0030 (nothing ran), ADR-0033 #4 (an empty array written as measured), ADR-0035 (the range stopped at
the return-type annotation), and this one. **It has never once been right when anybody looked.** The
protocol amendment requiring a hand-ranged control before believing that sentence was written the day
before this trial and earned its place within the hour.

ADR-0035 already named the recurring shape — *a confidently formatted claim about the code that is
really a claim about the tool* — and hardening the reporter does not help when the lie is in its input.

### Decision
A `TYPE_KEYWORD` set beside `TYPE_POSITION`, and a `{` opens a type when it follows either a character in
one or a word in the other: `extends`, `keyof`, `infer`, `is`, `as`, `implements`, `satisfies`, `typeof`,
`in`. The list is deliberately tight — `else {`, `try {` and `do {` must stay bodies, and an ordinary
body brace follows `)`. Verified against the real module: `isValidationError` derives `[145,149]`, which
is exactly the range the trial's hand-written control used.

**This is the fourth patch to the same guess, and it should be the last one made this way.** The range
should come from the TypeScript compiler's own AST, which cannot be wrong about where a body starts, and
`typescript` is already resolvable from every project sidecrew verifies — `deriveLineRange` is a
stand-in that has outlived its note saying so. That is a change to how the verifier reads code and it
needs its own measurement, so it is in BACKLOG rather than in this commit. The next time this sentence is
wrong, do that instead of adding a fifth case.

---

## ADR-0040 — `exportStyleFor` has no branch for a named class export

**Status:** accepted · 15 Sep 2026 · found by the project-a unmodified trial, fixed after it

### Context
`src/modules/import/common/import.file.utils.ts` is `export class ImportFileUtils` — a **named** class
export whose members are static. `exportStyleFor` has a branch for `export default class` and a fallback
for named exports; neither fits, so it falls through and names **the function**:

```
Import it like this:
import { hasCellContent } from "../src/modules/import/common/import.file.utils";
```

No such export exists. All 8 tasks of that module's plan carried an import line that cannot compile.
This is the ADR-0033 defect in a third shape: the declaration is recognised, the *export style* is not.

### Decision
A third `ExportStyle` kind rather than an overload of the existing one: `{ kind: "namedClass", local: "C" }`,
because `{ kind: "named" }` carries no `local` and giving it one would make every existing consumer have
to know which sort of `named` it had. `importsHint` emits `import { C } from "…"`.

The owning class is found per `export class` block, so a module exporting several names the one that
actually declares the member, and a class that does not declare it is not named just because it is
exported. Verified against the real module: `exportStyleFor` returns `ImportFileUtils`.

### The more interesting half
The baseline's most-quoted finding is that **18 of 20 candidates followed a false `imports_hint` over a
correct exemplar** — an explicit imperative beats a demonstrated example, essentially always. The planner
could not fix `exportStyleFor` and instead put one sentence at the front of both shapes' `rules`:

> Import the ImportFileUtils class by name and call the function through it exactly as the exemplar does;
> the function itself is not exported.

**13 of 13 candidates used the correct class import. 0 of 13 followed the hint.**

So the contest is not imperative-versus-example, it is **imperative-versus-imperative**, and `rules` wins
when it is specific and late. Two consequences: `rules` is a viable place to counter an `exportStyleFor`
gap while the gap is being fixed, and the module-2 survival rate in that trial is *not* depressed by this
defect — the confound was neutralised by the plan rather than by the trial.

---

## ADR-0041 — the exemplar host rule guards the wrong kind of leakage

**Status:** accepted · 15 Sep 2026 · found by the project-b trial

### Context
ADR-0015's host rule says: pick one function per module to host the exemplars and do not plan it, because
an exemplar of a function the plan also asks about hands the worker the answer and its survival then says
nothing about the model. That rule is about a host that **leaks the answer**.

Measured on `src/utils/array.ts`. The planner was offered `not` and `union` as hosts for `intersection`
and correctly refused both — one is intersection's body flipped, the other a composition of it — and
chose `notObjectArrays`. Which is intersection's **complement**.

All four attempts on `notObjectArrays` copied the exemplar's second test wholesale: same test name, same
inputs `['c','a','b']` and `['a','b','c']`, same expectation. That expectation is correct for
`intersection` and is `[]` for set difference. The function went **0/2** and every attempt read as model
error.

### Decision
The host rule extends from *syntactic twins* to *semantic neighbours*, and the agent file now asks the
question directly: if a worker copied an exemplar test wholesale and changed only the function name,
would it be right, wrong, or **wrong in a way that looks right**? Exclude the third kind. Inverses,
complements, negations and same-operation-opposite-branch pairs are the shapes to watch.

### Why this is worse than what the rule already caught
A leaked right answer **inflates** a rate: the survivor is real, it just was not earned. A leaked wrong
answer **destroys** a function's tasks and is indistinguishable, in the report, from a model that cannot
write the test. One makes the tool look better than it is; the other makes the model look worse than it
is, and nothing in the funnel can tell you which happened. The first is a measurement error you can
correct for afterwards. The second you cannot, because the evidence is gone.

This is also the second time in two trials that the *plan* has silently carried a run: ADR-0040's `rules`
sentence rescued a broken import hint 13/13, and here the host choice sank a function 0/2. The planner is
a much larger lever on the numbers than the survival-rate table makes it look, and neither effect is
visible in a `BatchResult`.

---

## ADR-0042 — a self-contradicting test file is mechanically detectable

**Status:** accepted · 15 Sep 2026 · found by the project-b trial · **option 1 implemented in Phase 14, 20 Sep 2026** — see the addendum below

### Context
The funnel now collapses at `pass` on every project measured — ten of the fourteen candidates that
type-checked on project-b asserted something untrue, and the tautology detector fired zero times. So
`pass` is where the remaining value is, and two of those ten failures share one mechanical property:

- `arrayDifference:boundary:1` asserts **contradictory results for the same call**, twice over (tests 2
  vs 6, and 3 vs 5), and repeats one test four times character-for-character.
- `mergeUniqueByKey:boundary:1` is 8/10 correct, with each wrong test contradicted by the test
  immediately after it.

The model is enumerating test *names* and writing expectations to match the name rather than the
function. A file that asserts `f(x) === a` and `f(x) === b` is wrong on its own terms, with no reference
to what `f` does — which means it is checkable without running anything and without a model.

### Options
1. **Detect and name it.** A new escalation reason — "self-contradictory: it asserts two different
   results for the same call" — so the retry prompt says the useful thing instead of pasting a jest
   failure. Small, fits the existing architecture, changes no verdict.
2. **Detect and salvage.** Drop the contradicted assertions and re-run. The trial's claim is that both
   candidates above would then have survived. This is a much bigger decision than it looks: sidecrew
   currently never edits a candidate, and a survivor assembled by deleting the parts that failed is not
   the thing CLAUDE.md #2 says survived. It would also make the survival rate incomparable with every
   number measured so far.
3. Nothing, and let the retry handle it.

### Recommendation
Option 1 now, option 2 never without an explicit decision and a fresh baseline. The measurement that
would justify option 2 is not "these two would have survived" — it is whether a salvaged test is one a
reviewer keeps, which is ADR-0020's argument about survival rate not being the whole story, pointed at
our own output for once.

### Addendum — implemented, 20 Sep 2026 (Phase 14)

`src/verifier/contradiction.ts`, reached from the retry rule: where a candidate **compiled and did not
pass**, `shouldRetry` says *"self-contradictory: it asserts `f(1, 2)` is `[1]` on line 4 and `[1, 2]`
on line 7"* instead of `compiled but did not pass`. Nothing else changed — no verdict field, no
survival, no score — which is what option 1 means and what keeps every number measured so far
comparable.

**The work went into what it refuses to call a contradiction**, because this sentence is what the one
retry is spent on and a confidently wrong sentence is worse than a useless one. It fires only when
every argument is **written out** — `f(1, "a")`, not `f(x)`, because `x` may have been reassigned and
a `beforeEach` may have rebuilt the world between the two assertions — the matcher is the same one
(`toBe` and `toEqual` are different questions), the assertion is not negated, and the expected value is
a literal too. Eight negative cases are pinned in `test/contradiction.test.ts` against five positive
ones, deliberately in that proportion.

Built on ADR-0076's compiler, which is also why it is written now and was not in Phase 7: the same
judgements over a masked string would have been a sixth regular expression.


---

## ADR-0043 — sidecrew is published when it does the vision, not when workload #1 is finished

**Status:** accepted · 16 Sep 2026 · owner's decision · supersedes the sequencing in ADR-0031 and the
first move of Phase 10

### Context
Workload #1 is finished. After ADR-0033 through ADR-0041 it produces measured survival rates on
**unmodified** real projects on both stacks — 3/8 and 4/8 on Nest, 4/10 at a median survivor mutation
score of 0.871 on React — with the gate's one fail-open hole closed and the closure demonstrated on real
worker output rather than a planted control.

The obvious next move was to publish it. The owner's call was the opposite:

> I prefer to make it public when it does my vision. I don't want to make something half baked as my
> final product.

And the vision, in the owner's words, which had lived in conversation and in ADR-0031's context paragraph
and nowhere a reader would find it:

> From outside, the user wants to change x, y, z in their source code, and the change gets done with the
> same quality Opus itself does — while from inside it's not just Opus, it's Opus with its local model
> employees.

### Decision
1. **`docs/plan/VISION.md` exists** and is the first thing `CLAUDE.md` tells a session to read. A vision
   that lives in a chat log does not exist, which is the same reason ADR-0031 was written.
2. **Publication moves behind workload #2a** — behaviour-preserving code changes, ADR-0031 option A.
   Phases renumbered: 10 workload #2a, 11 its go/no-go, 12 supervision, 13 workload #2b, 14 publish,
   15 more languages.
3. **The first published sentence is "the user asks for a change to their source and gets it."** Not
   "sidecrew writes unit tests."
4. `CLAUDE.md`'s opening changes from "narrow, verifiable subtasks — first: unit tests" to a statement of
   the general rule: **one honest gate per workload is the unit of progress**, and a workload a machine
   cannot check does not belong here at any price.

### Why this is right, beyond it being the owner's call
**Naming is sticky.** "sidecrew writes tests" is a much harder label to escape after release than it is to
broaden before one. The project would be named after its first workload, and every later capability would
read as scope creep rather than as the plan.

**The architecture was always general and the README was not.** `docs/specs/pipeline.md` has said since
Phase 0 that "test generation is workload #1" and that the `WorkerTask → Candidate → Verdict` triple is
meant to stay generic. Publishing workload #1 as the product would have made the documentation true and
the framing false.

### What it costs, recorded because it is real
Workload #1 sits unreleased for the length of Phases 10–13. Nobody outside gets to use it, and nobody
outside gets to find its next defect. **Six trials have now each found something no amount of reading
found** — including one, ADR-0037, that would have inflated a published number by a quarter. Users are the
next instrument of that kind, and this decision declines to switch it on for a while. The owner has
weighed that against shipping a waypoint under a permanent name and chosen to pay it.

### The precondition this clears
ADR-0031 refused to start workload #2 on the grounds that "sidecrew cannot currently complete workload #1
on any real project. Two trials, zero candidates." That is no longer true: six trials, three measured
rates, two stacks, unmodified projects. The stated blocker is gone and option A is Phase 10.

### Addendum, later on 16 Sep 2026 — the bar, in the owner's words
> Everything should be published when what I proposed works properly and people can use it on their code
> base with no problem.

"What I proposed" is the worked example now quoted in `VISION.md` — Opus decomposes, groups, hires,
confirms, corrects — which means the management side (ADR-0044) is inside the bar, not after it. "People
can use it on their code base" adds the `api` tier (ADR-0045) to the bar, because a 16 GB laptop where
`sidecrew run` refuses to start is a laptop where people cannot use it. Phases renumbered once more:
13 is the Haiku tier, 14 publish, 15 workload #2b (behind publish, because it is not in the bar), 16 more
languages. `VISION.md` § *What "ready to publish" means* has
the four definition-of-done lines this sentence turns into.

## ADR-0044 — The management side: what one task is, how a job is ordered, how many workers Opus "hires", and what happens when a piece comes back wrong

**Status:** accepted · 16 Sep 2026 · owner's decision — the options were written down at the owner's
request and the owner took the recommendation in each of §1, §2 and §4 the same day. §3 is a
clarification the docs already needed. Where a section says "Recommendation", read "Decision". §4's
worth is still a number Phase 12 produces; what is decided is that it gets built and measured, and the
kill switch in rule 2 is how it can lose.

### Context
The vision has two halves. The **gate** half — a machine decides what Opus sees — has six trials, forty
ADRs and a measured funnel behind it. The **management** half — Opus plans, groups, hires, confirms and
corrects — had, until today, three sentences in `VISION.md` and no design. The owner's worked example
(quoted in full in `VISION.md`) makes it concrete:

> If 100 files need to change, one worker is responsible for maybe 5–10 files, grouped in a way that makes
> sense. Each reports back when it is finished; Opus confirms the job was done properly, and if not, gives
> it the prompt to fix it.

Against that, what exists: a task is one function × one shape; a plan is flat and a run is one batch; the
only retry is mechanical (the compiler's own message appended, once, ADR-0022); after that the task
escalates and Claude or Sonnet **does the work itself** rather than telling the worker what was wrong;
and concurrency is the run's, taken from free RAM. Four gaps, one section each.

### 1. What is one task, for a code change?
Workload #1's unit — one function, one shape — was chosen because mutation is scoped to a function
(ADR-0013). Nothing about it transfers to "fix the type errors in this project".

- **A — one file per task.** The gate is exact and local: zero errors in *this* file, none introduced
  anywhere, suite still green, diff confined to this file. Confinement is trivial to check. But a change
  whose meaning spans files — a renamed type and its thirty call sites — becomes thirty tasks that each
  break the others' compile until all of them land, which is an ordering problem A cannot express.
- **B — one group of related files per task.** The owner's 5–10. Opus chooses the grouping by coupling — a
  module and its call sites, a directory, a type and its users. The gate is per group: strictly fewer
  errors overall, zero in the group's files, none introduced elsewhere, suite green, diff confined to the
  group. Matches the owner's picture, and the worker sees enough to make a coherent change. It also puts
  more code in front of a 7B at once, and whether that hurts is exactly the kind of question Phase 11
  measures rather than this ADR guesses.
- **C — Opus groups, the gate judges per file.** The group is the dispatch unit, the file the verdict
  unit. Best reporting; one verifier run per file, and the existing suite is the expensive stage (the
  Phase 10 prompt says to measure it before assuming it is cheap).

**Recommendation: B as the contract, with C's reporting for free.** The code-change `WorkerTask` carries
`files: string[]` and the ask; the verdict records the `tsc` error count **per file** before and after,
so that a per-file view exists without a per-file verifier run. Group size is a **plan field with a
default**, never a constant, because the right number is a measurement and Phase 11 is where it is taken.
Confinement is "the diff touches only `files`", which is the property the Goodhart controls in the Phase
10 prompt (`@ts-ignore`, deleting the line, editing the tsconfig) are checked against.

### 2. Steps
A refactor has waves: rename the type, *then* fix the call sites; migrate the API, *then* delete the shim.
Step N+1's baseline is the project **after step N's survivors were applied**. Today a plan is flat, a run
is one batch, and the baseline is captured once.

**Recommendation.** The plan carries an ordered `steps`; each step is a list of tasks that are independent
of one another and run in parallel; the run enforces the order and re-captures the baseline between
steps. At a step boundary the run applies that step's survivors to the sandbox, records what escalated,
and continues — it does not wait for Opus, because a decision per step is where supervision is cheap and
a *wait* per step is where a long job dies overnight. Opus reads the step report afterwards and can stop,
re-plan, or let the next step run. A task that escalates in step N does not block step N+1 unless the plan
marks it `blocking`, which is the planner's call and the default is not.

### 3. How many workers
The owner's phrase is "how many smaller model instances each step needs". The machine rewrites it: a
32 GB Mac hosts one or two resident 7B workers (Phase 1, measured), a 24 GB Mac one, and the run picks
concurrency from free RAM at the instant it starts and lowers it if the machine sags (ADR-0011,
ADR-0025). On the `api` tier (ADR-0045) the limit is the rate limit, not RAM, and it is still the run's.

**Decision, because it is a clarification rather than a choice:** there is **no `workers` field in the
plan.** Opus decides the *shape* of the work — how it is cut, grouped and ordered. The machine decides how
many pieces are in flight. "Hire ten workers for this step" means ten tasks queued against whatever is up.
The docs stop saying "instances" and say "tasks", and `VISION.md` says why.

### 4. The correction round — "if not, gives it the prompt to fix it"
This is the clause with no design behind it and the one the vision's economics turn on.

- **A — escalate only (today).** Mechanical retry, then Claude or Sonnet writes it. Cheapest to run and
  already built. Contradicts the owner's sentence outright: Opus never tells a worker anything.
- **B — one Opus-written correction per task, after the mechanical retry, against a per-run budget.** Opus
  reads the **verdict** — which gate stage failed, the tool's message, which confinement rule was broken,
  which tests regressed — and writes a short note. The worker gets the same task with `correction`
  appended and tries once more (`attempt` gains the value `2`). The budget is a count or a token cap per
  run, set in the plan, and a run that exhausts it falls back to A for the remaining tail.
- **C — a conversation.** The worker asks, Opus answers, as many turns as it takes. Ruled out: the cost is
  unbounded, and there is no evidence a 7B's questions are worth answering at Opus prices. If Phase 12
  finds that a *specific* question shape is worth it, that is a new option, not this one.

**Recommendation: B**, with three rules that keep it inside the architecture:

1. **Fed by the gate, never by raw output.** Non-negotiable #3 says Claude sees survivors only. A
   correction is written from the verdict and from what the gate itself extracted — the hunk `tsc` points
   at, the confinement checker's list of files touched and rules broken, the names of the tests that
   regressed. Opus does not read the candidate's diff to write a correction. That is the line between B
   and "Opus reviews everything", and it is also why the Phase 10 prompt says to design the code-change
   verdict for this reader now.
2. **Budgeted, and switched off by its own number.** Phase 12 measures corrected-attempt survival and the
   Opus tokens each correction cost, against what escalation would have cost. If corrected attempts do not
   survive often enough to pay for themselves, B is off by default and the docs say so. This is a frozen
   rule written before the run, as Phase 6 and Phase 11 do it.
3. **Not a substitute for the mechanical retry.** ADR-0022's retry carries the tool's own words for free;
   B is spent only when that has failed, so the cheapest correction is always tried first.

Why B rather than A, beyond the owner's sentence: an escalation hands the *whole* task to a paid model. A
correction hands it one sentence. When the worker was close — wrong import, one file it should not have
touched, one test it did not run — the sentence is cheaper than the task, and "the worker was close" is a
property the verdict can tell us. When it was not close, the budget stops the bleeding.

### The other direction — "communicate when they need to"
Unchanged from `VISION.md`: workers do not chat, they escalate, structurally and in batches. Phase 12 adds
one thing to the worker's contract — a way to return *"I cannot do this, because X"* instead of a bad
candidate, so that a refusal is an escalation with a reason rather than a verdict that failed at `compile`
for a reason nobody can read. The mechanism is what `escalations.jsonl` and `sidecrew escalate` already
do; the addition is that the worker can put itself there.

### What this changes, and where
- **Phase 10** owns the contract: `files[]`, `steps`, the code-change `Verdict` with per-file counts and a
  correction-readable failure, and `attempt ∈ {0, 1, 2}`. Hand-written plans exercise it.
- **Phase 12** owns the planner agent (Opus decides groups and steps, the way `test-planner` decides
  shapes), the correction round, its budget, its measurement, and the worker's refusal shape.
- **Non-negotiable #3** stays as written; rule 1 above is how B satisfies it.
- **`VISION.md`** now carries the worked example clause by clause and the "instances means tasks" point.

### What is not decided here
Whether B pays for itself. That is a number, Phase 12 produces it, and this ADR gets an addendum when it
exists. Nothing else in it waits on that number: Phase 10 builds the contract of §1–2 now.

## ADR-0045 — The `api` tier ships before publication, and the worker on it is Haiku

**Status:** accepted · 16 Sep 2026 · owner's decision · makes ADR-0009's option C load-bearing

### Context
ADR-0009 decided, on 11 Sep, that machines that cannot host a 7B beside a normal working set fall back to
the Anthropic API as the worker. The schema was changed to make that representable (`worker_kind`,
`claude_tokens.workers` zero only on `local`), `models.json` got a `tiers` table, and `serve` tells such a
machine which tier it is. **Nothing implements the path**: `runBatch` hard-codes `local` and refuses to
start without a local worker, so on those machines `sidecrew run` does not run (BACKLOG, since Phase 4).
Phase 6 measured Haiku through the identical funnel as configuration C3, but from a subagent harness, so
its token figures are an upper bound and not what the tier would cost.

From the owner, today:

> Since not every laptop has enough RAM for a local model, we decided to use Haiku for laptops with 16 GB
> or smaller RAM for doing the small stuff.

and, in the same message, the publication bar: *people can use it on their code base with no problem.*

### Decision
1. **It is a phase, not a backlog item.** Phase 13, before publish (14). A tool that refuses to run on a
   16 GB laptop fails the owner's bar on its own.
2. **The model is Haiku**, the current one, pinned by its **full model id** in `models.json`'s `api` tier
   the way local weights are pinned by revision (ADR-0027). A change of id is a change of configuration
   and gets a new measurement, not a silent upgrade.
3. **The boundary is installed RAM, and in code it is 24 GB.** `tiers` maps `min_ram_gb: 24` to `local`
   and everything below to `api`, per ADR-0009's reasoning that a 16 GB machine with Xcode open has no
   room. The owner says "16 GB or smaller"; the table says "less than 24", which also puts the 18 GB
   machines Apple sells on the `api` tier. That is the intended reading — 18 GB is not enough either — and
   the docs use the owner's phrase with this ADR as the footnote.
4. **The tier is decided by the machine, not opted into by the user.** ADR-0009's "opt-in, never a silent
   default" was written against one hazard — a 32 GB machine that happens to be busy must not quietly
   start billing — and that hazard stays closed: the tier comes from *installed* RAM, which does not
   change during a workday, never from free RAM. A machine that cannot host a worker gets the `api` tier
   without being asked, because the alternative is nothing. `doctor` and `serve` say which tier the
   machine is and why; `BatchResult.config.worker_kind` records which one ran. Non-negotiable #1 in
   `CLAUDE.md` is reworded to say exactly this.
5. **What holds on the tier and what does not.** The gate is identical. Non-negotiable #3 holds — the
   worker being Claude does not make raw worker output reviewable; the verifier sits between the two
   calls. Zero-worker-tokens does **not** hold and the schema already says so. Determinism is temperature 0
   and nothing more; Phase 1's 5/5 byte-identical check is a local-tier test and is not claimed here.
   Concurrency is bounded by the rate limit rather than by RAM, and it is still the run's to pick (ADR-0044 §3).
6. **Accounting comes from the API's own usage fields**, not from an estimate; `claude_tokens.workers` is
   what Anthropic billed, so that the tier's cost can be printed beside the local tier's in the README.
7. **The tier gets its own number.** Phase 11's protocol, run on the `api` tier with the real client, on
   the same fixture and the same unmodified projects. Phase 6's C3 figures are not quoted for it.

### Consequences
- A network dependency and a bill for those users, stated in `doctor` and the README rather than
  discovered. The local tier's headline — worker inference costs zero Claude tokens — is a *local-tier*
  headline and is labelled as such wherever it appears.
- `models.json`'s `api` entry stops saying "opt-in per machine" and names the model.
- The "small stuff" stays small: the `api` tier does the same tasks the local tier does. It is not a way
  to route harder work to a better model; that is what escalation is for, and escalation's default
  (`sonnet`) is unchanged.

## ADR-0046 — Workload #2a's sandbox keeps the project's tests, and ADR-0004 is not wrong

**Status:** accepted · 16 Sep 2026 · Phase 10 · narrows ADR-0004 rather than reversing it

### Context
ADR-0004 removes every test file from the sandbox, and the reasoning is measured and still correct:
Stryker attributes a kill to whatever test killed it, our verdict is a *count*, so a project with a real
suite hands every candidate a full set of kills it had nothing to do with. `killed ≥ 1` would be
satisfied by a candidate that asserts nothing, in every repository that already has tests.

Workload #2a's gate is *the project's own existing suite plus `tsc`* (ADR-0031 option A). A sandbox that
deletes the suite deletes the gate. The two rules are exact opposites and both are load-bearing, so one
of them has to be wrong — or the rule everybody was reading was never the rule.

### Decision
**ADR-0004's rule is "the sandbox contains nothing that could satisfy the gate except the candidate",
and removing the tests is what that means for workload #1.** Written that way it is not a rule about
test files at all; it is the definition of a controlled experiment, and it says the opposite thing in
the two workloads because the gate is a different object:

| | workload #1 | workload #2a |
|---|---|---|
| the gate | mutants of one function, killed by the candidate | the project's suite, plus `tsc` |
| a pre-existing test is | **the confound** — it earns kills the candidate did not | **the instrument** — it is what "behaviour preserved" is measured with |
| so the sandbox | deletes every test | **keeps every test, and forbids the candidate from touching one** |

Concretely, for #2a:

- the sandbox is a copy of the project **including its tests**, `node_modules` symlinked as before,
  and the same `skipFromSandbox` exclusions for build output and caches (ADR-0033's top-level-only
  rule is unchanged, and it was expensive);
- **editing a test file is a confinement breach** (`test_file_edited`, ADR-0048) and a plan that lists
  one in a task's `files` does not validate. That is the #2a form of ADR-0004's paranoia: the
  experiment is only controlled while the worker cannot reach the instrument;
- `__snapshots__` stays excluded for the same reason it always was — a snapshot written by somebody
  else's run is a recorded answer — with one addition: a change that would need a snapshot rewritten is
  a change that alters output, which is by definition not behaviour-preserving. It should fail.

### Why the baseline is what makes this safe
Keeping the tests reintroduces exactly the confound ADR-0004 removed — "the suite is green" would be
satisfied by a candidate that changed nothing — and the answer is not to delete anything but to stop
comparing against a constant. The gate compares against a **baseline captured in the same sandbox,
before the change, in the same way**: every test that passed *before* still passes, and at least as many
tests ran. A project with pre-existing failures is normal (project-a has 23 suites failing on missing
DB env), so "all green" was never available as a rule and is not one here.

### Consequences
- One sandbox per *step* holds the baseline; each task gets a clone of it, so tasks stay parallel
  (ADR-0044 §2 and §3). On APFS the clone is `cp -Rc`, the same trick ADR-0034 already uses for
  `node_modules`, falling back to a plain copy elsewhere.
- The cost is the project's own suite, once per baseline and once per surviving candidate. ADR-0004
  could assume the mutation stage dominated; here the suite *is* the expensive stage and the Phase 10
  prompt says to measure it rather than assume it is cheap. Phase 11 reports it, because Phase 12's
  correction round cannot be budgeted without it.
- `verifyTs`'s sandbox is untouched. This is a second sandbox for a second workload, not a flag on the
  first — the Phase 10 prompt asked for a design change rather than a flag, and a boolean that flipped
  the meaning of ADR-0004 from inside one function is how the rule would have been lost.

## ADR-0047 — The code-change contract: a task is a group of files, a candidate is whole files, a verdict is written for the correction round

**Status:** accepted · 16 Sep 2026 · Phase 10 · builds ADR-0044 §1–2 · supersedes nothing

### Context
ADR-0044 decided the management side and left Phase 10 the contract: `files[]`, ordered `steps`, no
`workers` field, a verdict with per-file counts that a correction can be written from, and `attempt ∈
{0, 1, 2}`. Three things still had to be chosen, and only one of them was obvious.

### 1. The plan, and what a task is — decided by ADR-0044 §1, built here
`ChangePlan` carries `steps[]`, each an ordered list of independent `tasks`, each a `task_id`, an `ask`,
and **`files: string[]`** — the group. The gate judges the group; the verdict records the `tsc` error
count **per file**, so C's per-file reporting comes free without a verifier run per file.

Two fields exist so that a measurement can change them without a contract change:

- **`max_group_size`**, default 10 (the owner's "5–10"), and validation refuses a task with more files.
  A plan field with a default, never a constant, because the right number is what Phase 11 measures.
- **`max_deleted_lines`** per task, default 0. *Deleting the offending line* is a cheap way to pass a
  type-error gate and *removing dead code* is a real 2a job; the difference is not in the diff, it is in
  what was asked. So the ask carries its own deletion budget and the gate enforces it (ADR-0048).

**There is no `workers` field, and that is machine-checked**: `ChangePlan` is a `strict` zod object, so a
plan carrying one does not parse. ADR-0044 §3 is a sentence in a document until something refuses.

### 2. What a worker returns — whole files, not a patch
The Phase 10 prompt: *"the diff is the artefact, not a file … prefer the smallest thing that can be
checked."* Two readings, and they disagree.

- **A — a unified diff.** Smallest on the wire, and it is literally the artefact. But a 7B emitting
  correct `@@` hunk headers against code it is reading for the first time is a known-hard ask, and the
  failure mode is *"the patch did not apply"* — a whole extra stage, an extra way to fail, and an extra
  thing a verdict has to represent. Worse, it is a failure that says nothing about whether the model
  understood the change.
- **B — the full new contents of each file it changed.** Larger on the wire and it costs completion
  tokens proportional to file size. But application is mechanical and cannot fail, confinement is
  decidable *before* a byte is written, and the diff can be computed exactly rather than trusted.

**Decision: B.** `ChangeCandidate.edits` is `[{ path, contents }]`, and sidecrew derives the diff. What
this buys is the property the gate needs most: **nothing is written until confinement has passed**,
because confinement is a pure function of the task's `files[].source` and the candidate's `contents` —
no patch to apply first, no partially-applied state to reason about.

**What it costs, recorded now rather than discovered in Phase 11.** Asking a 7B to reproduce a 300-line
file with one line changed is expensive and is the most likely way this workload fails for a reason that
is not about reasoning. So the candidate carries `truncated` (the completion hit the token ceiling) and
`unparsed` (the answer could not be read as edits), and `FixResult.stats` counts both, by name, as
funnel rows of their own. Phase 11's frozen rule (§4.4) turns that into a verdict about the *format*
rather than about the model: at or above a quarter of attempts, the run is inconclusive and the next
action is a search/replace-block experiment, not a no-go on workload #2a. A design decision that can be
measured out of the way is worth more than the right guess.

### 3. The verdict is written for a reader who arrives in Phase 12
ADR-0044 §4 rule 1: a correction is written from the **verdict** and from what the gate extracted —
never from the candidate's diff. So `ChangeVerdict` says, precisely:

- `errors.remaining_in_target` — which of the task's own files still have `tsc` errors, and how many;
- `errors.introduced` — which files anywhere gained errors, and how many;
- `errors.message` — the compiler's own words, truncated to the contract's 2 KB;
- `tests.regressed` — the **names** of the tests that passed before and do not now;
- `tests.ran_before` / `ran_after` / `reported` — whether the suite ran at all, and on how much;
- `confinement[]` — which rule the diff broke, in which file, with the offending line.

Every one of those is a sentence a correction can be written from without reading a line of worker
output, which is what keeps non-negotiable #3 true when Phase 12 arrives.

`attempt` is `0 | 1 | 2` and `correction` is a nullable field on `ChangeTask` today. Phase 12 fills it.
Deciding this after the schema existed would have been a second ADR and a migration; ADR-0044 said so
and it cost a field.

### Consequences
- `docs/specs/pipeline.md` gains a workload-#2a section with an example of each shape, and
  `test/schemas.test.ts` parses them, so the two cannot drift (ADR-0007).
- `Candidate` and `ChangeCandidate` now share one `worker` stamp, including the refinement that a
  `local` candidate must record its seed. One tier guarantee, one place.
- No MCP tool and no skill wiring in this phase. `sidecrew fix` takes a plan and nothing writes plans
  until Phase 12; a tool Claude cannot usefully call is a tool that goes stale. `BACKLOG.md` has it.

## ADR-0048 — The 2a gate, and the seven cheap ways to pass it that are blocked by name

**Status:** accepted · 16 Sep 2026 · Phase 10 · the workload-#2a form of CLAUDE.md #2

### Context
ADR-0006 is a whole document about workers optimising against the gate, and the Phase 10 prompt names
this workload's Goodhart surface exactly: *"a worker that fixes a type error by editing `tsconfig.json`,
deleting the failing line, adding `// @ts-ignore`, or changing an unrelated file has defeated the gate,
not passed it. Enumerate the cheap ways to pass and block each one explicitly."*

The other half is ADR-0037, which is the most expensive thing six trials bought: the compile stage could
report `compile ok` on a candidate it never opened, and did. **A gate that passes quietly is worse than
no gate**, so this one has to be able to prove what it checked.

### The rule
```
survives ⇔ confined ∧ compile_ok ∧ tests_ok
```

**`compile_ok`** ⇔ every file in the task has **zero** `tsc` errors after the change, **and** no file
anywhere has more errors after than before.

The Phase 10 prompt asks for "strictly fewer errors overall, zero in the target file, and none
introduced anywhere else". The third clause is not a third condition — it is a *theorem*: if the task's
files went from N > 0 errors to zero and nothing else gained any, the project total strictly dropped.
Stating the gate as two conditions rather than three is what makes it **monotone**, and monotone is what
lets "fix every TypeScript error in a large codebase" converge over many tasks without any single task
having to finish it. The totals are still recorded, because Phase 11 needs them and because a theorem
worth relying on is worth asserting in a test.

**`tests_ok`** ⇔ every test that passed in the baseline still passes, **and** at least as many tests ran
as in the baseline, **and** the runner actually produced a report.

Never "everything is green": a project with pre-existing failures is normal, so the baseline is the
comparison and ADR-0046 is how it is captured. The other two clauses are ADR-0037's question asked of
this gate — *can it prove it ran, on the thing it claims to have checked?* A suite that collected zero
tests is not a green suite, and a runner that produced no report has not told us anything. Both are
`tests_ok: false`, and the second is a **machine problem**: it does not spend the retry, exactly as
`stage_reached === "mutation"` does not in workload #1 (ADR-0012).

### The seven rules, blocked by name
`confined` ⇔ no rule below fired. Each is checked as a **count before against a count after**, per file,
rather than by diffing — a gate whose verdict depends on which alignment a diff algorithm chose is a
gate with a heuristic inside it. The diff is still produced and written to the run directory, because
that is the artefact a reviewer reads; nothing gates on it.

| rule | what it blocks | why it is cheap for a worker |
|---|---|---|
| `path_outside_task` | an edit to a file the task does not list | fix the error by changing its caller instead |
| `build_config_edited` | any edit to `tsconfig*`, `package.json`, a lockfile, an eslint/jest/vitest/babel/bundler config | turn the check off — the prompt's own example |
| `test_file_edited` | any edit to a test file, `__tests__`, `__mocks__` or a snapshot | edit the instrument (ADR-0046) |
| `suppression_added` | a new `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `eslint-disable` | silence the error — the prompt's own example |
| `any_escape_added` | a new `as any`, `: any`, `<any>` | the type-shaped version of the same move |
| `deletion_without_replacement` | more code lines removed than `max_deleted_lines` allows | delete the failing line — the prompt's own example |
| `no_edit_at_all` | a candidate that changed nothing | the suite is already green, so do nothing |

Two of them — `build_config_edited` and `test_file_edited` — fire **even when the path is in the task's
`files`**, and `validateChangePlan` refuses a plan that lists such a path. A rule the plan can switch off
is a rule the planner can be argued into switching off, and the planner is going to be a model.

`max_deleted_lines` is the one dial, it is per task, and it defaults to 0. A "remove dead code" ask sets
it; a "fix the type errors" ask does not. That keeps deletion a property of what was *asked* rather than
of what the worker felt like doing.

### What the contract enforces, so that no verifier can be quietly wrong
`survived` is an **iff** in `src/schemas.ts`, the way workload #1's is — and here it is stronger,
because there are more ways to lie:

- `survived` must equal `confined ∧ compile_ok ∧ tests_ok`;
- `confined` must equal `confinement.length === 0`;
- `compile_ok: true` requires both error maps to be empty;
- `tests_ok: true` requires `tests` to be present, `reported`, `ran_after ≥ ran_before`, `ran_after > 0`
  and `regressed` empty.

A `ChangeVerdict` that claims a survival its own fields do not support **does not serialise**. That is
the same move `schemas.ts` already makes for the zero-worker-tokens guarantee, applied to the thing
ADR-0037 proved can go wrong in silence.

### Known holes, named rather than left to be discovered
- **A change to code no test executes is admitted by `tsc` alone.** That is real and it is not fixable
  from inside sidecrew — it is the user's coverage. Phase 11 reports the fraction of survivors whose
  changed lines no test that ran touched, as a number beside the rate, so nobody reads the rate as a
  stronger claim than it is. It is deliberately **not** a criterion: refusing to fix code somebody
  forgot to test would refuse most real work.
- **`as any` is sometimes the right answer.** Blocking it costs a survivor now and then. The escape is
  escalation, which is what escalation is for, and not a flag — a flag would be reached for exactly when
  the gate was about to say something inconvenient.
- **A behaviour-preserving change can still be bad.** The suite plus `tsc` cannot see "correct but
  awful". That is what Opus approving survivors is for, and Phase 11 measures it as a blind approval
  rate rather than assuming it.

## ADR-0049 — `doctor` checks node against sidecrew's floor, never against the project's `engines`, and a suite that cannot load is a vacuous gate

**Status:** accepted · 17 Sep 2026 · Phase 11 · the remedy is a `doctor` row, not a code change to the gate

### Context
Phase 11's first act on `project-a` (Nest/jest) was to capture a baseline. Under the node sidecrew itself runs
on — v20.20.0, comfortably above the package's `>= 20` floor — **all 352 suites failed to load and
jest collected zero tests**:

```
The module '.../better-sqlite3/build/Release/better_sqlite3.node'
was compiled against a different Node.js version using NODE_MODULE_VERSION 127.
This version of Node.js requires NODE_MODULE_VERSION 115.
```

The project's own `package.json` says `"engines": { "node": ">= 22.18.0" }`, and its native modules
are built for that. `captureBaseline` refused correctly — ADR-0048's "a suite that collected zero
tests is not a green suite" did exactly its job — but only **after** a full sandbox copy and a `tsc`
run, and with a message about the suite rather than about the cause.

`doctor` had said `ok node v20.20.0` and `ok jest 30.4.1` on that same project, moments earlier.

### Decision
1. **`doctor --project` reads the target project's `engines.node` and compares the running node
   against it**, as a row of its own. sidecrew's floor answers "can sidecrew run"; it has never
   answered "can this project's suite run", and for workload #2a the second question is half the gate.
2. **The row names the cause, whose fault it is and the exact fix**, in ADR-0032's shape: *this project
   declares node >= 22.18.0, sidecrew is running v20.20.0, and its native modules are built for the
   former — run sidecrew under the project's node.*
3. **Not a fallback and not automatic.** sidecrew does not re-exec itself under another node: which
   node is correct is the user's environment decision, and a tool that silently switched runtimes
   would make the next failure much harder to read.

### Why this is a publication-bar item rather than a nicety
`VISION.md`: *"every failure a user would hit on a project sidecrew has not seen before is either
fixed or named by `doctor` with its remedy."* This is exactly that shape — a fact about the project's
layout, which is what `doctor` is for, discovered at the cost of a five-minute baseline capture. Six
trials made the same point about workload #1 (ADR-0033); this is the first time it has been made about
the suite half of #2a's gate.

### Consequences
- Phase 11's real-project runs are performed under `~/.nvm/versions/node/v22.23.2`, recorded in
  `experiments/go-no-go-2a/results/baseline-reference.json`. v22.11.0 does **not** satisfy the engine.
- A project with no `engines` field gets no row, rather than a guess.

## ADR-0050 — ADR-0034's clone upgrade *is* reached by workload #2a, and the comment saying otherwise was wrong

**Status:** proposed · 17 Sep 2026 · Phase 11 · **not applied during the run** (§6: the gate is not
changed mid-measurement), with the evidence attached for the decision afterwards

### Context
`makeChangeSandbox` symlinks `node_modules` and says why:

> Symlinked for the same reason ADR-0004 symlinks it: the stages only read it. ADR-0034's clone
> upgrade is a `tsc` TS2883 treatment and is not reached here, because #2a never type-checks a file
> that was not already in the project's own program.

Measured on `project-a`: the real checkout reports **0** `tsc` errors and the #2a sandbox reports
**1**.

```
src/modules/logger/winston.config.ts(50,17): error TS2883: The inferred type of 'getWinstonConfig'
cannot be named without a reference to 'Format' from
'../../../../../../../../../../Users/.../node_modules/logform'. This is likely not portable.
```

The reasoning in the comment is sound and its conclusion is false. TS2883 is not about type-checking a
file outside the program; it is about a file **inside** the program whose *inferred* type has to be
named through a path that leaves the project — which is precisely what a symlinked `node_modules`
creates. ADR-0034 met this in workload #1 and answered it by cloning; #2a inherited the symlink and
the assumption that it could not happen.

### Why it did not invalidate Phase 11
The gate is monotone by construction (ADR-0048): `compile_ok` requires zero errors in the **task's own
files** and no file anywhere gaining errors. A pre-existing error in a file no task lists is tolerated
by both clauses, and `winston.config.ts` is listed by no task — checked, not assumed. The baseline
records `errors.total: 1` and every task's own files start from zero.

**The near miss is the reason this is written down.** `winston.config.ts` was the thirteenth candidate
on the rename shortlist and was dropped only because twelve was the number wanted. Had it been kept,
the task would have been unsatisfiable — the gate demands zero errors in the task's files after the
change, and this one has an error before it that no edit to that file can remove — and the run would
have reported a worker failure that was entirely sidecrew's.

### Options
- **A — clone `node_modules` for #2a too**, as ADR-0034 does for #1. Correct, and costs the clone (on
  APFS, `cp -Rc`, cheap in space and close to cheap in time).
- **B — clone only when a TS2883 appears in the baseline**, which is ADR-0034's own "only when
  TypeScript proves it must" rule applied here. Cheaper in the common case, one more state to reason
  about.
- **C — leave it, and have the baseline refuse a plan whose task files carry a pre-existing error.**
  Does not fix the sandbox; does close the near miss above. Worth doing **regardless of A or B**,
  because a task that cannot be survived should be refused by `validateChangePlan` rather than counted
  as a worker failure — which is §2's first denominator exclusion, enforced instead of remembered.

### Recommendation
**B, plus C.** C is the part that protects a measurement; B is the part that removes the cause. Both
after Phase 11's numbers are in, so that the run is readable against one sandbox.

## ADR-0051 — The client's code and the client's name never enter this repository, and the numbers do

**Status:** accepted · 17 Sep 2026 · owner's decision · becomes non-negotiable #7 in `CLAUDE.md`

### Context
sidecrew is public — `github.com/lvlrSajjad/sidecrew`, HTTP 200 unauthenticated. `origin/main` had
stopped at Phase 2 and carried **no** experiment files, while the local branch had run 36 commits
ahead through six real-world trials and Phase 11's staging. Asked to push, the check before pushing
found what those 36 commits contained:

- **33+ files holding complete client source files, verbatim.** Workload #2a's handshake quotes whole
  files three times over by construction: the rendered prompt is *"the files, exactly as they are on
  disk"*, the worker's answer is *"the complete new contents"*, and the review pack is a unified diff
  of both. One of them exposed `CENSORED_FIELDS = ['password', 'cvv', 'CVV']` and
  `TRIMMED_FIELDS = ['cardNumber', 'accountingNumber', ...]` from a payments-adjacent service — which
  is a statement about what that redaction covers and, more usefully to an attacker, what it does not.
- **448 mentions of the client's name across 59 tracked files** — 322 in the source-bearing experiment
  directories, 75 in `docs/`, the rest in scripts, plans and commit messages.

Nothing had been pushed, so nothing was public. That was luck rather than design: the same commits had
been sitting locally for two phases.

### Decision
**No client artefact and no client name leaves this repository. The measurements stay.**

The split is clean because the two things were never the same:

| | | |
|---|---|---|
| the client's | whole files in prompts, answers, candidates, diffs, review packs, coverage, recon notes; the client's name anywhere | **never committed** |
| ours | survival rates, funnels, confinement-break counts, suite sizes, gate wall-clock, latencies, RSS, the protocol, the gate, the ADRs | **committed, published, and the point** |

Projects are `project-a` (Nest/jest) and `project-b` (React/jest), described by the properties a reader
needs — stack, scale, suite size, what makes them hard to verify. *"An unmodified commercial Nest
codebase, 352 suites, 6,349 tests, 23 suites failing on missing DB env"* is exactly as strong a claim
as naming it, and unlike the name it is publishable.

### Why this is a rule about the repository rather than about discretion
A public git history is **not retractable**. A push distributes every blob reachable from the ref;
deleting the file in a later commit does not remove it from history; and forks, caches and code search
pick it up in hours. So the control has to sit before the push, and it has to be an allowlist habit —
*what may be committed* — rather than a search for things to strip, because a denylist that misses one
blob has failed completely while looking like it worked.

The same asymmetry the rest of this repo is built on: `.gitignore` is the mechanism, the rule is the
reason, and the verification is a scan of **the history being pushed** rather than of the diff.

### Consequences
- `.gitignore` covers `experiments/go-no-go-2a/c3/*/{prompts,answers,tasks}/`, the non-fixture review
  packs, coverage output and the run log. The fixture's own handshake is ours and stays tracked, which
  is what keeps the pipeline auditable in public.
- **Reproducibility is reduced, on purpose.** A reader can check every number, the protocol, the gate
  and the harness, and cannot re-run the exact prompts. That is the price, it is stated in the report
  rather than hidden, and the fixture is the part anyone can reproduce end to end.
- The 36 unpushed commits are rewritten before the first push: client artefacts removed from history,
  names replaced, commit messages included. A verification pass scans **every blob in the rewritten
  history**, not the tip, and the push does not happen until it comes back empty.
- A full bundle of the original history is kept outside the repo, so nothing is lost — it simply is
  not the thing that gets published.

## ADR-0052 — A stage runs in the project's environment, not in the launcher's

**Status:** accepted · 18 Sep 2026 · Phase 11 · the workload-#2a form of ADR-0037, and worse

### Context
Phase 11's first four attempts on a real Nest project captured a baseline of **2412–2417 of ~6350
tests passing** where a validated run had captured **6140**. About 170 whole suites had stopped
passing. Three explanations were proposed with some confidence and all three were wrong: external
memory pressure, the project's own jest workers exhausting RAM, and the resident 7B competing with
them. Each died to a measurement — most decisively, the suite ran **healthy at 10.6 GB free while the
machine was already swapping**.

The variable that actually separated the runs was the **launcher**. Every degraded run was started
with `npx tsx`; every healthy one with `node`. Isolated on a single spec, thirty seconds a test:

| launcher | source | result |
|---|---|---|
| `node` | compiled | 176 passed |
| `npx tsx` | source | 176 failed |
| `npx tsx` | **compiled** | 176 failed — the launcher, not the compilation |
| `npx tsx`, `npm_*` stripped | compiled | 176 passed |

`npx` exports npm's own state into the environment — `npm_config_cache`, `npm_config_prefix`,
`INIT_CWD`, `NODE`, a dozen `npm_package_*` — and every descendant inherits it, including the
project's test runner. A dependency that derives a path from those variables then derives a
**different** one. Here `mongodb-memory-server` looked for its cached `mongod` where npm pointed
instead of where the project had put it, failed an MD5 check on what it found, and took every suite
that needs an in-memory Mongo down with it. The failures arrive as ordinary red tests, with nothing
naming the cause.

### Why this is worse than ADR-0037
ADR-0037's compile stage could report `compile ok` on a candidate it never opened — the gate **broke**,
and a broken gate can be caught by asking it to prove what it checked.

This does not break the gate. It corrupts the **baseline**, which is the gate's *reference*. The rule
is "every test that passed before still passes"; if 3,931 tests never passed before, the candidate
does not have to keep them passing. The gate still works, still proves it ran, still reports honest
fields — and has become quietly weaker. **A survival rate measured against it is an overstatement
that nothing in the verdict can detect.**

Workload #1 is nearly immune by construction: its gate is self-contained per candidate. Workload #2a
separates the baseline from the candidate's run **in time**, which is what opens the door.

### Decision
1. **A project's toolchain runs in an environment the launcher cannot reach into.** `stageEnv()`
   returns what the stage adds (`CI`, `NO_COLOR`, `FORCE_COLOR`) **and what it takes away**: every
   `npm_*`, plus `INIT_CWD`, `NODE` and `COLOR`. Used by every `tsc`, test-runner and Stryker
   invocation in both workloads.
2. **The list is "what a package manager exports", not a denylist of things observed to break.**
   `mongodb-memory-server` is the dependency that happened to be caught; the next one to read
   `npm_config_cache` must not cost another night.
3. **`env: { FOO: undefined }` unsets `FOO`** (`src/exec.ts`). A spread cannot express removal, and
   the whole fix is removal.
4. **A baseline reference is valid only for the commit it was measured at.** Both real projects moved
   under this experiment overnight; a project that has moved is re-measured, never compared against a
   stale row.

### Consequences
- **`npx sidecrew fix` was the natural way to run this tool and it produced a weakened gate.** That is
  a publication-bar defect (`VISION.md`: *"people can use it on their code base with no problem"*),
  not an experiment artefact, and it is why the fix is in `src/` rather than in the harness.
- Phase 11's four contaminated arms were discarded. The discipline that caught them — a quiet-machine
  reference, checked per arm — was built on the *wrong* diagnosis and still worked, because it tests
  the baseline against a known-good value rather than reasoning about causes. That is an argument for
  validating measurements against references instead of against explanations.
- `doctor` should eventually report the launcher's pollution the way ADR-0049 has it report the
  project's `engines`. Not built here; `BACKLOG.md`.
- Three tests in `test/exec.test.ts` cover the unset semantics and the strip list.

### What this does not explain
Nothing about the model. Every number taken under the contaminated baseline is void and is being
re-measured; none of it reached a report.

## ADR-0053 — A test whose name is generated is not a regression

**Status:** accepted · 18 Sep 2026 · Phase 11 · narrows ADR-0048's `tests_ok` without weakening it

### Context
The 2a gate's test rule is *every test that passed before still passes*, and a test is identified by
`<file>::<full name>` — the file included on purpose, because two files may each have a test called
"returns zero" and a rule about one must not be satisfiable by the other (ADR-0048).

The first candidate on a real React project failed at the tests stage. Its diff was a single clean
line — the removal of an unused `import React` — and the two tests it had supposedly broken were:

```
src/utils/dateTz.test.ts::DateTz isValid isValid(2026-09-18T01:18:55.112Z) === true
src/utils/dateTz.test.ts::DateTz isValid isValid(1789694335112) === true
```

The titles are built from `Date.now()`. The test did not fail; **its id changed**, because the id
contains a timestamp taken when the suite ran. The baseline's id is never seen again, and the rule
`passed_before ∧ ¬passed_after` scores that as a regression. Every candidate on that project would
have failed the same way, for a property of the project's test titles and nothing to do with the
change — a survival rate of 0/12 that says nothing about the model.

That is a **false negative** in the gate, and this repo has spent most of its attention on the
opposite failure. ADR-0037 was a gate that passed something it should have refused; this is a gate
that refuses everything on a project it cannot identify tests in. Both are "the measurement was about
the plumbing", and only the second is self-announcing — it fails loudly and immediately, which is why
it cost one arm rather than a phase.

### Decision
**A test that passed before is a regression only if it is present in the new report and did not
pass.** An id absent from the report altogether is not evidence of failure, and is reported as a
count — `N test(s) … are absent from this report — generated test names, not regressions` — rather
than silently dropped.

`SuiteRun` therefore carries `seen_ids` beside `passed_ids`: telling "this test failed" from "this id
is not in the report" needs both, and only the first is a regression.

### Why this does not weaken the gate, for a reason specific to this workload
The obvious objection is that a candidate could now delete a test and escape. It cannot:

1. **Editing a test file is a confinement breach** (`test_file_edited`, ADR-0046/0048), checked before
   a byte is written, and a plan that lists a test file does not validate. A candidate has no way to
   remove a test.
2. **`ran_after ≥ ran_before` still holds** (ADR-0048), so a suite that collected fewer tests than the
   baseline is refused regardless of which ids moved.

With both in force, an id that vanished between two runs of the *same* suite over the *same* tests is
a renamed test, never a removed one. The narrowing is exact: it removes the one case the rule got
wrong and leaves every case it got right.

### Consequences
- Workload #1 is untouched: its gate is mutation score on one function and never compares test ids
  across runs.
- Phase 11's project-a arms are **kept**. The fix can only remove entries from `regressed`, and
  project-a reported none — checked, not assumed. The project-b arms are re-run.
- A project whose test titles are generated is now supported rather than silently unmeasurable. That
  is a publication-bar item of the same kind as ADR-0049: it is a property of somebody's repository,
  discovered on the first real encounter with one.
- Three tests in `test/change.test.ts` cover it, including the real `Date.now()` shape.

## ADR-0054 — Documentation is not behaviour, and the 2a gate cannot see it

**Status:** **accepted — the gate refuses it** · owner's decision, 20 Sep 2026 · proposed 18 Sep from
Phase 11 · an eighth cheap pass, absent from ADR-0048's seven · implemented the same day, addendum at
the end of this file

### Context
ADR-0048 enumerates seven cheap ways past the 2a gate and blocks each by name. Phase 11 measured an
eighth, on both inputs where the local worker could be observed:

| input | behaviour | count | control |
|---|---|---|---|
| fixture | deleted a 7-line docblock while making a correct one-line fix | **2 of 3 survivors** | 0 of 3 |
| project-a | reworded a doc comment, *Normalises* → *Canonicalises*, while renaming | **1 of 10 sampled** | 0 of 10 |

Every one of those changes **survived**: confined, `tsc` clean, the project's suite green. The gate
is not wrong — `survives ⇔ confined ∧ compile_ok ∧ tests_ok`, and a comment is neither a type nor a
test. It answered the question it was asked.

`max_deleted_lines: 0` looks like it should have caught the fixture case. It does not, because
`codeLines` skips comment-only lines on purpose, and its docstring reasons its way to the opposite of
what the code does:

> the worst that does is refuse a candidate that deleted a comment, which is not a fix.

The worst it actually does is **admit** one. The asymmetry was analysed in the wrong direction and
shipped, which is the same shape of error as ADR-0037.

The prompt already forbids it in plain English — *"Do not reformat, rename, reorder or tidy anything
else"* — and that is worth nothing. A prompt is a request; a gate is a constraint; the worker
optimises against the constraint. ADR-0006 said this in 2026 and it keeps being true.

### Why it matters more than its size suggests
This is the **only** behaviour that separated the local tier from the control in the entire phase.
Survival was 1.00 in four of five measurable cells. If the approval guard had not existed, Phase 11
would have reported an unqualified GO everywhere, including where the worker damaged two files out of
three. The headline claim is *"the same quality Opus would produce"*, and silently deleting a
maintainer's explanation of why a fix is safe is not that — least of all on the fixture, where the
deleted comment was the one documenting the trap the task was about.

### Options
- **A — an eighth confinement rule, `documentation_removed`.** Count comment lines before and after
  per file; a net decrease beyond a per-task budget is a breach, like `deletion_without_replacement`
  but for prose. Cheap, symmetric with what exists, and blocks the measured behaviour by name.
  Costs: a legitimate "remove the stale comment" ask needs its own budget field, and a reworded
  comment of the same length is invisible to a line count — it would catch the fixture's deletions
  and **miss** project-a's rewording, which is the subtler half.
- **B — compare comment *text*, not comment lines.** Catches rewording too. Needs the TypeScript AST
  to be reliable, which is already wanted for `deriveLineRange` (PHASES item 3).
- **C — leave the gate and let the approval rate carry it.** Defensible: A is already a veto, it
  caught this unprompted on both inputs, and a gate that polices prose will refuse changes a
  reviewer would have liked. Costs: A is sampled and human-equivalent, so it scales with review
  budget, not with the run.
- **D — say so in the report and change nothing.** What this run did, because §6 forbids tuning the
  gate mid-measurement.

### Recommendation
**A now, B when the AST lands**, and keep C regardless — the approval guard is what found this and
no enumeration should be trusted to be complete. Decide with Phase 12, since a correction round gives
a cheaper answer than a refusal: the verdict can say *"you changed a comment you were not asked to"*
and let the worker try again, which is exactly the kind of note ADR-0044 §4 is for.

### What is not decided
Whether a comment-aware rule pays for itself. It has one measured number behind it — 3 of 13 sampled
survivors across two inputs — and that is a small denominator on which to add a gate rule.

## ADR-0055 — Each sandbox gets its own test-runner cache

**Status:** accepted · 18 Sep 2026 · Phase 11 · confirmed by intervention

### Context
Every candidate on a real React project failed at the tests stage: 24 of 24 attempts parsed, applied,
stayed confined and compiled, and **none** passed the suite. The cause was not the candidates —

| what was measured | ran / passed |
|---|---|
| project directory ×3, sandbox ×3, per-task clone ×2, worker resident ×2 | 8795 / 8788 every time |
| the recorded candidate through `verifyChange` ×2 | **SURVIVED** |
| inside the full 12-task arm | 8786, then 8707 |

The decisive artefact was the run's own combined check: with **zero survivors applied**, the final
suite lost 90 tests from 7 whole files against the arm's own baseline. Nothing a candidate did can
explain a regression in a run containing no changes.

Whole files failing to load, only inside a long multi-invocation run, pointed at the one thing that
accumulates across a run: a **3.8 GB jest haste-map cache**, shared by every sandbox because jest's
default cache directory is global. A 12-task arm creates 24 differently-rooted sandboxes and they all
write to it.

**Clearing it, with no code change, turned 0/12 into 11/12** — same tasks, same candidates, same gate,
one variable removed. Five earlier hypotheses (external load, memory pressure, the resident worker,
the sandbox, the candidate) were each refuted by measurement first.

### Decision
**A stage runs against a cache it owns.** The runner is given a `--cacheDirectory` inside the sandbox,
so it is created with the sandbox, isolated from every other run, and swept with it. No sandbox ever
shares transform or haste-map state with another.

The cost is a cold cache per candidate. On a 772-suite project that is real and it is worth paying:
the alternative is a gate that silently refuses everything once a run is long enough, and the length
at which it starts is a property of the machine rather than of the project.

### Why this is the same lesson as ADR-0052, one layer out
ADR-0052 was the *launcher's* environment reaching into the project's toolchain. This is one run of
the toolchain reaching into the next through state on disk. Both corrupt the gate without breaking
it, both are invisible in every summary the run prints, and both were found by reading discarded
output rather than by reasoning about the model. The general rule, which is now worth stating as one:
**a stage must be isolated in every dimension it can carry state — environment, filesystem, and
cache.** Two of the three had to be learned the expensive way.

### Applied
`sandboxCacheDir()` puts the cache at `<sandbox>/.sidecrew-runner-cache` and `suiteArgs` passes it to
jest as `--cacheDirectory`. Created with the sandbox, shared with nothing, swept with it. vitest is
not given one: its cache lives under the project's own `node_modules/.vite`, which the sandbox
already isolates. Landed **after** Phase 11's measurements were complete, so §6 is satisfied and no
number in the report was taken with it in place — project-b's arms were measured by clearing the
shared cache by hand, which is the same isolation arrived at manually.

### Consequences
- Workload #1 shares the same helper and gets the same isolation. It never showed the symptom, most
  likely because a Stryker run is a different cache shape and its trials were shorter.
- `doctor` could report a large shared runner cache as a warning. Not built; `BACKLOG.md`.
- Phase 11's project-b arms are the measured ones and are labelled as taken after this fix. project-a
  was never affected — its arms ran clean at 12/12 with the shared cache in place, which is why the
  symptom took a second project to appear at all.

## ADR-0056 — A sandbox that will not delete is a machine failure, not a worker failure

**Status:** proposed · 18 Sep 2026 · Phase 11 · the 2a form of ADR-0012

### Context
One task of twelve on project-b produced no verdict:

```
ENOTEMPTY: directory not empty, rmdir '…/T/sidecrew-task-V6UW3E'
```

`verifyChange` removes its per-task clone in a `finally`; that removal raced something still holding
the directory and threw. `runFix` catches a non-fatal throw, records it as `threw`, and the task is
counted as **escalated** — which in `FixResult.stats` is indistinguishable from *the worker could not
do this*. The funnel's `answered: 11` against `tasks: 12` is the only structural hint, and nothing
names it as a machine problem.

That asymmetry is the point. Workload #1 has an explicit exemption: a runner that produced no report
is the machine failing, so it does **not** spend the retry (ADR-0012), and `shouldRetryChange` already
carries the same rule for a test runner that produced no report. Teardown was never given one, so a
filesystem race silently costs a task and lands in the denominator of a survival rate.

### Decision (proposed)
1. **Teardown cannot fail a candidate.** Removing a sandbox is housekeeping that happens after the
   verdict is known. It is retried briefly, and on failure the path is recorded for the sweep rather
   than thrown — a verdict already decided must not be discarded by cleanup.
2. **A throw that is the machine's is counted apart from a worker's.** `FixResult.stats` gains
   `machine_failures`, so a rate's denominator can exclude what was never the worker's to answer.
   That is a contract change and needs `docs/specs/pipeline.md` updated in the same commit.
3. **The report says which.** Phase 11 reports project-b as `S(C2) = 11/12` as measured **and**
   `11/11` excluding this task, because collapsing that choice into one number hides a judgement the
   reader should see.

### Consequences
- One task of 24 on the real projects, so the effect on this phase's numbers is small and bounded.
  The reason to fix it is not the size; it is that a machine failure wearing a worker failure's
  clothes is exactly the error class this whole phase has been about.
- Not applied during the run (§6). The count is attached.

## ADR-0057 — The correction round cannot reach the one defect it was supposed to prove itself on

**Status:** accepted · 18 Sep 2026 · Phase 12 · owner took option D the same day · supersedes the part of
ADR-0054 that left the decision to Phase 12's number, and settles ADR-0054 as **D now, B when the AST
lands, C's argument kept**

### Context
Phase 12's prompt §2.2 offers the unrequested cosmetic edit as the correction round's first test:

> the **only** measured quality gap between the local tier and the control is unrequested cosmetic
> edits — a deleted docblock, a reworded comment, a stray blank line, **4 of 23 sampled survivors
> against 0 of 23** (ADR-0054). That is exactly the shape a one-sentence correction should fix, and it
> is a cheaper answer than an eighth confinement rule. It is also a ready-made test of whether
> corrections work at all.

It is the right instinct and, as the gate stands, **it cannot be done**. Three facts collide:

1. **A cosmetic edit survives.** `survives ⇔ confined ∧ compile_ok ∧ tests_ok`, and a comment is
   neither a type nor a test (ADR-0054). Its verdict reads `survived: true`.
2. **A correction is written from the verdict and never from the diff** — non-negotiable #3, ADR-0044
   §4 rule 1, and the reason `ChangeVerdict` was designed for this reader (ADR-0047 §3). A survivor's
   verdict carries nothing about the comment, so there is nothing to write a correction *from*.
3. **The correction round fires after a failure.** ADR-0044 §4: the mechanical retry fails, then one
   Opus note, then `attempt` becomes 2. A survivor never enters it.

So the probe requires either letting Opus read the candidate's diff — which is the line between this
design and *"Opus reviews everything"*, and it is not available — or **making the behaviour visible to
the verdict first**, which is a decision about the gate and therefore an ADR.

This also settles a question §2.2's protocol had to leave open: whether ADR-0054 can be decided *by*
the correction round's number. It cannot. **ADR-0054 is upstream of that measurement, not downstream
of it**, and any plan that has the number decide the rule has the order backwards.

### A second finding that bears on all four options
**No task Phase 11 ran ever reached a second attempt.** `retried = 0` in all six arms across 54 tasks
(`experiments/correction-round/README.md` §2). Whatever is decided here, the correction round's
denominator on *renames and unused-import removals* is zero, and the measurement needs the unmeasured
shapes regardless.

### Options
- **A — ADR-0054's recommendation: an eighth confinement rule, `documentation_removed`.** A net
  decrease in comment lines beyond a per-task budget is a breach. The verdict then carries
  `confinement: [{rule: "documentation_removed", …}]`, the correction round composes with it exactly as
  designed, and the probe runs. Costs: it is a **refusal**, so a legitimate "remove the stale comment"
  ask needs its own budget field; it catches the fixture's deletions and **misses** project-a's
  rewording, which is the subtler half; and it tunes the gate on a denominator of 3 of 13 sampled
  survivors across two inputs.
- **B — compare comment *text*, not comment lines.** Catches rewording too. Needs the TypeScript AST,
  which is already wanted for `deriveLineRange`. Strictly better than A and strictly more work; the
  same refusal costs apply.
- **C — leave the gate alone; the blind approval guard carries it.** ADR-0054's own option C, and it is
  defensible: the guard found this unprompted on both inputs, and a gate that polices prose will refuse
  changes a reviewer would have liked. Cost: **the probe does not run**, and §2.2 is measured on
  gate-visible failures only.
- **D — observe without gating.** The confinement checker already compares the task's sources against
  the candidate's contents, so it can *report* a comment delta as a non-gating observation on the
  verdict. `changeSurvives` is untouched, no change is refused, rule 1 is satisfied because Opus reads
  the verdict rather than the diff — and the correction round gains the one thing it needs. Cost, and
  it is the real one: **the round would then fire on a survivor**, which ADR-0044 §4 did not
  contemplate. That is a scope change to the correction round, not a free observation, and it needs its
  own budget clause or a run can spend Opus tokens correcting changes that already passed.

### Recommendation
**D, with the correction round's survivor case budgeted separately and off by default**, then **B when
the AST lands**, keeping **C's argument regardless** — the approval guard is what found this and no
enumeration should be trusted to be complete.

The reason to prefer D over A is that A answers a measurement question by adding a refusal, and the
thing actually in doubt is whether a one-sentence correction changes a worker's behaviour at all. D
measures that on the one behaviour we have counted, without spending a gate rule on a denominator of
three, and leaves A and B available if the answer is that corrections do not work.

### Decision, 18 Sep 2026
**D.** Written where the options were, so the reasoning above is the record rather than a summary of it.

1. **The verdict gains non-gating `observations`.** The confinement checker already compares the task's
   sources against the candidate's contents; a comment delta is reported there and **nothing gates on
   it**. `changeSurvives` is byte-for-byte the rule ADR-0048 froze, and a run's survival rate is
   comparable with Phase 11's because no candidate's fate changes.
2. **The correction round may fire on a survivor that carries an observation**, which ADR-0044 §4 did
   not contemplate. It is therefore **its own budget and it ships off by default**: a run that has not
   asked for it spends nothing correcting changes that already passed.
3. **ADR-0054 is settled by this, not by a number.** Its options A and B are *refusals* and remain
   available; what this phase does is make the behaviour visible so that a correction is possible at
   all. If corrections turn out not to change it, A or B is the answer and the measurement will say so.
4. **The order was backwards and is now right.** ADR-0054 is upstream of §2.2's measurement.
   `experiments/correction-round/README.md` §4.4 is amended to match, below its frozen §4.

### What is still not decided
Whether a comment *rewording* — project-a's `Normalises` → `Canonicalises`, the subtler half — is worth
catching. Option B catches it and needs the TypeScript AST. The observation shipped here is a line
delta, so it sees the deletions and not the rewordings, and the run reports which half it measured.

## ADR-0058 — The planner's real output is refusal, and `shape` is a contract field because the shape is the caveat

**Status:** accepted · 18 Sep 2026 · Phase 12 · builds ADR-0044 §1–2 · settles the enforcement half of
ADR-0050 option C

### Context
ADR-0044 §1–2 decided what a task is and how a job is ordered, and Phase 10 built both into the
contract. Phase 12 had to build the thing that *writes* one. Two questions came out of that which
ADR-0044 did not answer, and both turned out to be about measurement rather than about planning.

### 1. A planner that only plans is not enough — it has to refuse
The gate is `survives ⇔ confined ∧ compile_ok ∧ tests_ok`, and `compile_ok` requires **zero** `tsc`
errors in the task's own files (ADR-0048). That makes a whole class of task **unsatisfiable by anyone**:
no worker passes it, at any temperature, for any number of attempts, and the run finds out by spending
262 s of gate per attempt to learn something a `tsc` run already knew. Phase 11 nearly measured one
(ADR-0050 option C).

The Phase 12 prompt is explicit that this belongs in the validator rather than in the planner's head —
*"enforced in `validateChangePlan` rather than remembered by whoever writes the plan"* — and the reason
is that the planner is a model. A rule a model is asked to remember is a rule that holds until the model
is having a bad day.

**Decision: `validateChangePlan` refuses four kinds of task by name**, and a refusal is an error rather
than a warning, so the plan does not validate until the task is dropped or widened:

| refusal | why nothing can pass it |
|---|---|
| `pre_existing_error` | the task's files already carry a `tsc` error its ask does not cover, and `compile_ok` demands zero (ADR-0050 option C) |
| `files_too_large_to_rewrite` | a worker returns whole files (ADR-0047 §2), so the task can only produce a truncated candidate |
| `file_outside_program` | `tsc` never compiled the file, so it has zero errors because nothing looked — `compile_ok` would pass **vacuously** |
| `deletion_budget_zero` | a `dead_code` ask with `max_deleted_lines: 0`: removing the code is the ask, and the gate counts it as `deletion_without_replacement` |

`files_too_large_to_rewrite` is the one Phase 11 found rather than the one anybody predicted: *"whole-file
rewriting bounds a task to files a 7B can reproduce inside 8192 tokens, which most files in a real
service are not."* That wall is hit before the model's ability is, so it is a planner constraint with a
number on it rather than a truncation rate that reads as a model failure.

A fifth check is an **error but not a refusal**, because it is not about satisfiability: two tasks in one
step listing the same file. Tasks inside a step run in parallel from one baseline, each in its own clone
(ADR-0046), so both candidates can survive and whichever lands second at the step boundary silently
drops the first's change. **No per-task verdict can see this** — only `FixResult.project.combined_regressions`
can, and by then the run is over. Across different steps it is fine: the boundary re-captures the
baseline.

**A refused task is not a planned task.** It is reported separately and excluded from `N` in
`experiments/planner-cost/README.md` §4.1, because a planner that refuses well is doing work, and
counting refusals in the denominator would make a careful planner look expensive.

### 2. `shape` is required, with no default
`PlannedChange.shape` ∈ {`rename`, `unused_import`, `null_guard`, `api_migration`, `dead_code`}.

It is a contract field rather than a note in `notes` because **the shape is the caveat on every number
this repository publishes.** Phase 11's measured coverage hole is about 1 survivor in 5 whose changed
lines no test that ran executed, and what that costs depends entirely on the shape:

- for a `rename`, `tsc` proves completeness and completeness is most of what the ask was, so the
  compiler is a fair oracle even where no test runs;
- for a `null_guard`, an `api_migration` or `dead_code`, the same 1-in-6 is a **much weaker claim**,
  because there the compiler cannot tell you the behaviour survived.

Phase 11's report says the number should travel with the rate and the shape should travel with both. A
field is how that stops depending on whoever writes the report. **No default**, because a default would
have made every unlabelled task a `rename` — the shape every existing rate is already about — and the
error would have been invisible.

It also makes a standing requirement checkable: **Phase 11b §4.4 withholds its verdict** unless at least
half the tasks are the harder three, so `ChangeValidationReport.shapes` and `hardShare()` report the mix
and `sidecrew fix --validate` says so in as many words.

### 3. Two smaller ones, recorded because the reasoning is not obvious from the code
- **The library does not call a model to write a correction.** `RunFixOpts.correct` is injected by the
  caller. An API call inside `runFix` would make a local-tier run spend Claude tokens from inside
  sidecrew, which is the guarantee `schemas.ts` exists to enforce; instead Opus supplies the writer and
  the run accounts for what it spent, in `claude_tokens.planning`, where a refinement refuses a result
  that hides it.
- **`ChangeEscalation` is its own shape, not a widened `Escalation`.** Workload #1's `stage_reached` is
  `Stage` and says nothing about confinement or a regressed test — the first two things a 2a reader
  needs. Widening it would give every workload-#1 escalation four permanently-null fields and make the
  discriminant a runtime question.

### Consequences
- `sidecrew fix --validate` runs a real `tsc` by default, which costs tens of seconds. That is the half
  producing the refusals, so the expensive check is the default and `--no-compile` is the option.
- Every existing plan needs a `shape` per task. The fixture's three are `null_guard`.

  **Phase 11's two plans were migrated after all, and the first version of this bullet was wrong.** It
  said they were "a record of a run that happened" and left them alone — but Phase 11b §2 says to
  **reuse and extend** them, so leaving them unparseable would have blocked the phase that outranks this
  one. They are now `project-a.json` (12 × `rename`) and `project-b.json` (6 × `unused_import`,
  6 × `rename`), which is also the name the results already referenced.
- **Those plans are untracked**, and that is CLAUDE.md #7 rather than tidiness: `project` is an absolute
  path into a client checkout, and the asks quote the client's own symbols by construction — a rename
  ask cannot state what to rename without naming it. They stay on disk; the results that reference them
  carry the numbers, which are ours.
- The four refusals are checks on **satisfiability**, not on quality. A plan can pass all of them and
  still be a bad plan; nothing here judges the grouping, and the only thing that can is a human or a
  measurement.

### What is not decided
Whether `max_group_size`'s default of 10 is right. **Phase 11 measured only one file per task**, so
every survival number in this repository is for single-file tasks and nothing says a 7B can handle five
files at once. The validator enforces the plan's own ceiling and takes no view on what it should be.

## ADR-0059 — The `api` tier's client is `fetch` against the Messages API, and the dependency rule holds

**Status:** accepted · 18 Sep 2026 · Phase 13 §2.1 · the first of ADR-0045's three open decisions

### Context
ADR-0045 made the `api` tier a phase. Nothing implements the path, and the first thing it needs is a
way to talk to Anthropic. That collides head-on with a rule this package's shape is built on —
`CLAUDE.md`, *Shape*: **"Only runtime dependency: `@modelcontextprotocol/sdk` (+ `zod`)."** The rule is
not decoration: `README.md` leads with it, `package.json` has exactly those two, and every external
capability so far (`mlx_lm`, `muter`, `stryker`, `swift`) is shelled out and reported by `doctor`
rather than bundled (ADR-0002). A decision that adds a dependency is a decision to change what the
package *is*, so it does not get made quietly.

Two facts narrow the question more than they first appear:

1. **The call surface this tier needs is tiny and frozen by ADR-0045 §5.** One turn, a system message
   and a user message, `temperature: 0`, a `max_tokens`, read the text back, read `usage`. No tools, no
   structured outputs, no batching, no caching, no conversation. The tier does *the same small stuff*
   the local tier does, explicitly not harder work routed to a better model.
2. **`src/worker.ts` is already this program.** It speaks streaming HTTP to a JSON endpoint, parses a
   usage block, refuses an estimate, and implements a retry rule stated in terms of what the stream had
   already carried. The Messages API is a different JSON shape, not a harder one.

### Options
- **A — add `@anthropic-ai/sdk` as a runtime dependency.** Correct retries, a typed error taxonomy,
  streaming and usage fields for free, and it is the officially supported path. Costs: it breaks the
  stated rule, and it breaks it for *everyone* — the dependency installs on every machine, including
  the 24 GB and 32 GB majority who are on the `local` tier and will never construct the client. It also
  buys, at that price, a feature set ADR-0045 §5 forbids this tier from using.
- **B — call the Messages API over `fetch`.** Keeps the rule intact and keeps the install one step.
  Costs, and they are real: retries, rate-limit back-off and the error taxonomy become ours, and
  getting 429/529 handling wrong on somebody's bill is worse than getting it wrong on localhost.
- **C — an optional peer dependency.** Installed only by users who need the tier. Costs: `doctor` has
  to explain a missing optional dep, and "it works on my machine" becomes a support shape. It also
  lands the extra step on **exactly the wrong user**: the `api` tier exists because a 16 GB machine has
  no alternative, so its user is the one person who cannot route around a failed install.

### Decision — B, with the retry rule stated as an invariant rather than inherited
`fetch`, non-streaming, in `src/api-worker.ts`, behind the same `generate` seam the go/no-go harness
already uses. Three things make B's cost payable, and each is written down because "we own retries" is
only frightening while it is vague:

1. **What is retried is narrower than an SDK's default, on purpose.** The local client retries *only a
   connection that never carried a token*, because a request that died mid-stream has already spent an
   inference. The same sentence with money in it: **retry only a response the server refused before
   producing anything** — HTTP 429 and 5xx, which are rejections and are not billed — and **never a
   timeout or a dropped socket**, because those are the cases where the completion may have happened
   and a retry would bill twice. An SDK that retries connection errors by default does the one thing
   this tier most needs not to do.
2. **Back-off honours `retry-after` when the server sends one**, and is bounded: at most two retries,
   exponential, capped. A tier that hammers a rate limit on the owner's account is a worse failure than
   a task that escalates.
3. **The error taxonomy we need is three cases, not thirty.** 401 (name the environment variable that
   is missing), 429/5xx (back off, then escalate), everything else (surface the status and the body's
   first 512 bytes, as the local client already does). `doctor` names a missing key with its fix, in
   ADR-0032's shape.

The deciding argument is not the byte count of `node_modules`. It is that **A makes every user of the
local tier pay for a path they will never take, in order to buy capabilities this tier is forbidden to
use** — and that C charges the one user who has no alternative an extra step to get a tool that runs at
all. B is the only option whose cost falls on us rather than on a user.

### Consequences
- `CLAUDE.md`'s dependency rule survives Phase 13 unamended, and the README's claim stays true.
- **We own a billing-relevant retry.** The rule above is enforced in `src/api-worker.ts` and tested:
  a 429 retries, a timeout does not. If that inverts, the symptom is a doubled bill and no error.
- **`assertLocalTier` is untouched** (`src/worker.ts:52`). The `api` path gets its own guard,
  `assertApiTier`, with its own allowlist — the local guard's job is to refuse Anthropic, the api
  guard's job is to refuse everything else, and widening either to serve the other would delete the
  guarantee both exist for.
- Streaming is not used, so this tier reports no meaningful TTFT. `Candidate.timing.ttft_ms` is written
  equal to `wall_ms` and said so here; §5 reports wall clock and makes no criterion of it, and a
  cross-tier latency comparison was already forbidden (Phase 13 §5.1).
- If the surface ever grows past one turn — tools, caching, batching — this decision is due for review,
  and the review is an ADR rather than an `npm install`.

## ADR-0060 — The `api` tier is pinned to `claude-haiku-4-5`, and the pin is weaker than a revision sha

**Status:** accepted · 18 Sep 2026 · Phase 13 §2.2 · implements ADR-0045 §2

### Context
ADR-0045 §2: Haiku, *"pinned by its full model id in `models.json`'s `api` tier the way local weights
are pinned by revision (ADR-0027). A change of id is a change of configuration and gets a new
measurement, not a silent upgrade."* `models.json`'s `api` entry currently reads `"model": null`.

The analogy to ADR-0027 is the part that needs care, because **it does not hold all the way**. A local
pin is a Hugging Face commit sha resolved to an immutable snapshot directory on disk (ADR-0010); it
cannot change under a run and it cannot reach the network. A hosted model id is a name the provider
resolves, and no string we write makes the weights behind it ours. Claiming the two pins are equally
strong would put a false statement next to a number.

### What the id choice actually constrains — and a finding that makes it load-bearing
`WorkerStamp.temperature` is `z.literal(0)` and non-negotiable #4 is determinism. On the current API,
**the sampling parameters were removed from the newer model generations**: `temperature` is accepted on
Claude Haiku 4.5 and returns a 400 on the 4.6-and-later families. So a silent upgrade of this tier to a
newer model would not merely make two survival rates incomparable — it would make the request **fail
outright**, at the one moment a user on a 16 GB machine has no fallback.

That inverts the usual argument for a floating alias. The risk a pin normally guards against is a quiet
change in behaviour; here the pin also guards against a hard error, and that failure is loud rather than
subtle. Two further properties of this model belong beside the id because they bound the workload:
Haiku 4.5's context window is **200K**, not the 1M of the larger models — and ADR-0047 §2 has workers
rewriting **whole files** — and it takes `thinking` only in the older `budget_tokens` form, which this
tier does not use at all.

### Options
- **A — a floating alias** (`…-latest`, or a bare family name the provider re-points). Always the
  current model, no maintenance. Costs: it is exactly what ADR-0045 §2 forbids; every number this tier
  produced would be uncomparable with the next one; and per the finding above it can turn into a 400.
- **B — the generation id, `claude-haiku-4-5`.** The strongest pin the provider offers at this
  granularity: a new generation is a new id, so an upgrade cannot happen without an edit to
  `models.json`. Costs: it is **not** immutable — a provider may serve a revised snapshot behind it —
  so it is weaker than a commit sha and must not be described as equivalent.
- **C — a dated snapshot id.** Would be the true analogue of a commit sha. Costs: the current model ids
  are complete as written and are not date-suffixed; inventing a suffix produces a 404, and pinning to
  a dated id from an older naming scheme would pin to an older model.

### Decision — B
`models.json`'s `api` tier names `claude-haiku-4-5`, with the licence and footprint columns replaced by
what a hosted model actually has: the id, the context window, and the per-MTok rates the cost line is
computed from. `doctor` prints the id. `Candidate.worker.model` records it, and `worker.revision` is the
**empty string** on this tier rather than a fabricated value — the same honesty `discoverWorkers`
already practises for an anonymous local worker.

**And the weakness is written down where the number is**, not only here: an `api`-tier result carries
the model id, and the §5 report says that the id names a generation rather than an immutable artefact.
A reader comparing two `api` runs a year apart is entitled to know that the pin is a promise about the
name and not about the weights.

### Consequences
- A change of id is a configuration change and gets a new measurement (ADR-0045 §2), enforced socially
  rather than mechanically — nothing in the code can detect that a hosted model was revised.
- The rates in `models.json` are **the rates on the day they were written**, labelled with that date.
  They feed the `$(api)` line of Phase 13 §5.1 and nothing else; they are not a price quote.
- Non-negotiable #6 (Apache-2.0 / MIT) is a rule about *weights sidecrew downloads or ships*, and it
  does not reach a hosted API any more than it reaches Claude itself. The `api` tier downloads nothing.
- The 200K window is the smallest context sidecrew has ever targeted. `fixTokenBudget` is a function of
  the task's files and already bounds the output; the **input** side is now the binding constraint on
  how large a file this tier can be given, and nothing has measured where that bites.

## ADR-0061 — The `api` tier's number is taken fresh on the current tool, not against Phase 11's arms

**Status:** accepted · 18 Sep 2026 · Phase 13 §2.3 · amends ADR-0045 §7, which was written before both
of the facts below

### Context
ADR-0045 §7 says the tier gets its own number from *"Phase 11's protocol, run on the `api` tier"*. That
sentence was written on 16 Sep. Two things have happened since, and following it literally now produces
a number comparable to nothing:

1. **`src/prompts/fixer.md` changed** in `6c161de` — Phase 12 added the worker refusal shape
   (`--- CANNOT: reason ---`). The rendered prompt is no longer byte-identical to the one Phase 11's
   `C2` and `C3` arms saw.
2. **Phase 11b §2.1 decided not to pin the old template**, on the grounds that pinning measures a tool
   nobody will ship.

Phase 13 §2.3 requires this decided explicitly and **before the first candidate**, and §5.0 precondition
4 makes a run void if it is not.

### Options
- **A — pin `fixer.md` to its Phase 11 bytes for the `api` arm.** Produces a number directly comparable
  with `C2` and `C3` on the same tasks. Costs: it measures a sidecrew nobody ships, which is the exact
  objection Phase 11b §2.1 already sustained; it re-introduces a pinned-template code path the project
  has just decided against; and it forfeits comparability with 11b's arms, which are the arms the next
  question is asked against.
- **B — run fresh on the current tool, comparable to Phase 11b's arms.** Measures the thing that would
  actually be shipped to a 16 GB user. Costs: `A(C2)` — which §5.2's SHIP clause is stated against — is
  a Phase 11 figure taken on the older template, so the bar itself is a number from a different tool.
- **C — re-run the local arm on the current tool as well**, giving a same-commit `C2` beside the `api`
  arm. Strictly the cleanest. Costs: it roughly doubles the phase, and the local re-run is Phase 11b's
  work rather than this phase's.

### Decision — B, with the bar's provenance stated, and C named as the thing that would settle it
The `api` tier's number is taken on the current tool at the commit it runs at. No template is pinned.

The reason is the one Phase 11b already gave, and it is stronger here rather than weaker: this phase
exists to answer *"can a 16 GB user be given this tool"*, and a measurement of a tool that will not be
shipped cannot answer it. Option A buys arithmetic comparability at the price of measuring the wrong
artefact.

**What that costs, stated rather than hidden:** §5.2's SHIP clause is `A(api) ≥ 0.90 · A(C2)`, and
`A(C2) = 0.900` on both real projects is a Phase 11 figure from the pre-`6c161de` template. §5 is frozen
and is not being edited, so the bar stands at the number it names — but a reader must be told that the
two sides of that inequality were measured on different prompt bytes. Three things make this the least
bad option rather than a fudge:

- the change to `fixer.md` **adds a refusal path** and does not alter the instruction the worker is
  given about the change itself, so its effect on approval is plausibly small — *plausibly*, which is an
  argument for reporting the caveat, not for dismissing it;
- refusals are their own row in `FixResult.stats` (§5.1) and are never folded into `S`, so if the new
  path does bite it shows up as itself rather than as a moved survival rate;
- **whenever a same-commit local arm exists — Phase 11b's or a later one — the comparison is redone
  against it and that becomes the headline**, with this run's figure kept. That is option C, deferred
  rather than refused, and it is the only thing that removes the caveat.

### Consequences
- §5.0 precondition 4 is satisfied by this ADR, and its date is before any `api`-tier candidate exists.
- Phase 6's `C3` token figures remain **not** this tier's cost (ADR-0045 §7, Phase 13 §7), and the
  README must not quote them for it. They are an upper bound from a subagent harness.
- Nothing measured here speaks to Phase 11b's axis — whether the `api` tier beats *not using sidecrew*
  on a 16 GB machine (Phase 13 §5.4).
- The `api` run's result records the commit it ran at, so the "same commit" in option C is checkable
  rather than remembered.

## ADR-0062 — A refusal on a single-file task is swallowed by the bare-answer fallback

**Status:** accepted · 18 Sep 2026 · **option B** · found while building Phase 13, in the api tier's
tests · **not a Phase 13 decision** — it is about the workload #2a contract and it applies to the local
tier identically · fixed in `083cf21` on `main` before this branch merged, and the reasoning below is
the record of why

### The defect
`generateChange` and `generateApiChange` both parse a completion in this order:

```ts
const { edits, unparsed } = parseEdits(completion.text, task);
const refusal = edits.length === 0 ? parseRefusal(completion.text) : null;
```

and `parseEdits` ends with ADR-0047's deliberate concession:

> **only when the task has exactly one file** — a bare answer, because a model handed one file and
> asked for one file back very often simply returns it.

So on a one-file task **any non-empty answer becomes that file's new contents**, `edits.length` is
never 0, and `parseRefusal` is never reached. A worker that answers exactly as
`src/prompts/fixer.md` instructs —

```
--- CANNOT: the symbol is not in these files ---
```

— produces a candidate whose edit replaces the file with that sentence. It then fails `tsc` and is
counted as an ordinary failure. Reproduced in `test/api-tier.test.ts`; `parseEdits` on a **two**-file
task returns `[]` and the refusal is read correctly, which is what makes this a one-file bug rather
than a broken parser.

### Why it matters more than it looks
1. **`FixResult.stats.refusals` is structurally 0 for single-file tasks.** ADR-0056 added
   `machine_failures` so that *"a rate's denominator can now exclude what was never the worker's to
   answer"*; a refusal is the other member of that family and it is being counted in the numerator of
   the worker's failures instead.
2. **Phase 11 measured only single-file tasks.** ADR-0058's *What is not decided* says so in terms:
   *"Phase 11 measured only one file per task, so every survival number in this repository is for
   single-file tasks."* Phase 11b reuses those plans. So the refusal path Phase 12 built is **inert in
   exactly the configuration everything has been measured in**, and a run reporting `refusals: 0` is
   reporting a constant rather than an observation.
3. **It is invisible in a summary statistic**, which is this project's recurring failure mode (Phase
   11's six defects, Phase 12's two). Nothing looks wrong: `S` moves, the funnel moves, `refusals`
   sits at 0 and reads as *"the worker never needed to refuse"*.

### Options
- **A — parse the refusal before the edits.** `parseRefusal` first; if it matches and nothing else in
  the answer is a `--- FILE:` marker, it is a refusal. Cheapest, and it matches the prompt's own
  contract (the refusal form is a whole answer, not a fragment). Cost: an answer that *quotes* the
  marker inside a file it is rewriting would be read as a refusal. `parseRefusal` is already strict
  about the form, and requiring the absence of any `FILE:` marker makes the collision narrow — but
  narrow is not zero, and the failure is silent in the other direction.
- **B — exclude a refusal from the bare-answer fallback.** Leave the order alone; make the fallback
  refuse to claim text whose only content is a `CANNOT` marker. Smallest possible change, and it keeps
  ADR-0047's concession intact for every other answer. Cost: two places now know what a refusal looks
  like.
- **C — drop the bare-answer fallback and require markers.** Removes the ambiguity at its root. Cost:
  it un-decides ADR-0047's concession, which exists because a 7B handed one file very often returns it
  bare — and Phase 11's `edit_parse_failed = 0` across 30 real rewrites is evidence the concession is
  doing real work. This would spend verdicts on a formatting convention, which is what it was added to
  avoid.
- **D — leave it, and label `refusals` as multi-file-only.** Honest and free. Cost: the contract field
  means something different depending on the task's file count, which is the kind of conditional truth
  that ADR-0056 added a field to avoid.

### Recommendation
**B**, with **A's ordering as the thing to reconsider if a second ambiguity appears.** B is the change
that does not touch anything Phase 11 measured: no answer that produced a candidate before produces a
different one after, so no survival rate moves and no arm becomes incomparable. That property matters
more than usual right now, with Phase 11b running against those same plans.

### Decision, 18 Sep 2026 — B, and it was already shipped
The recommendation was taken. `parseEdits` checks for a refusal **after** the `--- FILE:` marker pass
and **before** the bare-answer fallback:

```ts
if (edits.length > 0) return { edits, unparsed: null };      // markers won; nothing to disambiguate
if (parseRefusal(clean) !== null) return { edits: [], unparsed: null };
const only = task.files.length === 1 ? task.files[0] : undefined;   // ADR-0047's concession, intact
```

**That placement also closes A's collision, which is why B did not need A's ordering after all.** The
cost recorded against A was an answer that *quotes* a `CANNOT` marker inside a file it is rewriting. It
cannot arise here: such an answer carries a `--- FILE:` marker, so the first line returns before the
refusal check is reached. The ambiguity A had to reason about is resolved structurally rather than by a
strictness heuristic.

Both tiers get it for free — `generateChange` and `generateApiChange` both derive `refusal` from
`edits.length === 0`, so fixing the parser fixed the pair.

**Shipped before this branch merged**, because Phase 11b was mid-flight against exactly the single-file
plans this defect makes `refusals` inert on. That session checked its in-flight arm's candidates for
`CANNOT` text, found none, and restarted on a rebuilt binary — so no measured number depends on the
buggy parser. Regression test in `test/fix.test.ts`, covering one-file and two-file tasks and asserting
ADR-0047's bare-answer concession still works.

Whatever is chosen, **the measurement question is separate and is not fixed by the code change**:
every `refusals` figure taken so far on single-file tasks is a constant, and re-reading it as an
observation would be wrong.

### Not decided here
This is written where the options are, per CLAUDE.md's *When unsure*, and left for the owner. Phase 13
neither fixed it nor relied on it; `test/api-tier.test.ts` asserts today's behaviour so that a fix is
noticed rather than silent.

## ADR-0063 — An experiment may run `tsc` stricter than the project does, and must say so

**Status:** accepted · 18 Sep 2026 · owner's decision · narrows Phase 11 §2's "unmodified real
projects" rather than reversing it · enables Phase 11b §4.4 and Phase 12 §2.2

### Context
Phase 11b §4.4 withholds its verdict unless at least half its tasks are `null_guard`, `api_migration`
or `dead_code`. Phase 12 §2.2 needs tasks a 7B actually **fails**, and `retried = 0` across all 54 of
Phase 11's tasks says renames and unused-import removals are not those. Both phases needed the same
missing input.

The Phase 11b session surveyed both projects and reported the harder shapes as absent: zero
`api_migration` candidates, zero `null_guard` in project-a. That survey was checked independently and
the conclusion did not hold, for a reason that is the whole of this ADR:

**`project-a` compiles with `strict: false` and `strictNullChecks: false`.** The survey looked for `!.`
dereferences as a null-guard proxy — and with `strictNullChecks` off *nobody writes `!`, because the
compiler never demands it*. The proxy was structurally incapable of returning anything but zero. The
disconfirming evidence was in the same table: project-b, which is `strict: true`, returned 11.

Measured on project-a with `tsc --strictNullChecks` as a **command-line flag, with no file in the
client's repository changed**:

| | project-a |
|---|---|
| files with ≥ 1 error | 763 |
| files with **1–3 total** errors — few enough for one ask to cover all of them | **417** |
| …of those, inside ADR-0047 §2's whole-file ceiling | **401** |
| …of those, where *every* error is null-shaped (TS18048/18047/2532/2538) | **22** |

(The ceiling is 22,674 characters, derived from `rewriteCost`, not the ≤400 lines the first survey used.)

### Decision
**An experiment may compile a project at a stricter setting than the project's own, and the protocol
must declare it.** Four conditions, and the run is void without them:

1. **No file in the project changes.** A compiler flag only. The moment a `tsconfig.json` is edited,
   Phase 11 §2's rule bites: *if the project has to be changed to be verified, that is a finding about
   sidecrew, not a setup step.*
2. **The baseline is captured under the same setting.** `compile_ok`'s "no file anywhere has more errors
   after than before" compares two error counts, and comparing them across two compiler configurations
   is meaningless. sidecrew already captures the baseline through the same path, so this is a plumbing
   requirement rather than a new rule — and the plumbing does not exist: `loadChangePlan` takes a
   tsconfig *path*, not flags.
3. **Every number says which setting produced it.** A survival rate under `--strictNullChecks` and one
   under the project's own configuration are not the same measurement and may not share a table cell.
4. **The gate's meaning is restated, because it changes.** Under the project's own configuration the
   gate asks *does this preserve what the project's own compiler says*. Under a stricter one it asks
   *does this satisfy a stricter compiler*. The second is a legitimate and more valuable experiment —
   it is the canonical real 2a job — but it is a different question and the report says so.

Condition 4 is the Phase 11b session's own framing and is the sharpest statement of the cost.

### Why this is the right call rather than a convenience
The alternative reading — "unmodified means as the project compiles today" — is defensible and was
considered. It fails on its own terms: it makes `VISION.md`'s **headline example** unmeasurable. *"Fix
every TypeScript error in this codebase"* has an empty task list on a project whose compiler reports
zero errors, which every well-maintained project does by definition. A discipline that forbids measuring
the thing the product is for is not protecting the measurement.

And the scenario is not contrived. *A team turns on `strict` and fixes the fallout* is among the most
common large behaviour-preserving jobs in TypeScript, it is exactly what workload #2a is shaped for, and
it is the condition under which a user would actually reach for this tool.

### Consequences
- **Phase 11b §4.4 becomes reachable and is not amended.** The bar is unchanged; what changes is whether
  the task set can meet it. §4.4 already says to report the cells and withhold the verdict when it
  cannot, which is the frozen rule working.
- **Phase 12 §2.2 gets a denominator**, from the same source, and
  `experiments/correction-round/README.md` §4.5's threat stands: a task set chosen because the worker
  fails on it is still a biased task set, and now the bias has a second source — the strictness setting
  was also chosen.
- **Plumbing is owed**: compiler flags are not expressible in a `ChangePlan` today. Whoever runs the
  first such experiment builds it, with a spec update in the same commit.
- **A stricter setting is not a licence to pick the strictest.** `--strictNullChecks` on project-a
  yields ~11,000 errors; 417 files are satisfiable and 174 have 11 or more, which no single ask covers.
  The setting is chosen to make the work *visible*, not to maximise it.

## ADR-0064 — Workload #2a's addressable surface is a property of the project's configuration, not of its code (PROPOSED)

**Status:** proposed · 18 Sep 2026 · bears on `VISION.md`'s worked example · needs the owner

### Context
Phase 11 measured **zero `tsc` errors** on both unmodified real projects, and every task it ran was a
rename or an unused-import removal. The natural reading, and the one both sessions initially took, is
that the addressable population of workload #2a on a real codebase *is* renames and dead imports — a
narrow and rather disappointing surface.

ADR-0063's measurement says that reading is wrong, and the correction generalises well beyond these two
projects:

> **The addressable surface of workload #2a is whatever the compiler is currently asked to report.**
> That is a property of the project's configuration, not of its code.

project-a has ~11,000 latent type errors and reports zero, because `strictNullChecks` is off. The work is
there. The compiler is simply not being asked.

### Why this matters more than a survey result
`VISION.md`'s worked example, and the owner's own, is **"fix every TypeScript error in this codebase"**,
described there as *"the best-fitting workload in the entire design"*. Taken literally against a
well-maintained project, that job **does not exist** — the task list is empty by construction, because a
maintained project keeps its own error count at zero. The example presupposes a codebase that has errors,
and says so nowhere.

So the honest statement of when #2a pays is narrower and more specific than the vision implies, and it is
also more useful:

- **a project mid-migration** — a framework or major-version upgrade with the fallout not yet cleared;
- **a project that has just raised its own bar** — `strict`, `strictNullChecks`, `noUnusedLocals`, a new
  lint rule — which is the single most common source, and the one a team schedules deliberately;
- **a project with a large legacy surface** the team has never had budget to clean;
- **not** a clean, actively-maintained codebase at its own settings, where the surface is renames, dead
  imports, and little else — exactly what Phase 11 measured and correctly reported.

### Options
- **A — record it here and leave `VISION.md` alone.** Cheapest. Costs: the vision keeps an example whose
  task list is empty on the projects most likely to be used to demo it, and the next person to notice
  re-derives this.
- **B — amend `VISION.md` with one paragraph**: #2a's population depends on the project's strictness
  setting, so the worked example presupposes a project that has errors, and the shapes it names are what
  a *raised bar* produces. Costs: it is the owner's document and its claims are the owner's.
- **C — make it a product claim rather than a caveat.** *"Point sidecrew at the migration you have been
  putting off"* is a sharper pitch than *"fix your type errors"*, and it is the same machinery. Costs: a
  positioning decision, and nothing has been measured on a migration yet.
- **D — measure it before claiming anything.** Run #2a on a project at a raised bar and report the rate
  per shape. Phase 11b and Phase 12 §2.2 will produce exactly this data under ADR-0063.

### Recommendation
**D, then B** — the measurement exists shortly and the amendment should quote it rather than anticipate
it. **C is the interesting one** and is deliberately left to the owner, because it is about what this is
*for* rather than about what it does.

### What is not decided
Whether the surface at a raised bar is *tractable*, as distinct from present. 401 of project-a's 417
satisfiable files fit the whole-file ceiling, but 174 files carry 11+ errors that no single ask covers,
and nothing has yet measured whether a 7B can clear a null-guard error at all — every survival number in
this repository is for renames and unused imports. Present is not the same as addressable, and this ADR
claims only the first.

## ADR-0065 — Memoise candidates, never verdicts, and key on the rendered prompt

**Status:** accepted · 18 Sep 2026 · Phase 13b · `BACKLOG.md` § *The edge ideas* item 3, which was
Phase 10's or Phase 12's and was built by neither

### Context
The backlog's pitch: *"Runs are deterministic (ADR-0003): same rendered prompt, seed, model and revision
give the same bytes. A cache keyed on those makes a re-run after an unrelated change cost nothing."*

Two things have to be decided before a line of it exists, and the second one turned out to be settled by
a measurement taken the same day.

### 1. What goes in the key
A cache key that misses an input serves a candidate produced for a **different question**, and nothing
downstream can tell. That is ADR-0037's failure mode — a stage that passes quietly — with a new way in.

- **A — key on the `ChangeTask`.** Canonicalise the task and hash it. Reads well, and it is wrong: the
  **prompt template is an input and it changes.** `src/prompts/fixer.md` gained the refusal form in
  `6c161de` today; a task-keyed cache would have gone on serving candidates generated by the previous
  template, indefinitely, with the task bytes identical. It also silently includes fields the prompt
  never renders — `shape` and `max_deleted_lines` are gate inputs, not generation inputs — so it would
  miss on tasks whose completions are genuinely identical.
- **B — key on the rendered prompt.** `changePromptText(task)`, the exact bytes sent, plus the sampling
  parameters that are not in it. The template is folded in by construction: change the template, change
  the rendered text, change the key. Nothing has to remember that the template is an input.

**Decision: B.** The key is the sha-256 of:

```
rendered prompt ‖ model repo ‖ pinned revision ‖ seed ‖ temperature ‖ max_tokens
```

`max_tokens` is derivable from the task (`fixTokenBudget`) and is included **anyway**, because a derived
value that stops being derived the same way is exactly the kind of drift a hash exists to catch.

**Local tier only.** ADR-0045 §5: the `api` tier has no seed, so its output is not reproducible and
caching it would be caching a coincidence. The tier is in the key's scope only in the sense that an
`api` run does not consult the cache at all.

### 2. Verdicts are not cacheable, and this is now measured rather than argued
The valuable version of this idea is caching **verdicts** — the gate is 95 % of a candidate's cost, so
caching generation saves almost nothing (§3). It is also impossible, and Phase 11b measured why on the
day this was decided:

> Arm C's `rename-04` produced two verdicts from a **byte-identical candidate**: `tests_ok: false` with
> **155 named regressions** on the first run, `survived` on the second. The machine was swapping
> (32 GB installed, 5.3 of 6.1 GB swap in use).

**A verdict is not a pure function of its inputs.** A gate starved of memory fails *closed*, and the
false negative names specific tests and reads exactly like a real regression `tsc` cannot see. A verdict
cache would take the first of those two answers, key it on the candidate, and serve it forever — turning
a transient environmental failure into a permanent recorded one, in the direction that makes the tool
look stricter than it is.

So: **candidates are cached; verdicts are re-computed, always.** Anyone revisiting this should read the
`rename-04` case first.

### 3. What it is worth, stated so nobody quotes it as more
**The backlog's claim that a re-run "costs nothing" is false**, against Phase 11's own numbers:
generation is **13.5 s** of a **~275 s** candidate, and the gate is **95 %** of the cost. A fully cached
re-run therefore saves about **5 %** of wall clock, not 100 %.

The honest case for building it is not speed:

- **Re-planning.** A 40-task plan edited to add five tasks currently regenerates forty. With the cache it
  generates five. Still only ~5 % of the run's cost, but it is the shape Phase 11b is about to hit.
- **Reproducibility as evidence.** A cache hit is a claim that ADR-0003 holds. Regenerating on a hit and
  comparing bytes turns Phase 1's one-off 5/5 determinism check into a continuous one, at the cost of
  the thing it was meant to save. Worth having behind a flag, not by default.

### Consequences
- **A cached run's `generate_ms` is not a measurement, and the result has to say so.** `FixResult.stats`
  gains a cache-hit count; a run with hits must not have its `generate_ms` median quoted, because the
  hits are near-zero and would drag it towards a number no worker ever achieved. For a project whose
  entire output is measurements, this is the consequence that matters most — a cache that silently
  improved a timing figure would be the third instance this week of a number that looks right.
- **Experiments run with the cache off.** Any go/no-go arm, any `experiments/` figure: a measurement of
  what the workers do cannot be served from a record of what they did last time. Off by default,
  on by flag, and the flag is recorded in the result.
- **The cache is content-addressed and never invalidated**, because the key covers its inputs. It grows;
  a size cap is a later problem and is noted rather than solved.
- **A cache miss is not an error and a corrupt entry is not fatal.** Unreadable entry → regenerate. The
  failure mode of a cache in this repository must be *slower*, never *wrong*.

### What is not decided
Whether it pays for itself at all. **5 % of wall clock is small enough that it may not**, and the owner's
decision of 18 Sep was that it lands before publish, not that it is worth the disk. The measure the
backlog names — *wall time of a second identical run* — is worth taking once it exists, and the answer
may be that the re-planning case is the only one that justifies it.

## ADR-0066 — A gate under memory pressure fails closed, and the false negative is indistinguishable from a true one

**Status:** **accepted, option C** · proposed 18 Sep 2026, decided by the owner 19 Sep 2026 · found during Phase 11b arm C · implemented the same day, addendum below
**Bears on:** every workload #2a measurement, Phase 12 §2.2, Phase 13 §5 · **evidence:** measured, below

### Context

Phase 11b's arm C was interrupted at task 4 of 19 by a result that should not be possible.

A **byte-identical candidate** — same task, same worker, temperature 0, `sha256` of its edits
`d18fea54c85465f5` on both attempts — produced two different verdicts on two consecutive runs of the
same gate:

| attempt | `confined` | `compile_ok` | `tests_ok` | verdict |
|---|---|---|---|---|
| 0 | true | true | **false**, 155 regressed | failed |
| 1 | true | true | true | **survived** |

All 155 regressions were in a single suite. The candidate touched one module file. Nothing in the
verdict is wrong on its face: 155 named tests, a confined diff, a clean `tsc`. It reads exactly like a
renamed runtime-resolved identifier that the compiler cannot see — a real, plausible, well-evidenced
defect of precisely the kind this gate exists to catch.

It was not. The machine was thrashing: 32 GB installed, 15.2 GB compressed, 5.3 of 6.1 GB swap in use.

### The finding

> **A resource-starved gate fails closed, and it fails closed in a way its own verdict cannot
> distinguish from a true failure.** The verdict records what it observed, and what it observed really
> did happen — the tests really did fail. The verdict has no field for *why*, and no way to acquire one.

The only thing that separated the false negative from a true one was running the identical candidate a
second time. Nothing in the artefact, the funnel, or any summary statistic carried the distinction.

**This is ADR-0011's structure, one level up.** That ADR retired peak RSS as a gate input on the grounds
that *"peak RSS cannot detect the condition that invalidates peak RSS"* — under pressure macOS
compresses and evicts, so RSS falls while the machine starves. The same sentence holds here with the
noun changed: **a gate verdict cannot detect the condition that invalidates a gate verdict.**

### Why it happened, which is worse than bad luck

The guard already exists, is already documented, and is wired into one of the three places that need it.

`kern.memorystatus_vm_pressure_level` (1 normal, 2 warn, 4 critical) is the kernel's own judgement, and
ADR-0011 named it as the check that `free_gb` cannot replace — because under pressure `vm_stat`'s free
pages *rise* while the machine thrashes.

| call site | reads `free_gb` | reads pressure |
|---|---|---|
| `serve.ts:138` — worker startup | yes | **yes** |
| `fix.ts:663` — workload #2a | yes | **no** |
| `batch.ts:490` — workload #1 | yes | **no** |

So the worker politely refuses to *start* on a starved machine, and then both workloads run their gates
on one without looking. Arm C logged `17.6 GB free ÷ 6.5 GB per slot` and sized itself off a number that
was high *because* the machine was in trouble. The instrument read the symptom as headroom.

**A concurrency clamp would not have prevented this.** The run was already `--concurrency 1`. One
project suite plus a resident 7B plus an IDE exceeded the machine on its own. The defect is not sizing;
it is that the gate never asks about pressure at all.

### Why it biases in one direction only

This is the part that would have quietly poisoned Phase 11b rather than merely adding noise.

Arms A and B (a frontier model alone, no gate) never run the project's suite. Arms C and D do. So
contention **cannot** hurt the ungated arms and **can only** hurt the gated ones — and it hurts them by
manufacturing failures. A loaded machine therefore makes the gate look stricter than it is, which reads
in the report as *"sidecrew rejects changes that were fine"*: a conclusion about the tool, produced by
the laptop.

An experiment comparing a gated arm against an ungated one on a shared machine has this exposure by
construction, whether or not anyone notices.

### What was done now, and what was deliberately not

**Done — the environment, not the product.** The 11b launcher waits for the kernel to report pressure
normal on three consecutive samples before starting, and then **records** `pressure, free_gb, swap_gb,
compressed_gb` every 20 s for the whole run. The recorder is the important half: it does not prevent
anything, it makes a starved verdict *identifiable after the fact* by cross-referencing a verdict's
mtime against the timeline. Without it contamination can only be suspected; with it, it can be checked.
(Its `free_gb` agrees with `parseMemory` to the decimal, so it is the product's own instrument.)

**Not done — the gate.** The right fix is almost certainly to classify a `tests_ok: false` taken under
`warn`/`critical` pressure as a **`machine_failure`** rather than a gate failure. ADR-0056 already put
that field in the contract and the denominator rule already excludes it:
`tasks − survived − refusals − machine_failures`.

That change was **not** made, and the reason is the point of the frozen-rule discipline rather than
caution for its own sake: it changes what the gate counts, mid-experiment, *after seeing a number it
would have changed*. §4 of both phase prompts forbids exactly that, and it would make arm C
non-comparable with arms A/B and with Phase 11. **The environment is mine to fix during a run; the gate
is not.**

### Options for the real fix, after 11b reports

- **A — sample pressure around the suite and downgrade to `machine_failure` on `warn`/`critical`.**
  Correct, uses machinery that exists, and costs one sysctl per verification. Risk: a machine that is
  *always* under mild pressure silently converts real failures into machine failures, which is the same
  bug with the sign flipped — so the threshold and its denominator effect must both be reported.
- **B — refuse to start a gated run under pressure, and abort mid-run if it rises.** Simplest and
  strictest. Costs hours of a long run to a transient spike, and an aborted run is a lost measurement.
- **C — record pressure on the verdict and gate nothing.** What the launcher does today, promoted into
  the product: every verdict carries the machine's state when it was taken, and analysis excludes what
  it likes. Cheapest, fully honest, and leaves the judgement where the evidence is.
- **D — re-run any failing candidate once before recording a failure.** Catches it empirically without
  any notion of pressure, and would have caught this exact case. Roughly doubles the cost of every
  failure, which at 262 s per attempt is the most expensive option here.

**Recommendation: C now, A after.** C is unarguable and cannot bias anything, because it adds a field
and changes no decision. A is the one that actually protects a rate, and it should land with the
threshold's effect on the denominator measured rather than assumed.

### Consequences

- Phase 11b's arm C was **discarded at 4/19 and restarted from scratch**, not resumed. Resume reuses any
  *terminal* verdict, and a false negative is perfectly terminal — it would have preserved all four. The
  `resume` docstring now says so in terms (`3e6d9b7`).
- Arms A and B stand. Their measured quantities — tokens, delivered changes, lines — involve no gate.
- Any #2a survival rate taken on a contended machine is soft, including ones already recorded. Phase 11's
  arms ran overnight on a quiet machine, which is the reason to believe them, and that is now a stated
  precondition rather than a lucky habit.

### Amendment, 18 Sep 2026 14:15 — pressure level is too coarse to be the threshold; swap growth is the signal

The recorder answered its own open question within three minutes of first running, which is the best
argument for option C that could have been made.

Arm C's restart began on a machine at **18.8 GB free, pressure normal**, with nothing else running. The
baseline suite capture alone moved it to `warn` in **100 seconds**:

| t+ | pressure | free | swap | compressed |
|---|---|---|---|---|
| 0 s | 1 normal | 18.8 | 2.5 | 4.9 |
| 40 s | 1 normal | 9.4 | 2.5 | 8.7 |
| 60 s | 1 normal | 7.1 | 2.5 | 12.9 |
| 80 s | **2 warn** | 7.4 | 2.5 | 14.2 |
| 120 s | **2 warn** | 5.9 | 2.7 | 15.1 |

**Free memory collapsed into the compressor, and swap stayed flat.** That is the distinction the ADR
above missed by treating `warn` as the actionable state:

- **Compression is the suite's ordinary operating point.** 352 suites and ~6,300 tests plus a resident
  7B do not fit in 32 GB with room to spare, so the kernel compresses, reports `warn`, and everything
  still works. Nothing reaches disk.
- **Swapping is the damaging condition.** When the false negative was produced this morning, swap was at
  **5.3 of 6.1 GB** — 2.8 GB above this run's floor and actively paging. That is when a suite starts
  timing out, and a timeout is what the verdict records as a regression.

**Consequences, and one of them is uncomfortable:**

1. **Option A's threshold cannot be the pressure level.** A gate that downgraded every `tests_ok: false`
   taken at `warn` would downgrade nearly all of them on this hardware, converting real failures into
   machine failures wholesale — the same bug with the sign flipped, which this ADR already warned about
   in the abstract and can now name a threshold that would cause it. The candidate signal is **swap
   growth against the run's own floor**, which is a delta rather than a level and needs no absolute
   calibration.
2. **Phase 11's arms almost certainly ran at `warn` too**, since the same suite on the same machine
   reaches it unaided. That does *not* make them soft: they ran overnight with nothing else resident, so
   the compressor had room and swap had no competition. The distinction between the two runs was never
   `warn` — it was whether anything else was also demanding memory.
3. **A start-time guard is necessary and not sufficient**, for the same reason ADR-0011 gave about
   `free_gb`: the workload creates the condition after the check has passed. The recorder is what covers
   the gap, and it covers it by observation rather than by prediction.

This is why the recommendation stays **C now, A after**. C would have caught all of this on the first
run that used it; A written yesterday would have shipped a threshold that was wrong on this machine.

### Amendment, 18 Sep 2026 14:35 — the false negative reproduced across a restart, which rules out the remaining explanations

The restarted arm C reached the same task on a quiet machine. Same candidate, third evaluation:

| run | machine | binary | attempt | verdict |
|---|---|---|---|---|
| 11:21 | swapping 5.3 / 6.1 GB | pre-restart | 0 | **failed at `tests`**, 155 regressed |
| 11:21 | swapping | pre-restart | 1 | survived |
| 12:09 | quiet, swap flat at 2.5–3.0 GB | `2e7aa1e` | 0 | survived |

All three candidates hash to `d18fea54c85465f5` over their edits. **One failure in three evaluations of
identical bytes, and it is the one taken while the machine was paging to disk.**

This closes the alternatives that a single retry left open:

- **Not a flaky suite.** A suite flaky in that spec file would fail at some rate independent of machine
  state; it has now passed twice, on two binaries, in two runs, and failed only under swap.
- **Not a stale binary or a code change.** The morning run and the afternoon run used different
  binaries and produced the same candidate and the same survival.
- **Not worker non-determinism.** The 7B emitted byte-identical edits hours apart at temperature 0,
  which independently corroborates Phase 11's `determinism_observed`.

The evidence for this ADR is therefore cross-run rather than cross-attempt, and the recommendation is
unchanged: **C now, A after**, with the threshold on swap growth rather than pressure level.

## ADR-0067 — The #2a gate compares test identity, not test counts, and a parameterised case can fail invisibly

**Status:** accepted · implemented on `main` 18 Sep 2026, see the addendum below · 18 Sep 2026 · found by reading Phase 11b's baseline artefacts · needs the owner
**Direction:** leniency — the opposite of ADR-0066. This one lets a broken change *through*.

### What was found

Reading arm C's baseline for something else, the counts did not line up:

```
passed: 6159        passed_ids (list): 6159        unique ids: 5864
```

**54 test ids appear more than once, up to nine times each** — `test.each` and other parameterised
tests, which jest reports under a single `file::fullName` for every case. 295 of 6,368 executions
(4.6 % of the suite) live inside an id that covers more than one assertion.

### Why that defeats the regression rule

ADR-0048's gate requires *every test that passed before still passes*. The implementation is
(`change.ts:603`):

```ts
const passedNow = new Set(suite.passed_ids);
const regressed = baseline.tests.passed_ids.filter((id) => !passedNow.has(id) && seenNow.has(id));
```

`passedNow` is a **set**. If a parameterised id had nine passing cases at baseline and a candidate
breaks one of them, the other eight still put that id in `passedNow`, so `!passedNow.has(id)` is false
and **no regression is recorded** — nine times over.

Nothing else closes it:

- **`ran_after >= ran_before` does not.** A failing case still ran, so the count is unchanged.
- **`failed` is not compared.** It is captured at baseline and on every candidate (`change.ts:441`) and
  then never read.
- **`passed` is not compared either.** Same: recorded, unused.

So `tests_ok` is `reported && regressed.length === 0 && ran >= ran_before && ran > 0`. **The gate
compares identity sets and ignores the counts it already has.**

### Why this is not the same bug as ADR-0066, and is in some ways worse

ADR-0066 is a false *negative*: the gate rejects a good change, loudly, with evidence. It is expensive
and it is visible if you look.

This is a false *positive*: the gate admits a change that broke something, silently, and reports
`survived`. Workload #2a's entire claim is that a machine can decide what Opus is allowed to see. A
survivor that broke a parameterised case has passed a gate that could not have caught it, and the only
remaining line of defence is the blind reviewer — who is reading a diff, not running a suite.

**It touches every #2a number in this repository**, because the rate it inflates is `S`. It does not
invalidate them: renames and unused-import removals are unlikely to break one case of a parameterised
test and not the others, and Phase 11's blind review found no such defect. But "unlikely by the shape
of the tasks we happened to run" is a weaker guarantee than the gate is advertised to give.

### The fix is one line, and it is better than the rule it supplements

```ts
tests_ok = … && suite.passed >= opts.baseline.tests.passed;
```

A count comparison is **more** robust to the problem ADR-0053 solved, not less. A test whose title is
generated from `Date.now()` gets a new id every run, which is exactly why id comparison needed the
`seenNow` guard — but it still *passes*, so it still counts. Counts are blind to renaming by
construction.

The risk is the mirror of ADR-0053's: a genuinely flaky test that passes at baseline and fails on a
candidate would now fail the gate on the count where the id rule already fails it on identity, so this
adds no new flakiness exposure. What it does add is sensitivity to a suite whose total varies by
itself — a `test.each` over a directory listing, say — and that should be measured before the clause
lands rather than assumed absent.

### Options

- **A — add the count comparison.** One line, closes the hole, strictly more sensitive.
- **B — record `passed_before`/`passed_after` on the verdict and gate nothing yet.** ADR-0066's option
  C applied here: make it visible, learn the false-alarm rate, then gate. Cheapest and unarguable.
- **C — count occurrences rather than set membership** (compare multiset of ids). Exact, and it names
  *which* parameterised id lost a case, which A cannot. More code, and it inherits ADR-0053's
  generated-name problem in full.

**Recommendation: B now, then A.** The same reasoning as ADR-0066 and for the same reason — the
threshold question here is "does this suite's total vary on its own?", and that is a measurement
nobody has taken. Two ADRs in one day have now turned on a number that did not exist.

### Not changed during Phase 11b

`tests_ok` is the gate. Changing it mid-experiment is what §4 forbids, and it would make arm C
incomparable with arms A, B, D and with Phase 11. Recorded, not applied.

## ADR-0068 — `observations` counts comment lines, so a reworded comment is invisible

**Status:** accepted · implemented on `main` 18 Sep 2026, see the addendum below · 18 Sep 2026 · measured in Phase 11b arm C · amends ADR-0057 · needs the owner

### Context

ADR-0057 added non-gating `observations` to every `ChangeVerdict` so that unrequested cosmetic edits
are visible without spending a blind reviewer — explicitly as *"the cheapest read on `E(x)`"*.

Phase 11b arm C gives it its first real test, and it fails the case it was built for.

The local 7B matched Opus byte-for-byte on 18 of 19 tasks. On the nineteenth, given

> Rename `normalizeCriteriaId` to `canonicaliseCriteriaId` … **Change nothing else.**

it renamed the symbol *and* reworded the function's doc comment from "Normalises …" to
"Canonicalises …". Whether that is a defect or an improvement is precisely the judgement
`observations` was meant to surface cheaply.

**All 19 verdicts carry `observations: []`, including that one.**

### Why it missed

`observe` (`confinement.ts:221`):

```ts
const lost = commentLines(before) - commentLines(edit.contents);
if (lost > 0) { … }                    // fires only when the count DROPS
```

A reword changes no counts. `commentLines` is equal before and after, `blankLines` is equal, so no
observation is emitted. The detector measures **volume**, and the behaviour it is chasing changes
**content** at constant volume.

This was predicted. Phase 12's handoff to 11b says, in one clause, that *"a line delta is blind to a
comment reworded at the same length (1 of Phase 11's 4 cases)"*. It is now measured.

### Why it matters more than one missed observation

**The behaviour is reproducible, not incidental.** Phase 11's single blind-review rejection on this
project was *"1 of 10 C2 survivors reworded a doc comment ('Normalises' -> …)"*. Same worker, same
behaviour, same word, different phase, different task set. This is a property of the model, and it is
**the only quality difference between a 7B and a frontier model anywhere in this phase's data.**

So the one thing `observations` needed to see is the one thing the whole experiment found, and the
detector's blind spot is aligned exactly with the worker's signature. A proxy that misses the only
case in its dataset has a measured sensitivity of **0/1**, which is not a number to ship on.

### Options

- **A — compare comment *text*, not comment count.** Collect comment lines before and after; emit
  `comment_text_changed` when the multisets differ and the ask did not request it. Catches rewords,
  reorderings and substitutions, and subsumes the current check. Cost: noisier on `dead_code` and on
  any ask that legitimately touches prose, which needs the same `task.shape` exemption the current
  rule already has.
- **B — emit a normalised-text hash per file and diff it against the source with comments stripped.**
  Distinguishes "code identical, comments changed" from "code changed" exactly, which is the real
  question. More code; the most precise answer.
- **C — leave it and rely on the blind reviewer.** Honest, and it concedes ADR-0057's stated purpose:
  the field then records whitespace churn and deleted comments only, and should say so rather than be
  described as a read on `E(x)`.

**Recommendation: A, with ADR-0057's description narrowed either way.** Even if the owner takes C, the
claim that `observations` is a cheap proxy for `E(x)` should be struck, because the measurement now
says it is not one. A mechanism that is believed to cover a case it cannot see is worse than an absent
one — the same shape as ADR-0066's unfinished guard, in a different part of the system and on the same
day.

### Not changed during Phase 11b

`observations` are non-gating, so changing the detector would not alter a single verdict. It would
still change what arm C's artefacts record mid-experiment, and the comparison with Phase 11's arms
depends on the field meaning the same thing. Recorded, not applied.

> **ADR-0066 to ADR-0068 are the Phase 11b session's** and land here when its branch merges. ADR-0067
> and ADR-0068 were *decided and implemented* on `main` on 18 Sep 2026 — the reasoning stays theirs and
> the decision sections below record what was built. Numbering continues at 0069.

## ADR-0067 addendum — implemented on `main`, 18 Sep 2026: the gate compares how much passed, not which names

**Status:** accepted · the Phase 11b session found it and proposed the fix; this records what shipped.

`tests_ok` gains `suite.passed >= baseline.tests.passed`, and `ChangeVerdict.tests` gains
`passed_before` / `passed_after` so the **schema can enforce it**. A gate condition a schema cannot check
is a convention rather than a gate (CLAUDE.md #2), and the one-line fix alone would have left the
strongest clause in the gate unenforceable.

**This is the only gate defect found so far that erred towards leniency.** ADR-0066's starved gate
refuses a good change, which is visible and recoverable; this one **admitted a broken one**. A
`test.each` block gives every case the same `fullName`, so breaking one of nine leaves the id in the
passing set (`regressed` empty), and `ran_after >= ran_before` holds because the failing case still ran.
Nothing in the verdict could see it. Measured: 54 ids appearing up to 9 times, 295 of 6,368 executions.

The counts are also **more** robust than ids to the generated-name problem ADR-0053 solved — a renamed
test still counts — so this strengthens two rules at once.

Its own failure message is deliberately distinct from `regressed`'s: there are no test *names* to report,
which is exactly why the id check missed it, so the sentence says what it does know.

### Two things checked afterwards, and one of them is a limit on the clause

**The clause assumes the suite is deterministic, and that assumption is now explicit.** `passed_after >=
passed_before` compares two counts taken minutes apart; on a flaky suite it produces false refusals, and
— worse in the direction this ADR cares about — a `+n` flake can mask a `-1` breakage. The evidence says
the two real projects are stable: project-b's suite was measured at `8795/8788` three times in the
project directory and three times in a sandbox during Phase 11's hypothesis testing, and Phase 11b's
arm C ran project-a's suite 19 times in one sitting without a flake being reported. So the clause is
sound *here*. It is not sound in general, and a project whose suite drifts by ±n has a noise floor of n
on this check — which `regressed` did not have, because an id either passed or it did not. **Both
clauses are kept for that reason**; they fail in different directions and neither subsumes the other.

**Phase 11's own #2a numbers carry the same exposure and cannot be checked retroactively.** Its runs
were taken under the lenient gate too, and unlike Phase 11b the free check is unavailable: the run
directories under `.sidecrew/runs/` no longer exist, and `experiments/go-no-go-2a/results/partials/*.json`
carry the `FixResult` but not the baseline. `baseline-reference.json` is **not** a substitute — it is a
quiet-machine reference at one commit, its `tests_passed + tests_failed` does not equal `tests_ran`
(skipped tests), and using a reference in place of a run's own captured baseline is precisely the
substitution the reference exists to *detect*. So the honest statement for Phase 11 is that its rates
were measured under the gate as it stood, with no way to re-derive the stricter clause short of re-running
the arms. That is recorded rather than repaired.

## ADR-0068 addendum — implemented on `main`, 18 Sep 2026: observations compare comment text

**Status:** accepted · **option A** · amends ADR-0057, which is mine, and the Phase 11b session proposed
this rather than editing it — the right call, and the reasoning below is theirs.

`ObservationKind` gains `comment_text_changed`, fired when the multiset of trimmed comment lines gains
an entry and **nothing was removed** — a removal is the more specific finding, and two observations for
one edit would double-count it in any rate. Still non-gating: `changeSurvives` does not read it and the
refinement still asserts that, so survival stays comparable with every previous phase.

**Why this is worth more than its size.** ADR-0057 shipped a line delta and named this gap in its own
*"what is still not decided"*. Phase 11b then measured it, and the result is sharper than the prediction:
across 19 real tasks a local 7B produced **byte-identical output to Opus on 18**, and the single
divergence was rewording a doc comment to match a renamed symbol — **the exact blind spot**. All 19
verdicts reported `observations: []`. Phase 11 had seen the same worker do the same thing to the same
word, so it is a reproducible property of the model rather than an anecdote.

So the mechanism had **sensitivity 0/1 on the only case in its dataset**, aimed squarely at the one
behaviour it existed to catch. *A mechanism believed to cover a case it cannot see is worse than an
absent one* — which is ADR-0066's unfinished-guard shape in a different subsystem on the same afternoon,
and the generalisation worth carrying forward.

**What it still does not see, stated rather than implied:** comments are compared line-wise after
trimming, so a comment rewrapped across different boundaries with identical words does not register. And
nothing here judges whether a reword was *right* — on the measured case the rename arguably made the old
comment untrue, and Opus left stale documentation behind. That is the judgement a blind approval rate
exists for, and deliberately not the gate's.

## ADR-0069 — A baseline has a shelf life: a gate whose reference was captured on another day is comparing against a different world

**Status:** **accepted, option A** · proposed and decided by the owner 19 Sep 2026 · measured in Phase 11b arm D, project-b · implemented the same day, addendum below
**Third independent source of #2a false negatives**, after ADR-0066 (memory pressure) and the still
undiagnosed case in `experiments/status-quo/README.md` O8.

### The measurement

Arm D, project-b, `rename-11`. The candidate is **byte-identical to the one arm C ran**, and arm C's
attempt survived. Arm D's failed at `tests` with exactly one regression.

| | |
|---|---|
| baseline captured | **2026-09-18 23:26:01** |
| the failing candidate verified | **2026-09-19 00:03:17** |
| arm C's attempt on identical bytes | 2026-09-18 22:55:21 — **survived** |
| machine at the time | pressure 1, 16–18 GB free, swap flat at 1.5 GB all run |
| the single regressed test | `…ViewTrackedTodayDrawerForm…` |

The machine was pristine, so this is not ADR-0066. The regressed test's own name contains the word
that explains it: it asserts on what was tracked **today**. The baseline's "today" was the 18th; the
candidate's was the 19th. **The run crossed midnight and the reference stopped describing the same
world.**

### Why this is its own defect and not a flaky test

A flaky test fails at some rate independent of when it runs. This one fails **iff** the baseline and
the candidate fall on different calendar days, which makes it perfectly predictable and perfectly
invisible:

- every #2a run captures its baseline once per step and then verifies candidates for hours;
- at 250–270 s per candidate, a 19-task run takes ~90 minutes, so **any run starting after ~22:30
  crosses midnight**;
- nothing in `ChangeVerdict` records when the baseline was taken, so a reader cannot tell.

It generalises past midnight. Any test that pins to a date, a week number, a month boundary, a
quarter, a fiscal period or a timezone transition has the same exposure, and the wider the gap between
baseline capture and candidate verification, the larger it gets. Unattended mode makes long runs
ordinary, which makes this more likely rather than less.

### What it costs

The same thing ADR-0066 costs, and it compounds with it: **a survival rate that is a lower bound of
unknown tightness.** A rejected candidate is expensive (262 s of gate, plus a retry) and, worse,
indistinguishable in the artefact from a real regression. Here the retry does not help either: a
retry minutes later is still on the wrong side of midnight, so the mechanical retry that rescues a
memory false negative **cannot rescue this one**.

### Options

- **A — record `captured_at` on the verdict, alongside the baseline's own timestamp.** Both already
  exist (`baselines/*.json` carries `captured_at`); the verdict does not repeat them, so the gap is
  not visible where the verdict is read. Cheapest, changes no decision, and makes the condition
  detectable after the fact — the same shape as ADR-0066's recommended option C.
- **B — refuse a verdict whose baseline is older than a threshold**, and re-capture. Correct and
  expensive: re-capturing project-b's baseline costs ~250 s, and doing it per step is already the
  design. A threshold of "same calendar day" is crude; "older than N hours" needs a number nobody has.
- **C — re-capture the baseline at every step boundary regardless.** Already the behaviour; it does not
  help, because a single step of 12 tasks is itself ~55 minutes.
- **D — freeze the clock for the suite** (`TZ`, a fixed fake timer). Removes the class entirely and is
  the only option that does, but it changes what the project's own suite measures, which is exactly
  the thing ADR-0046 says the #2a sandbox must not do.

**Recommendation: A now, and treat B as needing a measurement first.** The pattern is the one this
phase keeps arriving at — *record before you gate*, because the threshold cannot be chosen from data
nobody has collected. Option A also makes B's threshold derivable later: with `captured_at` on every
verdict, the correlation between baseline age and `tests`-stage failures is a query rather than a study.

### Consequence for Phase 11b's numbers

Arm D's `rename-11` on project-b is a **false negative** and is reported as such. It is excluded from
no denominator automatically — ADR-0066's discipline applies unchanged: the verdict cannot tell you,
so the exclusion is an analyst's judgement made in the open, with the evidence above, rather than a
rule the gate applied silently.

### Confirmation, 19 Sep 2026 00:12 — the test fails on unmodified code, and the run was invalidated

The hypothesis above was drawn from timestamps. It is now confirmed directly: running that one spec
file against the **unmodified project**, with no candidate applied and nothing from any arm involved:

```
Tests: 1 failed, 28 passed, 29 total
```

The failing case is the same one. So the test's outcome is a function of the wall clock and nothing
else, and the baseline captured at 23:26 on the 18th recorded it as passing.

**The consequence is worse than one lost task.** Once the date rolled over, *every* candidate verified
afterwards inherited that one regression, so `rename-12` failed for the same reason immediately after
`rename-11`, and every remaining task in the run would have done the same. **A single date-dependent
test converts a stale baseline into a total run failure**, not a sampling of them — which is why this
is an ADR rather than a footnote about flakiness.

Arm D on project-b was therefore **stopped at 10 of 19 and restarted with a baseline captured on the
new day**, rather than resumed. Resuming would have kept the two poisoned verdicts, and the rule
established under ADR-0066 holds here for the same reason: a run discarded for environmental reasons
is restarted, never resumed, because a false negative is perfectly terminal.

The first ten tasks ran before midnight against a same-day baseline and were internally valid; they
are discarded anyway, because an arm assembled from two baselines is two experiments.

**This also sharpens option B above.** "Refuse a verdict whose baseline is older than N hours" is the
wrong shape. The failure is not gradual with age — it is a step function at whatever boundary the
project's tests happen to encode, and midnight is merely the most common one. The check that actually
works is **"the baseline and the verdict fall on the same calendar day in the suite's timezone"**,
with the recorded `captured_at` making any other boundary detectable after the fact.

## ADR-0066 addendum — a third disagreement, and the first with pressure ruled out (21 Sep 2026)

ADR-0077's counterfactual produced one, incidentally and outside the corpus `D` was measured on.
`snc-27`: **82 regressions on the first reading, 0 on a second reading of the same bytes**, an hour
apart, against baselines reproducing each other exactly (6159/6368 passing, 11,412 `tsc` errors).

**The machine bracketed both verdicts and was quiet for both** — `pressure: normal`, swap flat at
0.016 GB, free 25–26 GB, before and after. This ADR's own case was a swapping machine and `D = 2/19`
was measured where pressure was the assumed explanation. **Here it is excluded.** The mechanism is
therefore not established, and the honest position is that it is unknown rather than known-and-fixed.

Not folded into `D`: different corpus, different rule. Recorded because it is the first of these three
with telemetry on both sides, and because ADR-0077's option B would move the gate's weight *onto* the
clause that did this.

## ADR-0066 and ADR-0069 addendum — decided together and implemented on `main`, 19 Sep 2026

**Decided in one sitting, on purpose.** The two are the same shape — *record, don't gate* — and taking
them apart would have meant writing the verdict's provenance twice. The owner took **ADR-0066 option
C** and **ADR-0069 option A**. Two of the three known sources of #2a false negatives are now
**detectable in the artefact** rather than merely suspected; the third
(`experiments/status-quo/README.md` O8) is still undiagnosed and is the reason the gate's own error
rate is being measured directly rather than argued about.

### What landed

`ChangeVerdict` gained three fields, and `changeSurvives` reads none of them:

| field | ADR | what it answers |
|---|---|---|
| `baseline_captured_at` | 0069 | how old the reference this verdict was judged against is |
| `verified_at` | 0069 | the other end of that gap |
| `machine` | 0066 | `{ pressure, free_gb, swap_gb, compressed_gb }` **before and after** the gate |

With `crossesCalendarDay` and `swapGrowthGb` as the two readers, `readMachineState` in `doctor.ts` as
the instrument, and `sidecrew fix` warning **once per run** on the first verdict where the day boundary
has been crossed. It does not stop, which is the whole of option A.

### Three things that were decided in the implementing and are not in either ADR above

1. **`machine` is a pair of samples, not one.** ADR-0066's own amendment ruled out the pressure level
   as a threshold, and the quantity it named instead — *swap growth against the run's floor* — is a
   delta. One sample cannot express a delta, so recording one would have shipped a field that cannot
   answer the question the field exists for. `before` is taken before any sandbox work and `after`
   once the suite has finished, because ADR-0011's argument is that **the workload creates the
   condition after the check has passed**: a sample taken only at the start records the machine the
   gate was about to ruin.

2. **The null is one sentence, not two.** All three fields are nullable with a default, because
   `--resume` and every analysis script read verdicts written before Phase 12 — and that is what null
   means: *this verdict predates the field*. A machine that could not be asked, a non-macOS host or a
   missing `sysctl`, is a **present** `machine` whose members are null. The refusal path records a
   sample rather than null for exactly this reason, even though a refusal brackets nothing: leaving it
   null there would have given the same value a second meaning, and a field with two meanings is one
   nobody can query.

3. **The day comparison is local, and that is a limitation worth naming.** The baseline and the
   candidate run on the same machine in the same environment, so the suite's *today* is this process's
   today. A project that pins `TZ` itself is the case `crossesCalendarDay` cannot see — and the
   recorded timestamps are precisely what make that findable afterwards, which is the argument for
   option A restated at one level down.

### What this does not do, stated so nobody reads more into it than is there

**No rate changes and no verdict changes.** That is the point of both options and it is the reason they
could be taken before the measurements rather than after: a field that gates nothing cannot bias a
number, so implementing it mid-programme is not the thing §4 forbids. Every survival rate in this
repository remains a lower bound of unknown tightness. What is different is that the tightness is now a
**query over a corpus of verdicts** rather than a study somebody has to design — which is also how
ADR-0066 option A finally gets its threshold, and ADR-0069 option B gets the number it was missing.

## ADR-0064 addendum, 19 Sep 2026 — a second configuration property, measured while taking §2.1

**Evidence, not a decision.** The ADR above stays PROPOSED. This records a second, independent way a
project's *configuration* decides what workload #2a can address, found by the change planner while
producing §2.1's plan and worth having because it is the more common of the two.

**project-a's `tsconfig.json` declares neither `include` nor `exclude`**, so the program it describes
covers the **test** directory as well as `src/`. The gate's `compile_ok` requires zero `tsc` errors in
the task's own files *and none introduced anywhere else*, and a plan may never list a test file
(ADR-0046, ADR-0048 — the tests are the instrument).

Therefore, on such a project:

> **Any rename of a symbol that a test file references is unsatisfiable by construction.** The rename
> must be complete or it does not compile; completing it requires editing a file no plan may list; so
> the gate reports an error introduced outside the task's files, and no worker at any temperature can
> pass it.

Measured on one 12-task plan: **3 of 11 refusals** were this, and they were not marginal cases — one
was a genuine misspelling in a public identifier across 8 files, 4 of them tests.

**Why this belongs to ADR-0064 rather than to a new one.** It is the same sentence with a different
compiler flag: the addressable surface is whatever the project's configuration makes reachable.
`strictNullChecks` decides how much work *exists*; `include`/`exclude` decides how much of it a plan is
*allowed to touch*. A project can therefore have plenty of #2a work and very little addressable #2a
work, which is a distinction no survey of a codebase's contents would show.

**It also sharpens who #2a pays for**, in the same direction as the ADR's list: a project whose
tsconfig separates source from tests has a materially larger addressable surface than one whose
program covers both, and neither project has more or better code. Worth saying plainly before any
README quotes a survival rate as though it were a property of the tool.

**What it does not justify.** Not a relaxation of the test-file rule, and not a per-task `exclude`. The
tests are the gate; a workload that edits its own oracle is not this workload (ADR-0046). If anything
here becomes an action it is `doctor` answering the question before a plan is written, which is the
shape ADR-0032 set and where the other pre-flight questions already went.

## ADR-0070 — The tool-config rule refuses ordinary source in a dotted-name convention

**Status:** **accepted, option C** · owner's decision, 20 Sep 2026 · implemented the same day, addendum at the end of this file
**Bears on:** every plan written against a NestJS/Angular-style codebase · **evidence:** measured, below

### The measurement

Two tasks in §2.1's plan were written, validated **INVALID**, and dropped. Both were refused as
touching *"a tool config"*. Neither file is a tool config: both are ordinary application source, deep
in the source tree, in the dotted-name convention NestJS and Angular projects use throughout
(`foo.service.ts`, `foo.module.ts`, `foo.config.ts`).

The rule is one regex, deliberately duplicated in `src/fix-validate.ts` and `src/confinement.ts` so
that it has two implementations and no shared switch:

```
/^[\w.-]+\.(config|conf)\.[\w.]+$/
```

It matches on the *stem shape* and accepts **any** extension, so `src/<domain>/<domain>.config.ts`
matches exactly as `vitest.config.ts` does.

### Why the obvious fix is wrong, and this is the reason the ADR exists

The planner's own suggestion was to narrow the extension to config *formats* — `.json`, `.yaml`,
`.js`. **That would break the rule outright.** The configs that matter most here are written in
TypeScript: `vitest.config.ts`, `jest.config.ts`, `playwright.config.ts`, `stryker.config.js`,
`tailwind.config.ts`. Those are the gate's own configuration, and ADR-0048 says a worker may never
reach them. A narrowing by extension would admit precisely the files the rule exists to refuse.

**The direction of error is the whole decision, and it is the scrub's argument again** (ADR-0051): a
false positive **costs a task**; a false negative **lets a worker edit the gate's configuration**, and
a gate a candidate can reconfigure is not a gate. The current rule errs in the safe direction and any
replacement must keep erring that way.

### Options

- **A — match only at the project root.** A tool config lives at the root of the project it configures;
  `src/exception/exception.config.ts` does not. One comparison, no list to maintain, and it keeps every
  real tool config refused. Risk: a project that keeps configs in `config/` or `.config/` — add those
  two as known locations, or accept that such a file is refused, which is the safe direction.
- **B — require a known tool stem** (`vitest`, `jest`, `webpack`, `rollup`, `next`, `tailwind`,
  `babel`, `eslint`, `vite`, `playwright`, `cypress`, `stryker`, …). Precise, and it is a list somebody
  has to maintain — and a miss admits a real tool config, which is the dangerous direction. On its own,
  no.
- **C — A or B: root-located *or* a known tool stem.** Refuses everything A refuses, plus a tool config
  parked somewhere unusual. Strictly safer than either alone and still frees `src/**/*.config.ts`.
- **D — leave it.** Planners route around it, as this one did, and the cost is invisible: tasks that
  were never written down because the validator said no. That invisibility is the argument against D.

**Recommendation: C.** It keeps the safe direction of error intact, it needs no relaxation of anything
ADR-0048 decided, and the failure it removes is one a planner cannot diagnose from the message — the
validator says *"a tool config"* about a file that plainly is not one, which is the kind of message
that gets a rule quietly distrusted.

**Whatever is chosen, it lands in both copies in the same commit, with a test asserting the two agree.**
The duplication is deliberate (a rule with one implementation is a rule with one place to get it
wrong), and the failure mode of deliberate duplication is exactly one copy being fixed.

## ADR-0071 — `validateChangePlan` cannot see the task that is unsatisfiable *because of what it will change*

**Status:** **accepted, options A and D** · owner's decision, 20 Sep 2026 · implemented the same day, addendum at the end of this file
**Bears on:** every `#2a` plan on a project whose `tsc` program includes its tests · **evidence:** measured

### The measurement

§2.2's pass 1 ran 30 `null_guard` tasks on `project-a` under `--strictNullChecks`, against a plan the
validator reported **`valid`**. One survived.

Twenty-four of the fifty-nine attempts failed at `compile`. **Not one of them failed on its own file.**
Every one failed because some *other* file gained an error — and 22 of the 24 gained **exactly one
error in exactly the same file**: the project's app-wide e2e spec.

| | |
|---|---|
| errors in that spec at baseline | **165**, identical across three independent captures |
| errors in it after a candidate | **166** |
| project-wide total | 11,412 → **11,411** — the candidate *improved* it |
| distinct source files those 22 tasks edited | **22** |

Twenty-two unrelated edits do not each independently break one shared spec. A Nest e2e spec
bootstraps the whole application module, so it transitively imports nearly the entire source tree;
under `strictNullChecks` it already carries 165 errors, and narrowing a type almost anywhere surfaces
one more. The lone survivor edited a `src/common` file that spec does not reach.

### The defect

`compile_ok` is *zero errors in the task's own files **and** no file anywhere with more errors than
before* (ADR-0048). A plan may never list a test file, because the tests are the gate (ADR-0046). So:

> **When the project's `tsc` program includes an app-wide test, a task can be unsatisfiable purely
> because of the type change the ask requires — and no edit confined to the task's own files can
> avoid it.**

`validateChangePlan` refuses a task whose files carry a **pre-existing** error (ADR-0050 option C).
That is a property of the file *before* the change. This class is a property of what the change *does*,
which the validator never simulates, so it passes every one of them. The run then spends the full
gate on each — here 30 tasks for one survivor.

**It is the same sentence as ADR-0064's addendum, one step further on.** There, a rename was
unsatisfiable because completing it required editing a test file. Here nothing needs editing: merely
*changing a type* makes a file the plan may not touch report one more error. ADR-0064 is about the
addressable surface being a property of configuration; this is the sharpest instance of it.

### Why this is not an argument for relaxing the gate

`compile_ok`'s "nothing anywhere got worse" clause is what makes the gate **monotone**, and monotone
is what lets *"fix every TypeScript error in a large codebase"* converge over many tasks without any
one of them having to finish it (`docs/specs/pipeline.md`). Dropping it to "the project total went
down" would admit a change that fixes two errors and creates one, repeatedly, and nothing would
notice the drift. **The gate is right and the plan was wrong**, which is why this is an ADR about the
validator.

### Options

- **A — the validator reports the exposure, and gates nothing.** For each task, name the files that
  import it transitively and lie outside the plan, with their current error counts. Cheap — `tsc
  --listFiles` already runs — and it is *record, don't gate*, which is the pattern ADR-0066 and
  ADR-0069 both landed on and the one that has never yet been wrong here. A planner reading "this file
  is reachable from a spec carrying 165 errors" writes a different plan.
- **B — refuse the task.** Correct when the prediction is right and expensive when it is wrong: the
  survivor here would have been kept, but a task whose type change happens not to surface anything
  would be refused for a thing that would not have happened. Predicting a compiler's output without
  running the compiler is how the `deriveLineRange` special cases accumulated.
- **C — speculative pre-flight**: apply nothing, but re-run `tsc` once per task with the file's exports
  widened. Accurate and absurd — one full type-check per task before any worker runs, on a project
  where that is 15 s and the whole point was to spend gate time only on satisfiable work.
- **D — `doctor` answers it once per project**, before any plan is written: *"your tsconfig has no
  `include`/`exclude`, so your test files are in the program; the largest of them reaches N source
  files and carries M errors."* One answer per project rather than per task, in the shape ADR-0032 set
  for every other pre-flight question.

**Recommendation: A and D together.** A puts the fact on the task where a planner will see it; D puts
it in front of the user before a plan exists, which is where the three other pre-flight questions
already went. B stays available if A turns out to be ignored, and C is recorded only so nobody
proposes it later without its price attached.

### Consequence for §2.2, stated rather than applied

Twelve of §2.2's `n₂ = 29` are this class. They are **unsatisfiable by construction**, so a correction
cannot rescue them and `S_c` computed over all 29 is depressed by tasks no worker could ever pass.

**They are not excluded.** §4.0 precondition 4 forbids changing the task set after seeing failures,
and that is exactly what excluding them now would be. The run reports `S_c` over the declared `n₂`
**and** the breakdown by failure shape, so a reader can see both the number the frozen rule produces
and the number that means something. Which is the honest way round: the rule was frozen for a reason,
and the reason is that a denominator adjusted after the fact is a description of the adjustment.

## ADR-0072 — `ChangeVerdict.errors.message` quotes the wrong compiler output, and it is the one field a correction is written from

**Status:** **accepted, accepted in full** · owner's decision, 20 Sep 2026 · implemented the same day, addendum at the end of this file
**Implemented 20 Sep 2026**, once §2.2 had reported — see *Why this is not being fixed tonight*, which is why it waited.

### The measurement

`errors.message` is documented as *"The compiler's own words, truncated. What a correction quotes
(ADR-0044 §4 rule 1)"*, and ADR-0047 §3 claims the whole verdict was **designed for a reader who
arrives two phases later**. §2.2 is the first time that reader existed. It does not pass.

`verifyChange` sets `errorMessage = truncateError(tsc.message)`, and `tsc.message` is the **entire
project's** diagnostics with the file list stripped. `truncateError` then cuts it at 2,048 characters.
On a project with 11,412 errors the result is the alphabetically-first 2 KB.

Checked on three of the twelve compile failures, independently of the corrector's report:

| task | its own file | does `errors.message` mention that file? |
|---|---|---|
| snc-02 | `src/common/…util.ts` | **no** |
| snc-06 | `src/interceptor/…interceptor.ts` | **no** |
| snc-13 | `src/modules/api/…controller.ts` | **no** |

All three carry a byte-identical 2,048-character excerpt, every line of which is about an unrelated
`src/cba/…` file, cut mid-token. It mentions neither the task's own file nor the file that *gained* an
error — the two things a correction has to be specific about.

The corrector, which could see the briefs and nothing else, reported this unprompted: *"the one field
that was supposed to let me be specific about what the compiler objected to told me nothing about any
of these 29 tasks."* It also reported the consequence — that its notes for the six pure-compile
failures had to say *"the file you were given"*, which is exactly the generic phrasing a correction
round exists to avoid.

### Why it was invisible until now

On a project whose compiler is quiet, `tsc.message` **is** the relevant output: a handful of errors,
all of them the task's. The field is correct whenever the project has few errors and wrong in
proportion to how many it has — so it degrades precisely as a project becomes a better candidate for
workload #2a (ADR-0064), and it has never been read by the reader it was designed for until tonight.

**Same shape as the truncation bug found four hours earlier**, where `tsc --listFiles` fell off the end
of a 1 MB buffer: both are "a field that is fine on a small project and silently useless on a large
one", and both were found by pointing the tool at a real codebase with the strictness turned up.

### The fix, which already exists in the codebase

`diagnosticsFor(diagnostics, files)` in `fix.ts` filters a diagnostics blob to the lines about a given
set of files — it is what shows the **worker** the diagnostics for its own task, and it is right there.
The verdict should carry the same thing, over the union of *the task's files* and *the files that
gained errors*. No new mechanism, no new field, and rule 1 is untouched: this is still the gate's
extract, not the candidate's diff.

### Why this is not being fixed tonight

**§2.2 is mid-flight and this is the field its mechanism reads.** Fixing it now would change what a
correction is written from, after seeing that the corrections were thin — which is the shape
`experiments/correction-round/README.md` §4.0 forbids and the same line ADR-0066 drew: *the
environment is mine to fix during a run; the gate is not.*

So §2.2's result stands on the code that produced it, and it is reported with this defect named as a
**stated confound**: the 12 compile-shape corrections were written from a brief carrying no relevant
compiler output, and whatever `S_c` those produce is a floor rather than a measurement of the
mechanism working properly. The 17 `no_edit_at_all` corrections are unaffected — their briefs name the
file and the rule, and the corrector said so.

### Consequence for ADR-0047 §3

ADR-0047 §3's claim was that the verdict is designed for a reader two phases later. That claim was
untested for two phases. **On its first test, one of its four evidence fields was unusable and the
reader said so without being asked.** Worth recording plainly: the design was right in shape and wrong
in one detail, and the detail only shows up at a scale nothing else in this repository had reached.

## ADR-0073 — sidecrew is a 24 GB+ tool; the `api` tier stops being a tier

**Status:** **accepted** · owner's decision, 20 Sep 2026 · **narrows ADR-0009 and ADR-0045**, and puts
ADR-0059 – ADR-0061 behind an opt-in · ADR-0062's fix is untouched

### The decision, in the owner's terms

> We don't want the api tier. We support 24 GB+ RAM laptops.

So: **installed RAM below 24 GB is refused, with a reason.** Nothing selects a network worker by
looking at a machine's size any more.

### What changes

1. **`doctor` fails the `tier` row below 24 GB**, and the run paths refuse before spending anything —
   `assertSupportedMachine`, thrown as its own `UnsupportedMachineError` so a caller can tell an
   unsupported machine from a broken toolchain. The message carries ADR-0032's three parts: how much
   RAM this machine has, what the floor is, and why the floor exists.
2. **A key is no longer the question on a small machine.** Previously a 16 GB laptop with an
   `ANTHROPIC_API_KEY` set was quietly handed a tier whose survival, approval and dollar-per-task
   figures have never been measured. It is now refused *whether or not* it has one, which is the
   substance of the change rather than a detail of it.
3. **`SIDECREW_TIER=api` remains, as an unsupported escape hatch.** It works, it is tested, it bills
   the user's key, and `doctor` labels it *"api tier (unsupported, opted in)"*. It is never reached by
   default.
4. **Phase 13 §5 is cancelled** and Phase 13 leaves the publish path. The tier ships buildable,
   opt-in, and unpriced — which was already true, and is now said out loud instead of being a debt.

### What does **not** change, and this is the part worth reading

**`WorkerKind` keeps `"api"`.** The enum value does not mean "the Haiku tier"; it means *a model
reached over the network wrote this candidate*. Phase 11's C3 control and Phase 11b's arm D both
record it — **including the 19-candidate corpus the gate's own error rate was measured on three days
ago.** Removing the value would stop that corpus parsing and would retroactively invalidate `D`.

So the tier leaves the supported surface; the word stays in the contract. `tierFor` still describes
both rules for the same reason — recorded results must keep resolving.

The schema refinement that refuses *"an `api` run that produced outcomes and reports `workers: 0`"*
also stays. It is the other half of the local-tier zero-token guarantee, and it guards the escape
hatch and the experiment harnesses alike.

### Why refuse rather than warn

ADR-0009 measured that a 7B cannot sit beside a normal working set under 24 GB. The failure mode of
trying anyway is **swapping**, and ADR-0066 measured what swapping does to this gate: it manufactures
false negatives that are indistinguishable in the artefact from real defects. A warning would hand
that failure to precisely the users least equipped to recognise it.

### What it costs, stated plainly

**A 16 GB laptop can no longer run sidecrew**, and `VISION.md` previously called that disqualifying —
*"a tool that cannot run on half the laptops is not one people can use"*. That sentence is now wrong
about this tool and has been removed rather than quietly softened. The honest replacement is a
**stated hardware requirement**, which is an ordinary thing for a tool that hosts a 7B to have, and a
far better position than an unmeasured second product hiding behind a RAM check.

The alternative considered and rejected was **measuring** the tier instead (Phase 13 §5, ~$0.25 of
credits). It was rejected on scope rather than cost: a second tier is a second set of numbers, a
second worker to keep pinned, and a second thing every future measurement has to be reported per. One
supported configuration is a smaller and more defensible product.

## ADR-0070, ADR-0071 and ADR-0072 addendum — decided and implemented on `main`, 20 Sep 2026

The owner took **ADR-0070 option C**, **ADR-0071 option A** (with D left as later work), and ADR-0072
in full. All three landed together with 707 fast tests green.

### ADR-0070 — `isToolConfig`, one predicate, two gates

A tool config is now one **at the project root** *or* one whose stem names a known tool. The shape
alone was reaching into the source tree and refusing `src/<domain>/<domain>.config.ts`.

**The rule stays duplicated and the predicate does not**, which is the distinction worth keeping.
ADR-0048 says the confinement rules must not be switchable from a plan, so `confinement.ts` and
`fix-validate.ts` keep their own copies of the *rule*. But *"is this filename a tool config"* is a
fact about a string, and two answers to it would be a bug rather than a safeguard. The tests pin both
directions: every real TypeScript tool config still refused, and a root-level `app.config.ts` still
refused too — eager at the root is the safe direction, and it may cost a task but cannot cost the gate.

### ADR-0071 — the validator reports the exposure and gates nothing

`validateChangePlan` now warns when the `tsc` program contains test files that already carry errors,
naming how many, the worst offender, and the mechanism: a plan may never list a test file, and
`compile_ok` fails if any file anywhere gains one, so a task can be unsatisfiable purely because of
the type change its ask requires.

**It warns rather than refuses, and the run that motivated it is the argument.** Of the 30 tasks, one
survived — and a rule that predicted the compiler's output without running the compiler would have
refused that one too. Option D (`doctor` answering once per project, before a plan exists) is not
built and stays open; the warning is where a planner will actually meet it.

### ADR-0072 — `relevantDiagnostics`

The verdict now carries the compiler's words about **the task's own files and the files that just
gained an error**, in the compiler's own order, with each diagnostic's indented continuation lines
kept — TS2345's second line is where the reason lives. It falls back to the whole message when it can
attribute none of it, because an empty `message` reads as *"the compiler said nothing"*, which is the
opposite of what a failed compile stage means.

**One thing that cannot be repaired.** The verdicts already on disk were truncated to 2 KB *before*
being stored, so the information the filter needs was discarded at write time. §2.2's twelve
compile-shape corrections were written from the degraded field and that remains a stated confound of
`S_c = 0/29`; it is not retroactively fixable, and re-running §2.2 on the fixed field would be a new
measurement rather than a correction of that one.

## ADR-0074 — O8 is undiagnosable from the artefacts, because the field that would explain it is 2 KB of console noise

**Status:** **accepted** · 20 Sep 2026 · found while attempting the O8 diagnostic the owner asked for
· ADR-0072's twin, in the tests field · implemented the same day

### What the diagnostic attempt found

O8 — the undiagnosed third source of #2a false negatives — has one known signature: **every verdict on
disk that records a regression has all of its regressed tests inside exactly one suite file.** Six for
six, across two orders of magnitude of count. That points at a *suite-level* failure rather than a
test-level one, which would be diagnosable from the runner's own output.

It is not, and here is why:

| case | regressions are in | does `tests.message` name that suite? |
|---|---|---|
| ADR-0066's 155, under swap | `…/workorder.service.spec.ts` | **no** |
| 12, on a quiet machine | `…/user.service.spec.ts` | **no** |

Both messages are exactly **2,048 characters** — `truncateError`'s ceiling — and both are dominated by
one unrelated suite's `console.log` output. `suite.message` is the *whole run's* output, and on a
352-suite project its first 2 KB is whatever printed first.

> **The verdict cannot say why a suite failed, so nobody can diagnose O8 from the run directories.**
> Not a hard question, a missing field.

### Decision

`relevantSuiteOutput` keeps the per-suite blocks belonging to the suites that actually regressed, and
drops the rest. Jest prints `FAIL <path>` / `PASS <path>` headers, so the blocks are recoverable;
console output *inside* a kept block is kept, because it is often the reason. It falls back to the
whole message when it recognises no block, for the same reason `relevantDiagnostics` does: an empty
message reads as *"the runner said nothing"*, which is the opposite of what a failing suite means.

### Why this is the same defect as ADR-0072 and worth saying so

Both are *a field that is fine on a small project and silently useless on a large one*, and both
degrade precisely as a project becomes a better workload-#2a candidate (ADR-0064). ADR-0072 was found
by a corrector that said so unprompted; this one was found by going looking for a diagnosis and
discovering the evidence had been discarded at write time. **Four defects of this shape have now been
found in eight days** — the 1 MB `run` cap that truncated `tsc --listFiles`, ADR-0072, this, and the
`compile_ok` blind spot of ADR-0071. It is worth treating as a class rather than as four incidents:
**anything this tool truncates for display, it also truncates for diagnosis.**

### What it does not do

**It does not diagnose O8**, and it cannot retroactively: the verdicts on disk were truncated before
being written, so the evidence for the six known cases is gone. What changes is that **the next
occurrence is diagnosable.** Catching one is now a matter of running the gate until it disagrees with
itself again — which, at `D ≈ 0.105`, is about ten candidates.

## ADR-0054 addendum — accepted and implemented, 20 Sep 2026: the gate judges intent, not only behaviour

The owner's decision, in their words:

> **"The gate must care about the reason behind doing a work even if it's not documented on the
> disc."**

That is option A, extended by what ADR-0068 had already built. `documentation_changed` is now the
**eighth confinement rule**: documentation removed, or reworded at constant volume, that the ask did
not call for. A `dead_code` ask is exempt — removing code that nothing reaches removes the comments
explaining it, and a *"remove the stale comments"* ask is already that shape, so option A's feared
"needs its own budget field" turned out not to be needed.

**Whitespace stays an observation and still does not gate.** The decision is about documentation.
Killing a correct change over a blank line is exactly the false-positive cost option C warned of, and
nothing measured argues for it.

### What this changes about the gate, stated plainly because it is a non-negotiable

CLAUDE.md #2 makes the gate an iff, and that iff now has one more clause in it: `confined` requires
no unrequested documentation change, so `changeSurvives` does too.

> **A survival rate taken before 20 Sep 2026 and one taken after are not comparable.**

Phase 11's, 11b's and 12's numbers were measured on the seven-rule gate. They stay valid for what
they measured and they are not re-runnable against the current one. Any future rate says which gate
it was taken on. This is the cost of the decision and it is the owner's to pay — the alternative was
a headline claim of *"the same quality Opus would produce"* while the only measured quality gap
between a 7B and a frontier model went unblocked.

### What it is worth, and the honest size of the evidence

The behaviour behind it is **3 of 13 sampled survivors across two inputs, against 0 of 13 for the
control** — and it was the *only* thing separating the local tier from a frontier model in all of
Phase 11. That is a small denominator to add a gate rule on, which the original ADR said and which
stays true. What tipped it is not the count: it is that a prompt forbidding it in English is worth
nothing, because a worker optimises against the constraint rather than the request (ADR-0006), and
the thing being deleted on the fixture was the comment documenting the trap the task was about.

**What it still cannot see**, unchanged from the original: a comment rewrapped across different line
boundaries with identical words, and whether a reword was *right*. The second is a judgement for a
reviewer and explicitly not for the gate.

## ADR-0075 — The whole-file return format, not the model, caps the addressable surface at about half a codebase

**Status:** **accepted — option C**, 20 Sep 2026, by the owner · measured the same day it was asked · unblocks Phase 14c
**Bears on:** the *"anything Opus does"* goal, ADR-0047 §2, and Phase 14's AST item

### The question

> *"How do we perform on large files? 1000+ line files? Considering our local 7B models don't have a
> huge context window — won't they corrupt the file?"*

### They do not corrupt it. Three things stop that, and one of them is measured

1. **The validator refuses the task before a worker sees it.** `files_too_large_to_rewrite`:
   `rewriteCost(sources) > MAX_FIX_TOKENS` is an error, not a warning, so the plan does not validate.
2. **If a model truncates anyway, the candidate says so.** `ChangeCandidate.truncated` is on the
   contract and the gate treats it as a problem; a cut-off file cannot be scored as a survivor.
3. **Measured: 0 truncated and 0 unparsed across 59 candidates** in §2.2, on files up to 18.9 KB.

So the failure mode the question feared is closed. **The real cost is worse in a way that is easier
to miss, because nothing fails.**

### What it actually costs, measured on project-a

| | |
|---|---|
| TypeScript files under `src/` | **2,160** |
| over the ~22,674-character whole-file ceiling | **71 — 3.3 %** |
| files of **1000+ lines** | **52**, and **every one** is over the ceiling |
| **share of the codebase those 71 files are, by bytes** | **48.1 %** |

**Three percent of the files are half the code.** And the work concentrates there: the Phase 12
planner, surveying independently, reported that project-a's misspelled identifiers live in service
files of 30–145 KB — *"1,975 of 2,042 files are individually under it; the ones carrying the work are
not."*

> **Roughly half of a real codebase is unaddressable, and it is the half where the work is.** That is
> a property of the **return format**, not of the model's ability, and no amount of better weights
> moves it.

### Why this matters against the 90 % goal

The owner's bar is *"anything Opus does… even 90 % is a win."* Opus edits a 4,000-line file without
thinking about it. Today sidecrew declines, correctly and loudly. So the ceiling — not the 7B's
reasoning — is the first binding constraint on that number, and it binds at roughly 50 % by volume
before model quality is even reached.

### Options

- **A — keep whole-file and accept the ceiling.** Honest, zero work, and caps the product at about
  half a codebase. It is also the status quo, so it is what ships if nothing is decided.
- **B — unified-diff hunks.** ADR-0047 §2 rejected this and the reasons still hold: a 7B emitting
  correct `@@` headers against code it is reading for the first time fails in a way that says nothing
  about whether it understood the change, and it adds a whole stage — *the patch did not apply* — for
  a verdict to represent. **No.**
- **C — symbol-scoped return.** The task names a declaration; the worker returns **that declaration's
  new text** and nothing else; sidecrew splices it back by AST range. The model never writes a line
  number, so B's failure mode does not exist. Confinement stays decidable before a byte is written
  (it is still a pure function of the task's sources and the answer). The bound becomes the *symbol*,
  not the file — a 60-line method inside a 4,000-line service is suddenly in reach.
- **D — a larger-context local model.** Moves the ceiling without removing it, costs memory the gate
  needs (CLAUDE.md #5), and Phase 6 measured the 14B matching the 7B on TypeScript while costing 2.2×
  the generation time.

**Decision: C**, taken by the owner on 20 Sep 2026 on the recommendation below. **Phase 14c is
unblocked.** A, B and D are rejected for the reasons given above; B's rejection also carries ADR-0047
§2's, which is independent and still holds.

**Recommendation: C.** It is the only option that changes the *shape* of the limit rather than its
size, and it makes an item already owed load-bearing: **C needs `deriveLineRange` to read the
TypeScript AST**, which is Phase 14's DoD item and has been patched four times as a regex with *"no
mutants at all"* wrong every time anybody checked. That item stops being hardening and becomes the
enabler for the biggest single capability gain available.

**What C does not fix**, said now: a change that genuinely spans a whole file — a wide rename inside a
145 KB service — is still out of reach, because the *answer* is large however it is framed. C moves
the boundary from *"the file is big"* to *"the change is big"*, which is the right boundary and not
the absence of one.

---

## ADR-0076 — `deriveLineRange` asks the compiler, and says which of the two answered

**Status:** accepted · 20 Sep 2026 · Phase 14 · implemented on `main`

### Context

The range finder has been patched four times — ADR-0030, ADR-0033 #4, ADR-0035, ADR-0039 — and every
one of those patches was found the same way: a probe printed `NOT PLANNABLE — no mutants at all` about
a function whose hand-written range kills mutants. The sentence has been checked four times and been
wrong four times, which is not a run of bad luck; it is what a regular expression over a masked string
is for a grammar that is not regular.

Phase 14 owed this fix as hardening. ADR-0075 made it load-bearing: **option C splices a symbol's new
text back by AST range**, so the reach of workload #2a is bounded by what this function can find.

**The size of the defect, measured rather than argued.** Corpus: this repository's own `src`, 34 files.
Names were enumerated from the compiler's tree and both implementations were then asked for a range.

| | |
|---|---|
| function declarations found | **436** |
| the scanner **could not see** | **152 — 34.9 %** |
| the scanner returned a **wrong range** | **5** |
| agreed | 279 — 64.0 % |

A miss costs a function nobody plans, silently. A wrong range is worse: all five were bodies **cut
short**, so mutation ran over part of a function and the report said nothing. One of them is
`tsTargetFor` in `src/plan.ts`, 12 lines reported as 6 — and reducing it gave the diagnosis the four
previous patches never had: a concise arrow has no closing brace to match, so the scanner ends it at
the first `;` or blank line, and **`mask` blanks a comment to spaces**, which that search cannot tell
from a blank line. Every commented concise arrow in the corpus ends at its first comment. No fifth
pattern would have found that; the fourth three did not.

### Decision

1. **`lineRangeOf` asks the TypeScript compiler first** (`src/verifier/ast.ts`), matching function
   declarations, methods, class properties, object-literal members and `const` arrows — **and refusing
   a declaration with no body**, so an overload signature or a `declare function` is no longer mistaken
   for the thing that has lines in it.
2. **`typescript` is loaded out of the project being verified**, the way `mlx_lm`, `stryker` and `tsc`
   already are — `createRequire`, resolution not a path check, so a hoisted workspace is right. It does
   **not** become a dependency of sidecrew: CLAUDE.md § *Shape* allows one, and every project this tool
   can verify already has the compiler, because the gate shells out to `tsc` and to Stryker's
   `typescript-checker`.
3. **The scanner stays, as the fallback**, and keeps its own tests asserted against it by name rather
   than against whichever engine is reachable. A machine without the compiler gets the old behaviour,
   which is worse and is not nothing.
4. **Which one answered is part of the answer.** `lineRangeOf` returns `via: "ast" | "scanner" | null`.
   `deriveLineRange` is unchanged for callers that only want the range.
5. **`doctor` asks the question before a run**, because a project where the compiler is unreachable
   gets the 34.9 % miss rate and has no other way to find out.

### Why not make `typescript` a dependency

It would guarantee one behaviour everywhere, which is the honest argument for it, and this repository
has been burned by exactly that class of divergence. Against it: a second runtime dependency for a tool
whose shape rule is one, ~22 MB in every install including a Swift-only one, and — the deciding
reason — **the project's own compiler is the more correct one to ask**, because it is the version that
will parse the same file at the gate. Decision 5 is what keeps the divergence from being silent.

### What this does not fix

Swift. There is no compiler API to ask from Node, so `swift` is always the scanner. That is a stated
limit rather than a silence, and the Swift pattern has never been one of the four that was wrong.

### One thing it cost, recorded because the failure was silent

`doctor` had to ask two questions that live in `plan.ts` and `verifier/ts.ts`, and importing either
from `doctor.ts` closed a cycle — `concurrency → serve → doctor → plan → verifier/ts → concurrency`.
Under ESM that does not throw. It makes `DEFAULT_STRYKER_CONCURRENCY` **`undefined`**, and the only
thing that noticed was one assertion in `test/concurrency.test.ts` whose whole point is that the
verifier's default and the run's default are one constant rather than two. The fix was to move
`testDirFor` and `jestConfigEntry` down to `verifier/shared.ts`, which has no imports of ours at all,
and re-export them from where they used to live.

Worth writing down twice over: a cycle here is a **wrong number**, not a crash, and the test that
caught it was written for a different reason entirely.

## ADR-0077 — `null_guard` under a strictness flag is unpassable by construction, and gets more so as the worker improves (PROPOSED)

**Status:** **option D accepted 20 Sep 2026 and MEASURED 21 Sep — 14/15, see the section below** ·
Phase 14b · A is retired by that number, C more firmly; **B is recommended and needs the owner** ·
originally: A, B and C remain open and are deliberately not decided — D is the decision to *measure before choosing*, and it is the whole of
what was agreed. Phase 14b's own verdict — `PROCEED to 14c` — does not depend on any of them.

**What D commits to, so a later session does not widen it.** One run: re-gate probe 1's **15
clean-target tasks** — those whose target file compiled clean and whose only introduced errors were in
test files — with test-file *type* errors demoted to observations, and count how many survive the
project's suite. The candidates are already on disk from probe 1, so **no worker and no generation is
needed**; this is a replay of the verify stage, and its cost is the suite.

**Two constraints on how it is run, both load-bearing.** `changeSurvives` is **not** modified: the
production gate is what ADR-0046 and ADR-0048 made it, and a measurement that edits the gate to get a
better number is the thing this whole project is built against. The counterfactual is computed by a
harness applying its own rule to a replayed verify, and the result is reported as a **counterfactual**
rather than as a survival rate. And its denominator is **15, stated with the 30** — it is a
conditional number about a subset chosen after seeing failures, which is exactly the adjustment
§4.0 precondition 4 forbids doing silently.

### Context

Phase 14b asked whether the 7B's `1/30` on `null_guard` work was a capability ceiling or a fixable gap.
Two probes, both on §2.2's same 30 declared tasks, under `--strictNullChecks` (ADR-0063).

| arm | declined to edit | **target fixed correctly** | unsatisfiable (ADR-0071) | survived |
|---|---|---|---|---|
| pass 1 — 7B, whole-file ask | 17 | **8** | 12 | 1 |
| probe 2 — 7B, ask narrowed to one function | 10 | **14** | 18 | 1 |
| probe 1 — 14B, whole-file ask | 3 | **17** | 21 | **2** |

`S₁₄ = 2/30 = 0.067`, 95 % `[0.008, 0.221]`, best of the two probes.

**The answer is neither of the two the phase expected.** The workers are not failing to do the work.
Against pass 1, probe 2 fixed **+6** more target files correctly and gained **+6** unsatisfiable tasks;
probe 1 fixed **+9** and gained **+9**. The relationship is one to one in both arms: *every additional
target a worker gets right becomes an unsatisfiable task rather than a survivor.*

**The mechanism, read off `ChangeVerdict.errors.introduced` rather than inferred.** Of probe 1's 21
unsatisfiable tasks, the errors that sink them land in a **test file in 21 cases out of 21**, and in a
**non-test source file in 0**. Adding the null guard `--strictNullChecks` demands narrows a type; the
narrowed type propagates into fixtures and mocks; the gate forbids editing test files, because tests
**are** the gate (ADR-0046, ADR-0048). There is no legal edit that passes, whatever writes it.

**The direction is the part worth deciding about.** Unsatisfiable rises with capability — 12 → 18 → 21
— because a file nobody edits cannot break anything downstream. A better worker does not score better;
it converts *declines* into *impossibilities*. Any future investment in worker capability on this
shape, including 14b′ had it triggered, would have bought nothing measurable.

### The decision this forces

Phase 14b's frozen rule says `S₁₄ < 0.10` → write the ceiling down as a **product fact**, and
`README` says which shapes sidecrew is *for*. That is being done. But "the ceiling" is now known to be
**the gate's scope, not the model**, and the honest product fact depends on which of these is true.

**A — Say it and stop.** `null_guard` driven by a strictness flag is out of scope; `README` lists the
shapes that work. **For:** truthful today, costs nothing, and the 90 % bar already rests on Reach +
Cost. **Against:** it writes off a shape the workers demonstrably *can* do, on a project where 763
files carry such an error.

**B — Let a plan declare the test files a change may disturb**, gated on those tests still *passing*
rather than still *type-checking*. **For:** matches what a human reviewer would accept — a fixture
whose mock now needs a `| null` is not a regression. **Against:** it weakens the strongest thing the
gate says, and ADR-0046 chose "the project's tests, untouched" deliberately. Needs its own proof that
it cannot be gamed.

**C — Pre-filter the pool.** Add "no test file references this file's type surface" to the selection
rules, so unsatisfiable tasks are never planned. **For:** cheap, mechanical, and honest about what is
addressable — it is ADR-0064's shape, a property of the *configuration*. **Against:** on this project
it removes most of the pool, and a tool that only accepts work nobody depends on is a smaller tool
than the vision describes. It also makes the funnel look better by declining the hard cases, which is
the failure mode §4.5 warns about.

**D — Measure before choosing.** The counterfactual this phase could not run: re-gate probe 1's 15
clean-target tasks with test-file *type* errors demoted to observations, and see how many survive the
suite. **For:** B and C are both bets on an unmeasured number, and this is one short run. **Against:**
it is another evening, and 14c is already blocked on ADR-0075.

**Recommendation: D then B.** The counterfactual is cheap and it is the only thing that separates
"the gate is mis-scoped" from "these changes really do break the tests". **15 of 30 tasks reached a
clean target and would have reached the suite** under a differently scoped gate; whether they survive
it is the number nobody has, and every argument for B assumes it.

### Consequences if nothing is decided

Phase 14b still reports `PROCEED to 14c` and 14c is unaffected — its subject is *reach*, and reach is
ADR-0075's. What lapses is the Shapes row: it would record `null_guard` as "the worker can do it, the
gate cannot credit it", which is accurate and is not a state to leave a scorecard in indefinitely.

---

### Option D, measured — 21 Sep 2026

**14 of 15, and all 15 reached the suite.** `experiments/editing-ceiling/results/adr-0077-counterfactual-2026-09-21.json`.

| | k/n | 95 % exact | |
|---|---|---|---|
| this counterfactual | **14/15** | **[0.681, 0.998]** | clean-target tasks, test-file type errors demoted |
| `S₁₄`, the rule's number | 2/30 | [0.008, 0.221] | unchanged, and not recomputed |

**The intervals do not overlap**, which is what makes this an answer rather than a hint. The gate's
scope, not the worker, is what those 15 tasks died on — ADR-0077's reading, now with a number behind
it instead of an inference from the funnel.

**Every one of the 15 demoted exactly one error, and all 15 were in a test file** — re-measured from a
fresh `tsc` rather than read off the recorded verdicts, so it is an independent confirmation of the
*21 of 21* above and not a second reading of the same field.

**On the same 30, a B-shaped gate scores 16.** The 2 that survive today plus these 14; the other 14
tasks fail for reasons a test-file demotion does not touch — 4 left errors in the target, 3 returned
the file byte-identical, 6 were unsatisfiable *and* failed the target, all by the classifier's own
fields. `16/30 = 0.533`, 95 % `[0.343, 0.717]`. **This is a counterfactual and it is not `S₁₄`**;
Phase 14b's rule is applied to `2/30` and stays there.

### The one failure is the most useful thing in the run

`snc-27` failed the first reading with **82 regressions** and **passed a second reading of the same
bytes with 0**. Both against a baseline reproducing probe 1's exactly — 6159/6368 passing, 11,412 `tsc`
errors — and, this time, with the machine bracketed per verdict: **`pressure: normal`, swap flat at
0.016 GB, on both sides of both readings.**

**So this is a third measured instance of the gate disagreeing with itself, and the first where memory
pressure is ruled out rather than suspected.** `D = 2/19 = 0.105` came from a corpus where the
explanation was assumed to be pressure; ADR-0066's own case was a swapping machine. This one was not.
Whatever `D` is, it is not only that. Recorded here rather than folded into `D`, which is a different
corpus and a different rule.

**The counterfactual is reported as 14/15 — the failing reading — deliberately.** ADR-0066's finding
is that a verdict is not a pure function of its inputs; taking the better of two readings because it
is better is precisely the move that ADR forbids. **The conclusion does not depend on it**: 14/15 and
15/15 are both decisively above `S₁₄`.

### Recommendation on A/B/C — and the result argues both ways at once

**B, and the measurement that supports it also names its weak point.** B gates on the test files
*still passing* rather than *still type-checking*, and `snc-27` is the clause "still passing"
disagreeing with itself inside one hour on an unloaded machine. **B moves weight off a deterministic
check onto a non-deterministic one**, and the size of that non-determinism is the unresolved `D`.

That is not an argument against B — 14/15 against 2/30 is too large to leave on the table, and the
status quo *also* depends on the suite for every task that gets past `compile`. It is an argument that
**B's own proof obligation is the one ADR-0077 already wrote down** — *"needs its own proof that it
cannot be gamed"* — **plus a second one nobody had listed: that a flip like `snc-27`'s is rare enough
to price in.** Characterising `D` on a corpus where pressure is excluded is now on the critical path
to B, where before it was a loose end.

**A is retired by this number** — writing `null_guard` off as out of scope would be writing off work
the gate can be shown to credit. **C is retired more firmly than before**: pre-filtering the pool
would have removed all 15 of these tasks, 14 of which pass the project's own suite.

---

## ADR-0078 — The 24 GB floor applies to every run, including one that never starts a worker

**Status:** **accepted**, 20 Sep 2026, by the owner · confirms existing behaviour · no product code changed

### Context

Raised while fixing CI on 20 Sep. `runBatch` and `fix` call `assertSupportedMachine` (ADR-0073) before
they know whether the run will generate anything, so `sidecrew run --dry-run` is refused on a machine
below 24 GB. A dry run stops before the first token and picks no worker: it renders tasks and prompts
and counts estimated tokens, none of which needs RAM the machine does not have.

It surfaced as a CI failure — a GitHub macOS runner has 7 GB, and three of the five `runBatch` tests
that died on the floor were `--dry-run` tests. **Those tests were fixed by passing `workerKind`
explicitly**, the bypass `assertSupportedMachine`'s own docstring blesses for a harness, which moved
the tests off the floor without moving the floor. That deliberately left the product question open
rather than answering it with a test fix.

### The question

Should `--dry-run` be exempt from the floor?

- **A — exempt it.** *"What would this cost me?"* is exactly the question somebody on an unsupported
  machine wants answered before buying a supported one, and refusing it is a worse first experience
  than answering it. The dry run genuinely cannot fail for want of RAM.
- **B — the floor applies to every run.** One rule that holds everywhere, with no case analysis at the
  call site and nothing for a later change to get wrong.

### Decision

**B.** The floor applies to every run, `--dry-run` included.

**Why, in the owner's terms:** a floor with an exception is two rules, and the exception is the kind
that grows — the next candidate is `--help`-shaped, then a validate-only path, and each one is
individually reasonable. The cost of B is one confusing refusal on a machine sidecrew does not support
anyway; the cost of A is a second code path through the tier decision, which is the decision ADR-0045
§4 made deliberately unconditional so that nothing selects a tier by looking at anything but installed
RAM.

**`SIDECREW_TIER=api` is not the escape hatch for this**, and the refusal text should not be read as
recommending it: it opts into a tier ADR-0073 descoped and whose survival and cost figures were never
measured.

### Consequences

- **No code changed.** This confirms what `src/models.ts` already does; the value of the ADR is that
  the behaviour is now intended rather than incidental, and a future reader finds the reasoning
  instead of re-deriving it.
- **The harness bypass stays**, and stays for harnesses. `workerKind` set explicitly means *this run is
  not choosing a tier by looking at RAM* — an experiment, a replay, or a test. It is not a user-facing
  way around the floor.
- **What this does not settle:** whether the refusal *message* should say what a dry run would have
  cost, which is a wording question and cheap to revisit.

---

## ADR-0079 — Recon before planning: sidecrew should negotiate the bar, then fix, then offer to raise it (PROPOSED)

**Status:** proposed · 20 Sep 2026 · owner's proposal · **needs the owner** · bears on ADR-0063,
ADR-0064, ADR-0077 and ADR-0044

### The proposal, in the owner's words

> A user says *"fix the TypeScript errors on this project"* or *"how many TypeScript issues are
> there?"*. sidecrew should say: **your own config reports none, but under this flag you have `n` —
> do you want to fix those?** Then fix them. Then, when they are fixed, **ask whether to turn the flag
> on**, so the mistake cannot recur. Opus plans, workers check and report, Opus asks the user and
> re-plans on the answer, and the loop runs until it is addressed. The same shape should work for
> tests, a simple bug, a feature, or lint.

### Why this is the right instinct: it makes ADR-0064 mechanical instead of rhetorical

ADR-0064 established that **#2a's addressable surface is a property of the project's configuration,
not of its code** — project-a carries ~11,000 latent errors and reports zero because
`strictNullChecks` is off. ADR-0064's open options treat that as something to *say*: a caveat in
`VISION.md` (B) or a sharper pitch (C).

**This proposal makes it something the tool does.** The user does not have to know the fact; sidecrew
measures it and puts the number in front of them. That is strictly better than any wording, and it
retires the hardest part of ADR-0064's C — the worry that *"point sidecrew at the migration you have
been putting off"* is a claim nobody can act on without already understanding their own tsconfig.

### Three things that bear on it, none of which block the recon step itself

**1. Most of the machinery exists; the missing piece is a surface, not a capability.**
ADR-0063 accepted compiling stricter than the project, `EXTRA_STRICTNESS` in `src/schemas.ts` already
carries the flags as a bare boolean switch list, and `ChangePlan` already records which setting
produced a number. The project-a measurement quoted above was taken this way. What does not exist is
any **product** path to it: no subcommand reports *"your config says 0, `--strictNullChecks` says
763 files"* to a user. The loop is likewise not new — **ADR-0044's correction round** is the
plan → work → report → re-plan cycle, accepted and partly built.

**2. ADR-0063 condition 1 forbids editing the project, and that rule is about experiments, not
about the product.** Condition 1 — *"No file in the project changes. A compiler flag only"* — exists so
a measurement cannot be rescued by editing the thing being measured. The proposal's final step is
precisely to edit `tsconfig.json`, and that is not a violation: **a user who asked for the flag to be
turned on is not a measurement being rescued.** This must be written down explicitly, because a future
session reading ADR-0063 alone would conclude the flag-flip is forbidden. The separating rule:
*an experiment may never change the project; the product may, only on an explicit answer from the
user, and never as a side effect of a run.*

**3. The honest blocker: on the flagship example, "yes, fix them" currently cannot be delivered.**
This is the part to decide with eyes open. ADR-0077 measured `null_guard` under `--strictNullChecks`
at **2/30**, and the cause is not the worker: the fix narrows a type, the narrowed type propagates
into fixtures and mocks, and the gate forbids editing test files because tests **are** the gate. The
sinking error was in a test file in **21 of 21** cases and in non-test source in **0** — and it gets
worse as the worker improves.

So on project-a the proposed flow would today promise 763 files and clear very few. **A recon step that
quantifies work the tool then cannot do is worse than no recon step**, because it converts a quiet
limitation into a loud broken promise.

**But the proposal supplies the argument ADR-0077 option B was missing.** B — *let a plan declare the
test files a change may disturb, gated on those tests still passing rather than still type-checking* —
was held back because it weakens the strongest thing the gate says. **Under this proposal the user has
explicitly consented to raising the bar**, and in that context a fixture whose mock now needs `| null`
is not a regression: it is part of the migration they asked for. Consent does not make B safe on its
own — it still needs its own proof that it cannot be gamed — but it removes the objection that the
gate would be weakened *without anyone having asked for it*.

### The generalisation has a hard boundary, and it is CLAUDE.md's central rule

*"One honest gate per workload is the unit of progress — a workload a machine cannot check does not
belong here at any price."* Against the five shapes named:

| shape | the gate a machine can run | verdict |
|---|---|---|
| **type errors** | `tsc`, plus the suite | ✅ exists — workload #2a |
| **tests** | compile → run → mutation-kill | ✅ exists — workload #1 |
| **lint issues** | the linter's own exit code, plus the suite | ✅ **the cleanest addition available**, and see below |
| **a simple bug** | a failing test that now passes, suite still green | ✅ *conditional* — only where a reproducing test exists, and writing that test is workload #1 |
| **adding a feature** | — | ❌ **no gate.** No machine checks *"is this the feature I wanted"* |

**Lint deserves attention ahead of the others**, and for a reason ADR-0077 makes concrete: a
`noUnusedLocals` or unused-import fix **deletes a reference**, it does not narrow a type, so it does
not propagate into fixtures. It is the one raised-bar shape whose fallout the gate can already credit,
and Phase 11 measured renames and unused-import removals as the shapes that actually survive.

### Options

- **A — recon only.** Build the *"your config says 0, this flag says n — want to see them?"* report and
  stop there. Cheap, honest, useful on its own, and it makes no promise the gate cannot keep. It also
  answers the owner's second question (*"how many TypeScript issues are there?"*) completely.
- **B — recon, then fix, scoped to shapes that survive today.** A on top of a pool filtered to lint and
  dead-code shapes. Deliverable now, and it is ADR-0077 option C's pre-filter used honestly — as a
  scoping rule the user is told about, not as a way to make a funnel look better.
- **C — the full loop, including the flag-flip.** Requires ADR-0077 A/B/C decided first, because
  `null_guard` is most of the population on a real strictness migration. Highest value and the owner's
  actual ask.
- **D — the general agent loop across all five shapes.** Rejected as stated: *adding a feature* has no
  gate, and admitting one workload without one costs the property every other number in this
  repository depends on. The other four are in scope on their own merits.

### Recommendation

**A now, B next, C once ADR-0077 is decided; never D as stated.** A is small, is useful the day it
ships, and is the piece that makes ADR-0064 a behaviour instead of a paragraph — which also means
ADR-0064's own B/C become much less urgent. Sequencing C behind ADR-0077 is not caution; it is the
difference between a tool that quantifies work it can do and one that quantifies work it cannot.

**ADR-0077's option D counterfactual is on the critical path to C** and costs about an hour with no
worker. It should be run before C is decided.

### What is not decided here

Whether recon belongs in `sidecrew run`/`fix` as a pre-flight, in a subcommand of its own, or only over
MCP where Opus is already in the conversation. The owner's framing — *"Opus receives the task and
decides to add these checks to the plan before any action"* — points at MCP, and that is the cheapest
place to try it, but it is not settled.

### ADR-0079 addendum, 20 Sep 2026 — the framework the recon step is an instance of, and the one gap it closes

The owner generalised the proposal the same day:

> Opus receives the task, plans a session to gather the info needed. Opus receives the info from the
> Qwens. Opus asks the user if needed, and plans based on what the user decides and the info. Opus
> asks the Qwens to act on that. The loop continues until what was asked is satisfied.

**This is not a new direction — it is `VISION.md`'s philosophy section, and it was written the same
day.** *"The local model can scan the code, go through several files looking for something, report
back to Opus; Opus says okay, let's do this, and so on."* Steps 1–2 are `BACKLOG.md` § *The edge
ideas* item 1, reassigned to **Phase 13b**, and `VISION.md` §3 already calls retrieval *"the shape of
the product, not an optimisation of it."* Recording it here so ADR-0079 is read as an instance of the
framework rather than as a feature beside it.

**It has a measured target, which is why it outranks most of the backlog.** Planning costs **233,500
fixed tokens** on a real project — **68 % of the total even at 41 tasks** — and that fixed term is
overwhelmingly Opus *reading*: 15.5M cache reads against 89k of output. It is the one part of the cost
curve that does not amortise as the task count grows, and steps 1–2 attack exactly it.

**The open problem sits precisely in the loop's step 2, and `VISION.md` states it.**

> *"A local model that returns ten **confirmed** locations Opus did not need has passed its gate and
> saved nothing. Existence is checkable by machine; relevance is not."*

That is why edge idea 1 *"needs its own ADR before it is built"*, and why recon is a different
Goodhart shape from every other workload here: the gate can prove a symbol is where a worker said it
is, and cannot prove Opus needed to see it. A recon workload gated only on existence can be passed
perfectly while making the session more expensive, not less.

**The owner's step 3 is a candidate answer to that, and it is the contribution this framing adds.**
*"Opus asks the user if needed"* supplies a **relevance oracle that is not a machine and not Opus** —
the person who asked. The division is clean and it is cheap:

| | who decides | cost |
|---|---|---|
| **does this location exist** | a machine — `tsc`, the AST, a grep | free |
| **is this location relevant** | the **user**, on a batched summary | one question |
| **is this change correct** | the gate (ADR-0046, ADR-0048) | the suite |

This does not make recon gateable on its own; it makes the ungateable half *somebody's* rather than
nobody's. Whether that is sufficient is the ADR edge idea 1 still owes.

**The constraint to design against, from the same measurement.** The 68 % is a *fixed* per-session
term dominated by Opus reading. A loop that re-plans `n` times risks paying it `n` times, which would
invert the entire point of the product. So the framework is only worth building if each cycle is
**batched and cheap for Opus** — one round trip per phase over a summary, never per task, and workers
reporting in aggregate rather than streaming findings. **A chatty loop is a more expensive Opus
session with extra steps**, and it would be measurable as such: planning tokens per task is the number
that says which one was built.

**Sequencing this implies**, and it does not change ADR-0079's recommendation: recon-as-report
(option A) is the cheapest instance of step 1–2 and needs no relevance oracle at all, because the user
asked the question the report answers. It is therefore both the smallest useful piece of the framework
and the one that dodges the unsolved problem — which is a good reason to build it first.

## ADR-0080 — A release gate must ask the systems it publishes to, not its own copy of what they want

**Status:** accepted · 21 Sep 2026 · implemented the same day · bears on ADR-0051's *prove it before
it leaves the machine* framing

### What happened

`v0.1.0` was re-tagged onto the tarball-smoke fix and the run got further than any before it:
`gate` ✓, `npm` ✓, `registry` ✗. Reading it properly, **only one of those three marks was true.**

| job | mark | what was actually so |
|---|---|---|
| `gate` | ✓ | true |
| `npm` | ✓ | **false.** `npm publish` failed; the step reported success |
| `registry` | ✗ | true — 422 `body.packages[0].registryType: expected length >= 1` |

### Three defects, one shape

**1. The schema check validated the file against its own obsolescence.** The gate fetches the schema
from the URL `server.json` itself names, and `server.json` named `2025-07-09` — the last schema whose
package keys are snake_case. The registry API reads camelCase (`registryType`, `registryBaseUrl`,
`packageArguments`, `valueHint`). So the file was, precisely, valid against a schema nobody enforces
any more. **A check that reads its own expectations out of the artefact under test can catch
invalidity and can never catch staleness**, and no amount of care fixes that, because the artefact is
where the staleness is. Measured: against `2025-12-11` the old file fails ajv on `registryType`, so
bumping the pin restores the check's value as well as fixing the file.

Phase 7 migrated this same file across this same kind of drift once already (`registry_name`/`name`
→ `registry_type`/`identifier`), and the comment recording it sits directly above the check that
could not catch the recurrence. That is what makes this a check to add rather than a lesson to
remember harder.

**2. The registry was asked after the point of no return.** `registry` runs after `npm` by design,
and the design is right — the entry points at an npm version, so publishing the pointer first makes
it resolve to nothing. But it meant the **first** contact with the registry happened after npm had
been written to, and npm forbids re-using a version number. `mcp-publisher validate` costs a download
and a round-trip and answers the only authority on what the registry accepts. It now runs **in the
gate**.

**3. `npm publish | tee` reported every failure as a success.** bash takes a pipeline's status from
its last command, and `tee` always succeeds, so `if npm publish ... | tee log; then echo published`
took the success branch unconditionally. The "already published is a skip, not a failure" arm below it
was unreachable dead code from the day it was written. What it hid this time: `prepublishOnly` ran
`npm test` on **ubuntu**, where `test/cache.test.ts`'s *"does not throw when it cannot write"* timed
out — the first time the suite had ever run on Linux, because `ci.yml` runs it on macOS deliberately
and with a good reason.

### The decision

1. `server.json` migrates to `2025-12-11` and camelCase. Verified with `mcp-publisher validate`
   against the live registry and with the gate's own ajv invocation.
2. The gate runs `mcp-publisher validate` **before** `npm run lint`/`test`/`build`, on the same pinned
   binary the `registry` job publishes with — hoisted to one workflow-level `MCP_PUBLISHER_VERSION`,
   because a gate that validates with a different version than the one that publishes is not a gate.
3. The publish step captures `npm publish`'s status into a variable and branches on it. `tee` is gone.
4. The `npm` job moves to `macos-latest`. `prepublishOnly` runs the suite, and **sidecrew is a
   macOS/Apple-silicon tool** — `doctor` shells out to `sysctl` and `vm_stat`, `bench` to `pmset`.
   Gating a publish on a platform we do not ship to is a gate on the wrong question. Whether that one
   test is *also* wrong on Linux is a separate question and is in `BACKLOG.md`.

### What it cost, so the size of it is on the record

`0.1.0` is on npm with **no provenance attestation** — it was hand-published, the workflow's
`--provenance` publish never ran, and the false pass is why nobody noticed. npm will not accept a
re-publish of a version, so `0.1.0` cannot gain one. The workflow's own comment calls provenance *the
cheapest thing this repository can do about supply chain*; it starts at `0.1.1`.

### The rule worth carrying

**Every check in a release gate should be asked of the system that will refuse you, not of a local
copy of its rules** — and where the answer cannot be had before the irreversible step, that is a
finding about the pipeline's order, not an acceptable risk. Three of this week's four release defects
are the same shape from a different angle: an assertion that read the developer's environment when it
meant to read the artefact, and now one that read the artefact when it meant to read the registry.

### Addendum, 21 Sep 2026 — the rule has a limit, and `v0.1.1` found it

`0.1.1` went out with everything above in place. It **proved the three unproven flows**: npm Trusted
Publishing authenticated, `--provenance` wrote a SLSA statement to the sigstore transparency log
(`logIndex 2905544693`), and the registry's `login github-oidc` reported `✓ Successfully logged in`.
The gate's new `mcp-publisher validate` passed. `publish` then failed twice, for two entirely
different reasons:

1. **The registry's own database was down** — `dial tcp …:5432 connect: connection refused` on
   `registry-pg-rw`. Not ours. Re-running the failed job was enough, and it is worth knowing that
   `gh run rerun <id> --failed` re-runs one job against the same tag — which beats deleting and
   re-pushing a tag for a transient third-party outage, and is the closest thing this workflow has to
   the `workflow_dispatch` it does not have.
2. **`package.json` had no `mcpName`.** The registry validates the **published npm package**, not just
   `server.json`: it fetches the tarball and refuses unless `package.json` declares
   `"mcpName": "io.github.lvlrSajjad/sidecrew"`. That is its proof that whoever publishes the entry
   controls the npm package.

**The second one is the limit of this ADR's rule, and it is worth stating rather than pretending
otherwise.** *Ask the system that will refuse you* assumes it can be asked **before** the irreversible
step. Here it cannot: the registry's check reads a package that does not exist until npm has taken the
version, and npm will not take a version twice. There is no pre-flight endpoint for it. So the gate
now carries a **local copy of the registry's rule** — `package.json.mcpName == server.json.name` —
which is exactly what the rule above argues against, adopted knowingly, because the alternative is
finding out after npm every time. A local copy can go stale; that is the cost, and it is smaller than
one burned version per discovery.

**It cost `0.1.2`.** `0.1.1` is on npm, correct and provenance-signed, and is simply not the version
the registry points at.

**And `0.1.2` failed once more, on a third thing again: a race.** npm accepted the publish and the
registry 404'd the version seconds later, because it resolves the npm package as part of `publish` and
npm's own output says the package *"may take a few minutes to become available"*. `gh run rerun
--failed` after the version appeared was enough, and the entry went live at 11:02 UTC. The job now
polls npm for the version before publishing. **This one is worth separating from the other two**: it
is not a wrong assertion or a stale copy of a rule, it is two systems with no shared clock, and its
signature is that it fails *sometimes* — which is how it would have gone on being diagnosed as
something else. Four release defects, four different shapes, in one day.

**Where the release ended up:** `sidecrew@0.1.2` on npm as `latest` with a SLSA provenance
attestation, and `io.github.lvlrSajjad/sidecrew` active on the MCP Registry at `0.1.2`.

## ADR-0081 — `app.e2e-spec.ts` was not a test file to any of the four copies of the rule that says what one is

**Status:** accepted · 21 Sep 2026 · implemented the same day · found by ADR-0077's counterfactual ·
bears on ADR-0046, ADR-0048 and ADR-0070

### What happened

The ADR-0077 counterfactual demotes type errors **in test files** to observations. It asks that
question with `isTestArtefact` — the gate's own predicate — deliberately, because the whole argument
being measured is *"the errors land in files the gate forbids editing"*, and that is only true if
"test file" here means exactly the set a candidate may not touch.

The first task came back `demoted=0 kept=1`. Reading the recorded verdicts for all 15: **14 of the 15
sinking files are `*.e2e-spec.ts`, and `isTestArtefact` says none of them is a test file.**

`TEST_FILE` was `/\.(test|spec)\.[cm]?[jt]sx?$/`. `app.e2e-spec.ts` ends in `-spec.ts`, not `.spec.ts`.
It is what `nest new` generates. Measured on project-a: **77 such files, beside 354 `.spec.ts` the
pattern did match.** project-b is unaffected — it is `.test.tsx` throughout — except for one
`.type-test.ts`.

### It is a hole in the gate, not a wrinkle in a measurement

`checkConfinement`'s `test_file_edited` fires **even for a path the task lists**, and ADR-0048 gives
the reason in one sentence: *a rule the plan can switch off is a rule the planner can be argued into
switching off, and the planner is going to be a model.* Run against the production function:

| the task lists | breaches |
|---|---|
| `src/a.spec.ts` | `test_file_edited` |
| `test/app.e2e-spec.ts` | **none — the candidate may edit it** |
| `src/a.int-spec.ts` | **none** |

So on the flagship NestJS project, a plan listing an e2e spec let a candidate edit the instrument the
gate is made of. `loadChangePlan` and `fix-validate`'s `FORBIDDEN` each carried their own copy of the
same regex and had the same hole, so neither of the two independent refusals ADR-0048 asks for would
have fired.

**No published number moves.** Probe 1: **0 of 58** candidate edits and **0 of 58** task-listed files
were a test file this pattern missed. `S₁₄ = 2/30` and every rate before it stand. The defect was
latent — which is the only reason it is an ADR and not an erratum.

### Why four copies agreed for so long

The comment above the pattern read *"the same pattern the workload-#1 sandbox uses… **one definition,
two gates**"*. There were **four**: `confinement.ts`, `verifier/ts.ts`, `fix.ts` and
`fix-validate.ts`. They agreed on every case anyone had thought of, so nothing could show; the first
case they disagreed about would have been the first bug, and the first case they *all* got wrong was
invisible by construction.

This is the standing hazard the release pipeline hit the same week from the other end — *the two
workflows duplicate this check, and a fix to one is not a fix to both*. Duplication hides a defect
twice: once because the copies agree, and once because fixing one looks like fixing it.

### The decision

1. **The pattern gains the qualifier**: `/\.([\w-]+[.-])?(test|spec)\.[cm]?[jt]sx?$/`. A separator is
   required immediately before `spec`/`test`, so `contest.ts`, `latest.ts`, `manifest.ts` and
   `spectrum.ts` are still source — asserted, because that is the direction that costs a task.
2. **One definition, and the rules stay duplicated.** This is ADR-0070's division applied again: the
   *rule* stays in each of the four places, because ADR-0048 wants independent refusals; the *fact*
   about a filename does not, because two answers to a question of fact is a bug rather than a
   safeguard. `TEST_FILE_PATTERN` and `isTestArtefact` live in `confinement.ts`; the other three
   import them.
3. **A test asserts there is no second spelling in `src`.** It scans the source for the regex and
   requires exactly one file to contain it. It fails on a fifth copy rather than waiting for the
   copies to disagree — verified by adding one and watching it go red.

### What this does to ADR-0077's counterfactual

The measurement had not finished — it was stopped at task 1 of 15 — and it would have answered *0 or
1 of 15 reached the suite* for a reason that had nothing to do with ADR-0077's question. **The
demotion set was empty because the predicate was wrong, not because the errors were somewhere else.**
ADR-0077's reading was right on the facts: the errors do land in test files, 14 of 15 of them in the
e2e specs a NestJS project keeps in `test/`.

**Fixing the gate before running the counterfactual is not the thing ADR-0077's first constraint
forbids**, and the difference is worth stating rather than assuming:

- The fix makes the gate **stricter** — more files protected, never fewer. It can only lower a
  survival rate, never raise one.
- It was found by a measurement asking an independent question, not by looking for a better number.
- It moves no published number, because nothing ever edited one of these files.
- The counterfactual's demotion set is *defined* as the files the gate forbids editing. With the
  predicate wrong, the measurement is wrong in either direction — running it on the old predicate
  would not have been the conservative choice, it would have been the meaningless one.

## ADR-0082 — sidecrew writes the oracle it is judged by, before the change exists (PROPOSED)

**Status:** **proposed · 21 Sep 2026 · the owner's proposal · needs the owner** · bears on ADR-0016,
ADR-0031, ADR-0046, ADR-0048, ADR-0077 and Phase 15 · **nothing here is built and nothing is agreed**

### The proposal, in the owner's words

> Opus receives a request from the user. Opus uses the worker to gather info from the code, and asks
> the user if needed. **Opus asks the worker to write its own tests that cover the area the user needs
> to change, to establish the behaviour is green.** *[If the request also includes a behavioural
> change, the tests are written to the **expected** behaviour instead.]* Opus plans the change at the
> same time, and asks the worker to make it.

Every step but the emphasised two is already `VISION.md`'s loop and the framework table in
`PHASES.md` — step 2 is **14d**, the planning and acting steps are built. **The delta is the oracle**,
and it is worth stating on its own because it changes what sidecrew *is* rather than how well it does
what it already does.

### What changes

Today #2a's oracle is the project's suite: **borrowed** — fixed, external, independent, and possibly
bad. This proposes a **manufactured** one: written per task, before the change, gated by workload #1.

| | today | under this proposal |
|---|---|---|
| #2a's oracle | the project's tests | the project's tests **plus** tests written for this change |
| works on a project with no tests | no | yes |
| works on a project with *bad* tests | yes, for the reason below | yes, and better |
| #2b's oracle | **none** | the test, written to the expected behaviour |

**A bad borrowed oracle is not actually #2a's problem, and the distinction matters before anyone
"fixes" it.** #2a claims behaviour-*preservation*, not correctness. For that claim a tautological or
wrong test is still a valid instrument: it is not asked to be right, it is asked to be **unchanged and
re-runnable**. A test that enshrines a bug still fires when the bug changes. What a bad suite costs
#2a is *reach* — coverage of the region being edited — not validity.

### Why it is not circular, which is the first objection and it is answerable

The gate's central rule is that the thing being judged may not edit its own exam (ADR-0046, ADR-0048).
A worker writing the tests it will then be measured against looks exactly like that, and is not,
**because of the ordering**:

1. The test is written against the **unmodified** code, before the change exists.
2. Workload #1's gate already requires it to **compile, pass on the original code, and kill ≥ 1 mutant
   of it, non-tautologically** (ADR-0016). A test that passes the original and kills a mutant of it is
   pinned to the old behaviour.
3. Only then is the change made, and the frozen test re-run.

Nothing in that sequence lets the change author move the target. **The circularity is defeated by time
ordering plus an independent gate, not by trust.**

### The hole in it, and a mechanical answer that already half exists

**"Kills a mutant" is not "would notice *this* change."** Mutation proves sensitivity to *some*
mutation of the function. A change can move behaviour in a dimension the generated test does not
observe, and the test stays green — a valid artefact that fails to help, which is the Goodhart shape
`VISION.md` warns about for retrieval.

**Proposed answer: scope the mutation to the change's own lines.** ADR-0013 already scopes mutation to
a line range. Require the generated tests to kill mutants **inside the range the change will touch**.
That is machine-checkable sensitivity to the right region, built from parts that exist. It is not
airtight — sensitivity to mutants is still not sensitivity to all behaviour — but it converts a hope
into a gate, which is this project's whole standard.

### What it does to the two objections `VISION.md` already records against 2b

`VISION.md` § *Why 2b is genuinely harder* names two, both from ADR-0031. This framing moves both,
and settles neither.

1. **"The economics invert — Claude writes the specification, and that costs more than writing the
   implementation."** This proposal has **the worker** write it, not Claude. That is sidecrew's entire
   premise applied to the spec-writing step, and it makes the objection an *open question* rather than
   a closed one. **It does not answer it**: workload #1 survives at **3/8, 4/8 and 4/10 on real
   projects** (measured, README) — call it two in five — so a pinning oracle means *generate several,
   keep one*, and mutation testing is the most expensive stage in the system. Against a planning cost
   already measured at `R` = 2.84 (12 tasks) and 1.07 (41), both **FAIL**.
2. **"Goodhart flips the wrong way — the cheapest way to pass a visible test is `if (x === 3) return
   7`, and that ships."** The known countermeasure is held-out tests, *"which doubles the expensive
   half"*. **Here they are held out by construction and for free**: writing the test and making the
   change are two separate worker invocations with separate prompts, and the change worker is never
   shown the test. Goodhart needs the measure to be visible. **This is mitigation, not elimination**
   — for #2b the task description carries the intent, so a worker can still special-case toward what
   it infers — but it is a materially cheaper countermeasure than the one ADR-0031 assumed.

### For #2b this is the missing instrument, and that is the real prize

`PHASES.md` has #2b as post-1.0 and *"the one nothing measured so far says anything about"*, because
behaviour-changing work has no oracle **by definition**: the project's tests encode the old behaviour.
A test written to the *new* behaviour is exactly the instrument that was missing. It splits the
question in two, and only one half needs a human:

| question | who answers | cost |
|---|---|---|
| does the change do what was asked | the machine — the new test passes, the old suite does not regress | the gate |
| **was that the right thing to ask for** | **the user, once, on the test** | reading ten lines, not auditing a diff |

**The human oracle does not disappear and should not be claimed to.** What moves is *where it sits*:
a test that states an expectation is far cheaper to review than a change spread across files, and
everything downstream of that approval is mechanical. That is ADR-0079's *"ask the user"* step landing
on the cheapest possible artefact.

### Options

**A — Don't.** #2a stays on the project's suite; #2b stays post-1.0 on ADR-0031's terms. **For:**
today's gate is the strongest sentence this tool says, and every addition here spends some of it.
**Against:** it leaves sidecrew unable to work on a project whose tests are thin, which is most of
them, and leaves #2b with no route at all.

**B — #2a only.** Generate a pinning oracle before a change, for regions the project's suite does not
cover. The claim stays *behaviour-preserving*; nothing is written to a desired behaviour. **For:** it
is the half with no intent problem, and the prize — reach on under-tested code — is concrete.
**Against:** it pays workload #1's cost on every #2a task, and that cost is the one `R` already fails.

**C — Both, the full loop including test-as-specification for #2b.** **For:** it is the vision, and
the human-approves-the-test division is genuinely cheaper than any 2b design written down so far.
**Against:** Goodhart is mitigated, not removed, and a wrong test ships a wrong implementation with a
green gate — the one failure mode this project exists to prevent.

**D — Measure first, and the measurement is short and well defined.** Take `n` functions in a real
project, ask the worker for tests that **kill a mutant inside a named line range**, and report the
yield and the wall-clock per accepted test. That is the number both B and C rest on, it does not exist,
and every argument above is a bet on it.

**Recommendation: D, then B, then C.** The same shape as ADR-0077 and for the same reason — two of
these options are bets on an unmeasured number, and the number is one short run away. **D's rule must
be frozen before it runs** (`PHASES.md` § exit checks): what yield makes B affordable, stated in
advance, so the result cannot be read to suit.

### Interaction with ADR-0077

If sidecrew brings its own oracle, **ADR-0077 option B matters less** — the project's test files
gaining type errors stops being the thing that decides whether work is possible. It does not go away:
the project's suite still runs, and those errors still appear. **Neither ADR blocks the other**, and
ADR-0077's `14/15` is the cheaper win and available now.

## ADR-0083 — ADR-0069's guard watched local midnight, and the tests move at UTC midnight

**Status:** accepted · 22 Sep 2026 · implemented the same day · **found by measurement, not by
reading** · bears on ADR-0069, ADR-0066, ADR-0077 and ADR-0081

### What was measured

25 runs of `project-a`'s **unmodified** suite, each in a fresh clone of one sandbox — exactly as
`verifyChange` clones per task — with no change applied. 92 minutes, machine `normal` and swap flat at
0.008 GB for all 25. `experiments/gate-error-rate/results/suite-reproducibility-2026-09-21.json`.

| run | started | passing |
|---|---|---|
| 1–8 | 23:27:55Z … 23:55:03Z | 6317 |
| **9** | **23:58:42Z** — ran *through* 00:00Z | **6319** |
| 10 | 00:02:23Z | **6320** |
| 11–25 | … 00:59:49Z | 6320, stable for another hour |

**Three tests, in three different suites, and the pattern is not flakiness.** It is strictly
monotonic, never flips back, and the transition straddles **00:00 UTC** exactly. Local time was
01:55 → 02:02 CEST and the local day never changed.

So `project-a` has three UTC-date-dependent tests. That is a fact about a project rather than a defect
in one, and it is the ordinary case: any code doing date arithmetic in UTC — every
`toISOString().slice(0, 10)`, every UTC-stored timestamp — has a UTC notion of *today* whatever the
machine's clock says.

### The defect it exposes

`crossesCalendarDay` compared `getFullYear`/`getMonth`/`getDate` — **local** components. Its own
docstring argued for that:

> *Local time is the right frame because the baseline and the candidate ran on the same machine in the
> same environment, so the suite's own notion of today is this process's. A project that pins `TZ`
> itself is the case this cannot see.*

**The reasoning is wrong and the named blind spot understates it.** No `TZ` pin is required; UTC date
arithmetic in ordinary application code is enough. And the window is not small: **any run between
01:00 and 03:00 local in a UTC+2 summer crosses the boundary the tests care about and not the one the
guard watched.** Last night's run sat exactly there.

`scripts/results-14b.py` carries a deliberate Python reproduction of the same rule and had the same
hole — ADR-0081's *"a fix to one copy is not a fix to the others"*, for the third time this week.

### The decision

**Either frame changing is the warning.** Local **or** UTC. Each catches what the other misses: the
original 02:00-local case that ADR-0069 was written from, and this one. Strictly more sensitive; it
**gates nothing** — ADR-0069 is a warning, not a clause — so the only cost of a false positive is a
sentence. Both copies changed together, and the Python docstring now says why.

**The test for it was also wrong, in the way this week keeps producing.** It asserted that an
eleven-hour same-local-day gap does not cross — true in CEST, true on CI's UTC runners, and **false in
Pacific/Auckland**, where those two instants fall on different UTC days. An assertion that reads the
environment when it meant to read the artefact, for the fourth time. It now uses explicit `Z` instants
for the crossing case and a one-minute window at local noon for the non-crossing one — **the only
shape that is safe in every timezone**, because local midnight is twelve hours away and UTC midnight
can coincide with an endpoint but never fall strictly inside. Verified in CEST, `Pacific/Auckland` and
`UTC`.

### What this explains, and what it does not

**It does not explain `snc-27`.** That verdict was taken at 12:26Z against a baseline at 11:35Z —
nowhere near either boundary — and its 82 regressions remain unexplained. Against the rule frozen
before the run: `0 < spread < 82`, *a floor exists and is smaller than `snc-27`'s flip; the remainder
still needs one.*

**And the direction matters — the first draft of this ADR had it backwards.** The three tests went
**fail → pass**, not pass → fail: at run 1 they were among the project's 209 already-failing tests, and
after 00:00Z they passed. In gate terms that is **harmless**. `tests_ok` requires `regressed.length ===
0` and `passed >= baseline.passed`; a test that failed in the baseline and passes later is not a
regression and more passing is allowed. **A verdict taken across this boundary could only have been
helped by it, never failed.**

So *within those 25 runs* the floor in the direction that fails a candidate was **0**, and the measured
floor of 3 was in the direction that cannot.

**That did not survive a larger sample, and the correction is ADR-0084.** A 50-run control in a
boundary-free window found **11 tests that each failed in exactly one of 50 runs**, clustered into 3
runs — the harmful direction, pass → fail. 25 runs simply did not catch any. **Do not quote the
sentence above as a floor of zero**; it is a statement about a sample that was too small, kept here
because this ADR's other conclusions rest on the same run and a reader has to know which parts a later
measurement moved.

**The guard is still right, because the mechanism is direction-agnostic.** ADR-0069's own case was the
harmful direction — *"the test that asserts on what was tracked today had already flipped"*. Which way
a date-dependent test moves across a boundary depends on what it asserts, and both directions exist in
the same project. One night measured one boundary in one direction; the warning has to cover both.

### A second finding, unlooked-for: 5.3 % of the test ids are not stable between runs

**349 of 6,529** ids appeared in some of the 25 runs and not others — `6180` were seen in all 25
(5,968 always passing, 209 never, 3 flaky). That is ADR-0053's generated-name phenomenon, measured on
this project for the first time and much larger than the *"two such tests"* that ADR was written from.

**The gate already handles it correctly and this is a check on that, not a defect**: `regressed` counts
only ids present in `seen_ids` now, so a vanished id is never a regression, and `ran_after >=
ran_before` still refuses a suite that collected fewer. Worth recording because 5.3 % is the scale at
which somebody would otherwise be tempted to "fix" the id comparison, and ADR-0053 is why they should
not.

**For ADR-0077 option B, read ADR-0084 rather than this paragraph.** It said that across 25 runs no
test moved in the direction that fails a candidate. True of those 25 and false in general: the 50-run
control found the harmful direction at a rate that matters. The date-boundary finding above stands; the
reassurance did not. The control arm, 55 runs across a boundary-free window, is what
turns that into a statement with a number under it.

### The instrument that found it

`scripts/suite-reproducibility.ts` — no change applied, fresh clone per run, flips counted by the same
`passed_ids` the gate compares, reading rule frozen in the header before the number existed, and
**counts only** in the payload because a test id carries a client file path. It is worth keeping: *is
this project's suite deterministic* is a question worth asking of any project sidecrew is pointed at,
and it costs one suite run per sample.

## ADR-0084 — `D` is the suite's flake rate, not the gate's error rate

**Status:** the **measurement is accepted** (22 Sep 2026, overnight) · the **mitigation is proposed and
needs the owner** · supersedes the reassurance in ADR-0083 · bears on ADR-0066, ADR-0069, ADR-0077 and
every survival number this project has published

### The measurement

50 runs of `project-a`'s **unmodified** suite, fresh clone each, no change applied, 01:39Z → 04:45Z —
**no calendar boundary of either kind** — machine `normal` throughout.
`experiments/gate-error-rate/results/suite-reproducibility-2026-09-22.json`.

**11 tests, in 6 suites, each failed in exactly one of the 50 runs.** They cluster into three runs:

| run | at | passing | short by |
|---|---|---|---|
| 8 | 02:06:02Z | 6316 | 4 |
| 22 | 02:58:37Z | 6314 | 6 |
| 23 | 03:03:08Z | 6319 | 1 |
| the other 47 | | 6320 | — |

This is **the harmful direction**: tests that passed become tests that fail. In the gate that is a
regression, `tests_ok` is false, and the candidate does not survive.

### What it explains

**Every one of these would have failed a candidate that deserved to pass**, and the rate at which a run
carries at least one is **3/50 = 0.060, 95 % `[0.013, 0.165]`**.

| | k/n | 95 % exact |
|---|---|---|
| runs carrying ≥ 1 spurious failure — this measurement | **3/50** | **[0.013, 0.165]** |
| `D`, the gate's measured error rate — ADR-0066 | 2/19 | [0.013, 0.331] |

**The intervals share a lower bound and overlap over their whole length.** `D = 0.105` and this 0.060
are not distinguishable on these samples.

**So the most likely reading of `D` is that it was never the gate's error at all.** `verifyChange` did
its job each time: it compared a suite result against a baseline and reported what it saw. What moved
was the suite. ADR-0066 proposed memory pressure and implemented recording for it; the 21 Sep instance
excluded pressure with telemetry on both sides; this supplies the mechanism that was missing, and it
requires no defect in any code this project wrote.

**It does not explain `snc-27`'s 82.** The largest spurious failure observed here is **6**, an order of
magnitude short. Same *kind* of event, not the same size, and calling 82 explained by this would be
exactly the overreach the rest of this ADR argues against.

### What it means for every rate this project has published

**A single evaluation of a candidate carries roughly a 6 % chance of a spurious failure**, in the
direction that fails it. Every survival number measured one evaluation per candidate. So published
rates are **biased low** by something on that order, and the bias is a property of the projects
measured rather than of sidecrew.

This does not invalidate them and must not be used to revise them upward — that would be adjusting a
number after seeing which way an error points, which is what §4.0 precondition 4 forbids. It is a
caveat that belongs beside them, and it is smaller than most of the intervals already quoted.

### The mitigation — proposed, and the owner's call

**Re-run the suite once before recording a failure that rests only on regressions.** If the second run
agrees, the candidate failed. If it disagrees, the verdict records both and the disagreement is the
finding.

- **It costs nothing on the happy path.** Only a candidate that already failed on `tests_ok` pays, and
  only those which compiled — 2 of 30 on the flagship shape, so the expected cost is a fraction of one
  extra suite run per plan.
- **It cannot make the gate more permissive in the way that matters.** A candidate that genuinely
  breaks tests breaks them twice. This only rescues one that never broke them.
- **It is the standard already applied by hand.** `snc-27` was re-read precisely because one failing
  observation against `D = 0.105` is not enough to publish, and ADR-0066's rule — *never take the
  better of two readings because it is better* — is what makes the *recorded disagreement*, rather than
  the better number, the output.
- **Against:** it makes a verdict a function of two runs rather than one, which is a contract change
  (`ChangeVerdict` would need to carry the second reading), and it spends wall-clock at the most
  expensive stage. And a 6 % floor is a property of *this* project; another may be clean, in which case
  this buys nothing there.

**Recommendation: do it, behind a flag that defaults on, and record both readings rather than
collapsing them.** The alternative is publishing survival rates that are known to be biased low by a
mechanism that is now measured and cheap to correct.

### What this says about ADR-0077 option B

B gates on *the tests still passing*. The suite it would lean on fails 11 tests intermittently at
roughly 6 % of runs. **That is an argument for the mitigation above, not against B** — because today's
gate already rests on exactly the same suite for every candidate that reaches it, so B adds no exposure
that is not already there. What changed is that the exposure now has a number.

## ADR-0085 — A sandbox teardown race throws away the verdict it was cleaning up after

**Status:** accepted · 22 Sep 2026 · implemented the same day · **found by two measurements dying at
the same run number** · bears on ADR-0025 (escalations) and on how past "the gate could not run"
counts should be read

### What happened

Two 25-run reproducibility measurements, on **two different projects**, both died **at run 9**. The
first silently — every run from the ninth produced no report and the harness dutifully counted 47 of
them. The second said why:

```
Error: ENOTEMPTY: directory not empty, rmdir '…/sidecrew-task-M4fu5n'
```

`rm(dir, { recursive: true, force: true })` throws `ENOTEMPTY` when something is still writing into the
tree as it is unlinked. **`force` suppresses `ENOENT` and nothing else**, so it does not cover this. The
something is a jest worker outliving the run it belonged to; after eight suite runs one is reliably
still there.

**The reproducibility at run 9 across two unrelated codebases is what makes this a defect rather than
bad luck.**

### Why it matters beyond a harness

`verifyChange` removes its per-task sandbox in a **`finally`**:

```ts
} finally {
  if (opts.keepSandbox) …
  else await rm(sandbox, { recursive: true, force: true });
}
```

**An exception in a `finally` propagates instead of the value the block was returning.** So a throw on
that line does not merely fail to clean up — it **replaces a verdict that had already been computed**.
`runFix` catches it as *"the gate could not run at all"* and escalates the task for a machine reason.
The gate was right, the suite had run, the answer existed, and the cleanup lost it.

**How to read past runs in light of this:** any task escalated with a gate-could-not-run reason may
have been a completed verdict discarded at teardown. Nothing is being revised — there is no way to
recover which, and inventing a correction is worse than carrying the caveat — but an escalation of that
shape is no longer evidence that the gate failed to evaluate.

### The decision

**One `removeSandbox` in `verifier/shared.ts`, used by all seven teardowns**, with Node's own answer for
this class: `maxRetries: 5, retryDelay: 200`, which `fs.rm` applies with linear backoff to exactly
`EBUSY`/`EMFILE`/`ENFILE`/`ENOTEMPTY`/`EPERM`.

Seven call sites — `change.ts` ×2, `fix.ts`, `fix-validate.ts`, `verifier/ts.ts` ×2, `verifier/swift.ts`
— spelled the same options independently. **One definition rather than seven, because ADR-0081 is what
this project has to show for the last set of copies that agreed until they did not**, and because a
retry policy is precisely the kind of thing that gets fixed in one place and left in six.

`shared.ts` is the home for the reason the import-cycle hazard records: it imports nothing of ours.

### What this does not claim

It does not make teardown infallible; it makes it survive a transient. If a sandbox genuinely cannot be
removed after five attempts the error still propagates, which is correct — at that point something is
wrong with the machine and a silent leak of half-gigabyte directories would be worse.

And it does not explain the **first** failure's silence. That run produced no report from run 9 onward
rather than throwing, which is a different symptom of the same family, and the harness now records the
runner's message and stops after three so the next occurrence says which.
