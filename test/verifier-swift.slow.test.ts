// The whole pipeline against the real fixture: swift build, swift test and Muter all actually run.
// SIDECREW_SLOW=1 to include. Needs a Swift toolchain and `brew install muter-mutation-testing/formulae/muter`.
//
// Minutes, not seconds — a Swift verdict is a cold SwiftPM build plus a Muter run that rebuilds per
// mutant. `experiments/go-no-go/results/verifier-swift-cost.json` has the measured numbers.
import { readFile } from "node:fs/promises";
import { describe, it, expect } from "vitest";
import { verifySwift, VerifierSetupError, type SwiftFramework } from "../src/verifier/swift.js";
import { Verdict, type Candidate } from "../src/schemas.js";

const FIXTURES = "fixtures/swift-fixture";

interface CandidateEntry {
  file: string;
  task_id: string;
  source: string;
  function: string;
  framework: SwiftFramework;
  test_target: string;
  expect: "survives" | "tautological";
}

const catalogue = async (): Promise<CandidateEntry[]> =>
  (JSON.parse(await readFile(`${FIXTURES}/candidates.json`, "utf8")) as { candidates: CandidateEntry[] }).candidates;

const candidate = (task_id: string, test_source: string): Candidate => ({
  task_id,
  worker: { kind: "local", model: FIXTURES, revision: "checked-in", temperature: 0, seed: 42 },
  test_source,
  usage: { prompt_tokens: 0, completion_tokens: 0 },
  timing: { ttft_ms: 0, wall_ms: 0 },
});

const fromFile = async (entry: CandidateEntry): Promise<Candidate> =>
  candidate(entry.task_id, await readFile(`${FIXTURES}/${entry.file}`, "utf8"));

const target = (entry: Pick<CandidateEntry, "source" | "function" | "framework" | "test_target">) => ({
  projectDir: FIXTURES,
  sourceFile: entry.source,
  functionName: entry.function,
  framework: entry.framework,
  testTarget: entry.test_target,
});

const xctest = (body: string) =>
  `import XCTest\n@testable import SwiftFixture\n\nfinal class CandidateXCTests: XCTestCase {\n${body}\n}\n`;

const xctestTarget = (source: string, fn: string) =>
  ({ projectDir: FIXTURES, sourceFile: source, functionName: fn, framework: "xctest" as const, testTarget: "SwiftFixtureXCTests" });

describe("verifySwift on the fixture", () => {
  it("survives the four legitimate candidates and none of the five tautologies", async () => {
    for (const entry of await catalogue()) {
      const verdict = await verifySwift(await fromFile(entry), { target: target(entry) });
      expect(Verdict.safeParse(verdict).success).toBe(true);
      expect(verdict.task_id).toBe(entry.task_id);

      if (entry.expect === "survives") {
        expect(verdict.survived, `${entry.file}: ${verdict.error}`).toBe(true);
        expect(verdict.stage_reached).toBe("done");
        expect(verdict.error).toBeNull();
        expect(verdict.mutation?.killed ?? 0).toBeGreaterThanOrEqual(1);
        expect(verdict.mutation?.score ?? 0).toBeGreaterThan(0);
        expect(verdict.timing_ms.mutation).toBeGreaterThan(0);
      } else {
        expect(verdict.survived, entry.file).toBe(false);
        expect(verdict.tautological, entry.file).toBe(true);
        expect(verdict.compile_ok, entry.file).toBe(true);
        expect(verdict.pass_ok, entry.file).toBe(true);
        // The point of the static check: a tautology never reaches the stage that costs minutes.
        expect(verdict.stage_reached).toBe("pass");
        expect(verdict.mutation).toBeNull();
        expect(verdict.timing_ms.mutation).toBeUndefined();
        expect(verdict.error).toContain(entry.function);
      }
    }
  }, 1_800_000);

  it("records a Swift Testing kill as a kill rather than as a crash", async () => {
    // ADR-0005's regression, and the reason `sidecrew-test.sh` exists. Muter decides a mutant died by
    // matching `with ([1-9][0-9]*) failure` against the test output — XCTest's summary line, which
    // Swift Testing never prints. Without the wrapper every one of these lands in `timeout` instead of
    // `killed`, `killed >= 1` is never reached, and no @Test candidate can survive anything.
    for (const entry of (await catalogue()).filter((c) => c.framework === "swift-testing" && c.expect === "survives")) {
      const verdict = await verifySwift(await fromFile(entry), { target: target(entry) });
      expect(verdict.mutation?.killed ?? 0, `${entry.file}: ${JSON.stringify(verdict.mutation)}`).toBeGreaterThanOrEqual(1);
      expect(verdict.mutation?.timeout, entry.file).toBe(0);
      expect(verdict.survived, entry.file).toBe(true);
    }
  }, 900_000);

  it("bounds a mutant that never finishes instead of waiting for it", async () => {
    // `chunk` guards with `size < 1`; mutate that to `size > 1` and `i += size` steps by zero, so the
    // boundary candidate's own `size: 0` case loops for ever. Muter 16 has no per-mutant timeout, so
    // without the watchdog in `sidecrew-test.sh` this test does not finish — it is here as much to
    // prove the run *terminates* as to check where the mutant is counted.
    const entry = (await catalogue()).find((c) => c.function === "chunk" && c.expect === "survives");
    if (!entry) throw new Error("candidates.json has no surviving chunk candidate");
    const verdict = await verifySwift(await fromFile(entry), { target: target(entry), mutantTimeoutS: 20 });
    expect(verdict.mutation?.timeout ?? 0).toBeGreaterThanOrEqual(1);
    // Counted towards the score, never towards survival — the asymmetry ADR-0012 fixed for Stryker.
    expect(verdict.mutation?.killed ?? 0).toBeGreaterThanOrEqual(1);
    expect(verdict.survived).toBe(true);
  }, 900_000);

  it("stops at compile, and hands the retry the compiler's own words", async () => {
    const verdict = await verifySwift(
      candidate("slugify:happy_path:9", xctest('  func testWrongType() {\n    XCTAssertEqual(Strings.slugify(42), "a")\n  }')),
      { target: xctestTarget("Sources/SwiftFixture/Strings.swift", "slugify") },
    );
    expect(verdict).toMatchObject({ survived: false, compile_ok: false, pass_ok: false, stage_reached: "compile", mutation: null });
    expect(verdict.error).toContain("error:");
    expect(verdict.error?.length ?? 0).toBeLessThanOrEqual(2048);
    expect(verdict.timing_ms.pass).toBeUndefined();
  }, 600_000);

  it("stops at pass when the test compiles but is wrong about the answer", async () => {
    const verdict = await verifySwift(
      candidate("slugify:happy_path:8", xctest('  func testWrongAnswer() {\n    XCTAssertEqual(Strings.slugify("Hello World"), "Hello World")\n  }')),
      { target: xctestTarget("Sources/SwiftFixture/Strings.swift", "slugify") },
    );
    expect(verdict).toMatchObject({ survived: false, compile_ok: true, pass_ok: false, stage_reached: "pass", mutation: null });
    expect(verdict.error).toContain("hello-world");
  }, 600_000);

  it("refuses a test suite that ran nothing, which swift test calls a success", async () => {
    // The newest entry in ADR-0006's cheap-pass list, and one the exit code cannot see: `swift test`
    // exits 0 after running zero tests. Here the class has no `test`-prefixed method, so XCTest finds
    // nothing to run — while the file still compiles, still calls the function, and still asserts.
    const verdict = await verifySwift(
      candidate("slugify:happy_path:7", xctest('  func checkSlug() {\n    XCTAssertEqual(Strings.slugify("Hello World"), "hello-world")\n  }')),
      { target: xctestTarget("Sources/SwiftFixture/Strings.swift", "slugify") },
    );
    expect(verdict.compile_ok).toBe(true);
    expect(verdict.pass_ok).toBe(false);
    expect(verdict.tautological).toBe(false);
    expect(verdict.stage_reached).toBe("pass");
    expect(verdict.error).toContain("ran no tests at all");
    expect(verdict.survived).toBe(false);
  }, 600_000);

  it("fails a candidate that passes and asserts something, but kills nothing", async () => {
    // The cheap pass the static check does not catch (ADR-0006): a real assertion about a real call
    // that no mutant of the function can break. The mutation stage is the only thing standing here.
    const verdict = await verifySwift(
      candidate("applyAll:stateful_sequence:9", xctest('  func testReturnsAState() {\n    XCTAssertTrue(OrderState.allCases.contains(Machine.applyAll(.draft, [])))\n  }')),
      { target: xctestTarget("Sources/SwiftFixture/Machine.swift", "applyAll") },
    );
    expect(verdict.compile_ok).toBe(true);
    expect(verdict.pass_ok).toBe(true);
    expect(verdict.tautological).toBe(false);
    expect(verdict.stage_reached).toBe("done");
    expect(verdict.mutation?.killed).toBe(0);
    expect(verdict.survived).toBe(false);
    expect(verdict.error).toContain("applyAll");
  }, 900_000);

  it("shows the planted off-by-one for what it is", async () => {
    // fixtures/swift-fixture/README.md documents it: truncate cuts text whose length is exactly
    // maxLength. A boundary test that asserts the *correct* behaviour fails the pass stage — which is
    // how a survivor can still be wrong, and why ADR-0006 sends low-score survivors to review.
    const correct = await verifySwift(
      candidate("truncate:boundary:0", xctest('  func testLeavesTextOfExactlyMaxLengthAlone() {\n    XCTAssertEqual(Strings.truncate("abcd", maxLength: 4), "abcd")\n  }')),
      { target: xctestTarget("Sources/SwiftFixture/Strings.swift", "truncate") },
    );
    expect(correct.compile_ok).toBe(true);
    expect(correct.pass_ok).toBe(false);
    expect(correct.error).toContain("abc…");

    const pinsTheBug = await verifySwift(
      candidate("truncate:boundary:1", xctest('  func testCutsTextOfExactlyMaxLength() {\n    XCTAssertEqual(Strings.truncate("abcd", maxLength: 4), "abc…")\n    XCTAssertEqual(Strings.truncate("ab", maxLength: 0), "")\n  }')),
      { target: xctestTarget("Sources/SwiftFixture/Strings.swift", "truncate") },
    );
    expect(pinsTheBug.survived, `${pinsTheBug.error}`).toBe(true);
  }, 900_000);

  it("says which function had no mutants rather than blaming the test for it", async () => {
    // Muter's four operators see relational operators, logical connectors, ternaries and discarded side
    // effects. `unique` has none of them, so nothing can be mutated and nothing can be killed — and a
    // retry spent rewriting a perfectly good test would be a retry spent on the wrong problem.
    const verdict = await verifySwift(
      candidate("unique:happy_path:0", xctest('  func testKeepsFirstOccurrence() {\n    XCTAssertEqual(Arrays.unique([3, 1, 3, 2, 1]), [3, 1, 2])\n  }')),
      { target: xctestTarget("Sources/SwiftFixture/Arrays.swift", "unique") },
    );
    expect(verdict.compile_ok).toBe(true);
    expect(verdict.pass_ok).toBe(true);
    expect(verdict.stage_reached).toBe("done");
    expect(verdict.mutation?.killed).toBe(0);
    expect(verdict.survived).toBe(false);
    expect(verdict.error).toContain("no mutants");
    expect(verdict.error).toContain("not a fault in the test");
  }, 900_000);

  it("refuses a project it cannot run, rather than blaming the candidate for it", async () => {
    // "your toolchain is missing" and "your test is bad" must not reach the retry loop in the same
    // shape: one of them is worth retrying and the other will fail identically forever.
    await expect(
      verifySwift(candidate("slugify:happy_path:6", xctest("  func testNothing() {}")), {
        target: { ...xctestTarget("Strings.swift", "slugify"), projectDir: `${FIXTURES}/Sources` },
      }),
    ).rejects.toBeInstanceOf(VerifierSetupError);
  }, 120_000);

  it("refuses to guess which of two test targets a candidate belongs to", async () => {
    await expect(
      verifySwift(candidate("slugify:happy_path:5", xctest("  func testNothing() {}")), {
        target: { projectDir: FIXTURES, sourceFile: "Sources/SwiftFixture/Strings.swift", functionName: "slugify", framework: "xctest" },
      }),
    ).rejects.toThrow(/test targets/);
  }, 120_000);
});
