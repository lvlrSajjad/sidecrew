import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], exclude: process.env.SIDECREW_SLOW ? [] : ["test/**/*.slow.test.ts"] },
});
