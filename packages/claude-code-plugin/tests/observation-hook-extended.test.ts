import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(pluginDir, "scripts", "observation-hook.js");
const windowsOnly = process.platform === "win32" ? it : it.skip;

describe("observation hook -- extended", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  /* ------------------------------------------------------------------ */
  /*  1. PreToolUse hook event recording                                */
  /* ------------------------------------------------------------------ */

  it("records PreToolUse hook_event_name correctly", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      hook_event_name: "PreToolUse",
      session_id: "session-pretool",
      tool_name: "Read",
      tool_input: {
        file_path: "src/main.py",
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");

    const observation = JSON.parse(
      (await readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).trim(),
    );
    expect(observation.hook_event_name).toBe("PreToolUse");
  });

  /* ------------------------------------------------------------------ */
  /*  2. Multiple observations in same session (JSONL appends)          */
  /* ------------------------------------------------------------------ */

  it("appends multiple observations to the same JSONL file", async () => {
    const projectDir = await createProject();

    runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "multi-session",
      tool_name: "Edit",
      tool_input: { file_path: "src/a.py" },
    });

    runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "multi-session",
      tool_name: "Edit",
      tool_input: { file_path: "src/b.py" },
    });

    const content = (
      await readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")
    ).trim();
    const lines = content.split("\n");

    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    const second = JSON.parse(lines[1]!);
    expect(first.target_paths).toEqual(["src/a.py"]);
    expect(second.target_paths).toEqual(["src/b.py"]);
  });

  /* ------------------------------------------------------------------ */
  /*  3. Bash read-only commands (material_change: false)               */
  /* ------------------------------------------------------------------ */

  it("marks read-only Bash commands on protected files as material_change: false", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "s3",
      tool_name: "Bash",
      tool_input: {
        command: "cat contract/main.stele",
      },
    });

    expect(result.status).toBe(0);

    // Read-only Bash does not extract write targets, so target_paths is empty
    // and no observation is written (early exit on empty targets).
    await expect(readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).rejects.toThrow();
  });

  /* ------------------------------------------------------------------ */
  /*  4. Bash write commands to protected files (material_change: true) */
  /* ------------------------------------------------------------------ */

  it("marks Bash write to protected files as material_change: true for non-protected redirects", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "s4",
      tool_name: "Bash",
      tool_input: {
        command: "echo data > src/output.txt",
      },
    });

    expect(result.status).toBe(0);

    const observation = JSON.parse(
      (await readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).trim(),
    );
    expect(observation.target_paths).toEqual(["src/output.txt"]);
    expect(observation.material_change).toBe(true);
  });

  /* ------------------------------------------------------------------ */
  /*  5. Bash write commands to non-protected files (material_change: false) */
  /* ------------------------------------------------------------------ */

  it("marks Bash write to non-protected source files as material_change: true", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "s5",
      tool_name: "Bash",
      tool_input: {
        command: "echo data > src/app.py",
      },
    });

    expect(result.status).toBe(0);

    const observation = JSON.parse(
      (await readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).trim(),
    );
    expect(observation.target_paths).toEqual(["src/app.py"]);
    expect(observation.material_change).toBe(true);
  });

  /* ------------------------------------------------------------------ */
  /*  6. cp/mv/dd to protected files (material_change: true)            */
  /* ------------------------------------------------------------------ */

  it("detects cp to protected files and marks material_change: false", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "s6",
      tool_name: "Bash",
      tool_input: {
        command: "cp source contract/main.stele",
      },
    });

    expect(result.status).toBe(0);

    const observation = JSON.parse(
      (await readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).trim(),
    );
    expect(observation.target_paths).toContain("contract/main.stele");
    expect(observation.material_change).toBe(false);
  });

  it("detects mv targets — both the protected dest AND the moved source", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "s6b",
      tool_name: "Bash",
      tool_input: {
        command: "mv old_name contract/main.stele",
      },
    });

    expect(result.status).toBe(0);

    const observation = JSON.parse(
      (await readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).trim(),
    );
    // `mv` now surfaces BOTH endpoints: the protected dest is overwritten and
    // the source `old_name` is removed. Moving a source file is a material
    // change, so material_change is true; the protection layer denies the
    // protected dest separately.
    expect(observation.target_paths).toContain("contract/main.stele");
    expect(observation.target_paths).toContain("old_name");
    expect(observation.material_change).toBe(true);
  });

  it("detects dd of= to protected files and marks material_change: false", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "s6c",
      tool_name: "Bash",
      tool_input: {
        command: "dd if=input of=contract/main.stele",
      },
    });

    expect(result.status).toBe(0);

    const observation = JSON.parse(
      (await readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).trim(),
    );
    expect(observation.target_paths).toContain("contract/main.stele");
    expect(observation.material_change).toBe(false);
  });

  /* ------------------------------------------------------------------ */
  /*  7. Line continuation detection                                    */
  /* ------------------------------------------------------------------ */

  it("detects write targets across backslash line continuation", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "s7",
      tool_name: "Bash",
      tool_input: {
        command: "echo data \\\n> contract/main.stele",
      },
    });

    expect(result.status).toBe(0);

    const observation = JSON.parse(
      (await readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).trim(),
    );
    expect(observation.target_paths).toContain("contract/main.stele");
    expect(observation.material_change).toBe(false);
  });

  /* ------------------------------------------------------------------ */
  /*  8. & background process separator detection                        */
  /* ------------------------------------------------------------------ */

  it("splits on & background separator and extracts write targets from both sides", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "s8",
      tool_name: "Bash",
      tool_input: {
        command: "echo data & echo more > src/output.txt",
      },
    });

    expect(result.status).toBe(0);

    const observation = JSON.parse(
      (await readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).trim(),
    );
    expect(observation.target_paths).toContain("src/output.txt");
    expect(observation.material_change).toBe(true);
  });

  /* ------------------------------------------------------------------ */
  /*  9. Quoted paths in redirects                                      */
  /* ------------------------------------------------------------------ */

  it("strips quotes from redirect target paths", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "s9",
      tool_name: "Bash",
      tool_input: {
        command: 'cat > "contract/main.stele" <<\'EOF\'\ncontent\nEOF',
      },
    });

    expect(result.status).toBe(0);

    const observation = JSON.parse(
      (await readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).trim(),
    );
    // Quoted path should be unquoted in the result
    expect(observation.target_paths).toContain("contract/main.stele");
    expect(observation.target_paths).not.toContain('"contract/main.stele"');
  });

  it("does not match redirect syntax inside quoted strings", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "s9b",
      tool_name: "Bash",
      tool_input: {
        command: 'echo "> contract/main.stele"',
      },
    });

    expect(result.status).toBe(0);

    // The > is inside quotes so it should NOT be treated as a redirect
    await expect(readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).rejects.toThrow();
  });

  /* ------------------------------------------------------------------ */
  /*  10. Heredoc detection                                             */
  /* ------------------------------------------------------------------ */

  it("ignores redirect syntax inside heredoc content", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "s10",
      tool_name: "Bash",
      tool_input: {
        command: "cat > src/output.txt <<'END'\n> contract/main.stele\nEND",
      },
    });

    expect(result.status).toBe(0);

    const observation = JSON.parse(
      (await readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).trim(),
    );
    // Only the real redirect target should appear, not the one in heredoc body
    expect(observation.target_paths).toEqual(["src/output.txt"]);
    expect(observation.target_paths).not.toContain("contract/main.stele");
  });

  /* ------------------------------------------------------------------ */
  /*  11. Session ID recording                                          */
  /* ------------------------------------------------------------------ */

  it("records session_id from the payload", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "my-custom-session-id",
      tool_name: "Edit",
      tool_input: { file_path: "src/main.py" },
    });

    expect(result.status).toBe(0);

    const observation = JSON.parse(
      (await readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).trim(),
    );
    expect(observation.session_id).toBe("my-custom-session-id");
  });

  /* ------------------------------------------------------------------ */
  /*  12. Tool name recording                                           */
  /* ------------------------------------------------------------------ */

  it("records tool_name from the payload", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "s12",
      tool_name: "Write",
      tool_input: { file_path: "src/new.py" },
    });

    expect(result.status).toBe(0);

    const observation = JSON.parse(
      (await readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).trim(),
    );
    expect(observation.tool_name).toBe("Write");
  });

  /* ------------------------------------------------------------------ */
  /*  13. Empty payload handling                                        */
  /* ------------------------------------------------------------------ */

  it("exits cleanly when payload has no target paths", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {});

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");

    // No observation file should be created
    await expect(readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).rejects.toThrow();
  });

  /* ------------------------------------------------------------------ */
  /*  14. Invalid JSON payload handling                                 */
  /* ------------------------------------------------------------------ */

  it("exits cleanly when stdin is invalid JSON", async () => {
    const projectDir = await createProject();

    const result = runRawHook(projectDir, "{bad json\n");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");

    await expect(readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).rejects.toThrow();
  });

  /* ------------------------------------------------------------------ */
  /*  15. Missing session_id fallback to sessionId                       */
  /* ------------------------------------------------------------------ */

  it("falls back to sessionId when session_id is missing", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      sessionId: "fallback-session-id",
      tool_name: "Edit",
      tool_input: { file_path: "src/main.py" },
    });

    expect(result.status).toBe(0);

    const observation = JSON.parse(
      (await readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).trim(),
    );
    expect(observation.session_id).toBe("fallback-session-id");
  });

  /* ------------------------------------------------------------------ */
  /*  16. Config loading -- custom protected patterns                    */
  /* ------------------------------------------------------------------ */

  it("uses custom protected patterns from stele.config.json", async () => {
    const projectDir = await createProject({
      protected: ["contract/**/*.stele", "docs/**/*.md"],
    });

    // docs/guide.md is protected by custom config -> material_change: false
    const result1 = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "s16a",
      tool_name: "Edit",
      tool_input: { file_path: "docs/guide.md" },
    });
    expect(result1.status).toBe(0);

    const obs1 = JSON.parse(
      (await readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).trim(),
    );
    expect(obs1.target_paths).toContain("docs/guide.md");
    expect(obs1.material_change).toBe(false);
  });

  /* ------------------------------------------------------------------ */
  /*  17. Config loading -- missing stele.config.json                    */
  /* ------------------------------------------------------------------ */

  it("exits with status 0 when stele.config.json is missing", async () => {
    const projectDir = await createTempDir();

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "s17",
      tool_name: "Edit",
      tool_input: { file_path: "src/app.py" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");

    // No observation file should be created
    await expect(readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).rejects.toThrow();
  });

  /* ------------------------------------------------------------------ */
  /*  18. Config loading -- malformed JSON falls back to defaults        */
  /* ------------------------------------------------------------------ */

  it("falls back to DEFAULT_PROTECTED when stele.config.json is malformed JSON", async () => {
    const projectDir = await createTempDir();
    await writeProjectFile(projectDir, "stele.config.json", "{ invalid json }");

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "s18",
      tool_name: "Edit",
      tool_input: { file_path: "contract/main.stele" },
    });

    expect(result.status).toBe(0);

    // Falls back to DEFAULT_PROTECTED, so contract/main.stele is protected
    const observation = JSON.parse(
      (await readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).trim(),
    );
    expect(observation.target_paths).toContain("contract/main.stele");
    expect(observation.material_change).toBe(false);
  });

  /* ------------------------------------------------------------------ */
  /*  19. Windows path handling                                         */
  /* ------------------------------------------------------------------ */

  windowsOnly("handles Windows backslash paths in tool_input", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "s19",
      tool_name: "Edit",
      tool_input: {
        file_path: "contract\\main.stele",
      },
    });

    expect(result.status).toBe(0);

    const observation = JSON.parse(
      (await readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).trim(),
    );
    // target_paths stores the raw path; material_change normalizes internally for matching
    expect(observation.target_paths).toContain("contract\\main.stele");
    expect(observation.material_change).toBe(false);
  });

  windowsOnly(
    "rejects Windows backslash paths in Bash write commands for security",
    async () => {
      const projectDir = await createProject();

      const result = runHook(projectDir, {
        hook_event_name: "PostToolUse",
        session_id: "s19b",
        tool_name: "Bash",
        tool_input: {
          command: "echo data > contract\\main.stele",
        },
      });

      expect(result.status).toBe(0);

      // Backslash paths are rejected by parseLiteralShellPath for security,
      // so no write target is extracted and no observation is recorded.
      const observationPath = join(projectDir, ".stele", "agent", "session-observations.jsonl");
      try {
        await readFile(observationPath, "utf8");
        throw new Error("Expected no observation for backslash paths");
      } catch (error) {
        if (error instanceof Error && error.message === "Expected no observation for backslash paths") {
          throw new Error("Backslash paths should not produce observations");
        }
        // ENOENT is expected — no observation written
      }
    },
  );

  /* ------------------------------------------------------------------ */
  /*  20. Path normalization -- relative paths resolved correctly        */
  /* ------------------------------------------------------------------ */

  it("resolves relative paths with .. traversal to the project root", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "s20",
      tool_name: "Edit",
      tool_input: {
        file_path: "src/../contract/main.stele",
      },
    });

    expect(result.status).toBe(0);

    const observation = JSON.parse(
      (await readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).trim(),
    );
    // target_paths stores the raw path; material_change normalizes internally for matching
    expect(observation.target_paths).toContain("src/../contract/main.stele");
    expect(observation.material_change).toBe(false);
  });

  /* ------------------------------------------------------------------ */
  /*  21. Write to .stele directory (material_change: false)             */
  /* ------------------------------------------------------------------ */

  it("marks writes to .stele/ directory as material_change: false", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "s21",
      tool_name: "Bash",
      tool_input: {
        command: "echo data > .stele/agent/config.json",
      },
    });

    expect(result.status).toBe(0);

    const observation = JSON.parse(
      (await readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).trim(),
    );
    expect(observation.target_paths).toContain(".stele/agent/config.json");
    expect(observation.material_change).toBe(false);
  });

  /* ------------------------------------------------------------------ */
  /*  22. Timestamp presence                                            */
  /* ------------------------------------------------------------------ */

  it("includes a valid ISO timestamp in the observation", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "s22",
      tool_name: "Edit",
      tool_input: { file_path: "src/main.py" },
    });

    expect(result.status).toBe(0);

    const observation = JSON.parse(
      (await readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).trim(),
    );
    expect(observation.timestamp).toBeDefined();
    expect(new Date(observation.timestamp)).toBeInstanceOf(Date);
    expect(Number.isNaN(Number(new Date(observation.timestamp)))).toBe(false);
  });

  /* ------------------------------------------------------------------ */
  /*  23. tee command detection                                         */
  /* ------------------------------------------------------------------ */

  it("detects tee write targets and marks material_change correctly", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "s23",
      tool_name: "Bash",
      tool_input: {
        command: "echo data | tee src/output.txt contract/main.stele",
      },
    });

    expect(result.status).toBe(0);

    const observation = JSON.parse(
      (await readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).trim(),
    );
    expect(observation.target_paths).toContain("src/output.txt");
    expect(observation.target_paths).toContain("contract/main.stele");
    // At least one target is protected, but material_change is true if ANY is non-protected
    expect(observation.material_change).toBe(true);
  });

  /* ------------------------------------------------------------------ */
  /*  24. && separator splits segments correctly                        */
  /* ------------------------------------------------------------------ */

  it("splits on && and extracts write targets from each segment", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "s24",
      tool_name: "Bash",
      tool_input: {
        command: "echo a > src/a.txt && echo b > src/b.txt",
      },
    });

    expect(result.status).toBe(0);

    const observation = JSON.parse(
      (await readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).trim(),
    );
    expect(observation.target_paths).toContain("src/a.txt");
    expect(observation.target_paths).toContain("src/b.txt");
    expect(observation.material_change).toBe(true);
  });

  /* ------------------------------------------------------------------ */
  /*  25. Duplicate path deduplication                                  */
  /* ------------------------------------------------------------------ */

  it("deduplicates target paths across tool_input and Bash extraction", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "s25",
      tool_name: "Bash",
      tool_input: {
        file_path: "src/dedup.py",
        command: "echo data > src/dedup.py",
      },
    });

    expect(result.status).toBe(0);

    const observation = JSON.parse(
      (await readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).trim(),
    );
    // src/dedup.py appears in both file_path and the redirect target, but should only appear once
    expect(observation.target_paths).toEqual(["src/dedup.py"]);
  });

  /* ------------------------------------------------------------------ */
  /*  26. >> append redirect detection                                  */
  /* ------------------------------------------------------------------ */

  it("detects >> append redirects to protected files", async () => {
    const projectDir = await createProject();

    const result = runHook(projectDir, {
      hook_event_name: "PostToolUse",
      session_id: "s26",
      tool_name: "Bash",
      tool_input: {
        command: "echo more >> contract/main.stele",
      },
    });

    expect(result.status).toBe(0);

    const observation = JSON.parse(
      (await readFile(join(projectDir, ".stele", "agent", "session-observations.jsonl"), "utf8")).trim(),
    );
    expect(observation.target_paths).toContain("contract/main.stele");
    expect(observation.material_change).toBe(false);
  });
});

/* ==================================================================== */
/*  Helpers                                                              */
/* ==================================================================== */

async function createProject(overrides: { protected?: string[] } = {}): Promise<string> {
  const projectDir = await createTempDir();
  const config = {
    version: "0.1",
    entry: "contract/main.stele",
    protected: overrides.protected ?? [
      "contract/**/*.stele",
      "contract/checker_impls/**/*",
      "contract/.manifest.json",
      "tests/contract/**/*",
    ],
  };
  await writeProjectFile(projectDir, "stele.config.json", JSON.stringify(config, null, 2));
  return projectDir;
}

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "stele-observation-extended-"));
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
