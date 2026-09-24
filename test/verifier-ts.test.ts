// The parts of the TypeScript verifier that can be checked without a toolchain: the report parser, the
// sandbox rules, the range finder, and the config the fixture and the verifier have to agree on.
// The pipeline itself is `verifier-ts.slow.test.ts`.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { testSuffixFor } from "../src/plan.js";
import {
  noKillMessage, uncountedStatuses,
  JEST_CONFIG_FILES,
  MUTATION_REPORT,
  NEVER_COPY,
  STRYKER_PLUGIN,
  TEST_FILE_PATTERN,
  TEST_RUNNERS,
  derivedTsconfig,
  deriveLineRange,
  jestConfigEntry,
  jestConfigShim,
  stripFileList,
  rescuedFromTestName,
  SIDECREW_JEST_CONFIG,
  detectJestConfig,
  isTestRunner,
  makeSandbox,
  parseMutationReport,
  looksLikeOom,
  runArgs,
  skipFromSandbox,
  strykerConfig,
  truncateError,
} from "../src/verifier/ts.js";
import { MAX_ERROR_CHARS, MutationResult } from "../src/schemas.js";

const FIXTURES = "fixtures/ts-fixture";

const report = (statuses: string[], file = "src/strings.ts") => ({
  schemaVersion: "1.0",
  files: { [file]: { mutants: statuses.map((status, i) => ({ id: String(i), status })) } },
});

describe("parseMutationReport", () => {
  it("counts the four statuses that say something about the test", () => {
    const r = parseMutationReport(report(["Killed", "Killed", "Survived", "Timeout", "NoCoverage"]));
    expect(r.killed).toBe(2);
    expect(r.survived).toBe(1);
    expect(r.timeout).toBe(1);
    expect(r.no_coverage).toBe(1);
    expect(r.killed_ids).toEqual(["0", "1"]);
  });

  it("ignores the statuses that are Stryker talking about itself", () => {
    const r = parseMutationReport(report(["Killed", "CompileError", "RuntimeError", "Ignored", "Pending"]));
    expect(r).toMatchObject({ killed: 1, survived: 0, timeout: 0, no_coverage: 0, score: 1 });
  });

  it("scores a timeout as a kill and a never-reached mutant as a miss", () => {
    // The mutation-testing standard, so our scores stay comparable with everybody else's.
    expect(parseMutationReport(report(["Killed", "Timeout", "Survived", "NoCoverage"])).score).toBe(0.5);
    expect(parseMutationReport(report(["Killed", "Survived"])).score).toBe(0.5);
    expect(parseMutationReport(report(["Killed", "NoCoverage", "NoCoverage"])).score).toBeCloseTo(1 / 3);
  });

  it("counts a timeout towards the score but never towards survival", () => {
    // CLAUDE.md #2 wants a killed mutant. A mutant that hung the suite is not one.
    const r = parseMutationReport(report(["Timeout", "Timeout"]));
    expect(r.score).toBe(1);
    expect(r.killed).toBe(0);
    expect(r.killed_ids).toEqual([]);
  });

  it("scores an empty report 0 rather than dividing by nothing", () => {
    expect(parseMutationReport(report([])).score).toBe(0);
    expect(parseMutationReport({}).score).toBe(0);
    expect(parseMutationReport(null).killed).toBe(0);
  });

  it("counts only the file under test when the report holds several", () => {
    const many = {
      files: {
        "src/strings.ts": { mutants: [{ id: "0", status: "Killed" }] },
        "src/arrays.ts": { mutants: [{ id: "1", status: "Killed" }, { id: "2", status: "Survived" }] },
      },
    };
    expect(parseMutationReport(many, "src/arrays.ts")).toMatchObject({ killed: 1, survived: 1, killed_ids: ["1"] });
    expect(parseMutationReport(many, "src/strings.ts")).toMatchObject({ killed: 1, survived: 0 });
  });

  it("falls back to every file rather than reporting nothing when the name does not match", () => {
    // A path spelled differently is still a report about the run we just did; "killed nothing" is not.
    expect(parseMutationReport(report(["Killed"]), "src/elsewhere.ts").killed).toBe(1);
  });

  it("always produces something the contract accepts", () => {
    expect(MutationResult.safeParse(parseMutationReport(report(["Killed", "Survived", "NoCoverage"]))).success).toBe(true);
  });
});

describe("truncateError", () => {
  it("strips the colour codes a terminal reporter leaves behind", () => {
    expect(truncateError("[31mTS2307: Cannot find module[39m")).toBe("TS2307: Cannot find module");
  });

  it("keeps short errors whole", () => {
    expect(truncateError("  error: nope\n")).toBe("error: nope");
  });

  it("caps at the contract's limit, keeping the head", () => {
    const long = `${"the reason\n".repeat(500)}`;
    const cut = truncateError(long);
    expect(cut.length).toBeLessThanOrEqual(MAX_ERROR_CHARS);
    expect(cut.startsWith("the reason")).toBe(true);
    expect(cut).toContain("truncated");
  });
});

describe("deriveLineRange", () => {
  it("finds a function's first and last line", async () => {
    const source = await readFile(`${FIXTURES}/src/strings.ts`, "utf8");
    const lines = source.split("\n");
    const [start, end] = deriveLineRange(source, "truncate") ?? [0, 0];
    expect(lines[start - 1]).toContain("export function truncate");
    expect(lines[end - 1]).toBe("}");
  });

  it("handles an async function and one that is not the first in the file", async () => {
    const source = await readFile(`${FIXTURES}/src/async.ts`, "utf8");
    const range = deriveLineRange(source, "firstSuccessful");
    expect(range).not.toBeNull();
    expect(source.split("\n")[(range?.[0] ?? 1) - 1]).toContain("export async function firstSuccessful");
  });

  it("is not fooled by a brace inside a string or a comment", () => {
    const source = 'export function f(): string {\n  // }\n  return "}";\n}\nexport function g(): number {\n  return 1;\n}\n';
    expect(deriveLineRange(source, "f")).toEqual([1, 4]);
  });

  it("returns null rather than guessing when the function is not there", () => {
    expect(deriveLineRange("export function other() {}\n", "slugify")).toBeNull();
  });
});

describe("strykerConfig", () => {
  it("is exactly what the fixture has checked in", async () => {
    // The fixture's copy exists so a human can run `npx stryker run` by hand and see what the verifier
    // sees. A copy that drifted would answer a different question from the one being debugged.
    expect(await readFile(`${FIXTURES}/stryker.config.mjs`, "utf8")).toBe(strykerConfig());
  });

  it("keeps the four settings the verifier depends on", () => {
    const config = strykerConfig();
    expect(config).toContain('reporters: ["json"]');
    expect(config).toContain(`jsonReporter: { fileName: ${JSON.stringify(MUTATION_REPORT)} }`);
    expect(config).toContain("disableTypeChecks: false");
    expect(config).toContain("break: null");
  });

  it("takes the tsconfig and the concurrency from the caller", () => {
    expect(strykerConfig({ tsconfig: "tsconfig.build.json", concurrency: 1 })).toContain('tsconfigFile: "tsconfig.build.json"');
    expect(strykerConfig({ concurrency: 1 })).toContain("concurrency: 1");
  });

  it("names symlinked directories in ignorePatterns, and says nothing when there are none", () => {
    // Stryker's own sandbox copy dies with ENOTSUP on a symlinked directory — observed on two runs of
    // the same project a day apart, a hard stop before any candidate is judged (ADR-0035).
    expect(strykerConfig()).not.toContain("ignorePatterns");
    expect(strykerConfig({ ignorePatterns: [] })).not.toContain("ignorePatterns");
    expect(strykerConfig({ ignorePatterns: [".claude/agents", ".claude/skills"] }))
      .toContain('ignorePatterns: [".claude/agents",".claude/skills"]');
  });

  it("never points the incremental file outside the sandbox", () => {
    // A shared incremental file hands one candidate another's kills. Measured — ADR-0004.
    expect(strykerConfig()).toContain('incrementalFile: ".sidecrew-mutation/stryker-incremental.json"');
  });
});

describe("the compile stage proves it checked the candidate — ADR-0037", () => {
  it("adds the candidate to the project's own config rather than replacing it", () => {
    const derived = JSON.parse(derivedTsconfig("tsconfig.json", join("test", "a.test.ts"))) as Record<string, unknown>;
    // `extends` inherits include and exclude when the child does not restate them, and a `files` entry
    // is additive — so the program grows by exactly one file.
    expect(derived).toEqual({ extends: "./tsconfig.json", files: ["test/a.test.ts"] });
  });

  it("keeps a tsconfig path that is already relative", () => {
    expect(JSON.parse(derivedTsconfig("./build/tsconfig.app.json", "t.test.ts"))).toMatchObject({
      extends: "./build/tsconfig.app.json",
    });
  });

  it("strips the file list out of what the retry gets to read", () => {
    // `--listFiles` prints thousands of paths on a real project, and the compile stage's output is not
    // a log — it is what the retry prompt and the escalation queue are built from.
    const noisy = [
      "test/a.test.ts(5,7): error TS2322: Type 'number' is not assignable to type 'string'.",
      "/Users/x/project/node_modules/typescript/lib/lib.es5.d.ts",
      "/Users/x/project/src/arrays.ts",
      "test/a.test.ts(9,1): error TS2554: Expected 2 arguments, but got 3.",
    ].join("\n");
    const clean = stripFileList(noisy);
    expect(clean).toContain("TS2322");
    expect(clean).toContain("TS2554");
    expect(clean).not.toContain("lib.es5.d.ts");
    expect(clean.split("\n")).toHaveLength(2);
  });

  it("keeps a diagnostic that happens to carry an absolute path", () => {
    const line = "/Users/x/project/src/a.ts(3,1): error TS2307: Cannot find module 'q'.";
    expect(stripFileList(line)).toBe(line);
  });
});

describe("jestConfigEntry — ADR-0036's two fixes have to compose, ADR-0038", () => {
  /**
   * This one needs `fixtures/jest-fixture/node_modules`, which is not in the repository — it is a build
   * artefact. On a **fresh clone** it is therefore absent, and until now the test failed with
   * `.toMatch() expects to receive a string, but got object`: `jestConfigEntry` correctly returned
   * `null`, and `typeof null === "object"`.
   *
   * That is a publication defect rather than a test defect. `npm test` is the first thing a stranger
   * runs, and a failure whose message names neither the cause nor the remedy is exactly what
   * `VISION.md`'s bar rules out — *every failure a user would hit is either fixed or named with its
   * exact fix* (ADR-0032). It was invisible locally because the fixture had been installed months ago.
   */
  const jestFixtureInstalled = existsSync("fixtures/jest-fixture/node_modules");

  it.skipIf(!jestFixtureInstalled)("finds jest-config for a hoisted project", () => {
    expect(jestConfigEntry("fixtures/jest-fixture")).toMatch(/jest-config/);
  });

  it("says how to enable the skipped case rather than passing silently", () => {
    // A skip nobody can act on is a test that quietly stopped running. If the fixture is missing, this
    // asserts the remedy is one command — and if it is present, it asserts the case above really ran.
    expect(
      jestFixtureInstalled,
      "fixtures/jest-fixture has no node_modules, so the hoisted-project case is skipped. "
      + "Install it with: npm --prefix fixtures/jest-fixture i",
    ).toBe(jestFixtureInstalled);
    expect(jestConfigEntry("fixtures/jest-fixture")).toStrictEqual(
      jestFixtureInstalled ? expect.stringContaining("jest-config") : null,
    );
  });

  it("is null rather than throwing where jest is not installed", () => {
    // The caller turns that into "no shim", and the mutation stage names the cause if it then dies.
    expect(jestConfigEntry("fixtures/ts-fixture")).toBeNull();
  });

  it("bakes the resolved path into the shim, so guard and shim cannot disagree", () => {
    expect(jestConfigShim(undefined, "/abs/jest-config/build/index.js"))
      .toContain('require("/abs/jest-config/build/index.js")');
  });
});

describe("strykerConfig's plugins — exactly sidecrew's own, ADR-0088", () => {
  it("names exactly the plugins it is given, with no glob to load the other runner's", () => {
    const config = strykerConfig({ plugins: ["/cache/jest-runner/dist/src/index.js", "/cache/typescript-checker/dist/src/index.js"] });
    expect(config).toContain('plugins: ["/cache/jest-runner/dist/src/index.js","/cache/typescript-checker/dist/src/index.js"]');
    expect(config).not.toContain("@stryker-mutator/*");
  });

  it("writes no plugins line when given none, so the fixture's checked-in config still matches", () => {
    expect(strykerConfig()).not.toContain("plugins");
    expect(strykerConfig({ plugins: [] })).not.toContain("plugins");
  });
});

describe("jestConfigShim — ts-jest must not type-check Stryker, ADR-0036", () => {
  it("keeps the project's own globals and adds only diagnostics", () => {
    // Stryker's own `jest.config` key is a shallow override, so setting `globals` through it drops
    // whatever else the project had there — and `__DEV__` in globals is every React Native project.
    const shim = jestConfigShim("test/jest-unit.ts");
    expect(shim).toContain('readInitialOptions("test/jest-unit.ts"');
    expect(shim).toContain("...config,");
    expect(shim).toContain("...globals,");
    expect(shim).toContain('"ts-jest": { ...(globals["ts-jest"] ?? {}), diagnostics: false }');
  });

  it("lets jest find the project's config when there is no explicit one", () => {
    expect(jestConfigShim(undefined)).toContain("readInitialOptions(undefined,");
  });

  it("is not a name jest would discover by itself", () => {
    // `readInitialOptions` with no path searches for the standard names. If the shim used one of them
    // it would find itself and wrap nothing.
    expect(JEST_CONFIG_FILES).not.toContain(SIDECREW_JEST_CONFIG);
    expect(SIDECREW_JEST_CONFIG.startsWith(".sidecrew")).toBe(true);
  });
});

describe("the sandbox", () => {
  const made: string[] = [];
  afterEach(async () => {
    await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  const project = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "sidecrew-fake-project-"));
    made.push(dir);
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "test"), { recursive: true });
    await mkdir(join(dir, "reports", "mutation"), { recursive: true });
    await mkdir(join(dir, "node_modules", ".bin"), { recursive: true });
    await mkdir(join(dir, "test", "__snapshots__"), { recursive: true });
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "src", "thing.ts"), "export const one = 1;\n");
    await writeFile(join(dir, "test", "thing.test.ts"), "// somebody else's test\n");
    await writeFile(join(dir, "test", "thing.spec.tsx"), "// and their other one\n");
    await writeFile(join(dir, "test", "__snapshots__", "thing.test.ts.snap"), "// a recorded answer\n");
    await writeFile(join(dir, "reports", "stryker-incremental.json"), "{}");
    await writeFile(join(dir, "node_modules", "marker.txt"), "not copied\n");
    return dir;
  };

  it("leaves the project's own tests behind", async () => {
    // The one that matters: a mutant killed by a test that was already there is not evidence about
    // the candidate, and counting it would make every candidate in a real repo look like a survivor.
    const sandbox = await makeSandbox(await project());
    made.push(sandbox);
    expect(existsSync(join(sandbox, "src", "thing.ts"))).toBe(true);
    expect(existsSync(join(sandbox, "test", "thing.test.ts"))).toBe(false);
    expect(existsSync(join(sandbox, "test", "thing.spec.tsx"))).toBe(false);
  });

  it("leaves recorded snapshots and a warm incremental cache behind", async () => {
    const sandbox = await makeSandbox(await project());
    made.push(sandbox);
    expect(existsSync(join(sandbox, "test", "__snapshots__", "thing.test.ts.snap"))).toBe(false);
    expect(existsSync(join(sandbox, "reports", "stryker-incremental.json"))).toBe(false);
  });

  it("symlinks node_modules rather than copying it", async () => {
    const dir = await project();
    const sandbox = await makeSandbox(dir);
    made.push(sandbox);
    expect(await readFile(join(sandbox, "node_modules", "marker.txt"), "utf8")).toContain("not copied");
    expect(existsSync(join(dir, "node_modules", "marker.txt"))).toBe(true);
  });

  it("makes each candidate its own sandbox", async () => {
    const dir = await project();
    const [a, b] = await Promise.all([makeSandbox(dir), makeSandbox(dir)]);
    made.push(a, b);
    expect(a).not.toBe(b);
  });

  it("agrees with itself about what a test file looks like", () => {
    for (const name of ["a.test.ts", "a.spec.ts", "a.test.tsx", "a.test.mts", "a.spec.js"]) {
      expect(TEST_FILE_PATTERN.test(name), name).toBe(true);
    }
    for (const name of ["test.ts", "attest.ts", "a.ts", "testing.ts"]) {
      expect(TEST_FILE_PATTERN.test(name), name).toBe(false);
    }
    expect(NEVER_COPY.has("node_modules")).toBe(true);
    expect(NEVER_COPY.has("reports")).toBe(true);
  });
});

// ── the second runner — ADR-0028 ──────────────────────────────────────────────────────────────────

describe("runArgs", () => {
  it("asks vitest for a file positionally, the way its include expects", () => {
    expect(runArgs("vitest", "test/a.test.ts")).toEqual(["run", "test/a.test.ts"]);
  });

  it("asks jest for the path literally rather than hoping testMatch covers it", () => {
    // `--runTestsByPath` is the difference between working on any project and working on projects
    // whose testMatch happens to cover wherever the candidate was written. A jest-expo preset matches
    // any `.test.ts`; a Nest app matches `.spec.ts` under `src/`.
    expect(runArgs("jest", "test/a.test.ts")).toEqual(["--ci", "--runTestsByPath", "test/a.test.ts"]);
  });

  it("never passes --passWithNoTests, because a run that executed nothing must fail", () => {
    // ADR-0006's Swift lesson, which is a lesson about exit codes rather than about Swift: `swift test`
    // exits 0 on an empty suite, and jest would too if asked nicely.
    expect(runArgs("jest", "x.test.ts")).not.toContain("--passWithNoTests");
  });
});

describe("strykerConfig for jest", () => {
  it("names the runner and carries the project's own config file", () => {
    const cfg = strykerConfig({ runner: "jest", jestConfig: "jest.config.js" });
    expect(cfg).toContain('testRunner: "jest"');
    expect(cfg).toContain('projectType: "custom"');
    expect(cfg).toContain('configFile: "jest.config.js"');
  });

  it("omits configFile when the project keeps its config in package.json", () => {
    // Stryker's runner finds that case correctly on its own; naming a file that is not there does not.
    // Matched as its own key rather than as a substring: `tsconfigFile` is a different option and is
    // always present.
    const cfg = strykerConfig({ runner: "jest" });
    expect(cfg).toContain('projectType: "custom"');
    expect(cfg).not.toMatch(/^\s+configFile:/m);
    expect(cfg).toMatch(/^\s+tsconfigFile:/m);
  });

  it("turns findRelatedTests off, because the sandbox has exactly one test in it", () => {
    // On, a project whose module resolution jest cannot follow — path aliases, a monorepo, jest-expo —
    // silently relates the mutant to no tests and every mutant comes back NoCoverage. That reads as
    // "your test covers nothing" when what happened is that jest could not find it.
    expect(strykerConfig({ runner: "jest" })).toContain("enableFindRelatedTests: false");
  });

  it("leaves the vitest config exactly as it was", () => {
    // The Vitest arm is what every measurement before Phase 9 was taken on, so adding a second runner
    // must not have moved it.
    const cfg = strykerConfig();
    expect(cfg).toContain('testRunner: "vitest"');
    expect(cfg).not.toContain("jest");
  });
});

describe("detectJestConfig", () => {
  it("finds the fixture's config file", () => {
    expect(detectJestConfig("fixtures/jest-fixture")).toBe("jest.config.js");
  });

  it("is undefined for a project that has none", () => {
    expect(detectJestConfig("fixtures/ts-fixture")).toBeUndefined();
  });
});

describe("the runner as a contract", () => {
  it("knows exactly two, and says so by name", () => {
    expect([...TEST_RUNNERS]).toEqual(["vitest", "jest"]);
    expect(isTestRunner("jest")).toBe(true);
    expect(isTestRunner("mocha")).toBe(false);
  });

  it("names a Stryker plugin per runner, because stryker alone cannot drive either", () => {
    expect(STRYKER_PLUGIN.vitest).toBe("@stryker-mutator/vitest-runner");
    expect(STRYKER_PLUGIN.jest).toBe("@stryker-mutator/jest-runner");
  });
});

describe("looksLikeOom — ADR-0032", () => {
  it("recognises the three ways node says it ran out of heap", () => {
    // All three were produced by one project's typecheck in one afternoon.
    expect(looksLikeOom("FATAL ERROR: Reached heap limit Allocation failed")).toBe(true);
    expect(looksLikeOom("JavaScript heap out of memory")).toBe(true);
    expect(looksLikeOom("FATAL ERROR: Ineffective mark-compacts near heap limit")).toBe(true);
  });

  it("does not fire on an ordinary compiler error", () => {
    // The whole point is telling a machine limit from a candidate that is simply wrong, so a false
    // positive here would turn a real verdict into a setup error and stop the run.
    expect(looksLikeOom("src/a.ts(3,5): error TS2345: Argument of type 'string'")).toBe(false);
    expect(looksLikeOom("Test suite failed to run\n  Cannot find module '../src/x'")).toBe(false);
  });
});

describe("testSuffixFor — ADR-0032", () => {
  it("follows the convention the project already uses", () => {
    // Not cosmetic: the mutation stage runs jest under the *project's* config, and a NestJS
    // `testRegex: '.*\\.spec\\.ts$'` does not match a file called `foo.test.ts`. Jest then finds
    // nothing, every mutant is NoCoverage, and the verdict looks exactly like a test that covers nothing.
    expect(testSuffixFor("fixtures/ts-fixture")).toBe(".test.ts");
    expect(testSuffixFor("fixtures/jest-fixture")).toBe(".test.ts");
  });

  it("defaults to .test.ts when a project has expressed no preference", () => {
    // jest's and vitest's own default, so it is the likeliest to match.
    expect(testSuffixFor("src")).toBe(".test.ts");
  });
});

// ── what the third real project broke — ADR-0033 ──────────────────────────────────────────────────

describe("deriveLineRange across the shapes a real codebase uses", () => {
  // Measured on a NestJS codebase: `export function` is 23 of ~1,504 declarations, 1.5 %. The idiom is a
  // class of static methods, and every one of them was invisible.
  const shapes: [string, string, string][] = [
    ["export function", "export function f(a: number): number {\n  return a;\n}\n", "f"],
    ["plain function", "function f(a: number) {\n  return a;\n}\n", "f"],
    ["export const arrow with a block", "export const f = (v: unknown) => {\n  return [v];\n};\n", "f"],
    ["export const concise arrow", "export const f = (n: number) => n * 2;\n", "f"],
    ["static class method", "export default class U {\n  static f(a: number): number {\n    return a;\n  }\n}\n", "f"],
    ["static class property arrow", "class U {\n  static f = (s: string) => {\n    return s.trim();\n  };\n}\n", "f"],
    ["public static async", "class U {\n  public static async f(id: string): Promise<void> {\n    await id;\n  }\n}\n", "f"],
    ["plain class method", "class U {\n  f(a: number): number {\n    return a + 1;\n  }\n}\n", "f"],
  ];

  for (const [label, source, name] of shapes) {
    it(`finds a ${label}`, () => {
      const range = deriveLineRange(source, name);
      expect(range, label).not.toBeNull();
      const [start, end] = range!;
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThanOrEqual(start);
      // The range must not run past the file, which is what a naive brace match does on an arrow body.
      expect(end).toBeLessThanOrEqual(source.trimEnd().split("\n").length);
    });
  }

  it("does not mistake a call for a declaration", () => {
    // The class-method pattern is the loosest one here, so this is the case it could get wrong.
    expect(deriveLineRange("const x = 1;\nf(3);\n", "f")).toBeNull();
  });

  it("bounds a concise arrow at its own statement, not at the next brace it can find", () => {
    // `const f = (n) => n * 2;` has no block. Brace-matching from the next `{` would swallow whatever
    // follows — a range covering several unrelated functions, which is what ADR-0013 made expensive.
    const source = "export const f = (n: number) => n * 2;\n\nexport function g() {\n  return 1;\n}\n";
    expect(deriveLineRange(source, "f")).toEqual([1, 1]);
  });
});

describe("deriveLineRange does not stop at a return-type annotation — ADR-0035", () => {
  // Reduced from `AssetUtil.getSpendVsReplacement` in a real NestJS module. The braces of the return
  // type balance on their own line, so the old brace match closed at the signature and the probe
  // reported `NOT PLANNABLE — no mutants at all` about a function with 18 killable mutants.
  it("spans the body of an arrow whose return type is an object literal type", () => {
    const source = [
      "class U {",
      "  static readonly f = (",
      "    cost: number,",
      "    spent: number,",
      "  ): { percentage: string; color: Colour } => {",
      "    let value = cost - spent;",
      "    if (value < 0) value = 0;",
      "    return { percentage: `${value}%`, color: Colour.Red };",
      "  };",
      "}",
      "",
    ].join("\n");
    expect(deriveLineRange(source, "f")).toEqual([2, 9]);
  });

  it("spans the body of a method whose return type is an object literal type", () => {
    const source = "class U {\n  static f(a: number): { n: number } {\n    return { n: a };\n  }\n}\n";
    expect(deriveLineRange(source, "f")).toEqual([2, 4]);
  });

  it("skips every alternative of a union return type, not just the first", () => {
    // The naive repair — skip one brace group — takes `{ b: number }` for the body and closes there.
    const source = "class U {\n  static f(a: number): { a: number } | { b: number } {\n    return { a };\n  }\n}\n";
    expect(deriveLineRange(source, "f")).toEqual([2, 4]);
  });

  it("still finds the body when the return type has no braces", () => {
    const source = "class U {\n  static f = (a: number): number => {\n    return a;\n  };\n}\n";
    expect(deriveLineRange(source, "f")).toEqual([2, 4]);
  });

  it("does not stop at a generic constraint's braces — ADR-0039", () => {
    // `TYPE_POSITION` was a set of CHARACTERS, and a constraint opens its brace after a WORD. Measured
    // on a real module: this derived as the signature line alone, and the probe then printed
    // "NOT PLANNABLE — no mutants at all" about a function whose hand-ranged control kills a mutant.
    const source = [
      "export class V {",
      "  static isValidationError<T extends { isValid: boolean }>(e: unknown): e is T {",
      "    return typeof e === \"object\";",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(deriveLineRange(source, "isValidationError")).toEqual([2, 4]);
  });

  it("does not treat a word before a body brace as a type position", () => {
    // The keyword list has to be tight: `)` precedes an ordinary body and must stay a body.
    const source = "export function f(a: number): number {\n  return a;\n}\n";
    expect(deriveLineRange(source, "f")).toEqual([1, 3]);
  });

  it("does not treat a destructured parameter as a return type", () => {
    const source = "export function f({ a, b }: Props): number {\n  return a + b;\n}\n";
    expect(deriveLineRange(source, "f")).toEqual([1, 3]);
  });
});

describe("skipFromSandbox — ADR-0033", () => {
  it("keeps a source directory whose name happens to be an output directory's", () => {
    // Measured: `src/modules/reports/` is a controller, a service, a module and two entities, and the
    // sandbox deleted all five because `reports` is where sidecrew's own Stryker output used to go. The
    // verdict said "did not compile".
    expect(skipFromSandbox(join("src", "modules", "reports", "reports.service.ts"))).toBe(false);
    expect(skipFromSandbox(join("src", "dist", "thing.ts"))).toBe(false);
    expect(skipFromSandbox(join("src", "coverage", "model.ts"))).toBe(false);
  });

  it("still skips them at the top level, where they really are output", () => {
    expect(skipFromSandbox("reports")).toBe(true);
    expect(skipFromSandbox(join("dist", "index.js"))).toBe(true);
    expect(skipFromSandbox(join("coverage", "lcov.info"))).toBe(true);
  });

  it("skips the ones that nest legitimately, at any depth", () => {
    expect(skipFromSandbox(join("packages", "a", "node_modules", "x"))).toBe(true);
    expect(skipFromSandbox(join("src", "__snapshots__", "a.snap"))).toBe(true);
  });

  it("puts sidecrew's own mutation output somewhere a project will not have", () => {
    // The collision is the whole reason `reports` was in the skip list.
    expect(MUTATION_REPORT.startsWith(".sidecrew-mutation/")).toBe(true);
  });
});

describe("rescuedFromTestName — a file named like a test that is not one, ADR-0035", () => {
  const files = (o: Record<string, string>): Map<string, string> => new Map(Object.entries(o));

  it("keeps the file the trial lost, from the import that lost it", () => {
    // Verbatim shape from project-a: `test/util/test.setup.ts` imports a NestJS config module named
    // `auth.config.test.ts`. The sandbox deleted it, `tsc` failed on the project's own code, and 12 of
    // 16 attempts died on that one line — reported as "did not compile", about the candidate.
    const rescued = rescuedFromTestName(files({
      [join("test", "util", "test.setup.ts")]: `import { authConfig } from "../../src/modules/auth/auth.config.test";\n`,
      [join("src", "modules", "auth", "auth.config.test.ts")]: `export const authConfig = { secret: "x" };\n`,
    }));
    expect([...rescued]).toEqual([join("src", "modules", "auth", "auth.config.test.ts")]);
  });

  it("does not keep a real test, which is a leaf nothing imports", () => {
    const rescued = rescuedFromTestName(files({
      [join("src", "strings.ts")]: `export const f = (s: string) => s;\n`,
      [join("test", "strings.test.ts")]: `import { f } from "../src/strings";\nit("works", () => f("a"));\n`,
    }));
    expect(rescued.size).toBe(0);
  });

  it("does not keep a test imported only by another test — both are leaves together", () => {
    const rescued = rescuedFromTestName(files({
      [join("src", "a.ts")]: `export const a = 1;\n`,
      [join("test", "helper.test.ts")]: `export const mk = () => 1;\n`,
      [join("test", "a.test.ts")]: `import { mk } from "./helper.test";\n`,
    }));
    expect(rescued.size).toBe(0);
  });

  it("follows the chain: code → test-named → test-named", () => {
    const rescued = rescuedFromTestName(files({
      [join("src", "app.ts")]: `import { b } from "./b.test";\n`,
      [join("src", "b.test.ts")]: `export { c as b } from "./c.test";\n`,
      [join("src", "c.test.ts")]: `export const c = 1;\n`,
    }));
    expect(rescued).toEqual(new Set([join("src", "b.test.ts"), join("src", "c.test.ts")]));
  });

  it("reads require and dynamic import, not only static import", () => {
    expect(rescuedFromTestName(files({
      [join("src", "a.ts")]: `const x = require("./cfg.test");\n`,
      [join("src", "cfg.test.ts")]: `module.exports = {};\n`,
    })).size).toBe(1);
    expect(rescuedFromTestName(files({
      [join("src", "a.ts")]: `const x = await import("./cfg.test");\n`,
      [join("src", "cfg.test.ts")]: `export default {};\n`,
    })).size).toBe(1);
  });

  it("resolves a specifier whether or not it carries an extension", () => {
    // ESM spells the import `./cfg.test.js` for a file on disk called `cfg.test.ts`.
    expect(rescuedFromTestName(files({
      [join("src", "a.ts")]: `import "./cfg.test.js";\nimport "./other.test";\n`,
      [join("src", "cfg.test.ts")]: `export {};\n`,
      [join("src", "other.test.ts")]: `export {};\n`,
    }))).toEqual(new Set([join("src", "cfg.test.ts"), join("src", "other.test.ts")]));
  });

  it("walks up out of the importer's directory", () => {
    expect(rescuedFromTestName(files({
      [join("test", "util", "setup.ts")]: `import "../../src/deep/cfg.test";\n`,
      [join("src", "deep", "cfg.test.ts")]: `export {};\n`,
    }))).toEqual(new Set([join("src", "deep", "cfg.test.ts")]));
  });

  it("ignores bare specifiers, which are packages and never this project's files", () => {
    expect(rescuedFromTestName(files({
      [join("src", "a.ts")]: `import "jest.test";\nimport "@scope/thing.test";\n`,
      [join("src", "jest.test.ts")]: `export {};\n`,
    })).size).toBe(0);
  });

  it("costs nothing on a project with no test-named files at all", () => {
    expect(rescuedFromTestName(files({ [join("src", "a.ts")]: `import "./b";\n` })).size).toBe(0);
  });
});

describe("the sandbox's node_modules — ADR-0034", () => {
  const built: string[] = [];
  afterEach(async () => {
    await Promise.all(built.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("is a symlink by default, because cloning doubled a fixture verdict", async () => {
    // Measured both ways: the clone costs 18 s against a real project's 104 s mutation stage (worth it)
    // and 6 s against the fixture's 6 s mutation stage (not). Neither measurement can be the rule, so
    // the default stays what ADR-0004 chose and the clone is an upgrade on evidence.
    const sandbox = await makeSandbox("fixtures/ts-fixture", await mkdtemp(join(tmpdir(), "sidecrew-nm-")));
    built.push(sandbox);
    expect(lstatSync(join(sandbox, "node_modules")).isSymbolicLink()).toBe(true);
    // And it resolves, which is the thing ADR-0029 fixed.
    expect(existsSync(join(sandbox, "node_modules", "typescript", "package.json"))).toBe(true);
  });

  it("recognises the one error that is about the sandbox rather than the candidate", () => {
    // TS2883 fires on the *project's own* code, on every candidate of an affected project, so untreated
    // it is a 0 % survival rate reported as twenty compile failures.
    const real = "src/modules/logger/winston.config.ts(50,17): error TS2883: The inferred type of " +
      "'getWinstonConfig' cannot be named without a reference to '../../../../Users/x/node_modules/logform'.";
    expect(/\bTS2883\b/.test(real)).toBe(true);
    expect(/\bTS2883\b/.test("src/a.ts(3,5): error TS2345: Argument of type 'string'")).toBe(false);
  });
});

describe("noKillMessage — the two meanings of killed == 0 (ADR-0005)", () => {
  const m = (survived: number, no_coverage = 0, timeout = 0) =>
    ({ score: 0, killed: 0, survived, no_coverage, timeout, killed_ids: [] as string[], killed_mutators: [] as string[], body_mutant_id: null, killed_reasons: [] as string[] });

  it("never says a changed version passed when none ran — every mutant a compile error", () => {
    // ADR-0082 D, 24 Sep 2026: 2 mutants, both CompileError. The old sentence sent a planner to repair
    // an exemplar that was never the problem.
    const said = noKillMessage("f", m(0), { CompileError: 2 });
    expect(said).toContain("nothing in f could be mutated");
    expect(said).toContain("every one failed to compile");
    expect(said).not.toContain("against every changed version");
  });

  it("says there were no mutants at all when Stryker made none", () => {
    expect(noKillMessage("f", m(0), {})).toContain("made no mutants in its line range");
  });

  it("still blames the test when mutants ran and survived, and counts the discarded ones", () => {
    const said = noKillMessage("f", m(3), { CompileError: 1 });
    expect(said).toContain("3 survived");
    expect(said).toContain("1 failed to compile and were discarded");
    expect(said).toContain("every changed version that ran");
  });
});

describe("uncountedStatuses", () => {
  it("counts what parseMutationReport leaves out, for the file under test", () => {
    const report = { files: { "src/a.ts": { mutants: [{ status: "CompileError" }, { status: "Killed" }, { status: "CompileError" }] } } };
    expect(uncountedStatuses(report, "src/a.ts")).toEqual({ CompileError: 2 });
  });
});
