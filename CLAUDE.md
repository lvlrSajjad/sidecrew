# CLAUDE.md — how to work in this repo

You are building **sidecrew**: an npm package (CLI + MCP server, TypeScript, Node ≥ 20) that farms narrow,
verifiable subtasks out to local MLX models and only shows Claude what survived a gate a machine can run.
Workload #1 is unit tests (gate: compile → run → mutation-kill); workload #2 is behaviour-preserving code
changes (gate: the project's own suite plus `tsc`). **One honest gate per workload is the unit of
progress** — a workload a machine cannot check does not belong here at any price. Sibling project in style and packaging: github.com/lvlrSajjad/simframe.

## Read first
- `docs/plan/VISION.md` — **what this is for.** Opus plans and supervises; local models do the work; a mechanical gate decides what Opus is allowed to see. Unit tests are workload #1, not the destination. Publication waits for workload #2 (owner's decision, 16 Sep 2026).
- `docs/research/2026-09-10-local-worker-models.md` — the evidence behind every design choice. Don't re-litigate; if you disagree, write an ADR.
- `docs/plan/PHASES.md` — where we are. One phase per session; the prompt is in `docs/plan/prompts/`.
- `docs/DECISIONS.md` ADR-0044 — the management side (task shape, steps, correction round). Accepted; Phase 10 built §1–2 into the code-change contract, Phase 12 builds §4. ADR-0046 (the #2a sandbox *keeps* the project's tests), ADR-0047 (the code-change contract) and ADR-0048 (the #2a gate) are what Phase 10 decided.
- `docs/plan/prompts/phase-11-go-no-go-2a.md` — **the decision rule for workload #2a, frozen before any number existed.** Do not edit §4; amend below it, dated.
- `docs/specs/pipeline.md` — JSON contracts between planner, workers, verifier, reviewer. Changing a contract needs an ADR and a spec update in the same commit.

## Non-negotiables
1. Worker inference never touches the Anthropic API **on the local tier** — reached over `http://localhost:<port>/v1` (mlx_lm.server), never via a subagent. Machines with less than 24 GB installed (the owner's "16 GB or smaller") are the `api` tier and their worker is Haiku (ADR-0009, ADR-0045): the tier is decided by **installed** RAM, never by free RAM, so a machine that can host a worker never falls back silently, and `BatchResult` records which tier ran. The guarantee is enforced in `src/schemas.ts`, not assumed: a `local` run that spent Claude tokens on worker inference does not serialise.
2. **One gate per workload, and each is an iff in `src/schemas.ts` rather than a convention.**
   Workload #1 (tests): survive ⇔ compiles ∧ passes on original code ∧ kills ≥ 1 mutant of the function
   under test **other than the one that empties its whole body** (ADR-0089) ∧ non-tautological. Workload #2a (behaviour-preserving changes): survive ⇔ the diff was
   confined ∧ `tsc` clean in the task's files with none introduced elsewhere ∧ every test that passed
   before still passes — ADR-0048, and the seven cheap ways to pass it are blocked by name. A verdict
   that claims a survival its own fields do not support does not serialise, on either.
3. Claude reviews survivors only, batched, filtered by mutation score. Never surface raw worker output to Claude.
4. Determinism: temperature 0, fixed seed, one in-flight request per worker process. Pin HF revisions in `src/models.json`.
5. Memory: total resident under ~28 GB on the 32 GB baseline. Default 2 × 7B or 1 × 14B. Never swap.
6. Licences: Apache-2.0 / MIT only for anything downloaded or shipped by default. Codestral weights are research-only.
7. **No client anything leaves this repo — not their code, not their name.** sidecrew is ours and is
   public; the real projects it is measured on are a **client's**, used as a benchmark and testbed, and
   they are not ours to publish. This is a rule about the repository, not about tact, because a public
   git history is not retractable: a push distributes every blob in it, `git rm` in a later commit does
   not remove it, and forks, caches and code search pick it up within hours.
   - **Never commit** a rendered prompt, a worker answer, a candidate, a diff, a review pack, a coverage
     report or a recon note that quotes a client project. Those three artefacts quote whole files
     verbatim by construction. `.gitignore` covers the paths; the rule is why.
   - **Never name the client** — not in docs, ADRs, `CHANGELOG`, `PHASES`, commit messages, plan files,
     script defaults or an article. Naming a client as your testbed discloses the engagement and that
     their codebase was used. Write **`project-a` (Nest/jest)** and **`project-b` (React/jest)**, and
     describe them by the properties a reader needs: stack, scale, suite size, what makes them hard.
   - **The numbers are ours and stay.** A survival rate, a funnel, a suite's size, a gate's wall-clock
     cost — none of that identifies anyone, and it is the entire scientific value. Anonymise, do not
     delete: *"an unmodified commercial Nest codebase, 352 suites, 6,349 tests"* is exactly as strong a
     claim as naming it, and it is publishable.
   - **Local paths stay local.** Plans under `experiments/` point at absolute paths on one machine;
     those are configuration, not results, and they name the client too.
   - Before any `git push`, and before any article, page or README number: scan the diff **and the
     history being pushed** for the client's names and for code that is not ours. ADR-0051 records the
     time this was caught at the push itself, with 448 mentions across 59 files already committed.

## Shape (copy simframe)
- One package, `bin: sidecrew`, subcommands (`run` is workload #1, `fix` is #2a), `sidecrew mcp` for stdio. Only runtime dependency: `@modelcontextprotocol/sdk` (+ `zod`). External capabilities (`mlx_lm`, `muter`, `stryker`, `swift`) are shelled out and reported by `doctor`, never bundled in the npm package. **A tool the gate needs is sidecrew's to provide, never the project's** (ADR-0088): Stryker is pinned in sidecrew's own cache (`sidecrew tools install`, `src/tools.ts`), and **a project is byte-for-byte intact after every job**, checked by `src/integrity.ts` rather than promised.
- `server.json` and `package.json` versions move together; `release.yml` enforces it.
- README leads with measured numbers. Every number in docs is labelled measured or estimated.
- Files are the IPC where possible: runs go to `.sidecrew/runs/<id>/`, one JSON per candidate/verdict.

## Conventions
- TypeScript strict, ESM, `vitest`. No default exports. `zod` for contracts. Shell-outs through one helper (`src/exec.ts`) with timeouts.
- Slow tests (`*.slow.test.ts`) need real toolchains and run only with `SIDECREW_SLOW=1`; CI runs the fast set.
- Every phase ends with: `npm run lint && npm test` green, `PHASES.md` status updated, an ADR if anything was decided, a line in `docs/CHANGELOG.md`.
- Don't pull features forward from later phases; note them in `docs/plan/BACKLOG.md`.
- Measured numbers → `experiments/go-no-go/results/*.json` with `"measured": true` plus machine info.
- **`docs/plan/HANDOFF.md` is the standing handoff and is always current.** It is the first file a new
  session reads. **Update it before you finish**, whenever the phase state, the next action, an open
  owner decision, or a standing hazard changes — not only at a phase boundary. A stale handoff is
  worse than none, because it is trusted: it says where we are, so a session that believes an old one
  starts by redoing or contradicting finished work. Keep it short enough to stay true; the detail
  belongs in `PHASES.md`, `ROADMAP.md` and the ADRs, and the handoff points at them.

## When unsure
Smallest working thing. If a decision is bigger than a function signature, write the options into `docs/DECISIONS.md` as a proposed ADR and ask.
