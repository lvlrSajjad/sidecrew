// `sidecrew recon` without a compiler: the arithmetic, the contract, and the sentence (ADR-0079 option A,
// ADR-0090). The real `tsc` is in recon.slow.test.ts.
import { describe, expect, it } from "vitest";
import { PROJECT_SCOPE } from "../src/change.js";
import {
  alreadyOn, countCodes, flagFinding, isEnabled, parseShowConfig, RECON_NOTE, renderRecon, split, type Compile,
} from "../src/recon.js";
import { ReconFlag, ReconReport } from "../src/schemas.js";

const compile = (by_file: Record<string, number>, codes: Record<string, number> = {}): Compile =>
  ({ by_file, codes: new Map(Object.entries(codes)) });

const report = (over: Partial<ReconReport> = {}): ReconReport => ({
  version: 1,
  project: "/somewhere/project",
  tsconfig: "tsconfig.json",
  commit: "7ec88df000000000000000000000000000000000",
  typescript: "5.9.3",
  created: "2026-09-24T10:00:00.000Z",
  config_read: true,
  baseline: {
    errors: 0, source: { errors: 0, files: 0 }, tests: { errors: 0, files: 0 }, config_errors: 0,
    program_files: 40, tests_in_program: 12, top_codes: [], ms: 900,
  },
  flags: [],
  fix_offered: false,
  note: RECON_NOTE,
  ...over,
});

describe("isEnabled — is a flag already on in the project's resolved config", () => {
  it("reads an explicit setting", () => {
    expect(isEnabled({ strictNullChecks: true }, "--strictNullChecks")).toBe(true);
    expect(isEnabled({ noUnusedLocals: false }, "--noUnusedLocals")).toBe(false);
    expect(isEnabled({}, "--noUnusedLocals")).toBe(false);
  });

  it("knows what --strict turns on, for a compiler that does not spell it out", () => {
    expect(isEnabled({ strict: true }, "--noImplicitAny")).toBe(true);
    expect(isEnabled({ strict: true }, "--strict")).toBe(true);
    // Not in the family: `strict` says nothing about unused locals.
    expect(isEnabled({ strict: true }, "--noUnusedLocals")).toBe(false);
  });

  it("lets an explicit false beat --strict, as tsc does", () => {
    // project-a's shape: strict-ish, with strictNullChecks off — exactly the case recon exists for.
    expect(isEnabled({ strict: true, strictNullChecks: false }, "--strictNullChecks")).toBe(false);
  });
});

describe("parseShowConfig", () => {
  it("takes compilerOptions, and answers null rather than guessing", () => {
    expect(parseShowConfig('{"compilerOptions":{"strict":true},"files":["./a.ts"]}')).toEqual({ strict: true });
    expect(parseShowConfig("error TS5058: The specified path does not exist")).toBeNull();
    expect(parseShowConfig('{"files":[]}')).toBeNull();
  });
});

describe("countCodes", () => {
  it("counts TSnnnn per compile, file-bound or not", () => {
    const text = [
      "src/a.ts(1,2): error TS2532: Object is possibly 'undefined'.",
      "src/b.ts(3,4): error TS2532: Object is possibly 'undefined'.",
      "src/b.ts(5,6): error TS18048: 'x' is possibly 'undefined'.",
      "error TS5023: Unknown compiler option 'x'.",
      "  a continuation line, which is not an error",
    ].join("\n");
    expect(Object.fromEntries(countCodes(text))).toEqual({ TS2532: 2, TS18048: 1, TS5023: 1 });
  });
});

describe("split — source against tests, with the gate's own test predicate", () => {
  it("puts spec files, __tests__ and e2e specs on the test side, and fileless errors apart", () => {
    const s = split({
      "src/a.ts": 3, "src/a.spec.ts": 2, "src/__tests__/b.ts": 1, "test/app.e2e-spec.ts": 4,
      [PROJECT_SCOPE]: 1, "src/zero.ts": 0,
    });
    expect(s.source).toEqual({ errors: 3, files: 1 });
    expect(s.tests).toEqual({ errors: 7, files: 3 });
    expect(s.config).toBe(1);
  });
});

describe("flagFinding — what a flag adds, per file and never negative", () => {
  it("counts only the positive part per file, so a lost error cannot hide a gained one", () => {
    const base = compile({ "src/a.ts": 2, "src/b.ts": 1 }, { TS2322: 3 });
    const under = compile({ "src/a.ts": 1, "src/b.ts": 4, "src/c.spec.ts": 2 }, { TS2322: 1, TS2532: 6 });
    const f = flagFinding("--strictNullChecks", base, under, 10, 1234);
    // Totals would say 7 − 3 = 4. The work is b +3 and the spec +2; a's −1 cancels nothing.
    expect(f.added).toBe(5);
    expect(f.source).toEqual({ errors: 3, files: 1 });
    expect(f.tests).toEqual({ errors: 2, files: 1 });
    expect(f.top_files).toEqual([
      { file: "src/b.ts", errors: 3, test: false },
      { file: "src/c.spec.ts", errors: 2, test: true },
    ]);
    expect(f.top_codes).toEqual([{ code: "TS2532", count: 6 }]);
    expect(ReconFlag.safeParse(f).success).toBe(true);
  });

  it("caps the file list and keeps the order stable", () => {
    const under = compile({ "b.ts": 2, "a.ts": 2, "c.ts": 5 });
    const f = flagFinding("--noUnusedLocals", compile({}), under, 2, 0);
    expect(f.top_files.map((x) => x.file)).toEqual(["c.ts", "a.ts"]);
    expect(f.source).toEqual({ errors: 9, files: 3 });
  });

  it("reports a flag the compiler rejects as errors against no file, not as a clean project", () => {
    const f = flagFinding("--exactOptionalPropertyTypes", compile({}), compile({ [PROJECT_SCOPE]: 1 }), 10, 0);
    expect(f.added).toBe(1);
    expect(f.config_errors).toBe(1);
    expect(f.top_files).toEqual([]);
  });
});

describe("ReconReport — the contract refuses what the report must not say", () => {
  const measured = flagFinding("--strictNullChecks", compile({}), compile({ "src/a.ts": 3 }), 10, 50);

  it("accepts a well-formed report", () => {
    expect(ReconReport.safeParse(report({ flags: [measured, alreadyOn("--noImplicitAny")] })).success).toBe(true);
  });

  it("does not serialise a report that offers to fix what it counts (PHASES.md 14d)", () => {
    expect(ReconReport.safeParse({ ...report(), fix_offered: true }).success).toBe(false);
  });

  it("does not let an already-on flag carry counts, or a measured one omit them", () => {
    expect(ReconReport.safeParse(report({ flags: [{ ...alreadyOn("--noImplicitAny"), added: 0 }] })).success).toBe(false);
    expect(ReconReport.safeParse(report({ flags: [{ ...measured, tests: null }] })).success).toBe(false);
  });

  it("does not let added disagree with its own parts", () => {
    expect(ReconReport.safeParse(report({ flags: [{ ...measured, added: 99 }] })).success).toBe(false);
  });

  it("cannot claim a flag is already on when the configuration was never read", () => {
    expect(ReconReport.safeParse(report({ config_read: false, flags: [alreadyOn("--noImplicitAny")] })).success).toBe(false);
  });

  it("refuses a program of zero files — that is a tsc that did not run (ADR-0037)", () => {
    expect(ReconReport.safeParse(report({ baseline: { ...report().baseline, program_files: 0 } })).success).toBe(false);
  });

  it("refuses a flag reported twice", () => {
    expect(ReconReport.safeParse(report({ flags: [measured, measured] })).success).toBe(false);
  });
});

describe("renderRecon — the sentence ADR-0079 asked for", () => {
  it("says zero, then what the flag adds, source and tests apart, and that it is not an offer", () => {
    const f = flagFinding("--strictNullChecks", compile({}), compile({ "src/a.ts": 700, "src/a.spec.ts": 63 }), 10, 50);
    const text = renderRecon(report({ flags: [f, alreadyOn("--noImplicitAny")] }));
    expect(text).toMatch(/your own configuration\s+0 errors/);
    expect(text).toMatch(/\+ --strictNullChecks\s+\+763 errors — source: 700 errors in 1 file · tests: 63 errors in 1 file/);
    expect(text).toMatch(/--noImplicitAny\s+already on in tsconfig\.json/);
    expect(text).toMatch(/a\.spec\.ts {2}\(test\)/);
    expect(text).toContain("A count, not an offer.");
  });
});
