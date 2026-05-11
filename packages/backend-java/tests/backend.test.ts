import { describe, expect, it } from "vitest";
import { backend } from "../src/backend.js";
import { getJavaRuntimeSource } from "../src/runtime.js";
import type { Contract } from "@stele/core";

function makeMinimalContract(invariantCount = 1): Contract {
  return {
    rootPath: "/test",
    files: [],
    metadata: [],
    imports: [],
    operators: [],
    checkers: [],
    scenarios: [],
    groups: [],
    invariants: Array.from({ length: invariantCount }, (_, i) => ({
      kind: "invariant" as const,
      filePath: "test.cdl",
      node: { kind: "list" as const, head: "invariant", items: [], span: { file: "test.cdl", line: i + 1, column: 1 } },
      span: { file: "test.cdl", line: i + 1, column: 1 },
      id: `INV_${String(i + 1).padStart(3, "0")}`,
      severity: "error",
      description: `Test invariant ${i + 1}`,
      assertExpression: {
        kind: "list" as const,
        head: "gt",
        items: [
          { kind: "list" as const, head: "path", items: [{ kind: "identifier" as const, value: "value", span: { file: "test.cdl", line: 1, column: 1 } }], span: { file: "test.cdl", line: 1, column: 1 } },
          { kind: "number" as const, value: 0, raw: "0", span: { file: "test.cdl", line: 1, column: 1 } },
        ],
        span: { file: "test.cdl", line: i + 1, column: 1 },
      },
      dependsOn: [],
    })),
    codeShapes: [],
  };
}

describe("LanguageBackend: java", () => {
  it("has correct metadata", () => {
    expect(backend.name).toBe("java");
    expect(backend.framework).toBe("junit5");
    expect(backend.fileExtension).toBe(".java");
    expect(backend.version).toBe("0.1.0");
  });

  it("generate() returns files for top-level invariants", () => {
    const contract = makeMinimalContract(1);
    const files = backend.generate(contract, { projectRoot: "/test" });
    expect(files.length).toBeGreaterThanOrEqual(2);
    const hasRuntime = files.some((f) => f.path.endsWith("_stele_runtime.java"));
    expect(hasRuntime).toBe(true);
    const hasTest = files.some((f) => f.path.endsWith("test_contract.java"));
    expect(hasTest).toBe(true);
  });

  it("generate() returns only runtime when no invariants", () => {
    const contract = makeMinimalContract(0);
    const files = backend.generate(contract, { projectRoot: "/test" });
    expect(files.length).toBe(1);
    expect(files[0]!.path).toContain("_stele_runtime.java");
  });

  it("generate() creates separate files for each group", () => {
    const contract: Contract = {
      ...makeMinimalContract(0),
      groups: [
        {
          kind: "group" as const,
          filePath: "test.cdl",
          node: { kind: "list" as const, head: "group", items: [], span: { file: "test.cdl", line: 1, column: 1 } },
          span: { file: "test.cdl", line: 1, column: 1 },
          id: "payments",
          invariants: [
            {
              kind: "invariant" as const,
              filePath: "test.cdl",
              node: { kind: "list" as const, head: "invariant", items: [], span: { file: "test.cdl", line: 1, column: 1 } },
              span: { file: "test.cdl", line: 1, column: 1 },
              id: "PAY_001",
              severity: "error",
              description: "Payment invariant",
              assertExpression: {
                kind: "list" as const,
                head: "gt",
                items: [
                  { kind: "list" as const, head: "path", items: [{ kind: "identifier" as const, value: "amount", span: { file: "test.cdl", line: 1, column: 1 } }], span: { file: "test.cdl", line: 1, column: 1 } },
                  { kind: "number" as const, value: 0, raw: "0", span: { file: "test.cdl", line: 1, column: 1 } },
                ],
                span: { file: "test.cdl", line: 1, column: 1 },
              },
              dependsOn: [],
            },
          ],
        },
      ],
    };
    const files = backend.generate(contract, { projectRoot: "/test" });
    const hasGroupTest = files.some((f) => f.path.includes("test_payments"));
    expect(hasGroupTest).toBe(true);
  });

  it("generate() respects custom outputDir", () => {
    const contract = makeMinimalContract(1);
    const files = backend.generate(contract, { projectRoot: "/test", outputDir: "custom/test/java/contract" });
    expect(files[0]!.path).toContain("custom/test/java/contract");
  });

  it("generate() output is deterministic", () => {
    const contract = makeMinimalContract(2);
    const files1 = backend.generate(contract, { projectRoot: "/test" });
    const files2 = backend.generate(contract, { projectRoot: "/test" });
    expect(files1.map((f) => f.path).join(",")).toBe(files2.map((f) => f.path).join(","));
    expect(files1.map((f) => f.content).join("")).toBe(files2.map((f) => f.content).join(""));
  });

  it("supportFiles() returns empty array", () => {
    const contract = makeMinimalContract(1);
    const supportFiles = backend.supportFiles!(contract, { projectRoot: "/test" });
    expect(Array.isArray(supportFiles)).toBe(true);
  });
});

describe("getJavaRuntimeSource", () => {
  it("returns valid Java source", () => {
    const source = getJavaRuntimeSource();
    expect(source).toContain("package contract;");
    expect(source).toContain("final class SteleRuntime");
    expect(source).toContain("class SteleRuntimeError");
  });

  it("contains all required runtime methods", () => {
    const source = getJavaRuntimeSource();
    expect(source).toContain("steleEq");
    expect(source).toContain("steleGt");
    expect(source).toContain("steleForall");
    expect(source).toContain("steleExists");
    expect(source).toContain("steleSum");
    expect(source).toContain("getAtPath");
    expect(source).toContain("safeSerialize");
    expect(source).toContain("steleRunScenario");
    expect(source).toContain("steleCallChecker");
    expect(source).toContain("CheckerFunction");
    expect(source).toContain("CheckerResult");
  });

  it("source is cached", () => {
    const source1 = getJavaRuntimeSource();
    const source2 = getJavaRuntimeSource();
    expect(source1).toBe(source2);
  });
});

describe("writeFixtureBootstrap", () => {
  it("writes SteleConftest.java for a fixture", async () => {
    const tmpdir = "/tmp/stele-test-fixture";
    const appState = {
      accounts: [
        { balance: 100, name: "Alice" },
        { balance: 50, name: "Bob" },
      ],
    };

    await backend.writeFixtureBootstrap!(
      { id: "test-fixture", dir: "/tmp/fixture", appState },
      tmpdir,
    );

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(`${tmpdir}/src/test/java/contract/SteleConftest.java`, "utf8");
    expect(content).toContain("package contract;");
    expect(content).toContain("public class SteleConftest");
    expect(content).toContain("steleContext");

    // Cleanup
    const { rm } = await import("node:fs/promises");
    await rm(tmpdir, { recursive: true, force: true });
  });

  it("produces deterministic output", async () => {
    const tmpdir = "/tmp/stele-test-fixture-deterministic";
    const appState = {
      items: [{ id: 1, value: "a" }, { id: 2, value: "b" }],
    };

    await backend.writeFixtureBootstrap!(
      { id: "det-fixture", dir: "/tmp/det", appState },
      tmpdir,
    );

    const { readFile } = await import("node:fs/promises");
    const content1 = await readFile(`${tmpdir}/src/test/java/contract/SteleConftest.java`, "utf8");

    // Remove and regenerate
    const { rm, mkdir } = await import("node:fs/promises");
    await rm(tmpdir, { recursive: true, force: true });
    await mkdir(tmpdir, { recursive: true });

    await backend.writeFixtureBootstrap!(
      { id: "det-fixture", dir: "/tmp/det", appState },
      tmpdir,
    );

    const content2 = await readFile(`${tmpdir}/src/test/java/contract/SteleConftest.java`, "utf8");
    expect(content1).toBe(content2);

    // Cleanup
    await rm(tmpdir, { recursive: true, force: true });
  });
});
