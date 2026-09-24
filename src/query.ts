// `sidecrew query` — predicate retrieval, ADR-0090 §4 piece 3.
//
// The 20 Sep planners wrote their own throwaway scripts, in the middle of planning, for four questions:
// how many references does this symbol have, which exports does nothing outside their file use, which
// declarations fit the rewrite ceiling, and where are the unused locals. Those scripts and the greps
// and listings around them were a fifth of everything the larger planner read (ADR-0090 §1). They are
// predicate questions — a machine answers them exactly — so a machine should, once, in a shape a
// planner can read cheaply.
//
// **The compiler answers, never a regular expression.** References come from the project's own
// TypeScript language service, loaded out of the project (ADR-0076: `typescript` is not a dependency
// of sidecrew). A grep counts a name; this counts the symbol, so a same-named local in another file is
// not a reference and an aliased import is.
//
// **Every list is capped and says so** (`QueryAnswer.truncated`), and a capped list keeps its `total`.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  assertChangeToolchain, DEFAULT_CHANGE_TIMEOUTS, makeChangeSandbox, PROJECT_SCOPE, toPosix, typecheck,
} from "./change.js";
import { isTestArtefact } from "./confinement.js";
import { MAX_FIX_TOKENS } from "./fix.js";
import { rewriteCost } from "./fix-validate.js";
import { withIntactProject } from "./integrity.js";
import { QueryAnswer, type StrictnessFlag } from "./schemas.js";
import { declarations, lineAt } from "./symbols.js";
import { loadCompiler } from "./verifier/ast.js";
import { removeSandbox, VerifierSetupError } from "./verifier/shared.js";

type TsModule = typeof import("typescript");
type TsNode = import("typescript").Node;
type TsSourceFile = import("typescript").SourceFile;
type TsLanguageService = import("typescript").LanguageService;

export const DEFAULT_QUERY_LIMIT = 50;
/** Locations listed per symbol in a `refs` answer; the count is always exact. */
export const REFS_LOCATIONS = 10;

export type QueryKind = QueryAnswer["kind"];
export const QUERY_KINDS: readonly QueryKind[] = ["refs", "unreferenced", "sizes", "diagnostics"];

export interface QueryOpts {
  tsconfig?: string;
  limit?: number;
  /** A project-relative prefix, `src/common` say. Everything in the program when absent. */
  under?: string;
  /** `refs` only: `file:Name` or `file:Class.member`, project-relative. */
  symbols?: string[];
  /** `diagnostics` only. */
  flag?: StrictnessFlag;
  codes?: string[];
  timeoutMs?: number;
  sandboxRoot?: string;
  onEvent?: (line: string) => void;
}

// ── the language service, over exactly the program the project's tsconfig describes ────────────────

interface Program {
  ts: TsModule;
  ls: TsLanguageService;
  /** Absolute paths of the program's own files — `node_modules` and lib files are never in it. */
  files: string[];
  inProgram: Set<string>;
  root: string;
  rel: (abs: string) => string;
}

function openProgram(projectDir: string, tsconfig: string): Program {
  const ts = loadCompiler(projectDir) as TsModule | null;
  if (ts === null) {
    throw new VerifierSetupError(
      `typescript is not resolvable from ${projectDir}, and sidecrew query asks the project's own compiler — ` +
      "it is not a dependency of sidecrew (ADR-0076). Install the project's dependencies first.",
    );
  }
  const root = resolve(projectDir);
  const parsed = ts.getParsedCommandLineOfConfigFile(resolve(root, tsconfig), {}, {
    ...ts.sys,
    getCurrentDirectory: () => root,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new VerifierSetupError(`${tsconfig}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
    },
  });
  if (parsed === undefined) throw new VerifierSetupError(`${tsconfig} could not be read by the project's compiler`);
  const files = parsed.fileNames.map((f) => resolve(f));
  const text = new Map<string, string | undefined>();
  const read = (f: string): string | undefined => {
    if (!text.has(f)) text.set(f, ts.sys.readFile(f));
    return text.get(f);
  };
  // Read-only by construction: a language service host has no write method, and nothing here calls
  // `ts.sys.writeFile`. The integrity check around every query is the proof rather than this comment.
  const ls = ts.createLanguageService({
    getCompilationSettings: () => parsed.options,
    getScriptFileNames: () => files,
    getScriptVersion: () => "0",
    getScriptSnapshot: (f) => {
      const t = read(f);
      return t === undefined ? undefined : ts.ScriptSnapshot.fromString(t);
    },
    getCurrentDirectory: () => root,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: read,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  }, ts.createDocumentRegistry());
  return { ts, ls, files, inProgram: new Set(files), root, rel: (abs) => toPosix(relative(root, abs)) };
}

const sourceFileOf = (p: Program, abs: string): TsSourceFile => {
  const sf = p.ls.getProgram()?.getSourceFile(abs);
  if (sf === undefined) throw new VerifierSetupError(`${p.rel(abs)} is not in the program the tsconfig describes`);
  return sf;
};

/** A project-relative prefix match on a posix path. `src/common` matches `src/common/x.ts`, not `src/commonx.ts`. */
export const isUnder = (file: string, under: string | undefined): boolean => {
  if (under === undefined || under === "" || under === ".") return true;
  const prefix = toPosix(under).replace(/^\.\//, "").replace(/\/+$/, "");
  return file === prefix || file.startsWith(`${prefix}/`);
};

/** The program's own source files a planner could ask a task about: no declaration files, no tests. */
const sourcesUnder = (p: Program, under: string | undefined): string[] =>
  p.files.filter((f) => !f.endsWith(".d.ts") && !isTestArtefact(p.rel(f)) && isUnder(p.rel(f), under));

// ── naming a declaration: `Name` or `Class.member`, the same spelling a symbol task uses ────────────

const identText = (ts: TsModule, name: TsNode | undefined): string | undefined =>
  name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) ? name.text : undefined;

/** The name node of `name` in `sf`, for `findReferences` to start from, or null. */
function nameNode(ts: TsModule, sf: TsSourceFile, name: string): TsNode | null {
  const [head, member] = name.split(".");
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (identText(ts, d.name) === head && member === undefined) return d.name;
      continue;
    }
    if (!(ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st)
      || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st) || ts.isModuleDeclaration(st))) continue;
    if (identText(ts, st.name) !== head || st.name === undefined) continue;
    if (member === undefined) return st.name;
    if (ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st)) {
      for (const m of st.members) {
        if (member === "constructor" && ts.isConstructorDeclaration(m)) return m.getFirstToken(sf) ?? m;
        if (identText(ts, m.name) === member && m.name !== undefined) return m.name;
      }
    }
  }
  return null;
}

interface Refs { total: number; files: Set<string>; fromTests: number; outsideNonTest: number; locations: { file: string; line: number }[] }

function referencesOf(p: Program, sf: TsSourceFile, node: TsNode): Refs {
  const found = p.ls.findReferences(sf.fileName, node.getStart(sf)) ?? [];
  const refs: Refs = { total: 0, files: new Set(), fromTests: 0, outsideNonTest: 0, locations: [] };
  const seen = new Set<string>();
  const program = p.ls.getProgram();
  for (const symbol of found) {
    for (const r of symbol.references) {
      if (r.isDefinition) continue;
      const key = `${r.fileName}:${r.textSpan.start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // References inside node_modules or lib files are not the project's, and cannot be edited by a task.
      if (!p.inProgram.has(resolve(r.fileName))) continue;
      const file = p.rel(resolve(r.fileName));
      const text = program?.getSourceFile(r.fileName)?.text ?? "";
      refs.total += 1;
      refs.files.add(file);
      if (isTestArtefact(file)) refs.fromTests += 1;
      else if (resolve(r.fileName) !== resolve(sf.fileName)) refs.outsideNonTest += 1;
      refs.locations.push({ file, line: lineAt(text, r.textSpan.start) });
    }
  }
  refs.locations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return refs;
}

// ── the four questions ──────────────────────────────────────────────────────────────────────────────

const common = (projectDir: string, tsconfig: string, started: number) => ({
  version: 1 as const, project: projectDir, tsconfig, created: new Date().toISOString(), ms: Date.now() - started,
});

function refsQuery(p: Program, specs: string[]) {
  if (specs.length === 0) throw new Error("query refs needs at least one --symbol file:Name");
  return specs.map((spec) => {
    const at = spec.lastIndexOf(":");
    if (at <= 0) throw new Error(`${spec} is not file:Name — say which file declares it, the way a symbol task does`);
    const file = toPosix(spec.slice(0, at));
    const name = spec.slice(at + 1);
    const abs = resolve(p.root, file);
    const none = { file, name, found: false, references: 0, files: 0, from_tests: 0, locations: [], locations_truncated: false };
    if (!p.inProgram.has(abs)) return none;
    const sf = sourceFileOf(p, abs);
    const node = nameNode(p.ts, sf, name);
    if (node === null) return none;
    const r = referencesOf(p, sf, node);
    r.files.add(file);
    return {
      file, name, found: true, references: r.total, files: r.files.size, from_tests: r.fromTests,
      locations: r.locations.slice(0, REFS_LOCATIONS), locations_truncated: r.locations.length > REFS_LOCATIONS,
    };
  });
}

const DECLARATION_KIND: Record<string, string> = {
  FunctionDeclaration: "function", ClassDeclaration: "class", InterfaceDeclaration: "interface",
  TypeAliasDeclaration: "type", EnumDeclaration: "enum", VariableStatement: "const", ModuleDeclaration: "namespace",
};

function unreferencedQuery(p: Program, under: string | undefined, say: (l: string) => void) {
  const { ts } = p;
  const items: { file: string; name: string; line: number; kind: string; decorated: boolean; refs_from_tests: number }[] = [];
  let scanned = 0;
  const files = sourcesUnder(p, under);
  say(`  ${files.length} source file(s) under ${under ?? "the whole program"}`);
  for (const abs of files) {
    const sf = sourceFileOf(p, abs);
    for (const st of sf.statements) {
      const exported = ts.canHaveModifiers(st) && (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      const kind = DECLARATION_KIND[ts.SyntaxKind[st.kind]];
      if (kind === undefined) continue;
      const names: TsNode[] = ts.isVariableStatement(st)
        ? st.declarationList.declarations.map((d) => d.name).filter((n) => ts.isIdentifier(n))
        : "name" in st && st.name !== undefined ? [st.name as TsNode] : [];
      for (const n of names) {
        scanned += 1;
        const r = referencesOf(p, sf, n);
        if (r.outsideNonTest > 0) continue;
        items.push({
          file: p.rel(abs), name: identText(ts, n) ?? "?", line: lineAt(sf.text, n.getStart(sf)), kind,
          decorated: ts.canHaveDecorators(st) && (ts.getDecorators(st) ?? []).length > 0,
          refs_from_tests: r.fromTests,
        });
      }
    }
  }
  return { items, scanned };
}

function sizesQuery(p: Program, under: string | undefined) {
  const items = sourcesUnder(p, under).map((abs) => {
    const text = readFileSync(abs, "utf8");
    const file = p.rel(abs);
    const rewrite_tokens = rewriteCost([text]);
    const fits = rewrite_tokens <= MAX_FIX_TOKENS;
    if (fits) return { file, chars: text.length, rewrite_tokens, fits, declarations: null, declarations_fitting: null };
    // Only uniquely nameable declarations: an ambiguous name is refused by `resolveSymbol`, so counting it
    // as a task a planner could write would be a promise the validator then breaks.
    const all = declarations(text, abs, p.root) ?? [];
    const counts = new Map<string, number>();
    for (const d of all) counts.set(d.name, (counts.get(d.name) ?? 0) + 1);
    const nameable = all.filter((d) => counts.get(d.name) === 1);
    const fitting = nameable.filter((d) => rewriteCost([text.slice(d.span.start, d.span.end)]) <= MAX_FIX_TOKENS).length;
    return { file, chars: text.length, rewrite_tokens, fits, declarations: nameable.length, declarations_fitting: fitting };
  });
  // Largest first: the files that do not fit are the ones a planner needs to know about.
  items.sort((a, b) => b.chars - a.chars || a.file.localeCompare(b.file));
  return { items, fitting: items.filter((i) => i.fits).length };
}

const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s*(.*)$/;

/** `file(line,col): error TSnnnn: message`, from `--pretty false` output, paths made project-relative. */
export function parseDiagnostics(message: string, sandbox: string): { file: string; line: number; col: number; code: string; message: string }[] {
  const out: { file: string; line: number; col: number; code: string; message: string }[] = [];
  const names = [resolve(sandbox)];
  // macOS hands back `/var/…` for a temp dir and `tsc` prints `/private/var/…` (`sandboxNames` in change.ts).
  try { names.push(realpathSync(sandbox)); } catch { /* the given name is enough */ }
  for (const raw of message.split("\n")) {
    const m = DIAGNOSTIC.exec(raw.trimEnd());
    if (!m) continue;
    let file = toPosix(m[1]!);
    for (const n of names) {
      const rel = relative(n, m[1]!);
      if (m[1]!.startsWith("/") && !rel.startsWith("..")) { file = toPosix(rel); break; }
    }
    out.push({ file, line: Number(m[2]), col: Number(m[3]), code: m[4]!, message: m[5]!.slice(0, 200) });
  }
  return out;
}

async function diagnosticsQuery(projectDir: string, tsconfig: string, opts: QueryOpts) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHANGE_TIMEOUTS.compile;
  const sandbox = await makeChangeSandbox(projectDir, opts.sandboxRoot);
  try {
    const under = await typecheck(sandbox, projectDir, tsconfig, timeoutMs, opts.flag === undefined ? [] : [opts.flag]);
    let found = parseDiagnostics(under.message, sandbox);
    if (opts.flag !== undefined) {
      // Only what the flag adds: the planner's question is "what would turning this on cost", and the
      // baseline's own errors are an answer to a different one.
      const base = await typecheck(sandbox, projectDir, tsconfig, timeoutMs);
      const had = new Set(parseDiagnostics(base.message, sandbox).map((d) => `${d.file}:${d.line}:${d.col}:${d.code}`));
      found = found.filter((d) => !had.has(`${d.file}:${d.line}:${d.col}:${d.code}`));
    }
    const codes = (opts.codes ?? []).map((c) => (c.toUpperCase().startsWith("TS") ? c.toUpperCase() : `TS${c}`));
    return found
      .filter((d) => d.file !== PROJECT_SCOPE && isUnder(d.file, opts.under))
      .filter((d) => codes.length === 0 || codes.includes(d.code))
      .map(({ file, line, code, message }) => ({ file, line, code, message }));
  } finally {
    await removeSandbox(sandbox);
  }
}

// ── the entry point ─────────────────────────────────────────────────────────────────────────────────

export async function query(kind: QueryKind, projectDir: string, opts: QueryOpts = {}): Promise<QueryAnswer> {
  const tsconfig = opts.tsconfig ?? "tsconfig.json";
  const limit = opts.limit ?? DEFAULT_QUERY_LIMIT;
  const say = opts.onEvent ?? (() => {});
  const under = opts.under === undefined || opts.under === "" ? undefined : toPosix(opts.under);
  if (!QUERY_KINDS.includes(kind)) throw new Error(`query kind must be one of ${QUERY_KINDS.join(", ")}`);
  if (!existsSync(resolve(projectDir, tsconfig))) throw new VerifierSetupError(`${projectDir} has no ${tsconfig}`);
  if (kind === "diagnostics") assertChangeToolchain(projectDir, tsconfig);

  return withIntactProject(projectDir, async () => {
    const started = Date.now();
    const cap = <T>(items: T[]) => ({ total: items.length, truncated: items.length > limit, items: items.slice(0, limit) });
    if (kind === "diagnostics") {
      const items = await diagnosticsQuery(projectDir, tsconfig, { ...opts, under });
      return QueryAnswer.parse({
        ...common(projectDir, tsconfig, started), kind, under: under ?? null, flag: opts.flag ?? null,
        added_only: opts.flag !== undefined, codes: opts.codes ?? [], ...cap(items),
      });
    }
    say(`  opening ${tsconfig} with the project's own language service`);
    const p = openProgram(projectDir, tsconfig);
    if (kind === "refs") {
      const items = refsQuery(p, opts.symbols ?? []);
      return QueryAnswer.parse({ ...common(projectDir, tsconfig, started), kind, total: items.length, truncated: false, items });
    }
    if (kind === "unreferenced") {
      const { items, scanned } = unreferencedQuery(p, under, say);
      return QueryAnswer.parse({ ...common(projectDir, tsconfig, started), kind, under: under ?? null, scanned, ...cap(items) });
    }
    const { items, fitting } = sizesQuery(p, under);
    return QueryAnswer.parse({
      ...common(projectDir, tsconfig, started), kind, under: under ?? null, ceiling: MAX_FIX_TOKENS, fitting, ...cap(items),
    });
  }, say);
}

// ── rendering: one line per item, because a planner reads this and its reading is the cost ─────────

/**
 * The answer as a planner reads it. **Text by default, and on purpose**: the JSON repeats every key on
 * every item, and a planner's reading is the thing 14d is measured on (ADR-0090 §1). The JSON is the
 * contract; this is the cheap view of it, and it drops nothing but the key names.
 */
export function renderQuery(a: QueryAnswer): string {
  const more = a.truncated ? ` — showing ${a.items.length} of ${a.total}; raise --limit for the rest` : "";
  const out: string[] = [];
  switch (a.kind) {
    case "refs":
      out.push(`refs (${a.ms} ms)`);
      for (const r of a.items) {
        if (!r.found) { out.push(`${r.file}:${r.name}  NOT FOUND — no declaration of that name in that file`); continue; }
        out.push(`${r.file}:${r.name}  ${r.references} ref(s) in ${r.files} file(s), ${r.from_tests} from tests`);
        for (const l of r.locations) out.push(`  ${l.file}:${l.line}`);
        if (r.locations_truncated) out.push(`  … ${r.references - r.locations.length} more`);
      }
      break;
    case "unreferenced":
      out.push(`unreferenced exports under ${a.under ?? "the program"}: ${a.total} of ${a.scanned} scanned have no reference outside their file from a non-test file${more}`);
      out.push("  (a count of references cannot see reflection: a decorated class may be reached by DI or a glob)");
      for (const i of a.items) {
        out.push(`${i.file}:${i.line} ${i.kind} ${i.name}${i.decorated ? "  DECORATED" : ""}${i.refs_from_tests ? `  used by ${i.refs_from_tests} test ref(s)` : ""}`);
      }
      break;
    case "sizes":
      out.push(`sizes under ${a.under ?? "the program"}: ${a.fitting} of ${a.total} file(s) fit a whole-file rewrite (ceiling ${a.ceiling} tokens)${more}`);
      for (const i of a.items) {
        out.push(`${i.file}  ${i.chars} chars, ~${i.rewrite_tokens} tokens${i.fits ? "" : `  TOO BIG — ${i.declarations_fitting}/${i.declarations} nameable declarations fit as symbol tasks`}`);
      }
      break;
    case "diagnostics":
      out.push(`diagnostics${a.flag ? ` added by ${a.flag}` : ""} under ${a.under ?? "the program"}${a.codes.length ? ` (${a.codes.join(", ")})` : ""}: ${a.total}${more}`);
      for (const d of a.items) out.push(`${d.file}:${d.line} ${d.code} ${d.message}`);
      break;
  }
  return `${out.join("\n")}\n`;
}

export async function queryCommand(kind: QueryKind, opts: QueryOpts & { project: string; json?: boolean }): Promise<QueryAnswer> {
  const answer = await query(kind, opts.project, { ...opts, onEvent: opts.json ? undefined : (l) => process.stderr.write(`${l}\n`) });
  process.stdout.write(opts.json ? `${JSON.stringify(answer, null, 2)}\n` : renderQuery(answer));
  return answer;
}
