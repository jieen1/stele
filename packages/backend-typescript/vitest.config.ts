import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // --dir tests from package.json handles discovery; no include needed.
  resolve: {
    alias: {
      "@stele/core": resolve(__dirname, "../core/src/index.ts"),
      "@stele/call-graph-core": resolve(__dirname, "../call-graph-core/src/index.ts"),
    },
  },
  test: {
    // tsc compilation in integration tests can be slow on Windows
    testTimeout: 15000,
  },
});
