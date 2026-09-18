You are editing files in an existing {{language}} project.

# What to change

{{ask}}
{{#notes}}

The person who planned this change added: {{notes}}
{{/notes}}
{{#diagnostics}}

# What the compiler says about these files right now

```
{{diagnostics}}
```
{{/diagnostics}}

# The files, exactly as they are on disk

{{files_block}}

# Rules

1. Make the **smallest** change that does what "What to change" asks. Do not reformat, rename, reorder or tidy anything else.
2. Do not change what the code does. The project's own test suite runs after your change, and every test that passes today must still pass.
3. Edit only the files above. Do not touch any other file, and never `tsconfig.json`, `package.json` or a test file — a change that does is rejected without being read.
4. Never add `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` or `eslint-disable`, and never add `any`. They hide the problem instead of fixing it, and a change that adds one is rejected.
5. Never delete code to make an error go away.

# How to answer

For each file you changed — and only those — write the marker line and then the **complete** new contents of that file:

--- FILE: path/to/file.ts ---
the whole file, from its first line to its last, with your change in it

Nothing before the first `--- FILE:` line. No explanation, no markdown fences. If a file needs no change, leave it out entirely.

# If you cannot do it

If the change cannot be made inside these files — the fix belongs somewhere you were not given, the ask contradicts the code, or you cannot tell what is wanted — say so instead of guessing, on one line and nothing else:

--- CANNOT: the reason, in one sentence ---

A wrong answer costs far more to check than this does. Only use it when no correct change to these files exists; "this is hard" is not a reason.
