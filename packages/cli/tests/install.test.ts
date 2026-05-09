import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { createProgram, runCli } from "../src/index.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stele-cli-install-"));
  tempDirs.push(dir);
  return dir;
}

async function createProject(): Promise<string> {
  const dir = await createTempDir();
  await writeFile(join(dir, "stele.config.json"), JSON.stringify(DEFAULT_CONFIG), "utf8");
  await mkdir(join(dir, "contract"), { recursive: true });
  await writeFile(
    join(dir, "contract", "main.stele"),
    [
      "(invariant SAMPLE_RULE",
      '  (severity high)',
      '  (description "demo invariant")',
      "  (assert (eq 1 1)))",
    ].join("\n"),
    "utf8",
  );
  return dir;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("stele install --agent cursor", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("creates .cursor/rules/stele.md when invoked through the CLI", async () => {
    const projectDir = await createProject();
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runCli(["node", "stele", "install", "--agent", "cursor"]);

    const rules = await readFile(join(projectDir, ".cursor", "rules", "stele.md"), "utf8");
    expect(rules).toMatch(/^<!-- stele-auto:v1 -->/u);
    expect(rules).toContain("# Stele Contract Rules (auto-generated)");
    expect(rules).toContain("SAMPLE_RULE");
  });

  it("uninstalls Cursor integration when --uninstall is passed", async () => {
    const projectDir = await createProject();
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runCli(["node", "stele", "install", "--agent", "cursor", "--enable-shell"]);
    await runCli(["node", "stele", "install", "--agent", "cursor", "--uninstall"]);

    expect(await pathExists(join(projectDir, ".cursor", "rules", "stele.md"))).toBe(false);
    expect(await pathExists(join(projectDir, ".cursor", "composer", "stele-check.sh"))).toBe(false);
  });

  it("creates the composer hook with --enable-shell", async () => {
    const projectDir = await createProject();
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runCli(["node", "stele", "install", "--agent", "cursor", "--enable-shell"]);

    const composer = await readFile(join(projectDir, ".cursor", "composer", "stele-check.sh"), "utf8");
    expect(composer).toContain("stele check --json");
  });

  it("rejects unsupported agents", async () => {
    const projectDir = await createTempDir();
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const originalExitCode = process.exitCode;

    await runCli(["node", "stele", "install", "--agent", "fictional-ide"]);

    expect(process.exitCode).not.toBe(0);
    expect(stderrSpy.mock.calls.flat().join("")).toMatch(/E_UNSUPPORTED_AGENT|not supported/u);
    process.exitCode = originalExitCode;
  });

  it("rejects continue-dev with E_AGENT_NOT_IMPLEMENTED", async () => {
    const projectDir = await createTempDir();
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const originalExitCode = process.exitCode;

    await runCli(["node", "stele", "install", "--agent", "continue-dev"]);

    expect(process.exitCode).not.toBe(0);
    expect(stderrSpy.mock.calls.flat().join("")).toMatch(/Phase 3|not yet implemented/u);
    process.exitCode = originalExitCode;
  });

  it("succeeds when agent=claude-code with an informational note", async () => {
    const projectDir = await createTempDir();
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(["node", "stele", "install", "--agent", "claude-code"]);

    expect(stdoutSpy.mock.calls.flat().join("")).toMatch(/claude-code-plugin/u);
  });
});
