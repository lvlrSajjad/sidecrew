// The parts of the Swift verifier that can be checked without a toolchain: the report parser, the
// sandbox rules, the range finder, the two files written into the sandbox, and the two readings of
// `swift test` output that the exit code cannot give us.
// The pipeline itself is `verifier-swift.slow.test.ts`.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import {
  DEFAULT_MUTANT_TIMEOUT_S,
  MUTER_CONFIG,
  NEVER_COPY,
  TEST_RUNNER,
  deriveTestFilter,
  executedTests,
  makeSandbox,
  muterConfig,
  parseMuterReport,
  testRunnerScript,
  testTargets,
} from "../src/verifier/swift.js";
import { deriveLineRange } from "../src/verifier/shared.js";
import { MutationResult } from "../src/schemas.js";

const FIXTURES = "fixtures/swift-fixture";

const at = (line: number, outcome: string, operator = "RelationalOperatorReplacement", file = "Sources/SwiftFixture/Strings.swift") => ({
  testSuiteOutcome: outcome,
  mutationPoint: { mutationOperatorId: operator, filePath: `/tmp/sandbox_mutated/${file}`, position: { line, column: 9, utf8Offset: 0 } },
});

const report = (operators: ReturnType<typeof at>[], fileName = "Strings.swift") => ({
  globalMutationScore: 0,
  numberOfKilledMutants: 0,
  totalAppliedMutationOperators: operators.length,
  fileReports: [{ fileName, mutationScore: 0, appliedOperators: operators }],
});

describe("parseMuterReport", () => {
  it("maps each of Muter's outcomes to the bucket the contract has for it", () => {
    const r = parseMuterReport(report([
      at(10, "failed"), at(11, "failed"), at(12, "passed"), at(13, "runtimeError"), at(14, "noCoverage"),
    ]));
    expect(r).toMatchObject({ killed: 2, survived: 1, timeout: 1, no_coverage: 1 });
  });

  it("ignores a buildError, which is Muter talking about Swift rather than about the test", () => {
    const r = parseMuterReport(report([at(10, "failed"), at(11, "buildError"), at(12, "somethingNew")]));
    expect(r).toMatchObject({ killed: 1, survived: 0, timeout: 0, no_coverage: 0, score: 1 });
  });

  it("scores a runtimeError as a kill and a never-reached mutant as a miss", () => {
    // The mutation-testing standard, so our numbers stay comparable with the TypeScript verifier's
    // and with everybody else's.
    expect(parseMuterReport(report([at(1, "failed"), at(2, "runtimeError"), at(3, "passed"), at(4, "noCoverage")])).score).toBe(0.5);
    expect(parseMuterReport(report([at(1, "failed"), at(2, "passed")])).score).toBe(0.5);
  });

  it("never counts a runtimeError towards survival", () => {
    // CLAUDE.md #2 wants a killed mutant. A mutant that crashed the process, or that the wrapper's
    // watchdog killed, is one nothing asserted about — ADR-0005, and ADR-0012 for the asymmetry.
    const r = parseMuterReport(report([at(1, "runtimeError"), at(2, "runtimeError")]));
    expect(r.score).toBe(1);
    expect(r.killed).toBe(0);
    expect(r.killed_ids).toEqual([]);
  });

  it("counts only mutants inside the function's line range", () => {
    // ADR-0013 through a different door: Muter cannot be told a range, so the range is applied here.
    const all = report([at(10, "failed"), at(25, "failed"), at(40, "passed")]);
    expect(parseMuterReport(all, "Sources/SwiftFixture/Strings.swift", [20, 30])).toMatchObject({ killed: 1, survived: 0 });
    expect(parseMuterReport(all, "Sources/SwiftFixture/Strings.swift", null)).toMatchObject({ killed: 2, survived: 1 });
  });

  it("names each kill by operator and position, because Muter has no mutant ids", () => {
    const r = parseMuterReport(report([at(16, "failed", "ChangeLogicalConnector")]));
    expect(r.killed_ids).toEqual(["ChangeLogicalConnector@16:9"]);
  });

  it("drops the zeroed placeholder Muter emits for a file with no coverage", () => {
    // It names no line, so it cannot be attributed to the function under test — and an unattributable
    // mutant counted against the candidate is exactly what ADR-0013 exists to prevent.
    const placeholder = { testSuiteOutcome: "noCoverage", mutationPoint: { mutationOperatorId: "RemoveSideEffects", filePath: "", position: { line: 0, column: 0, utf8Offset: 0 } } };
    const r = parseMuterReport({ fileReports: [{ fileName: "Async.swift", appliedOperators: [placeholder] }] });
    expect(r).toMatchObject({ killed: 0, survived: 0, timeout: 0, no_coverage: 0, score: 0 });
  });

  it("counts only the file under test when the report holds several", () => {
    const many = {
      fileReports: [
        { fileName: "Strings.swift", appliedOperators: [at(10, "failed")] },
        { fileName: "Arrays.swift", appliedOperators: [at(10, "failed", "RelationalOperatorReplacement", "Sources/SwiftFixture/Arrays.swift"), at(11, "passed", "RelationalOperatorReplacement", "Sources/SwiftFixture/Arrays.swift")] },
      ],
    };
    expect(parseMuterReport(many, "Sources/SwiftFixture/Arrays.swift")).toMatchObject({ killed: 1, survived: 1 });
    expect(parseMuterReport(many, "Sources/SwiftFixture/Strings.swift")).toMatchObject({ killed: 1, survived: 0 });
  });

  it("falls back to every file rather than reporting nothing when the name does not match", () => {
    expect(parseMuterReport(report([at(10, "failed")]), "Sources/SwiftFixture/Elsewhere.swift").killed).toBe(1);
  });

  it("scores an empty report 0 rather than dividing by nothing", () => {
    expect(parseMuterReport(report([])).score).toBe(0);
    expect(parseMuterReport({}).killed).toBe(0);
    expect(parseMuterReport(null).killed).toBe(0);
  });

  it("always produces something the contract accepts", () => {
    const r = parseMuterReport(report([at(1, "failed"), at(2, "passed"), at(3, "noCoverage")]));
    expect(MutationResult.safeParse(r).success).toBe(true);
  });
});

describe("executedTests", () => {
  // `swift test` exits 0 when it ran nothing, so this is the only thing standing between a candidate
  // whose tests were never selected and a clean pass — ADR-0006's newest cheap pass.
  const xctest = (n: number, failures = 0) => `Test Suite 'All tests' passed\n\t Executed ${n} tests, with ${failures} failures (0 unexpected) in 0.001 (0.002) seconds\n`;

  it("reads XCTest's summary, taking the overall count rather than a per-suite one", () => {
    expect(executedTests(`${xctest(3)}${xctest(3)}`)).toMatchObject({ xctest: 3, total: 3 });
    expect(executedTests(`\t Executed 2 tests, with 0 failures\n\t Executed 5 tests, with 0 failures\n`).xctest).toBe(5);
  });

  it("reads Swift Testing's summary, whether the run passed or failed", () => {
    expect(executedTests("✔ Test run with 4 tests in 1 suite passed after 0.001 seconds.").swiftTesting).toBe(4);
    expect(executedTests("✘ Test run with 2 tests in 1 suite failed after 0.001 seconds with 1 issue.").swiftTesting).toBe(2);
  });

  it("adds the two up, because swift test runs both frameworks in one go", () => {
    expect(executedTests(`${xctest(3)}✔ Test run with 4 tests in 1 suite passed.`)).toMatchObject({ xctest: 3, swiftTesting: 4, total: 7 });
  });

  it("reports nothing as nothing", () => {
    expect(executedTests(`${xctest(0)}✔ Test run with 0 tests in 0 suites passed after 0.001 seconds.`).total).toBe(0);
    expect(executedTests("").total).toBe(0);
  });
});

describe("deriveTestFilter", () => {
  it("finds the XCTestCase subclass", () => {
    expect(deriveTestFilter("final class SlugifyTests: XCTestCase {\n}\n", "xctest")).toBe("SlugifyTests");
    expect(deriveTestFilter("class Plain: XCTestCase {}", "xctest")).toBe("Plain");
  });

  it("finds the Swift Testing suite, named or not", () => {
    expect(deriveTestFilter("@Suite struct ChunkTests {\n}\n", "swift-testing")).toBe("ChunkTests");
    expect(deriveTestFilter('@Suite("chunk") struct ChunkTests {}', "swift-testing")).toBe("ChunkTests");
    expect(deriveTestFilter("@Suite final class ChunkTests {}", "swift-testing")).toBe("ChunkTests");
  });

  it("returns null rather than guessing when there is no single name to filter on", () => {
    // Null costs a slightly longer run. A wrong guess selects nothing, and `swift test` calls that a
    // pass — so between the two there is no contest.
    expect(deriveTestFilter("@Test func a() {}\n@Test func b() {}\n", "swift-testing")).toBeNull();
    expect(deriveTestFilter("final class A: XCTestCase {}\nfinal class B: XCTestCase {}", "xctest")).toBeNull();
    expect(deriveTestFilter("import XCTest\n", "xctest")).toBeNull();
  });

  it("agrees with the fixture's own candidates", async () => {
    expect(deriveTestFilter(await readFile(`${FIXTURES}/legitimate/HappyPathXCTests.swift`, "utf8"), "xctest")).toBe("SlugifyHappyPathXCTests");
    expect(deriveTestFilter(await readFile(`${FIXTURES}/legitimate/AsyncTests.swift`, "utf8"), "swift-testing")).toBe("MapSeriesAsyncTests");
  });

  it("is not fooled by the helper class inside a Swift Testing suite", async () => {
    // AsyncTests declares a plain `final class Order` to record call order. It is not a suite.
    const source = await readFile(`${FIXTURES}/legitimate/AsyncTests.swift`, "utf8");
    expect(source).toContain("final class Order");
    expect(deriveTestFilter(source, "swift-testing")).toBe("MapSeriesAsyncTests");
  });
});

describe("deriveLineRange, in Swift", () => {
  it("finds a function's first and last line through its modifiers", async () => {
    const source = await readFile(`${FIXTURES}/Sources/SwiftFixture/Strings.swift`, "utf8");
    const lines = source.split("\n");
    const [start, end] = deriveLineRange(source, "truncate", "swift") ?? [0, 0];
    expect(lines[start - 1]).toContain("public static func truncate");
    expect(lines[end - 1]?.trim()).toBe("}");
  });

  it("handles a generic, throwing function that is not the first in the file", async () => {
    const source = await readFile(`${FIXTURES}/Sources/SwiftFixture/Arrays.swift`, "utf8");
    const range = deriveLineRange(source, "rotate", "swift");
    expect(range).not.toBeNull();
    expect(source.split("\n")[(range?.[0] ?? 1) - 1]).toContain("func rotate<T>");
  });

  it("handles an async function", async () => {
    const source = await readFile(`${FIXTURES}/Sources/SwiftFixture/Async.swift`, "utf8");
    expect(deriveLineRange(source, "firstSuccessful", "swift")).not.toBeNull();
  });

  it("is not fooled by a brace inside a string or a comment", () => {
    const source = 'func f() -> String {\n  // }\n  return "}"\n}\nfunc g() -> Int {\n  return 1\n}\n';
    expect(deriveLineRange(source, "f", "swift")).toEqual([1, 4]);
  });

  it("returns null rather than guessing when the function is not there", () => {
    expect(deriveLineRange("func other() {}\n", "slugify", "swift")).toBeNull();
  });

  it("does not match a name that merely starts the same way", () => {
    expect(deriveLineRange("public func truncateAll() {\n}\n", "truncate", "swift")).toBeNull();
  });
});

describe("muterConfig", () => {
  it("is exactly what the fixture has checked in", async () => {
    // The fixture's copy exists so a human can run `muter run` by hand and see what the verifier sees.
    // A copy that drifted would answer a different question from the one being debugged.
    expect(await readFile(`${FIXTURES}/${MUTER_CONFIG}`, "utf8")).toBe(muterConfig());
  });

  it("runs the tests through the wrapper, with xcrun one level down", () => {
    const config = muterConfig();
    expect(config).toContain("executable: /bin/sh");
    expect(config).toContain(`- "./${TEST_RUNNER}"`);
    expect(config).toContain('- "/usr/bin/xcrun"');
    expect(config).toContain('- "swift"');
    expect(config).toContain('- "test"');
  });

  it("keeps the project's own tests out of the mutation scope", () => {
    expect(muterConfig()).toContain("- Tests");
    expect(muterConfig()).toContain("- Package.swift");
  });
});

describe("testRunnerScript", () => {
  it("is exactly what the fixture has checked in", async () => {
    expect(await readFile(`${FIXTURES}/${TEST_RUNNER}`, "utf8")).toBe(testRunnerScript());
  });

  it("kills by working directory as well as by process group", () => {
    // The group kill alone is not enough and that was measured, not guessed: SwiftPM runs the built
    // xctest binary in a process group of its own, so killing ours reaches xcrun and swift-test and
    // leaves the hung process at 100 % CPU with PPID 1. ADR-0005 §3.
    const script = testRunnerScript();
    expect(script).toContain("set -m");
    expect(script).toMatch(/kill -9 -"\$child"/);
    expect(script).toMatch(/pkill -9 -f "\$PWD"/);
    // By path first: once the launchers are dead the orphan has no parent chain left to find it by.
    expect(script.indexOf("pkill")).toBeLessThan(script.indexOf('kill -9 -"$child"'));
  });

  it("emits the line Muter's kill detector matches, and only when the run really failed", () => {
    const script = testRunnerScript();
    expect(script).toContain("Test run with .* failed");
    expect(script).toContain("with 1 failure");
    // Gated on a grep, so a crash or a timeout — which print no such line — stay runtimeError.
    expect(script).toMatch(/if grep -q .*then/);
  });

  it("takes the per-mutant deadline from the caller and defaults where the constant says", () => {
    expect(testRunnerScript({ mutantTimeoutS: 5 })).toContain("SIDECREW_MUTANT_TIMEOUT_S:-5");
    expect(testRunnerScript()).toContain(`SIDECREW_MUTANT_TIMEOUT_S:-${DEFAULT_MUTANT_TIMEOUT_S}`);
  });

  it("passes the child's exit code back to Muter unchanged", () => {
    expect(testRunnerScript()).toContain('exit "$code"');
  });
});

describe("the sandbox", () => {
  const made: string[] = [];
  afterEach(async () => {
    await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  const project = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "sidecrew-fake-package-"));
    made.push(dir);
    for (const sub of ["Sources/Thing", "Tests/ThingTests", "Tests/ThingXCTests", ".build/debug", "muter_logs"]) {
      await mkdir(join(dir, sub), { recursive: true });
    }
    await writeFile(join(dir, "Package.swift"), "// swift-tools-version: 6.0\n");
    await writeFile(join(dir, "Sources", "Thing", "Thing.swift"), "public enum Thing {}\n");
    await writeFile(join(dir, "Tests", "ThingTests", "SomebodyElses.swift"), "// their test\n");
    await writeFile(join(dir, "Tests", "ThingXCTests", "TheirsToo.swift"), "// and their other one\n");
    await writeFile(join(dir, ".build", "debug", "module.swiftmodule"), "binary\n");
    await writeFile(join(dir, "muter_logs", "old.log"), "a previous run\n");
    return dir;
  };

  const keep = { testTarget: "ThingTests", testFile: "Candidate.swift", source: "// the candidate\n" };

  it("leaves the package's own tests behind and writes the candidate in their place", async () => {
    // The one that matters (ADR-0004): a mutant killed by a test that was already there is not
    // evidence about the candidate.
    const sandbox = await makeSandbox(await project(), keep);
    made.push(sandbox);
    expect(existsSync(join(sandbox, "Sources", "Thing", "Thing.swift"))).toBe(true);
    expect(existsSync(join(sandbox, "Tests", "ThingTests", "SomebodyElses.swift"))).toBe(false);
    expect(existsSync(join(sandbox, "Tests", "ThingXCTests", "TheirsToo.swift"))).toBe(false);
    expect(await readFile(join(sandbox, "Tests", "ThingTests", "Candidate.swift"), "utf8")).toBe("// the candidate\n");
  });

  it("leaves every other test target present but empty, so the manifest still resolves", async () => {
    const sandbox = await makeSandbox(await project(), keep);
    made.push(sandbox);
    const placeholder = join(sandbox, "Tests", "ThingXCTests", "SidecrewPlaceholder.swift");
    expect(existsSync(placeholder)).toBe(true);
    expect(await readFile(placeholder, "utf8")).not.toContain("func ");
    expect(existsSync(join(sandbox, "Tests", "ThingTests", "SidecrewPlaceholder.swift"))).toBe(false);
  });

  it("never copies .build, because a copied module cache is pinned to the path it was built at", async () => {
    // Muter copies the project to a sibling directory; a .build that came along makes every mutant
    // fail to compile with `missing required module 'SwiftShims'`. Measured, not feared — ADR-0005.
    const sandbox = await makeSandbox(await project(), keep);
    made.push(sandbox);
    expect(existsSync(join(sandbox, ".build"))).toBe(false);
    expect(existsSync(join(sandbox, "muter_logs"))).toBe(false);
    expect(NEVER_COPY.has(".build")).toBe(true);
  });

  it("makes each candidate its own sandbox", async () => {
    const dir = await project();
    const [a, b] = await Promise.all([makeSandbox(dir, keep), makeSandbox(dir, keep)]);
    made.push(a, b);
    expect(a).not.toBe(b);
  });

  it("lists the package's test targets", async () => {
    expect(testTargets(await project())).toEqual(["ThingTests", "ThingXCTests"]);
    expect(testTargets(FIXTURES)).toEqual(["SwiftFixtureTests", "SwiftFixtureXCTests"]);
    expect(testTargets(join(tmpdir(), "sidecrew-no-such-package"))).toEqual([]);
  });
});
