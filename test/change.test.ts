// The parts of the workload-#2a gate that are pure: reading `tsc`, reading a test report, and the
// contract that makes a `ChangeVerdict` unable to claim a survival its own fields do not support.
//
// ADR-0037 is why the second and third blocks exist. The compile stage of workload #1 could report
// `compile ok` on a candidate it never opened, and did, for six trials. The 2a versions of that failure
// are "the tsconfig does not cover this file, so it has no errors" and "the suite collected nothing, so
// it is green" — both are here, and both fail loudly rather than quietly.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  assertInProgram, parseTestReport, parseTscErrors, programFiles, sandboxCacheDir, suiteArgs, typecheck,
  PROJECT_SCOPE,
} from "../src/change.js";
import { ChangeVerdict, changeSurvives } from "../src/schemas.js";
import { VerifierSetupError } from "../src/verifier/shared.js";

const SANDBOX = "/tmp/sandbox";

describe("parseTscErrors", () => {
  it("counts per file, from --pretty false output", () => {
    const counts = parseTscErrors([
      "src/cart.ts(17,34): error TS18048: 'cart.discount' is possibly 'undefined'.",
      "src/rates.ts(11,16): error TS2538: Type 'undefined' cannot be used as an index type.",
      "src/rates.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.",
    ].join("\n"), SANDBOX);
    expect(counts).toEqual({ total: 3, by_file: { "src/cart.ts": 1, "src/rates.ts": 2 } });
  });

  it("makes an absolute path relative to the sandbox, because that is how the contract spells a file", () => {
    const counts = parseTscErrors(`${SANDBOX}/src/rates.ts(11,16): error TS2538: nope`, SANDBOX);
    expect(counts.by_file).toEqual({ "src/rates.ts": 1 });
  });

  it("keeps an error that belongs to no file, under (project)", () => {
    // `TS18003 No inputs were found` has no file. Dropping it would let a change that broke the whole
    // program fall out of the accounting and read as zero errors.
    const counts = parseTscErrors("error TS18003: No inputs were found in config file.", SANDBOX);
    expect(counts).toEqual({ total: 1, by_file: { [PROJECT_SCOPE]: 1 } });
  });

  it("ignores everything that is not an error line", () => {
    const counts = parseTscErrors([
      `${SANDBOX}/node_modules/typescript/lib/lib.es2022.d.ts`,
      `${SANDBOX}/src/money.ts`,
      "src/rates.ts(11,16): error TS2538: nope",
      "Found 1 error in src/rates.ts:11",
    ].join("\n"), SANDBOX);
    expect(counts.total).toBe(1);
  });
});

describe("programFiles — ADR-0037 asked of this gate", () => {
  it("takes the sandbox-relative file list off --listFiles", () => {
    const program = programFiles([
      `${SANDBOX}/node_modules/typescript/lib/lib.d.ts`,
      `${SANDBOX}/src/rates.ts`,
      `${SANDBOX}/test/rates.test.ts`,
      "/elsewhere/on/disk.ts",
      "",
    ].join("\n"), SANDBOX);
    expect([...program].sort()).toEqual(["node_modules/typescript/lib/lib.d.ts", "src/rates.ts", "test/rates.test.ts"]);
  });

  it("refuses a file tsc never looked at, rather than calling its zero errors a pass", () => {
    // This is the whole ADR-0037 failure mode: a task file outside the tsconfig's `include` reports no
    // errors forever, and `compile_ok` would be vacuously true on every candidate of that project.
    const program = programFiles(`${SANDBOX}/src/money.ts`, SANDBOX);
    expect(() => assertInProgram(["src/rates.ts"], program, "tsconfig.json")).toThrow(VerifierSetupError);
    expect(() => assertInProgram(["src/rates.ts"], program, "tsconfig.json")).toThrow(/ADR-0037/);
    expect(() => assertInProgram(["src/money.ts"], program, "tsconfig.json")).not.toThrow();
  });
});

describe("parseTestReport", () => {
  const report = {
    numTotalTests: 3,
    numPassedTests: 2,
    numFailedTests: 1,
    testResults: [
      {
        name: `${SANDBOX}/test/rates.test.ts`,
        assertionResults: [
          { fullName: "rates looks a rate up", status: "passed" },
          { fullName: "rates is zero for a code it does not know", status: "failed" },
        ],
      },
      { name: `${SANDBOX}/test/cart.test.ts`, assertionResults: [{ fullName: "cart discounts", status: "passed" }] },
    ],
  };

  it("reads the counts and the passing ids", () => {
    const parsed = parseTestReport(report, SANDBOX);
    expect(parsed.ran).toBe(3);
    expect(parsed.passed).toBe(2);
    expect(parsed.failed).toBe(1);
    expect(parsed.passed_ids).toEqual(["test/rates.test.ts::rates looks a rate up", "test/cart.test.ts::cart discounts"]);
  });

  it("qualifies an id by its file, so two tests of the same name are two tests", () => {
    // Without the file, "every test that passed before still passes" could be satisfied by a different
    // test that happens to share a name.
    const sameName = {
      numTotalTests: 2, numPassedTests: 2, numFailedTests: 0,
      testResults: [
        { name: `${SANDBOX}/test/a.test.ts`, assertionResults: [{ fullName: "returns zero", status: "passed" }] },
        { name: `${SANDBOX}/test/b.test.ts`, assertionResults: [{ fullName: "returns zero", status: "passed" }] },
      ],
    };
    expect(new Set(parseTestReport(sameName, SANDBOX).passed_ids).size).toBe(2);
  });

  it("survives a report with nothing in it rather than throwing", () => {
    // A suite that failed to load has counts and no assertions. Zero is the honest reading, and the
    // gate refuses it one layer up because it is fewer than the baseline ran.
    expect(parseTestReport({}, SANDBOX)).toEqual({ ran: 0, passed: 0, failed: 0, passed_ids: [], seen_ids: [] });
  });
});

describe("suiteArgs", () => {
  it("asks each runner for the whole suite and a machine-readable report", () => {
    expect(suiteArgs("vitest", "/tmp/r.json")).toEqual(["run", "--reporter=json", "--outputFile=/tmp/r.json"]);
    expect(suiteArgs("jest", "/tmp/r.json")).toEqual(["--ci", "--json", "--outputFile=/tmp/r.json"]);
  });

  it("gives jest a cache directory inside the sandbox, so no two runs share one (ADR-0055)", () => {
    // Measured: a shared cache across 24 differently-rooted sandboxes reached 3.8 GB and whole test
    // files stopped loading — 0 of 12 candidates survived for a reason no candidate caused.
    expect(suiteArgs("jest", "/tmp/r.json", "/sandbox/.cache"))
      .toContain("--cacheDirectory=/sandbox/.cache");
    expect(sandboxCacheDir("/sandbox")).toBe("/sandbox/.sidecrew-runner-cache");
  });

  it("never passes a flag that would let an empty run be a pass", () => {
    // ADR-0006's Swift lesson: `swift test` exits 0 on an empty suite and jest would too if asked
    // nicely. `--ci` is here for the snapshot reason; `--passWithNoTests` must never be.
    for (const runner of ["vitest", "jest"] as const) {
      expect(suiteArgs(runner, "/tmp/r.json").join(" ")).not.toContain("passWithNoTests");
    }
  });
});

// ── the contract, which is the part no verifier can be quietly wrong about ─────────────────────────

const verdict = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  task_id: "t",
  stage_reached: "done",
  survived: true,
  compile_ok: true,
  tests_ok: true,
  confined: true,
  files_touched: ["src/rates.ts"],
  errors: {
    before: { total: 1, by_file: { "src/rates.ts": 1 } },
    after: { total: 0, by_file: {} },
    introduced: {},
    remaining_in_target: {},
    message: null,
  },
  tests: { reported: true, ran_before: 12, ran_after: 12, passed_before: 12, passed_after: 12, regressed: [], message: null },
  confinement: [],
  error: null,
  timing_ms: { compile: 10, tests: 20 },
  ...over,
});

describe("ChangeVerdict enforces the gate as an iff (ADR-0048)", () => {
  it("parses a verdict whose fields support it", () => {
    expect(() => ChangeVerdict.parse(verdict())).not.toThrow();
  });

  it("refuses a survival its own fields contradict", () => {
    expect(() => ChangeVerdict.parse(verdict({ survived: false }))).toThrow(/survived must equal/);
    expect(() => ChangeVerdict.parse(verdict({ compile_ok: false, survived: true }))).toThrow(/survived must equal/);
  });

  it("refuses tests_ok when the stage never ran", () => {
    expect(() => ChangeVerdict.parse(verdict({ tests: null, survived: true }))).toThrow(/never ran/);
  });

  it("refuses tests_ok when the runner produced no report", () => {
    // The 2a form of ADR-0012: the machine failed, not the change, and a green here would be a fiction.
    const tests = { reported: false, ran_before: 12, ran_after: 0, passed_before: 12, passed_after: 0, regressed: [], message: "boom" };
    expect(() => ChangeVerdict.parse(verdict({ tests }))).toThrow(/no report/);
  });

  it("refuses tests_ok when fewer tests ran than in the baseline", () => {
    const tests = { reported: true, ran_before: 12, ran_after: 11, passed_before: 12, passed_after: 11, regressed: [], message: null };
    expect(() => ChangeVerdict.parse(verdict({ tests }))).toThrow(/fewer tests ran/);
  });

  it("refuses tests_ok when fewer tests PASSED, which is the only way a broken test.each case shows", () => {
    // ADR-0067, and the direction matters: this bug let a bad change *through*, where ADR-0066's
    // failure only refused a good one. A `test.each` block gives every case the same `fullName`, so
    // breaking one of nine leaves the id in the passing set — `regressed` is empty — and the failing
    // case still ran, so `ran_after >= ran_before` holds too. Only the counts can see it.
    // Measured on a real project: 54 ids appearing up to 9 times, 295 of 6,368 executions.
    const broken = verdict({
      tests: {
        reported: true,
        ran_before: 6368, ran_after: 6368,
        passed_before: 6159, passed_after: 6158,
        regressed: [],
        message: null,
      },
    });
    expect(ChangeVerdict.safeParse(broken).success).toBe(false);

    const honest = verdict({
      tests: {
        reported: true,
        ran_before: 6368, ran_after: 6368,
        passed_before: 6159, passed_after: 6159,
        regressed: [],
        message: null,
      },
    });
    expect(ChangeVerdict.safeParse(honest).success).toBe(true);
  });

  it("refuses tests_ok when a suite collected nothing at all", () => {
    const tests = { reported: true, ran_before: 0, ran_after: 0, passed_before: 0, passed_after: 0, regressed: [], message: null };
    expect(() => ChangeVerdict.parse(verdict({ tests }))).toThrow(/zero tests is not a green suite/);
  });

  it("refuses tests_ok when a test that passed before now fails", () => {
    const tests = { reported: true, ran_before: 12, ran_after: 12, passed_before: 12, passed_after: 12, regressed: ["test/a.test.ts::x"], message: "x" };
    expect(() => ChangeVerdict.parse(verdict({ tests }))).toThrow(/passed before now fails/);
  });

  it("refuses compile_ok with errors left in the task's files or introduced anywhere", () => {
    const errors = { ...(verdict().errors as Record<string, unknown>), remaining_in_target: { "src/rates.ts": 1 } };
    expect(() => ChangeVerdict.parse(verdict({ errors }))).toThrow(/zero errors in the task's files/);
    const introduced = { ...(verdict().errors as Record<string, unknown>), introduced: { "test/report.test.ts": 1 } };
    expect(() => ChangeVerdict.parse(verdict({ errors: introduced }))).toThrow(/none introduced anywhere else/);
  });

  it("refuses a confined flag that disagrees with its own list", () => {
    const confinement = [{ rule: "suppression_added", file: "src/rates.ts", detail: "line 1" }];
    expect(() => ChangeVerdict.parse(verdict({ confinement }))).toThrow(/confined must equal/);
  });

  it("is the same rule `changeSurvives` computes", () => {
    for (const over of [{}, { confined: false }, { compile_ok: false }, { tests_ok: false }]) {
      const v = verdict(over) as Parameters<typeof changeSurvives>[0];
      expect(changeSurvives(v)).toBe(v.confined && v.compile_ok && v.tests_ok);
    }
  });
});

describe("the monotone gate (ADR-0048)", () => {
  it("strictly fewer errors overall is a theorem, not a third condition", () => {
    // If the task's files went from N > 0 errors to zero and nothing else gained any, the total
    // strictly dropped. Two conditions rather than three is what makes the gate converge over many
    // tasks without any single one having to finish the job — so it is asserted rather than assumed.
    const targets = ["src/a.ts", "src/b.ts"];
    const before = { total: 9, by_file: { "src/a.ts": 4, "src/b.ts": 2, "src/c.ts": 3 } };
    for (const after of [
      { total: 3, by_file: { "src/c.ts": 3 } },
      { total: 1, by_file: { "src/c.ts": 1 } },
    ]) {
      const remaining = targets.filter((f) => (after.by_file as Record<string, number>)[f] !== undefined);
      const introduced = Object.entries(after.by_file).filter(([f, n]) => n > ((before.by_file as Record<string, number>)[f] ?? 0));
      expect(remaining).toEqual([]);
      expect(introduced).toEqual([]);
      expect(after.total).toBeLessThan(before.total);
    }
  });
});

describe("a tsc that did not run is not a clean project", () => {
  it("refuses an empty file list rather than reading it as zero errors", async () => {
    // Found by the first real run of this gate, which makes it four for four (PHASES, Phase 9): a
    // relative project path made the compiler unspawnable, `run` returned an empty stdout because it
    // never throws, and `parseTscErrors` read that as a clean compile — `compile ok` on something the
    // compiler never opened, which is ADR-0037 in the gate written to be paranoid about ADR-0037.
    //
    // `--listFiles` is what makes it detectable: every successful invocation lists at least the
    // TypeScript lib files, so an empty program cannot be a real one.
    const dir = await mkdtemp(join(tmpdir(), "sidecrew-notsc-"));
    try {
      await mkdir(join(dir, "node_modules", ".bin"), { recursive: true });
      // A "tsc" that fails the way a missing one does: no output, non-zero exit.
      await writeFile(join(dir, "node_modules", ".bin", "tsc"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      await expect(typecheck(dir, dir, "tsconfig.json", 10_000)).rejects.toThrow(VerifierSetupError);
      await expect(typecheck(dir, dir, "tsconfig.json", 10_000)).rejects.toThrow(/did not run — not that the project is clean/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("a generated test name is not a regression — ADR-0053", () => {
  const report = (tests: { file: string; name: string; status: string }[]) => ({
    numTotalTests: tests.length,
    numPassedTests: tests.filter((t) => t.status === "passed").length,
    numFailedTests: tests.filter((t) => t.status !== "passed").length,
    testResults: [...new Set(tests.map((t) => t.file))].map((file) => ({
      name: file,
      assertionResults: tests.filter((t) => t.file === file).map((t) => ({ fullName: t.name, status: t.status })),
    })),
  });

  it("collects every id it saw, not only the passing ones", () => {
    const r = parseTestReport(report([
      { file: "a.test.ts", name: "one", status: "passed" },
      { file: "a.test.ts", name: "two", status: "failed" },
    ]), "/sandbox");
    expect(r.passed_ids).toEqual(["a.test.ts::one"]);
    expect(r.seen_ids.sort()).toEqual(["a.test.ts::one", "a.test.ts::two"]);
  });

  it("a test that passed before and failed after is present in the report, so it is a regression", () => {
    const after = parseTestReport(report([{ file: "a.test.ts", name: "one", status: "failed" }]), "/sandbox");
    const before = ["a.test.ts::one"];
    const seen = new Set(after.seen_ids);
    const passed = new Set(after.passed_ids);
    expect(before.filter((id) => !passed.has(id) && seen.has(id))).toEqual(["a.test.ts::one"]);
  });

  it("a test whose generated name changed is absent from the report, so it is not", () => {
    // The real shape: a title built from Date.now(), so the id differs on every run.
    const after = parseTestReport(report([
      { file: "dateTz.test.ts", name: "isValid(1789694335112) === true", status: "passed" },
    ]), "/sandbox");
    const before = ["dateTz.test.ts::isValid(1789694000000) === true"];
    const seen = new Set(after.seen_ids);
    const passed = new Set(after.passed_ids);
    expect(before.filter((id) => !passed.has(id) && seen.has(id))).toEqual([]);
  });
});
