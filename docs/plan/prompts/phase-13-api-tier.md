# Phase 13 — the `api` tier: Haiku as the worker on machines that cannot host one

Read `docs/plan/VISION.md`, then `docs/plan/ROADMAP.md` (newer than `PHASES.md`, and it reorders it),
then **ADR-0009 and ADR-0045** (the tier decision and the decision to ship it), then
`experiments/go-no-go-2a/results/REPORT.md` for what the local tier actually measures. Then this.

> **§5 of this prompt is frozen the day it is written and before any `api`-tier candidate exists**, on
> the same terms Phase 6's, Phase 11's and Phase 11b's were. Do not edit it during or after the run;
> anything learned about it is appended below, dated. A rule written after a number is a description of
> that number.

## 0. Check the order before you start

**This phase is out of order and you should know that rather than discover it.** `PHASES.md`'s rule is
*"don't start N+1 until N's DoD is met"*, and as of 18 Sep 2026:

- **Phase 12 is built but unmeasured.** Its two numbers (`experiments/planner-cost/`,
  `experiments/correction-round/`) do not exist. Neither blocks this phase — they are about the planner
  and the correction round, and nothing here touches either.
- **Phase 11b is unstarted and outranks both** (`ROADMAP.md`: *"the gap that outranks everything"*).

Phase 13 is largely independent build work on a surface nobody else is touching, which is why it can run
alongside. **But two sessions in one working tree collided on 18 Sep** and one commit swallowed
another's staged work. Stage explicit paths. Never `git add -A` or `git commit -a` here.

## 1. What this phase is for

From the owner:

> Since not every laptop has enough RAM for a local model, we decided to use Haiku for laptops with
> 16 GB or smaller RAM for doing the small stuff.

ADR-0009 decided this on 11 Sep and ADR-0045 made it a phase on 16 Sep. **Nothing implements the path.**
`runBatch` hard-codes `worker_kind: "local"` and refuses to start without a local worker; `runFix` does
the same. So on a 16 GB machine `sidecrew run` does not run, and `VISION.md`'s publication bar — *people
can use it on their code base with no problem* — fails on its own.

`models.json`'s `api` tier currently says `"model": null`. That is the whole state of it.

**What this is not.** The `api` tier does the same small tasks the local tier does. It is not a way to
route harder work to a better model — that is what escalation is for, and escalation's default
(`sonnet`) is unchanged (ADR-0045, Consequences).

## 2. The three decisions that are not made, and must be before code

Each needs an ADR. Do not take the first option because it is first.

### 2.1 How the client talks to the API — and it collides with a stated rule

`CLAUDE.md`'s shape section: **"Only runtime dependency: `@modelcontextprotocol/sdk` (+ `zod`)."** An
API client needs something.

- **A — add `@anthropic-ai/sdk` as a runtime dependency.** Correct retries, streaming, usage fields and
  error types for free, and it is the officially supported path. Costs: it breaks a rule the README and
  the package shape are built on, and it is a dependency every user installs whether or not they are on
  the `api` tier.
- **B — call the Messages API over `fetch`.** `src/worker.ts` already speaks streaming HTTP to an
  OpenAI-shaped endpoint and already parses usage; the Messages API is a different shape but not a
  harder one. Keeps the dependency rule intact. Costs: retries, rate-limit back-off and error taxonomy
  become ours, and getting 429/529 handling wrong on somebody's bill is worse than getting it wrong on
  localhost.
- **C — an optional peer dependency.** Installed only by users who need the tier. Costs: `doctor` has to
  explain a missing optional dep, and "it works on my machine" becomes a support shape.

Whichever you choose, **`assertLocalTier` is load-bearing and must not simply be relaxed**
(`src/worker.ts:52`). It is non-negotiable #1 expressed in code — it is what stops a "local" run reaching
a network endpoint. Give the `api` path its own function with its own allowlist; do not widen the guard
that protects the local tier's guarantee.

### 2.2 The pinned model id

ADR-0045 §2: Haiku, pinned by **full model id** in `models.json`'s `api` tier, the way local weights are
pinned by revision (ADR-0027). A change of id is a change of configuration and gets a new measurement,
not a silent upgrade. Decide the id, write it down, and make `doctor` print it.

### 2.3 What §5's measurement is comparable *to*

ADR-0045 §7 says "Phase 11's protocol, run on the `api` tier". That sentence was written before two
things happened, and following it literally now produces a number comparable to nothing:

- **`src/prompts/fixer.md` changed** in `6c161de` (the worker refusal shape), so the rendered prompt is
  not byte-identical to Phase 11's arms;
- **Phase 11b §2.1 decided not to pin the old template**, on the grounds that pinning measures a tool
  nobody will ship.

So decide explicitly, in an ADR, whether this tier's number is compared against Phase 11's `C2`/`C3`
(requires pinning, and measures a sidecrew nobody ships) or is taken fresh on the current tool
(comparable to 11b's arms instead). **Do not leave it implicit.** Phase 6's `C3` figures are an upper
bound from a subagent harness and are *not* this tier's price — ADR-0045 §7 is explicit and the README
must not quote them.

## 3. What to build

- The client (§2.1), behind the same `generate` seam `RunFixOpts.generate` and the go/no-go harness
  already use, so the gate, the retry rule, the step boundary and the baseline capture are the
  production ones rather than a copy.
- Tier selection from **installed** RAM, never free RAM (ADR-0045 §4). The hazard that rule closes is a
  32 GB machine that happens to be busy quietly starting to bill; keep it closed.
- `runBatch` and `runFix` both stop hard-coding `local`. `BatchResult`/`FixResult.config.worker_kind`
  already record which tier ran and the schema already refuses a `local` run that spent worker tokens —
  that refinement is the guarantee, so do not weaken it to make the `api` path convenient.
- **Accounting from the API's own usage fields** (ADR-0045 §6), never an estimate. `generateChange`
  already throws when a local worker reports estimated usage, for exactly this reason; hold the same
  line here.
- Concurrency bounded by the rate limit rather than by RAM, and still the run's to pick (ADR-0044 §3).
  There is no `workers` field and the schema is `strict`.
- `doctor` and `serve` say which tier the machine is **and why**, in the shape ADR-0032 set: the cause,
  whose fault it is, and the exact fix.

## 4. Constraints carried in

- **Non-negotiable #3 holds and does not care that the worker is Claude.** The verifier sits between the
  two calls; raw `api`-tier worker output is not reviewable output. A subagent is still not a worker
  (ADR-0001) — the `haiku-worker` agent is an experiment control and says so in its own description.
- **Determinism is temperature 0 and nothing more.** ADR-0045 §5: no seed on this tier, so Phase 1's 5/5
  byte-identical check is a local-tier test and must not be claimed here. `Candidate.worker` already
  requires a seed only on `local`. The memoisation idea in `BACKLOG.md` is local-tier only for the same
  reason.
- **The zero-worker-tokens headline is a *local-tier* headline** and is labelled as such wherever it
  appears, including the README (ADR-0045, Consequences).
- **CLAUDE.md #7.** The client's code and name never enter the repository. `experiments/go-no-go-2a/plans/`
  is untracked and stays that way. Scan the diff **and the history being pushed** before any push — and
  as of 18 Sep 2026 there are 45 tracked files still naming the client, so **do not push** (ROADMAP
  priority 4).
- **This tier spends the owner's money.** Say what a run cost before running a bigger one.

## 5. The decision rule — frozen before any `api`-tier candidate exists

### 5.0 Precondition

A run is read only if all of these hold. Any one failing makes it **void**:

1. **The gate is the production gate**, byte-for-byte ADR-0048's rule. The tier changes who writes the
   candidate and nothing else.
2. **`config.worker_kind` is `api` and `claude_tokens.workers` is what Anthropic billed**, taken from the
   API's usage fields rather than estimated. A run whose worker tokens are an estimate is void, because
   the entire point of this measurement is the tier's price.
3. **The baseline matches a reference** measured on a quiet machine at the same commit. Phase 11's
   amendment, and it caught every contaminated arm there while the explanation attached to it was wrong
   three times over.
4. **§2.3 is decided and written down before the first candidate**, so the run says what it is
   comparable to rather than being asked afterwards.

### 5.1 The measured quantities

Per input, never pooled — the fixture and both unmodified real projects:

- **S(api)** — survival, exactly as Phase 11 §4.1 defines it.
- **A(api)** — the blind approval rate, exactly as Phase 11 §4.1 defines it, reviewer blind to tier.
- **$(api)** — **dollars per surviving task**, from the billed usage, at the rates recorded on the day.
  This is the quantity that does not exist for the local tier and is the reason this phase has a rule at
  all.
- **refusals** and **machine_failures**, as their own rows (`FixResult.stats`), never folded into S.
- Wall clock, **reported, never a criterion**. Phase 11 §4.2's reasoning holds and is stronger here: the
  gate is 95 % of a candidate's cost and is identical across tiers, so a latency comparison between
  tiers would be measuring the user's test suite.

### 5.2 The rule

The question is **not** "is Haiku better than the 7B". It is **"is the `api` tier good enough to ship to
a user who has no alternative"**, because on a 16 GB machine the alternative is that sidecrew does not
run at all. That asymmetry is the whole rule:

- **SHIP** — `A(api) ≥ 0.90 · A(C2)` on each real project, **and** `S(api) ≥ 0.25` absolute. The tier is
  at least as trustworthy as the local tier the README already describes, and clears Phase 11's absolute
  floor.
- **SHIP WITH THE NUMBER STATED** — `A(api) ≥ 0.90 · A(C2)` but `S(api) < 0.25`. It works and it is
  wasteful; ship it with the survival rate and the dollar cost in the README, the way ADR-0020 set the
  precedent. A user with no alternative is entitled to a working tool and an honest price.
- **DO NOT SHIP** — `A(api) < 0.90 · A(C2)`. **Precision is the veto**, for Phase 11's reason: a tool
  that delivers changes a reviewer would reject is worse than one that delivers nothing, because the
  second failure is visible. A 16 GB user is then told the tier is not ready, which is a worse outcome
  than a bad tier only if you believe shipping a bad tier is not worse.

### 5.3 The clause about the sample

Phase 11's amendment, and it applies here before the fact rather than after: **a metric that saturates
cannot rank anything.** `S` sat at or above 0.917 in five of six cells there, which made the rule's
primary clauses inert and threw the whole verdict onto the approval guard. Expect the same. So:

- **budget for the blind pass from the start** — it is the clause that will decide this, not `S`;
- **state the bar as a count where the sample allows it.** With `min(10, survivors)` the approval rate
  moves in steps of 0.1, so 0.900 is the *first* value at or above a 0.90 bar and "exactly at the
  threshold" is the most likely way to pass. Both real projects did exactly that in Phase 11. Pick a
  sample size whose lattice does not land on its own threshold, or say "k of n".

### 5.4 What this phase does not answer

Whether the `api` tier beats **not using sidecrew** on a 16 GB machine. That is Phase 11b's axis, on a
tier it does not cover, and nothing measured here may be quoted as though it answered it.

## 6. Definition of done

- The `api` tier runs both workloads end to end on a machine that cannot host a local worker, with
  `worker_kind: "api"` and billed usage in `claude_tokens.workers`.
- An ADR for each of §2.1, §2.2 and §2.3, and `docs/specs/pipeline.md` updated in the same commit as any
  contract change.
- **§5 is measured** and in `experiments/` with `"measured": true` and machine info, against the rule
  above, unedited.
- `doctor` and `serve` name the tier and why, with the fix, in ADR-0032's shape.
- README labels the zero-worker-tokens headline as local-tier and prints the `api` tier's price beside
  it.
- `npm run lint && npm test` green, `PHASES.md` and `ROADMAP.md` updated, a line in `docs/CHANGELOG.md`.

## 7. Do not

- Do not relax `assertLocalTier`. Give the `api` path its own guard.
- Do not quote Phase 6's C3 token figures as this tier's cost. They are an upper bound from a subagent
  harness and ADR-0045 §7 says so.
- Do not let the `api` tier take different tasks from the local one. Same small stuff, same gate.
- Do not claim determinism. Temperature 0 is not a seed.
- Do not `git push`, and do not `git add -A`.

---

## Amendment to §5, dated 2026-09-18

*§5 above is unedited. This is appended below it, as §5's own preamble requires, and it was written
before any `api`-tier candidate existed — the thing §5 is frozen against. It moves no threshold.*

**A subagent arm was considered as a way to run §5 without API credits, and refused.**

The question came up because the Console account has no credits and the build is otherwise finished.
The candidate substitute was the one Phases 6 and 11 already use: the `haiku-worker` agent, a Claude
Code subagent on the session endpoint, which costs no API credits and runs through the production gate.

It cannot satisfy §5, for three reasons that were already written down before the question arose:

1. **ADR-0045 §7** says the tier gets its own number and *"Phase 6's C3 figures are not quoted for it"*.
2. **§5.0.2** voids a run whose worker tokens are an estimate. A subagent yields the Agent tool's own
   total, which is the upper bound §7 refuses.
3. **`src/api-worker.ts` never executes** on that path — not the client, not `assertApiTier`, not the
   retry rule that decides whether a 429 is billed twice. The one code path this phase exists to prove
   would remain untested against a real endpoint.

**And it would mostly re-derive an existing number.** Phase 11's C3 arm already ran Haiku through this
gate: `S = 12/12, 12/12, 3/3` and `A = 10/10, 10/10, 3/3`. On quality, Haiku-as-worker is the
best-performing configuration in this repository, so §5.2's precision veto is in substance already
answered. What is genuinely missing — *does the client work against the real endpoint*, and *what does
the tier cost* — is exactly what a subagent cannot tell us.

**Decision: Phase 13 stays at "built, unmeasured" until credits exist.** That is an honest state and it
blocks nothing before Phase 14, since §5's consumers are the publication bar and the README's price
line. The estimate is unchanged and small: ~$0.002 a task, under $0.25 for the full §5 shape, with the
fixture arm alone at ~$0.015 — and the fixture is our own code, so it exercises the whole path without
sending anyone else's source over the network.

**What not to do when the credits arrive:** do not let a substitute arm's figures reach
`experiments/`, even labelled. A number that looks like §5 sitting beside §5's protocol is a number
somebody quotes later, and this repository has already paid for that lesson twice.
