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
      "This file is protected by Stele. Use /stele:add or ask the user to approve a contract update.",
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

  it("allows contract directories and non-stele files that are not subtree-protected roots", async () => {
    const projectDir = await createProject();

    expectAllowed(
      runHook(projectDir, {
        tool_input: {
          path: "contract",
        },
      }),
    );
    expectAllowed(
      runHook(projectDir, {
        tool_input: {
          path: "contract/modules",
        },
      }),
    );
    expectAllowed(
      runHook(projectDir, {
        tool_input: {
          path: "contract/notes.txt",
        },
      }),
    );
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
    expectDenied(
      runHook(projectDir, {
        tool_input: {
          path: "contract/modules/rules.stele",
        },
      }),
    );
  });

  it("denies protected directory roots for checker implementations and generated tests", async () => {
    const projectDir = await createProject();

    expectDenied(
      runHook(projectDir, {
        tool_input: {
          path: "contract/checker_impls",
        },
      }),
    );
    expectDenied(
      runHook(projectDir, {
        input: {
          path: "tests/contract",
        },
      }),
    );
  });

  it("denies absolute protected directory roots inside the project", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      tool_input: {
        path: join(projectDir, "contract", "checker_impls"),
      },
    });

    expectDenied(result);
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

  windowsOnly("denies Windows namespaced absolute protected paths", async () => {
    const projectDir = await createProject();
    const result = runHook(projectDir, {
      tool_input: {
        path: toWindowsDevicePath(join(projectDir, "contract", "main.stele"), "?"),
      },
    });

    expectDenied(result);
  });

  windowsOnly("denies Windows device absolute protected paths", async () => {
    const projectDir = await createProject();
    const result = runHook(projectDir, {
      tool_input: {
        path: toWindowsDevicePath(join(projectDir, "contract", "main.stele"), "."),
      },
    });

    expectDenied(result);
  });

  windowsOnly("denies Windows namespaced protected directory roots", async () => {
    const projectDir = await createProject();
    const result = runHook(projectDir, {
      tool_input: {
        path: toWindowsDevicePath(join(projectDir, "tests", "contract"), "?"),
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

  it("denies subtree roots derived from custom wildcard protected globs while leaving the parent directory alone", async () => {
    const projectDir = await createProject({
      protected: ["docs/*/**/*"],
    });

    expectDenied(
      runHook(projectDir, {
        tool_input: {
          path: "docs/api",
        },
      }),
    );
    expectDenied(
      runHook(projectDir, {
        tool_input: {
          path: "docs/other",
        },
      }),
    );
    expectAllowed(
      runHook(projectDir, {
        tool_input: {
          path: "docs",
        },
      }),
    );
    expectDenied(
      runHook(projectDir, {
        tool_input: {
          path: "docs/api/readme.txt",
        },
      }),
    );
    expectAllowed(
      runHook(projectDir, {
        tool_input: {
          path: "docs-api",
        },
      }),
    );
    expectAllowed(
      runHook(projectDir, {
        tool_input: {
          path: "documentation/api",
        },
      }),
    );
  });

  it("matches brace-based custom protected globs the same way as the CLI", async () => {
    const projectDir = await createProject({
      protected: ["docs/{api,other}/**/*"],
    });

    expectDenied(
      runHook(projectDir, {
        tool_input: {
          path: "docs/api",
        },
      }),
    );
    expectDenied(
      runHook(projectDir, {
        tool_input: {
          path: "docs/other",
        },
      }),
    );
    expectAllowed(
      runHook(projectDir, {
        tool_input: {
          path: "docs",
        },
      }),
    );
    expectDenied(
      runHook(projectDir, {
        tool_input: {
          path: "docs/api/readme.txt",
        },
      }),
    );
    expectDenied(
      runHook(projectDir, {
        tool_input: {
          path: "docs/other/readme.txt",
        },
      }),
    );
    expectAllowed(
      runHook(projectDir, {
        tool_input: {
          path: "docs/public/readme.txt",
        },
      }),
    );
    expectAllowed(
      runHook(projectDir, {
        tool_input: {
          path: "documentation/api/readme.txt",
        },
      }),
    );
  });

  it("denies default protected files when config omits the protected field", async () => {
    const projectDir = await createProject({
      protected: undefined,
      omitProtected: true,
    });

    const result = runHook(projectDir, {
      tool_input: {
        file_path: "contract/main.stele",
      },
    });

    expectDenied(result);
  });

  it("allows protected targets when config explicitly sets protected to an empty array", async () => {
    const projectDir = await createProject({
      protected: [],
    });

    const result = runHook(projectDir, {
      tool_input: {
        file_path: "contract/main.stele",
      },
    });

    expectAllowed(result);
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

  it("denies protected Bash write targets across common redirect shapes", async () => {
    const projectDir = await createProject();

    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "cat > contract/main.stele <<'EOF'\ncontent\nEOF",
        },
      }),
    );
    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "cat <<'EOF' > tests/contract/test_contract.py\ncontent\nEOF",
        },
      }),
    );
    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "printf 'x' > contract/checker_impls/custom_checker.py",
        },
      }),
    );
    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "echo x >> contract/.manifest.json",
        },
      }),
    );
    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "tee contract/main.stele",
        },
      }),
    );
    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "tee -a contract/main.stele",
        },
      }),
    );
  });

  it("denies protected Bash write targets when the path is quoted", async () => {
    const projectDir = await createProject();

    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: 'cat > "contract/main.stele" <<\'EOF\'\ncontent\nEOF',
        },
      }),
    );
    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "tee 'tests/contract/test_contract.py'",
        },
      }),
    );
  });

  it("denies protected Bash write targets when redirection has no separating whitespace", async () => {
    const projectDir = await createProject();

    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "cat >contract/main.stele <<'EOF'\ncontent\nEOF",
        },
      }),
    );
    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "echo x >>contract/.manifest.json",
        },
      }),
    );
    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "cat 1>contract/main.stele <<'EOF'\ncontent\nEOF",
        },
      }),
    );
    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "echo err 2>>tests/contract/test_contract.py",
        },
      }),
    );
  });

  it("ignores comment text that mentions protected write targets", async () => {
    const projectDir = await createProject();

    expectAllowed(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "echo ok # > contract/main.stele",
        },
      }),
    );
    expectAllowed(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "grep x README.md # tee contract/main.stele",
        },
      }),
    );
    expectAllowed(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "printf '# not a comment' > src/app.py",
        },
      }),
    );
  });

  it("does not deny Bash commands that do not write protected files", async () => {
    const projectDir = await createProject();

    expectAllowed(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "cat contract/main.stele",
        },
      }),
    );
    expectAllowed(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "grep contract/main.stele README.md",
        },
      }),
    );
    expectAllowed(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "echo x > src/app.py",
        },
      }),
    );
    expectAllowed(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "printf '%s' contract/main.stele",
        },
      }),
    );
  });

  it("allows sibling prefixes outside protected directory roots", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      tool_input: {
        file_path: "tests/contractor/report.txt",
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

  it("does not allow non-cache files just because a protected path contains __pycache__", async () => {
    const projectDir = await createProject({
      protected: ["contract/**"],
    });

    const result = runHook(projectDir, {
      tool_input: {
        file_path: "contract/__pycache__/evil.py",
      },
    });

    expectDenied(result);
  });

  it("allows only real Python cache artifact suffixes inside __pycache__", async () => {
    const projectDir = await createProject({
      protected: ["contract/**"],
    });

    expectAllowed(
      runHook(projectDir, {
        tool_input: {
          file_path: "contract/__pycache__/x.pyc",
        },
      }),
    );
    expectAllowed(
      runHook(projectDir, {
        input: {
          path: "contract/__pycache__/x.pyo",
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

  it("supports UTF-8 BOM config files and still denies default protected targets", async () => {
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
    };

    await writeProjectFile(projectDir, "stele.config.json", `\uFEFF${JSON.stringify(config, null, 2)}\n`);

    const result = runHook(projectDir, {
      tool_input: {
        file_path: "contract/main.stele",
      },
    });

    expectDenied(result);
  });

  it("fails closed when stele.config.json is malformed", async () => {
    const projectDir = await createTempDir();
    await writeProjectFile(projectDir, "stele.config.json", "{ invalid json\n");

    const result = runRawHook(projectDir, '{"tool_input":{"file_path":"contract/main.stele"}}\n');

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unable to parse Stele config");
  });

  it("fails closed when protected config contains non-string entries", async () => {
    const projectDir = await createProject({
      protected: [42, true, null],
    });

    const result = runHook(projectDir, {
      tool_input: {
        file_path: "contract/main.stele",
      },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid protected config");
  });

  it("fails closed when protected config contains whitespace-only entries", async () => {
    const projectDir = await createProject({
      protected: ["   "],
    });

    const result = runHook(projectDir, {
      tool_input: {
        file_path: "contract/main.stele",
      },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid protected config");
  });

  it("fails closed when protected config is not an array", async () => {
    const projectDir = await createProject({
      protected: "contract/**",
    });

    const result = runHook(projectDir, {
      tool_input: {
        file_path: "contract/main.stele",
      },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid protected config");
  });

  it("fails closed when protected config uses unsupported bracket glob syntax", async () => {
    const projectDir = await createProject({
      protected: ["docs/[a-z].md"],
    });

    const result = runHook(projectDir, {
      tool_input: {
        file_path: "docs/a.md",
      },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unsupported glob pattern");
  });

  it("fails closed when protected config uses absolute or project-escaping patterns", async () => {
    for (const protectedPattern of ["C:\\contract\\**", "/contract/**", "../contract/**", "contract/../secrets/**"]) {
      const projectDir = await createProject({
        protected: [protectedPattern],
      });

      const result = runHook(projectDir, {
        tool_input: {
          file_path: "contract/main.stele",
        },
      });

      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("invalid protected config");
    }
  });

  it("fails closed when hook stdin JSON is malformed", async () => {
    const projectDir = await createProject();

    const result = runRawHook(projectDir, "{invalid\n");

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unable to parse Claude hook input");
  });
});

async function createProject(overrides: { protected?: unknown; omitProtected?: boolean } = {}): Promise<string> {
  const projectDir = await createTempDir();
  const config: Record<string, unknown> = {
    version: "0.1",
    contractDir: "contract",
    entry: "contract/main.stele",
    generatedDir: "tests/contract",
    checkerImplDir: "contract/checker_impls",
    manifestPath: "contract/.manifest.json",
    targetLanguage: "python",
    testFramework: "pytest",
    pathMode: "auto",
  };

  if (!overrides.omitProtected) {
    config.protected = overrides.protected ?? [
      "contract/**/*.stele",
      "contract/checker_impls/**/*",
      "contract/.manifest.json",
      "tests/contract/**/*",
    ];
  }

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
  return runRawHook(projectDir, `${JSON.stringify(payload)}\n`);
}

function runRawHook(projectDir: string, input: string) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: pluginDir,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
    },
    input,
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

function toWindowsDevicePath(absolutePath: string, prefixMarker: "?" | "."): string {
  if (absolutePath.startsWith("\\\\")) {
    return `\\\\${prefixMarker}\\UNC\\${absolutePath.slice(2)}`;
  }

  return `\\\\${prefixMarker}\\${absolutePath}`;
}
