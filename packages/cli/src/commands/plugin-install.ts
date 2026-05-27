import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type PluginInstallOptions = {
  claudeCode?: boolean;
  userConfigDir?: string;
  projectDir?: string;
  dryRun?: boolean;
};

type PluginEntry = {
  scope: string;
  projectPath: string;
  installPath: string;
};

type InstalledPlugins = Record<string, PluginEntry[]>;

type ClaudeSettings = {
  enabledPlugins?: Record<string, boolean>;
  [key: string]: unknown;
};

export async function runPluginInstall(cwd: string, options: PluginInstallOptions): Promise<void> {
  if (!options.claudeCode) {
    process.stderr.write(
      "[stele] No editor specified. Use --claude-code to register with Claude Code.\n",
    );
    process.exitCode = 1;
    return;
  }

  const projectDir = resolve(options.projectDir ?? cwd);
  const userConfigDir = options.userConfigDir ?? join(homedir(), ".claude");

  // Validate project dir has stele.config.json
  const configPath = join(projectDir, "stele.config.json");
  try {
    await access(configPath);
  } catch {
    process.stderr.write(
      `[stele] Error: No stele.config.json found in ${projectDir}.\n` +
        `  Run \`stele init\` to initialize Stele first.\n`,
    );
    process.exitCode = 1;
    return;
  }

  // Validate installPath has .claude-plugin/plugin.json
  const installPath = join(projectDir, "node_modules", "@stele", "claude-code-plugin");
  const pluginJsonPath = join(installPath, ".claude-plugin", "plugin.json");
  try {
    await access(pluginJsonPath);
  } catch {
    process.stderr.write(
      `[stele] Error: @stele/claude-code-plugin not found at ${installPath}.\n` +
        `  Run \`npm install --save-dev @stele/claude-code-plugin\` to install it.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const installedPluginsPath = join(userConfigDir, "plugins", "installed_plugins.json");
  const settingsPath = join(userConfigDir, "settings.json");

  // Read existing files or start fresh
  const pluginsJson = await readJsonFile<InstalledPlugins>(installedPluginsPath, {});
  const settingsJson = await readJsonFile<ClaudeSettings>(settingsPath, {});

  // Build the new entry
  const newEntry: PluginEntry = {
    scope: "project",
    projectPath: projectDir,
    installPath,
  };

  // Compute updated plugins
  const existingEntries: PluginEntry[] = pluginsJson["stele@local"] ?? [];
  const matchIndex = existingEntries.findIndex((e) => e.projectPath === projectDir);
  let pluginsChanged = false;
  let updatedEntries: PluginEntry[];

  if (matchIndex >= 0) {
    // Check if existing entry is already identical
    const existing = existingEntries[matchIndex];
    if (existing.scope === newEntry.scope && existing.installPath === newEntry.installPath) {
      updatedEntries = existingEntries;
    } else {
      updatedEntries = [
        ...existingEntries.slice(0, matchIndex),
        newEntry,
        ...existingEntries.slice(matchIndex + 1),
      ];
      pluginsChanged = true;
    }
  } else {
    updatedEntries = [...existingEntries, newEntry];
    pluginsChanged = true;
  }

  // Compute updated settings
  const currentEnabled = settingsJson.enabledPlugins?.["stele@local"];
  const settingsChanged = currentEnabled !== true;

  // Idempotent check
  if (!pluginsChanged && !settingsChanged) {
    process.stdout.write("[stele] No changes needed — plugin already registered.\n");
    return;
  }

  const updatedPlugins: InstalledPlugins = {
    ...pluginsJson,
    "stele@local": updatedEntries,
  };

  const updatedSettings: ClaudeSettings = {
    ...settingsJson,
    enabledPlugins: {
      ...(settingsJson.enabledPlugins ?? {}),
      "stele@local": true,
    },
  };

  if (options.dryRun) {
    process.stdout.write("[stele] Dry run — files that would be modified:\n\n");
    if (pluginsChanged) {
      process.stdout.write(`  ${installedPluginsPath}\n`);
      process.stdout.write(JSON.stringify(updatedPlugins, null, 2) + "\n\n");
    }
    if (settingsChanged) {
      process.stdout.write(`  ${settingsPath}\n`);
      process.stdout.write(JSON.stringify(updatedSettings, null, 2) + "\n\n");
    }
    return;
  }

  // Write files
  if (pluginsChanged) {
    await mkdir(join(userConfigDir, "plugins"), { recursive: true });
    await writeFile(installedPluginsPath, JSON.stringify(updatedPlugins, null, 2) + "\n", "utf8");
  }

  if (settingsChanged) {
    await mkdir(userConfigDir, { recursive: true });
    await writeFile(settingsPath, JSON.stringify(updatedSettings, null, 2) + "\n", "utf8");
  }

  process.stdout.write(
    `[stele] Claude Code plugin registered:\n` +
      `  project:    ${projectDir}\n` +
      `  plugin:     ${installPath}\n` +
      `  installed_plugins.json:  ${installedPluginsPath} (${pluginsChanged ? "updated" : "unchanged"})\n` +
      `  settings.json:           ${settingsPath} (${settingsChanged ? "updated" : "unchanged"})\n` +
      `\n` +
      `Restart Claude Code (close + reopen, or start a new session) so the plugin loads.\n`,
  );
}

async function readJsonFile<T>(filePath: string, defaultValue: T): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return defaultValue;
    throw error;
  }

  // File exists — parse it; refuse if malformed
  try {
    return JSON.parse(raw) as T;
  } catch (parseError) {
    const msg = parseError instanceof Error ? parseError.message : String(parseError);
    throw new Error(
      `[stele] Error: ${filePath} exists but contains malformed JSON.\n  ${msg}\n  Fix or remove the file before retrying.`,
    );
  }
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
