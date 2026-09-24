// The whole pipeline against the real fixture: tsc, vitest and Stryker all actually run.
// SIDECREW_SLOW=1 to include. Needs `sidecrew tools install` (ADR-0088); the fixture itself needs nothing beyond the repo root's vitest and typescript.
import { readFile } from "node:fs/promises";
import { describe, it, expect } from "vitest";
import { verifyTs, VerifierSetupError } from "../src/verifier/ts.js";
import { Verdict, type Candidate } from "../src/schemas.js";

const FIXTURES = "fixtures/ts-fixture";

interface CandidateEntry {
  file: string;
  task_id: string;
  source: string;
  function: string;
  expect: "survives" | "tautological";
}

const catalogue = async (): Promise<CandidateEntry[]> =>
  (JSON.parse(await readFile(`${FIXTURES}/candidates.json`, "utf8")) as { candidates: CandidateEntry[] }).candidates;

const candidate = (task_id: string, test_source: string): Candidate => ({
  task_id,
  worker: { kind: "local", model: "fixtures/ts-fixture", revision: "checked-in", temperature: 0, seed: 42 },
  test_source,
  usage: { prompt_tokens: 0, completion_tokens: 0 },
  timing: { ttft_ms: 0, wall_ms: 0 },
});

const fromFile = async (entry: CandidateEntry): Promise<Candidate> =>
  candidate(entry.task_id, await readFile(`${FIXTURES}/${entry.file}`, "utf8"));

const target = (entry: Pick<CandidateEntry, "source" | "function">) => ({
  projectDir: FIXTURES,
  sourceFile: entry.source,
  functionName: entry.function,
});

describe("the compile stage must prove it checked the candidate — ADR-0037", () => {
  // `tsconfig.narrow-include.json` is the fixture with `include: ["src"]`, so the candidate written to
  // `test/` is outside every include glob — the shape a real React project had. Before ADR-0037 the
  // stage reported `compile ok` without opening the candidate at all.
  const NARROW = "tsconfig.narrow-include.json";

  it(
    "fails a candidate that passes at runtime and does not type-check",
    { timeout: 10 * 60_000 },
    async () => {
      // Measured before the fix: survived, compile ok, pass ok, mutation score 0.8. A candidate that
      // does not compile, through a gate whose first conjunct is "compiles".
      const source = await readFile(`${FIXTURES}/illtyped/silent-type-errors.test.ts`, "utf8");
      const verdict = await verifyTs(candidate("chunk:happy_path:0", source), {
        target: { projectDir: FIXTURES, sourceFile: "src/arrays.ts", functionName: "chunk", tsconfig: NARROW },
        concurrency: 1,
      });
      expect(verdict.compile_ok).toBe(false);
      expect(verdict.survived).toBe(false);
      expect(verdict.stage_reached).toBe("compile");
      // All three, and nothing about the file list `--listFiles` prints to find them.
      expect(verdict.error).toContain("TS2322");
      expect(verdict.error).toContain("TS2554");
      expect(verdict.error ?? "").not.toMatch(/^\/.*lib\.es5\.d\.ts$/m);
    },
  );

  it(
    "still survives a good candidate on that same project",
    { timeout: 10 * 60_000 },
    async () => {
      // The fix must widen the program, not refuse the project. Same verdict as the normal tsconfig.
      const source = await readFile(`${FIXTURES}/legitimate/boundary.test.ts`, "utf8");
      const verdict = await verifyTs(candidate("chunk:boundary:0", source), {
        target: { projectDir: FIXTURES, sourceFile: "src/arrays.ts", functionName: "chunk", tsconfig: NARROW },
        concurrency: 1,
      });
      expect(verdict.compile_ok, verdict.error ?? "").toBe(true);
      expect(verdict.stage_reached).toBe("done");
      expect(verdict.survived).toBe(true);
    },
  );
});

describe("verifyTs on the fixture", () => {
  it("survives the four legitimate candidates and none of the four tautologies", async () => {
    for (const entry of await catalogue()) {
      const verdict = await verifyTs(await fromFile(entry), { target: target(entry) });
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
        // The point of the static check: a tautology never reaches the stage that costs money.
        expect(verdict.stage_reached).toBe("pass");
        expect(verdict.mutation).toBeNull();
        expect(verdict.timing_ms.mutation).toBeUndefined();
        expect(verdict.error).toContain(entry.function);
      }
    }
  }, 600_000);

  it("stops at compile, and hands the retry the compiler's own words", async () => {
    const verdict = await verifyTs(
      candidate("slugify:happy_path:9", 'import { slugify } from "../src/strings";\nimport { it, expect } from "vitest";\nit("x", () => { expect(slugify(42)).toBe("a"); });\n'),
      { target: target({ source: "src/strings.ts", function: "slugify" }) },
    );
    expect(verdict).toMatchObject({ survived: false, compile_ok: false, pass_ok: false, stage_reached: "compile", mutation: null });
    expect(verdict.error).toContain("TS2345");
    expect(verdict.error?.length ?? 0).toBeLessThanOrEqual(2048);
    expect(verdict.timing_ms.pass).toBeUndefined();
  }, 120_000);

  it("stops at pass when the test compiles but is wrong about the answer", async () => {
    const verdict = await verifyTs(
      candidate("slugify:happy_path:8", 'import { slugify } from "../src/strings";\nimport { it, expect } from "vitest";\nit("x", () => { expect(slugify("Hello World")).toBe("Hello World"); });\n'),
      { target: target({ source: "src/strings.ts", function: "slugify" }) },
    );
    expect(verdict).toMatchObject({ survived: false, compile_ok: true, pass_ok: false, stage_reached: "pass", mutation: null });
    expect(verdict.error).toContain("hello-world");
  }, 120_000);

  it("says a function with nothing mutable is about the function, not the test", async () => {
    // This test used to be "fails a candidate that passes … but kills nothing", on `applyAll`. Its one
    // mutant is a type error the checker discards, so it never exercised a weak test against live
    // mutants, and the old message said "the test passes against every changed version", which is
    // false (ADR-0082 D found the same defect on a real project, 24 Sep 2026). Kept, with the truth.
    const verdict = await verifyTs(
      candidate("applyAll:stateful_sequence:9", 'import { applyAll } from "../src/machine";\nimport { it, expect } from "vitest";\nit("x", () => { expect(typeof applyAll("draft", [])).toBe("string"); });\n'),
      { target: target({ source: "src/machine.ts", function: "applyAll" }) },
    );
    expect(verdict.survived).toBe(false);
    expect(verdict.mutation).toMatchObject({ killed: 0, survived: 0, timeout: 0, no_coverage: 0 });
    expect(verdict.error).toContain("nothing in applyAll could be mutated");
    expect(verdict.error).not.toContain("against every changed version");
  }, 300_000);

  it("KNOWN HOLE (ADR-0089): a type-only assertion survives by killing the empty-body mutant", async () => {
    // Recorded as the gate behaves today so the hole cannot close or widen unnoticed. Measured
    // 24 Sep 2026: `typeof slugify(x) === "string"` kills 1 of 12 mutants (score 0.083), is not
    // tautological to the detector, and survives. Flip these expectations when ADR-0089 is decided.
    const verdict = await verifyTs(
      candidate("slugify:happy_path:9", 'import { slugify } from "../src/strings";\nimport { it, expect } from "vitest";\nit("x", () => { expect(typeof slugify("Hello World")).toBe("string"); });\n'),
      { target: target({ source: "src/strings.ts", function: "slugify" }) },
    );
    expect(verdict.tautological).toBe(false);
    expect(verdict.mutation?.killed).toBe(1);
    expect(verdict.mutation!.score).toBeLessThan(0.1);
    expect(verdict.survived).toBe(true);
  }, 300_000);

  it("does not hand a candidate the kills the previous candidate earned", async () => {
    // The regression for the measured leak in ADR-0004. The second candidate covers none of the lines
    // being mutated, which is exactly the case where Stryker's incremental differ reuses everything it
    // has — so if the cache outlived the sandbox, this would come back with the first one's kills.
    const [first] = await catalogue();
    if (!first) throw new Error("candidates.json is empty");
    const earned = await verifyTs(await fromFile(first), { target: target(first) });
    expect(earned.mutation?.killed ?? 0).toBeGreaterThan(0);

    const elsewhere = await verifyTs(
      candidate("commonPrefix:happy_path:0", 'import { commonPrefix } from "../src/strings";\nimport { it, expect } from "vitest";\nit("x", () => { expect(commonPrefix("sidecrew", "sidecar")).toBe("sidec"); });\n'),
      {
        // Deliberately mismatched: a real test of commonPrefix, with the mutation scope left on the
        // lines of slugify that the previous candidate has just earned kills on.
        target: { projectDir: FIXTURES, sourceFile: first.source, functionName: "commonPrefix", lineRange: [7, 14] },
      },
    );
    expect(elsewhere.pass_ok).toBe(true);
    expect(elsewhere.tautological).toBe(false);
    expect(elsewhere.mutation?.killed).toBe(0);
    expect(elsewhere.mutation?.killed_ids).toEqual([]);
    expect((elsewhere.mutation?.survived ?? 0) + (elsewhere.mutation?.no_coverage ?? 0)).toBeGreaterThan(0);
    expect(elsewhere.survived).toBe(false);
  }, 600_000);

  it("shows the planted off-by-one for what it is", async () => {
    // fixtures/ts-fixture/README.md documents it: truncate cuts text whose length is exactly maxLength.
    // A boundary test that asserts the *correct* behaviour fails the pass stage — which is how a
    // survivor can still be wrong, and why ADR-0006 sends low-score survivors to review.
    const correct = await verifyTs(
      candidate("truncate:boundary:0", 'import { truncate } from "../src/strings";\nimport { it, expect } from "vitest";\nit("leaves text of exactly maxLength alone", () => { expect(truncate("abcd", 4)).toBe("abcd"); });\n'),
      { target: target({ source: "src/strings.ts", function: "truncate" }) },
    );
    expect(correct.compile_ok).toBe(true);
    expect(correct.pass_ok).toBe(false);
    expect(correct.error).toContain("abc…");

    const pinsTheBug = await verifyTs(
      candidate("truncate:boundary:1", 'import { truncate } from "../src/strings";\nimport { it, expect } from "vitest";\nit("cuts text of exactly maxLength", () => { expect(truncate("abcd", 4)).toBe("abc…"); });\n'),
      { target: target({ source: "src/strings.ts", function: "truncate" }) },
    );
    expect(pinsTheBug.survived).toBe(true);
  }, 300_000);

  it("says `nothing here could be mutated` on TypeScript, not just on Swift", async () => {
    // ADR-0005 named the two ways `killed == 0` happens and said the second was reachable on
    // TypeScript. Measured in Phase 5, it is: under strict TS, every mutant of `machine.ts`'s
    // `nextState` is a type error — `??` to `&&` changes the return type, an emptied body returns
    // nothing — so Stryker's type checker drops all of them and the function has no mutants at all.
    // A correct, thorough test of it therefore cannot survive, and the retry loop must not spend the
    // one retry rewriting it. `fixtures/ts-fixture/README.md` explains why the module has no plan.
    const verdict = await verifyTs(
      candidate("nextState:happy_path:0", 'import { nextState } from "../src/machine";\nimport { it, expect } from "vitest";\nit("moves a draft order to placed", () => { expect(nextState("draft", "place")).toBe("placed"); expect(nextState("shipped", "cancel")).toBe("shipped"); });\n'),
      { target: target({ source: "src/machine.ts", function: "nextState" }) },
    );
    expect(verdict.compile_ok).toBe(true);
    expect(verdict.pass_ok).toBe(true);
    expect(verdict.tautological).toBe(false);
    const m = verdict.mutation!;
    // All four zero — the branch a retry loop reads to tell this apart from "the test caught none".
    expect([m.killed, m.survived, m.timeout, m.no_coverage]).toEqual([0, 0, 0, 0]);
    expect(verdict.survived).toBe(false);
    expect(verdict.error).toMatch(/could be mutated|was killed/);
  }, 300_000);

  it("refuses a project it cannot run, rather than blaming the candidate for it", async () => {
    // "your toolchain is missing" and "your test is bad" must not reach the retry loop in the same
    // shape: one of them is worth retrying and the other will fail identically forever.
    await expect(
      verifyTs(candidate("slugify:happy_path:6", "it('x', () => {});"), {
        target: { projectDir: `${FIXTURES}/src`, sourceFile: "strings.ts", functionName: "slugify" },
      }),
    ).rejects.toBeInstanceOf(VerifierSetupError);
  }, 120_000);
});
