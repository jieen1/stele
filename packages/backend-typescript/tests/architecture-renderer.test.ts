import { describe, expect, it } from "vitest";
import {
  renderArchitectureTest,
  toMinimalArchitecture,
} from "../src/architecture-renderer.js";
import type { ArchitectureDeclaration, SourceSpan } from "@stele/core";

const EMPTY_SPAN: SourceSpan = { file: "", line: 0, column: 0 };

function createArchitecture(overrides: Partial<ArchitectureDeclaration> = {}): ArchitectureDeclaration {
  return {
    kind: "architecture",
    filePath: "main.stele",
    node: {} as ArchitectureDeclaration["node"],
    span: EMPTY_SPAN,
    id: "core-arch",
    lang: "typescript",
    description: "Core architecture",
    modules: [
      { id: "api", paths: ["src/api/**"], publicEntries: [], span: EMPTY_SPAN },
      { id: "core", paths: ["src/core/**"], publicEntries: [], span: EMPTY_SPAN },
      { id: "infra", paths: ["src/infra/**"], publicEntries: [], span: EMPTY_SPAN },
    ],
    layers: [],
    allowDependencies: [
      { from: "api", to: ["core"], span: EMPTY_SPAN },
      { from: "core", to: ["infra"], span: EMPTY_SPAN },
    ],
    denyCycles: true,
    ...overrides,
  };
}

describe("toMinimalArchitecture", () => {
  it("strips span/publicEntries from modules", () => {
    const arch = createArchitecture();
    const minimal = toMinimalArchitecture(arch);

    expect(minimal.id).toBe("core-arch");
    expect(minimal.modules).toEqual([
      { id: "api", paths: ["src/api/**"] },
      { id: "core", paths: ["src/core/**"] },
      { id: "infra", paths: ["src/infra/**"] },
    ]);
    expect(minimal.allowDependencies).toEqual([
      { from: "api", to: ["core"] },
      { from: "core", to: ["infra"] },
    ]);
    expect(minimal.denyCycles).toBe(true);
  });

  it("preserves denyCycles: false", () => {
    const arch = createArchitecture({ denyCycles: false });
    expect(toMinimalArchitecture(arch).denyCycles).toBe(false);
  });

  it("handles empty module list", () => {
    const arch = createArchitecture({
      modules: [],
      allowDependencies: [],
    });
    const minimal = toMinimalArchitecture(arch);
    expect(minimal.modules).toEqual([]);
    expect(minimal.allowDependencies).toEqual([]);
  });
});

describe("renderArchitectureTest", () => {
  it("renders a complete test file with vitest imports", () => {
    const minimal = toMinimalArchitecture(createArchitecture());
    const source = renderArchitectureTest({ architecture: minimal });

    expect(source).toMatch(/^import { describe, test, expect } from "vitest";/m);
    expect(source).toMatch(/import { evaluateArchitectureContract } from/m);
    expect(source).toContain('describe("Architecture: core-arch"');
    expect(source).toContain('test("architecture constraints are satisfied", async () => {');
  });

  it("embeds the architecture definition as a JSON object", () => {
    const minimal = toMinimalArchitecture(
      createArchitecture({
        modules: [{ id: "auth", paths: ["src/auth/**"], publicEntries: [], span: EMPTY_SPAN }],
        allowDependencies: [],
      }),
    );
    const source = renderArchitectureTest({ architecture: minimal });

    expect(source).toContain('"id": "auth"');
    expect(source).toContain('"src/auth/**"');
  });

  it("includes denyCycles in the embedded definition", () => {
    const minimal = toMinimalArchitecture(
      createArchitecture({ denyCycles: false }),
    );
    const source = renderArchitectureTest({ architecture: minimal });

    expect(source).toContain('"denyCycles": false');
  });

  it("computes projectRoot from the test file location", () => {
    const minimal = toMinimalArchitecture(createArchitecture());
    const source = renderArchitectureTest({ architecture: minimal });

    expect(source).toContain('__projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")');
  });

  it("formats violation details on failure", () => {
    const minimal = toMinimalArchitecture(createArchitecture());
    const source = renderArchitectureTest({ architecture: minimal });

    expect(source).toContain("if (violations.length > 0) {");
    expect(source).toContain(
      'expect(violations.length, "Found architecture violations:',
    );
  });

  it("renders with custom runtime import path", () => {
    const minimal = toMinimalArchitecture(createArchitecture());
    const source = renderArchitectureTest({
      architecture: minimal,
      runtimeImportPath: "./my-runtime.js",
    });

    expect(source).toContain('from "./my-runtime.js"');
  });

  it("handles architecture with multiple allowDependencies", () => {
    const minimal = toMinimalArchitecture(
      createArchitecture({
        allowDependencies: [
          { from: "a", to: ["b", "c"], span: EMPTY_SPAN },
          { from: "d", to: ["e"], span: EMPTY_SPAN },
        ],
      }),
    );
    const source = renderArchitectureTest({ architecture: minimal });

    expect(source).toContain('"from": "a"');
    expect(source).toContain('"b"');
    expect(source).toContain('"c"');
    expect(source).toContain('"from": "d"');
  });

  it("generates balanced braces and parens", () => {
    const minimal = toMinimalArchitecture(createArchitecture());
    const source = renderArchitectureTest({ architecture: minimal });

    const openBraces = (source.match(/{/g) || []).length;
    const closeBraces = (source.match(/}/g) || []).length;
    expect(openBraces).toBe(closeBraces);

    const openParens = (source.match(/\(/g) || []).length;
    const closeParens = (source.match(/\)/g) || []).length;
    expect(openParens).toBe(closeParens);
  });
});
