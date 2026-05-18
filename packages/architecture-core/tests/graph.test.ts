import { describe, expect, it } from "vitest";
import { buildFileToModuleMap, moduleBelongsToModule } from "../src/graph.js";
import type { ArchitectureModuleDeclaration } from "../src/types.js";

function makeModule(id: string, paths: string[]): ArchitectureModuleDeclaration {
  return {
    id,
    paths,
    publicEntries: [],
    span: { file: "test.stele", line: 1, column: 1 },
  };
}

describe("moduleBelongsToModule", () => {
  it("matches exact path patterns", () => {
    const modules = [makeModule("api", ["src/api"])]
    const result = moduleBelongsToModule("src/api", modules);
    expect(result?.id).toBe("api");
  });

  it("matches glob patterns with **", () => {
    const modules = [makeModule("api", ["src/api/**"])];
    const result = moduleBelongsToModule("src/api/services/user.ts", modules);
    expect(result?.id).toBe("api");
  });

  it("matches glob patterns with *", () => {
    const modules = [makeModule("api", ["src/api/*"])];
    const result = moduleBelongsToModule("src/api/index.ts", modules);
    expect(result?.id).toBe("api");
  });

  it("returns null for non-matching files", () => {
    const modules = [makeModule("api", ["src/api/**"])];
    const result = moduleBelongsToModule("src/domain/model.ts", modules);
    expect(result).toBeNull();
  });

  it("returns the first matching module when multiple match", () => {
    const modules = [
      makeModule("broad", ["src/**"]),
      makeModule("specific", ["src/domain/**"]),
    ];
    const result = moduleBelongsToModule("src/domain/model.ts", modules);
    expect(result?.id).toBe("broad");
  });
});

describe("buildFileToModuleMap", () => {
  it("assigns files to modules based on path patterns", () => {
    const modules = [
      makeModule("api", ["src/api/**"]),
      makeModule("domain", ["src/domain/**"]),
    ];
    const files = [
      "src/api/routes.ts",
      "src/domain/model.ts",
    ];

    const { fileToModule, unownedFiles, ambiguousFiles } = buildFileToModuleMap(modules, files);
    expect(fileToModule.get("src/api/routes.ts")).toBe("api");
    expect(fileToModule.get("src/domain/model.ts")).toBe("domain");
    expect(unownedFiles).toEqual([]);
    expect(ambiguousFiles).toEqual([]);
  });

  it("reports unowned files that match no module", () => {
    const modules = [makeModule("api", ["src/api/**"])];
    const files = ["src/api/routes.ts", "src/unknown/index.ts"];

    const { fileToModule, unownedFiles } = buildFileToModuleMap(modules, files);
    expect(fileToModule.size).toBe(1);
    expect(unownedFiles).toContain("src/unknown/index.ts");
  });

  it("reports ambiguous files claimed by multiple modules", () => {
    const modules = [
      makeModule("broad", ["src/**"]),
      makeModule("api", ["src/api/**"]),
    ];
    const files = ["src/api/routes.ts"];

    const { fileToModule, ambiguousFiles } = buildFileToModuleMap(modules, files);
    expect(fileToModule.get("src/api/routes.ts")).toBe("broad");
    expect(ambiguousFiles).toHaveLength(1);
    expect(ambiguousFiles[0].file).toBe("src/api/routes.ts");
    expect(ambiguousFiles[0].modules).toContain("broad");
    expect(ambiguousFiles[0].modules).toContain("api");
  });

  it("handles empty file list", () => {
    const modules = [makeModule("api", ["src/api/**"])];
    const result = buildFileToModuleMap(modules, []);
    expect(result.fileToModule.size).toBe(0);
    expect(result.unownedFiles).toEqual([]);
    expect(result.ambiguousFiles).toEqual([]);
  });
});
