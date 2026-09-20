// Where a function begins and ends, asked of the TypeScript compiler instead of a regular expression.
//
// `deriveLineRange`'s scanner has been patched four times — ADR-0030, ADR-0033 #4, ADR-0035, ADR-0039 —
// and every one of those patches was found the same way: a probe printed `NOT PLANNABLE — no mutants at
// all` about a function whose hand-written range kills mutants. The sentence has been checked four times
// and been wrong four times, so the fifth fix is not a fifth pattern (ADR-0076).
//
// The compiler cannot be wrong about where a body starts. What it can be is absent: `typescript` is not
// a dependency of sidecrew (CLAUDE.md § *Shape* — one runtime dependency) and is loaded out of the
// project being verified, the way every other external capability here is reached. Every TypeScript
// project sidecrew can verify has it, because the verifier shells out to `tsc` and to Stryker's
// `typescript-checker`; `doctor` asks the question so a project where it is missing hears about it
// before a run rather than after one.
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

/**
 * The compiler's own types, and **only** its types: `import type` is erased, so nothing here makes
 * `typescript` a runtime dependency of sidecrew (CLAUDE.md § *Shape* allows one, and this is not it).
 *
 * A hand-written structural shim was the first attempt and it was the wrong instinct — an interface
 * naming forty compiler members is a second implementation of something the compiler already
 * publishes, and a second implementation of a thing the writer already had is how `safeName` produced
 * a confident wrong answer once already. It also drifts silently, because a structural type that no
 * longer matches the real module still compiles.
 *
 * No **exported** signature in this module mentions these types, so none of them reaches
 * `dist/**.d.ts`, where an install without `typescript` would have to resolve them. `loadCompiler`
 * returns `unknown` for exactly that reason, and its callers cast.
 */
type TsModule = typeof import("typescript");
type TsNode = import("typescript").Node;
type TsSourceFile = import("typescript").SourceFile;

/**
 * `typescript`, loaded from the project being verified, or `null`.
 *
 * Resolution, not a path check, for the reason `isResolvable` gives: a hoisted workspace keeps a
 * package's dependencies at the repo root, and asking Node is the only way to be right about that. The
 * second root is sidecrew's own, which is what makes this work in this repository's tests and in an
 * install where `typescript` is hoisted beside `sidecrew`.
 */
const loaded = new Map<string, TsModule | null>();

function loadTypeScript(projectDir?: string): TsModule | null {
  const key = projectDir === undefined ? "" : resolve(projectDir);
  const cached = loaded.get(key);
  if (cached !== undefined) return cached;

  const roots = key === "" ? [import.meta.url] : [join(key, "package.json"), import.meta.url];
  let found: TsModule | null = null;
  for (const root of roots) {
    try {
      found = createRequire(root)("typescript") as TsModule;
      break;
    } catch {
      // Not resolvable from this root. The caller's fallback is the scanner, and `doctor` says so.
    }
  }
  loaded.set(key, found);
  return found;
}

/** Forget what was resolved. Tests only — a cache keyed by directory outlives a fixture. */
export function resetTypeScriptCache(): void {
  loaded.clear();
}

/**
 * The compiler module itself, for the other things in this repository that need a parser.
 *
 * `unknown` rather than its real type, so no `typescript` type reaches `dist/**.d.ts` — a caller casts
 * it back, and the cast is the one place each caller says "I am assuming a compiler here".
 */
export function loadCompiler(projectDir?: string): unknown {
  return loadTypeScript(projectDir);
}

/** Is the compiler reachable? `doctor` asks this so a user hears about the scanner before a run. */
export function typeScriptAvailable(projectDir?: string): boolean {
  return loadTypeScript(projectDir) !== null;
}

/** `.tsx` and `.ts` do not parse the same text the same way — `<T>(x) => x` is a cast in one and a tag in the other. */
function scriptKindFor(ts: TsModule, fileName: string | undefined): number {
  if (fileName === undefined) return ts.ScriptKind.TS;
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** The written name of a declaration's name node — an identifier, or a quoted key in an object literal. */
function nameOf(ts: TsModule, node: import("typescript").NamedDeclaration): string | undefined {
  const name = node.name;
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

const isFunctionValued = (ts: TsModule, node: TsNode | undefined): boolean =>
  node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));

/**
 * The first character of the declaration, skipping decorators but not modifiers.
 *
 * `export const f = …` must start at `export`, because a range that begins after it does not contain
 * the declaration and `--validate` rejects it (ADR-0013). A decorator is the other way round: it can be
 * many lines of unrelated configuration above the method, and mutating it is not mutating the function.
 */
function startOf(ts: TsModule, sf: TsSourceFile, node: import("typescript").NamedDeclaration): number {
  const decorated = ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0;
  if (!decorated) return node.getStart(sf, false);

  // `getModifiers` returns the `export`/`static`/`async` run without the decorators, so the first of
  // them is where the declaration proper begins. A decorated member with no modifiers begins at its
  // own name.
  const firstModifier = (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.[0];
  if (firstModifier !== undefined) return firstModifier.getStart(sf);
  return (node.name ?? node).getStart(sf, false);
}

/** The extent of a declaration: a `VariableDeclaration`'s is its statement's, so `export` is inside it. */
function extentOf(ts: TsModule, node: import("typescript").VariableDeclaration): TsNode {
  let up: TsNode | undefined = node.parent;
  while (up !== undefined && !ts.isVariableStatement(up)) up = up.parent;
  return up ?? node;
}

/** Half-open character span of one declaration, already adjusted for decorators. */
interface Span { start: number; end: number }

const spanOf = (
  ts: TsModule, sf: TsSourceFile, declaration: import("typescript").NamedDeclaration,
): Span => ({ start: startOf(ts, sf, declaration), end: declaration.getEnd() });

/**
 * The span of every declaration in `sf` that declares a function called `name`, in source order.
 *
 * A declaration **without a body is not one of them**: an overload signature and a `declare function`
 * both spell the name and neither has the lines a mutant could live on. The scanner matched the first
 * one it saw and returned the signature's line twice — a range containing no statements, which reads
 * downstream as "no mutants at all", the sentence this module exists to stop being wrong about.
 */
function spansNamed(ts: TsModule, sf: TsSourceFile, name: string): Span[] {
  const found: Span[] = [];

  const visit = (node: TsNode): void => {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      if (nameOf(ts, node) === name && node.body !== undefined) found.push(spanOf(ts, sf, node));
    } else if (ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) {
      if (nameOf(ts, node) === name && isFunctionValued(ts, node.initializer)) found.push(spanOf(ts, sf, node));
    } else if (ts.isVariableDeclaration(node)) {
      // The name is the declaration's, the extent is the statement's — `export const f = …` has to
      // include `export`, or `--validate` rejects the range for not containing its declaration.
      if (nameOf(ts, node) === name && isFunctionValued(ts, node.initializer)) {
        // A variable declaration cannot carry decorators, so its statement's start is the start.
        const extent = extentOf(ts, node);
        found.push({ start: extent.getStart(sf, false), end: extent.getEnd() });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);

  // `forEachChild` visits in source order and descends after pushing, so this is source order with an
  // enclosing declaration ahead of one nested inside it. The scanner this replaces also took the first.
  return found;
}

export interface AstRangeOpts {
  /** Where to resolve `typescript` from — the project being verified. */
  projectDir?: string;
  /** The source's own name, so `.tsx` parses as `.tsx`. */
  fileName?: string;
}

/**
 * The first and last line of the function called `functionName`, from the compiler's own tree.
 *
 * `null` means one of two different things and the caller cannot tell them apart here: the compiler was
 * not reachable, or it was and there is no such function. `deriveLineRange` distinguishes them — it
 * falls back to the scanner only in the first case would be wrong, so it falls back in both and reports
 * which answered. See `lineRangeOf`.
 */
export function astLineRange(
  source: string, functionName: string, opts: AstRangeOpts = {},
): readonly [number, number] | null {
  const ts = loadTypeScript(opts.projectDir);
  if (ts === null) return null;

  const kinds = opts.fileName === undefined
    ? [ts.ScriptKind.TS, ts.ScriptKind.TSX] // `<T>(x) => x` is a cast in one and an element in the other.
    : [scriptKindFor(ts, opts.fileName)];

  for (const kind of kinds) {
    const sf = ts.createSourceFile(opts.fileName ?? "source.ts", source, ts.ScriptTarget.Latest, true, kind);
    const [span] = spansNamed(ts, sf, functionName);
    if (span === undefined) continue;
    const from = ts.getLineAndCharacterOfPosition(sf, span.start).line + 1;
    // `end` is one past the last character, which on a body's closing brace is the newline after it.
    const to = ts.getLineAndCharacterOfPosition(sf, Math.max(span.end - 1, 0)).line + 1;
    return [from, to];
  }
  return null;
}

/**
 * Every file `tsc -p <tsconfig>` would put in the program, or `null` if the question cannot be answered.
 *
 * **What it is for.** ADR-0037 is the worst defect six real trials found and the only one that failed
 * *open*: `testDirFor` picks a test directory, the project's `include` does not cover it, and
 * `tsc --noEmit -p tsconfig.json` type-checks the project **without ever opening the candidate** —
 * reporting `compile ok` for a file carrying three type errors. The verifier detects it per candidate
 * and widens (`derivedTsconfig`). This is the same question asked once, before a plan is written.
 *
 * The compiler resolves it, not a glob re-implementation: `include`, `exclude`, `files` and an
 * `extends` chain compose in ways a second implementation gets wrong, and a second implementation of
 * something the writer already had is how `safeName` produced a confident wrong answer once already.
 *
 * `null` means the question could not be answered — no compiler, no tsconfig, or a config the parser
 * refused. That is a third answer and a caller must not read it as an empty program.
 */
export function tsconfigProgramFiles(tsconfigPath: string, projectDir?: string): readonly string[] | null {
  const ts = loadTypeScript(projectDir);
  if (ts === null) return null;

  const host: import("typescript").ParseConfigFileHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: (f) => ts.sys.fileExists(f),
    readFile: (f: string) => ts.sys.readFile(f),
    readDirectory: (path, extensions, exclude, include, depth) =>
      ts.sys.readDirectory(path, extensions, exclude, include, depth),
    getCurrentDirectory: () => projectDir ?? process.cwd(),
    onUnRecoverableConfigFileDiagnostic: () => {
      // Swallowed: an unreadable tsconfig is `null` below, not a crash inside `doctor`.
    },
  };

  try {
    const parsed = ts.getParsedCommandLineOfConfigFile(resolve(tsconfigPath), undefined, host);
    return parsed === undefined ? null : parsed.fileNames.map((f) => resolve(f));
  } catch {
    return null;
  }
}
