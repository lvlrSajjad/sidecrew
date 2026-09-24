#!/usr/bin/env python3
"""Where a planner's new tokens went: harness, reading, or its own output (ADR-0090 §1).

    python3 scripts/planner-decompose.py <subagent transcript.jsonl> [...] [--json]

`scripts/planner-tokens.mjs` says how much a planner spent; this says on what. It splits
`total_excluding_cache_reads` — the P_total `experiments/planner-cost/` §4 is stated in — into three
terms that add back up to it:

  harness   the first message's cache write: system prompt, tool definitions, the planner's brief.
            Paid once, before the planner has read anything.
  reading   every later cache write minus the previous message's own output: what tool results added
            to the context. Attributed to the tool call that produced it, pro rata by characters when
            one gap holds several results.
  output    output tokens, visible and thinking alike. **It is paid twice under P_total**: once as
            output, and again as a cache write when the next message re-sends it.

So `P_total ≈ harness + reading + 2 × output`, and the script prints the residual so nobody has to trust
the identity. Messages are de-duplicated by `message.id` keeping the last record, which is
`planner-tokens.mjs`'s rule (the 19 Sep amendment, defect 2).

**Prints aggregates only** — counts, token sums, tool classes. Never a command, a path or a line of a
tool result, because a planner transcript quotes the project it planned (CLAUDE.md #7).
"""
import collections
import json
import re
import sys

HEREDOC = re.compile(r"<<-?\s*'?(\w+)'?.*?\n\1\b", re.S)
SEGMENT = re.compile(r"\|\||&&|[|;\n()]")

# By program, never by substring: a scratchpad path contains this project's name, and the first version
# of this script filed every ad-hoc analysis script run from one under "sidecrew" (ADR-0090 §1, corrected).
PROGRAMS = [
    ("sidecrew", lambda prog, seg: prog == "sidecrew" or re.search(r"(dist/cli\.js|src/cli\.ts)\b", seg) is not None),
    ("tsc", lambda prog, seg: prog == "tsc" or re.match(r"npx\s+(--no-install\s+)?tsc\b", seg) is not None),
    ("script", lambda prog, seg: prog in ("node", "npx", "tsx", "python", "python3", "bun", "deno")),
    ("grep", lambda prog, seg: prog in ("grep", "rg", "ag", "egrep")),
    ("listing", lambda prog, seg: prog in ("ls", "wc", "find", "du", "stat", "tree")),
    ("file-read", lambda prog, seg: prog in ("cat", "sed", "head", "tail", "awk", "less")),
    ("git", lambda prog, seg: prog == "git"),
]
SKIP = {"cd", "export", "echo", "set", "mkdir", "rm", "sleep", "true", "for", "do", "done", "if", "then", "fi", "until", "while"}


def classify(name, inp):
    if name == "Read":
        return "file-read"
    if name in ("Grep", "Glob"):
        return "grep" if name == "Grep" else "listing"
    if name != "Bash":
        return "other"
    command = HEREDOC.sub(" ", inp.get("command", ""))
    found = []
    for seg in SEGMENT.split(command):
        seg = seg.strip()
        words = [w for w in seg.split() if "=" not in w.split("/")[0]]
        if not words or words[0] in SKIP:
            continue
        prog = words[0].rsplit("/", 1)[-1]
        for rank, (label, test) in enumerate(PROGRAMS):
            if test(prog, seg):
                found.append((rank, label))
                break
    # A heredoc that writes a script and then runs it is the script; the highest-priority program wins.
    return min(found)[1] if found else "other"


RETRIEVAL_TOOL = re.compile(r"^mcp__\w*sidecrew\w*__sidecrew_(recon|query|read)$")
RETRIEVAL_CLI = re.compile(r"(\bsidecrew|dist/cli\.js|src/cli\.ts)\s+(recon|query|read)\b")


def is_retrieval(name, inp):
    """A call to ADR-0090's retrieval tools. A base-arm transcript with any is void (phase-14d prompt, note)."""
    if RETRIEVAL_TOOL.match(name):
        return True
    return name == "Bash" and RETRIEVAL_CLI.search(HEREDOC.sub(" ", inp.get("command", ""))) is not None


def chars(content):
    if isinstance(content, str):
        return len(content)
    return sum(len(x.get("text", "")) for x in (content or []) if isinstance(x, dict))


def decompose(path):
    order, usage, uses = [], {}, {}
    retrieval = 0
    gap = collections.defaultdict(list)
    current = None
    for line in open(path):
        entry = json.loads(line)
        message = entry.get("message") or {}
        if entry.get("type") == "assistant":
            mid = message["id"]
            if mid not in usage:
                order.append(mid)
            usage[mid] = message.get("usage", {})
            current = mid
            for block in message.get("content", []):
                if block.get("type") == "tool_use":
                    uses[block["id"]] = classify(block["name"], block.get("input", {}))
                    retrieval += is_retrieval(block["name"], block.get("input", {}))
        elif entry.get("type") == "user" and current and isinstance(message.get("content"), list):
            for block in message["content"]:
                if block.get("type") == "tool_result":
                    gap[current].append((uses.get(block["tool_use_id"], "other"), chars(block.get("content"))))

    get = lambda u, k: u.get(k, 0) or 0
    p_total = sum(get(u, "input_tokens") + get(u, "output_tokens") + get(u, "cache_creation_input_tokens") for u in usage.values())
    output = sum(get(u, "output_tokens") for u in usage.values())
    harness = get(usage[order[0]], "cache_creation_input_tokens") + get(usage[order[0]], "input_tokens")
    reading = collections.Counter()
    for a, b in zip(order, order[1:]):
        added = get(usage[b], "cache_creation_input_tokens") + get(usage[b], "input_tokens") - get(usage[a], "output_tokens")
        items = gap[a]
        total = sum(n for _, n in items)
        if total == 0:
            reading["(no tool result)"] += added
            continue
        for label, n in items:
            reading[label] += added * n / total
    read_total = sum(reading.values())
    return {
        "messages": len(order),
        "P_total": p_total,
        "harness": harness,
        "reading": round(read_total),
        "output": output,
        "output_counted_twice": 2 * output,
        "residual": round(p_total - harness - read_total - 2 * output),
        "reading_by_tool": {k: round(v) for k, v in reading.most_common()},
        "retrieval_calls": retrieval,
    }


def main(argv):
    as_json = "--json" in argv
    paths = [a for a in argv if not a.startswith("--")]
    if not paths:
        sys.exit(__doc__)
    out = {}
    for path in paths:
        name = path.rsplit("/", 1)[-1]
        out[name] = r = decompose(path)
        if as_json:
            continue
        p = r["P_total"]
        pct = lambda v: f"{100 * v / p:5.1f} %"
        print(f"{name}  P_total {p:,}  ({r['messages']} messages)")
        print(f"  harness            {r['harness']:>9,}  {pct(r['harness'])}")
        print(f"  reading            {r['reading']:>9,}  {pct(r['reading'])}")
        print(f"  output × 2         {r['output_counted_twice']:>9,}  {pct(r['output_counted_twice'])}   (output {r['output']:,})")
        print(f"  residual           {r['residual']:>9,}")
        print(f"  retrieval calls    {r['retrieval_calls']:>9,}   (a base-arm transcript must have 0, or it is void)")
        for label, v in r["reading_by_tool"].items():
            print(f"    reading: {label:16s} {v:>8,}  {100 * v / max(r['reading'], 1):5.1f} % of reading")
    if as_json:
        print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main(sys.argv[1:])
