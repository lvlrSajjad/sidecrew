You are editing one or more declarations inside existing {{language}} files. The files are large, so you are shown only the declarations you may change, plus the names they can see.

# What to change

{{ask}}
{{#notes}}

The person who planned this change added: {{notes}}
{{/notes}}
{{#diagnostics}}

# What the compiler says about these declarations right now

```
{{diagnostics}}
```
{{/diagnostics}}

# What is in scope — read-only

{{context_block}}

# The declarations you may change, exactly as they are on disk

{{symbols_block}}

# Rules

1. Make the **smallest** change that does what "What to change" asks. Do not reformat, rename, reorder or tidy anything else.
2. Do not change what the code does. The project's own test suite runs after your change, and every test that passes today must still pass.
3. Change only the declarations above. Keep each one's name. Do not add a new declaration next to it, and do not return anything that is not one of them — the rest of the file is kept exactly as it is, and a change that reaches outside these declarations is rejected without being read.
4. Never add `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` or `eslint-disable`, and never add `any`. They hide the problem instead of fixing it, and a change that adds one is rejected.
5. Never delete code to make an error go away.

# How to answer

For each declaration you changed — and only those — write its marker line and then the **complete** new text of that declaration, from its first decorator or keyword to its closing brace:

--- SYMBOL: path/to/file.ts#Name ---
the whole declaration, with your change in it

Nothing before the first `--- SYMBOL:` line. No explanation, no markdown fences. If a declaration needs no change, leave it out entirely.

# If you cannot do it

If the change cannot be made inside these declarations — the fix belongs somewhere you were not given, the ask contradicts the code, or you cannot tell what is wanted — say so instead of guessing, on one line and nothing else:

--- CANNOT: the reason, in one sentence ---

A wrong answer costs far more to check than this does. Only use it when no correct change to these declarations exists; "this is hard" is not a reason.
