import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(pluginDir, "scripts", "pre-tool-protect.js");
const windowsOnly = process.platform === "win32" ? it : it.skip;
const protectedReason = [
  "This file is protected by Stele.",
  "Prefer fixing ordinary source code, fixtures, or scenario setup before changing protected contract material.",
  "Before changing protected files, answer:",
  "1. Is the existing contract still correct and my source change wrong?",
  "2. Can I satisfy the contract without editing contract/, tests/contract/, manifest, or baseline files?",
  "3. Has the user explicitly approved a contract change after reviewing the affected protected files?",
  "For new invariant knowledge, use the CLI command `stele propose invariant --id <id> --severity <error|warning|info> --description <text> --assert <cdl> --apply`.",
  "For modifying or deleting existing protected rules, stop and ask the user to review the contract change.",
  "Do not use a skill invocation for this; this plugin exposes CLI commands and slash-command docs, not a callable add skill.",
].join("\n");
const protectedRepeatReason =
  "Protected Stele edit is still blocked; detailed guidance was already shown earlier in this session. Ask the user to review the contract change, or add new invariant knowledge with `stele propose invariant --id <id> --severity <error|warning|info> --description <text> --assert <cdl> --apply`. Do not use a skill invocation for this.";
const denyResponse = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: protectedReason,
  },
};

describe("pre-tool-protect hook", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  // @tcb-negative @stele/claude-code-plugin
  it("denies the default protected stele entry file from tool_input.file_path", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      tool_input: {
        file_path: "contract/main.stele",
      },
    });

    expectDenied(result);
  });

  it("does not repeat the long protected-edit guidance in the same session", async () => {
    const projectDir = await createProject();
    const payload = {
      session_id: "session-1",
      tool_input: {
        file_path: "contract/main.stele",
      },
    };

    const first = runHook(projectDir, payload);
    const second = runHook(projectDir, payload);

    expectDenied(first);
    expectDeniedWithReason(second, protectedRepeatReason);
    expect(second.stdout).not.toContain("Before changing protected files, answer:");
    expect(first.stdout).not.toContain("/stele:add");
    expect(second.stdout).not.toContain("/stele:add");
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

  it("default-protected files stay protected even when config sets protected to an empty array", async () => {
    // Round 3 Reviewer G P0-3: protected config UNIONS with DEFAULT_PROTECTED;
    // it never replaces. An adopter that ships `protected: []` (or simply omits
    // a path from their array) can no longer accidentally drop security-critical
    // paths like contract/main.stele, hook scripts, or stele.config.json from
    // the glob. Replacing semantics was the single biggest kill-switch path
    // discovered during the Round 3 implementation review.
    const projectDir = await createProject({
      protected: [],
    });

    const result = runHook(projectDir, {
      tool_input: {
        file_path: "contract/main.stele",
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

  it("denies protected-file DELETION / move-away vectors (rm, mv, git rm, clobber, find)", async () => {
    const projectDir = await createProject();
    const deny = (command: string) =>
      expectDenied(runHook(projectDir, { tool_name: "Bash", tool_input: { command } }));

    deny("rm -f contract/main.stele");
    deny("rm -rf contract/checker_impls");
    deny("rm a.txt contract/.manifest.json"); // protected not last → all-args scan
    deny("rmdir tests/contract");
    deny("unlink contract/.manifest.json");
    deny("mv contract/main.stele /tmp/evil"); // moving a protected file away = delete
    deny("git rm -f contract/main.stele");
    deny("git mv contract/main.stele /tmp/x");
    deny("echo x >| contract/main.stele"); // force-clobber redirect
    deny("rm -rf contract/generated"); // fully-protected subtree root
    deny("find contract/generated -delete"); // find -delete over a fully-protected root
  });

  it("does NOT over-deny deletion of non-protected paths", async () => {
    const projectDir = await createProject();
    const allow = (command: string) =>
      expectAllowed(runHook(projectDir, { tool_name: "Bash", tool_input: { command } }));

    allow("rm -f /tmp/scratch.txt");
    allow("rm -rf docs");
    allow("mv a.txt b.txt");
    allow("find docs -name x -delete");
    allow("find contract -name x.stele"); // read-only find (no -delete/-exec)
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

  it("denies protected Bash write targets via cp, mv, and install commands", async () => {
    const projectDir = await createProject();

    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "cp source_file contract/main.stele",
        },
      }),
    );
    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "mv source_file contract/main.stele",
        },
      }),
    );
    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "install source_file contract/main.stele",
        },
      }),
    );
    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "cp a b contract/checker_impls/",
        },
      }),
    );
    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "cp -f source_file contract/.manifest.json",
        },
      }),
    );
  });

  it("Round 4 D-06: denies write to a symlink that realpath-resolves to a protected file", async () => {
    const projectDir = await createProject();
    // Pre-create the contract file so realpath has something to resolve to.
    await writeProjectFile(projectDir, "contract/main.stele", "(metadata)\n");
    const protectedAbsolute = join(projectDir, "contract/main.stele");
    const decoyAbsolute = join(projectDir, "decoy");
    await mkdir(dirname(decoyAbsolute), { recursive: true });
    await symlink(protectedAbsolute, decoyAbsolute);
    // The agent supplies the decoy path; pre-realpath that path is
    // "decoy" (not under contract/), so the legacy matchProtectedPath
    // would let it through. With D-06 the realpath puts it inside
    // contract/main.stele and matching denies.
    expectDenied(
      runHook(projectDir, {
        tool_name: "Write",
        tool_input: { file_path: "decoy", content: "x" },
      }),
    );
  });

  it("Round 4 D-05: denies ln -s pointing at a protected file", async () => {
    const projectDir = await createProject();
    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: { command: "ln -s /tmp/malicious contract/main.stele" },
      }),
    );
    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: { command: "ln -sf /tmp/payload .stele/stop-state.json" },
      }),
    );
  });

  it("Round 4 D-05: denies git checkout / git restore on a protected file", async () => {
    const projectDir = await createProject();
    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: { command: "git checkout HEAD -- contract/main.stele" },
      }),
    );
    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: { command: "git restore contract/checker_impls/self_protection.py" },
      }),
    );
  });

  it("Round 4 D-05: denies interpreter -c / -e invocations that look like a protected-file write", async () => {
    const projectDir = await createProject();
    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "python3 -c \"open('.stele/stop-state.json','w').write('x')\"",
        },
      }),
    );
    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "node -e \"require('node:fs').writeFileSync('contract/main.stele','x')\"",
        },
      }),
    );
  });

  it("Round 4 D-05: allows interpreter -c reads that mention a protected file but don't write", async () => {
    const projectDir = await createProject();
    expectAllowed(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "python3 -c \"print(open('contract/main.stele').read())\"",
        },
      }),
    );
  });

  it("Round 4 D-05: denies chmod/chown on a protected file", async () => {
    const projectDir = await createProject();
    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: { command: "chmod 0 contract/main.stele" },
      }),
    );
  });

  it("denies protected Bash write targets via dd of=file", async () => {
    const projectDir = await createProject();

    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "dd if=input of=contract/main.stele",
        },
      }),
    );
    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "dd of=tests/contract/test_contract.py if=/dev/zero",
        },
      }),
    );
  });

  it("denies protected Bash write targets via backslash line continuation", async () => {
    const projectDir = await createProject();

    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "echo data \\\n> contract/main.stele",
        },
      }),
    );
    expectDenied(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "echo data \\\n  >> contract/.manifest.json",
        },
      }),
    );
  });

  it("allows cp, mv, and dd to non-protected paths", async () => {
    const projectDir = await createProject();

    expectAllowed(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "cp source_file src/app.py",
        },
      }),
    );
    expectAllowed(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "mv old_name src/app.py",
        },
      }),
    );
    expectAllowed(
      runHook(projectDir, {
        tool_name: "Bash",
        tool_input: {
          command: "dd of=src/output.bin if=input",
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

  it("fails closed when protected config uses deeply nested bracket glob syntax", async () => {
    const projectDir = await createProject({
      protected: ["docs/[[[a-z]].md"],
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
  expectDeniedWithReason(result, protectedReason);
}

function expectDeniedWithReason(result: ReturnType<typeof runHook>, reason: string) {
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(
    `${JSON.stringify({
      hookSpecificOutput: {
        ...denyResponse.hookSpecificOutput,
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
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
