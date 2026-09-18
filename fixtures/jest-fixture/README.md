# jest-fixture

The same pure functions as `fixtures/ts-fixture`, under **Jest** instead of Vitest (ADR-0028).

Not a second full fixture — `src/strings.ts` only, copied byte-for-byte from the Vitest one including its
planted off-by-one in `truncate`. Its whole job is to answer one question: **is the test runner a seam, or
does changing it change verdicts?**

## Measured — 15 Sep 2026

Same plan, same model (qwen2.5-coder-7b-4bit @ `019cc73c45c7`), same seed, same functions, one runner
swapped:

| | ts-fixture (Vitest) | jest-fixture (Jest) |
|---|---|---|
| survived | 3/5 | **3/5** |
| survivors | countOccurrences:happy_path 1.00 · countOccurrences:boundary 1.00 · commonPrefix:boundary 0.80 | **the same three, the same scores** |
| escalated | truncate:boundary · titleCase:happy_path | **the same two** |

The runner is a seam. Both escalations are the fixture behaving as designed: `truncate:boundary` is the
planted off-by-one, which the worker fails by asserting the *correct* answer, and `titleCase` is the
arithmetic the 7B gets wrong (Phase 6, surprise 3).

## Why this project is shaped differently on purpose

`tsconfig.json` is **CommonJS/Node**, not ts-fixture's ESNext/Bundler. If this were a copy of the Vitest
project with one field changed, it would prove the runner is a seam in a project that was already
vitest-shaped. Jest projects are usually CJS, so this one is.

`jest.config.js` runs **ts-jest in transpile-only mode**, and that is load-bearing rather than tidy — see
the comment in the file and ADR-0028. Stryker instruments the source it mutates; ts-jest type-checks by
default; ts-jest then type-checks the instrumentation and every candidate fails the run stage with a page
of errors about a file nobody wrote.

## Running it by hand

```
cd fixtures/jest-fixture && npm install
npx jest --ci --runTestsByPath legitimate/<file>.test.ts
```

`--runTestsByPath` is what the verifier uses: it takes the path literally rather than matching it against
`testMatch`, which is what lets a candidate be written wherever the plan says without the project's own
config having to agree.
