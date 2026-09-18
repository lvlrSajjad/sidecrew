// `claude/skills/sidecrew/` against the code it describes.
//
// Phases 3, 4 and 5 each noticed the same gap by reading rather than by failing: `references/verifier.md`
// carried ADR-0012's superseded score formula from Phase 2 to the end of Phase 3, and said a tautology
// gets no retry when `shouldRetry` has always retried one. Both would have had an orchestrator doing the
// wrong thing, and `test/schemas.test.ts` keeps `pipeline.md` honest by parsing it while nothing did this.
//
// It is a grep, not a parser, and deliberately so: the reference docs are prose for a model to read, and
// the only things worth pinning are the ones a reader would act on — the survival rule, the score formula,
// the stage names, the conditions that skip the retry, and the review thresholds. A doc that drifts on
// any of those is a doc that makes Claude do something the code will not.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { REVIEW_THRESHOLD, DEFAULT_AUDIT_FRACTION } from "../src/review.js";
import { Stage } from "../src/schemas.js";
import { ESCALATIONS_FILE, DEFAULT_ESCALATION_MODEL } from "../src/escalate.js";
import { THERMAL_DROP } from "../src/throttle.js";

const read = (path: string): string => readFileSync(path, "utf8");
const VERIFIER = read("claude/skills/sidecrew/references/verifier.md");
const SKILL = read("claude/skills/sidecrew/SKILL.md");

describe("references/verifier.md", () => {
  it("states the survival rule the schema enforces", () => {
    expect(VERIFIER).toContain("compile_ok ∧ pass_ok ∧ ¬tautological ∧ mutation.killed ≥ 1");
  });

  it("states the mutation-score formula, and says which one it is not", () => {
    // The superseded `killed / (killed + survived)` is what was in here for two phases.
    expect(VERIFIER).toContain("(killed + timeout) / (killed + timeout + survived +");
    expect(VERIFIER).toContain("It is *not* `killed / (killed + survived)`");
  });

  it("names every stage the contract has, and no stage it does not", () => {
    for (const stage of Stage.options) expect(VERIFIER, stage).toContain(`| \`${stage}\``);
    expect(VERIFIER).not.toMatch(/\| `(verify|mutate|run)` \|/);
  });

  it("lists the conditions that skip the retry, with the ADR for each", () => {
    expect(VERIFIER).toContain('`stage_reached === "mutation"`');
    expect(VERIFIER).toContain("all four mutation counts are `0`");
    expect(VERIFIER).toContain("byte-identical to the first attempt's");
    for (const adr of ["ADR-0012", "ADR-0005", "ADR-0022"]) expect(VERIFIER, adr).toContain(adr);
  });

  it("says a tautology *is* retried, which is what the code does", () => {
    // The stale line said the opposite, and an orchestrator reading it would have escalated candidates
    // the retry can actually fix — the detector's finding names the line and the reason.
    expect(VERIFIER).toMatch(/retries everything else once.*including a tautology/s);
  });

  it("quotes the review thresholds the code defaults to", () => {
    expect(VERIFIER).toContain(`**${REVIEW_THRESHOLD.typescript}** on TypeScript`);
    expect(VERIFIER).toContain(`**${REVIEW_THRESHOLD.swift.toFixed(1)}** on Swift`);
    expect(VERIFIER).toContain(`**${DEFAULT_AUDIT_FRACTION * 100} %** audit sample`);
  });
});

describe("SKILL.md", () => {
  it("names only tools the MCP server actually exposes", async () => {
    // A skill that calls a tool by a name the server does not have fails at the worst possible moment:
    // mid-run, in front of a user, with half a plan generated.
    const { buildServer } = await import("../src/mcp.js");
    const server = buildServer();
    const registered = new Set(Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools));
    const named = new Set(SKILL.match(/sidecrew_[a-z_]+/g) ?? []);
    expect(named.size).toBeGreaterThan(0);
    for (const name of named) expect(registered.has(name), `SKILL.md names ${name}`).toBe(true);
  });

  it("keeps the escalation queue's filename and default model in step with the code", () => {
    expect(SKILL).toContain(ESCALATIONS_FILE);
    expect(SKILL).toContain(`\`${DEFAULT_ESCALATION_MODEL}\``);
  });

  it("still tells the orchestrator the two things it must not do", () => {
    // Both are load-bearing: ADR-0001 is the whole reason workers are not subagents, and ADR-0006 is the
    // reason a survivor is not an endorsement.
    expect(SKILL).toMatch(/never.*through a subagent/i);
    expect(SKILL).toMatch(/Survival is a filter, not an endorsement/);
  });

  it("does not recommend --force, which starts a worker into swap", () => {
    // Non-negotiable #5. The refusal's own advice is to close something or to wait.
    expect(SKILL).toMatch(/never suggest `--force`/);
  });
});

describe("the numbers the docs quote", () => {
  it("quotes the thermal drop the guard actually uses", () => {
    const readme = read("README.md");
    expect(readme).toContain(`${THERMAL_DROP * 100} %`);
  });
});
