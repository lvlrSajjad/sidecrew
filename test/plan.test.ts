// A `TestPlan` on disk → the things the worker and the verifiers need. The joins that are not in the
// contract are the ones worth pinning: the project root, the import hint, and what a stale plan is.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import {
  buildTask,
  buildTasks,
  exportStyleFor,
  findProjectRoot,
  functionOfTaskId,
  importsHint,
  loadPlan,
  PlanError,
  rangeFor,
  runnerFor,
  sliceLines,
  sourceSha,
  staleFunctions,
  swiftTargetFor,
  taskId,
  testDirFor,
  tsTargetFor,
  wantsJsExtension,
  type LoadedPlan,
} from "../src/plan.js";
import { Candidate, TestPlan } from "../src/schemas.js";

const FIXTURE_PLAN = "fixtures/ts-fixture/plans/strings/test_plan.json";

const made: string[] = [];
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
});

const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "sidecrew-plan-"));
  made.push(dir);
  return dir;
};

const candidate = (task_id: string): Candidate => Candidate.parse({
  task_id,
  worker: { kind: "local", model: "m", revision: "r", temperature: 0, seed: 1 },
  test_source: "",
  usage: { prompt_tokens: 0, completion_tokens: 0 },
  timing: { ttft_ms: 0, wall_ms: 0 },
});

describe("sourceSha and sliceLines", () => {
  it("slices 1-based and inclusive, as line_range records it", () => {
    expect(sliceLines("a\nb\nc\nd", [2, 3])).toBe("b\nc");
    expect(sliceLines("a\nb\nc\nd", [1, 1])).toBe("a");
  });

  it("is sha-256 hex of exactly that slice", () => {
    expect(sourceSha("b\nc")).toMatch(/^[0-9a-f]{64}$/);
    expect(sourceSha("b\nc")).toBe(sourceSha(sliceLines("a\nb\nc\nd", [2, 3])));
  });
});

describe("findProjectRoot", () => {
  it("walks up to the nearest package.json", async () => {
    const dir = await scratch();
    await mkdir(join(dir, "src", "deep"), { recursive: true });
    await writeFile(join(dir, "package.json"), "{}", "utf8");
    await writeFile(join(dir, "src", "deep", "x.ts"), "", "utf8");
    expect(findProjectRoot(join(dir, "src", "deep", "x.ts"), "typescript")).toBe(dir);
  });

  it("says what it was looking for rather than guessing a root", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "x.ts"), "", "utf8");
    expect(() => findProjectRoot(join(dir, "x.ts"), "typescript")).toThrow(/no package.json above/);
  });

  it("refuses a language neither verifier drives", async () => {
    expect(() => findProjectRoot("a/b.py", "python")).toThrow(/no verifier for python/);
  });
});

describe("importsHint", () => {
  it("is relative to where the candidate is about to be written", async () => {
    const loaded = await loadPlan(FIXTURE_PLAN);
    const fn = loaded.plan.functions[0]!;
    expect(importsHint(loaded, fn)).toBe(`import { ${fn.name} } from "../src/strings";`);
  });

  it("adds the .js a NodeNext project demands, and only then", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "tsconfig.json"), '{ "compilerOptions": { "moduleResolution": "NodeNext" } }', "utf8");
    expect(wantsJsExtension(dir)).toBe(true);
    await writeFile(join(dir, "tsconfig.json"), '{ "compilerOptions": { "moduleResolution": "Bundler" } }', "utf8");
    expect(wantsJsExtension(dir)).toBe(false);
    // A tsconfig we cannot read means the common case, not a crash.
    expect(wantsJsExtension(join(dir, "nowhere"))).toBe(false);
  });

  it("reaches a Swift module's internals through @testable", async () => {
    const loaded = {
      plan: TestPlan.parse({ ...swiftPlan }),
      planPath: "/p/test_plan.json",
      modulePath: "/p/Sources/SwiftFixture/Strings.swift",
      projectDir: "/p",
      sourceFile: "Sources/SwiftFixture/Strings.swift",
      source: "",
      exemplars: new Map(),
    } satisfies LoadedPlan;
    expect(importsHint(loaded, loaded.plan.functions[0]!)).toBe("@testable import SwiftFixture");
  });
});

const swiftPlan = {
  version: 1,
  language: "swift",
  module: "Sources/SwiftFixture/Strings.swift",
  test_framework: "xctest",
  meta: { planner_model: "m", planner_tokens: 0, created: "2026-09-14T00:00:00.000Z" },
  shapes: [{ kind: "happy_path", exemplar: "e.swift", exemplar_function: "f", rules: "r" }],
  functions: [{ name: "slugify", signature: "slugify(_ s: String) -> String", source_sha: "x", line_range: [1, 2], shapes: ["happy_path"] }],
};

describe("loadPlan", () => {
  it("resolves the module, the project root and every exemplar", async () => {
    const loaded = await loadPlan(FIXTURE_PLAN);
    expect(loaded.projectDir.endsWith("fixtures/ts-fixture")).toBe(true);
    expect(loaded.sourceFile).toBe("src/strings.ts");
    expect([...loaded.exemplars.keys()].sort()).toEqual(["boundary", "happy_path"]);
    expect(loaded.exemplars.get("happy_path")).toContain("import { slugify }");
  });

  it("names both places it looked for a module that is not there", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "plan.json"), JSON.stringify({ ...swiftPlan, module: "nowhere/x.swift" }), "utf8");
    await expect(loadPlan(join(dir, "plan.json"))).rejects.toThrow(/is not on disk — looked in .* and /);
  });

  it("refuses a plan whose exemplar is not on disk", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "package.json"), "{}", "utf8");
    await writeFile(join(dir, "x.ts"), "export function f(): number { return 1; }\n", "utf8");
    await writeFile(join(dir, "plan.json"), JSON.stringify({
      ...swiftPlan, language: "typescript", module: "x.ts", test_framework: "vitest",
      shapes: [{ kind: "happy_path", exemplar: "exemplars/gone.test.ts", exemplar_function: "slugify", rules: "r" }],
      functions: [{ name: "f", signature: "f(): number", source_sha: "x", line_range: [1, 1], shapes: ["happy_path"] }],
    }), "utf8");
    await expect(loadPlan(join(dir, "plan.json"))).rejects.toThrow(/exemplar for happy_path is not on disk/);
  });

  it("says which field made it not a TestPlan", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "plan.json"), '{ "version": 2 }', "utf8");
    await expect(loadPlan(join(dir, "plan.json"))).rejects.toThrow(PlanError);
  });
});

describe("staleFunctions", () => {
  it("is empty for a plan that describes the code on disk", async () => {
    const loaded = await loadPlan(FIXTURE_PLAN);
    expect(staleFunctions(loaded.plan, loaded.source)).toEqual([]);
  });

  it("names a function whose body has moved under it", async () => {
    const loaded = await loadPlan(FIXTURE_PLAN);
    // One character, in the first planned function's range. A stale line_range mutates the wrong
    // lines (ADR-0013), so this is the check that has to fire.
    const [from] = loaded.plan.functions[0]!.line_range;
    const lines = loaded.source.split("\n");
    lines[from] = `${lines[from]} `;
    const stale = staleFunctions(loaded.plan, lines.join("\n"));
    expect(stale.map((s) => s.name)).toContain(loaded.plan.functions[0]!.name);
  });
});

describe("buildTask", () => {
  it("carries the function's own source, the exemplar's text, and nothing about a retry", async () => {
    const loaded = await loadPlan(FIXTURE_PLAN);
    const fn = loaded.plan.functions.find((f) => f.name === "commonPrefix")!;
    const task = buildTask(loaded, fn, "boundary");
    expect(task.task_id).toBe("commonPrefix:boundary:0");
    expect(task.function.source).toContain("export function commonPrefix");
    expect(task.function.source).not.toContain("export function slugify");
    expect(task.exemplar_source).toBe(loaded.exemplars.get("boundary"));
    expect(task.retry_of).toBeNull();
    expect(task.previous_error).toBeNull();
  });

  it("puts the first attempt's id and error on the retry", async () => {
    const loaded = await loadPlan(FIXTURE_PLAN);
    const fn = loaded.plan.functions[0]!;
    const retry = buildTask(loaded, fn, "happy_path", { attempt: 1, retryOf: taskId(fn.name, "happy_path"), previousError: "boom" });
    expect(retry.task_id).toBe(`${fn.name}:happy_path:1`);
    expect(retry.retry_of).toBe(`${fn.name}:happy_path:0`);
    expect(retry.previous_error).toBe("boom");
  });

  it("builds one task per function × shape, in plan order", async () => {
    const loaded = await loadPlan(FIXTURE_PLAN);
    const tasks = buildTasks(loaded);
    expect(tasks).toHaveLength(loaded.plan.functions.reduce((n, f) => n + f.shapes.length, 0));
    expect(new Set(tasks.map((t) => t.task_id)).size).toBe(tasks.length);
  });

  it("refuses a shape the plan never defined", async () => {
    const loaded = await loadPlan(FIXTURE_PLAN);
    expect(() => buildTask(loaded, loaded.plan.functions[0]!, "async")).toThrow(/does not define/);
  });
});

describe("task ids", () => {
  it("round-trip the function name, which is how verify knows what to check", () => {
    expect(functionOfTaskId(taskId("slugify", "boundary", 1))).toBe("slugify");
  });
});

describe("rangeFor", () => {
  it("prefers the plan, which knows the range from the module the planner read", async () => {
    const loaded = await loadPlan(FIXTURE_PLAN);
    const fn = loaded.plan.functions[0]!;
    expect(rangeFor(loaded, fn.name)).toEqual(fn.line_range);
  });

  it("falls back to the module for an exemplar's function, which the plan deliberately omits", async () => {
    const loaded = await loadPlan(FIXTURE_PLAN);
    expect(loaded.plan.functions.map((f) => f.name)).not.toContain("slugify");
    expect(rangeFor(loaded, "slugify")).toEqual([7, 14]);
  });

  it("throws on a name neither the plan nor the module has, instead of mutating the whole file", async () => {
    const loaded = await loadPlan(FIXTURE_PLAN);
    expect(() => rangeFor(loaded, "slugfy")).toThrow(/neither .* has a function called slugfy/);
  });
});

describe("targets", () => {
  it("scopes TypeScript mutation to the planned range and lands the candidate where vitest looks", async () => {
    const loaded = await loadPlan(FIXTURE_PLAN);
    const target = tsTargetFor(loaded, "commonPrefix", candidate("commonPrefix:boundary:0"));
    expect(target).toMatchObject({ sourceFile: "src/strings.ts", functionName: "commonPrefix" });
    expect(target.lineRange).toEqual(loaded.plan.functions.find((f) => f.name === "commonPrefix")!.line_range);
    expect(target.testFile).toBe(`${testDirFor(loaded.projectDir)}/commonPrefix.boundary.0.test.ts`);
  });

  it("leaves the Swift test target unset when nothing names one, so the verifier refuses by name", async () => {
    // ADR-0014: a package with several test targets cannot be guessed at, and the failure has to be a
    // setup error naming them rather than a candidate written into whichever target came first.
    const loaded = {
      plan: TestPlan.parse(swiftPlan), planPath: "/p/plan.json", modulePath: "/p/Sources/SwiftFixture/Strings.swift",
      projectDir: "/p", sourceFile: "Sources/SwiftFixture/Strings.swift", source: "", exemplars: new Map(),
    } satisfies LoadedPlan;
    expect(swiftTargetFor(loaded, "slugify", candidate("slugify:happy_path:0")).testTarget).toBeUndefined();
  });

  it("lets the plan name the test target, and the call site override the plan", async () => {
    const withTarget = { ...swiftPlan, test_target: "SwiftFixtureTests" };
    const loaded = {
      plan: TestPlan.parse(withTarget), planPath: "/p/plan.json", modulePath: "/p/Sources/SwiftFixture/Strings.swift",
      projectDir: "/p", sourceFile: "Sources/SwiftFixture/Strings.swift", source: "", exemplars: new Map(),
    } satisfies LoadedPlan;
    const c = candidate("slugify:happy_path:0");
    expect(swiftTargetFor(loaded, "slugify", c).testTarget).toBe("SwiftFixtureTests");
    expect(swiftTargetFor(loaded, "slugify", c, { testTarget: "SwiftFixtureXCTests" }).testTarget).toBe("SwiftFixtureXCTests");
  });

  it("refuses a framework the Swift verifier cannot drive", async () => {
    const loaded = {
      plan: TestPlan.parse({ ...swiftPlan, test_framework: "quick" }), planPath: "/p/plan.json",
      modulePath: "/p/Sources/SwiftFixture/Strings.swift", projectDir: "/p",
      sourceFile: "Sources/SwiftFixture/Strings.swift", source: "", exemplars: new Map(),
    } satisfies LoadedPlan;
    expect(() => swiftTargetFor(loaded, "slugify", candidate("slugify:happy_path:0"))).toThrow(/not quick/);
  });
});

describe("runnerFor — ADR-0028", () => {
  it("maps the two frameworks the verifier can drive", () => {
    expect(runnerFor("vitest")).toBe("vitest");
    expect(runnerFor("jest")).toBe("jest");
  });

  it("refuses one it cannot, by name, rather than failing three stages later", () => {
    // `TestFramework` is an open string in the contract on purpose — the schema must not refuse a
    // project before the verifier has said whether it can handle it. This is the verifier saying so.
    expect(() => runnerFor("ava")).toThrow(/drives vitest and jest, not ava/);
    expect(() => runnerFor("mocha")).toThrow(PlanError);
  });

  it("is what tsTargetFor puts on the target", async () => {
    const jestPlan = await loadPlan("fixtures/jest-fixture/plans/strings/test_plan.json");
    const vitestPlan = await loadPlan("fixtures/ts-fixture/plans/strings/test_plan.json");
    const candidate = { task_id: "truncate:boundary:0" } as Parameters<typeof tsTargetFor>[2];
    expect(tsTargetFor(jestPlan, "truncate", candidate).runner).toBe("jest");
    expect(tsTargetFor(vitestPlan, "truncate", candidate).runner).toBe("vitest");
  });
});

describe("exportStyleFor and the import hint — ADR-0033", () => {
  it("reads a named export as a named import", () => {
    expect(exportStyleFor("export function f(a: number) { return a; }", "f")).toEqual({ kind: "named" });
    expect(exportStyleFor("export const f = (v: unknown) => [v];", "f")).toEqual({ kind: "named" });
    expect(exportStyleFor("function f() {}\nexport { f };", "f")).toEqual({ kind: "named" });
  });

  it("reads the NestJS idiom as a default import of the class", () => {
    // Measured: on a real NestJS codebase 1,465 of ~1,504 functions are static members of a
    // default-exported class and have no named export at all.
    const source = "export default class AssetUtil {\n  static f(a: number) { return a; }\n}";
    expect(exportStyleFor(source, "f")).toEqual({ kind: "default", local: "AssetUtil" });
    expect(exportStyleFor("class AssetUtil {}\nexport default AssetUtil;", "f"))
      .toEqual({ kind: "default", local: "AssetUtil" });
  });

  it("prefers the named export when a module has both", () => {
    expect(exportStyleFor("export function f() {}\nexport default class C {}", "f")).toEqual({ kind: "named" });
  });

  it("reads a named class export as a named import of the class — ADR-0040", () => {
    // `export class ImportFileUtils { static hasCellContent() {} }` — the class is exported, the member
    // is not, so neither branch above fired and the fallback emitted `import { hasCellContent }`, which
    // cannot compile. Measured: all 8 tasks of one module carried that hint.
    const source = "export class ImportFileUtils {\n  static hasCellContent(v: string) { return v.length > 0; }\n}";
    expect(exportStyleFor(source, "hasCellContent")).toEqual({ kind: "namedClass", local: "ImportFileUtils" });
    expect(exportStyleFor("export abstract class U {\n  static f() {}\n}", "f"))
      .toEqual({ kind: "namedClass", local: "U" });
  });

  it("names the class that actually declares the member when a module exports several", () => {
    const source = [
      "export class A {",
      "  static alpha() { return 1; }",
      "}",
      "export class B {",
      "  static beta() { return 2; }",
      "}",
    ].join("\n");
    expect(exportStyleFor(source, "beta")).toEqual({ kind: "namedClass", local: "B" });
    expect(exportStyleFor(source, "alpha")).toEqual({ kind: "namedClass", local: "A" });
  });

  it("falls back to a named import rather than inventing one", () => {
    expect(exportStyleFor("const x = 1;", "f")).toEqual({ kind: "named" });
    // A class that does not declare the member must not be named just because it is exported.
    expect(exportStyleFor("export class A {\n  static other() {}\n}", "f")).toEqual({ kind: "named" });
  });

  it("makes the hint agree with the exemplar instead of contradicting it", async () => {
    // The defect this is here for: the prompt carried `import { getNetBookValue } from …` for a module
    // with no named export, ten lines above an exemplar importing correctly — and 18 of 20 candidates
    // followed the wrong instruction over the right example.
    const loaded = await loadPlan(FIXTURE_PLAN);
    const fn = loaded.plan.functions[0]!;
    expect(importsHint(loaded, fn)).toMatch(/^import \{ /);

    const asDefault = { ...loaded, source: "export default class AssetUtil {\n  static truncate() {}\n}" };
    expect(importsHint(asDefault, fn)).toMatch(/^import AssetUtil from /);
    expect(importsHint(asDefault, fn)).not.toContain("{");
  });
});
