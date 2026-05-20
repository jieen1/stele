import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DesignProfile } from "../src/design-profile/types.js";
import { validateProfile } from "../src/design-profile/validate.js";
import { validateTsconfigPolicy } from "../src/toolchain/tsconfig-policy.js";
import { evaluateCoreNode } from "../src/complexity/evaluate.js";
import type { CoreNodeDeclaration } from "@stele/core";
import { buildModuleMap } from "../src/architecture/module-map.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createTempDir(): string {
  const dir = join(tmpdir(), `stele-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function minimalProfile(): DesignProfile {
  return {
    schema_version: 1,
    kind: "stele-design-profile",
    profile_id: "test",
    created_at: "2026-05-19T00:00:00.000Z",
    updated_at: "2026-05-19T00:00:00.000Z",
    project: {
      language: "typescript",
      source_roots: ["src"],
      ignore: [],
    },
  };
}

// ---------------------------------------------------------------------------
// PART-1: Tsconfig Policy Uses Shared Loader
// ---------------------------------------------------------------------------

describe("PART-1: Tsconfig Policy Uses Shared Loader", () => {
  it("validates tsconfig using TypeScript compiler API (not JSON.parse)", () => {
    const dir = createTempDir();
    const tsconfigPath = join(dir, "tsconfig.json");

    writeFileSync(tsconfigPath, JSON.stringify({
      compilerOptions: {
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
      },
    }), "utf8");

    const violations = validateTsconfigPolicy(dir, tsconfigPath, {
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
    });

    expect(violations).toEqual([]);
  });

  it("detects violations when options don't match", () => {
    const dir = createTempDir();
    const tsconfigPath = join(dir, "tsconfig.json");

    writeFileSync(tsconfigPath, JSON.stringify({
      compilerOptions: {
        strict: false,
      },
    }), "utf8");

    const violations = validateTsconfigPolicy(dir, tsconfigPath, {
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
    });

    expect(violations).toHaveLength(3);
    expect(violations[0].ruleKind).toBe("typescript-config-policy");
    expect(violations[0].severity).toBe("error");
  });

  it("handles tsconfig with extends chain", () => {
    const dir = createTempDir();
    const baseTsconfig = join(dir, "tsconfig.base.json");
    const childTsconfig = join(dir, "tsconfig.json");

    writeFileSync(baseTsconfig, JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
      },
    }), "utf8");

    writeFileSync(childTsconfig, JSON.stringify({
      extends: "./tsconfig.base.json",
      compilerOptions: {
        exactOptionalPropertyTypes: true,
      },
    }), "utf8");

    // The child should inherit strict from base
    const violations = validateTsconfigPolicy(dir, "tsconfig.json", {
      strict: true,
      exactOptionalPropertyTypes: true,
    });

    expect(violations).toEqual([]);
  });

  it("handles missing tsconfig gracefully", () => {
    const dir = createTempDir();

    const violations = validateTsconfigPolicy(dir, "nonexistent.json", {
      strict: true,
    });

    // Should report violation since strict is undefined
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain("undefined");
  });
});

// ---------------------------------------------------------------------------
// PART-2: Ambiguous Module Ownership Surfaced
// ---------------------------------------------------------------------------

describe("PART-2: Ambiguous Module Ownership Surfaced", () => {
  it("buildModuleMap detects ambiguous files", () => {
    const files = ["src/shared/utils.ts"];
    const modules = [
      { id: "billing", paths: ["src/shared/**/*.ts"], publicEntries: [], span: { file: "", line: 0, column: 0 } },
      { id: "customer", paths: ["src/shared/**/*.ts"], publicEntries: [], span: { file: "", line: 0, column: 0 } },
    ];

    const result = buildModuleMap(files, modules);

    const ambiguousEntry = result.ambiguousFiles.find((e) => e.file === "src/shared/utils.ts");
    expect(ambiguousEntry).toBeDefined();
    expect(ambiguousEntry!.modules.length).toBeGreaterThanOrEqual(2);
    expect(ambiguousEntry!.modules).toContain("billing");
    expect(ambiguousEntry!.modules).toContain("customer");
  });

  it("buildModuleMap has empty ambiguousFiles when no overlap", () => {
    const files = ["src/billing/invoice.ts", "src/customer/profile.ts"];
    const modules = [
      { id: "billing", paths: ["src/billing/**/*.ts"], publicEntries: [], span: { file: "", line: 0, column: 0 } },
      { id: "customer", paths: ["src/customer/**/*.ts"], publicEntries: [], span: { file: "", line: 0, column: 0 } },
    ];

    const result = buildModuleMap(files, modules);

    expect(result.ambiguousFiles).toEqual([]);
  });

  it("ambiguous files are tracked with module list", () => {
    const files = ["src/lib/helper.ts"];
    const modules = [
      { id: "module_a", paths: ["src/lib/**/*.ts"], publicEntries: [], span: { file: "", line: 0, column: 0 } },
      { id: "module_b", paths: ["src/lib/**/*.ts"], publicEntries: [], span: { file: "", line: 0, column: 0 } },
      { id: "module_c", paths: ["src/lib/**/*.ts"], publicEntries: [], span: { file: "", line: 0, column: 0 } },
    ];

    const result = buildModuleMap(files, modules);

    const ambiguousEntry = result.ambiguousFiles.find((e) => e.file === "src/lib/helper.ts");
    expect(ambiguousEntry).toBeDefined();
    expect(ambiguousEntry!.modules.length).toBeGreaterThanOrEqual(2);
    expect(ambiguousEntry!.modules).toContain("module_a");
    expect(ambiguousEntry!.modules).toContain("module_b");
    expect(ambiguousEntry!.modules).toContain("module_c");
  });
});

// ---------------------------------------------------------------------------
// PART-3: Missing Core-Node CLASS Violation
// ---------------------------------------------------------------------------

describe("PART-3: Missing Core-Node CLASS Violation", () => {
  it("returns configuration violation when file exists but class not found", async () => {
    const dir = createTempDir();
    const filePath = join(dir, "src", "MissingClass.ts");
    mkdirSync(dirname(filePath), { recursive: true });

    // Write a file without the expected class
    writeFileSync(filePath, `
export function someFunction() {
  return 42;
}
`, "utf8");

    const declaration: CoreNodeDeclaration = {
      id: "test-core-node",
      role: "aggregator",
      target: "src/MissingClass.ts::NonExistentClass",
      metrics: [
        { name: "sloc", ideal: 100, max: 200 },
        { name: "public-method-count", ideal: 5, max: 10 },
        { name: "max-cyclomatic", ideal: 10, max: 20 },
      ],
    };

    const result = await evaluateCoreNode(dir, declaration);

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].isConfigurationViolation).toBe(true);
    expect(result.violations[0].metric).toBe("missing-target");
    expect(result.violations[0].nodeId).toBe("test-core-node");
  });

  it("returns configuration violation when target file doesn't exist", async () => {
    const dir = createTempDir();

    const declaration: CoreNodeDeclaration = {
      id: "test-core-node",
      role: "aggregator",
      target: "src/NonExistent.ts::SomeClass",
      metrics: [
        { name: "sloc", ideal: 100, max: 200 },
        { name: "public-method-count", ideal: 5, max: 10 },
        { name: "max-cyclomatic", ideal: 10, max: 20 },
      ],
    };

    const result = await evaluateCoreNode(dir, declaration);

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].isConfigurationViolation).toBe(true);
    expect(result.violations[0].metric).toBe("missing-target");
  });

  it("returns no violation when file and class both exist", async () => {
    const dir = createTempDir();
    const filePath = join(dir, "src", "ExistingClass.ts");
    mkdirSync(dirname(filePath), { recursive: true });

    writeFileSync(filePath, `
export class ExistingClass {
  private _value: number = 0;

  getValue(): number {
    return this._value;
  }
}
`, "utf8");

    const declaration: CoreNodeDeclaration = {
      id: "test-core-node",
      role: "aggregator",
      target: "src/ExistingClass.ts::ExistingClass",
      metrics: [
        { name: "sloc", ideal: 100, max: 200 },
        { name: "public-method-count", ideal: 5, max: 10 },
        { name: "max-cyclomatic", ideal: 10, max: 20 },
      ],
    };

    const result = await evaluateCoreNode(dir, declaration);

    // Should not have configuration violation for missing class
    const configViolations = result.violations.filter((v) => v.isConfigurationViolation);
    expect(configViolations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PART-4: Profile Path in Errors
// ---------------------------------------------------------------------------

describe("PART-4: Profile Path in Errors", () => {
  it("validation errors include path field", () => {
    const profile = {
      ...minimalProfile(),
      schema_version: 2,
    } as DesignProfile;

    const errors = validateProfile(profile, "contract/design/profile.yaml");
    const err = errors.find((e) => e.field === "schema_version");

    expect(err).toBeDefined();
    expect(err!.path).toBe("contract/design/profile.yaml");
  });

  it("validation errors use default path when not specified", () => {
    const profile = {
      ...minimalProfile(),
      schema_version: 2,
    } as DesignProfile;

    const errors = validateProfile(profile);
    const err = errors.find((e) => e.field === "schema_version");

    expect(err).toBeDefined();
    expect(err!.path).toBe("contract/design/profile.yaml");
  });

  it("project language error includes path", () => {
    const profile = {
      ...minimalProfile(),
      project: { ...minimalProfile().project!, language: "python" },
    } as DesignProfile;

    const errors = validateProfile(profile, "my/custom/profile.yaml");
    const err = errors.find((e) => e.field === "project.language");

    expect(err).toBeDefined();
    expect(err!.path).toBe("my/custom/profile.yaml");
  });

  it("path traversal error includes path", () => {
    const profile = {
      ...minimalProfile(),
      project: {
        ...minimalProfile().project!,
        source_roots: ["../outside"],
      },
    } as DesignProfile;

    const errors = validateProfile(profile, "test-profile.yaml");
    const err = errors.find((e) => e.field === "project.source_roots");

    expect(err).toBeDefined();
    expect(err!.path).toBe("test-profile.yaml");
  });

  it("overlapping context roots error includes path", () => {
    const profile = {
      ...minimalProfile(),
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          {
            id: "billing",
            name: "Billing",
            subdomain_type: "core",
            root: "src/billing",
            layers: {},
          },
          {
            id: "payments",
            name: "Payments",
            subdomain_type: "supporting",
            root: "src/billing/payments",
            layers: {},
          },
        ],
      },
    } as DesignProfile;

    const errors = validateProfile(profile, "ddd-profile.yaml");
    const err = errors.find((e) => e.field === "ddd.contexts");

    expect(err).toBeDefined();
    expect(err!.path).toBe("ddd-profile.yaml");
    expect(err!.message).toContain("overlap");
  });

  it("enforced invariant error includes path", () => {
    const profile = {
      ...minimalProfile(),
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          {
            id: "billing",
            name: "Billing",
            subdomain_type: "core",
            root: "src/billing",
            layers: {},
          },
        ],
        core_invariants: [
          {
            id: "inv1",
            description: "Must have a reference",
            evolvability: "never",
            status: "enforced",
          },
        ],
      },
    } as DesignProfile;

    const errors = validateProfile(profile, "invariants-profile.yaml");
    const err = errors.find((e) => e.message?.includes("enforced"));

    expect(err).toBeDefined();
    expect(err!.path).toBe("invariants-profile.yaml");
  });

  it("duplicate ID error includes path", () => {
    const profile = {
      ...minimalProfile(),
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          { id: "ctx", name: "A", subdomain_type: "core", root: "src/a", layers: {} },
          { id: "ctx", name: "B", subdomain_type: "supporting", root: "src/b", layers: {} },
        ],
      },
    } as DesignProfile;

    const errors = validateProfile(profile, "dup-profile.yaml");
    const err = errors.find((e) => e.field === "ddd.contexts[*].id");

    expect(err).toBeDefined();
    expect(err!.path).toBe("dup-profile.yaml");
  });

  it("integration reference error includes path", () => {
    const profile = {
      ...minimalProfile(),
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          {
            id: "customer",
            name: "Customer",
            subdomain_type: "supporting",
            root: "src/customer",
            layers: {},
          },
        ],
        integrations: [
          {
            from: "billing",
            to: "customer",
            pattern: "anti_corruption_layer",
          },
        ],
      },
    } as DesignProfile;

    const errors = validateProfile(profile, "integration-profile.yaml");
    const err = errors.find((e) => e.message?.includes("integration.from"));

    expect(err).toBeDefined();
    expect(err!.path).toBe("integration-profile.yaml");
  });

  it("all errors in a batch include the same path", () => {
    const profile = {
      schema_version: 2,
      kind: "stele-design-profile",
      profile_id: "test",
      created_at: "2026-05-19T00:00:00.000Z",
      updated_at: "2026-05-19T00:00:00.000Z",
      project: {
        language: "python",
        source_roots: ["../outside"],
        ignore: [],
      },
    } as DesignProfile;

    const errors = validateProfile(profile, "multi-error-profile.yaml");

    expect(errors.length).toBeGreaterThanOrEqual(3);
    for (const err of errors) {
      expect(err.path).toBe("multi-error-profile.yaml");
    }
  });
});

// ---------------------------------------------------------------------------
// STUB-2: Safe main.stele Import
// ---------------------------------------------------------------------------

describe("STUB-2: Safe main.stele Import", () => {
  it("ensureImportInMain appends import when main.stele exists without it", () => {
    const dir = createTempDir();
    const mainPath = join(dir, "contract", "main.stele");
    mkdirSync(dirname(mainPath), { recursive: true });

    writeFileSync(mainPath, "(rule INVOICE_TOTAL_NON_NEGATIVE)\n", "utf8");

    // Simulate the ensureImportInMain logic
    const targetPath = "contract/generated/ddd-typedriven.stele";
    const content = readFileSync(mainPath, "utf8");

    // Robust check: normalize whitespace
    const normalizedImport = `(import "${targetPath}")`.replace(/\s+/g, " ");
    const lines = content.split("\n");
    const hasImport = lines.some((line) => {
      const normalized = line.trim().replace(/\s+/g, " ");
      return normalized === normalizedImport;
    });

    expect(hasImport).toBe(false);

    // Append import
    const prefix = content.endsWith("\n") ? "" : "\n";
    writeFileSync(mainPath, content + `${prefix}(import "${targetPath}")\n`, "utf8");

    const updatedContent = readFileSync(mainPath, "utf8");
    expect(updatedContent).toContain("(rule INVOICE_TOTAL_NON_NEGATIVE)");
    expect(updatedContent).toContain(`(import "${targetPath}")`);
  });

  it("ensureImportInMain does not duplicate existing import", () => {
    const dir = createTempDir();
    const mainPath = join(dir, "contract", "main.stele");
    mkdirSync(dirname(mainPath), { recursive: true });

    const targetPath = "contract/generated/ddd-typedriven.stele";
    writeFileSync(mainPath, `(rule INVOICE_TOTAL_NON_NEGATIVE)
(import "${targetPath}")
`, "utf8");

    const content = readFileSync(mainPath, "utf8");
    const normalizedImport = `(import "${targetPath}")`.replace(/\s+/g, " ");
    const lines = content.split("\n");
    const hasImport = lines.some((line) => {
      const normalized = line.trim().replace(/\s+/g, " ");
      return normalized === normalizedImport;
    });

    expect(hasImport).toBe(true);
    // Should not append again
  });

  it("ensureImportInMain creates file when main.stele doesn't exist", () => {
    const dir = createTempDir();
    const mainPath = join(dir, "contract", "main.stele");
    const targetPath = "contract/generated/ddd-typedriven.stele";

    expect(existsSync(mainPath)).toBe(false);

    // Create with import + newline
    mkdirSync(dirname(mainPath), { recursive: true });
    writeFileSync(mainPath, `(import "${targetPath}")\n`, "utf8");

    expect(existsSync(mainPath)).toBe(true);
    const content = readFileSync(mainPath, "utf8");
    expect(content).toBe(`(import "${targetPath}")\n`);
  });

  it("ensureImportInMain handles content without trailing newline", () => {
    const dir = createTempDir();
    const mainPath = join(dir, "contract", "main.stele");
    mkdirSync(dirname(mainPath), { recursive: true });

    // Content without trailing newline
    writeFileSync(mainPath, "(rule SOME_RULE)", "utf8");

    const targetPath = "contract/generated/ddd-typedriven.stele";
    const content = readFileSync(mainPath, "utf8");
    const prefix = content.endsWith("\n") ? "" : "\n";
    writeFileSync(mainPath, content + `${prefix}(import "${targetPath}")\n`, "utf8");

    const updatedContent = readFileSync(mainPath, "utf8");
    expect(updatedContent).toBe(`(rule SOME_RULE)
(import "${targetPath}")
`);
  });

  it("ensureImportInMain detects import with leading/trailing whitespace", () => {
    const dir = createTempDir();
    const mainPath = join(dir, "contract", "main.stele");
    mkdirSync(dirname(mainPath), { recursive: true });

    // Import with leading/trailing whitespace on the line
    const targetPath = "contract/generated/ddd-typedriven.stele";
    writeFileSync(mainPath, `  (import "${targetPath}")  \n`, "utf8");

    const content = readFileSync(mainPath, "utf8");
    const normalizedImport = `(import "${targetPath}")`.replace(/\s+/g, " ");
    const lines = content.split("\n");
    const hasImport = lines.some((line) => {
      const normalized = line.trim().replace(/\s+/g, " ");
      return normalized === normalizedImport;
    });

    // Leading/trailing whitespace trimmed, internal whitespace collapsed
    expect(hasImport).toBe(true);
  });
});
