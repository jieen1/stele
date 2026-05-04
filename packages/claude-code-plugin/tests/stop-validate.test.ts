import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(pluginDir, "scripts", "stop-validate.js");
const windowsOnly = process.platform === "win32" ? it : it.skip;

describe("stop-validate hook", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("runs stele check in CLAUDE_PROJECT_DIR and surfaces stdout and stderr", async () => {
    const projectDir = await createTempDir();
    const binDir = await createFakeSteleCli({
      stdout: "fake stele stdout",
      stderr: "fake stele stderr",
      exitCode: 0,
    });

    const result = runStopHook(projectDir, binDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("fake stele stdout");
    expect(result.stderr).toContain("fake stele stderr");
    await expect(readFile(join(projectDir, "cwd.txt"), "utf8")).resolves.toContain(projectDir);
    await expect(readFile(join(projectDir, "args.txt"), "utf8")).resolves.toContain("check");
  });

  it("blocks Stop with exit 2 when stele check exits non-zero and preserves CLI output", async () => {
    const projectDir = await createTempDir();
    const binDir = await createFakeSteleCli({
      stdout: "failing stele stdout",
      stderr: "failing stele stderr",
      exitCode: 7,
    });

    const result = runStopHook(projectDir, binDir);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("failing stele stdout");
    expect(result.stderr).toContain("failing stele stderr");
    expect(result.stderr).toContain("stele check failed");
  });

  it("blocks Stop with a clear reason when stele cannot be started", async () => {
    const projectDir = await createTempDir();
    const emptyBinDir = await createTempDir();

    const result = runStopHook(projectDir, emptyBinDir);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('Unable to run "stele');
  });

  windowsOnly("runs a .cmd stele shim on Windows without spawn EINVAL", async () => {
    const projectDir = await createTempDir();
    const binDir = await createFakeSteleCli({
      stdout: "windows cmd stdout",
      stderr: "windows cmd stderr",
      exitCode: 7,
    });

    const result = runStopHook(projectDir, binDir);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("windows cmd stdout");
    expect(result.stderr).toContain("windows cmd stderr");
    await expect(readFile(join(projectDir, "cwd.txt"), "utf8")).resolves.toContain(projectDir);
  });
});

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "stele-stop-hook-"));
  tempDirs.push(directory);
  return directory;
}

async function createFakeSteleCli(options: { stdout: string; stderr: string; exitCode: number }): Promise<string> {
  const binDir = await createTempDir();
  const fileName = process.platform === "win32" ? "stele.cmd" : "stele";
  const scriptPath = join(binDir, fileName);
  const scriptContent =
    process.platform === "win32"
      ? [
          "@echo off",
          `echo ${escapeBatchText(options.stdout)}`,
          `echo ${escapeBatchText(options.stderr)} 1>&2`,
          `> \"%CLAUDE_PROJECT_DIR%\\cwd.txt\" echo %CD%`,
          `> \"%CLAUDE_PROJECT_DIR%\\args.txt\" echo %*`,
          `exit /b ${options.exitCode}`,
        ].join("\r\n")
      : [
          "#!/bin/sh",
          `printf '%s\\n' '${escapeShellText(options.stdout)}'`,
          `printf '%s\\n' '${escapeShellText(options.stderr)}' >&2`,
          `printf '%s\\n' \"$PWD\" > \"$CLAUDE_PROJECT_DIR/cwd.txt\"`,
          `printf '%s\\n' \"$*\" > \"$CLAUDE_PROJECT_DIR/args.txt\"`,
          `exit ${options.exitCode}`,
        ].join("\n");

  await mkdir(binDir, { recursive: true });
  await writeFile(scriptPath, scriptContent, "utf8");

  if (process.platform !== "win32") {
    await chmod(scriptPath, 0o755);
  }

  return binDir;
}

function runStopHook(projectDir: string, binDir: string) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: pluginDir,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
      PATH: `${binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    },
    encoding: "utf8",
  });
}

function escapeBatchText(value: string): string {
  return value.replaceAll("^", "^^").replaceAll("&", "^&").replaceAll("<", "^<").replaceAll(">", "^>");
}

function escapeShellText(value: string): string {
  return value.replaceAll("'", "'\"'\"'");
}
