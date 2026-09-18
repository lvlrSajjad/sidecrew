# Stryker loads no plugins under pnpm — reproduced in six files

**Measured 15 Sep 2026**, Apple M2 Pro / 32 GB / macOS 26.6.2, node v20.20.0, pnpm 8.15.8,
`@stryker-mutator/*` 8.7.1. Behind ADR-0036.

The project-b trial (ADR-0030) found that Stryker loads none of its own plugins under pnpm and could not
explain why: the plugins were installed, they were visible in `node_modules/@stryker-mutator/`, and adding
`public-hoist-pattern[]=@stryker-mutator/*` did not help. This reproduces it away from that project, on a
six-file package, and the mechanism explains the thing that made no sense.

## Recipe

```
mkdir repro && cd repro
# src/strings.ts, tsconfig.json, jest.config.js copied from fixtures/jest-fixture
# test/boundary.test.ts copied from fixtures/jest-fixture/legitimate/boundary.test.ts
pnpm add -D @stryker-mutator/core@8.7.1 @stryker-mutator/jest-runner@8.7.1 \
  @stryker-mutator/typescript-checker@8.7.1 jest ts-jest typescript @types/jest @types/node @jest/globals
```

Then drive it through `verifyTs` with `runner: "jest"`.

## What the layout looks like

```
node_modules/@stryker-mutator/              core  jest-runner  typescript-checker   ← symlinks
node_modules/.pnpm/@stryker-mutator+core@8.7.1/node_modules/@stryker-mutator/
                                            api  core  instrumenter  util          ← where core really is
```

`@stryker-mutator/core/dist/src/di/plugin-loader.js`:

```js
const pluginDirectory = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)), org);
```

Five levels up from that file is the `node_modules` **core itself is installed under**, not the project's.
Under npm or yarn those are the same directory. Under pnpm they are not, and the second listing above is
what gets `readdir`'d: no runner, no checker.

**This is why hoisting did not help.** The glob never looks at the project's `node_modules`.

Naming the plugins as bare specifiers does not help either — `importModule` is `import(name)` from inside
core, and pnpm refuses a package core does not declare. Only `path.isAbsolute(expr)` takes the branch that
becomes a `file://` URL.

## Before

```
WARN OptionsValidator Unknown stryker config option "jest".
  * You might be missing a plugin … Stryker loaded plugins from: ["@stryker-mutator/*"]
ERROR Stryker Could not inject [class CheckerWorker].
  Cause: Cannot find Checker plugin "typescript". In fact, no Checker plugins were loaded.
```

Identical, word for word, to what the project-b trial saw on 576,606 lines of React.

## After

With `plugins` naming both by absolute path, read from each package's own manifest:

| | |
|---|---|
| verdict | `stage_reached: "done"`, survived |
| mutation | `score 0.7 · killed 5 · survived 3 · timeout 2 · no_coverage 0` |
| killed_ids | `["2","6","7","8","10"]` |

**The same verdict, down to the mutant ids, as the hoisted jest fixture** — and as the hoisted fixture with
ts-jest's diagnostics left on. Three layouts, one answer.

## Two things this surfaced that are not fixed

Under a strict layout the candidate's own imports stop resolving unless the project declares them:

```
test/…test.ts(2,38): error TS2307: Cannot find module '@jest/globals'
error TS2688: Cannot find type definition file for 'node'
```

Both are the project's dependency hygiene rather than sidecrew's, and both reach the verdict looking
exactly like a candidate that does not compile. In BACKLOG.

## What this does not say

Six files is not project-b. No Vite, no path aliases, no 763-test suite, no 2,800 files. It reproduces
the *mechanism* and shows the fix clears it; it does not show that project now runs.
