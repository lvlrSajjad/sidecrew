// Static tautology detector: constant assertions, x == x, snapshot-only, never references the function.
//
// This is the gate that mutation testing cannot be: research §E — mutation catches assert-true tests
// reliably *once they are run*, but running them costs the most expensive stage in the pipeline, and a
// test that asserts nothing is knowable for free from its text. ADR-0006 is the frame: the worker is an
// optimizer pointed at the verifier, so each rule below is written as "the cheapest way to pass the
// compile and run stages without the test being useful".
//
// Deliberately AST-light. It masks comments and string literals, then scans for assertion call sites —
// which is enough for the four cheap passes named above, and is not enough for anything cleverer. What
// it misses is listed in ADR-0006, not hidden here.
//
// Two dialects, because Phase 3 turned out to be the day the comment at the bottom of this file was
// cashed in. The *rules* are the same in both — a constant assertion is a constant assertion — but the
// syntax they scan is not: `expect(x).toBe(y)` and `XCTAssertEqual(x, y)` / `#expect(x == y)` share no
// tokens, and Swift's `import` has no `from` clause to end it on. Everything that differs is selected by
// `Dialect` and nothing else branches.

/** What made a test tautological. The code is stable; the message is for the retry prompt. */
export type TautologyCode =
  | "no_assertions"
  | "constant_assertions"
  | "self_comparison"
  | "snapshot_only"
  | "function_never_called"
  | "copied_exemplar";

export interface TautologyFinding {
  code: TautologyCode;
  /** Written to be read by the worker on its single retry, so it names the function and the line. */
  message: string;
  /** 1-based, in the candidate's own source. */
  line: number;
}

export interface TautologyReport {
  tautological: boolean;
  /** Assertion call sites found, whether or not they mean anything. */
  assertions: number;
  /** Assertions that are not constant, not self-comparisons and not snapshots. */
  meaningful: number;
  findings: TautologyFinding[];
}

/**
 * Which syntax to read. Derived from `Language`, not passed around as one, because Python and Kotlin
 * will each need their own and neither is written yet — a `Language` this file does not know is read
 * as TypeScript rather than crashing, and the verifier for it is what will notice.
 */
export type Dialect = "typescript" | "swift";

export const dialectOf = (language: string): Dialect => (language === "swift" ? "swift" : "typescript");

/** Identifiers that are values, not references to anything the test could be exercising. */
const LITERAL_WORDS: Record<Dialect, ReadonlySet<string>> = {
  typescript: new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]),
  swift: new Set(["true", "false", "nil"]),
};

/** Matchers that pin whatever today's output happens to be — including today's bug. */
const SNAPSHOT_MATCHERS = new Set(["toMatchSnapshot", "toMatchInlineSnapshot", "toMatchFileSnapshot", "toThrowErrorMatchingSnapshot", "toThrowErrorMatchingInlineSnapshot"]);

/** Matchers where `expect(x).m(x)` is a comparison of a thing with itself. */
const EQUALITY_MATCHERS = new Set(["toBe", "toEqual", "toStrictEqual", "toMatchObject", "equal", "deepEqual", "strictEqual", "deepStrictEqual"]);

/** `expect.<name>(…)` forms that set up an expectation rather than making one. */
const EXPECT_STATICS = new Set(["assertions", "hasAssertions", "extend", "addEqualityTesters", "addSnapshotSerializer", "getState", "setState"]);

/** Chain links that modify an assertion without being the assertion. */
const MODIFIERS = new Set(["not", "resolves", "rejects"]);

/**
 * Comments blanked, string and template contents replaced by `x`, both preserving length so an index
 * into the mask is an index into the original. Everything downstream scans the mask and quotes the
 * original, which is what keeps `it("expect(true).toBe(true)")` from being read as an assertion.
 */
export function mask(source: string, dialect: Dialect = "typescript"): string {
  const out = source.split("");
  const blank = (from: number, to: number, ch: string) => {
    for (let i = from; i < to && i < out.length; i += 1) if (out[i] !== "\n") out[i] = ch;
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      blank(i, end === -1 ? source.length : end, " ");
      i = end === -1 ? source.length : end;
    } else if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop, " ");
      i = stop;
    } else if (dialect === "swift" && source.startsWith('"""', i)) {
      // Before the single-quote branch, or `"""` reads as an empty string followed by an open one and
      // every quote after it is inverted — which would unmask the whole rest of the file.
      const end = source.indexOf('"""', i + 3);
      const stop = end === -1 ? source.length : end + 3;
      blank(i + 3, end === -1 ? source.length : end, "x");
      i = stop;
    } else if (dialect === "swift" && (ch === "#" || ch === "\u0023") && /^#+"/.test(source.slice(i))) {
      // A raw string: `#"…"#`, `##"…"##`. The delimiter length is part of the terminator, so a lone `"`
      // inside it does not end anything.
      const hashes = /^#+/.exec(source.slice(i))?.[0] ?? "#";
      const terminator = `"${hashes}`;
      const end = source.indexOf(terminator, i + hashes.length + 1);
      const stop = end === -1 ? source.length : end + terminator.length;
      blank(i + hashes.length + 1, end === -1 ? source.length : end, "x");
      i = stop;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") { j += 2; continue; }
        if (source[j] === quote) break;
        j += 1;
      }
      blank(i + 1, j, "x");
      i = Math.min(j + 1, source.length);
    } else {
      i += 1;
    }
  }
  return out.join("");
}

/**
 * Import statements, blanked. A name that only appears in an import was never exercised by anything.
 *
 * Swift needs its own rule rather than a wider regex: a Swift import is always one line and has no
 * `from` clause, so the TypeScript "keep blanking until the `from`" loop would run to the end of the
 * file and blank the whole test — which would make every Swift candidate look like one that never
 * calls its function.
 */
export function withoutImports(masked: string, dialect: Dialect = "typescript"): string {
  if (dialect === "swift") {
    return masked
      .split("\n")
      .map((line) => (/^(?:@\w+\s+)*import\b/.test(line.trim()) ? line.replace(/\S/g, " ") : line))
      .join("\n");
  }
  let inImport = false;
  return masked
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!inImport && !/^import\b/.test(trimmed)) return line;
      // A multi-line import ends at the line carrying its `from` clause or its terminating `;`.
      inImport = !(/\bfrom\b/.test(trimmed) || trimmed.endsWith(";"));
      return line.replace(/\S/g, " ");
    })
    .join("\n");
}

const lineOf = (source: string, index: number): number => source.slice(0, index).split("\n").length;

/** The text between `open` (index of `(`) and its match, or null when the parens never close. */
const balanced = (masked: string, open: number): { text: string; end: number } | null => {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      depth -= 1;
      if (depth === 0) return { text: masked.slice(open + 1, i), end: i };
    }
  }
  return null;
};

/**
 * True when the expression can be evaluated without touching anything under test: literals, operators
 * and nothing else. `2 + 2` counts; `slugify("a")` does not; `true` does, because `true` is a value
 * rather than a reference to the code being tested.
 */
export function isConstantExpression(text: string, dialect: Dialect = "typescript"): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  // Quoted spans go first, and they have to: by this point `mask` has turned the contents of every
  // string into `x`, and an `x` read as an identifier would make `expect("a")` look like a reference
  // to something. A string literal is a constant whatever is inside it.
  const withoutQuoted = trimmed.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "");
  const identifiers = withoutQuoted.match(/[A-Za-z_$][\w$]*/g) ?? [];
  return identifiers.every((id) => LITERAL_WORDS[dialect].has(id));
}

const normalise = (text: string): string => text.trim().replace(/\s+/g, " ").replace(/;$/, "");

/** Top-level commas only, so `assert.equal(f(a, b), c)` splits into two arguments and not three. */
const splitArgs = (text: string): string[] => {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === "," && depth === 0) { args.push(text.slice(start, i)); start = i + 1; }
  }
  const last = text.slice(start);
  if (last.trim().length > 0 || args.length > 0) args.push(last);
  return args.filter((a) => a.trim().length > 0);
};

interface Assertion {
  index: number;
  subject: string;
  matcher: string;
  /** The matcher's own argument text, or null for a matcher called with none. */
  expected: string | null;
  kind: "meaningful" | "constant" | "self" | "snapshot";
  /** The call site as written, for the message the retry reads. Set by the Swift scanner only. */
  text?: string;
}

/** `expect(subject).chain.matcher(expected)` and `assert.matcher(subject, expected)` call sites. */
function assertions(masked: string): Assertion[] {
  const found: Assertion[] = [];
  const call = /\b(expect|assert)\b\s*(?:\.\s*([A-Za-z_$][\w$]*))?\s*\(/g;
  for (let m = call.exec(masked); m !== null; m = call.exec(masked)) {
    const args = balanced(masked, m.index + m[0].length - 1);
    if (!args) continue;
    call.lastIndex = args.end;
    // `expect.assertions(2)` and friends configure the assertion count; they assert nothing themselves.
    if (m[1] === "expect" && m[2] !== undefined && EXPECT_STATICS.has(m[2])) continue;

    if (m[1] === "assert") {
      const parts = splitArgs(args.text);
      const matcher = m[2] ?? "ok";
      const subject = parts[0] ?? "";
      const expected = parts.length > 1 ? (parts[1] ?? null) : null;
      found.push({ index: m.index, subject, matcher, expected, kind: classify(subject, matcher, expected) });
      continue;
    }

    // expect(...) followed by `.not` / `.resolves` / `.rejects` links and then the matcher itself.
    let i = args.end + 1;
    let matcher = "";
    let expected: string | null = null;
    for (;;) {
      const rest = masked.slice(i);
      const link = /^\s*\.\s*([A-Za-z_$][\w$]*)/.exec(rest);
      if (!link) break;
      const name = link[1] ?? "";
      i += link[0].length;
      const after = /^\s*\(/.exec(masked.slice(i));
      if (after) {
        const callArgs = balanced(masked, i + after[0].length - 1);
        matcher = name;
        expected = callArgs && callArgs.text.trim().length > 0 ? callArgs.text : null;
        break;
      }
      if (!MODIFIERS.has(name)) { matcher = name; break; }
    }
    found.push({ index: m.index, subject: args.text, matcher, expected, kind: classify(args.text, matcher, expected) });
  }
  return found;
}

/**
 * Swift assertion call sites: XCTest's `XCTAssert…` family and Swift Testing's two macros.
 *
 * One scanner for both frameworks on purpose — a candidate is free to use `#expect` inside an
 * `XCTestCase`, Swift 6 allows it, and a detector that picked a framework first would have to be right
 * about that before it could be right about anything else.
 */
const SWIFT_ASSERTION = /(?:\bXCTAssert\w*|\bXCTFail\b|\bXCTUnwrap\b|#expect|#require)\s*\(/g;

/** `XCTAssertEqual(x, x)` is a comparison of a thing with itself; `XCTAssertNotEqual(x, x)` is a bug. */
const SWIFT_EQUALITY_ASSERTS = new Set(["XCTAssertEqual", "XCTAssertIdentical"]);

/** The `XCTAssert…` forms whose first two arguments are both operands rather than operand + message. */
const SWIFT_TWO_OPERAND = new Set([
  "XCTAssertEqual", "XCTAssertIdentical", "XCTAssertNotEqual", "XCTAssertNotIdentical",
  "XCTAssertGreaterThan", "XCTAssertGreaterThanOrEqual", "XCTAssertLessThan", "XCTAssertLessThanOrEqual",
]);

/**
 * A top-level `==` / `!=` / `===` / `!==`, so `#expect(a == b)` can be read the way
 * `XCTAssertEqual(a, b)` already is. Depth-aware, so the `==` inside `f(x == y)` is not top level, and
 * `<=` / `>=` are never mistaken for one because neither starts with `=` or `!`.
 */
const splitComparison = (text: string): { left: string; right: string; equal: boolean } | null => {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (depth === 0 && (c === "=" || c === "!") && text[i + 1] === "=") {
      const width = text[i + 2] === "=" ? 3 : 2;
      return { left: text.slice(0, i), right: text.slice(i + width), equal: c === "=" };
    }
  }
  return null;
};

function swiftAssertions(masked: string): Assertion[] {
  const found: Assertion[] = [];
  SWIFT_ASSERTION.lastIndex = 0;
  for (let m = SWIFT_ASSERTION.exec(masked); m !== null; m = SWIFT_ASSERTION.exec(masked)) {
    const args = balanced(masked, m.index + m[0].length - 1);
    if (!args) continue;
    SWIFT_ASSERTION.lastIndex = args.end;
    const name = m[0].slice(0, m[0].length - 1).trim();
    const parts = splitArgs(args.text);
    const text = `${name}(${normalise(args.text)})`;

    if (SWIFT_TWO_OPERAND.has(name)) {
      // Anything past the second argument is XCTest's own message / file / line, never an operand.
      const subject = parts[0] ?? "";
      const expected = parts.length > 1 ? (parts[1] ?? null) : null;
      const kind = classifySwift(name, subject, expected, SWIFT_EQUALITY_ASSERTS.has(name));
      found.push({ index: m.index, subject, matcher: name, expected, text, kind });
      continue;
    }

    // The one-expression forms — `XCTAssertTrue(x)`, `#expect(x == y)`, `try #require(x)`. The operands,
    // if there are two, are inside the expression rather than beside it.
    const expression = parts[0] ?? "";
    const comparison = splitComparison(expression);
    const subject = comparison ? comparison.left : expression;
    const expected = comparison ? comparison.right : null;
    const kind = classifySwift(name, subject, expected, comparison?.equal ?? false);
    found.push({ index: m.index, subject, matcher: comparison ? "==" : name, expected, text, kind });
  }
  return found;
}

/**
 * `comparesEqual` says whether the two operands are being asserted *equal*, which is the only case
 * where `x` against `x` cannot fail. `XCTAssertNotEqual(x, x)` is also a test that says nothing, but it
 * says it by failing, so it never reaches this stage as a passing candidate.
 */
function classifySwift(name: string, subject: string, expected: string | null, comparesEqual: boolean): Assertion["kind"] {
  // An unconditional failure is many things, but it is never a test that passes while asserting nothing.
  if (name === "XCTFail") return "meaningful";
  if (isConstantExpression(subject, "swift") && (expected === null || isConstantExpression(expected, "swift"))) return "constant";
  if (expected !== null && comparesEqual && normalise(subject) === normalise(expected)) return "self";
  return "meaningful";
}

function classify(subject: string, matcher: string, expected: string | null): Assertion["kind"] {
  if (SNAPSHOT_MATCHERS.has(matcher)) return "snapshot";
  if (isConstantExpression(subject) && (expected === null || isConstantExpression(expected))) return "constant";
  if (expected !== null && EQUALITY_MATCHERS.has(matcher) && normalise(subject) === normalise(expected)) return "self";
  return "meaningful";
}

/**
 * Whether `name` is ever *called* outside an import statement — referenced, not merely imported.
 *
 * The word-boundary match is what makes this work across both dialects without knowing either: Swift
 * candidates call `Strings.slugify(…)` rather than `slugify(…)`, and `\bslugify\s*\(` matches the tail
 * of a qualified call while still refusing `slugifyAll(` and a bare `slugify` that is never invoked.
 */
export function callsFunction(masked: string, name: string, dialect: Dialect = "typescript"): boolean {
  if (name.length === 0) return true;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\s*\\(`).test(withoutImports(masked, dialect));
}

/**
 * The whole check. A test is tautological when it asserts nothing, when nothing it asserts depends on
 * the code under test, or when it never calls the function it was asked to test.
 */
export interface TautologyOpts {
  language?: string;
  /**
   * The exemplar this candidate was shown, when there was one (ADR-0033).
   *
   * A candidate byte-identical to its exemplar compiles, passes, kills every mutant the exemplar kills
   * and is not tautological by any other rule — so it becomes a *survivor*, and on a real project one
   * did: it would have been the headline result of the run, and it is the example handed back. It teaches
   * nothing and it is not evidence about the model.
   *
   * This belongs here rather than in the batch loop because "this is not a test of the function you were
   * asked about" is the same kind of statement as the other five, and routing it through the same field
   * means the retry rule, the escalation queue and the review threshold all keep working unchanged.
   */
  exemplar?: string;
}

/** Whitespace-insensitive, because an identical file that differs by a trailing newline is identical. */
const sameSource = (a: string, b: string): boolean =>
  a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

export function analyseTautology(
  source: string,
  functionName: string,
  languageOrOpts: string | TautologyOpts = "typescript",
): TautologyReport {
  const opts: TautologyOpts = typeof languageOrOpts === "string" ? { language: languageOrOpts } : languageOrOpts;
  const language = opts.language ?? "typescript";
  const dialect = dialectOf(language);
  const masked = mask(source, dialect);
  const found = dialect === "swift" ? swiftAssertions(masked) : assertions(masked);
  const meaningful = found.filter((a) => a.kind === "meaningful").length;
  const findings: TautologyFinding[] = [];
  const at = (index: number) => lineOf(source, index);

  if (opts.exemplar !== undefined && opts.exemplar.trim() !== "" && sameSource(source, opts.exemplar)) {
    findings.push({
      code: "copied_exemplar",
      message:
        `this is the exemplar, returned unchanged — it tests whichever function the example was about, ` +
        `not ${functionName}. Write a new test for ${functionName}, copying only the structure and the ` +
        "assertion style.",
      line: 1,
    });
  }

  if (!callsFunction(masked, functionName, dialect)) {
    findings.push({
      code: "function_never_called",
      message: `the test never calls ${functionName}(…), so nothing it asserts can depend on it`,
      line: 1,
    });
  }

  if (found.length === 0) {
    findings.push({ code: "no_assertions", message: "the test makes no assertions at all", line: 1 });
  } else if (meaningful === 0) {
    for (const kind of ["constant", "self", "snapshot"] as const) {
      const first = found.find((a) => a.kind === kind);
      if (!first) continue;
      findings.push({ code: CODE_FOR[kind], message: MESSAGE_FOR[dialect][kind](first, functionName), line: at(first.index) });
    }
  }

  return { tautological: findings.length > 0, assertions: found.length, meaningful, findings };
}

const CODE_FOR = { constant: "constant_assertions", self: "self_comparison", snapshot: "snapshot_only" } as const;

type Message = (a: Assertion, fn: string) => string;

/**
 * One set per dialect, because the message is read by a worker model on its single retry and the
 * fastest way to waste that retry is to quote it syntax from a language it is not writing.
 */
const MESSAGE_FOR: Record<Dialect, Record<"constant" | "self" | "snapshot", Message>> = {
  typescript: {
    constant: (a, fn) =>
      `every assertion is constant — \`expect(${normalise(a.subject)})\` holds whatever ${fn} does`,
    self: (a) =>
      `every assertion compares a value with itself — \`expect(${normalise(a.subject)}).${a.matcher}(${normalise(a.expected ?? "")})\` cannot fail`,
    snapshot: (a, fn) =>
      `the only assertions are snapshots, which pin whatever ${fn} returns today rather than what it should return`,
  },
  swift: {
    constant: (a, fn) =>
      `every assertion is constant — \`${a.text ?? normalise(a.subject)}\` holds whatever ${fn} does`,
    self: (a) =>
      `every assertion compares a value with itself — \`${a.text ?? normalise(a.subject)}\` cannot fail`,
    // No Swift equivalent ships in XCTest or Swift Testing, so this is unreachable today. It is here so
    // that adding a snapshot library to the matcher list is a one-line change rather than a branch.
    snapshot: (a, fn) =>
      `the only assertions are snapshots, which pin whatever ${fn} returns today rather than what it should return`,
  },
};

/**
 * The boolean the `Verdict` carries. `language` now selects the dialect — Phase 3 was the day the
 * branch this comment used to promise actually had to be written.
 */
export function isTautological(source: string, functionName: string, language = "typescript"): boolean {
  return analyseTautology(source, functionName, language).tautological;
}
