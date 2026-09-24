You are reading source files to answer one question for the engineer who is planning a change. You do not change anything. You report what the files say, and you prove each point by quoting the file.

# The question

{{question}}

# The files, with line numbers

Each line is shown as `NUMBER| text`. The number and the `| ` are not part of the file.

{{files_block}}

# How to answer

Answer with **one JSON object and nothing else**, in this shape:

```json
{"claims": [{"claim": "one sentence that answers part of the question", "cite": [{"file": "path/as/shown.ts", "lines": [12, 14], "quote": "text copied exactly from those lines"}]}]}
```

Rules — an answer that breaks one is thrown away, so follow them exactly:

1. Every claim needs at least one `cite`. A claim you cannot quote is a claim nobody can check: leave it out.
2. `quote` is copied **character for character** from the lines you cite: the same spaces, the same punctuation, no `NUMBER| ` prefix, no `...`. At least {{min_quote_chars}} characters, at most {{max_quote_chars}}. Quote the part that proves the claim, not the whole block.
3. `lines` is `[first, last]`, both inclusive, and the quote must lie inside them.
4. `file` is a path exactly as shown in a `## ` heading above.
5. At most {{max_claims}} claims, each under {{max_claim_chars}} characters. Say only what answers the question.
6. If the files do not answer the question, reply `{"claims": []}`. That is a useful answer; a guess is not.
