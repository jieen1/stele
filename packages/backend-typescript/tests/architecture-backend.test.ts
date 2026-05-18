import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadContract, type Contract } from "@stele/core";
import backend from "../src/backend.js";
import { toMinimalArchitecture } from "../src/architecture-renderer.js";

const tempDirs: string[] = [];

describe("backend generates architecture tests", () => {
  afterEach(async () => {
    await Promise.allSettled(
      tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("emits an architecture test file when the contract has architectures", async () => {
    const contract = await createContract({
      "main.stele": [
        '(architecture "core-arch"',
        '  (lang typescript)',
        '  (module api (path "src/api/**"))',
        '  (module core (path "src/core/**"))',
        '  (allow-dependency api core)',
        ")",
      ].join("\n"),
    });

    const files = backend.generate(contract, {
      projectRoot: "/",
      outputDir: "tests/contract",
    });

    const paths = files.map((f) => f.path).sort();
    expect(paths).toContain("tests/contract/test_arch_core_arch.ts");

    const archFile = files.find((f) => f.path === "tests/contract/test_arch_core_arch.ts");
    expect(archFile).toBeDefined();
    expect(archFile.content).toContain('describe("Architecture: core-arch"');
    expect(archFile.content).toContain("evaluateArchitectureContract");
  });

  it("emits multiple architecture test files for multiple architectures", async () => {
    const contract = await createContract({
      "main.stele": [
        '(architecture "arch-one"',
        '  (lang typescript)',
        '  (module mod1 (path "src/mod1/**"))',
        ")",
        '(architecture "arch-two"',
        '  (lang typescript)',
        '  (module mod2 (path "src/mod2/**"))',
        ")",
      ].join("\n"),
    });

    const files = backend.generate(contract, {
      projectRoot: "/",
      outputDir: "tests/contract",
    });

    const paths = files.map((f) => f.path).sort();
    expect(paths).toContain("tests/contract/test_arch_arch_one.ts");
    expect(paths).toContain("tests/contract/test_arch_arch_two.ts");
  });

  it("does not emit architecture test files when there are no architectures", async () => {
    const contract = await createContract({
      "main.stele": [
        "(invariant RULE_001",
        "  (severity high)",
        '  (description "basic rule")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });

    const files = backend.generate(contract, {
      projectRoot: "/",
      outputDir: "tests/contract",
    });

    const paths = files.map((f) => f.path).sort();
    for (const path of paths) {
      expect(path).not.toContain("test_arch_");
    }
  });

  it("preserves denyCycles setting in generated test", async () => {
    const contract = await createContract({
      "main.stele": [
        '(architecture "no-cycles"',
        '  (lang typescript)',
        '  (deny-cycles false)',
        '  (module m (path "src/m/**"))',
        ")",
      ].join("\n"),
    });

    const files = backend.generate(contract, {
      projectRoot: "/",
      outputDir: "tests/contract",
    });

    const archFile = files.find((f) => f.path === "tests/contract/test_arch_no_cycles.ts");
    expect(archFile).toBeDefined();
    expect(archFile.content).toContain('"denyCycles": false');
  });

  it("combines invariant tests with architecture tests", async () => {
    const contract = await createContract({
      "main.stele": [
        '(architecture "arch1"',
        '  (lang typescript)',
        '  (module m (path "src/m/**"))',
        ")",
        "(invariant INV_001",
        "  (severity high)",
        '  (description "balance positive")',
        "  (assert (gt (path account balance) 0)))",
      ].join("\n"),
    });

    const files = backend.generate(contract, {
      projectRoot: "/",
      outputDir: "tests/contract",
    });

    const paths = files.map((f) => f.path).sort();
    expect(paths).toContain("tests/contract/test_contract.ts");
    expect(paths).toContain("tests/contract/test_arch_arch1.ts");
  });

  it("respects custom outputDir for architecture tests", async () => {
    const contract = await createContract({
      "main.stele": [
        '(architecture "my-arch"',
        '  (lang typescript)',
        '  (module m (path "src/m/**"))',
        ")",
      ].join("\n"),
    });

    const files = backend.generate(contract, {
      projectRoot: "/",
      outputDir: "custom/tests",
    });

    const paths = files.map((f) => f.path).sort();
    expect(paths).toContain("custom/tests/test_arch_my_arch.ts");
  });
});

describe("toMinimalArchitecture strips structural fields", () => {
  it("removes span and publicEntries from modules", async () => {
    const contract = await createContract({
      "main.stele": [
        '(architecture "test-arch"',
        '  (lang typescript)',
        '  (module m (path "src/m/**"))',
        ")",
      ].join("\n"),
    });

    const arch = contract.architectures[0];
    const minimal = toMinimalArchitecture(arch);

    expect(minimal.modules[0]).toEqual({
      id: "m",
      paths: ["src/m/**"],
    });
    // Verify no extra fields
    expect(Object.keys(minimal.modules[0])).toEqual(["id", "paths"]);
  });

  it("removes span from allowDependencies", async () => {
    const contract = await createContract({
      "main.stele": [
        '(architecture "test-arch"',
        '  (lang typescript)',
        '  (module a (path "src/a/**"))',
        '  (module b (path "src/b/**"))',
        '  (allow-dependency a b)',
        ")",
      ].join("\n"),
    });

    const arch = contract.architectures[0];
    const minimal = toMinimalArchitecture(arch);

    expect(minimal.allowDependencies[0]).toEqual({
      from: "a",
      to: ["b"],
    });
    expect(Object.keys(minimal.allowDependencies[0])).toEqual(["from", "to"]);
  });
});

async function createContract(files: Record<string, string>): Promise<Contract> {
  const directory = await mkdtemp(join(tmpdir(), "stele-arch-backend-"));
  tempDirs.push(directory);

  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const fullPath = join(directory, relativePath);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, "utf8");
    }),
  );

  return loadContract(join(directory, "main.stele"));
}
