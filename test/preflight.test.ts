// `doctor`'s pre-flight rows — Phase 14.
//
// Every one of these was a run that failed, or worse, a run that quietly succeeded. What they have in
// common is that the question "is it installed" answers yes for all of them: the defect is one layer
// down, in how a particular project is laid out. So the thing each test has to prove is not that the
// row exists but that it **separates** the good layout from the bad one — a row that says DEGRADED
// everywhere is as useless as one that says ok everywhere.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { heapCheck, lineRangeCheck, tsconfigIncludeCheck, tsJestCheck, jestTestsCheck } from "../src/doctor.js";
import { tsconfigProgramFiles } from "../src/verifier/ast.js";

const made: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A project on disk: a package.json, a tsconfig with the given `include`, and one file per path. */
async function project(opts: {
  include?: string[]; scripts?: Record<string, string>; files?: Record<string, string>;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sidecrew-preflight-"));
  made.push(dir);
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "p", scripts: opts.scripts ?? {} }), "utf8");
  if (opts.include !== undefined) {
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: opts.include }), "utf8");
  }
  for (const [path, body] of Object.entries(opts.files ?? {})) {
    await mkdir(join(dir, path.split("/").slice(0, -1).join("/")), { recursive: true });
    await writeFile(join(dir, path), body, "utf8");
  }
  return dir;
}

// ── ADR-0037: the compile stage that never opened the candidate ────────────────────────────────────

describe("tsconfig-include", () => {
  it("passes a project whose include covers the directory candidates go in", async () => {
    const dir = await project({ include: ["src", "test"], files: { "src/a.ts": "export const a = 1;\n", "test/a.test.ts": "export {};\n" } });
    const check = tsconfigIncludeCheck(dir);
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("test/");
  });

  it("names the failure when the include does not cover it, and gives the one-line fix", async () => {
    // The shape a real React project had: `testDirFor` returns `test/`, `include` is `["src"]`, and
    // `tsc --noEmit -p tsconfig.json` type-checks the project without ever opening the candidate.
    const dir = await project({ include: ["src"], files: { "src/a.ts": "export const a = 1;\n", "test/a.test.ts": "export {};\n" } });
    const check = tsconfigIncludeCheck(dir);
    expect(check.status).toBe("degraded");
    expect(check.detail).toContain("ADR-0037");
    expect(check.detail).toContain('add "test" to include');
  });

  it("says a missing test directory is unknown rather than covered", async () => {
    const dir = await project({ include: ["src"], files: { "src/a.ts": "export const a = 1;\n" } });
    const check = tsconfigIncludeCheck(dir);
    expect(check.status).toBe("degraded");
    expect(check.detail).toContain("does not have");
  });

  it("says nothing about a project with no tsconfig at all", async () => {
    const dir = await project({ files: { "a.js": "module.exports = 1;\n" } });
    expect(tsconfigIncludeCheck(dir).status).toBe("ok");
  });
});

describe("tsconfigProgramFiles", () => {
  it("is the compiler's own answer, `extends` chain and all", async () => {
    const dir = await project({ include: ["src"], files: { "src/a.ts": "export const a = 1;\n", "test/a.test.ts": "export {};\n" } });
    await writeFile(join(dir, "wide.json"), JSON.stringify({ extends: "./tsconfig.json", include: ["src", "test"] }), "utf8");

    const narrow = tsconfigProgramFiles(join(dir, "tsconfig.json"), dir) ?? [];
    const wide = tsconfigProgramFiles(join(dir, "wide.json"), dir) ?? [];
    expect(narrow.some((f) => f.endsWith("a.test.ts"))).toBe(false);
    expect(wide.some((f) => f.endsWith("a.test.ts"))).toBe(true);
  });

  it("is null, not empty, when the question cannot be answered", async () => {
    const dir = await project({ files: {} });
    // An empty program and an unanswerable question are different facts, and a caller that conflates
    // them reports "your include covers nothing" about a project that has no tsconfig.
    expect(tsconfigProgramFiles(join(dir, "tsconfig.json"), dir)).toBeNull();
  });
});

// ── ADR-0032: a machine limit wearing a compiler error's clothes ────────────────────────────────────

describe("tsc-heap", () => {
  it("reads the project's own number and says this process is not carrying it", async () => {
    const dir = await project({ scripts: { checkTs: "NODE_OPTIONS=--max-old-space-size=8192 tsc --noEmit" } });
    const check = heapCheck(dir, {});
    expect(check.status).toBe("degraded");
    expect(check.detail).toContain("--max-old-space-size=8192 sidecrew run");
  });

  it("is satisfied when the environment already carries at least that much", async () => {
    const dir = await project({ scripts: { checkTs: "NODE_OPTIONS=--max-old-space-size=8192 tsc --noEmit" } });
    expect(heapCheck(dir, { NODE_OPTIONS: "--max-old-space-size=8192" }).status).toBe("ok");
    expect(heapCheck(dir, { NODE_OPTIONS: "--max-old-space-size=12288" }).status).toBe("ok");
  });

  it("asks for nothing when the project asks for nothing", async () => {
    const dir = await project({ scripts: { test: "vitest run" } });
    expect(heapCheck(dir, {}).status).toBe("ok");
  });
});

// ── ADR-0038 / ADR-0036: the mutation stage dying on Stryker's own instrumentation ──────────────────

describe("ts-jest", () => {
  it("has nothing to say about a project that does not use ts-jest", async () => {
    const dir = await project({ include: ["src"] });
    const check = tsJestCheck(dir);
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("not needed");
  });
});

// ── the fourth, found in Phase 14: a suite that collects nothing ────────────────────────────────────

describe("jest-tests", () => {
  it("says nothing about a project whose runner is not jest", async () => {
    const dir = await project({ include: ["src"] });
    const check = await jestTestsCheck(dir);
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("not this project's runner");
  });
});

// ── ADR-0076: which implementation is finding line ranges ───────────────────────────────────────────

describe("line-ranges", () => {
  it("reports the compiler when it can be reached", () => {
    const check = lineRangeCheck(process.cwd());
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("compiler");
  });

  it("has nothing to range in a project with no tsconfig", async () => {
    const dir = await project({ files: { "a.js": "module.exports = 1;\n" } });
    expect(lineRangeCheck(dir).status).toBe("ok");
  });
});
