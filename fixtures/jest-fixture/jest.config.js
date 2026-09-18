/**
 * A config *file* rather than a `jest` key in package.json, because that is the case Stryker's
 * jest-runner is passed as `configFile` and the one a real project (jest-expo, Nest) has.
 */
module.exports = {
  testEnvironment: "node",

  /**
   * ts-jest in **transpile-only** mode, and this is not a shortcut — it is the one thing that makes
   * Jest and Stryker work together at all (ADR-0028).
   *
   * ts-jest type-checks by default. Stryker instruments the source it mutates, wrapping every
   * expression in `stryMutAct_9fa48(...)` guards it declares itself, and ts-jest then type-checks *that*
   * and fails with a page of errors about a file nobody wrote — `Parameter 'id' implicitly has an 'any'
   * type`, `Cannot assign to 'stryMutAct_9fa48' because it is a function`. Every candidate comes back
   * looking like it broke the build.
   *
   * Nothing is lost by turning it off, because sidecrew type-checks in a stage of its own: `tsc
   * --noEmit` over the whole project is the compile stage, and it runs before this one ever does. The
   * mutants' type checking is Stryker's `checkers: ["typescript"]`, which is what keeps mutants that
   * cannot compile out of the denominator (ADR-0016). Two type checks remain; the redundant third is
   * the one that was breaking.
   */
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { isolatedModules: true }],
  },

  // Deliberately narrow: the candidate is written to `test/` by `tsTargetFor`, and a project whose
  // testMatch does not cover that directory is exactly the case `--runTestsByPath` exists for. Both
  // paths are exercised — the run stage bypasses this, Stryker's runner obeys it.
  testMatch: ["<rootDir>/test/**/*.test.ts", "<rootDir>/legitimate/**/*.test.ts"],
  testPathIgnorePatterns: ["/node_modules/"],
};
