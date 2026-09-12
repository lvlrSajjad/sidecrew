// Static tautology detector: constant assertions, x == x, snapshot-only, never references the function.
//
// This is the gate that mutation testing cannot be: research §E — mutation catches assert-true tests
// reliably *once they are run*, but running them costs the most expensive stage in the pipeline, and a
// test that asserts nothing is knowable for free from its text. ADR-0006 is the frame: the worker is an
// optimizer pointed at the verifier, so each rule below is written as "the cheapest way to pass the
// compile and run stages without the test being useful".
//
// Deliberately AST-light and language-agnostic. It masks comments and string literals, then scans for
// assertion call sites — which is enough for the four cheap passes named above, and is not enough for
// anything cleverer. What it misses is listed in ADR-0006, not hidden here.

/** What made a test tautological. The code is stable; the message is for the retry prompt. */
export type TautologyCode =
  | "no_assertions"
  | "constant_assertions"
  | "self_comparison"
  | "snapshot_only"
  | "function_never_called";

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

/** Identifiers that are values, not references to anything the test could be exercising. */
const LITERAL_WORDS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);

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
export function mask(source: string): string {
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

/** Import statements, blanked. A name that only appears in an import was never exercised by anything. */
export function withoutImports(masked: string): string {
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
export function isConstantExpression(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  // Quoted spans go first, and they have to: by this point `mask` has turned the contents of every
  // string into `x`, and an `x` read as an identifier would make `expect("a")` look like a reference
  // to something. A string literal is a constant whatever is inside it.
  const withoutQuoted = trimmed.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "");
  const identifiers = withoutQuoted.match(/[A-Za-z_$][\w$]*/g) ?? [];
  return identifiers.every((id) => LITERAL_WORDS.has(id));
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

function classify(subject: string, matcher: string, expected: string | null): Assertion["kind"] {
  if (SNAPSHOT_MATCHERS.has(matcher)) return "snapshot";
  if (isConstantExpression(subject) && (expected === null || isConstantExpression(expected))) return "constant";
  if (expected !== null && EQUALITY_MATCHERS.has(matcher) && normalise(subject) === normalise(expected)) return "self";
  return "meaningful";
}

/** Whether `name` is ever *called* outside an import statement — referenced, not merely imported. */
export function callsFunction(masked: string, name: string): boolean {
  if (name.length === 0) return true;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\s*\\(`).test(withoutImports(masked));
}

/**
 * The whole check. A test is tautological when it asserts nothing, when nothing it asserts depends on
 * the code under test, or when it never calls the function it was asked to test.
 */
export function analyseTautology(source: string, functionName: string): TautologyReport {
  const masked = mask(source);
  const found = assertions(masked);
  const meaningful = found.filter((a) => a.kind === "meaningful").length;
  const findings: TautologyFinding[] = [];
  const at = (index: number) => lineOf(source, index);

  if (!callsFunction(masked, functionName)) {
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
      findings.push({ code: CODE_FOR[kind], message: MESSAGE_FOR[kind](first, functionName), line: at(first.index) });
    }
  }

  return { tautological: findings.length > 0, assertions: found.length, meaningful, findings };
}

const CODE_FOR = { constant: "constant_assertions", self: "self_comparison", snapshot: "snapshot_only" } as const;

const MESSAGE_FOR: Record<"constant" | "self" | "snapshot", (a: Assertion, fn: string) => string> = {
  constant: (a, fn) =>
    `every assertion is constant — \`expect(${normalise(a.subject)})\` holds whatever ${fn} does`,
  self: (a) =>
    `every assertion compares a value with itself — \`expect(${normalise(a.subject)}).${a.matcher}(${normalise(a.expected ?? "")})\` cannot fail`,
  snapshot: (a, fn) =>
    `the only assertions are snapshots, which pin whatever ${fn} returns today rather than what it should return`,
};

/**
 * The boolean the `Verdict` carries. `language` is accepted and ignored: the rules above are about
 * assertion shape rather than syntax, and the day a language needs its own dialect this is where the
 * branch goes.
 */
export function isTautological(source: string, functionName: string, _language = "typescript"): boolean {
  return analyseTautology(source, functionName).tautological;
}
