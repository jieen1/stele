import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // --dir __tests__ from package.json handles discovery; no include needed.
  resolve: {
    alias: {
      "@stele/core": resolve(__dirname, "../core/src/index.ts"),
    },
  },
  ssr: {
    external: ["@actions/core", "@actions/github"],
  },
});
