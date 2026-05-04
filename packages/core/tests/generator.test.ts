import { mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SteleError,
  type Contract,
  type GeneratedFile,
  type LanguageBackend,
} from "../src/index";
import * as stele from "../src/index";

const tempDirs: string[] = [];

describe("generation coordinator", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("returns canonical runtime, top-level, and group files in deterministic sorted order", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(group cash-flow",
        "  (invariant CASH_001",
        "    (severity high)",
        '    (description "cash rule")',
        "    (assert (eq 1 1))))",
        "(group accounts",
        "  (invariant ACCOUNT_001",
        "    (severity medium)",
        '    (description "account rule")',
        "    (assert (eq 1 1))))",
        "(invariant ROOT_ZETA",
        "  (severity critical)",
        '  (description "root zeta")',
        "  (assert (eq 1 1)))",
        "(invariant ROOT_ALPHA",
        "  (severity critical)",
        '  (description "root alpha")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });
    const contract = await loadContract(project.rootPath);

    const files = coordinateGeneration(
      contract,
      createLiteralBackend([
        {
          path: "tests/contract/test_contract.py",
          content: "# top-level\nROOT_ALPHA\nROOT_ZETA\n",
        },
        {
          path: "tests/contract/test_accounts.py",
          content: "# group accounts\nACCOUNT_001\n",
        },
        {
          path: "tests/contract/_stele_runtime.py",
          content: "# runtime helper\n",
        },
        {
          path: "tests/contract/test_cash_flow.py",
          content: "# group cash-flow\nCASH_001\n",
        },
      ]),
      { projectRoot: project.directory },
    );

    expect(files).toEqual([
      {
        path: "tests/contract/_stele_runtime.py",
        content: "# runtime helper\n",
      },
      {
        path: "tests/contract/test_accounts.py",
        content: "# group accounts\nACCOUNT_001\n",
      },
      {
        path: "tests/contract/test_cash_flow.py",
        content: "# group cash-flow\nCASH_001\n",
      },
      {
        path: "tests/contract/test_contract.py",
        content: "# top-level\nROOT_ALPHA\nROOT_ZETA\n",
      },
    ]);
  });

  it("accepts backend-declared support files alongside canonical generated files", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(group accounts",
        "  (invariant ACCOUNT_001",
        "    (severity medium)",
        '    (description "account rule")',
        "    (assert (eq 1 1))))",
        "(invariant ROOT_RULE",
        "  (severity critical)",
        '  (description "root rule")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });
    const contract = await loadContract(project.rootPath);
    const backend = createLiteralBackend(
      [
        {
          path: "tests/contract/_stele_runtime.py",
          content: "# runtime helper\n",
        },
        {
          path: "tests/contract/test_accounts.py",
          content: "# group accounts\nACCOUNT_001\n",
        },
        {
          path: "tests/contract/test_contract.py",
          content: "# top-level\nROOT_RULE\n",
        },
      ],
      [
        {
          path: "tests/contract/__init__.py",
          content: "",
        },
      ],
    );

    const generated = coordinateGeneration(contract, backend, { projectRoot: project.directory });

    expect(generated).toEqual([
      {
        path: "tests/contract/__init__.py",
        content: "",
      },
      {
        path: "tests/contract/_stele_runtime.py",
        content: "# runtime helper\n",
      },
      {
        path: "tests/contract/test_accounts.py",
        content: "# group accounts\nACCOUNT_001\n",
      },
      {
        path: "tests/contract/test_contract.py",
        content: "# top-level\nROOT_RULE\n",
      },
    ]);

    for (const file of generated) {
      await writeGeneratedFile(project.directory, file);
    }

    const verification = await verifyGenerated(contract, backend, { projectRoot: project.directory });

    expect(verification.ok).toBe(true);
    expect(verification.unchanged).toEqual(generated.map((file) => file.path));
  });

  it("emits runtime and group files only when the contract has no top-level invariants", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(group ledger",
        "  (invariant LEDGER_001",
        "    (severity high)",
        '    (description "ledger rule")',
        "    (assert (eq 1 1))))",
        "(group settlements",
        "  (invariant SETTLEMENT_001",
        "    (severity medium)",
        '    (description "settlement rule")',
        "    (assert (eq 1 1))))",
      ].join("\n"),
    });
    const contract = await loadContract(project.rootPath);

    const files = coordinateGeneration(
      contract,
      createLiteralBackend([
        {
          path: "tests/contract/test_settlements.py",
          content: "# group settlements\nSETTLEMENT_001\n",
        },
        {
          path: "tests/contract/_stele_runtime.py",
          content: "# runtime helper\n",
        },
        {
          path: "tests/contract/test_ledger.py",
          content: "# group ledger\nLEDGER_001\n",
        },
      ]),
      { projectRoot: project.directory },
    );

    expect(files.map((file) => file.path)).toEqual([
      "tests/contract/_stele_runtime.py",
      "tests/contract/test_ledger.py",
      "tests/contract/test_settlements.py",
    ]);
    expect(files.find((file) => file.path === "tests/contract/test_contract.py")).toBeUndefined();
  });

  it("rejects a backend that emits a non-canonical generated file path", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(group billing",
        "  (invariant BILLING_001",
        "    (severity high)",
        '    (description "billing rule")',
        "    (assert (eq 1 1))))",
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
        createLiteralBackend([
          {
            path: "tests/contract/_stele_runtime.py",
            content: "# runtime helper\n",
          },
          {
            path: "tests/contract/test_billing.py",
            content: "# group billing\nBILLING_001\n",
          },
          {
            path: "tests/contract/custom.py",
            content: "# wrong top-level path\n",
          },
        ]),
        { projectRoot: project.directory },
      ),
    ).toThrowError(SteleError);
  });

  it("rejects a backend that is missing required canonical files", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(group billing",
        "  (invariant BILLING_001",
        "    (severity high)",
        '    (description "billing rule")',
        "    (assert (eq 1 1))))",
        "(invariant ROOT_RULE",
        "  (severity critical)",
        '  (description "root rule")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });
    const contract = await loadContract(project.rootPath);

    for (const files of [
      [
        {
          path: "tests/contract/test_billing.py",
          content: "# group billing\nBILLING_001\n",
        },
        {
          path: "tests/contract/test_contract.py",
          content: "# top-level\nROOT_RULE\n",
        },
      ],
      [
        {
          path: "tests/contract/_stele_runtime.py",
          content: "# runtime helper\n",
        },
        {
          path: "tests/contract/test_contract.py",
          content: "# top-level\nROOT_RULE\n",
        },
      ],
      [
        {
          path: "tests/contract/_stele_runtime.py",
          content: "# runtime helper\n",
        },
        {
          path: "tests/contract/test_billing.py",
          content: "# group billing\nBILLING_001\n",
        },
      ],
    ] satisfies GeneratedFile[][]) {
      expect(() => coordinateGeneration(contract, createLiteralBackend(files), { projectRoot: project.directory })).toThrowError(
        SteleError,
      );
    }
  });

  it("rejects a backend that emits extra files under the generated output directory", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(group billing",
        "  (invariant BILLING_001",
        "    (severity high)",
        '    (description "billing rule")',
        "    (assert (eq 1 1))))",
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
        createLiteralBackend([
          {
            path: "tests/contract/_stele_runtime.py",
            content: "# runtime helper\n",
          },
          {
            path: "tests/contract/test_billing.py",
            content: "# group billing\nBILLING_001\n",
          },
          {
            path: "tests/contract/test_contract.py",
            content: "# top-level\nROOT_RULE\n",
          },
          {
            path: "tests/contract/bonus.py",
            content: "# extra\n",
          },
        ]),
        { projectRoot: project.directory },
      ),
    ).toThrowError(SteleError);
  });

  it("rejects undeclared support files even when the path is otherwise harmless", async () => {
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
        createLiteralBackend([
          {
            path: "tests/contract/__init__.py",
            content: "",
          },
          {
            path: "tests/contract/_stele_runtime.py",
            content: "# runtime helper\n",
          },
          {
            path: "tests/contract/test_contract.py",
            content: "# top-level\nROOT_RULE\n",
          },
        ]),
        { projectRoot: project.directory },
      ),
    ).toThrowError(SteleError);
  });

  it("rejects unsafe, duplicate, and case-colliding generated file paths", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant ROOT_RULE",
        "  (severity critical)",
        '  (description "root rule")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });
    const contract = await loadContract(project.rootPath);

    for (const files of [
      [
        {
          path: "../escape.py",
          content: "unsafe\n",
        },
        {
          path: "tests/contract/test_contract.py",
          content: "# top-level\nROOT_RULE\n",
        },
      ],
      [
        {
          path: "tests/contract/_stele_runtime.py",
          content: "# runtime helper\n",
        },
        {
          path: "tests/contract/test_contract.py",
          content: "# top-level\nROOT_RULE\n",
        },
        {
          path: "tests\\contract\\test_contract.py",
          content: "# duplicate top-level\n",
        },
      ],
      [
        {
          path: "tests/contract/_stele_runtime.py",
          content: "# runtime helper\n",
        },
        {
          path: "tests/contract/test_contract.py",
          content: "# top-level\nROOT_RULE\n",
        },
        {
          path: "tests/contract/TEST_CONTRACT.py",
          content: "# case collision\n",
        },
      ],
    ] satisfies GeneratedFile[][]) {
      expect(() => coordinateGeneration(contract, createLiteralBackend(files), { projectRoot: project.directory })).toThrowError(
        SteleError,
      );
    }
  });

  it("rejects group ids whose canonical filenames collide after sanitization", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(group cash-flow",
        "  (invariant CASH_001",
        "    (severity high)",
        '    (description "cash flow rule")',
        "    (assert (eq 1 1))))",
        "(group cash_flow",
        "  (invariant CASH_002",
        "    (severity high)",
        '    (description "cash flow underscore rule")',
        "    (assert (eq 1 1))))",
      ].join("\n"),
    });
    const contract = await loadContract(project.rootPath);

    expect(() =>
      coordinateGeneration(
        contract,
        createLiteralBackend([
          {
            path: "tests/contract/_stele_runtime.py",
            content: "# runtime helper\n",
          },
        ]),
        { projectRoot: project.directory },
      ),
    ).toThrowError(SteleError);
  });

  it("reports unchanged, missing, changed, and extra generated files without writing new files", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(group billing",
        "  (invariant BILLING_001",
        "    (severity high)",
        '    (description "billing rule")',
        "    (assert (eq 1 1))))",
        "(invariant ROOT_RULE",
        "  (severity critical)",
        '  (description "root rule")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });
    const contract = await loadContract(project.rootPath);
    const backend = createLiteralBackend([
      {
        path: "tests/contract/test_contract.py",
        content: "# top-level\nROOT_RULE\n",
      },
      {
        path: "tests/contract/_stele_runtime.py",
        content: "# runtime helper\n",
      },
      {
        path: "tests/contract/test_billing.py",
        content: "# group billing\nBILLING_001\n",
      },
    ]);

    await writeGeneratedFile(project.directory, {
      path: "tests/contract/_stele_runtime.py",
      content: "# runtime helper\n",
    });
    await writeGeneratedFile(project.directory, {
      path: "tests/contract/test_contract.py",
      content: "# stale top-level\nROOT_RULE\n",
    });
    await mkdir(join(project.directory, "tests", "contract", "nested"), { recursive: true });
    await writeFile(join(project.directory, "tests", "contract", "nested", "extra.py"), "# extra\n", "utf8");

    const missingGroupPath = join(project.directory, "tests", "contract", "test_billing.py");
    await expect(fileExists(missingGroupPath)).resolves.toBe(false);

    const beforeFiles = await listFiles(project.directory, "tests/contract");
    const verification = await verifyGenerated(contract, backend, { projectRoot: project.directory });
    const afterFiles = await listFiles(project.directory, "tests/contract");

    expect(beforeFiles).toEqual(afterFiles);
    await expect(fileExists(missingGroupPath)).resolves.toBe(false);
    expect(verification).toEqual({
      ok: false,
      outputDir: "tests/contract",
      unchanged: ["tests/contract/_stele_runtime.py"],
      missing: ["tests/contract/test_billing.py"],
      changed: ["tests/contract/test_contract.py"],
      extra: ["tests/contract/nested/extra.py"],
      files: [
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
      ],
    });
  });

  it("reports generated files as unchanged when disk matches the canonical backend output", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(group billing",
        "  (invariant BILLING_001",
        "    (severity high)",
        '    (description "billing rule")',
        "    (assert (eq 1 1))))",
        "(invariant ROOT_RULE",
        "  (severity critical)",
        '  (description "root rule")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });
    const contract = await loadContract(project.rootPath);
    const backend = createLiteralBackend([
      {
        path: "tests/contract/test_billing.py",
        content: "# group billing\nBILLING_001\n",
      },
      {
        path: "tests/contract/_stele_runtime.py",
        content: "# runtime helper\n",
      },
      {
        path: "tests/contract/test_contract.py",
        content: "# top-level\nROOT_RULE\n",
      },
    ]);

    for (const file of coordinateGeneration(contract, backend, { projectRoot: project.directory })) {
      await writeGeneratedFile(project.directory, file);
    }

    const verification = await verifyGenerated(contract, backend, { projectRoot: project.directory });

    expect(verification.ok).toBe(true);
    expect(verification.unchanged).toEqual([
      "tests/contract/_stele_runtime.py",
      "tests/contract/test_billing.py",
      "tests/contract/test_contract.py",
    ]);
    expect(verification.missing).toEqual([]);
    expect(verification.changed).toEqual([]);
    expect(verification.extra).toEqual([]);
    expect(verification.files.every((file) => file.status === "unchanged")).toBe(true);
  });

  it("reports non-regular output entries as extras during verification", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant ROOT_RULE",
        "  (severity critical)",
        '  (description "root rule")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });
    const contract = await loadContract(project.rootPath);
    const backend = createLiteralBackend(
      [
        {
          path: "tests/contract/_stele_runtime.py",
          content: "# runtime helper\n",
        },
        {
          path: "tests/contract/test_contract.py",
          content: "# top-level\nROOT_RULE\n",
        },
      ],
      [
        {
          path: "tests/contract/__init__.py",
          content: "",
        },
      ],
    );

    for (const file of coordinateGeneration(contract, backend, { projectRoot: project.directory })) {
      await writeGeneratedFile(project.directory, file);
    }

    const outputRoot = join(project.directory, "tests", "contract");
    const targetDirectory = join(project.directory, "linked-target");
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(join(targetDirectory, "ignored.py"), "# target\n", "utf8");

    const linkPath = join(outputRoot, "linked-dir");
    const createdLink = await tryCreateNonRegularEntry(targetDirectory, linkPath);

    if (!createdLink) {
      return;
    }

    const verification = await verifyGenerated(contract, backend, { projectRoot: project.directory });
    const extraEntry = verification.files.find((file) => file.path === "tests/contract/linked-dir");

    expect(verification.ok).toBe(false);
    expect(verification.extra).toContain("tests/contract/linked-dir");
    expect(extraEntry).toMatchObject({
      path: "tests/contract/linked-dir",
      status: "extra",
      actualContent: "[non-regular entry]",
    });
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

function createLiteralBackend(files: GeneratedFile[], supportFiles: GeneratedFile[] = []): LanguageBackend {
  return {
    name: "literal-python",
    framework: "pytest",
    fileExtension: ".py",
    version: "1.0.0",
    generate() {
      return files;
    },
    supportFiles() {
      return supportFiles;
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
): GeneratedFile[] {
  const value = (stele as Record<string, unknown>).coordinateGeneration;

  expect(value).toBeTypeOf("function");

  return (
    value as (contractValue: Contract, languageBackend: LanguageBackend, generationConfig: { projectRoot: string; outputDir?: string }) => GeneratedFile[]
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

async function writeGeneratedFile(projectRoot: string, file: GeneratedFile): Promise<void> {
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
  const directoryStat = await stat(directory);

  if (!directoryStat.isDirectory()) {
    return [relativePath(projectRoot, directory)];
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
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

async function tryCreateNonRegularEntry(targetDirectory: string, linkPath: string): Promise<boolean> {
  for (const type of ["junction", "dir"] as const) {
    try {
      await symlink(targetDirectory, linkPath, type);
      return true;
    } catch (error) {
      if (!isSymlinkPermissionError(error)) {
        throw error;
      }
    }
  }

  return false;
}

function isSymlinkPermissionError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES" || error.code === "UNKNOWN");
}
