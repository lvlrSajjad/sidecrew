// `sidecrew read` — judgement retrieval, ADR-0090 §2.2 and §4 piece 4.
//
// A local worker reads up to ten files and answers one question the planner asked, and **only the claims
// whose every quote a machine finds, byte for byte, inside the lines they cite reach the planner**. That
// is existence, checked. Relevance is not checked by anyone, and ADR-0090 §2.3 is why that is acceptable:
// the answer is capped (`READ_BUDGET`, frozen in the prompt file before this code existed), its cost is
// what `R` measures, and a misleading claim produces tasks the change gate fails rather than survivors.
//
// **What never happens here:** a refused claim's text reaching Claude (non-negotiable #3), or a Claude
// token being spent on the reader (non-negotiable #1 — `ReadAnswer.claude_tokens` is the literal 0 and
// the worker client refuses a non-local URL).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverWorkers, portsFromEnv, RUN_SEED, type WorkerEndpoint } from "./batch.js";
import { toPosix } from "./change.js";
import { withIntactProject } from "./integrity.js";
import { render } from "./prompt.js";
import { READ_BUDGET, ReadAnswer, type ReadRefusal } from "./schemas.js";
import { sidecrewDir } from "./serve.js";
import { complete, type Message } from "./worker.js";

const TEMPLATE_PATH = fileURLToPath(new URL("./prompts/reader.md", import.meta.url));

/** Completion cap: eight claims with quotes fit comfortably; a reader that needs more is surveying. */
export const READ_MAX_TOKENS = 1500;
export const READ_TIMEOUT_MS = 180_000;

export interface ReadQuestion {
  question: string;
  /** Project-relative paths. */
  files: string[];
}

interface GivenFile { path: string; text: string; lines: string[]; sha256: string }

/** Load the files the question names, refusing what the reader could not hold or should not see. */
export function loadGiven(projectDir: string, files: string[]): GivenFile[] {
  const root = resolve(projectDir);
  const unique = [...new Set(files.map((f) => toPosix(f).replace(/^\.\//, "")))];
  if (unique.length === 0) throw new Error("sidecrew read needs at least one file to read");
  if (unique.length > READ_BUDGET.max_files) {
    throw new Error(`${unique.length} files is more than a reader is given (${READ_BUDGET.max_files}) — ask narrower questions over fewer files`);
  }
  const given = unique.map((path) => {
    const abs = resolve(root, path);
    const rel = relative(root, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${path} is outside the project`);
    if (!existsSync(abs)) throw new Error(`${path} does not exist in ${projectDir}`);
    const text = readFileSync(abs, "utf8");
    return { path, text, lines: text.split("\n"), sha256: createHash("sha256").update(text).digest("hex") };
  });
  const total = given.reduce((n, f) => n + f.text.length, 0);
  if (total > READ_BUDGET.max_input_chars) {
    throw new Error(`these files are ${total} characters and a reader holds ${READ_BUDGET.max_input_chars} — split the question`);
  }
  return given;
}

export const filesBlock = (given: GivenFile[]): string =>
  given.map((f) => {
    const width = String(f.lines.length).length;
    return `## ${f.path}\n\n${f.lines.map((l, i) => `${String(i + 1).padStart(width)}| ${l}`).join("\n")}`;
  }).join("\n\n");

export async function buildReadPrompt(q: ReadQuestion, given: GivenFile[]): Promise<Message[]> {
  const template = await readFile(TEMPLATE_PATH, "utf8");
  const content = render(template, {
    question: q.question.trim(),
    files_block: filesBlock(given),
    min_quote_chars: String(READ_BUDGET.min_quote_chars),
    max_quote_chars: String(READ_BUDGET.max_quote_chars),
    max_claims: String(READ_BUDGET.max_claims),
    max_claim_chars: String(READ_BUDGET.max_claim_chars),
  });
  return [{ role: "user", content }];
}

interface RawCite { file?: unknown; lines?: unknown; quote?: unknown }
interface RawClaim { claim?: unknown; cite?: unknown }

/** The worker's JSON, fenced or not, or null. A reader that does not answer in the shape asked is `unparsed`. */
export function parseReaderAnswer(text: string): RawClaim[] | null {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as { claims?: unknown };
    return Array.isArray(parsed.claims) ? (parsed.claims as RawClaim[]) : null;
  } catch {
    return null;
  }
}

type Citation = { file: string; start_line: number; end_line: number; quote: string; match: "exact" | "normalised" };
type Checked = { ok: true; citation: Citation } | { ok: false; reason: ReadRefusal };

/**
 * ADR-0090 §2.2's check, for one citation: is the quote inside the lines it names, in a file the reader was
 * given — byte for byte, or failing that word for word once layout is taken out (`normaliseQuote`)? Which
 * of the two it was is recorded, so a reader of the answer can tell.
 */
export function checkCitation(raw: RawCite, given: Map<string, GivenFile>): Checked {
  const file = typeof raw.file === "string" ? toPosix(raw.file).replace(/^\.\//, "") : "";
  const f = given.get(file);
  if (f === undefined) return { ok: false, reason: "file_not_given" };
  const lines = Array.isArray(raw.lines) ? raw.lines : [];
  const start = Number(lines[0]);
  const end = Number(lines[1] ?? lines[0]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > f.lines.length) {
    return { ok: false, reason: "lines_out_of_range" };
  }
  const quote = typeof raw.quote === "string" ? raw.quote : "";
  if (quote.replace(/\s/g, "").length < READ_BUDGET.min_quote_chars || quote.length > READ_BUDGET.max_quote_chars) {
    return { ok: false, reason: "quote_size" };
  }
  const span = f.lines.slice(start - 1, end).join("\n");
  if (span.includes(quote)) return { ok: true, citation: { file, start_line: start, end_line: end, quote, match: "exact" } };
  const n = normaliseQuote(quote);
  if (n.replace(/\s/g, "").length >= READ_BUDGET.min_quote_chars && normaliseQuote(span).includes(n)) {
    return { ok: true, citation: { file, start_line: start, end_line: end, quote, match: "normalised" } };
  }
  return { ok: false, reason: "quote_not_found" };
}

/**
 * The same words in the same order, with the layout taken out: line-leading comment markers (`//`, `/*`,
 * `*`, `*\/`) removed and every run of whitespace one space. The 24 Sep probe's reason (the prompt file's
 * second amendment): the 7B joins a multi-line comment into one line and drops its markers, so byte
 * equality refused claims whose words were all there. **Elision still fails** — `{ ... }` is not in the
 * file — and so does any paraphrase, because the text must still be contiguous and in order.
 */
export const normaliseQuote = (text: string): string =>
  text.split("\n").map((l) => l.replace(/^\s*(\/\/+|\/\*+|\*\/|\*)\s?/, "")).join(" ").replace(/\s+/g, " ").trim();

export interface Admission {
  claims: { claim: string; citations: Citation[] }[];
  refused: Partial<Record<ReadRefusal, number>>;
}

/** Admit each claim whose every citation verifies, in order, until the budget is spent. */
export function admit(raw: RawClaim[], given: GivenFile[]): Admission {
  const byPath = new Map(given.map((f) => [f.path, f]));
  const refused: Partial<Record<ReadRefusal, number>> = {};
  const refuse = (r: ReadRefusal) => { refused[r] = (refused[r] ?? 0) + 1; };
  const claims: Admission["claims"] = [];
  let chars = 0;
  for (const c of raw) {
    const text = typeof c.claim === "string" ? c.claim.trim() : "";
    const cites = Array.isArray(c.cite) ? (c.cite as RawCite[]) : [];
    if (text === "" || cites.length === 0) { refuse("uncited"); continue; }
    if (text.length > READ_BUDGET.max_claim_chars) { refuse("claim_too_long"); continue; }
    const checked = cites.map((x) => checkCitation(x, byPath));
    const failed = checked.find((x): x is Extract<Checked, { ok: false }> => !x.ok);
    // One bad citation refuses the whole claim: a claim whose evidence is partly invented is not a
    // claim with less evidence, it is a claim nobody can trust.
    if (failed !== undefined) { refuse(failed.reason); continue; }
    const claim = { claim: text, citations: checked.map((x) => (x as Extract<Checked, { ok: true }>).citation) };
    const cost = renderClaim(claims.length + 1, claim).length + 1;
    if (claims.length >= READ_BUDGET.max_claims || chars + cost > READ_BUDGET.max_rendered_chars - HEADER_ALLOWANCE) {
      refuse("over_budget");
      continue;
    }
    claims.push(claim);
    chars += cost;
  }
  return { claims, refused };
}

/** Room kept for the one-line header `renderRead` puts above the claims. */
const HEADER_ALLOWANCE = 300;

const renderClaim = (n: number, c: Admission["claims"][number]): string =>
  `${n}. ${c.claim}\n   ${c.citations.map((x) => `${x.file}:${x.start_line}${x.end_line > x.start_line ? `-${x.end_line}` : ""}`).join(", ")}`;

/**
 * What the planner reads: each admitted claim and where it is — **not the quotes**. The machine has
 * checked them; re-reading them is the cost this exists to remove. They are in the JSON for anyone who
 * wants them.
 */
export function renderRead(a: Pick<ReadAnswer, "question" | "outcome" | "claims" | "refused" | "files" | "worker">): string {
  const refusedN = Object.values(a.refused).reduce((n, v) => n + (v ?? 0), 0);
  const why = refusedN === 0 ? "" : ` (${Object.entries(a.refused).map(([k, v]) => `${k} ${v}`).join(", ")})`;
  const head = a.outcome === "answered"
    ? `read: ${a.claims.length} claim(s) admitted, ${refusedN} refused${why} — ${a.files.length} file(s), ${a.worker.model}`
    : a.outcome === "nothing_found"
      ? `read: the reader found nothing that answers this in ${a.files.length} file(s)${refusedN ? `; ${refusedN} claim(s) refused${why}` : ""} — read them yourself if it matters`
      : `read: the reader did not answer in the required shape — nothing admitted; read the files yourself`;
  return [head.slice(0, HEADER_ALLOWANCE), ...a.claims.map((c, i) => renderClaim(i + 1, c))].join("\n");
}

export interface ReadOpts {
  worker?: WorkerEndpoint;
  ports?: number[];
  /** Where the raw answer is kept for diagnosis. Default `.sidecrew/reads`; null keeps nothing. */
  rawDir?: string | null;
  onEvent?: (line: string) => void;
}

export async function read(projectDir: string, q: ReadQuestion, opts: ReadOpts = {}): Promise<ReadAnswer> {
  if (q.question.trim() === "") throw new Error("sidecrew read needs a question");
  const worker = opts.worker ?? (await discoverWorkers(opts.ports ?? portsFromEnv()))[0];
  if (worker === undefined) throw new Error("no local worker is answering — start one with: sidecrew serve");

  return withIntactProject(projectDir, async () => {
    const given = loadGiven(projectDir, q.files);
    const completion = await complete({
      baseUrl: worker.baseUrl, model: worker.modelArg, messages: await buildReadPrompt(q, given),
      seed: RUN_SEED, maxTokens: READ_MAX_TOKENS, timeoutMs: READ_TIMEOUT_MS,
    });
    const raw = parseReaderAnswer(completion.text);
    const { claims, refused } = raw === null ? { claims: [], refused: {} } : admit(raw, given);

    let raw_path: string | null = null;
    const rawDir = opts.rawDir === undefined ? join(sidecrewDir(), "reads") : opts.rawDir;
    if (rawDir !== null) {
      // Kept for a person diagnosing the reader, never for Claude. `.sidecrew/` is gitignored and is the
      // one path the integrity check exempts; a project path in its name is local configuration.
      await mkdir(rawDir, { recursive: true });
      const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${createHash("sha256").update(q.question).digest("hex").slice(0, 8)}`;
      raw_path = join(rawDir, `${id}.txt`);
      await writeFile(raw_path, completion.text, "utf8");
    }

    const base = {
      question: q.question.trim(),
      outcome: raw === null ? "unparsed" as const : claims.length > 0 ? "answered" as const : "nothing_found" as const,
      claims, refused,
      files: given.map((f) => ({ path: f.path, sha256: f.sha256, lines: f.lines.length })),
      worker: { kind: "local" as const, model: worker.model, revision: worker.revision, temperature: 0 as const, seed: RUN_SEED },
    };
    return ReadAnswer.parse({
      version: 1, project: projectDir, ...base,
      usage: { prompt_tokens: completion.usage.prompt_tokens, completion_tokens: completion.usage.completion_tokens },
      wall_ms: Math.round(completion.wall_ms),
      rendered_chars: renderRead(base).length,
      raw_path,
      claude_tokens: 0,
    });
  }, opts.onEvent);
}

export async function readCommand(opts: ReadQuestion & { project: string; json?: boolean }): Promise<ReadAnswer> {
  const a = await read(opts.project, opts, { onEvent: (l) => process.stderr.write(`${l}\n`) });
  process.stdout.write(opts.json ? `${JSON.stringify(a, null, 2)}\n` : `${renderRead(a)}\n`);
  return a;
}
