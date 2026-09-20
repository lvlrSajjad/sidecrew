// The range finder, asked of the compiler instead of a regular expression — ADR-0076.
//
// Two things are under test and they are different. The shapes below are the ones the scanner got
// wrong or could not see at all, and they are the reason the AST exists. The agreement suite at the
// bottom is the one that keeps the *fallback* honest: the scanner is still reachable, still shipped,
// and still what answers on a machine with no `typescript`, so what it does has to stay measured
// rather than assumed.
import { describe, it, expect } from "vitest";
import { lineRangeOf, deriveLineRange } from "../src/verifier/shared.js";
import { typeScriptAvailable } from "../src/verifier/ast.js";

const ast = (source: string, name: string): readonly [number, number] | null =>
  lineRangeOf(source, name, "typescript", { engine: "ast" }).range;
const scanner = (source: string, name: string): readonly [number, number] | null =>
  lineRangeOf(source, name, "typescript", { engine: "scanner" }).range;

describe("the compiler is what answers when it is reachable", () => {
  it("is reachable here, or every other test in this file is measuring the scanner", () => {
    // If this ever fails, the suite below is green for the wrong reason. Named, because a test that
    // silently checks the fallback is the shape of defect this repository keeps paying for.
    expect(typeScriptAvailable()).toBe(true);
  });

  it("says so in `via`", () => {
    expect(lineRangeOf("export function f() {\n  return 1;\n}\n", "f").via).toBe("ast");
  });

  it("falls back to the scanner for Swift, which has no compiler to ask", () => {
    const source = "public func f(a: Int) -> Int {\n  return a\n}\n";
    expect(lineRangeOf(source, "f", "swift")).toEqual({ range: [1, 3], via: "scanner" });
  });

  it("reports neither when there is no such function", () => {
    expect(lineRangeOf("export function other() {}\n", "slugify")).toEqual({ range: null, via: null });
  });
});

// ── what the scanner got wrong, measured on this repository's own source ───────────────────────────

describe("bodies the scanner cut short — the `no mutants at all` class", () => {
  // Reduced from `codeLines` in `src/confinement.ts`. A concise arrow whose expression is a chained
  // call over several lines: the scanner ends it at the first `;` or blank line it can find, which is
  // inside the callback, and the range it returns covers a third of the function.
  it("spans a concise arrow whose expression runs over several lines", () => {
    const source = [
      "export const f = (text: string): number =>",
      "  text.split(\"\\n\").filter((raw) => {",
      "    const line = raw.trim();",
      "    if (line === \"\") return false;",
      "    return true;",
      "  }).length;",
      "",
    ].join("\n");
    expect(ast(source, "f")).toEqual([1, 6]);
    expect(scanner(source, "f")).toEqual([1, 3]); // wrong, and this is the record of how wrong
  });

  // Reduced from `tsTargetFor` in `src/plan.ts`, and the reduction is the diagnosis: a concise arrow
  // has no closing brace to match, so the scanner ends it at the first `;` or blank line — and a
  // **comment line is masked to spaces**, which is a blank line as far as that search can tell. Any
  // commented concise arrow therefore ends at its first comment. In the real module that cut a
  // 12-line function to 6, and mutation then ran over half of it with nothing saying so.
  it("spans an arrow whose body has a comment line in it", () => {
    const source = [
      "export const f = (a: number) => ({",
      "  b: a + 1,",
      "  // why c is what it is",
      "  c: a + 2,",
      "});",
      "",
    ].join("\n");
    expect(ast(source, "f")).toEqual([1, 5]);
    expect(scanner(source, "f")).toEqual([1, 2]); // wrong, and this is the record of how wrong
  });

  it("starts at the implementation, not at an overload signature that has no body", () => {
    // An overload spells the name and has no lines a mutant could live on. The scanner matched the
    // first spelling; the range then opened on two signature lines that are not the function.
    const source = [
      "export function f(a: string): string;",
      "export function f(a: number): number;",
      "export function f(a: unknown): unknown {",
      "  return a;",
      "}",
      "",
    ].join("\n");
    expect(ast(source, "f")).toEqual([3, 5]);
  });

  it("refuses a declaration that has no body at all", () => {
    expect(ast("declare function f(a: number): number;\n", "f")).toBeNull();
  });
});

describe("shapes the scanner could not see — the 152 it missed in this repository", () => {
  const invisible: [string, string][] = [
    ["a function on an object literal", "export const util = {\n  f: (a: number) => {\n    return a;\n  },\n};\n"],
    ["an exported default function", "export default function f(a: number) {\n  return a;\n}\n"],
    ["a const arrow that is not exported", "const f = (a: number) => {\n  return a;\n};\n"],
    ["a function expression bound to a const", "const f = function (a: number) {\n  return a;\n};\n"],
  ];

  for (const [label, source] of invisible) {
    it(`finds ${label}`, () => {
      const range = ast(source, "f");
      expect(range, label).not.toBeNull();
      expect(range![0]).toBeGreaterThan(0);
      expect(range![1]).toBeLessThanOrEqual(source.trimEnd().split("\n").length);
    });
  }
});

describe("what the AST must not do", () => {
  it("does not mistake a call for a declaration", () => {
    expect(ast("const x = 1;\nf(3);\n", "f")).toBeNull();
  });

  it("does not start a decorated method at its decorators", () => {
    // A decorator can be many lines of routing configuration above the method, and mutating it is not
    // mutating the function. The modifiers are a different matter — `export const f` has to include
    // `export`, or `--validate` rejects the range for not containing its declaration (ADR-0013).
    const source = [
      "class C {",
      "  @Get(\"x\")",
      "  @UseGuards(A)",
      "  public async f(id: string) {",
      "    return id;",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(ast(source, "f")).toEqual([4, 6]);
  });

  it("includes `export` in a const arrow's range", () => {
    expect(ast("export const f = (n: number) => n * 2;\n", "f")).toEqual([1, 1]);
  });

  it("is not fooled by a brace inside a string or a comment", () => {
    const source = 'export function f(): string {\n  // }\n  return "}";\n}\nexport function g(): number {\n  return 1;\n}\n';
    expect(ast(source, "f")).toEqual([1, 4]);
  });

  it("reads a .tsx file as .tsx", () => {
    // In `.ts`, `<T,>(x) => x` is a type assertion; in `.tsx` it is a generic arrow. Getting the kind
    // wrong does not throw — it silently parses something else.
    const source = "export const f = (a: number) => {\n  return <div>{a}</div>;\n};\n";
    expect(lineRangeOf(source, "f", "typescript", { fileName: "c.tsx" })).toEqual({ range: [1, 3], via: "ast" });
  });
});

// ── the fallback stays measured ────────────────────────────────────────────────────────────────────

describe("the scanner still answers the shapes it was built for", () => {
  // Every shape ADR-0033, ADR-0035 and ADR-0039 added. The AST is the default and these are the cases
  // a machine without `typescript` still gets right — so they are asserted against the scanner
  // explicitly, not against whichever engine happens to be reachable.
  const shapes: [string, string, [number, number]][] = [
    ["export function", "export function f(a: number): number {\n  return a;\n}\n", [1, 3]],
    ["plain function", "function f(a: number) {\n  return a;\n}\n", [1, 3]],
    ["export const arrow with a block", "export const f = (v: unknown) => {\n  return [v];\n};\n", [1, 3]],
    ["export const concise arrow", "export const f = (n: number) => n * 2;\n", [1, 1]],
    ["static class method", "export default class U {\n  static f(a: number): number {\n    return a;\n  }\n}\n", [2, 4]],
    ["static class property arrow", "class U {\n  static f = (s: string) => {\n    return s.trim();\n  };\n}\n", [2, 4]],
    ["public static async", "class U {\n  public static async f(id: string): Promise<void> {\n    await id;\n  }\n}\n", [2, 4]],
    ["plain class method", "class U {\n  f(a: number): number {\n    return a + 1;\n  }\n}\n", [2, 4]],
    ["object-literal return type", "class U {\n  static f(a: number): { n: number } {\n    return { n: a };\n  }\n}\n", [2, 4]],
    ["union return type", "class U {\n  static f(a: number): { a: number } | { b: number } {\n    return { a };\n  }\n}\n", [2, 4]],
    ["generic constraint", "export class V {\n  static f<T extends { isValid: boolean }>(e: unknown): e is T {\n    return typeof e === \"object\";\n  }\n}\n", [2, 4]],
    ["destructured parameter", "export function f({ a, b }: Props): number {\n  return a + b;\n}\n", [1, 3]],
  ];

  for (const [label, source, expected] of shapes) {
    it(`agrees with the compiler on ${label}`, () => {
      expect(scanner(source, "f"), `scanner, ${label}`).toEqual(expected);
      expect(ast(source, "f"), `ast, ${label}`).toEqual(expected);
    });
  }

  it("keeps `deriveLineRange`'s contract — the range, or null", () => {
    expect(deriveLineRange("export function f() {\n  return 1;\n}\n", "f")).toEqual([1, 3]);
    expect(deriveLineRange("export function f() {}\n", "g")).toBeNull();
  });
});
