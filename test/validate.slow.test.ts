// The expensive half of `validatePlan`: every exemplar compiled, run and mutated for real.
// SIDECREW_SLOW=1 to include. Needs `npm i` in fixtures/ts-fixture.
//
// This is the check the whole file exists for. An exemplar is the one thing in the plan the worker
// copies structurally, so an exemplar that does not survive teaches every candidate for that shape not
// to survive — and it does it quietly, twenty tasks later, in numbers that look like a bad model.
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validatePlan } from "../src/validate.js";

const PLAN = "fixtures/ts-fixture/plans/strings/test_plan.json";

const made: string[] = [];
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
});

/** The fixture's own plan, next to the fixture, with one exemplar swapped for whatever the case needs. */
const planWith = async (exemplarSource: string): Promise<string> => {
  const dir = await mkdtemp(join("fixtures/ts-fixture", ".validate-"));
  made.push(dir);
  await mkdir(join(dir, "exemplars"), { recursive: true });
  await copyFile("fixtures/ts-fixture/plans/strings/exemplars/boundary.test.ts", join(dir, "exemplars", "boundary.test.ts"));
  await writeFile(join(dir, "exemplars", "happy_path.test.ts"), exemplarSource, "utf8");

  const plan = JSON.parse(await (await import("node:fs/promises")).readFile(PLAN, "utf8")) as Record<string, unknown>;
  // `module` stays as the plan spells it — resolved against the working directory, as `loadPlan` does.
  const path = join(dir, "test_plan.json");
  await writeFile(path, JSON.stringify(plan, null, 2), "utf8");
  return path;
};

describe("validatePlan verifies the exemplars for real", () => {
  it("passes the fixture's own plan, and counts the exemplars it verified", async () => {
    const report = await validatePlan(PLAN);
    expect(report.errors).toEqual([]);
    expect(report.valid).toBe(true);
    expect(report.checked.exemplars).toBe(report.checked.shapes);
    expect(report.warnings.map((w) => w.code)).not.toContain("exemplars_not_verified");
  }, 300_000);

  it("fails a plan whose exemplar does not compile, and says which file and which stage", async () => {
    const path = await planWith(`import { describe, it, expect } from "vitest";
import { slugify } from "../src/strings";

describe("slugify", () => {
  it("does not compile", () => {
    expect(slugify(42)).toBe("hello");
  });
});
`);
    const report = await validatePlan(path);
    expect(report.valid).toBe(false);
    const failure = report.errors.find((e) => e.code === "exemplar_did_not_survive");
    expect(failure?.message).toMatch(/happy_path\.test\.ts tests slugify/);
    expect(failure?.message).toMatch(/reached compile/);
  }, 300_000);

  it("fails a plan whose exemplar is tautological — it compiles, it passes, and it says nothing", async () => {
    const path = await planWith(`import { describe, it, expect } from "vitest";
import { slugify } from "../src/strings";

describe("slugify", () => {
  it("asserts a constant", () => {
    slugify("Hello World");
    expect(true).toBe(true);
  });
});
`);
    const report = await validatePlan(path);
    expect(report.valid).toBe(false);
    expect(report.errors.find((e) => e.code === "exemplar_did_not_survive")?.message).toMatch(/tautological yes/);
  }, 300_000);
});
