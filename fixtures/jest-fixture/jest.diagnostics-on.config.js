/**
 * The same config as `jest.config.js` with ts-jest left at **its own default**: type-checking on.
 *
 * This is what a stock NestJS project looks like, and before ADR-0036 it was unmutatable — ts-jest
 * type-checks Stryker's instrumentation and the dry run dies with a page of errors about code nobody
 * wrote. ADR-0028 discovered that and told the project to fix itself; two project-a trials then showed
 * what that costs, and the only one that produced a number had to edit the project to get it.
 *
 * It exists so the blocker is reproduced **here**, on a fixture, rather than only on somebody's private
 * repo — `verifier-jest.slow.test.ts` drives it, and the assertion is that the verdict through this
 * config is identical to the verdict through `jest.config.js`.
 */
module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", {}],
  },
  testMatch: ["<rootDir>/test/**/*.test.ts", "<rootDir>/legitimate/**/*.test.ts"],
  testPathIgnorePatterns: ["/node_modules/"],
};
