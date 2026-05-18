import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "backend-registry": "src/backend-registry.ts",
    "architecture-runtime": "src/architecture-runtime.ts",
  },
  format: "esm",
  dts: true,
  clean: true,
  external: ["typescript", "typescript/lib/typescript"],
});
