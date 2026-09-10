import { defineConfig } from "vitest/config";

// Scoped deliberately: the verifier runs one generated test file at a time, so the config must not
// assume a suite-wide run.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
