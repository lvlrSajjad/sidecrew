// Symbol-scoped return — ADR-0075 option C, built as ADR-0086.
//
// A worker returns **whole files** (ADR-0047 §2), so a task has been bounded by what a 7B can reproduce
// inside its completion ceiling. On a real service that refused 3.3 % of the files and 48.1 % of the
// bytes, because the refused files are the big ones and that is where the work is. Nothing about the
// model decided that; the return format did.
//
// So a task may name a **declaration** instead. The worker returns that declaration's new text and
// nothing else, and this module splices it back by the compiler's own range. The model never writes a
// line number, which is the hunk failure mode ADR-0047 §2 rejected. And because the splice happens
// before the gate, every stage after `generate` still sees whole files.
//
// What is here, and nothing else:
//
//   * **naming**: `f` for a top-level declaration, `C.m` for a member of a top-level class. A name that
//     resolves to zero or to several declarations is refused rather than guessed (ADR-0086 §1).
//   * **the splice**: the task's own source, with each span replaced.
//   * **two confinement checks**, each a pure function of the task and the candidate (ADR-0086 §4).
//
// The compiler is loaded from the project being verified, never bundled (CLAUDE.md § *Shape*), exactly as
// `verifier/ast.ts` does it. That module's rule applies here too: no exported signature mentions a
// `typescript` type, so none of them reaches `dist/**.d.ts`.
import { loadCompiler } from "./verifier/ast.js";
import type { ChangeCandidate, ChangeTask, ConfinementBreach, FileEdit, SymbolEdit } from "./schemas.js";

type TsModule = typeof import("typescript");
type TsNode = import("typescript").Node;
type TsSourceFile = import("typescript").SourceFile;

/** Half-open UTF-16 offsets into a file's source — JavaScript string indices, what `slice` takes. */
export interface Span { start: number; end: number }

/** `f` or `C.m`. A private `#m` is not nameable: nothing outside the class can call it by that name either. */
export const SYMBOL_NAME = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)?$/;

const scriptKind = (ts: TsModule, fileName: string): number =>
  fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

const parse = (ts: TsModule, source: string, fileName: string): TsSourceFile =>
  ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind(ts, fileName));

/** The written name of a node's name, when it has one a plan could spell. */
function written(ts: TsModule, name: import("typescript").Node | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function topLevelName(ts: TsModule, node: TsNode): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)
    || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
    return written(ts, node.name);
  }
  // A statement declaring two names has no single declaration to hand back, so it is not nameable.
  if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
    return written(ts, node.declarationList.declarations[0]!.name);
  }
  return undefined;
}

function memberName(ts: TsModule, node: TsNode): string | undefined {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return written(ts, node.name);
  }
  return undefined;
}

/**
 * The span of a node as a symbol task means it: from its first token, **decorators and modifiers
 * included**, to its end. Leading JSDoc is excluded, so a declaration's documentation cannot change by
 * construction, which is ADR-0054's rule enforced by the splice rather than checked after it (ADR-0086 §2).
 */
const spanOf = (sf: TsSourceFile, node: TsNode): Span => ({ start: node.getStart(sf, false), end: node.getEnd() });

/** One declaration a symbol task could name, whether or not its name is unique in the file. */
export interface Declaration { name: string; span: Span; /** `C.m` only: the class it belongs to. */ owner: Span | null }

function declarationsOf(ts: TsModule, sf: TsSourceFile): Declaration[] {
  const found: Declaration[] = [];
  for (const statement of sf.statements) {
    const name = topLevelName(ts, statement);
    if (name !== undefined) found.push({ name, span: spanOf(sf, statement), owner: null });
    if (ts.isClassDeclaration(statement) && name !== undefined) {
      const owner = spanOf(sf, statement);
      for (const member of statement.members) {
        const m = memberName(ts, member);
        if (m !== undefined) found.push({ name: `${name}.${m}`, span: spanOf(sf, member), owner });
      }
    }
  }
  return found;
}

/**
 * Every declaration in `source` a symbol task could name, or `null` when the compiler is unreachable.
 *
 * Duplicates are **kept**. `resolveSymbol` refuses them, and the census has to see them to count what
 * that refusal costs.
 */
export function declarations(source: string, fileName: string, projectDir?: string): Declaration[] | null {
  const ts = loadCompiler(projectDir) as TsModule | null;
  if (ts === null) return null;
  return declarationsOf(ts, parse(ts, source, fileName));
}

export type Resolution =
  | { ok: true; span: Span; owner: Span | null }
  | { ok: false; reason: "no_compiler" | "bad_name" | "missing" | "ambiguous"; count: number };

/** Where `name` is in `source`: exactly one declaration, or the reason there is not exactly one. */
export function resolveSymbol(source: string, name: string, fileName: string, projectDir?: string): Resolution {
  if (!SYMBOL_NAME.test(name)) return { ok: false, reason: "bad_name", count: 0 };
  const all = declarations(source, fileName, projectDir);
  if (all === null) return { ok: false, reason: "no_compiler", count: 0 };
  const hits = all.filter((d) => d.name === name);
  if (hits.length === 0) return { ok: false, reason: "missing", count: 0 };
  if (hits.length > 1) return { ok: false, reason: "ambiguous", count: hits.length };
  return { ok: true, span: hits[0]!.span, owner: hits[0]!.owner };
}

/** A sentence for each way a name can fail to resolve, shared by the validator and the run. */
export const resolutionMessage = (file: string, name: string, r: Exclude<Resolution, { ok: true }>): string => {
  switch (r.reason) {
    case "no_compiler":
      return `${file}#${name} cannot be located: typescript is not resolvable from the project, and a symbol ` +
        "task is spliced by the compiler's own range (ADR-0086)";
    case "bad_name":
      return `${name} is not a symbol name — write \`f\` for a top-level declaration or \`C.m\` for a class member`;
    case "missing":
      return `${file} has no declaration called ${name} that a symbol task can name (ADR-0086 §1)`;
    case "ambiguous":
      return `${name} names ${r.count} declarations in ${file} — an overload or a get/set pair — and v1 ` +
        "refuses rather than guesses which one the worker should rewrite (ADR-0086 §1)";
  }
};

/** 1-based line of an offset. */
export const lineAt = (source: string, offset: number): number => {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
};

/** The whitespace between the start of a span's line and the span, so a prompt can show it indented. */
export const indentAt = (source: string, offset: number): string => {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const lead = source.slice(lineStart, offset);
  return /^[ \t]*$/.test(lead) ? lead : "";
};

/**
 * What a worker is shown around a declaration it is not allowed to change: the file's imports, and for a
 * class member the class's header — decorators, `extends`, `implements` — up to its opening brace.
 */
export function contextFor(source: string, fileName: string, owner: Span | null, projectDir?: string): { imports: string; enclosing: string } {
  const ts = loadCompiler(projectDir) as TsModule | null;
  if (ts === null) return { imports: "", enclosing: "" };
  const sf = parse(ts, source, fileName);
  const imports = sf.statements.filter((s) => ts.isImportDeclaration(s) || ts.isImportEqualsDeclaration(s))
    .map((s) => source.slice(s.getStart(sf, false), s.getEnd())).join("\n");
  if (owner === null) return { imports, enclosing: "" };
  const cls = sf.statements.find((s) => ts.isClassDeclaration(s) && s.getStart(sf, false) === owner.start);
  if (cls === undefined || !ts.isClassDeclaration(cls)) return { imports, enclosing: "" };
  const brace = source.indexOf("{", cls.members.pos - 1);
  const header = source.slice(owner.start, brace >= 0 && brace < cls.getEnd() ? brace + 1 : cls.members.pos).trimEnd();
  return { imports, enclosing: header };
}

/** The line of every `tsc` error `diagnostics` reports in `path` — `path(line,col): error …`. */
export const errorLines = (diagnostics: string, path: string): number[] => {
  const found: number[] = [];
  for (const line of diagnostics.split("\n")) {
    if (!line.startsWith(`${path}(`)) continue;
    const m = /^\((\d+),\d+\): error /.exec(line.slice(path.length));
    if (m) found.push(Number(m[1]));
  }
  return found;
};

/**
 * The plan's `{ file, name }` pairs, located in the task's sources: a `ChangeTask.symbols` array, or the
 * first reason one of them cannot be located. Shared by `buildChangeTask` and the tests, so the two
 * cannot build a symbol task two ways.
 */
export function locateSymbols(
  files: { path: string; source: string }[],
  planned: { file: string; name: string }[],
  diagnostics: string,
  projectDir?: string,
): ChangeTask["symbols"] | { problem: string } {
  const out: ChangeTask["symbols"] = [];
  for (const { file, name } of planned) {
    const path = file.split("\\").join("/");
    const source = files.find((f) => f.path === path)?.source;
    if (source === undefined) return { problem: `${path}#${name} is in a file the task does not list` };
    const r = resolveSymbol(source, name, path, projectDir);
    if (!r.ok) return { problem: resolutionMessage(path, name, r) };
    const start_line = lineAt(source, r.span.start);
    const end_line = lineAt(source, r.span.end - 1);
    const errors = errorLines(diagnostics, path).filter((l) => l >= start_line && l <= end_line).length;
    out.push({ path, name, ...r.span, start_line, end_line, source: source.slice(r.span.start, r.span.end), errors,
      ...contextFor(source, path, r.owner, projectDir) });
  }
  return out;
}

// ── the splice ────────────────────────────────────────────────────────────────────────────────────

/**
 * The returned text, ready to replace a span. The span starts at the declaration's first token, so any
 * indentation the worker put on the first line (the prompt shows it indented) is already in the file.
 */
const normalise = (text: string): string => text.replace(/^\s+/, "").replace(/\s+$/, "");

/**
 * Each symbol edit spliced into its file, producing whole-file edits the rest of the gate already reads.
 *
 * Edits naming a symbol the task does not list, or naming one twice, are **not** spliced. They remain in
 * `symbol_edits`, where `symbolBreaches` refuses them by name. A parser that dropped them would hide the
 * very signal the gate is counting (the `path_outside_task` reasoning, ADR-0048).
 *
 * A file that also came back whole, under a `--- FILE:` marker, keeps the whole-file answer and is not
 * spliced into. That answer is what gets judged, and `edit_outside_symbol` judges it the same way.
 */
export function spliceSymbols(task: ChangeTask, symbolEdits: SymbolEdit[], wholeFiles: FileEdit[]): FileEdit[] {
  const whole = new Set(wholeFiles.map((e) => e.path));
  const counts = new Map<string, number>();
  for (const e of symbolEdits) counts.set(`${e.path}#${e.name}`, (counts.get(`${e.path}#${e.name}`) ?? 0) + 1);

  const spliced: FileEdit[] = [];
  for (const file of task.files) {
    if (whole.has(file.path)) continue;
    const mine = task.symbols
      .filter((s) => s.path === file.path)
      .map((s) => ({ s, edit: symbolEdits.find((e) => e.path === s.path && e.name === s.name) }))
      .filter((x) => x.edit !== undefined && counts.get(`${x.s.path}#${x.s.name}`) === 1)
      .sort((a, b) => b.s.start - a.s.start);
    if (mine.length === 0) continue;
    let contents = file.source;
    for (const { s, edit } of mine) contents = contents.slice(0, s.start) + normalise(edit!.text) + contents.slice(s.end);
    spliced.push({ path: file.path, contents });
  }
  return [...wholeFiles, ...spliced];
}

// ── the two confinement rules (ADR-0086 §4) ──────────────────────────────────────────────────────

/**
 * `edit_outside_symbol` and `symbol_not_redeclared`, for a symbol-scoped task. Empty for any other task.
 *
 * **The test is a revert, not a diff.** Re-parse the candidate's file, find each named declaration, and
 * put the original text back where it now is. If that does not reproduce the original byte for byte,
 * something outside the named declarations changed. It judges a whole-file answer and a spliced one
 * identically, so a worker gains nothing by choosing its answer form. A second method returned where
 * one was asked for is caught the same way: after the named one is reverted, the extra is still there.
 *
 * **Fails closed.** A gate that cannot parse the answer does not pass it.
 */
export function symbolBreaches(task: ChangeTask, candidate: ChangeCandidate, projectDir?: string): ConfinementBreach[] {
  if (task.symbols.length === 0) return [];
  const breaches: ConfinementBreach[] = [];
  const named = new Set(task.symbols.map((s) => `${s.path}#${s.name}`));

  const seen = new Map<string, number>();
  for (const e of candidate.symbol_edits) {
    const key = `${e.path}#${e.name}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (!named.has(key)) {
      breaches.push({ rule: "edit_outside_symbol", file: e.path,
        detail: `returned ${e.name}, and the task names ${task.symbols.map((s) => s.name).join(", ")} — only those may change` });
    }
  }
  for (const [key, n] of seen) {
    if (n > 1 && named.has(key)) {
      const [file, name] = [key.slice(0, key.lastIndexOf("#")), key.slice(key.lastIndexOf("#") + 1)];
      breaches.push({ rule: "edit_outside_symbol", file, detail: `returned ${name} ${n} times, so there is no one answer to splice` });
    }
  }

  const ts = loadCompiler(projectDir) as TsModule | null;
  const sources = new Map(task.files.map((f) => [f.path, f.source]));
  for (const edit of candidate.edits) {
    const before = sources.get(edit.path);
    if (before === undefined || before === edit.contents) continue; // path_outside_task / not an edit
    const mine = task.symbols.filter((s) => s.path === edit.path);
    if (mine.length === 0) {
      breaches.push({ rule: "edit_outside_symbol", file: edit.path, detail: "this file carries no named declaration, so nothing in it may change" });
      continue;
    }
    if (ts === null) {
      breaches.push({ rule: "symbol_not_redeclared", file: edit.path,
        detail: "typescript is not resolvable, so the answer's declarations could not be located — refused rather than assumed (ADR-0086 §4)" });
      continue;
    }

    const found = declarationsOf(ts, parse(ts, edit.contents, edit.path));
    const now: { s: typeof mine[number]; span: Span }[] = [];
    for (const s of mine) {
      const hits = found.filter((d) => d.name === s.name);
      if (hits.length !== 1) {
        breaches.push({ rule: "symbol_not_redeclared", file: edit.path,
          detail: hits.length === 0
            ? `${s.name} is no longer declared here — it was renamed, split or deleted, and the task names it`
            : `${s.name} is now declared ${hits.length} times, and the task names one declaration` });
      } else {
        now.push({ s, span: hits[0]!.span });
      }
    }
    if (now.length !== mine.length) continue;

    // Put the originals back, last span first, so earlier offsets stay valid.
    let reverted = edit.contents;
    for (const { s, span } of [...now].sort((a, b) => b.span.start - a.span.start)) {
      reverted = reverted.slice(0, span.start) + before.slice(s.start, s.end) + reverted.slice(span.end);
    }
    if (reverted !== before) {
      breaches.push({ rule: "edit_outside_symbol", file: edit.path,
        detail: `with ${mine.map((s) => s.name).join(", ")} put back as they were, the file still differs from the original at line ` +
          `${lineAt(before, firstDifference(reverted, before))} — only the named declarations may change` });
    }
  }
  return breaches;
}

const firstDifference = (a: string, b: string): number => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
  return n;
};
