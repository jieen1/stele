import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  dts: true,
  clean: true,
  external: [
    "typescript",
    "typescript/lib/typescript",
    "@stele/core",
    "@stele/call-graph-core",
    "@stele/type-state-evaluator",
  ],
});
