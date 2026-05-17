import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/bin/mcp-server.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  external: ["@stele/core", "@modelcontextprotocol/sdk"],
  treeshake: true,
  splitting: true,
  minify: false,
  minifyImports: true,
  keepNames: true,
  noExternal: ["@stele/mcp-server"],
});
