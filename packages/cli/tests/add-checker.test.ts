import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAddChecker } from "../src/commands/addChecker.js";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE } from "../src/config/defaults.js";

const tempDirs: string[] = [];

describe("runAddChecker", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("exports runAddChecker function", () => {
    expect(typeof runAddChecker).toBe("function");
  });

  it("creates checker file with valid checker id", async () => {
    const projectDir = await createFixtureProject();
    const stdout = captureStdout();

    await runAddChecker(projectDir, "my_check");

    const checkerPath = join(projectDir, DEFAULT_CONFIG.checkerImplDir, "my_check.py");
    const content = await readFile(checkerPath, "utf8");
    expect(content).toContain("def check(inputs: dict) -> dict:");
    expect(content).toContain('"passed": False');
    expect(content).toContain('"message": "Checker implementation has not been approved yet."');
    expect(stdout.read()).toContain("(checker my_check");
  });

  it("converts hyphenated checker id to underscore for Python module name", async () => {
    const projectDir = await createFixtureProject();
    const stdout = captureStdout();

    await runAddChecker(projectDir, "my-checker");

    const checkerPath = join(projectDir, DEFAULT_CONFIG.checkerImplDir, "my_checker.py");
    const content = await readFile(checkerPath, "utf8");
    expect(content).toContain("def check(inputs: dict) -> dict:");
    expect(stdout.read()).toContain("(checker my-checker");
  });

  it("throws for invalid checker id starting with number", async () => {
    const projectDir = await createFixtureProject();

    await expect(runAddChecker(projectDir, "1invalid")).rejects.toThrow(/Invalid checker id/);
  });

  it("throws for invalid checker id with special characters", async () => {
    const projectDir = await createFixtureProject();

    await expect(runAddChecker(projectDir, "my checker!")).rejects.toThrow(/Invalid checker id/);
  });

  it("throws for empty checker id", async () => {
    const projectDir = await createFixtureProject();

    await expect(runAddChecker(projectDir, "")).rejects.toThrow(/Invalid checker id/);
  });

  it("throws when stele.config.json is missing", async () => {
    const projectDir = await createTempDir();

    await expect(runAddChecker(projectDir, "valid_id")).rejects.toThrow();
  });

  it("throws on duplicate checker id via module collision detection", async () => {
    const projectDir = await createFixtureProject();
    const stdout1 = captureStdout();

    await runAddChecker(projectDir, "dup_checker");

    const stdout2 = captureStdout();
    await expect(runAddChecker(projectDir, "dup_checker")).rejects.toThrow(/would collide/);
    void stdout1;
    void stdout2;
  });

  it("throws when checker would collide with pre-existing .py file", async () => {
    const projectDir = await createFixtureProject();
    const implDir = join(projectDir, DEFAULT_CONFIG.checkerImplDir);
    await mkdir(implDir, { recursive: true });
    await writeFile(join(implDir, "blocked.py"), 'def check(): pass\n', "utf8");

    await expect(runAddChecker(projectDir, "blocked")).rejects.toThrow(/would collide/);
  });

  it("writes CDL declaration to stdout", async () => {
    const projectDir = await createFixtureProject();
    const stdout = captureStdout();

    await runAddChecker(projectDir, "new_checker");

    const output = stdout.read();
    expect(output).toContain("(checker new_checker");
    expect(output).toContain('(description "TODO: describe what this checker validates.")');
  });

  it("creates checker directory if it does not exist", async () => {
    const projectDir = await createTempDir();
    await writeFile(
      join(projectDir, STELE_CONFIG_FILE),
      JSON.stringify({
        ...DEFAULT_CONFIG,
        checkerImplDir: "contract/deep/nested/checker_impls",
        manifestPath: "contract/.manifest.json",
      }),
      "utf8",
    );
    await mkdir(join(projectDir, "contract"), { recursive: true });
    const stdout = captureStdout();

    await runAddChecker(projectDir, "deep_checker");

    const checkerPath = join(projectDir, "contract", "deep", "nested", "checker_impls", "deep_checker.py");
    const content = await readFile(checkerPath, "utf8");
    expect(content).toContain("def check(inputs: dict) -> dict:");
    expect(stdout.read()).toContain("(checker deep_checker");
  });

  it("accepts checker id with underscores and numbers", async () => {
    const projectDir = await createFixtureProject();
    const stdout = captureStdout();

    await runAddChecker(projectDir, "valid_123_check");

    const checkerPath = join(projectDir, DEFAULT_CONFIG.checkerImplDir, "valid_123_check.py");
    const content = await readFile(checkerPath, "utf8");
    expect(content).toContain("def check(inputs: dict) -> dict:");
    expect(stdout.read()).toContain("(checker valid_123_check");
  });

  it("accepts checker id with hyphens", async () => {
    const projectDir = await createFixtureProject();
    const stdout = captureStdout();

    await runAddChecker(projectDir, "hyphenated-checker");

    const checkerPath = join(projectDir, DEFAULT_CONFIG.checkerImplDir, "hyphenated_checker.py");
    const content = await readFile(checkerPath, "utf8");
    expect(content).toContain("def check(inputs: dict) -> dict:");
    expect(stdout.read()).toContain("(checker hyphenated-checker");
  });
});

async function createFixtureProject(): Promise<string> {
  const projectDir = await createTempDir();

  await writeProjectFile(
    projectDir,
    STELE_CONFIG_FILE,
    JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n",
  );
  await writeProjectFile(
    projectDir,
    "contract/main.stele",
    [
      "(checker sample_checker",
      '  (description "Sample checker for testing."))',
      "",
      "(invariant SAMPLE_CHECK",
      "  (severity high)",
      '  (description "Sample invariant.")',
      "  (assert (eq 1 1)))",
    ].join("\n") + "\n",
  );
  await writeProjectFile(
    projectDir,
    "tests/contract/conftest.py",
    "import pytest\n",
  );
  return projectDir;
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stele-add-checker-test-"));
  tempDirs.push(dir);
  return dir;
}

async function writeProjectFile(projectDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = join(projectDir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
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
