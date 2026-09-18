#!/usr/bin/env node
// What the planner cost, in tokens, taken from Claude Code's own record rather than estimated.
//
// `TestPlan.meta.planner_tokens` is the only number in a `BatchResult` that is *not* measured by
// sidecrew — `stats.claude_tokens.planning` copies it straight out of the plan — so a planner that
// guesses puts a fiction into the go/no-go comparison at the one place the design says Claude is
// expensive. Claude Code writes a usage block per assistant message into the session transcript under
// ~/.claude/projects/<slug>/<session>.jsonl; this sums them.
//
//   node scripts/planner-tokens.mjs            # totals for the newest session in this project
//   node scripts/planner-tokens.mjs --mark     # print a checkpoint to diff against later
//   node scripts/planner-tokens.mjs --since N  # totals over the messages after checkpoint N
//
// The planner's recipe: `--mark` before reading the module, `--since` after writing the plan, and the
// delta's `total_excluding_cache_reads` goes in `meta.planner_tokens`.
//
// **Cache reads are reported and not counted**, and the difference is not small: a 25-message planning
// pass over a 220 k context reads ~5.4 M cached tokens and creates ~129 k new ones. Both are printed.
// The second is the one that belongs in the plan, because a cache read is the *same* context being
// re-sent rather than new work, and `BatchResult.stats.claude_tokens.planning` is compared against a
// worker count of zero — a 5.5 M there would say planning processed 5.5 M distinct tokens, which it did
// not. `total` is kept in the output so nobody has to take that on trust.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const slug = (dir) => dir.replace(/\//g, "-");

const sessionsDir = () => join(homedir(), ".claude", "projects", slug(process.cwd()));

/** The transcript written most recently — this session, when run from inside it. */
function newestTranscript(dir) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  if (files.length === 0) throw new Error(`no session transcript in ${dir}`);
  return join(dir, files[0].f);
}

/** Every assistant message's usage block, in order. */
function usages(path) {
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const u = JSON.parse(line)?.message?.usage;
      if (u) out.push(u);
    } catch {
      // A partially written last line is normal while the session is live.
    }
  }
  return out;
}

const sum = (list) => list.reduce((t, u) => ({
  input: t.input + (u.input_tokens ?? 0),
  output: t.output + (u.output_tokens ?? 0),
  cache_creation: t.cache_creation + (u.cache_creation_input_tokens ?? 0),
  cache_read: t.cache_read + (u.cache_read_input_tokens ?? 0),
}), { input: 0, output: 0, cache_creation: 0, cache_read: 0 });

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : (args[at + 1] ?? "");
};

const path = flag("--file") ?? newestTranscript(sessionsDir());
const all = usages(path);

if (args.includes("--mark")) {
  process.stdout.write(`${JSON.stringify({ transcript: path, messages: all.length })}\n`);
} else {
  const since = Number(flag("--since") ?? 0) || 0;
  const window = all.slice(since);
  const t = sum(window);
  process.stdout.write(`${JSON.stringify({
    transcript: path,
    messages: window.length,
    since,
    ...t,
    // Everything, including context re-read from cache. Reported for completeness.
    total: t.input + t.output + t.cache_creation + t.cache_read,
    // What goes in `meta.planner_tokens`: new tokens only — read, created, and written.
    total_excluding_cache_reads: t.input + t.output + t.cache_creation,
  }, null, 2)}\n`);
}
