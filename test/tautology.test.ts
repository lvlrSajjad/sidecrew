// The detector has one job: separate eight tests that all compile and all pass.
import { readFile, readdir } from "node:fs/promises";
import { describe, it, expect } from "vitest";
import {
  analyseTautology,
  callsFunction,
  isConstantExpression,
  isTautological,
  mask,
  withoutImports,
} from "../src/verifier/tautology.js";

const FIXTURES = "fixtures/ts-fixture";

interface CandidateEntry { file: string; function: string; expect: "survives" | "tautological" }
const catalogue = async (): Promise<CandidateEntry[]> =>
  (JSON.parse(await readFile(`${FIXTURES}/candidates.json`, "utf8")) as { candidates: CandidateEntry[] }).candidates;

describe("the eight fixtures", () => {
  it("flags all four tautologies and none of the four legitimate tests", async () => {
    const results = await Promise.all(
      (await catalogue()).map(async (c) => ({
        file: c.file,
        expected: c.expect === "tautological",
        report: analyseTautology(await readFile(`${FIXTURES}/${c.file}`, "utf8"), c.function),
      })),
    );
    expect(results).toHaveLength(8);
    for (const { file, expected, report } of results) {
      expect(report.tautological, `${file}: ${JSON.stringify(report.findings)}`).toBe(expected);
      // A finding with no message is a verdict the retry prompt cannot use.
      for (const f of report.findings) expect(f.message.length).toBeGreaterThan(10);
    }
  });

  it("names a different reason for each of the four tautologies", async () => {
    const codes = await Promise.all(
      (await catalogue())
        .filter((c) => c.expect === "tautological")
        .map(async (c) => analyseTautology(await readFile(`${FIXTURES}/${c.file}`, "utf8"), c.function).findings[0]?.code),
    );
    expect(new Set(codes).size).toBe(4);
  });

  it("covers every file in both fixture directories", async () => {
    const listed = new Set((await catalogue()).map((c) => c.file));
    for (const dir of ["tautological", "legitimate"]) {
      for (const file of await readdir(`${FIXTURES}/${dir}`)) {
        expect(listed.has(`${dir}/${file}`), `${dir}/${file} is not in candidates.json`).toBe(true);
      }
    }
  });
});

describe("analyseTautology", () => {
  const src = (body: string) => `import { slugify } from "../src/strings";\n${body}\n`;

  it("flags a test with no assertions at all", () => {
    const r = analyseTautology(src(`it("runs", () => { slugify("a"); });`), "slugify");
    expect(r.findings.map((f) => f.code)).toEqual(["no_assertions"]);
  });

  it("flags constant assertions however they are spelled", () => {
    for (const assertion of ["expect(true).toBe(true)", "expect(2 + 2).toBe(4)", "assert.ok(1)", "assert(true)", 'expect("a").toEqual("a")']) {
      const r = analyseTautology(src(`it("runs", () => { slugify("a"); ${assertion}; });`), "slugify");
      expect(r.tautological, assertion).toBe(true);
      expect(r.findings[0]?.code, assertion).toBe("constant_assertions");
    }
  });

  it("flags a value compared with itself, spaced or not", () => {
    const r = analyseTautology(src(`it("runs", () => { const out = slugify("a"); expect(out).toBe( out ); });`), "slugify");
    expect(r.findings.map((f) => f.code)).toEqual(["self_comparison"]);
  });

  it("flags snapshots as the only assertion", () => {
    const r = analyseTautology(src(`it("runs", () => { expect(slugify("a")).toMatchSnapshot(); });`), "slugify");
    expect(r.findings.map((f) => f.code)).toEqual(["snapshot_only"]);
  });

  it("flags a test that imports the function but never calls it", () => {
    const r = analyseTautology(src(`it("runs", () => { expect([1, 2].length).toBe(2); });`), "slugify");
    expect(r.findings.map((f) => f.code)).toEqual(["function_never_called"]);
  });

  it("passes a test where one real assertion sits among constant ones", () => {
    const r = analyseTautology(src(`it("runs", () => { expect(true).toBe(true); expect(slugify("A b")).toBe("a-b"); });`), "slugify");
    expect(r.tautological).toBe(false);
    expect(r.assertions).toBe(2);
    expect(r.meaningful).toBe(1);
  });

  it("does not read assertions out of strings or comments", () => {
    const r = analyseTautology(
      src(`it("expect(true).toBe(true) is not an assertion", () => {\n  // expect(1).toBe(1)\n  expect(slugify("A")).toBe("a");\n});`),
      "slugify",
    );
    expect(r.assertions).toBe(1);
    expect(r.tautological).toBe(false);
  });

  it("counts expect.assertions as setup rather than as an assertion", () => {
    const r = analyseTautology(src(`it("runs", () => { expect.assertions(1); expect(slugify("A")).toBe("a"); });`), "slugify");
    expect(r.assertions).toBe(1);
    expect(r.tautological).toBe(false);
  });

  it("reads through not / resolves / rejects to the matcher underneath", () => {
    const self = analyseTautology(src(`it("runs", async () => { const p = slugify("a"); await expect(p).resolves.toBe(p); });`), "slugify");
    expect(self.findings.map((f) => f.code)).toEqual(["self_comparison"]);
    const real = analyseTautology(src(`it("runs", () => { expect(slugify("A")).not.toBe("A"); });`), "slugify");
    expect(real.tautological).toBe(false);
  });

  it("gives the line of the offending assertion", () => {
    const r = analyseTautology(`import { slugify } from "../src/strings";\n\nit("runs", () => {\n  slugify("a");\n  expect(true).toBe(true);\n});\n`, "slugify");
    expect(r.findings[0]?.line).toBe(5);
  });

  it("reports both reasons when a test neither calls the function nor asserts anything real", () => {
    const r = analyseTautology(src(`it("runs", () => { expect(true).toBe(true); });`), "slugify");
    expect(r.findings.map((f) => f.code).sort()).toEqual(["constant_assertions", "function_never_called"]);
  });
});

describe("the pieces", () => {
  it("masks comments and string contents while keeping every index in place", () => {
    const source = `const a = "expect(1)"; // expect(2)\n/* expect(3) */ const b = 1;`;
    const masked = mask(source);
    expect(masked).toHaveLength(source.length);
    expect(masked.split("\n")).toHaveLength(2);
    expect(masked).not.toContain("expect");
    expect(masked).toContain('"xxxxxxxxx"');
  });

  it("blanks single and multi-line imports, and nothing else", () => {
    const masked = mask(`import {\n  slugify,\n} from "../src/strings";\nimport "./setup";\nslugify("a");\n`);
    const body = withoutImports(masked);
    // `mask` has already replaced the string's contents; `withoutImports` only blanks the imports.
    expect(body.trim()).toBe('slugify("x");');
    expect(body.split("\n")).toHaveLength(6);
  });

  it("knows a call from a mention", () => {
    expect(callsFunction(mask(`import { slugify } from "./s";\nslugify("a");`), "slugify")).toBe(true);
    expect(callsFunction(mask(`import { slugify } from "./s";\nconst f = slugify;`), "slugify")).toBe(false);
    expect(callsFunction(mask(`import { slugify } from "./s";\nconst s = "slugify(1)";`), "slugify")).toBe(false);
  });

  it("calls an expression constant only when nothing in it can vary", () => {
    for (const constant of ["true", "1", "2 + 2", '"abc"', "[1, 2]", "null", "undefined", "NaN"]) {
      expect(isConstantExpression(constant), constant).toBe(true);
    }
    for (const variable of ["slugify(\"a\")", "out", "x + 1", "[...xs]", ""]) {
      expect(isConstantExpression(variable), variable).toBe(false);
    }
  });

  it("keeps the boolean wrapper the Verdict is built from", () => {
    expect(isTautological(`import { slugify } from "./s";\nit("x", () => { expect(true).toBe(true); slugify("a"); });`, "slugify")).toBe(true);
    expect(isTautological(`import { slugify } from "./s";\nit("x", () => { expect(slugify("A")).toBe("a"); });`, "slugify")).toBe(false);
  });
});
