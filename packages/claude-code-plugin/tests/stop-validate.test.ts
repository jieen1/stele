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
    const binDir = await createFakeToolchain({
      stele: {
        stdout: "fake stele stdout",
        stderr: "fake stele stderr",
        exitCode: 0,
      },
      python: {
        stdout: "fake pytest stdout",
        stderr: "fake pytest stderr",
        exitCode: 0,
      },
    });

    const result = runStopHook(projectDir, binDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("fake stele stdout");
    expect(result.stdout).toContain("fake pytest stdout");
    expect(result.stderr).toContain("fake stele stderr");
    expect(result.stderr).toContain("fake pytest stderr");
    await expect(readFile(join(projectDir, "cwd.txt"), "utf8")).resolves.toContain(projectDir);
    await expect(readFile(join(projectDir, "args.txt"), "utf8")).resolves.toContain("check");
    await expect(readFile(join(projectDir, "pytest-cwd.txt"), "utf8")).resolves.toContain(projectDir);
    await expect(readFile(join(projectDir, "pytest-args.txt"), "utf8")).resolves.toContain(
      "-m pytest tests/contract -q",
    );
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

  it("blocks Stop with exit 2 when pytest exits non-zero after stele check passes", async () => {
    const projectDir = await createTempDir();
    const binDir = await createFakeToolchain({
      stele: { stdout: "stele ok", stderr: "", exitCode: 0 },
      python: { stdout: "pytest stdout", stderr: "pytest stderr", exitCode: 1 },
    });

    const result = runStopHook(projectDir, binDir, { includeSystemPath: false });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("stele ok");
    expect(result.stdout).toContain("pytest stdout");
    expect(result.stderr).toContain("pytest stderr");
    expect(result.stderr).toContain("pytest tests/contract failed");
  });

  it("does not run pytest when stele check fails", async () => {
    const projectDir = await createTempDir();
    const binDir = await createFakeToolchain({
      stele: { stdout: "", stderr: "stele bad", exitCode: 5 },
      python: { stdout: "pytest should not run", stderr: "", exitCode: 0 },
    });

    const result = runStopHook(projectDir, binDir);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("stele check failed");
    await expect(readFile(join(projectDir, "pytest-args.txt"), "utf8")).rejects.toThrow();
  });

  it("reports stele check failure before checking for python availability", async () => {
    const projectDir = await createTempDir();
    const binDir = await createFakeToolchain({
      stele: { stdout: "", stderr: "stele bad", exitCode: 9 },
    });

    const result = runStopHook(projectDir, binDir, { includeSystemPath: false });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("stele check failed");
    expect(result.stderr).not.toContain('Unable to run "python -m pytest tests/contract -q"');
  });

  it("fails closed with installation guidance when pytest is unavailable", async () => {
    const projectDir = await createTempDir();
    const binDir = await createFakeToolchain({
      stele: { stdout: "stele ok", stderr: "", exitCode: 0 },
      python: { stdout: "", stderr: "No module named pytest", exitCode: 1 },
    });

    const result = runStopHook(projectDir, binDir);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("No module named pytest");
    expect(result.stderr).toContain("python -m pytest tests/contract -q");
    expect(result.stderr).toContain("Ensure Python is installed");
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
  return createFakeToolchain({ stele: options });
}

async function createFakeToolchain(options: {
  stele: { stdout: string; stderr: string; exitCode: number };
  python?: { stdout: string; stderr: string; exitCode: number };
}): Promise<string> {
  const binDir = await createTempDir();
  await mkdir(binDir, { recursive: true });
  await writeToolScript(binDir, process.platform === "win32" ? "stele.cmd" : "stele", {
    ...options.stele,
    cwdFile: "cwd.txt",
    argsFile: "args.txt",
  });

  if (options.python) {
    await writeToolScript(binDir, process.platform === "win32" ? "python.cmd" : "python", {
      ...options.python,
      cwdFile: "pytest-cwd.txt",
      argsFile: "pytest-args.txt",
    });
  }

  return binDir;
}

async function writeToolScript(
  binDir: string,
  fileName: string,
  options: { stdout: string; stderr: string; exitCode: number; cwdFile: string; argsFile: string },
): Promise<void> {
  const filePath = join(binDir, fileName);
  const scriptContent =
    process.platform === "win32"
      ? [
          "@echo off",
          `echo ${escapeBatchText(options.stdout)}`,
          `echo ${escapeBatchText(options.stderr)} 1>&2`,
          `> \"%CLAUDE_PROJECT_DIR%\\${options.cwdFile}\" echo %CD%`,
          `> \"%CLAUDE_PROJECT_DIR%\\${options.argsFile}\" echo %*`,
          `exit /b ${options.exitCode}`,
        ].join("\r\n")
      : [
          "#!/bin/sh",
          `printf '%s\\n' '${escapeShellText(options.stdout)}'`,
          `printf '%s\\n' '${escapeShellText(options.stderr)}' >&2`,
          `printf '%s\\n' \"$PWD\" > \"$CLAUDE_PROJECT_DIR/${options.cwdFile}\"`,
          `printf '%s\\n' \"$*\" > \"$CLAUDE_PROJECT_DIR/${options.argsFile}\"`,
          `exit ${options.exitCode}`,
        ].join("\n");

  await writeFile(filePath, scriptContent, "utf8");

  if (process.platform !== "win32") {
    await chmod(filePath, 0o755);
  }
}

function runStopHook(projectDir: string, binDir: string, options?: { includeSystemPath?: boolean }) {
  const pathEntries = [binDir];

  if (options?.includeSystemPath !== false && process.env.PATH) {
    pathEntries.push(process.env.PATH);
  }

  return spawnSync(process.execPath, [scriptPath], {
    cwd: pluginDir,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
      PATH: pathEntries.join(process.platform === "win32" ? ";" : ":"),
      Path: pathEntries.join(process.platform === "win32" ? ";" : ":"),
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
