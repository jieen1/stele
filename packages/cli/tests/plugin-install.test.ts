import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPluginInstall } from "../src/commands/plugin-install.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stele-plugin-install-"));
  tempDirs.push(dir);
  return dir;
}

/** Create a minimal project with stele.config.json + the plugin package stub. */
async function createProject(dir: string): Promise<void> {
  await writeFile(join(dir, "stele.config.json"), JSON.stringify(DEFAULT_CONFIG), "utf8");
  // Simulate installed @stele/claude-code-plugin
  const pluginDir = join(dir, "node_modules", "@stele", "claude-code-plugin");
  await mkdir(join(pluginDir, ".claude-plugin"), { recursive: true });
  await writeFile(join(pluginDir, ".claude-plugin", "plugin.json"), '{"name":"stele"}', "utf8");
}

/** Create a fake ~/.claude directory with optional pre-existing files. */
async function createClaudeDir(
  base: string,
  opts: {
    installedPlugins?: unknown;
    settings?: unknown;
    pluginsJsonMalformed?: boolean;
  } = {},
): Promise<string> {
  const claudeDir = join(base, "claude");
  await mkdir(join(claudeDir, "plugins"), { recursive: true });

  if (opts.pluginsJsonMalformed) {
    await writeFile(join(claudeDir, "plugins", "installed_plugins.json"), "{ BAD JSON", "utf8");
  } else if (opts.installedPlugins !== undefined) {
    await writeFile(
      join(claudeDir, "plugins", "installed_plugins.json"),
      JSON.stringify(opts.installedPlugins, null, 2) + "\n",
      "utf8",
    );
  }

  if (opts.settings !== undefined) {
    await writeFile(
      join(claudeDir, "settings.json"),
      JSON.stringify(opts.settings, null, 2) + "\n",
      "utf8",
    );
  }

  return claudeDir;
}

describe("stele plugin install --claude-code", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    await Promise.allSettled(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("fresh install — writes both JSON files and prints summary", async () => {
    const base = await createTempDir();
    const projectDir = join(base, "app");
    await mkdir(projectDir, { recursive: true });
    await createProject(projectDir);
    const claudeDir = await createClaudeDir(base);

    const stdout = captureStdout();
    const originalExitCode = process.exitCode;

    await runPluginInstall(projectDir, {
      claudeCode: true,
      userConfigDir: claudeDir,
      projectDir,
    });

    process.exitCode = originalExitCode;

    // installed_plugins.json written correctly
    const pluginsRaw = await readFile(join(claudeDir, "plugins", "installed_plugins.json"), "utf8");
    const plugins = JSON.parse(pluginsRaw);
    expect(plugins["stele@local"]).toHaveLength(1);
    expect(plugins["stele@local"][0].projectPath).toBe(projectDir);
    expect(plugins["stele@local"][0].scope).toBe("project");

    // settings.json written correctly
    const settingsRaw = await readFile(join(claudeDir, "settings.json"), "utf8");
    const settings = JSON.parse(settingsRaw);
    expect(settings.enabledPlugins["stele@local"]).toBe(true);

    // Trailing newline
    expect(pluginsRaw.endsWith("\n")).toBe(true);
    expect(settingsRaw.endsWith("\n")).toBe(true);

    // Summary printed
    const out = stdout.read();
    expect(out).toContain("[stele] Claude Code plugin registered:");
    expect(out).toContain(projectDir);
    expect(out).toContain("Restart Claude Code");
  });

  it("update — existing installed_plugins.json with other plugins is preserved", async () => {
    const base = await createTempDir();
    const projectDir = join(base, "app");
    await mkdir(projectDir, { recursive: true });
    await createProject(projectDir);
    const claudeDir = await createClaudeDir(base, {
      installedPlugins: {
        "other-plugin": [{ scope: "global", projectPath: "/other", installPath: "/other/plugin" }],
      },
    });

    const originalExitCode = process.exitCode;
    captureStdout();

    await runPluginInstall(projectDir, {
      claudeCode: true,
      userConfigDir: claudeDir,
      projectDir,
    });

    process.exitCode = originalExitCode;

    const pluginsRaw = await readFile(join(claudeDir, "plugins", "installed_plugins.json"), "utf8");
    const plugins = JSON.parse(pluginsRaw);
    // Other plugin preserved
    expect(plugins["other-plugin"]).toHaveLength(1);
    expect(plugins["other-plugin"][0].scope).toBe("global");
    // New entry added
    expect(plugins["stele@local"]).toHaveLength(1);
    expect(plugins["stele@local"][0].projectPath).toBe(projectDir);
  });

  it("update — existing settings.json with other keys is preserved", async () => {
    const base = await createTempDir();
    const projectDir = join(base, "app");
    await mkdir(projectDir, { recursive: true });
    await createProject(projectDir);
    const claudeDir = await createClaudeDir(base, {
      settings: { theme: "dark", autoComplete: true },
    });

    captureStdout();
    const originalExitCode = process.exitCode;

    await runPluginInstall(projectDir, {
      claudeCode: true,
      userConfigDir: claudeDir,
      projectDir,
    });

    process.exitCode = originalExitCode;

    const settingsRaw = await readFile(join(claudeDir, "settings.json"), "utf8");
    const settings = JSON.parse(settingsRaw);
    expect(settings.theme).toBe("dark");
    expect(settings.autoComplete).toBe(true);
    expect(settings.enabledPlugins["stele@local"]).toBe(true);
  });

  it("idempotent — re-running with same args prints no-changes message and does not re-write", async () => {
    const base = await createTempDir();
    const projectDir = join(base, "app");
    await mkdir(projectDir, { recursive: true });
    await createProject(projectDir);
    const claudeDir = await createClaudeDir(base);

    captureStdout();
    const originalExitCode = process.exitCode;

    // First run
    await runPluginInstall(projectDir, {
      claudeCode: true,
      userConfigDir: claudeDir,
      projectDir,
    });

    // Grab mtimes of written files
    const { statSync } = await import("node:fs");
    const pluginsPath = join(claudeDir, "plugins", "installed_plugins.json");
    const settingsPath = join(claudeDir, "settings.json");
    const mtime1Plugins = statSync(pluginsPath).mtimeMs;
    const mtime1Settings = statSync(settingsPath).mtimeMs;

    // Second run — need to re-capture stdout
    const stdout2 = captureStdout();
    await runPluginInstall(projectDir, {
      claudeCode: true,
      userConfigDir: claudeDir,
      projectDir,
    });

    process.exitCode = originalExitCode;

    const mtime2Plugins = statSync(pluginsPath).mtimeMs;
    const mtime2Settings = statSync(settingsPath).mtimeMs;

    expect(mtime2Plugins).toBe(mtime1Plugins);
    expect(mtime2Settings).toBe(mtime1Settings);
    expect(stdout2.read()).toContain("No changes needed");
  });

  it("dry-run — does not write files, prints diff", async () => {
    const base = await createTempDir();
    const projectDir = join(base, "app");
    await mkdir(projectDir, { recursive: true });
    await createProject(projectDir);
    const claudeDir = await createClaudeDir(base);

    const stdout = captureStdout();
    const originalExitCode = process.exitCode;

    await runPluginInstall(projectDir, {
      claudeCode: true,
      userConfigDir: claudeDir,
      projectDir,
      dryRun: true,
    });

    process.exitCode = originalExitCode;

    // Files must NOT have been written
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(claudeDir, "plugins", "installed_plugins.json"))).toBe(false);
    expect(existsSync(join(claudeDir, "settings.json"))).toBe(false);

    const out = stdout.read();
    expect(out).toContain("Dry run");
    expect(out).toContain("stele@local");
  });

  it("refuses when stele.config.json is missing", async () => {
    const base = await createTempDir();
    const projectDir = join(base, "app");
    await mkdir(projectDir, { recursive: true });
    // No stele.config.json
    const claudeDir = await createClaudeDir(base);

    const stderr = captureStderr();
    const originalExitCode = process.exitCode;

    await runPluginInstall(projectDir, {
      claudeCode: true,
      userConfigDir: claudeDir,
      projectDir,
    });

    expect(process.exitCode).not.toBe(originalExitCode === 0 ? 0 : undefined);
    expect(process.exitCode).toBe(1);
    expect(stderr.read()).toContain("stele.config.json");
    process.exitCode = originalExitCode;
  });

  it("refuses when @stele/claude-code-plugin is not installed", async () => {
    const base = await createTempDir();
    const projectDir = join(base, "app");
    await mkdir(projectDir, { recursive: true });
    // Has stele.config.json but no plugin
    await writeFile(join(projectDir, "stele.config.json"), JSON.stringify(DEFAULT_CONFIG), "utf8");
    const claudeDir = await createClaudeDir(base);

    const stderr = captureStderr();
    const originalExitCode = process.exitCode;

    await runPluginInstall(projectDir, {
      claudeCode: true,
      userConfigDir: claudeDir,
      projectDir,
    });

    expect(process.exitCode).toBe(1);
    expect(stderr.read()).toContain("claude-code-plugin");
    process.exitCode = originalExitCode;
  });

  it("refuses when installed_plugins.json is malformed JSON", async () => {
    const base = await createTempDir();
    const projectDir = join(base, "app");
    await mkdir(projectDir, { recursive: true });
    await createProject(projectDir);
    const claudeDir = await createClaudeDir(base, { pluginsJsonMalformed: true });

    const originalExitCode = process.exitCode;

    await expect(
      runPluginInstall(projectDir, {
        claudeCode: true,
        userConfigDir: claudeDir,
        projectDir,
      }),
    ).rejects.toThrow(/malformed JSON/i);

    process.exitCode = originalExitCode;
  });

  it("no editor flag — prints error and exits 1", async () => {
    const base = await createTempDir();
    const projectDir = join(base, "app");
    await mkdir(projectDir, { recursive: true });
    const claudeDir = await createClaudeDir(base);

    const stderr = captureStderr();
    const originalExitCode = process.exitCode;

    await runPluginInstall(projectDir, {
      userConfigDir: claudeDir,
      projectDir,
    });

    expect(process.exitCode).toBe(1);
    expect(stderr.read()).toContain("--claude-code");
    process.exitCode = originalExitCode;
  });

  it("multiple projects — adds to existing stele@local array without duplicating", async () => {
    const base = await createTempDir();
    const projectDir1 = join(base, "app1");
    const projectDir2 = join(base, "app2");
    await mkdir(projectDir1, { recursive: true });
    await mkdir(projectDir2, { recursive: true });
    await createProject(projectDir1);
    await createProject(projectDir2);

    const claudeDir = await createClaudeDir(base, {
      installedPlugins: {
        "stele@local": [
          {
            scope: "project",
            projectPath: projectDir1,
            installPath: join(projectDir1, "node_modules", "@stele", "claude-code-plugin"),
          },
        ],
      },
      settings: { enabledPlugins: { "stele@local": true } },
    });

    captureStdout();
    const originalExitCode = process.exitCode;

    await runPluginInstall(projectDir2, {
      claudeCode: true,
      userConfigDir: claudeDir,
      projectDir: projectDir2,
    });

    process.exitCode = originalExitCode;

    const pluginsRaw = await readFile(join(claudeDir, "plugins", "installed_plugins.json"), "utf8");
    const plugins = JSON.parse(pluginsRaw);
    expect(plugins["stele@local"]).toHaveLength(2);
    expect(plugins["stele@local"].map((e: { projectPath: string }) => e.projectPath)).toContain(projectDir1);
    expect(plugins["stele@local"].map((e: { projectPath: string }) => e.projectPath)).toContain(projectDir2);
  });
});

// --- helpers ---

function captureStdout(): { read(): string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write);
  return { read: () => chunks.join("") };
}

function captureStderr(): { read(): string } {
  const chunks: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write);
  return { read: () => chunks.join("") };
}
