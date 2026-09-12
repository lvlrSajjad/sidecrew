// The parts of the TypeScript verifier that can be checked without a toolchain: the report parser, the
// sandbox rules, the range finder, and the config the fixture and the verifier have to agree on.
// The pipeline itself is `verifier-ts.slow.test.ts`.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import {
  MUTATION_REPORT,
  NEVER_COPY,
  TEST_FILE_PATTERN,
  deriveLineRange,
  makeSandbox,
  parseMutationReport,
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

  it("never points the incremental file outside the sandbox", () => {
    // A shared incremental file hands one candidate another's kills. Measured — ADR-0004.
    expect(strykerConfig()).toContain('incrementalFile: "reports/stryker-incremental.json"');
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
