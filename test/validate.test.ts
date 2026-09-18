// `validatePlan` — the structural half. Every case here runs with `verifyExemplars: false`, because
// the other half compiles and mutates real code and lives in `validate.slow.test.ts`.
//
// The thing being pinned is not "does it notice", it is **that it notices everything at once**. A
// validator that stops at the first problem is `loadPlan`, which already exists; this one exists so a
// planner can fix a plan in one pass, and a test that only ever feeds it one mistake would not catch
// the day it starts short-circuiting again.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validatePlan } from "../src/validate.js";
import { sourceSha } from "../src/plan.js";

const FIXTURE_PLAN = "fixtures/ts-fixture/plans/strings/test_plan.json";

const made: string[] = [];
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
});

const MODULE = `export function alpha(a: string): string {
  return a.trim();
}

export function beta(b: number): number {
  return b + 1;
}
`;

const codes = (issues: { code: string }[]): string[] => issues.map((i) => i.code);

/** A plan on disk with a module, an exemplar and whatever overrides the case is about. */
const scratchPlan = async (overrides: Record<string, unknown> = {}, files: Record<string, string> = {}): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "sidecrew-validate-"));
  made.push(dir);
  await mkdir(join(dir, "exemplars"), { recursive: true });
  await writeFile(join(dir, "package.json"), "{}", "utf8");
  await writeFile(join(dir, "mod.ts"), MODULE, "utf8");
  await writeFile(join(dir, "exemplars", "happy_path.test.ts"), "// exemplar\n", "utf8");
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text, "utf8");

  const plan = {
    version: 1,
    language: "typescript",
    module: "mod.ts",
    test_framework: "vitest",
    meta: { planner_model: "test", planner_tokens: 0, created: "2026-09-14T00:00:00.000Z" },
    shapes: [{ kind: "happy_path", exemplar: "exemplars/happy_path.test.ts", exemplar_function: "alpha", rules: "r" }],
    functions: [{
      name: "beta",
      signature: "beta(b: number): number",
      source_sha: sourceSha(MODULE.split("\n").slice(4, 7).join("\n")),
      line_range: [5, 7],
      shapes: ["happy_path"],
    }],
    ...overrides,
  };
  const path = join(dir, "test_plan.json");
  await writeFile(path, JSON.stringify(plan, null, 2), "utf8");
  return path;
};

const quick = (path: string) => validatePlan(path, { verifyExemplars: false });

describe("a plan that is fine", () => {
  it("is valid, counts what it checked, and warns that the expensive half did not run", async () => {
    const report = await quick(await scratchPlan());
    expect(report.errors).toEqual([]);
    expect(report.valid).toBe(true);
    expect(report.checked).toEqual({ functions: 1, shapes: 1, exemplars: 0 });
    // `checked.exemplars: 0` on its own would read as "there were none". The warning is what stops the
    // report claiming more than it did.
    expect(codes(report.warnings)).toEqual(["exemplars_not_verified"]);
  });

  it("validates the fixture plan the run actually uses", async () => {
    const report = await quick(FIXTURE_PLAN);
    expect(report.errors).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(report.checked.functions).toBeGreaterThan(0);
  });
});

describe("a plan that never gets as far as being a plan", () => {
  it("says so when the file is not JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sidecrew-validate-"));
    made.push(dir);
    const path = join(dir, "test_plan.json");
    await writeFile(path, "{ not json", "utf8");
    const report = await quick(path);
    expect(codes(report.errors)).toEqual(["unreadable_plan"]);
    expect(report.checked).toEqual({ functions: 0, shapes: 0, exemplars: 0 });
  });

  it("reports every schema failure, not the first, and names the field", async () => {
    const path = await scratchPlan({
      functions: [
        { name: "", signature: "s", source_sha: "x", line_range: [1, 2], shapes: ["happy_path"] },
        { name: "beta", signature: "", source_sha: "x", line_range: [1, 2], shapes: ["happy_path"] },
      ],
    });
    const report = await quick(path);
    expect(report.errors.length).toBe(2);
    expect(codes(report.errors)).toEqual(["schema", "schema"]);
    expect(report.errors.map((e) => e.where)).toEqual(["functions.0.name", "functions.1.signature"]);
  });

  it("explains a fourth shape in the taxonomy's own terms rather than as `too_big`", async () => {
    const path = await scratchPlan({
      functions: [{
        name: "beta", signature: "s", source_sha: "x", line_range: [5, 7],
        shapes: ["happy_path", "boundary", "async", "error_or_throw"],
      }],
    });
    const report = await quick(path);
    expect(report.errors[0]?.code).toBe("schema");
    expect(report.errors[0]?.message).toMatch(/at most 3 shapes per function/);
  });

  it("stops at a module it cannot find, because every other check reads it", async () => {
    const report = await quick(await scratchPlan({ module: "gone.ts" }));
    expect(codes(report.errors)).toEqual(["missing_module"]);
    expect(report.checked.functions).toBe(0);
  });
});

describe("the checks that would otherwise fail mid-run", () => {
  it("names an exemplar that is not on disk", async () => {
    const path = await scratchPlan({
      shapes: [{ kind: "happy_path", exemplar: "exemplars/gone.test.ts", exemplar_function: "alpha", rules: "r" }],
    });
    const report = await quick(path);
    expect(codes(report.errors)).toEqual(["missing_exemplar"]);
    expect(report.errors[0]?.where).toBe("shapes[0].exemplar");
  });

  it("catches a shape defined twice and a shape asked for but never defined", async () => {
    const path = await scratchPlan({
      shapes: [
        { kind: "happy_path", exemplar: "exemplars/happy_path.test.ts", exemplar_function: "alpha", rules: "r" },
        { kind: "happy_path", exemplar: "exemplars/happy_path.test.ts", exemplar_function: "alpha", rules: "r2" },
      ],
      functions: [{
        name: "beta", signature: "s", source_sha: sourceSha(MODULE.split("\n").slice(4, 7).join("\n")),
        line_range: [5, 7], shapes: ["boundary"],
      }],
    });
    const report = await quick(path);
    expect(codes(report.errors)).toEqual(["duplicate_shape", "undefined_shape"]);
  });

  it("catches a function listed twice", async () => {
    const sha = sourceSha(MODULE.split("\n").slice(4, 7).join("\n"));
    const fn = { name: "beta", signature: "s", source_sha: sha, line_range: [5, 7], shapes: ["happy_path"] };
    const report = await quick(await scratchPlan({ functions: [fn, fn] }));
    expect(codes(report.errors)).toContain("duplicate_function");
  });

  it("catches a line range that is not a range inside the module", async () => {
    const path = await scratchPlan({
      functions: [{ name: "beta", signature: "s", source_sha: "x", line_range: [5, 900], shapes: ["happy_path"] }],
    });
    const report = await quick(path);
    // And only that: a range off the end has no slice, so hashing it would be a second complaint
    // about the same mistake.
    expect(codes(report.errors)).toEqual(["bad_line_range"]);
  });

  it("catches a range that does not contain the declaration it claims to be", async () => {
    // The body without its `export function beta` line: it hashes to something, it is inside the file,
    // and mutating it would mutate lines belonging to nothing in particular (ADR-0013).
    const slice = MODULE.split("\n").slice(5, 6).join("\n");
    const path = await scratchPlan({
      functions: [{ name: "beta", signature: "s", source_sha: sourceSha(slice), line_range: [6, 6], shapes: ["happy_path"] }],
    });
    const report = await quick(path);
    expect(codes(report.errors)).toEqual(["range_not_function"]);
    expect(report.errors[0]?.message).toMatch(/\[5, 7\]/);
  });
});

describe("the things that are not errors", () => {
  it("treats a moved function as a warning and lists it in `stale` — the run is what refuses", async () => {
    const path = await scratchPlan({
      functions: [{ name: "beta", signature: "s", source_sha: "0".repeat(64), line_range: [5, 7], shapes: ["happy_path"] }],
    });
    const report = await quick(path);
    expect(report.valid).toBe(true);
    expect(report.stale).toEqual(["beta"]);
    expect(codes(report.warnings)).toContain("stale_source_sha");
  });

  it("warns about a shape no function asks for", async () => {
    const path = await scratchPlan({
      shapes: [
        { kind: "happy_path", exemplar: "exemplars/happy_path.test.ts", exemplar_function: "alpha", rules: "r" },
        { kind: "boundary", exemplar: "exemplars/happy_path.test.ts", exemplar_function: "alpha", rules: "r" },
      ],
    });
    const report = await quick(path);
    expect(report.valid).toBe(true);
    expect(codes(report.warnings)).toContain("unused_shape");
    expect(report.warnings.find((w) => w.code === "unused_shape")?.where).toBe("shapes[1].kind");
  });
});

describe("Swift's test target (ADR-0014)", () => {
  const swiftPlan = {
    language: "swift",
    module: "fixtures/swift-fixture/Sources/SwiftFixture/Strings.swift",
    test_framework: "xctest",
  };

  it("refuses a multi-target package the plan names no target for, before the first token", async () => {
    const path = await scratchPlan({
      ...swiftPlan,
      shapes: [{ kind: "happy_path", exemplar: "exemplars/happy_path.test.ts", exemplar_function: "slugify", rules: "r" }],
      functions: [{ name: "slugify", signature: "s", source_sha: "x", line_range: [1, 2], shapes: ["happy_path"] }],
    });
    const report = await quick(path);
    expect(codes(report.errors)).toContain("ambiguous_test_target");
    expect(report.errors.find((e) => e.code === "ambiguous_test_target")?.message).toMatch(/SwiftFixtureTests/);
  });

  it("refuses a target the package does not have", async () => {
    const path = await scratchPlan({
      ...swiftPlan,
      test_target: "NotATarget",
      shapes: [{ kind: "happy_path", exemplar: "exemplars/happy_path.test.ts", exemplar_function: "slugify", rules: "r" }],
      functions: [{ name: "slugify", signature: "s", source_sha: "x", line_range: [1, 2], shapes: ["happy_path"] }],
    });
    const report = await quick(path);
    expect(codes(report.errors)).toContain("unknown_test_target");
  });

  it("accepts the target the package does have", async () => {
    const path = await scratchPlan({
      ...swiftPlan,
      test_target: "SwiftFixtureXCTests",
      shapes: [{ kind: "happy_path", exemplar: "exemplars/happy_path.test.ts", exemplar_function: "slugify", rules: "r" }],
      functions: [{ name: "slugify", signature: "s", source_sha: "x", line_range: [1, 2], shapes: ["happy_path"] }],
    });
    const report = await quick(path);
    expect(codes(report.errors)).not.toContain("unknown_test_target");
    expect(codes(report.errors)).not.toContain("ambiguous_test_target");
  });
});

describe("when the exemplars are not verified", () => {
  it("says which errors stopped it, rather than reporting zero exemplars with no reason", async () => {
    // Default opts: verification is on, and is skipped because there is a structural error to fix first.
    const report = await validatePlan(await scratchPlan({ module: "mod.ts", shapes: [
      { kind: "happy_path", exemplar: "exemplars/gone.test.ts", exemplar_function: "alpha", rules: "r" },
    ] }));
    expect(codes(report.errors)).toEqual(["missing_exemplar"]);
    const skipped = report.warnings.find((w) => w.code === "exemplars_not_verified");
    expect(skipped?.message).toMatch(/1 error above has to be fixed/);
  });
});
