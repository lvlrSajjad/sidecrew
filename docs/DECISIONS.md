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

## ADR-0004 — (Phase 2) verification sandbox: temp copy vs git worktree — _tbd_

## ADR-0005 — (Phase 3) Muter + Swift Testing attribution — _tbd_

## ADR-0006 — The verifier is a scoring rule; design it against Goodhart, not just against bugs
Context: the worker is an optimizer pointed at the verifier. The cheapest way to score well is not to write a good test but to satisfy the gate: `assert true`, `expect(x).toBe(x)`, a snapshot that pins today's (possibly wrong) output, or one weak assertion that happens to kill a single trivial mutant. This becomes acute if we ever fine-tune or select a worker on its own survivors.
Decision: every gate we add is judged by "what is the cheapest way to pass it without the test being useful?" before it ships. Current gates and their known cheap passes:
- compile / pass → tautological tests. Countered by the static tautology check.
- killed ≥ 1 → a test that kills one trivial mutant (e.g. removes a `return`) while asserting nothing about the interesting logic. Countered only partially; hence mutation *score* drives review, not survival alone.
- mutation score → snapshot-of-current-bug kills mutants and encodes the bug. Countered by review of low-score survivors and, later, LLM-proposed mutants (BACKLOG).
- equivalent mutants inflate "survived" and depress the score for good tests. Accept; treat score as a review signal, not a pass/fail.
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
