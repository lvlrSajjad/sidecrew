#!/usr/bin/env node
// What the planner cost, in tokens, taken from Claude Code's own record rather than estimated.
//
// `TestPlan.meta.planner_tokens` is the only number in a `BatchResult` that is *not* measured by
// sidecrew — `stats.claude_tokens.planning` copies it straight out of the plan — so a planner that
// guesses puts a fiction into the go/no-go comparison at the one place the design says Claude is
// expensive. Claude Code writes a usage block per assistant message into the session transcript under
// ~/.claude/projects/<slug>/; this sums them.
//
//   node scripts/planner-tokens.mjs            # totals for the newest session in this project
//   node scripts/planner-tokens.mjs --mark     # print a checkpoint to diff against later
//   node scripts/planner-tokens.mjs --since N  # totals over the messages after checkpoint N
//   node scripts/planner-tokens.mjs --list     # the subagent transcripts under that session
//   node scripts/planner-tokens.mjs --agent ID # totals for ONE subagent transcript
//   node scripts/planner-tokens.mjs --agents   # every subagent under that session, with a breakdown
//   node scripts/planner-tokens.mjs --session ID   # a session other than the newest
//
// The planner's recipe **is no longer `--mark`/`--since`**: see "the clean window dissolves" below.
// For an Opus planner that runs as a subagent it is `--agents` after the plan is written, and the
// delta's `total_excluding_cache_reads` goes in `meta.planner_tokens`.
//
// ── Two defects, both found 19 Sep 2026, both of which this file used to have ─────────────────────
//
// **1. It could not see a subagent, which is the only thing it exists to measure.** `change-planner`
// and `test-planner` are subagents by design (`claude/agents/*.md`, `model: opus`), and a subagent's
// transcript is NOT a `*.jsonl` beside the session's — it is
// `<session-id>/subagents/agent-*.jsonl`, a subdirectory the old `readdirSync(...).filter(endsWith
// ".jsonl")` never descended into. Measured: a subagent spent 871,579 new tokens across 239 assistant
// messages while the parent transcript recorded 1,704 entries, every one `isSidechain: false`, and
// none of that usage. So `meta.planner_tokens` is suspect wherever a planner ran as a subagent.
//
// **2. It counted every assistant message about twice.** Claude Code writes a usage record per
// message *twice or more* — a partial with `stop_reason: null` and then the final one — and the old
// code summed every record it found. The partials repeat `input_tokens`, `cache_creation_input_tokens`
// and `cache_read_input_tokens` verbatim, so those were double-counted outright. Measured over 177
// transcripts in this project: the naive sum inflates new tokens by a **median of 1.89×**, up to
// 4.18×. Deduplicating by `message.id` and keeping the **last** record is correct because the last
// record was the maximum in **4,712 of 4,712** messages — asserted below rather than assumed, because
// a silent change of direction here would inflate or deflate a number nobody would re-derive.
//
// **3. Its slug dropped underscores and dots**, so it exited ENOENT on any project path containing
// one — which the projects this is measured on do. Recorded in `BACKLOG.md` and never fixed, in the
// same entry as defect 1.
//
// Every figure this script produced before 19 Sep 2026 is therefore wrong in two independent
// directions, and it is not a correction that can be applied to an old number: defect 1 omits a whole
// transcript and defect 2 multiplies what is left. Re-measure; do not rescale.
//
// ── The clean window dissolves ───────────────────────────────────────────────────────────────────
//
// Every earlier plan for §2.1 assumed the measurement needed a *fresh session*, because the default
// mode sums a whole transcript and a window containing the building as well as the planning is
// contaminated. That requirement is gone: **a subagent transcript is a clean window by construction**
// — it holds that agent's work and nothing else — so `--agent`/`--agents` measures the planner
// directly and the session it was spawned from is irrelevant.
//
// ── Cache reads are reported and not counted ─────────────────────────────────────────────────────
//
// The difference is not small: a 25-message planning pass over a 220 k context reads ~5.4 M cached
// tokens and creates ~129 k new ones. Both are printed. The second is the one that belongs in the
// plan, because a cache read is the *same* context being re-sent rather than new work, and
// `BatchResult.stats.claude_tokens.planning` is compared against a worker count of zero — a 5.5 M
// there would say planning processed 5.5 M distinct tokens, which it did not. `total` is kept in the
// output so nobody has to take that on trust.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/**
 * Claude Code's own directory naming, which replaces more than the separator.
 *
 * Defect 3, and it was in `BACKLOG.md` unfixed: the old version replaced `/` alone, so any project
 * path containing an underscore or a dot resolved to a directory that does not exist and the script
 * exited ENOENT. Verified against this machine's own `~/.claude/projects/`: a path segment
 * `FOO_BAR` is written `FOO-BAR`, and a worktree under `.claude` is written `-claude`. A planner told
 * to run this from inside a project whose path has an underscore got a stack trace where it expected
 * a number.
 */
const slug = (dir) => dir.replace(/[/_.]/g, "-");

const sessionsDir = () => join(homedir(), ".claude", "projects", slug(process.cwd()));

const byNewest = (dir, names) => names
  .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
  .sort((a, b) => b.at - a.at)
  .map((x) => x.f);

/** The transcript written most recently — this session, when run from inside it. */
function newestTranscript(dir) {
  const files = byNewest(dir, readdirSync(dir).filter((f) => f.endsWith(".jsonl")));
  if (files.length === 0) throw new Error(`no session transcript in ${dir}`);
  return join(dir, files[0]);
}

/** The session id a `<id>.jsonl` belongs to — the same id names its subagents' directory. */
const sessionIdOf = (path) => basename(path).replace(/\.jsonl$/, "");

/**
 * Every subagent transcript under one session, newest first, each with what the harness recorded
 * about it. The `.meta.json` beside it carries `agentType`, `description` and `model`, which is what
 * lets a reader tell a planner run from a search — a number whose provenance is ambiguous is the
 * thing this whole file is about.
 */
function subagents(dir, sessionId) {
  const sub = join(dir, sessionId, "subagents");
  if (!existsSync(sub)) return [];
  return byNewest(sub, readdirSync(sub).filter((f) => f.endsWith(".jsonl"))).map((f) => {
    const path = join(sub, f);
    let meta = {};
    const metaPath = path.replace(/\.jsonl$/, ".meta.json");
    if (existsSync(metaPath)) {
      try { meta = JSON.parse(readFileSync(metaPath, "utf8")); } catch { /* absent or half-written */ }
    }
    return {
      id: basename(f, ".jsonl"),
      path,
      agent_type: meta.agentType ?? null,
      description: meta.description ?? null,
      model: meta.model ?? null,
    };
  });
}

/**
 * One usage block per assistant message, in order, **deduplicated**.
 *
 * Defect 2 above. The last record per `message.id` wins; entries with no id fall back to the line's
 * own uuid so nothing is silently dropped. The assertion is the important half: if the harness ever
 * starts writing the complete record first, this would quietly under-count and no test would fail.
 */
function usages(path) {
  const order = [];
  const byId = new Map();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const u = entry?.message?.usage;
      if (!u) continue;
      const id = entry.message.id ?? entry.uuid ?? `#${order.length}`;
      if (!byId.has(id)) order.push(id);
      const seen = byId.get(id);
      if (seen !== undefined && (u.output_tokens ?? 0) < (seen.output_tokens ?? 0)) {
        throw new Error(
          `${path}: message ${id} records a later usage block smaller than an earlier one ` +
          `(${u.output_tokens} < ${seen.output_tokens}). The de-duplication rule assumed the last ` +
          "record is the complete one, which held in 4,712 of 4,712 messages on 19 Sep 2026. Re-derive it.",
        );
      }
      byId.set(id, u);
    } catch (e) {
      // A partially written last line is normal while the session is live; a rule violation is not.
      if (e instanceof Error && e.message.includes("de-duplication rule")) throw e;
    }
  }
  return order.map((id) => byId.get(id));
}

const sum = (list) => list.reduce((t, u) => ({
  input: t.input + (u.input_tokens ?? 0),
  output: t.output + (u.output_tokens ?? 0),
  cache_creation: t.cache_creation + (u.cache_creation_input_tokens ?? 0),
  cache_read: t.cache_read + (u.cache_read_input_tokens ?? 0),
}), { input: 0, output: 0, cache_creation: 0, cache_read: 0 });

const totals = (window) => {
  const t = sum(window);
  return {
    messages: window.length,
    ...t,
    // Everything, including context re-read from cache. Reported for completeness.
    total: t.input + t.output + t.cache_creation + t.cache_read,
    // What goes in `meta.planner_tokens`: new tokens only — read, created, and written.
    total_excluding_cache_reads: t.input + t.output + t.cache_creation,
  };
};

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : (args[at + 1] ?? "");
};
const emit = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

const dir = sessionsDir();
const parent = flag("--file") ?? (flag("--session") ? join(dir, `${flag("--session")}.jsonl`) : newestTranscript(dir));
const sessionId = sessionIdOf(parent);

if (args.includes("--list")) {
  const found = subagents(dir, sessionId);
  emit({
    session: sessionId,
    parent_transcript: parent,
    subagents: found.length,
    // No usage totals here on purpose: listing is for choosing, and printing a number beside every row
    // invites summing the wrong subset of them by eye.
    agents: found.map(({ path: _p, ...rest }) => rest),
  });
} else if (args.includes("--agents") || flag("--agent") !== undefined) {
  const found = subagents(dir, sessionId);
  const want = flag("--agent");
  const chosen = want === undefined
    ? found
    : found.filter((a) => a.id === want || a.id === `agent-${want}`);
  if (chosen.length === 0) {
    throw new Error(
      want === undefined
        ? `no subagent transcripts under ${join(dir, sessionId, "subagents")} — this session spawned none`
        : `no subagent ${want} under ${join(dir, sessionId, "subagents")} — run --list`,
    );
  }
  const per = chosen.map((a) => ({ ...a, ...totals(usages(a.path)) }));
  emit({
    session: sessionId,
    // Which transcripts were summed, named individually. A total whose provenance is a count rather
    // than a list is exactly the number this script was rewritten to stop producing.
    transcripts: per.map((a) => a.path),
    agents: per.map(({ path: _p, ...rest }) => rest),
    combined: totals(chosen.flatMap((a) => usages(a.path))),
  });
} else {
  const all = usages(parent);
  if (args.includes("--mark")) {
    // Counts are over DE-DUPLICATED messages, so a mark taken before 19 Sep 2026 does not compare
    // with a `--since` taken after it. Re-mark rather than reconcile.
    emit({ transcript: parent, messages: all.length });
  } else {
    const since = Number(flag("--since") ?? 0) || 0;
    emit({ transcript: parent, since, ...totals(all.slice(since)) });
  }
}
