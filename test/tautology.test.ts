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
const SWIFT_FIXTURES = "fixtures/swift-fixture";

interface CandidateEntry { file: string; function: string; expect: "survives" | "tautological" }
const catalogueIn = async (dir: string): Promise<CandidateEntry[]> =>
  (JSON.parse(await readFile(`${dir}/candidates.json`, "utf8")) as { candidates: CandidateEntry[] }).candidates;
const catalogue = async (): Promise<CandidateEntry[]> => catalogueIn(FIXTURES);

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

describe("the Swift dialect", () => {
  // Same rules, different syntax. The interesting half of this block is that the *rules* needed no
  // change at all: a constant assertion is a constant assertion whether it is spelled
  // `expect(true).toBe(true)` or `XCTAssertTrue(true)`.
  const src = (body: string) => `import Testing\n@testable import SwiftFixture\n\n@Test func t() {\n${body}\n}\n`;

  it("flags all five Swift tautologies and none of the four legitimate candidates", async () => {
    const entries = await catalogueIn(SWIFT_FIXTURES);
    expect(entries).toHaveLength(9);
    for (const c of entries) {
      const report = analyseTautology(await readFile(`${SWIFT_FIXTURES}/${c.file}`, "utf8"), c.function, "swift");
      expect(report.tautological, `${c.file}: ${JSON.stringify(report.findings)}`).toBe(c.expect === "tautological");
      for (const f of report.findings) expect(f.message.length).toBeGreaterThan(10);
    }
  });

  it("names four different reasons across the five", async () => {
    // Four, not five: `snapshot_only` has no spelling in XCTest or Swift Testing, and `no_assertions`
    // — a test body with no assertion in it — is a cheap pass Swift makes easier than TypeScript does.
    const codes = await Promise.all(
      (await catalogueIn(SWIFT_FIXTURES))
        .filter((c) => c.expect === "tautological")
        .map(async (c) => analyseTautology(await readFile(`${SWIFT_FIXTURES}/${c.file}`, "utf8"), c.function, "swift").findings[0]?.code),
    );
    expect(new Set(codes).size).toBe(4);
  });

  it("covers every file in both fixture directories", async () => {
    const listed = new Set((await catalogueIn(SWIFT_FIXTURES)).map((c) => c.file));
    for (const dir of ["tautological", "legitimate"]) {
      for (const file of await readdir(`${SWIFT_FIXTURES}/${dir}`)) {
        expect(listed.has(`${dir}/${file}`), `${dir}/${file} is not in candidates.json`).toBe(true);
      }
    }
  });

  it("flags constant assertions in both frameworks' spellings", () => {
    for (const assertion of ["XCTAssertTrue(true)", "XCTAssertFalse(false)", "XCTAssertEqual(2 + 2, 4)", "#expect(true)", "#expect(2 + 2 == 4)", 'XCTAssertEqual("a", "a")']) {
      const r = analyseTautology(src(`    _ = Strings.slugify("a")\n    ${assertion}`), "slugify", "swift");
      expect(r.tautological, assertion).toBe(true);
      expect(r.findings[0]?.code, assertion).toBe("constant_assertions");
    }
  });

  it("flags a value compared with itself, as an argument pair or across an operator", () => {
    for (const assertion of ["XCTAssertEqual(actual, actual)", "#expect(actual == actual)", "XCTAssertEqual( actual ,actual )"]) {
      const r = analyseTautology(src(`    let actual = Strings.slugify("a")\n    ${assertion}`), "slugify", "swift");
      expect(r.findings.map((f) => f.code), assertion).toEqual(["self_comparison"]);
    }
  });

  it("does not call an inequality a self-comparison", () => {
    // `#expect(x != x)` says nothing either, but it says it by failing — so it never reaches the
    // detector as a candidate that compiles, runs and passes.
    const r = analyseTautology(src(`    let actual = Strings.slugify("a")\n    #expect(actual != actual)`), "slugify", "swift");
    expect(r.tautological).toBe(false);
  });

  it("flags a test body with no assertion in it", () => {
    const r = analyseTautology(src(`    _ = Strings.slugify("a")`), "slugify", "swift");
    expect(r.findings.map((f) => f.code)).toEqual(["no_assertions"]);
  });

  it("flags a test that imports the module but never calls the function", () => {
    const r = analyseTautology(src(`    #expect([1, 2].count == 2)`), "slugify", "swift");
    expect(r.findings.map((f) => f.code)).toEqual(["function_never_called"]);
  });

  it("sees a qualified call as a call", () => {
    // Swift candidates write `Strings.slugify(…)`, not `slugify(…)`.
    expect(callsFunction(mask("Strings.slugify(\"a\")", "swift"), "slugify", "swift")).toBe(true);
    expect(callsFunction(mask("let f = Strings.slugify", "swift"), "slugify", "swift")).toBe(false);
    expect(callsFunction(mask("Strings.slugifyAll(\"a\")", "swift"), "slugify", "swift")).toBe(false);
  });

  it("blanks a Swift import without running past the end of it", () => {
    // Swift imports have no `from` clause. The TypeScript rule would keep blanking to the end of the
    // file, which would make every Swift candidate look like one that never calls its function.
    const source = "import XCTest\n@testable import SwiftFixture\nStrings.slugify(\"a\")\n";
    const body = withoutImports(mask(source, "swift"), "swift");
    expect(body.trim()).toBe('Strings.slugify("x")');
  });

  it("passes a real assertion sitting among constant ones", () => {
    const r = analyseTautology(src(`    #expect(true)\n    #expect(Strings.slugify("A b") == "a-b")`), "slugify", "swift");
    expect(r.tautological).toBe(false);
    expect(r.assertions).toBe(2);
    expect(r.meaningful).toBe(1);
  });

  it("does not read assertions out of strings or comments, including multi-line ones", () => {
    const source = [
      "import Testing",
      "@testable import SwiftFixture",
      "@Test func t() {",
      "  // #expect(true)",
      '  let doc = """',
      "  #expect(true)",
      '  """',
      '  #expect(Strings.slugify("A") == "a")',
      "  _ = doc",
      "}",
    ].join("\n");
    const r = analyseTautology(source, "slugify", "swift");
    expect(r.assertions).toBe(1);
    expect(r.tautological).toBe(false);
  });

  it("counts an unconditional failure as meaningful rather than constant", () => {
    // `XCTFail("…")` takes a string literal, which is constant — but a test that calls it does not pass,
    // so it is never the cheap pass this detector is looking for.
    const r = analyseTautology(src(`    _ = Strings.slugify("a")\n    XCTFail("not implemented")`), "slugify", "swift");
    expect(r.tautological).toBe(false);
  });

  it("knows nil is a Swift literal and undefined is not", () => {
    expect(isConstantExpression("nil", "swift")).toBe(true);
    expect(isConstantExpression("nil")).toBe(false);
    expect(isConstantExpression("undefined", "swift")).toBe(false);
  });
});

describe("copied_exemplar — ADR-0033", () => {
  const exemplar = `import { describe, it, expect } from "vitest";
import { slugify } from "../src/strings";

describe("slugify", () => {
  it("lowercases and dashes", () => {
    expect(slugify("A B")).toBe("a-b");
  });
});
`;

  it("catches a candidate that is the exemplar handed back", () => {
    // Measured on a real project: one "survivor" was byte-identical to its exemplar. It compiled,
    // passed, killed 10 mutants and was non-tautological by every other rule, so it would have been the
    // run's headline result — and it is the example, returned unchanged.
    const report = analyseTautology(exemplar, "getBookValue", { exemplar });
    expect(report.tautological).toBe(true);
    expect(report.findings.map((f) => f.code)).toContain("copied_exemplar");
    // The message has to tell the retry what to do, because the retry is the thing that reads it.
    expect(report.findings[0]?.message).toMatch(/exemplar, returned unchanged/);
    expect(report.findings[0]?.message).toMatch(/getBookValue/);
  });

  it("ignores whitespace, because a trailing newline is not a different file", () => {
    expect(analyseTautology(`${exemplar}\n\n`, "getBookValue", { exemplar }).tautological).toBe(true);
  });

  it("does not fire on a real test that merely imitates the exemplar's style", () => {
    // Copying structure and assertion style is exactly what the prompt asks for. Only a verbatim copy
    // is the defect.
    const real = exemplar.replace(/slugify/g, "titleCase").replace('"a-b"', '"A B"');
    const report = analyseTautology(real, "titleCase", { exemplar });
    expect(report.findings.map((f) => f.code)).not.toContain("copied_exemplar");
  });

  it("does nothing when no exemplar is supplied", () => {
    // `sidecrew verify` on a hand-written file has no exemplar, and must not be penalised for it.
    expect(analyseTautology(exemplar, "slugify").findings.map((f) => f.code)).not.toContain("copied_exemplar");
    expect(analyseTautology(exemplar, "slugify", { exemplar: "" }).findings.map((f) => f.code))
      .not.toContain("copied_exemplar");
  });
});
