// A candidate that is wrong on its own terms, found without running anything — ADR-0042.
//
// **What this is about.** The funnel collapses at `pass` on every project measured: ten of the
// fourteen candidates that type-checked on project-b asserted something untrue, and the tautology
// detector fired zero times. Two of those ten shared one mechanical property —
//
//   * one asserted **contradictory results for the same call**, twice over, and repeated one test four
//     times character-for-character;
//   * the other was 8/10 correct, with each wrong test contradicted by the test immediately after it.
//
// The model is enumerating test *names* and writing expectations to match the name rather than the
// function. A file that asserts `f(1) === 2` and `f(1) === 3` is wrong **with no reference to what `f`
// does**, which means it is checkable without a model and without running anything.
//
// **What this deliberately is not.** ADR-0042 chose option 1 — *detect and name it* — and ruled out
// option 2, salvaging the file by deleting the contradicted assertions, without an explicit decision
// and a fresh baseline. So nothing here touches a verdict, a survival or a mutation score: the only
// thing it changes is the sentence the retry prompt and the escalation queue carry, which today is a
// pasted jest failure. A false positive therefore costs one misleading sentence, never a rejected
// candidate — and the narrowing below is still worth doing, because a misleading sentence is what the
// single retry is spent on.
import { loadCompiler } from "./ast.js";

type TsModule = typeof import("typescript");
type TsNode = import("typescript").Node;
type TsExpression = import("typescript").Expression;

/** Two assertions about the same call that cannot both hold. */
export interface Contradiction {
  /** The call, as written, normalised — `f(1, "a")`. */
  call: string;
  /** The two expected values, as written. Ordered by where they appear. */
  expected: readonly [string, string];
  /** The 1-based lines the two assertions are on. */
  lines: readonly [number, number];
}

/** The matchers that assert a value, rather than a relation or a side effect. */
const EQUALITY_MATCHERS = new Set(["toBe", "toEqual", "toStrictEqual"]);

/**
 * Is every part of this argument written out, with nothing read from anywhere?
 *
 * The narrowing that makes a contradiction a contradiction. `f(x)` twice with different expectations
 * says nothing — `x` may have been reassigned, and a `beforeEach` may have rebuilt the world between
 * them. `f(1, "a")` twice with different expectations is either a contradiction or a function with
 * hidden state, and hidden state in the function a plan named is a different report.
 */
function isWrittenOut(ts: TsModule, node: TsNode): boolean {
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) return true;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return true;
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (node.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(node) && node.text === "undefined") return true;
  if (ts.isPrefixUnaryExpression(node)) return isWrittenOut(ts, node.operand);
  if (ts.isArrayLiteralExpression(node)) return node.elements.every((e) => isWrittenOut(ts, e));
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((prop) =>
      ts.isPropertyAssignment(prop) && !ts.isComputedPropertyName(prop.name) && isWrittenOut(ts, prop.initializer));
  }
  return false;
}

/** Text with every run of whitespace collapsed, so formatting is not a difference. */
const normalise = (text: string): string => text.replace(/\s+/g, " ").trim();

/** `expect(<expr>)` — unwrapping `await`, and refusing `expect(…).not`, which asserts the opposite. */
function assertedCall(ts: TsModule, node: TsNode): { call: import("typescript").CallExpression; matcher: string } | null {
  if (!ts.isCallExpression(node)) return null;
  const matcherAccess = node.expression;
  if (!ts.isPropertyAccessExpression(matcherAccess)) return null;
  const matcher = matcherAccess.name.text;
  if (!EQUALITY_MATCHERS.has(matcher)) return null;

  // `expect(x)` — and only that. `expect(x).not`, `expect(x).resolves` and `expect(x).rejects` all put
  // something between `expect` and the matcher, and each of them changes what the matcher means.
  const expectCall = matcherAccess.expression;
  if (!ts.isCallExpression(expectCall)) return null;
  if (!ts.isIdentifier(expectCall.expression) || expectCall.expression.text !== "expect") return null;
  if (expectCall.arguments.length !== 1 || node.arguments.length !== 1) return null;

  const subject = expectCall.arguments[0]!;
  const inner: TsExpression = ts.isAwaitExpression(subject) ? subject.expression : subject;
  return ts.isCallExpression(inner) ? { call: inner, matcher } : null;
}

/** Does this call name the function under test — `f(…)`, `Util.f(…)`, `obj.f(…)`? */
function callsFunction(ts: TsModule, call: import("typescript").CallExpression, functionName: string): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text === functionName;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === functionName;
  return false;
}

export interface ContradictionOpts {
  /** Where to resolve `typescript` from. */
  projectDir?: string;
  /** The candidate's own name, so a `.tsx` test parses as `.tsx`. */
  fileName?: string;
}

/**
 * The first pair of assertions in `source` that assert different results for the same written-out call
 * of `functionName`, or `null`.
 *
 * `null` also means "could not be checked" — no compiler, or nothing matched. That is deliberate and
 * safe here in a way it would not be in a gate: this only ever *adds* a sentence, so failing to find
 * one leaves the existing behaviour exactly as it was.
 */
export function findContradiction(
  source: string, functionName: string, opts: ContradictionOpts = {},
): Contradiction | null {
  const ts = loadCompiler(opts.projectDir) as TsModule | null;
  if (ts === null) return null;

  const fileName = opts.fileName ?? "candidate.test.ts";
  const kind = fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);

  /** call text → the first expectation seen for it, and where. */
  const seen = new Map<string, { expected: string; line: number }>();
  let found: Contradiction | null = null;

  const visit = (node: TsNode): void => {
    if (found !== null) return;
    const asserted = assertedCall(ts, node);
    if (asserted !== null && callsFunction(ts, asserted.call, functionName)) {
      const args = asserted.call.arguments;
      const expected = (node as import("typescript").CallExpression).arguments[0]!;
      if (args.every((a) => isWrittenOut(ts, a)) && isWrittenOut(ts, expected)) {
        // Keyed by the matcher too: `toBe` and `toEqual` are different questions about the same call,
        // and a value that is `toEqual` one object and not `toBe` another is not a contradiction.
        const key = `${asserted.matcher}:${normalise(asserted.call.getText(sf))}`;
        const text = normalise(expected.getText(sf));
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const first = seen.get(key);
        if (first === undefined) seen.set(key, { expected: text, line });
        else if (first.expected !== text) {
          found = {
            call: normalise(asserted.call.getText(sf)),
            expected: [first.expected, text],
            lines: [first.line, line],
          };
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);

  return found;
}

/** The sentence the retry prompt and the escalation queue carry, in place of a pasted jest failure. */
export const describeContradiction = (c: Contradiction): string =>
  `self-contradictory: it asserts ${c.call} is ${c.expected[0]} on line ${c.lines[0]} and ` +
  `${c.expected[1]} on line ${c.lines[1]} — the file is wrong on its own terms, whatever the function ` +
  "does (ADR-0042)";
