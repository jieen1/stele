import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SteleError, type Contract } from "../src/index";
import * as stele from "../src/index";

const tempDirs: string[] = [];

describe("generation coordinator", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("produces deterministic, sorted generated files for runtime, top-level invariants, and grouped invariants", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant ROOT_ZETA",
        "  (severity high)",
        '  (description "top-level zeta")',
        "  (assert (eq 1 1)))",
        "(group billing",
        '  (description "billing checks")',
        "  (invariant BILLING_002",
        "    (severity medium)",
        '    (description "billing two")',
        "    (assert (eq 1 1)))",
        "  (invariant BILLING_001",
        "    (severity medium)",
        '    (description "billing one")',
        "    (assert (eq 1 1))))",
        "(group accounts",
        "  (invariant ACCOUNT_002",
        "    (severity critical)",
        '    (description "account two")',
        "    (assert (eq 1 1)))",
        "  (invariant ACCOUNT_001",
        "    (severity critical)",
        '    (description "account one")',
        "    (assert (eq 1 1))))",
        "(invariant ROOT_ALPHA",
        "  (severity high)",
        '  (description "top-level alpha")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });
    const contract = await loadContract(project.rootPath);

    const files = coordinateGeneration(contract, createFakeBackend(), { projectRoot: project.directory });

    expect(files).toEqual([
      {
        path: "tests/contract/_stele_runtime.py",
        content: "# runtime helper\n",
      },
      {
        path: "tests/contract/test_accounts.py",
        content: [
          "# group accounts",
          "ACCOUNT_001",
          "ACCOUNT_002",
          "",
        ].join("\n"),
      },
      {
        path: "tests/contract/test_billing.py",
        content: [
          "# group billing",
          "BILLING_001",
          "BILLING_002",
          "",
        ].join("\n"),
      },
      {
        path: "tests/contract/test_contract.py",
        content: [
          "# top-level",
          "ROOT_ALPHA",
          "ROOT_ZETA",
          "",
        ].join("\n"),
      },
    ]);
  });

  it("keeps stable top-level and group output paths and emits the runtime helper once", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(group ledger",
        "  (invariant LEDGER_001",
        "    (severity high)",
        '    (description "ledger one")',
        "    (assert (eq 1 1))))",
        "(group settlements",
        "  (invariant SETTLEMENT_001",
        "    (severity medium)",
        '    (description "settlement one")',
        "    (assert (eq 1 1))))",
        "(invariant ROOT_RULE",
        "  (severity critical)",
        '  (description "root rule")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });
    const contract = await loadContract(project.rootPath);

    const files = coordinateGeneration(contract, createFakeBackend(), { projectRoot: project.directory });

    expect(files.map((file) => file.path)).toEqual([
      "tests/contract/_stele_runtime.py",
      "tests/contract/test_contract.py",
      "tests/contract/test_ledger.py",
      "tests/contract/test_settlements.py",
    ]);
    expect(files.filter((file) => file.path === "tests/contract/_stele_runtime.py")).toHaveLength(1);
  });

  it("reports unchanged, missing, changed, and extra generated files without writing new files", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(group billing",
        "  (invariant BILLING_001",
        "    (severity high)",
        '    (description "billing one")',
        "    (assert (eq 1 1))))",
        "(invariant ROOT_RULE",
        "  (severity critical)",
        '  (description "root rule")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });
    const contract = await loadContract(project.rootPath);
    const expectedFiles = coordinateGeneration(contract, createFakeBackend(), { projectRoot: project.directory });

    await writeGeneratedFile(project.directory, expectedFiles.find((file) => file.path.endsWith("_stele_runtime.py"))!);
    await writeGeneratedFile(project.directory, {
      path: "tests/contract/test_contract.py",
      content: "# stale top-level\nROOT_RULE\n",
    });
    await mkdir(join(project.directory, "tests", "contract", "nested"), { recursive: true });
    await writeFile(join(project.directory, "tests", "contract", "nested", "extra.py"), "# extra\n", "utf8");

    const missingPath = join(project.directory, "tests", "contract", "test_billing.py");
    await expect(fileExists(missingPath)).resolves.toBe(false);

    const beforeDirectoryEntries = await listFiles(project.directory, "tests/contract");
    const verification = await verifyGenerated(contract, createFakeBackend(), { projectRoot: project.directory });
    const afterDirectoryEntries = await listFiles(project.directory, "tests/contract");

    expect(beforeDirectoryEntries).toEqual(afterDirectoryEntries);
    await expect(fileExists(missingPath)).resolves.toBe(false);
    expect(verification.ok).toBe(false);
    expect(verification.outputDir).toBe("tests/contract");
    expect(verification.unchanged).toEqual(["tests/contract/_stele_runtime.py"]);
    expect(verification.changed).toEqual(["tests/contract/test_contract.py"]);
    expect(verification.missing).toEqual(["tests/contract/test_billing.py"]);
    expect(verification.extra).toEqual(["tests/contract/nested/extra.py"]);
    expect(verification.files).toEqual([
      {
        path: "tests/contract/_stele_runtime.py",
        status: "unchanged",
        expectedContent: "# runtime helper\n",
        actualContent: "# runtime helper\n",
      },
      {
        path: "tests/contract/nested/extra.py",
        status: "extra",
        actualContent: "# extra\n",
      },
      {
        path: "tests/contract/test_billing.py",
        status: "missing",
        expectedContent: "# group billing\nBILLING_001\n",
      },
      {
        path: "tests/contract/test_contract.py",
        status: "changed",
        expectedContent: "# top-level\nROOT_RULE\n",
        actualContent: "# stale top-level\nROOT_RULE\n",
      },
    ]);
  });

  it("reports all generated files as unchanged when disk matches memory", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(group billing",
        "  (invariant BILLING_001",
        "    (severity high)",
        '    (description "billing one")',
        "    (assert (eq 1 1))))",
        "(invariant ROOT_RULE",
        "  (severity critical)",
        '  (description "root rule")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });
    const contract = await loadContract(project.rootPath);
    const expectedFiles = coordinateGeneration(contract, createFakeBackend(), { projectRoot: project.directory });

    await Promise.all(expectedFiles.map((file) => writeGeneratedFile(project.directory, file)));

    const verification = await verifyGenerated(contract, createFakeBackend(), { projectRoot: project.directory });

    expect(verification.ok).toBe(true);
    expect(verification.changed).toEqual([]);
    expect(verification.extra).toEqual([]);
    expect(verification.missing).toEqual([]);
    expect(verification.unchanged).toEqual(expectedFiles.map((file) => file.path));
    expect(verification.files.every((file) => file.status === "unchanged")).toBe(true);
  });

  it("rejects unsafe generated paths", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant ROOT_RULE",
        "  (severity critical)",
        '  (description "root rule")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });
    const contract = await loadContract(project.rootPath);

    for (const unsafePath of [
      "../escape.py",
      "tests/contract/../escape.py",
      "/tmp/absolute.py",
      "C:\\temp\\absolute.py",
      "tests\\other\\escape.py",
    ]) {
      expect(() =>
        coordinateGeneration(contract, createStaticBackend([{ path: unsafePath, content: "unsafe\n" }]), {
          projectRoot: project.directory,
        }),
      ).toThrowError(SteleError);
    }
  });

  it("rejects duplicate generated file paths after normalization", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant ROOT_RULE",
        "  (severity critical)",
        '  (description "root rule")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });
    const contract = await loadContract(project.rootPath);

    expect(() =>
      coordinateGeneration(
        contract,
        createStaticBackend([
          {
            path: "tests/contract/test_contract.py",
            content: "one\n",
          },
          {
            path: "tests\\contract\\test_contract.py",
            content: "two\n",
          },
        ]),
        { projectRoot: project.directory },
      ),
    ).toThrowError(SteleError);
  });
});

async function createTempProject(files: Record<string, string>): Promise<{ directory: string; rootPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "stele-core-generator-"));
  tempDirs.push(directory);

  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const fullPath = join(directory, relativePath);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, "utf8");
    }),
  );

  return {
    directory,
    rootPath: join(directory, "main.stele"),
  };
}

function createFakeBackend(): LanguageBackend {
  return {
    name: "fake-python",
    framework: "pytest",
    fileExtension: ".py",
    version: "1.0.0",
    generate(contract) {
      const topLevelInvariantIds = contract.invariants
        .filter((invariant) => invariant.groupId === undefined)
        .map((invariant) => invariant.id)
        .sort();
      const groupFiles = contract.groups
        .map((group) => ({
          path: `tests/contract/test_${group.id}.py`,
          content: [
            `# group ${group.id}`,
            ...group.invariants.map((invariant) => invariant.id).sort(),
            "",
          ].join("\n"),
        }))
        .sort((left, right) => right.path.localeCompare(left.path));

      return [
        ...groupFiles,
        {
          path: "tests\\contract\\test_contract.py",
          content: [
            "# top-level",
            ...topLevelInvariantIds,
            "",
          ].join("\n"),
        },
        {
          path: "tests/contract/_stele_runtime.py",
          content: "# runtime helper\n",
        },
      ];
    },
  };
}

function createStaticBackend(files: Array<{ path: string; content: string }>): LanguageBackend {
  return {
    name: "static",
    framework: "pytest",
    fileExtension: ".py",
    version: "1.0.0",
    generate() {
      return files;
    },
  };
}

function loadContract(rootPath: string): Promise<Contract> {
  const loadContractValue = (stele as Record<string, unknown>).loadContract;

  expect(loadContractValue).toBeTypeOf("function");

  return (loadContractValue as (path: string) => Promise<Contract>)(rootPath);
}

function coordinateGeneration(
  contract: Contract,
  backend: LanguageBackend,
  config: { projectRoot: string; outputDir?: string },
): Array<{ path: string; content: string }> {
  const value = (stele as Record<string, unknown>).coordinateGeneration;

  expect(value).toBeTypeOf("function");

  return (
    value as (
      contractValue: Contract,
      languageBackend: LanguageBackend,
      generationConfig: { projectRoot: string; outputDir?: string },
    ) => Array<{ path: string; content: string }>
  )(contract, backend, config);
}

function verifyGenerated(
  contract: Contract,
  backend: LanguageBackend,
  config: { projectRoot: string; outputDir?: string },
): Promise<{
  ok: boolean;
  outputDir: string;
  unchanged: string[];
  missing: string[];
  changed: string[];
  extra: string[];
  files: Array<{
    path: string;
    status: "unchanged" | "missing" | "changed" | "extra";
    expectedContent?: string;
    actualContent?: string;
  }>;
}> {
  const value = (stele as Record<string, unknown>).verifyGenerated;

  expect(value).toBeTypeOf("function");

  return (
    value as (
      contractValue: Contract,
      languageBackend: LanguageBackend,
      generationConfig: { projectRoot: string; outputDir?: string },
    ) => Promise<{
      ok: boolean;
      outputDir: string;
      unchanged: string[];
      missing: string[];
      changed: string[];
      extra: string[];
      files: Array<{
        path: string;
        status: "unchanged" | "missing" | "changed" | "extra";
        expectedContent?: string;
        actualContent?: string;
      }>;
    }>
  )(contract, backend, config);
}

type LanguageBackend = {
  name: string;
  framework: string;
  fileExtension: string;
  version: string;
  generate(contract: Contract, config: { projectRoot: string; outputDir?: string }): Array<{ path: string; content: string }>;
};

async function writeGeneratedFile(projectRoot: string, file: { path: string; content: string }): Promise<void> {
  const fullPath = join(projectRoot, file.path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, file.content, "utf8");
}

async function listFiles(projectRoot: string, relativeDirectory: string): Promise<string[]> {
  const rootDirectory = join(projectRoot, relativeDirectory);

  if (!(await fileExists(rootDirectory))) {
    return [];
  }

  return walkFiles(rootDirectory, projectRoot);
}

async function walkFiles(directory: string, projectRoot: string): Promise<string[]> {
  const entries = await stat(directory);

  if (!entries.isDirectory()) {
    return [relativePath(projectRoot, directory)];
  }

  const children = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    children.map(async (entry) => {
      const fullPath = join(directory, entry.name);

      if (entry.isDirectory()) {
        return walkFiles(fullPath, projectRoot);
      }

      if (entry.isFile()) {
        return [relativePath(projectRoot, fullPath)];
      }

      return [];
    }),
  );

  return files.flat().sort();
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function relativePath(projectRoot: string, fullPath: string): string {
  return fullPath.slice(projectRoot.length + 1).replaceAll("\\", "/");
}
