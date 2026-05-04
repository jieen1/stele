import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAddChecker } from "../src/commands/addChecker.js";
import { runExplain } from "../src/commands/explain.js";
import { runList } from "../src/commands/list.js";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE } from "../src/config/defaults.js";
import { createProgram, runCli } from "../src/index.js";

const tempDirs: string[] = [];
const CHECKER_STUB = `def check(inputs: dict) -> dict:
    return {
        "passed": False,
        "message": "Checker implementation has not been approved yet.",
        "context": inputs,
    }
`;
const CHECKER_BLOCK = `(checker fresh_checker
  (description "TODO: describe what this checker validates."))
`;
const HYPHENATED_CHECKER_BLOCK = `(checker fresh-checker
  (description "TODO: describe what this checker validates."))
`;

describe("inspection commands", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("list prints stable columns and includes top-level plus group invariants from the real contract", async () => {
    const projectDir = await createInspectionFixtureProject();

    const stdout = captureStdout();
    await runList(projectDir, {});

    expect(stdout.read()).toBe(
      [
        "ID\tSeverity\tCategory\tDescription\tFile Path",
        "PAYMENT_BASELINE\thigh\t<none>\tBaseline rule used as a dependency target.\tcontract/main.stele",
        'ROOT_PAYMENT_BALANCE\tcritical\tdata-integrity\tPayments remain balanced before settlement.\tcontract/main.stele',
        'COMMENT_RULE\thigh\t<none>\tComment rule with ) and ; inside the string.\tcontract/main.stele',
        'TSV_RULE\thigh\t<none>\tTabbed\\\\path\\tline\\nnext\\rreturn\tcontract/main.stele',
        'GROUP_CHECKED_SETTLEMENT\tmedium\t(domain ledger)\tSettlement batches require an approved checker.\tcontract/main.stele',
      ].join("\n") + "\n",
    );
  });

  it("list escapes user-controlled cells so each row remains stable TSV", async () => {
    const projectDir = await createInspectionFixtureProject();
    const stdout = captureStdout();

    await runList(projectDir, { severity: "high" });

    const output = stdout.read().trimEnd().split("\n");
    const tsvRow = output.find((line) => line.startsWith("TSV_RULE\t"));

    expect(tsvRow).toBeDefined();
    expect(tsvRow!.split("\t")).toHaveLength(5);
    expect(tsvRow).toContain("Tabbed\\\\path\\tline\\nnext\\rreturn");
  });

  it("list applies severity, category, and tag filters against parsed field values", async () => {
    const projectDir = await createInspectionFixtureProject();

    await expectListOutput(projectDir, { severity: "critical" }, [
      "ID\tSeverity\tCategory\tDescription\tFile Path",
      'ROOT_PAYMENT_BALANCE\tcritical\tdata-integrity\tPayments remain balanced before settlement.\tcontract/main.stele',
    ]);
    await expectListOutput(projectDir, { category: "data-integrity" }, [
      "ID\tSeverity\tCategory\tDescription\tFile Path",
      'ROOT_PAYMENT_BALANCE\tcritical\tdata-integrity\tPayments remain balanced before settlement.\tcontract/main.stele',
    ]);
    await expectListOutput(projectDir, { tag: "payment" }, [
      "ID\tSeverity\tCategory\tDescription\tFile Path",
      'ROOT_PAYMENT_BALANCE\tcritical\tdata-integrity\tPayments remain balanced before settlement.\tcontract/main.stele',
      'GROUP_CHECKED_SETTLEMENT\tmedium\t(domain ledger)\tSettlement batches require an approved checker.\tcontract/main.stele',
    ]);
    await expectListOutput(projectDir, { tag: ":priority" }, [
      "ID\tSeverity\tCategory\tDescription\tFile Path",
      'ROOT_PAYMENT_BALANCE\tcritical\tdata-integrity\tPayments remain balanced before settlement.\tcontract/main.stele',
    ]);
    await expectListOutput(projectDir, { tag: "(scope nightly)" }, [
      "ID\tSeverity\tCategory\tDescription\tFile Path",
      'GROUP_CHECKED_SETTLEMENT\tmedium\t(domain ledger)\tSettlement batches require an approved checker.\tcontract/main.stele',
    ]);
  });

  it("list combines filters and keeps a stable header when nothing matches", async () => {
    const projectDir = await createInspectionFixtureProject();

    await expectListOutput(projectDir, { severity: "medium", category: "(domain ledger)", tag: "(scope nightly)" }, [
      "ID\tSeverity\tCategory\tDescription\tFile Path",
      'GROUP_CHECKED_SETTLEMENT\tmedium\t(domain ledger)\tSettlement batches require an approved checker.\tcontract/main.stele',
    ]);
    await expectListOutput(projectDir, { severity: "low", category: "missing", tag: "missing" }, [
      "ID\tSeverity\tCategory\tDescription\tFile Path",
    ]);
  });

  it("explain prints the full top-level invariant source, generated path, dependencies, rationale, and checker placeholder", async () => {
    const projectDir = await createInspectionFixtureProject();
    const stdout = captureStdout();

    await runExplain(projectDir, "ROOT_PAYMENT_BALANCE");

    expect(stdout.read()).toContain("ID: ROOT_PAYMENT_BALANCE\n");
    expect(stdout.read()).toContain("Generated Test Path: tests/contract/test_contract.py\n");
    expect(stdout.read()).toContain("Dependencies: PAYMENT_BASELINE\n");
    expect(stdout.read()).toContain('Rationale: "Preserve the accounting invariant before settlement."\n');
    expect(stdout.read()).toContain("Checker ID: <none>\n");
    expect(stdout.read()).toContain(
      [
        "Source:",
        "(invariant ROOT_PAYMENT_BALANCE",
        "  (severity critical)",
        '  (description "Payments remain balanced before settlement.")',
        "  (category data-integrity)",
        '  (tags payment :priority "batch window")',
        '  (rationale "Preserve the accounting invariant before settlement.")',
        "  (depends-on PAYMENT_BASELINE)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );
  });

  it("explain prints group invariant details including checker id and generated group path", async () => {
    const projectDir = await createInspectionFixtureProject();
    const stdout = captureStdout();

    await runExplain(projectDir, "GROUP_CHECKED_SETTLEMENT");

    expect(stdout.read()).toContain("Generated Test Path: tests/contract/test_batch_reconciliation.py\n");
    expect(stdout.read()).toContain("Dependencies: <none>\n");
    expect(stdout.read()).toContain("Rationale: <none>\n");
    expect(stdout.read()).toContain("Checker ID: approved_checker\n");
    expect(stdout.read()).toContain(
      [
        "Source:",
        "(invariant GROUP_CHECKED_SETTLEMENT",
        "    (severity medium)",
        '    (description "Settlement batches require an approved checker.")',
        "    (category (domain ledger))",
        "    (tags payment (scope nightly) 7)",
        "    (uses-checker approved_checker))",
      ].join("\n"),
    );
  });

  it("explain preserves source when comments contain closing parens and strings contain comment-like characters", async () => {
    const projectDir = await createInspectionFixtureProject();
    const stdout = captureStdout();

    await runExplain(projectDir, "COMMENT_RULE");

    expect(stdout.read()).toContain(
      [
        "Source:",
        "(invariant COMMENT_RULE",
        "  (severity high)",
        "  ; note: this comment mentions ) and should not end the invariant",
        '  (description "Comment rule with ) and ; inside the string.")',
        '  (rationale "Rationale keeps ) and ; as literal text.")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );
  });

  it("explain rejects unknown ids and CLI exit handling includes the missing id", async () => {
    const projectDir = await createInspectionFixtureProject();
    const stderr = captureStderr();
    const originalExitCode = process.exitCode;

    await expect(runExplain(projectDir, "MISSING_RULE")).rejects.toThrow(/MISSING_RULE/);

    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    process.exitCode = 0;
    await runCli(["node", "stele", "explain", "MISSING_RULE"]);

    expect(process.exitCode).toBe(1);
    expect(stderr.read()).toContain("MISSING_RULE");
    process.exitCode = originalExitCode;
  });

  it("add-checker creates the exact stub file and prints the checker block", async () => {
    const projectDir = await createInspectionFixtureProject();
    const stdout = captureStdout();

    await runAddChecker(projectDir, "fresh_checker");

    await expect(readFile(join(projectDir, "contract", "checker_impls", "fresh_checker.py"), "utf8")).resolves.toBe(CHECKER_STUB);
    expect(stdout.read()).toBe(CHECKER_BLOCK);
  });

  it("add-checker creates a missing checker implementation directory inside the project", async () => {
    const projectDir = await createInspectionFixtureProject();
    const stdout = captureStdout();

    await rm(join(projectDir, "contract", "checker_impls"), { recursive: true, force: true });
    await runAddChecker(projectDir, "fresh_checker");

    await expect(readFile(join(projectDir, "contract", "checker_impls", "fresh_checker.py"), "utf8")).resolves.toBe(CHECKER_STUB);
    expect(stdout.read()).toBe(CHECKER_BLOCK);
  });

  it("add-checker accepts a hyphenated CDL checker id, creates an underscore Python filename, and prints the CDL id unchanged", async () => {
    const projectDir = await createInspectionFixtureProject();
    const stdout = captureStdout();

    await runAddChecker(projectDir, "fresh-checker");

    await expect(readFile(join(projectDir, "contract", "checker_impls", "fresh_checker.py"), "utf8")).resolves.toBe(CHECKER_STUB);
    expect(stdout.read()).toBe(HYPHENATED_CHECKER_BLOCK);
  });

  it("add-checker rejects invalid or dangerous ids", async () => {
    const projectDir = await createInspectionFixtureProject();

    for (const checkerId of ["", "../escape", "nested/checker", "C:\\evil", "\\\\server\\share", "-bad", "name.py"]) {
      await expect(runAddChecker(projectDir, checkerId)).rejects.toThrow(/checker/i);
    }
  });

  it("add-checker refuses to overwrite an existing checker implementation", async () => {
    const projectDir = await createInspectionFixtureProject();

    await expect(runAddChecker(projectDir, "approved_checker")).rejects.toThrow(/approved_checker/i);
    await expect(readFile(join(projectDir, "contract", "checker_impls", "approved_checker.py"), "utf8")).resolves.toBe(
      "def approved_checker(context):\n    return {\"passed\": True, \"message\": None}\n",
    );
  });

  it("add-checker refuses filename collisions between hyphenated and underscored ids", async () => {
    const projectDir = await createInspectionFixtureProject();

    await runAddChecker(projectDir, "fresh_checker");

    await expect(runAddChecker(projectDir, "fresh-checker")).rejects.toThrow(/fresh-checker|fresh_checker|already exists|collision/i);
    await expect(readFile(join(projectDir, "contract", "checker_impls", "fresh_checker.py"), "utf8")).resolves.toBe(CHECKER_STUB);
  });

  it("add-checker rejects checker directories that escape the project root via symlink or junction", async () => {
    const projectDir = await createInspectionFixtureProject();
    const externalDir = await createTempDir();
    const checkerImplDir = join(projectDir, "contract", "checker_impls");

    await rm(checkerImplDir, { recursive: true, force: true });

    const createdLink = await tryCreateNonRegularEntry(externalDir, checkerImplDir);

    if (!createdLink) {
      return;
    }

    await expect(runAddChecker(projectDir, "probe_checker")).rejects.toThrow(/checkerImplDir|project root|symlink|junction|non-regular/i);
    await expect(readdir(externalDir)).resolves.toEqual([]);
  });

  it("add-checker rejects linked checker ancestors before creating external directories", async () => {
    const projectDir = await createTempDir();
    const outsideDir = await createTempDir();

    await writeProjectFile(projectDir, STELE_CONFIG_FILE, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);

    const createdLink = await tryCreateNonRegularEntry(outsideDir, join(projectDir, "contract"));

    if (!createdLink) {
      return;
    }

    await expect(runAddChecker(projectDir, "probe_checker")).rejects.toThrow(/checkerImplDir|project root|symlink|junction|non-regular/i);
    await expect(readdir(outsideDir)).resolves.toEqual([]);
  });

  it("CLI wiring forwards cwd, filters, ids, and checker names to the new handlers", async () => {
    const handlers = {
      list: vi.fn(async () => undefined),
      explain: vi.fn(async () => undefined),
      addChecker: vi.fn(async () => undefined),
    };
    const program = createProgram({
      cwd: () => "E:/tmp/project",
      runList: handlers.list,
      runExplain: handlers.explain,
      runAddChecker: handlers.addChecker,
    });

    await program.parseAsync(["node", "stele", "list", "--severity", "critical", "--category", "data-integrity", "--tag", "payment"]);
    await program.parseAsync(["node", "stele", "explain", "ROOT_PAYMENT_BALANCE"]);
    await program.parseAsync(["node", "stele", "add-checker", "fresh_checker"]);

    expect(handlers.list).toHaveBeenCalledWith("E:/tmp/project", {
      severity: "critical",
      category: "data-integrity",
      tag: "payment",
    });
    expect(handlers.explain).toHaveBeenCalledWith("E:/tmp/project", "ROOT_PAYMENT_BALANCE");
    expect(handlers.addChecker).toHaveBeenCalledWith("E:/tmp/project", "fresh_checker");
  });
});

async function createInspectionFixtureProject(): Promise<string> {
  const projectDir = await createTempDir();

  await writeProjectFile(projectDir, STELE_CONFIG_FILE, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  await writeProjectFile(
    projectDir,
    "contract/main.stele",
    [
      "(checker approved_checker",
      '  (description "Checker for settlement approvals."))',
      "",
      "(invariant PAYMENT_BASELINE",
      "  (severity high)",
      '  (description "Baseline rule used as a dependency target.")',
      "  (assert (eq 1 1)))",
      "",
      "(invariant ROOT_PAYMENT_BALANCE",
      "  (severity critical)",
      '  (description "Payments remain balanced before settlement.")',
      "  (category data-integrity)",
      '  (tags payment :priority "batch window")',
      '  (rationale "Preserve the accounting invariant before settlement.")',
      "  (depends-on PAYMENT_BASELINE)",
      "  (assert (eq 1 1)))",
      "",
      "(invariant COMMENT_RULE",
      "  (severity high)",
      "  ; note: this comment mentions ) and should not end the invariant",
      '  (description "Comment rule with ) and ; inside the string.")',
      '  (rationale "Rationale keeps ) and ; as literal text.")',
      "  (assert (eq 1 1)))",
      "",
      "(invariant TSV_RULE",
      "  (severity high)",
      '  (description "Tabbed\\\\path\\tline\\nnext\\rreturn")',
      "  (assert (eq 1 1)))",
      "",
      "(group batch-reconciliation",
      '  (description "Group for settlement checks.")',
      "  (invariant GROUP_CHECKED_SETTLEMENT",
      "    (severity medium)",
      '    (description "Settlement batches require an approved checker.")',
      "    (category (domain ledger))",
      "    (tags payment (scope nightly) 7)",
      "    (uses-checker approved_checker)))",
    ].join("\n") + "\n",
  );
  await writeProjectFile(
    projectDir,
    "contract/checker_impls/approved_checker.py",
    "def approved_checker(context):\n    return {\"passed\": True, \"message\": None}\n",
  );
  await writeProjectFile(
    projectDir,
    "tests/contract/conftest.py",
    "import pytest\n\n@pytest.fixture\ndef stele_context():\n    return {}\n",
  );

  return projectDir;
}

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "stele-cli-"));
  tempDirs.push(directory);
  return directory;
}

async function writeProjectFile(projectDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = join(projectDir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

async function expectListOutput(projectDir: string, options: { severity?: string; category?: string; tag?: string }, lines: string[]) {
  const stdout = captureStdout();
  await runList(projectDir, options);
  expect(stdout.read()).toBe(`${lines.join("\n")}\n`);
}

function captureStdout(): { read(): string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write);
  return {
    read: () => chunks.join(""),
  };
}

function captureStderr(): { read(): string } {
  const chunks: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write);
  return {
    read: () => chunks.join(""),
  };
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
