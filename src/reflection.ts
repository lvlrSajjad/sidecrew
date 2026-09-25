// The reflective-reference guard — a confinement rule for the one way a behaviour-preserving change can pass
// `tsc` and every test and still break the program at runtime (V1-CHALLENGES §11; the independent analysis's
// item 7; ADR-0092 rung 1 with its blind spots named).
//
// A reference count, a compiler and a test suite all see *static* uses. A NestJS or TypeORM project also
// reaches code by **reflection**: a decorator registers a class with a container, a string token names a
// provider, a glob loads every `*.entity.ts` by path, `this[name]` calls a method by its name. Delete or
// rename something reached only that way and nothing static notices — and if no test happens to exercise the
// path, the suite stays green. The 25 Sep planners refused tasks on exactly this by hand; this makes the
// judgement mechanical where it can be.
//
// **What it checks, for every declaration whose name disappears from a task's file** — by deletion or by
// rename, because a renamed class registered as `'UserService'` breaks the same way:
//   1. it was **decorated** (a class, or a class member) — a framework reaches it by reflection;
//   2. its name appears as a **string literal** in another project file — a DI token, a dynamic lookup;
//   3. its file matches a **runtime glob** written in the project (`**/*.entity{.ts,.js}`) — loaded by path.
//
// **Its blind spots, stated where it is used:** a name *built* at runtime (`'User' + 'Service'`), a glob
// assembled from variables, and configuration outside the project's own files are all invisible to it. It
// fails closed when the compiler cannot be loaded, the way ADR-0086's symbol rules do.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { ChangeCandidate, ChangeTask, ConfinementBreach } from "./schemas.js";
import { declarations } from "./symbols.js";
import { loadCompiler } from "./verifier/ast.js";

type TsModule = typeof import("typescript");
type TsNode = import("typescript").Node;

const toPosix = (p: string): string => p.split(sep).join("/");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".sidecrew", ".next", "out"]);
const SCANNED = /\.(ts|tsx|js|jsx|mjs|cjs|json|ya?ml)$/;
/** Files larger than this are data, not code, and a name inside one is not a registration. */
const MAX_SCANNED_BYTES = 512 * 1024;

/** Every project file a string token or a glob could be written in, as `[posix path, text]`. */
function projectTexts(projectDir: string): [string, string][] {
  const out: [string, string][] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs);
      else if (SCANNED.test(name) && st.size <= MAX_SCANNED_BYTES) {
        try {
          out.push([toPosix(relative(projectDir, abs)), readFileSync(abs, "utf8")]);
        } catch {
          // Unreadable is not a registration.
        }
      }
    }
  };
  walk(projectDir);
  return out;
}

/** `'Name'`, `"Name"` or `` `Name` `` — the name alone, as a string. */
const stringToken = (name: string): RegExp => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(['"\`])${escaped}\\1`);
};

/** String literals that look like a runtime file glob: a wildcard, and a `.ts` / `.js` ending in some spelling. */
export function runtimeGlobs(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/(['"`])([^'"`\n]*\*[^'"`\n]*)\1/g)) {
    const g = m[2]!;
    if (/\.(\{?[jt]s|\{\.?[jt]s)|\.\*$|\*\.[jt]s/.test(g) || /\{\.ts,\.js\}|\{ts,js\}/.test(g)) found.push(g);
  }
  return found;
}

// A glob's last path segment as a regular expression over a basename: `*`, `?` and `{a,b}`. **`.js` and `.ts`
// are the same file here**: a glob is often written against compiled output (`dist/**/*.entity.js`) while the
// task edits the source, and missing that is the dangerous direction. (Line comments on purpose: a glob's
// `**/` would close a block comment.)
export function globTailMatches(glob: string, file: string): boolean {
  const variants = [file, file.replace(/\.([cm]?)ts(x?)$/, ".$1js$2")];
  return variants.some((f) => tailMatches(glob, f));
}

function tailMatches(glob: string, file: string): boolean {
  const tail = glob.split("/").filter((s) => s !== "" && s !== "**").at(-1);
  if (tail === undefined) return false;
  let re = "";
  for (let i = 0; i < tail.length; i += 1) {
    const c = tail[i]!;
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const close = tail.indexOf("}", i);
      if (close === -1) { re += "\\{"; continue; }
      re += `(?:${tail.slice(i + 1, close).split(",").map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`;
      i = close;
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(basename(file));
}

/** Which of `names` are declarations in `source` carrying a decorator — on the class, or on the member itself. */
function decorated(ts: TsModule, source: string, fileName: string, names: Set<string>): Set<string> {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const hit = new Set<string>();
  const has = (n: TsNode): boolean => ts.canHaveDecorators(n) && (ts.getDecorators(n) ?? []).length > 0;
  const text = (n: TsNode | undefined): string | undefined =>
    n !== undefined && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : undefined;
  for (const st of sf.statements) {
    if (!ts.isClassDeclaration(st)) continue;
    const cls = text(st.name);
    if (cls === undefined) continue;
    if (names.has(cls) && has(st)) hit.add(cls);
    for (const m of st.members) {
      const member = ts.isConstructorDeclaration(m) ? "constructor" : text((m as { name?: TsNode }).name);
      if (member !== undefined && names.has(`${cls}.${member}`) && has(m)) hit.add(`${cls}.${member}`);
    }
  }
  return hit;
}

/**
 * The `reflective_reference` breaches of one candidate: every declaration whose name leaves a task's file
 * while something reaches it by reflection. Empty when nothing disappears — the common case, and free.
 */
export function reflectiveBreaches(task: ChangeTask, candidate: ChangeCandidate, projectDir?: string): ConfinementBreach[] {
  const sources = new Map(task.files.map((f) => [f.path, f.source]));
  const gone = new Map<string, string[]>();
  for (const edit of candidate.edits) {
    const before = sources.get(edit.path);
    if (before === undefined || before === edit.contents) continue;
    const was = declarations(before, edit.path, projectDir);
    const now = declarations(edit.contents, edit.path, projectDir);
    if (was === null || now === null) {
      return [{ rule: "reflective_reference", file: edit.path, detail: "typescript could not be loaded, so what this change removes cannot be checked for reflective uses — fails closed" }];
    }
    const remaining = new Set(now.map((d) => d.name));
    const lost = [...new Set(was.map((d) => d.name))].filter((n) => !remaining.has(n));
    if (lost.length > 0) gone.set(edit.path, lost);
  }
  if (gone.size === 0) return [];

  const ts = loadCompiler(projectDir) as TsModule | null;
  if (ts === null) {
    return [...gone.keys()].map((file) => ({ rule: "reflective_reference" as const, file, detail: "typescript could not be loaded — fails closed" }));
  }
  const texts = projectDir === undefined ? [] : projectTexts(projectDir);
  const globs = [...new Set(texts.flatMap(([, t]) => runtimeGlobs(t)))];
  const breaches: ConfinementBreach[] = [];
  for (const [file, lost] of gone) {
    const names = new Set(lost);
    for (const name of decorated(ts, sources.get(file)!, file, names)) {
      breaches.push({ rule: "reflective_reference", file, detail: `${name} is decorated, so a framework may reach it by reflection (DI, an ORM, a scheduler) where no reference count or test can see — it may not be removed or renamed here` });
    }
    for (const name of lost) {
      const leaf = name.split(".").at(-1)!;
      const where = texts.find(([p, t]) => p !== toPosix(file) && stringToken(leaf).test(t));
      if (where !== undefined) {
        breaches.push({ rule: "reflective_reference", file, detail: `${name} is named as the string '${leaf}' in ${where[0]} — a DI token or a lookup by name reaches it that way` });
      }
    }
    const glob = globs.find((g) => globTailMatches(g, file));
    if (glob !== undefined) {
      breaches.push({ rule: "reflective_reference", file, detail: `${file} matches the runtime glob '${glob}' — loaded by path, so removing or renaming ${lost.join(", ")} is invisible to the compiler and to a reference count` });
    }
  }
  return breaches;
}
