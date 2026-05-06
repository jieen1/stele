import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(pluginDir, "scripts", "lifecycle-context.js");

describe("lifecycle context hook", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("injects Stele agent context at SessionStart without showing noisy hook output", async () => {
    const projectDir = await createProject();
    await writeFakeStele(projectDir, "context from stele");

    const result = runHook(projectDir, {
      hook_event_name: "SessionStart",
      session_id: "session-1",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout);
    expect(payload.suppressOutput).toBe(true);
    expect(payload.hookSpecificOutput).toEqual({
      hookEventName: "SessionStart",
      additionalContext: "context from stele\n",
    });
    await expect(readText(join(projectDir, "stele-args.log"))).resolves.toContain("agent-context");
  });

  it("injects focused context on UserPromptSubmit using git diff files", async () => {
    const projectDir = await createProject();
    await writeFakeStele(projectDir, "focused context");
    await writeProjectFile(projectDir, ".git", "not a real repo");

    const result = runHook(projectDir, {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      prompt: "change payments",
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(payload.hookSpecificOutput.additionalContext).toBe("focused context\n");
    await expect(readText(join(projectDir, "stele-args.log"))).resolves.toContain("agent-context");
  });

  it("injects file-specific context before reading or editing a focused file", async () => {
    const projectDir = await createProject();
    await writeFakeStele(projectDir, "file context");

    const result = runHook(projectDir, {
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: {
        file_path: "src/payments/service.py",
      },
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      additionalContext: "file context\n",
    });
    await expect(readText(join(projectDir, "stele-args.log"))).resolves.toContain("--focus src/payments/service.py");
  });

  it("stays silent when the project has no Stele config", async () => {
    const projectDir = await createTempDir();

    const result = runHook(projectDir, {
      hook_event_name: "SessionStart",
      session_id: "session-1",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});

async function createProject(): Promise<string> {
  const projectDir = await createTempDir();
  await writeProjectFile(
    projectDir,
    "stele.config.json",
    JSON.stringify({
      version: "0.1",
      entry: "contract/main.stele",
      protected: ["contract/**/*.stele", "tests/contract/**/*"],
    }),
  );
  return projectDir;
}

async function writeFakeStele(projectDir: string, stdout: string): Promise<void> {
  const binDir = join(projectDir, "node_modules", ".bin");
  await mkdir(binDir, { recursive: true });
  const fileName = process.platform === "win32" ? "stele.cmd" : "stele";
  const filePath = join(binDir, fileName);
  const content =
    process.platform === "win32"
      ? ["@echo off", `echo %*>> "%CLAUDE_PROJECT_DIR%\\stele-args.log"`, `echo ${stdout}`, "exit /b 0"].join("\r\n")
      : ["#!/bin/sh", 'printf "%s\\n" "$*" >> "$CLAUDE_PROJECT_DIR/stele-args.log"', `printf '%s\\n' '${stdout}'`, "exit 0"].join("\n");

  await writeFile(filePath, content, "utf8");

  if (process.platform !== "win32") {
    await chmod(filePath, 0o755);
  }
}

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "stele-lifecycle-hook-"));
  tempDirs.push(directory);
  return directory;
}

async function writeProjectFile(projectDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = join(projectDir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

async function readText(path: string): Promise<string> {
  return await import("node:fs/promises").then((fs) => fs.readFile(path, "utf8"));
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
