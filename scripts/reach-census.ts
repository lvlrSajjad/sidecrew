// How much of a project can a worker physically be asked to change? — Phase 14c's `Reach`
//
//   npx tsx scripts/reach-census.ts <project-dir> --label project-a [--out FILE] [--list FILE]
//
// **What it counts.** Every `.ts`/`.tsx` file under `<project>/src`, by bytes, split by whether
// `validateChangePlan`'s `files_too_large_to_rewrite` clause refuses a one-file task on it:
// `rewriteCost([source]) > MAX_FIX_TOKENS`. The clause is imported, never re-implemented — a census
// with its own copy of the rule measures the copy (the `safeName` lesson, HANDOFF §5).
//
// **Why it was written before anything else in the phase.** `prompts/phase-14c-the-reach.md` §1: the
// refused set is the denominator of `Reach` and the population `S_big` is drawn from, and it cannot be
// re-derived afterwards, because the whole point of the phase is that the clause stops firing. So the
// first run of this script is against the code **as it stood before 14c changed anything**, and its
// result file records the sidecrew commit it ran on.
//
// **Counts, never names** (CLAUDE.md #7). A path under a client's `src/` names their modules. The
// committed payload carries counts, bytes and a sha256 of the sorted refused list; the list itself goes
// to `--list`, which defaults to a gitignored directory, so the set can be proved unchanged later
// without ever being published.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { isTestArtefact } from "../src/confinement.js";
import { toPosix } from "../src/change.js";
import { MAX_FIX_TOKENS } from "../src/fix.js";
import { rewriteCost } from "../src/fix-validate.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const projectArg = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const label = flag("--label");
if (projectArg === undefined || label === undefined) {
  console.error("usage: reach-census.ts <project-dir> --label <project-a|project-b> [--out FILE] [--list FILE]");
  process.exit(2);
}
const project = resolve(projectArg);
const today = new Date().toISOString().slice(0, 10);
const out = flag("--out") ?? `experiments/reach/results/census-before-${label}-${today}.json`;
const listOut = flag("--list") ?? `experiments/reach/local/refused-${label}-${today}.txt`;

const git = (cwd: string, ...a: string[]): string => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();

function walk(dir: string, found: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, found);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) found.push(path);
  }
  return found;
}

interface Tally { files: number; bytes: number; refused_files: number; refused_bytes: number }
const tally = (): Tally => ({ files: 0, bytes: 0, refused_files: 0, refused_bytes: 0 });

const all = tally();
const source = tally(); // test artefacts excluded — a plan may never list one (ADR-0048)
const refused: string[] = [];

for (const abs of walk(join(project, "src"), []).sort()) {
  const text = readFileSync(abs, "utf8");
  const bytes = Buffer.byteLength(text, "utf8");
  const rel = toPosix(relative(project, abs));
  const isRefused = rewriteCost([text]) > MAX_FIX_TOKENS;
  const buckets = isTestArtefact(rel) ? [all] : [all, source];
  for (const t of buckets) {
    t.files += 1;
    t.bytes += bytes;
    if (isRefused) { t.refused_files += 1; t.refused_bytes += bytes; }
  }
  if (isRefused && !isTestArtefact(rel)) refused.push(rel);
}

const share = (t: Tally) => ({
  ...t,
  refused_file_share: t.files === 0 ? 0 : t.refused_files / t.files,
  refused_byte_share: t.bytes === 0 ? 0 : t.refused_bytes / t.bytes,
  reach: t.bytes === 0 ? 0 : 1 - t.refused_bytes / t.bytes,
});

const listText = `${refused.join("\n")}\n`;
const payload = {
  measured: true,
  kind: "reach-census",
  phase: "14c",
  when: "before — files_too_large_to_rewrite as it stood before 14c changed anything",
  label,
  date: new Date().toISOString(),
  rule: { clause: "files_too_large_to_rewrite", test: "rewriteCost([source]) > MAX_FIX_TOKENS", MAX_FIX_TOKENS },
  universe: "every .ts/.tsx under <project>/src, .d.ts excluded",
  all_files: share(all),
  source_files: share(source),
  refused_list_sha256: createHash("sha256").update(listText, "utf8").digest("hex"),
  refused_list_count: refused.length,
  project_commit: git(project, "rev-parse", "HEAD"),
  project_dirty: git(project, "status", "--porcelain").length > 0,
  sidecrew_commit: git(process.cwd(), "rev-parse", "HEAD"),
  sidecrew_dirty: git(process.cwd(), "status", "--porcelain", "--", "src").length > 0,
  machine: { host_hash: createHash("sha256").update(hostname()).digest("hex").slice(0, 12), node: process.version },
};

mkdirSync(dirname(out), { recursive: true });
mkdirSync(dirname(listOut), { recursive: true });
writeFileSync(listOut, listText, "utf8");
writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ all: payload.all_files, source: payload.source_files, sha: payload.refused_list_sha256 }, null, 2));
console.log(`wrote ${out} and ${listOut}`);
