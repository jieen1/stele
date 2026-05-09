import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["runner.ts"],
    // Conformance tests spawn `node` + the compiled CLI per fixture and
    // optionally run pytest. Each step can take a few seconds; allow ample
    // headroom while staying well below CI default budgets.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    globals: false,
    isolate: true,
  },
});
