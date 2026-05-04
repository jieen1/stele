import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(pluginDir, "scripts", "pre-tool-protect.js");
const windowsOnly = process.platform === "win32" ? it : it.skip;
const denyResponse = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason:
      "This file is protected by Stele. Use /stele:propose-change or ask the user to approve a contract update.",
  },
};

describe("pre-tool-protect hook", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("denies the default protected stele entry file from tool_input.file_path", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      tool_input: {
        file_path: "contract/main.stele",
      },
    });

    expectDenied(result);
  });

  it("denies checker impl, manifest, and generated files across supported input shapes", async () => {
    const projectDir = await createProject();

    expectDenied(
      runHook(projectDir, {
        tool_input: {
          target_path: "contract/checker_impls/custom_checker.py",
        },
      }),
    );
    expectDenied(
      runHook(projectDir, {
        input: {
          path: "contract/.manifest.json",
        },
      }),
    );
    expectDenied(
      runHook(projectDir, {
        input: {
          notebook_path: "tests/contract/test_contract.py",
        },
      }),
    );
  });

  it("denies normalized traversal targets that resolve to protected files", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      tool_input: {
        path: "contract/../contract/main.stele",
      },
    });

    expectDenied(result);
  });

  it("denies protected targets provided with Windows separators", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      input: {
        path: "contract\\checker_impls\\custom_checker.py",
      },
    });

    expectDenied(result);
  });

  it("denies absolute traversal attempts that walk through a protected root before escaping", async () => {
    const projectDir = await createProject();
    const attemptedPath = `${projectDir}\\contract\\..\\..\\outside.txt`;

    const result = runHook(projectDir, {
      tool_input: {
        path: attemptedPath,
      },
    });

    expectDenied(result);
  });

  windowsOnly("denies protected paths case-insensitively on Windows", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      tool_input: {
        file_path: "CONTRACT\\MAIN.STELE",
      },
    });

    expectDenied(result);
  });

  it("denies custom protected globs like docs markdown", async () => {
    const projectDir = await createProject({
      protected: [
        "contract/**/*.stele",
        "contract/checker_impls/**/*",
        "contract/.manifest.json",
        "tests/contract/**/*",
        "docs/**/*.md",
      ],
    });

    const result = runHook(projectDir, {
      input: {
        path: "docs/guides/setup.md",
      },
    });

    expectDenied(result);
  });

  it("allows unprotected files", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      tool_input: {
        file_path: "src/app.py",
      },
    });

    expectAllowed(result);
  });

  it("allows python cache artifacts under generated and checker directories", async () => {
    const projectDir = await createProject();

    expectAllowed(
      runHook(projectDir, {
        tool_input: {
          file_path: "tests/contract/__pycache__/test_contract.cpython-313-pytest-9.0.2.pyc",
        },
      }),
    );
    expectAllowed(
      runHook(projectDir, {
        input: {
          path: "contract/checker_impls/__pycache__/custom_checker.cpython-313.pyo",
        },
      }),
    );
  });

  it("allows when stele.config.json is missing", async () => {
    const projectDir = await createTempDir();

    const result = runHook(projectDir, {
      tool_input: {
        file_path: "contract/main.stele",
      },
    });

    expectAllowed(result);
  });
});

async function createProject(overrides: { protected?: string[] } = {}): Promise<string> {
  const projectDir = await createTempDir();
  const config = {
    version: "0.1",
    contractDir: "contract",
    entry: "contract/main.stele",
    generatedDir: "tests/contract",
    checkerImplDir: "contract/checker_impls",
    manifestPath: "contract/.manifest.json",
    targetLanguage: "python",
    testFramework: "pytest",
    pathMode: "auto",
    protected: overrides.protected ?? [
      "contract/**/*.stele",
      "contract/checker_impls/**/*",
      "contract/.manifest.json",
      "tests/contract/**/*",
    ],
  };

  await writeProjectFile(projectDir, "stele.config.json", `${JSON.stringify(config, null, 2)}\n`);
  return projectDir;
}

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "stele-plugin-"));
  tempDirs.push(directory);
  return directory;
}

async function writeProjectFile(projectDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = join(projectDir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

function runHook(projectDir: string, payload: unknown) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: pluginDir,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
    },
    input: `${JSON.stringify(payload)}\n`,
    encoding: "utf8",
  });
}

function expectDenied(result: ReturnType<typeof runHook>) {
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(`${JSON.stringify(denyResponse)}\n`);
}

function expectAllowed(result: ReturnType<typeof runHook>) {
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe("");
}
