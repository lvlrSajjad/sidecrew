import { defineConfig } from "vitest/config";

// The whole suite, unlike ts-fixture's config: workload #2a runs the project's own tests as the gate,
// so the runner has to be asked for all of them rather than for one generated file.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
