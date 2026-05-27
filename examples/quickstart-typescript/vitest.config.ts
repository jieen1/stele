import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Include Stele-generated test files (test_*.ts) alongside standard *.test.ts
    include: ["tests/**/{test_*,*.test}.ts", "tests/**/*.spec.ts"],
    setupFiles: ["tests/contract/_stele_setup.ts"],
  },
});
