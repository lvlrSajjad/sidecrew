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
import { isTestArtefact, isToolConfig, checkConfinement, codeLines, confinementMessage, observe } from "../src/confinement.js";
import { ChangeCandidate, ChangeTask, ConfinementRule, type ConfinementBreach } from "../src/schemas.js";
import { locateSymbols } from "../src/symbols.js";

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
  /** ADR-0086: a control for a symbol task's rules names the declarations its task is scoped to. */
  symbols?: string[];
  edits: { path: string; contents: string }[];
}

/** The same task, scoped to declarations in `src/rates.ts` the way `buildChangeTask` scopes one. */
const scoped = (t: ChangeTask, names: string[] | undefined): ChangeTask => {
  if (names === undefined) return t;
  const located = locateSymbols(t.files, names.map((name) => ({ file: "src/rates.ts", name })), "");
  if (!Array.isArray(located)) throw new Error(located.problem);
  return ChangeTask.parse({ ...t, symbols: located });
};

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
      const breaches = checkConfinement(scoped(task(["src/rates.ts"]), control.symbols), candidate(control.edits));
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

describe("documentation the ask did not call for — a breach since ADR-0054, 20 Sep 2026", () => {
  const withComment = "// why this is safe\n// second line\nexport const a = 1;\n";

  it("sees the deleted docblock the gate admitted, which is what ADR-0054 measured", () => {
    // The fixture case: a 7B deleted a 7-line docblock in 2 of 3 survivors while making a correct
    // one-line fix, and every clause of the gate passed. `max_deleted_lines: 0` did not catch it
    // because `codeLines` skips comments — deliberately, and its docstring used to claim the opposite.
    const t = ChangeTask.parse({ ...task(["src/rates.ts"]), files: [{ path: "src/rates.ts", source: withComment, source_sha: "sha", errors: 1 }] });
    const c = candidate([{ path: "src/rates.ts", contents: "export const a = 2;\n" }]);
    // The owner's call, 20 Sep 2026: "the gate must care about the reason behind doing a work even if
    // it's not documented on the disc." So this now REFUSES rather than merely recording.
    const breaches = checkConfinement(t, c);
    expect(breaches.map((b) => b.rule)).toContain("documentation_changed");
    expect(breaches.find((b) => b.rule === "documentation_changed")!.detail).toContain("2 comment line(s)");
    // ...and it is not double-reported as an observation, which would count one edit twice in any rate.
    expect(observe(t, c).map((o) => o.kind)).not.toContain("comment_lines_removed");
  });

  it("says nothing when the change kept the prose", () => {
    const t = ChangeTask.parse({ ...task(["src/rates.ts"]), files: [{ path: "src/rates.ts", source: withComment, source_sha: "sha", errors: 1 }] });
    const kept = withComment.replace("export const a = 1;", "export const a = 2;");
    const c = candidate([{ path: "src/rates.ts", contents: kept }]);
    expect(observe(t, c)).toEqual([]);
    expect(checkConfinement(t, c).map((b) => b.rule)).not.toContain("documentation_changed");
  });

  it("catches the stray blank line project-b's rejected diff added, whose twin was accepted", () => {
    // The control made the identical import removal without the extra line; the blind reviewer
    // accepted one and rejected the other without knowing which was which.
    const t = ChangeTask.parse({ ...task(["src/rates.ts"]), files: [{ path: "src/rates.ts", source: "export const a = 1;\n", source_sha: "sha", errors: 1 }] });
    const c = candidate([{ path: "src/rates.ts", contents: "export const a = 2;\n\n" }]);
    const churned = observe(t, c);
    expect(churned.map((o) => o.kind)).toEqual(["whitespace_churn"]);
    // Whitespace is still recorded and still does NOT gate. ADR-0054 is about documentation, and
    // killing a correct change over a blank line is the false-positive risk that option C warned of.
    expect(checkConfinement(t, c).map((b) => b.rule)).not.toContain("documentation_changed");
  });

  it("sees a rewording at constant volume — the case it was blind to (ADR-0068)", () => {
    // The exact measured case, twice over. Phase 11 sampled it once; Phase 11b then found it was the
    // **only** divergence between a local 7B and Opus across 19 real tasks — and all 19 verdicts
    // reported `observations: []`. Sensitivity 0/1 on the model's one reproducible behaviour, from a
    // mechanism that looked like it covered it.
    const before = "// Normalises the code\nexport const a = 1;\n";
    const t = ChangeTask.parse({ ...task(["src/rates.ts"]), files: [{ path: "src/rates.ts", source: before, source_sha: "sha", errors: 1 }] });
    const reworded = "// Canonicalises the code\nexport const a = 2;\n";
    const seen = checkConfinement(t, candidate([{ path: "src/rates.ts", contents: reworded }]));
    expect(seen.map((b) => b.rule)).toEqual(["documentation_changed"]);
    expect(seen[0]!.detail).toContain("Canonicalises");
  });

  it("does not report a reword on top of a removal, which would double-count one edit", () => {
    const before = "// one\n// two\nexport const a = 1;\n";
    const t = ChangeTask.parse({ ...task(["src/rates.ts"]), files: [{ path: "src/rates.ts", source: before, source_sha: "sha", errors: 1 }] });
    // A line goes, and the survivor is reworded. `comment_lines_removed` is the more specific finding.
    const both = "// ONE\nexport const a = 2;\n";
    expect(checkConfinement(t, candidate([{ path: "src/rates.ts", contents: both }])).map((b) => b.rule))
      .toEqual(["documentation_changed"]);
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

describe("a tool config is where it lives, not just what it is called — ADR-0070", () => {
  it("still refuses every real tool config, including the TypeScript ones", () => {
    // The direction of error is the whole decision: a false positive costs a task, a false negative
    // lets a worker reconfigure the gate judging it. Narrowing by EXTENSION — the obvious fix — would
    // have admitted every one of these, because the configs that matter here are TypeScript.
    for (const f of [
      "vitest.config.ts", "jest.config.ts", "jest.config.js", "playwright.config.ts",
      "stryker.config.js", "vite.config.mts", "eslint.config.js", "tailwind.config.ts",
      "webpack.config.cjs", "stryker.conf.json",
    ]) expect(isToolConfig(f)).toBe(true);
  });

  it("stops refusing ordinary source in a dotted-name convention", () => {
    // NestJS and Angular name files this way throughout. Two real tasks were written, validated
    // INVALID and dropped because `src/<domain>/<domain>.config.ts` matched the old shape-only rule.
    for (const f of [
      "src/exception/exception.config.ts",
      "src/exception/model/exception.config.model.ts",
      "src/modules/billing/billing.conf.ts",
    ]) expect(isToolConfig(f)).toBe(false);
  });

  it("stays eager at the project root, which is the safe direction", () => {
    // A root-level `app.config.ts` is still refused. That may cost a task; it cannot cost the gate.
    expect(isToolConfig("app.config.ts")).toBe(true);
    // And a tool's config parked in a subdirectory is still caught by its stem.
    expect(isToolConfig("config/vitest.config.ts")).toBe(true);
    expect(isToolConfig("packages/web/jest.config.js")).toBe(true);
  });

  it("is not fooled by a name that merely contains the word", () => {
    expect(isToolConfig("src/config.ts")).toBe(false);
    expect(isToolConfig("src/configuration.service.ts")).toBe(false);
    expect(isToolConfig("src/app.module.ts")).toBe(false);
  });
});

describe("a test file is a test file however the project spells it — ADR-0081", () => {
  // The task lists a synthetic path rather than a fixture, because the point is the NAME and the
  // fixture's own suite must not gain a file.
  const listing = (path: string): ChangeTask => ChangeTask.parse({
    task_id: "t", language: "typescript", test_framework: "vitest",
    ask: "Fix every TypeScript error in these files without changing what the code does.",
    files: [{ path, source: "export const a = 1;\n", source_sha: "sha", errors: 1 }],
    diagnostics: "", max_deleted_lines: 0, notes: null, attempt: 0, retry_of: null,
    previous_error: null, correction: null, shape: "null_guard",
  });
  const edit = (path: string): ChangeCandidate => ChangeCandidate.parse({
    task_id: "t", worker: { kind: "local", model: "m", revision: "r", temperature: 0, seed: 42 },
    edits: [{ path, contents: "export const a = 2;\n" }], unparsed: null, truncated: false,
    refusal: null, usage: { prompt_tokens: 1, completion_tokens: 1 }, timing: { ttft_ms: 1, wall_ms: 1 },
  });

  it("recognises the qualifier a project puts before spec or test", () => {
    // `app.e2e-spec.ts` is what `nest new` generates, and it was not a test file to any of the four
    // copies of this regex. Measured on a real NestJS codebase: 77 such files beside 354 `.spec.ts`.
    for (const f of [
      "test/app.e2e-spec.ts", "test/auth.e2e-spec.ts", "src/a.int-spec.ts",
      "src/a.integration.spec.ts", "src/a.type-test.ts", "test/foo.e2e-test.ts",
      "src/a.spec.ts", "src/a.test.ts", "src/a.spec.tsx", "src/a.test.mjs",
      "__tests__/a.ts", "__mocks__/a.ts", "x/__snapshots__/a.snap",
    ]) expect(isTestArtefact(f), f).toBe(true);
  });

  it("does not take an ordinary name that merely ends in those letters", () => {
    // A separator is required immediately before `spec`/`test`, which is what keeps the qualifier
    // from swallowing a source file. These are the words that would break it if it did not.
    for (const f of [
      "src/contest.ts", "src/latest.ts", "src/manifest.ts", "src/testing.ts",
      "src/spectrum.ts", "src/inspector.ts", "src/a.ts", "src/protest.tsx",
    ]) expect(isTestArtefact(f), f).toBe(false);
  });

  it("refuses the edit even when the plan lists the file — ADR-0048, and the hole it had", () => {
    // This is the rule that must not be switchable from a plan. Before ADR-0081 a task listing an
    // e2e spec produced NO breach at all: the candidate could edit the instrument the gate is.
    expect(rules(checkConfinement(listing("test/app.e2e-spec.ts"), edit("test/app.e2e-spec.ts"))))
      .toContain("test_file_edited");
    expect(rules(checkConfinement(listing("src/rates.int-spec.ts"), edit("src/rates.int-spec.ts"))))
      .toContain("test_file_edited");
  });

  it("is the only spelling of the pattern in src — a fifth copy is what let this survive", () => {
    // Four files held the same regex, they agreed on everything except the one case that mattered,
    // and nothing could show that because they agreed. This fails on a new copy rather than waiting
    // for the copies to disagree again (HANDOFF § Standing hazards: a fix to one is not a fix to both).
    const files = readdirSync("src", { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts"))
      .map((f) => join("src", f));
    const copies = files.filter((f) => /\(test\|spec\)/.test(readFileSync(f, "utf8")));
    expect(copies).toEqual(["src/confinement.ts"]);
  });
});
