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

  it("after successful validation asks for one maintenance review when material source edits were observed", { timeout: 15000 }, async () => {
    const projectDir = await createTempDir();
    await writeObservation(projectDir, {
      session_id: "session-1",
      tool_name: "Edit",
      target_paths: ["src/payments/service.py"],
      material_change: true,
    });
    const binDir = await createFakeToolchain({
      stele: {
        stdout: "fake stele stdout",
        stderr: "",
        exitCode: 0,
      },
      python: {
        stdout: "fake pytest stdout",
        stderr: "",
        exitCode: 0,
      },
    });

    const result = runStopHook(projectDir, binDir, {
      payload: {
        session_id: "session-1",
        hook_event_name: "Stop",
        stop_hook_active: false,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Stele maintenance review required");
    expect(result.stderr).toContain("stele propose invariant --id <id>");
    await expect(readFile(join(projectDir, "args.txt"), "utf8")).resolves.toContain("maintenance-summary");
  });

  it("does not repeat the maintenance review block after the Stop hook re-enters", async () => {
    const projectDir = await createTempDir();
    await writeObservation(projectDir, {
      session_id: "session-1",
      tool_name: "Edit",
      target_paths: ["src/payments/service.py"],
      material_change: true,
    });
    const binDir = await createFakeToolchain({
      stele: { stdout: "stele ok", stderr: "", exitCode: 0 },
      python: { stdout: "pytest ok", stderr: "", exitCode: 0 },
    });

    const result = runStopHook(projectDir, binDir, {
      payload: {
        session_id: "session-1",
        hook_event_name: "Stop",
        stop_hook_active: true,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("Stele maintenance review required");
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
    expectContractRecoveryGuidance(result.stderr);
  });

  it("blocks Stop with a clear reason when stele cannot be started", async () => {
    const projectDir = await createTempDir();
    const emptyBinDir = await createTempDir();

    const result = runStopHook(projectDir, emptyBinDir);

    expect(result.status).toBe(2);
    // stderr should contain error about failing to run stele (message varies by platform)
    expect(result.stderr.length).toBeGreaterThan(0);
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
    expectContractRecoveryGuidance(result.stderr);
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
    expect(result.stderr).toContain(".venv");
    expect(result.stderr).toContain("PATH");
  });

  it("finds stele in project-local node_modules/.bin when PATH does not include stele", async () => {
    const projectDir = await createTempDir();
    await writeToolScript(join(projectDir, "node_modules", ".bin"), steleFileName(), {
      stdout: "local stele stdout",
      stderr: "local stele stderr",
      exitCode: 0,
      cwdFile: "cwd.txt",
      argsFile: "args.txt",
    });
    const binDir = await createFakePythonCli({
      stdout: "path python stdout",
      stderr: "path python stderr",
      exitCode: 0,
    });

    const result = runStopHook(projectDir, binDir, { includeSystemPath: false });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("local stele stdout");
    expect(result.stderr).toContain("local stele stderr");
  });

  it("finds python in project-local .venv when PATH does not include python", async () => {
    const projectDir = await createTempDir();
    const binDir = await createFakeSteleCli({
      stdout: "path stele stdout",
      stderr: "path stele stderr",
      exitCode: 0,
    });
    await writeToolScript(projectVenvBinDir(projectDir), pythonFileName(), {
      stdout: "local python stdout",
      stderr: "local python stderr",
      exitCode: 0,
      cwdFile: "pytest-cwd.txt",
      argsFile: "pytest-args.txt",
    });

    const result = runStopHook(projectDir, binDir, { includeSystemPath: false });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("local python stdout");
    expect(result.stderr).toContain("local python stderr");
  });

  it("finds python in a nested backend .venv", async () => {
    const projectDir = await createTempDir();
    const binDir = await createFakeSteleCli({
      stdout: "path stele stdout",
      stderr: "path stele stderr",
      exitCode: 0,
    });
    await writeToolScript(projectVenvBinDir(projectDir, "backend"), pythonFileName(), {
      stdout: "nested python stdout",
      stderr: "nested python stderr",
      exitCode: 0,
      cwdFile: "pytest-cwd.txt",
      argsFile: "pytest-args.txt",
    });

    const result = runStopHook(projectDir, binDir, { includeSystemPath: false });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("nested python stdout");
    expect(result.stderr).toContain("nested python stderr");
  });

  it("falls back to PATH when project-local stele and python are absent", async () => {
    const projectDir = await createTempDir();
    const binDir = await createFakeToolchain({
      stele: { stdout: "path stele stdout", stderr: "", exitCode: 0 },
      python: { stdout: "path python stdout", stderr: "", exitCode: 0 },
    });

    const result = runStopHook(projectDir, binDir, { includeSystemPath: false });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("path stele stdout");
    expect(result.stdout).toContain("path python stdout");
  });

  it("skips pytest when python unavailable and no tests/contract directory", async () => {
    const projectDir = await createTempDir();
    const binDir = await createFakeSteleCli({
      stdout: "stele ok",
      stderr: "",
      exitCode: 0,
    });

    const result = runStopHook(projectDir, binDir, { includeSystemPath: false });

    // No tests/contract/ dir exists → pytest skipped gracefully
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Skipping pytest check");
  });

  it("fails closed when python unavailable but tests/contract directory exists", async () => {
    const projectDir = await createTempDir();
    const binDir = await createFakeSteleCli({
      stdout: "stele ok",
      stderr: "",
      exitCode: 0,
    });

    // Create tests/contract/ directory to signal this project has contract tests
    await mkdir(join(projectDir, "tests", "contract"), { recursive: true });

    const result = runStopHook(projectDir, binDir, { includeSystemPath: false });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Unable to run "python -m pytest tests/contract -q"');
    expect(result.stderr).toContain(".venv");
    expect(result.stderr).toContain("PATH");
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

async function createFakePythonCli(options: { stdout: string; stderr: string; exitCode: number }): Promise<string> {
  const binDir = await createTempDir();
  await mkdir(binDir, { recursive: true });
  await writeToolScript(binDir, pythonFileName(), {
    ...options,
    cwdFile: "pytest-cwd.txt",
    argsFile: "pytest-args.txt",
  });
  return binDir;
}

async function createFakeToolchain(options: {
  stele: { stdout: string; stderr: string; exitCode: number };
  python?: { stdout: string; stderr: string; exitCode: number };
}): Promise<string> {
  const binDir = await createTempDir();
  await mkdir(binDir, { recursive: true });
  await writeToolScript(binDir, steleFileName(), {
    ...options.stele,
    cwdFile: "cwd.txt",
    argsFile: "args.txt",
  });

  if (options.python) {
    await writeToolScript(binDir, pythonFileName(), {
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
  await mkdir(dirname(filePath), { recursive: true });
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

async function writeObservation(projectDir: string, observation: Record<string, unknown>): Promise<void> {
  const observationPath = join(projectDir, ".stele", "agent", "session-observations.jsonl");
  await mkdir(dirname(observationPath), { recursive: true });
  await writeFile(observationPath, `${JSON.stringify(observation)}\n`, "utf8");
}

function runStopHook(projectDir: string, binDir: string, options?: { includeSystemPath?: boolean; payload?: unknown }) {
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
    input: options?.payload === undefined ? "" : `${JSON.stringify(options.payload)}\n`,
    encoding: "utf8",
  });
}

function steleFileName(): string {
  return process.platform === "win32" ? "stele.cmd" : "stele";
}

function pythonFileName(): string {
  return process.platform === "win32" ? "python.cmd" : "python";
}

function projectVenvBinDir(projectDir: string, nestedDir?: string): string {
  if (process.platform === "win32") {
    return nestedDir
      ? join(projectDir, nestedDir, ".venv", "Scripts")
      : join(projectDir, ".venv", "Scripts");
  }

  return nestedDir ? join(projectDir, nestedDir, ".venv", "bin") : join(projectDir, ".venv", "bin");
}

function expectContractRecoveryGuidance(stderr: string): void {
  expect(stderr).toContain("Before editing contract-protected files");
  expect(stderr).toContain("first assume the existing contract is still correct");
  expect(stderr).toContain("Try to repair ordinary source code or fixtures first");
  expect(stderr).toContain("Did my recent source-code change violate an existing invariant?");
  expect(stderr).toContain("Can I fix this without editing contract/, tests/contract/, baseline, or manifest?");
  expect(stderr).toContain("If the requested behavior truly changes the contract, stop and ask the user to review");
  expect(stderr).toContain("Do not bypass Stele");
}

function escapeBatchText(value: string): string {
  return value.replaceAll("^", "^^").replaceAll("&", "^&").replaceAll("<", "^<").replaceAll(">", "^>");
}

function escapeShellText(value: string): string {
  return value.replaceAll("'", "'\"'\"'");
}
