#!/usr/bin/env python3
"""What a planner transcript cost in dollars, by token class (ADR-0091 tier 0; V1-CHALLENGES §11 item 1).

    python3 scripts/planner-dollars.py <transcript.jsonl>[:N] [...] [--json]

`planner-tokens.mjs` and `planner-decompose.py` count tokens, and a token count prices an output token and a
cache read the same although they are billed 100x apart on Opus 5.5 ($20 vs $0.20 per million). This prices
each class at the rate of the model that produced it, read from the transcript itself:

  input            uncached input
  cache_write_5m   1.25 x input      cache_write_1h   2 x input
  cache_read       0.1 x input on Opus 5 / Sonnet / Haiku, 0.05 x on Opus 5.5 ($0.20)
  output           includes thinking, which is billed as output

Rates are Anthropic's first-party list prices as cached by the claude-api reference on 25 Sep 2026; change
`RATES` if they move, and say so beside any number. Messages are de-duplicated by `message.id`, keeping the
last record (the 19 Sep amendment). `:N` after a path adds dollars per planned task.

`alone` adds back what a pass launched on its own would have paid for the harness another pass had cached
for it (25 Sep's parallel launch; `prompts/phase-14d-retrieval.md`, note of ~00:20): the first message's
cache read, re-priced as a 5-minute cache write. Prints aggregates only — never a line of a transcript.
"""
import json
import sys

RATES = {  # $ per million tokens: input, output, cache read
    "claude-opus-5-5": (4.00, 20.00, 0.20),
    "claude-opus-5": (5.00, 25.00, 0.50),
    "claude-opus-4-8": (5.00, 25.00, 0.50),
    "claude-sonnet-5": (2.00, 10.00, 0.20),
    "claude-haiku-4-5": (1.00, 5.00, 0.10),
}


def price(path):
    usage, model_of = {}, {}
    for line in open(path):
        e = json.loads(line)
        if e.get("type") != "assistant":
            continue
        m = e["message"]
        usage[m["id"]] = m.get("usage", {})
        model_of[m["id"]] = m.get("model")
    order = list(usage)
    models = {model_of[i] for i in order}
    if len(models) != 1 or next(iter(models)) not in RATES:
        raise SystemExit(f"{path}: model(s) {models} — add a rate to RATES before pricing")
    model = next(iter(models))
    rin, rout, rread = RATES[model]
    t = {"input": 0, "cache_write_5m": 0, "cache_write_1h": 0, "cache_read": 0, "output": 0, "thinking": 0}
    for u in usage.values():
        cc = u.get("cache_creation") or {}
        w5 = cc.get("ephemeral_5m_input_tokens")
        w1 = cc.get("ephemeral_1h_input_tokens")
        if w5 is None and w1 is None:  # an older transcript without the split: count it all as 5-minute
            w5, w1 = u.get("cache_creation_input_tokens", 0) or 0, 0
        t["input"] += u.get("input_tokens", 0) or 0
        t["cache_write_5m"] += w5 or 0
        t["cache_write_1h"] += w1 or 0
        t["cache_read"] += u.get("cache_read_input_tokens", 0) or 0
        t["output"] += u.get("output_tokens", 0) or 0
        t["thinking"] += (u.get("output_tokens_details") or {}).get("thinking_tokens", 0) or 0
    dollars = {
        "input": t["input"] * rin / 1e6,
        "cache_write": (t["cache_write_5m"] * 1.25 + t["cache_write_1h"] * 2.0) * rin / 1e6,
        "cache_read": t["cache_read"] * rread / 1e6,
        "output": t["output"] * rout / 1e6,
    }
    total = sum(dollars.values())
    shared = usage[order[0]].get("cache_read_input_tokens", 0) or 0
    alone = total + shared * (1.25 * rin - rread) / 1e6
    return {"model": model, "messages": len(order), "tokens": t, "dollars": {k: round(v, 4) for k, v in dollars.items()},
            "total": round(total, 4), "alone": round(alone, 4),
            "output_share_of_dollars": round(dollars["output"] / total, 3) if total else None}


def main(argv):
    as_json = "--json" in argv
    out = {}
    for arg in (a for a in argv if not a.startswith("--")):
        path, _, n = arg.partition(":")
        r = price(path)
        if n:
            r["N"] = int(n)
            r["per_task"] = round(r["total"] / int(n), 4)
            r["per_task_alone"] = round(r["alone"] / int(n), 4)
        name = path.rsplit("/", 1)[-1]
        out[name] = r
        if not as_json:
            d = r["dollars"]
            print(f"{name}  {r['model']}  ${r['total']:.2f} (alone ${r['alone']:.2f})"
                  + (f"  N={r['N']}  ${r['per_task_alone']:.3f}/task alone" if n else ""))
            print(f"   output ${d['output']:.2f} ({100 * (r['output_share_of_dollars'] or 0):.0f} %) · cache write ${d['cache_write']:.2f}"
                  f" · cache read ${d['cache_read']:.2f} · input ${d['input']:.3f} · thinking tokens {r['tokens']['thinking']:,}")
    if as_json:
        print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main(sys.argv[1:])
