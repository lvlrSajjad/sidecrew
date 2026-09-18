// "The diff touches only what was asked" — the free half of the workload-#2a gate, and the half a
// worker will try hardest to get around (ADR-0048).
//
// The load-bearing test in here is the last one in the first block: **every `ConfinementRule` has a
// control in `fixtures/fix-fixture/controls/`, and every control is refused.** An enumeration of cheap
// ways to pass is worth exactly what its controls are worth, and a rule added without one would
// otherwise be a rule nobody ever saw fire.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, it, expect } from "vitest";
import { checkConfinement, codeLines, confinementMessage, observe } from "../src/confinement.js";
import { ChangeCandidate, ChangeTask, ConfinementRule, type ConfinementBreach } from "../src/schemas.js";

const FIXTURE = "fixtures/fix-fixture";
const CONTROLS = join(FIXTURE, "controls");

const read = (rel: string): string => readFileSync(join(FIXTURE, rel), "utf8");

const task = (files: string[], overrides: Partial<{ max_deleted_lines: number }> = {}): ChangeTask =>
  ChangeTask.parse({
    task_id: "t",
    language: "typescript",
    test_framework: "vitest",
    ask: "Fix every TypeScript error in these files without changing what the code does.",
    files: files.map((path) => ({ path, source: read(path), source_sha: "sha", errors: 1 })),
    diagnostics: "",
    max_deleted_lines: overrides.max_deleted_lines ?? 0,
    notes: null,
    attempt: 0,
    retry_of: null,
    previous_error: null,
    correction: null,
    shape: "rename",
  });

const candidate = (edits: { path: string; contents: string }[]): ChangeCandidate =>
  ChangeCandidate.parse({
    task_id: "t",
    worker: { kind: "local", model: "m", revision: "r", temperature: 0, seed: 42 },
    edits,
    unparsed: null,
    truncated: false,
    refusal: null,
    usage: { prompt_tokens: 1, completion_tokens: 1 },
    timing: { ttft_ms: 1, wall_ms: 1 },
  });

const rules = (breaches: ConfinementBreach[]): string[] => breaches.map((b) => b.rule);

interface Control {
  rule: string;
  why: string;
  edits: { path: string; contents: string }[];
}

const controls = (): Map<string, Control> => new Map(
  readdirSync(CONTROLS).filter((f) => f.endsWith(".json")).map((f) => {
    const control = JSON.parse(readFileSync(join(CONTROLS, f), "utf8")) as Control;
    return [basename(f, ".json"), control];
  }),
);

describe("the controls in fixtures/fix-fixture/controls", () => {
  const found = controls();

  it("covers every ConfinementRule, so a new rule cannot arrive without one", () => {
    expect([...found.keys()].sort()).toEqual([...ConfinementRule.options].sort());
    for (const [name, control] of found) expect(control.rule, name).toBe(name);
  });

  it("explains, in each file, what the control is buying", () => {
    // These are read by whoever next wonders whether a rule is worth its false positives.
    for (const [name, control] of found) expect(control.why.length, name).toBeGreaterThan(80);
  });

  for (const [name, control] of controls()) {
    it(`refuses the ${name} control, and names that rule`, () => {
      // The task is always about `src/rates.ts`: every control is a way of *not* fixing its planted
      // TS2538, which is what makes them comparable.
      const breaches = checkConfinement(task(["src/rates.ts"]), candidate(control.edits));
      expect(rules(breaches), control.why).toContain(name);
      expect(confinementMessage(breaches)).toContain(name);
    });
  }
});

describe("checkConfinement", () => {
  it("passes a real fix that stays inside the file", () => {
    const fixed = read("src/rates.ts").replace("rates[code] ?? 0", "code === undefined ? 0 : rates[code] ?? 0");
    expect(checkConfinement(task(["src/rates.ts"]), candidate([{ path: "src/rates.ts", contents: fixed }]))).toEqual([]);
  });

  it("counts suppressions rather than detecting them, so a project that already has one still works", () => {
    // Otherwise every candidate of a project with a single legacy `@ts-ignore` fails forever, which
    // would read as a survival rate rather than as a bug in the gate.
    const withOne = `// @ts-ignore\n${read("src/rates.ts")}`;
    const t = ChangeTask.parse({
      ...task(["src/rates.ts"]),
      files: [{ path: "src/rates.ts", source: withOne, source_sha: "sha", errors: 1 }],
    });
    const unchangedCount = withOne.replace("rates[code] ?? 0", "code === undefined ? 0 : rates[code] ?? 0");
    expect(rules(checkConfinement(t, candidate([{ path: "src/rates.ts", contents: unchangedCount }])))).toEqual([]);

    const second = `${unchangedCount}\n// @ts-expect-error\n`;
    expect(rules(checkConfinement(t, candidate([{ path: "src/rates.ts", contents: second }])))).toContain("suppression_added");
  });

  it("blocks a build config and a test file even when the task lists them", () => {
    // ADR-0048: a rule the plan can switch off is a rule the planner can be argued into switching off,
    // and from Phase 12 the planner is a model. `loadChangePlan` refuses such a plan as well.
    const t = task(["tsconfig.json"]);
    expect(rules(checkConfinement(t, candidate([{ path: "tsconfig.json", contents: "{}\n" }]))))
      .toContain("build_config_edited");

    const withTest = task(["test/rates.test.ts"]);
    expect(rules(checkConfinement(withTest, candidate([{ path: "test/rates.test.ts", contents: "//\n" }]))))
      .toContain("test_file_edited");
  });

  it("recognises a build config wherever it lives and however it is spelled", () => {
    for (const path of [
      "packages/api/tsconfig.json", "tsconfig.build.json", "package.json", "pnpm-lock.yaml",
      "vite.config.ts", "jest.config.js", "stryker.conf.json", ".eslintrc.cjs", ".babelrc",
    ]) {
      const breaches = checkConfinement(task(["src/rates.ts"]), candidate([{ path, contents: "x" }]));
      expect(rules(breaches), path).toContain("build_config_edited");
    }
  });

  it("does not mistake an ordinary source file for a config", () => {
    // The rule is anchored on the `.config.` segment rather than on a list of tool names, so a helper
    // called `jest-helpers.ts` is source and stays source.
    for (const path of ["src/jest-helpers.ts", "src/config.ts", "src/vitest-utils.ts"]) {
      const breaches = checkConfinement(task(["src/rates.ts"]), candidate([{ path, contents: "x" }]));
      expect(rules(breaches), path).not.toContain("build_config_edited");
    }
  });

  it("allows deletion exactly as far as the ask does", () => {
    const source = read("src/rates.ts");
    const shorter = source.replace(/export function convert[\s\S]*?\n}\n/, "");
    const removed = codeLines(source) - codeLines(shorter);
    expect(removed).toBeGreaterThan(0);

    expect(rules(checkConfinement(task(["src/rates.ts"]), candidate([{ path: "src/rates.ts", contents: shorter }]))))
      .toContain("deletion_without_replacement");
    expect(rules(checkConfinement(task(["src/rates.ts"], { max_deleted_lines: removed }), candidate([{ path: "src/rates.ts", contents: shorter }]))))
      .not.toContain("deletion_without_replacement");
  });

  it("does not count comments or blank lines as deleted code", () => {
    // The budget exists to stop a worker deleting the line that failed. Refusing a candidate that
    // tidied a comment would spend a verdict on nothing.
    const source = read("src/rates.ts");
    const noComments = source.replace(/\/\*\*[\s\S]*?\*\/\n/g, "").replace(/\n\n+/g, "\n");
    expect(codeLines(noComments)).toBe(codeLines(source));
    expect(rules(checkConfinement(task(["src/rates.ts"]), candidate([{ path: "src/rates.ts", contents: noComments }]))))
      .not.toContain("deletion_without_replacement");
  });

  it("calls a byte-identical answer no edit at all, and so an empty one", () => {
    const same = read("src/rates.ts");
    expect(rules(checkConfinement(task(["src/rates.ts"]), candidate([{ path: "src/rates.ts", contents: same }]))))
      .toEqual(["no_edit_at_all"]);
    expect(rules(checkConfinement(task(["src/rates.ts"]), candidate([])))).toEqual(["no_edit_at_all"]);
  });

  it("reports every rule a candidate broke, not the first", () => {
    // Phase 11 counts each rule by name, so a checker that stopped early would report the cheapest
    // pass a worker tried rather than every one it tried.
    const bad = `// @ts-ignore\nconst x = 1 as any;\n`;
    const breaches = checkConfinement(task(["src/rates.ts"]), candidate([{ path: "src/rates.ts", contents: bad }]));
    expect(rules(breaches)).toEqual(expect.arrayContaining(["suppression_added", "any_escape_added", "deletion_without_replacement"]));
  });

  it("keeps a file the task does not list rather than ignoring it", () => {
    const breaches = checkConfinement(task(["src/rates.ts"]), candidate([{ path: "src/money.ts", contents: "export const x = 1;\n" }]));
    expect(rules(breaches)).toContain("path_outside_task");
    expect(breaches.find((b) => b.rule === "path_outside_task")?.detail).toContain("src/rates.ts");
  });
});

describe("observe — true of the candidate, and nothing gates on it (ADR-0057)", () => {
  const withComment = "// why this is safe\n// second line\nexport const a = 1;\n";

  it("sees the deleted docblock the gate admitted, which is what ADR-0054 measured", () => {
    // The fixture case: a 7B deleted a 7-line docblock in 2 of 3 survivors while making a correct
    // one-line fix, and every clause of the gate passed. `max_deleted_lines: 0` did not catch it
    // because `codeLines` skips comments — deliberately, and its docstring used to claim the opposite.
    const t = ChangeTask.parse({ ...task(["src/rates.ts"]), files: [{ path: "src/rates.ts", source: withComment, source_sha: "sha", errors: 1 }] });
    const stripped = observe(t, candidate([{ path: "src/rates.ts", contents: "export const a = 2;\n" }]));
    expect(stripped.map((o) => o.kind)).toContain("comment_lines_removed");
    expect(stripped[0]!.detail).toContain("2 comment line(s)");
  });

  it("says nothing when the change kept the prose", () => {
    const t = ChangeTask.parse({ ...task(["src/rates.ts"]), files: [{ path: "src/rates.ts", source: withComment, source_sha: "sha", errors: 1 }] });
    const kept = withComment.replace("export const a = 1;", "export const a = 2;");
    expect(observe(t, candidate([{ path: "src/rates.ts", contents: kept }]))).toEqual([]);
  });

  it("catches the stray blank line project-b's rejected diff added, whose twin was accepted", () => {
    // The control made the identical import removal without the extra line; the blind reviewer
    // accepted one and rejected the other without knowing which was which.
    const t = ChangeTask.parse({ ...task(["src/rates.ts"]), files: [{ path: "src/rates.ts", source: "export const a = 1;\n", source_sha: "sha", errors: 1 }] });
    const churned = observe(t, candidate([{ path: "src/rates.ts", contents: "export const a = 2;\n\n" }]));
    expect(churned.map((o) => o.kind)).toEqual(["whitespace_churn"]);
  });

  it("sees a rewording at constant volume — the case it was blind to (ADR-0068)", () => {
    // The exact measured case, twice over. Phase 11 sampled it once; Phase 11b then found it was the
    // **only** divergence between a local 7B and Opus across 19 real tasks — and all 19 verdicts
    // reported `observations: []`. Sensitivity 0/1 on the model's one reproducible behaviour, from a
    // mechanism that looked like it covered it.
    const before = "// Normalises the code\nexport const a = 1;\n";
    const t = ChangeTask.parse({ ...task(["src/rates.ts"]), files: [{ path: "src/rates.ts", source: before, source_sha: "sha", errors: 1 }] });
    const reworded = "// Canonicalises the code\nexport const a = 2;\n";
    const seen = observe(t, candidate([{ path: "src/rates.ts", contents: reworded }]));
    expect(seen.map((o) => o.kind)).toEqual(["comment_text_changed"]);
    expect(seen[0]!.detail).toContain("Canonicalises");
  });

  it("does not report a reword on top of a removal, which would double-count one edit", () => {
    const before = "// one\n// two\nexport const a = 1;\n";
    const t = ChangeTask.parse({ ...task(["src/rates.ts"]), files: [{ path: "src/rates.ts", source: before, source_sha: "sha", errors: 1 }] });
    // A line goes, and the survivor is reworded. `comment_lines_removed` is the more specific finding.
    const both = "// ONE\nexport const a = 2;\n";
    expect(observe(t, candidate([{ path: "src/rates.ts", contents: both }])).map((o) => o.kind))
      .toEqual(["comment_lines_removed"]);
  });

  it("does not call a moved comment a change, because it compares a multiset", () => {
    const before = "// alpha\n// beta\nexport const a = 1;\n";
    const t = ChangeTask.parse({ ...task(["src/rates.ts"]), files: [{ path: "src/rates.ts", source: before, source_sha: "sha", errors: 1 }] });
    const moved = "// beta\n// alpha\nexport const a = 2;\n";
    expect(observe(t, candidate([{ path: "src/rates.ts", contents: moved }]))).toEqual([]);
  });

  it("exempts a dead_code ask, where removing the comments was the point", () => {
    const t = ChangeTask.parse({
      ...task(["src/rates.ts"]),
      shape: "dead_code",
      files: [{ path: "src/rates.ts", source: withComment, source_sha: "sha", errors: 1 }],
    });
    expect(observe(t, candidate([{ path: "src/rates.ts", contents: "export const a = 1;\n" }]))).toEqual([]);
  });
});
