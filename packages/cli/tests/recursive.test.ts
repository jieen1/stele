import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE } from "../src/config/defaults.js";
import { runCheckRecursive } from "../src/commands/check.js";
import { runGenerateRecursive } from "../src/commands/generate.js";
import { runLockRecursive } from "../src/commands/lock.js";
import { aggregateExitCode, type SubReport } from "../src/commands/recursive.js";
import { discoverProjects } from "../src/recursive-discovery.js";

const tempDirs: string[] = [];

describe("recursive-discovery", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("finds nested stele.config.json files", async () => {
    const root = await createTempDir();
    await writeProjectFile(join(root, "packages/a"), STELE_CONFIG_FILE, "{}\n");
    await writeProjectFile(join(root, "packages/b"), STELE_CONFIG_FILE, "{}\n");

    const projects = await discoverProjects(root);

    expect(projects).toEqual([join(root, "packages/a"), join(root, "packages/b")]);
  });

  it("does not descend into a project once stele.config.json is found", async () => {
    const root = await createTempDir();
    await writeProjectFile(join(root, "a"), STELE_CONFIG_FILE, "{}\n");
    await writeProjectFile(join(root, "a/internal"), STELE_CONFIG_FILE, "{}\n");

    const projects = await discoverProjects(root);

    expect(projects).toEqual([join(root, "a")]);
    expect(projects).not.toContain(join(root, "a/internal"));
  });

  it("skips ignored directories (node_modules, .git, .venv, dist, build, etc.)", async () => {
    const root = await createTempDir();

    for (const ignored of ["node_modules", ".git", ".venv", "dist", "build", "coverage", ".next", ".cache", "__pycache__"]) {
      await writeProjectFile(join(root, ignored, "stele.config.json"), STELE_CONFIG_FILE, "{}\n");
    }
    await writeProjectFile(join(root, "real"), STELE_CONFIG_FILE, "{}\n");

    const projects = await discoverProjects(root);

    expect(projects).toEqual([join(root, "real")]);
  });

  it("skips other dot-prefixed directories", async () => {
    const root = await createTempDir();
    await writeProjectFile(join(root, ".hidden"), STELE_CONFIG_FILE, "{}\n");
    await writeProjectFile(join(root, "visible"), STELE_CONFIG_FILE, "{}\n");

    const projects = await discoverProjects(root);

    expect(projects).toEqual([join(root, "visible")]);
  });

  it("returns the empty list when no projects exist", async () => {
    const root = await createTempDir();

    const projects = await discoverProjects(root);

    expect(projects).toEqual([]);
  });

  it("returns lex-sorted results regardless of filesystem order", async () => {
    const root = await createTempDir();
    await writeProjectFile(join(root, "z-last"), STELE_CONFIG_FILE, "{}\n");
    await writeProjectFile(join(root, "a-first"), STELE_CONFIG_FILE, "{}\n");
    await writeProjectFile(join(root, "m-middle"), STELE_CONFIG_FILE, "{}\n");

    const projects = await discoverProjects(root);

    expect(projects).toEqual([join(root, "a-first"), join(root, "m-middle"), join(root, "z-last")]);
  });
});

describe("aggregateExitCode", () => {
  it("returns 0 for all-passing", () => {
    expect(aggregateExitCode([fakeReport(0), fakeReport(0)])).toBe(0);
  });

  it("returns 1 if any project exits 1, even when others have 2/3", () => {
    expect(aggregateExitCode([fakeReport(0), fakeReport(2), fakeReport(1), fakeReport(3)])).toBe(1);
  });

  it("returns max(2,3) of remaining when no exit 1 and any 2/3", () => {
    expect(aggregateExitCode([fakeReport(0), fakeReport(2), fakeReport(3)])).toBe(3);
    expect(aggregateExitCode([fakeReport(2), fakeReport(2)])).toBe(2);
  });

  it("returns max non-zero exit code when no 1/2/3 results", () => {
    expect(aggregateExitCode([fakeReport(0), fakeReport(4), fakeReport(5)])).toBe(5);
  });

  it("treats single-project all-pass as 0", () => {
    expect(aggregateExitCode([fakeReport(0)])).toBe(0);
  });
});

describe("runCheckRecursive", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("throws E_NO_PROJECTS_FOUND when no projects under root", async () => {
    const root = await createTempDir();
    const stdout: string[] = [];
    const stderr: string[] = [];

    const error = await runCheckRecursive(root, {}, {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    }).catch((thrown: Error) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe("E_NO_PROJECTS_FOUND");
    expect((error as Error).message).toContain("No stele.config.json found under");
  });

  it("invokes single-project check across each discovered project and aggregates exit codes", async () => {
    const root = await createTempDir();
    await createPythonProject(join(root, "packages/a"));
    await createPythonProject(join(root, "packages/b"));

    const stdout: string[] = [];
    const stderr: string[] = [];

    const result = await runCheckRecursive(root, {}, {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });

    // Both projects have ungenerated tests → drift (exit 2 CONTRACT_FAIL or 3 TAMPER_DETECTED).
    expect(result.subReports).toHaveLength(2);
    expect(result.subReports[0].project).toBe(join(root, "packages/a"));
    expect(result.subReports[1].project).toBe(join(root, "packages/b"));
    // Both fail with the same kind of drift; aggregate should match.
    expect(result.exitCode).toBeGreaterThan(0);
    expect(stdout.join("")).toContain("Found 2 projects");
  });

  it("emits aggregate JSON with --json", async () => {
    const root = await createTempDir();
    await createPythonProject(join(root, "packages/a"));

    const stdout: string[] = [];
    const stderr: string[] = [];

    const result = await runCheckRecursive(root, { json: true }, {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });

    expect(result.jsonOutput).toBeDefined();
    const parsed = JSON.parse(result.jsonOutput!);
    expect(parsed.schema_version).toBe("1");
    expect(parsed.tool).toBe("@stele/cli");
    expect(parsed.command).toBe("check");
    expect(parsed.cwd).toBe(root);
    expect(parsed.projects).toHaveLength(1);
    expect(parsed.projects[0].project).toBe(join(root, "packages/a"));
    expect(parsed.max_exit_code).toBe(result.exitCode);
    expect(typeof parsed.passed).toBe("number");
    expect(typeof parsed.failed).toBe("number");
    expect(typeof parsed.generated_at).toBe("string");
  });

  it("does not write human header when --json is set", async () => {
    const root = await createTempDir();
    await createPythonProject(join(root, "a"));

    const stdout: string[] = [];
    const stderr: string[] = [];

    await runCheckRecursive(root, { json: true }, {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });

    const text = stdout.join("");
    expect(text).not.toContain("Found 1 project");
    expect(text).not.toContain("checking ");
  });

  it("aggregate exit code prioritizes 1 over drift codes (mocked)", () => {
    // pure aggregateExitCode test with mixed reports
    const reports: SubReport[] = [
      { project: "/a", exit_code: 0, summary: { violation_count: 0 } },
      { project: "/b", exit_code: 2, summary: { violation_count: 2 } },
      { project: "/c", exit_code: 1, summary: { violation_count: 0 }, error: { message: "boom" } },
    ];
    expect(aggregateExitCode(reports)).toBe(1);
  });
});

describe("runGenerateRecursive", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("throws E_NO_PROJECTS_FOUND when nothing under root", async () => {
    const root = await createTempDir();
    const stdout: string[] = [];
    const stderr: string[] = [];

    const error = await runGenerateRecursive(root, {}, {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    }).catch((thrown: Error) => thrown);

    expect((error as { code?: string }).code).toBe("E_NO_PROJECTS_FOUND");
  });

  it("generates for each discovered project (heterogeneous backends)", async () => {
    const root = await createTempDir();
    await createPythonProject(join(root, "py-project"));
    await createTypescriptProject(join(root, "ts-project"));

    const stdout: string[] = [];
    const stderr: string[] = [];

    const result = await runGenerateRecursive(root, {}, {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });

    expect(result.subReports).toHaveLength(2);
    expect(result.subReports[0].project).toBe(join(root, "py-project"));
    expect(result.subReports[1].project).toBe(join(root, "ts-project"));
    expect(result.subReports.every((report) => report.exit_code === 0)).toBe(true);
    expect(result.exitCode).toBe(0);
  });
});

describe("runLockRecursive", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("locks each discovered project after generation", async () => {
    const root = await createTempDir();
    await createPythonProject(join(root, "a"));
    await createPythonProject(join(root, "b"));

    // First generate so that lock will succeed.
    const stdout1: string[] = [];
    const stderr1: string[] = [];
    await runGenerateRecursive(root, {}, {
      stdout: (chunk) => stdout1.push(chunk),
      stderr: (chunk) => stderr1.push(chunk),
    });

    const stdout2: string[] = [];
    const stderr2: string[] = [];
    const result = await runLockRecursive(root, { reason: "test reason" }, {
      stdout: (chunk) => stdout2.push(chunk),
      stderr: (chunk) => stderr2.push(chunk),
    });

    expect(result.subReports).toHaveLength(2);
    expect(result.subReports.every((report) => report.exit_code === 0)).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("throws E_NO_PROJECTS_FOUND when nothing under root", async () => {
    const root = await createTempDir();
    const stdout: string[] = [];
    const stderr: string[] = [];

    const error = await runLockRecursive(root, { reason: "x" }, {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    }).catch((thrown: Error) => thrown);

    expect((error as { code?: string }).code).toBe("E_NO_PROJECTS_FOUND");
  });
});

function fakeReport(exit_code: number): SubReport {
  return { project: "/x", exit_code, summary: { violation_count: 0 } };
}

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "stele-recursive-"));
  tempDirs.push(directory);
  return directory;
}

async function writeProjectFile(projectDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = join(projectDir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

async function createPythonProject(projectDir: string): Promise<void> {
  await writeProjectFile(projectDir, STELE_CONFIG_FILE, `${JSON.stringify({ ...DEFAULT_CONFIG, targetLanguage: "python", testFramework: "pytest" }, null, 2)}\n`);
  await writeProjectFile(
    projectDir,
    "contract/main.stele",
    [
      "(invariant ROOT_RULE",
      "  (severity high)",
      '  (description "Root rule.")',
      "  (assert (eq 1 1)))",
    ].join("\n"),
  );
  await writeProjectFile(
    projectDir,
    "tests/contract/conftest.py",
    "import pytest\n\n@pytest.fixture\ndef stele_context():\n    return {}\n",
  );
}

async function createTypescriptProject(projectDir: string): Promise<void> {
  await writeProjectFile(
    projectDir,
    STELE_CONFIG_FILE,
    `${JSON.stringify(
      {
        ...DEFAULT_CONFIG,
        targetLanguage: "typescript",
        testFramework: "vitest",
        protected: [
          "contract/**/*.stele",
          "contract/checker_impls/**/*",
          "contract/.baseline.json",
          "contract/.manifest.json",
          "tests/contract/**/*",
        ],
      },
      null,
      2,
    )}\n`,
  );
  await writeProjectFile(
    projectDir,
    "contract/main.stele",
    [
      "(invariant ROOT_RULE",
      "  (severity high)",
      '  (description "Root rule.")',
      "  (assert (eq 1 1)))",
    ].join("\n"),
  );
}
