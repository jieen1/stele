import { access, readdir, readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadContract } from "@stele/core";
import { loadConfig } from "../config/loadConfig.js";
import { STELE_CONFIG_FILE } from "../config/defaults.js";
import { STELE_VERSION } from "../version.js";

const execFileAsync = promisify(execFile);

export type DoctorOptions = {
  json?: boolean;
};

type CheckStatus = "ok" | "warn" | "error";

type DoctorFinding = {
  check: string;
  status: CheckStatus;
  message: string;
  fix?: string;
};

const ICON: Record<CheckStatus, string> = {
  ok: "✓",
  warn: "⚠",
  error: "✗",
};

export async function runDoctor(projectDir: string, options: DoctorOptions): Promise<void> {
  const findings: DoctorFinding[] = [];

  // 1. CLI version
  findings.push(await checkCliVersion(projectDir));

  // 2. stele.config.json exists and parses
  const configFinding = await checkConfig(projectDir);
  findings.push(configFinding);

  // Load config for subsequent checks (best-effort)
  let config: Awaited<ReturnType<typeof loadConfig>> | undefined;
  if (configFinding.status !== "error") {
    try {
      config = await loadConfig(projectDir);
    } catch {
      // config is broken beyond JSON parse — leave as undefined
    }
  }

  // 3. contract/ directory exists
  const contractDir = config?.contractDir ?? "contract";
  findings.push(await checkContractDir(projectDir, contractDir));

  // 4. contract/main.stele exists and parses
  const entry = config?.entry ?? "contract/main.stele";
  const entryFinding = await checkContractEntry(projectDir, entry);
  findings.push(entryFinding);
  const invariantCount = entryFinding.status === "ok"
    ? (entryFinding as DoctorFinding & { _invariantCount?: number })._invariantCount ?? 0
    : 0;

  // 5. tests/contract/ (or generatedDir) exists
  const generatedDir = config?.generatedDir ?? "tests/contract";
  findings.push(await checkGeneratedDir(projectDir, generatedDir));

  // 6. Generated tests are in sync
  findings.push(await checkGeneratedSync(projectDir));

  // 7. Manifest locked or absent
  const manifestPath = config?.manifestPath ?? "contract/.manifest.json";
  findings.push(await checkManifest(projectDir, manifestPath));

  // 8. Backend toolchain present
  const targetLanguage = config?.targetLanguage ?? "python";
  findings.push(await checkToolchain(targetLanguage));

  // 9. Claude Code plugin registration
  const claudeDir = join(homedir(), ".claude");
  findings.push(...(await checkClaudeCodePlugin(projectDir, claudeDir)));

  // 10. Custom checkers compile
  const checkerImplDir = config?.checkerImplDir ?? "contract/checker_impls";
  findings.push(await checkCustomCheckers(projectDir, checkerImplDir, targetLanguage));

  if (options.json) {
    const output = findings.map(({ check, status, message, fix }) => ({
      check,
      status,
      message,
      fix,
    }));
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    setDoctorExitCode(findings);
    return;
  }

  // Human output
  process.stdout.write("[stele doctor]\n\n");
  for (const finding of findings) {
    const icon = ICON[finding.status];
    process.stdout.write(`  ${icon} ${finding.message}\n`);
    if (finding.fix && finding.status !== "ok") {
      process.stdout.write(`    → ${finding.fix}\n`);
    }
  }

  const ok = findings.filter((f) => f.status === "ok").length;
  const warnings = findings.filter((f) => f.status === "warn").length;
  const errors = findings.filter((f) => f.status === "error").length;

  process.stdout.write(`\nSummary: ${ok} OK, ${warnings} warnings, ${errors} errors.\n`);

  setDoctorExitCode(findings);
}

function setDoctorExitCode(findings: DoctorFinding[]): void {
  const hasErrors = findings.some((f) => f.status === "error");
  if (hasErrors) {
    process.exitCode = 1;
  }
}

// ----------------------------------------------------------------
// Check implementations
// ----------------------------------------------------------------

async function checkCliVersion(projectDir: string): Promise<DoctorFinding> {
  const check = "@stele/cli version";
  try {
    // Try to find the version from the local node_modules
    const cliPkgPath = join(projectDir, "node_modules", "@stele", "cli", "package.json");
    let localVersion: string | undefined;
    try {
      const pkgRaw = await readFile(cliPkgPath, "utf8");
      const pkg = JSON.parse(pkgRaw) as { version?: string };
      localVersion = pkg.version;
    } catch {
      // not installed locally — fall through
    }

    if (localVersion) {
      if (localVersion === STELE_VERSION) {
        return {
          check,
          status: "ok",
          message: `@stele/cli ${STELE_VERSION} resolves via node_modules/.bin/stele`,
        };
      }
      return {
        check,
        status: "warn",
        message: `@stele/cli in node_modules is ${localVersion} but running CLI is ${STELE_VERSION}`,
        fix: "Run `npm install --save-dev @stele/cli` to update.",
      };
    }

    return {
      check,
      status: "ok",
      message: `@stele/cli ${STELE_VERSION} (running from PATH)`,
    };
  } catch (error) {
    return {
      check,
      status: "error",
      message: `Cannot determine @stele/cli version: ${errorMessage(error)}`,
    };
  }
}

async function checkConfig(projectDir: string): Promise<DoctorFinding> {
  const check = "stele.config.json";
  const configPath = join(projectDir, STELE_CONFIG_FILE);
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    return {
      check,
      status: "error",
      message: "stele.config.json not found",
      fix: "Run `stele init` to initialize Stele.",
    };
  }

  try {
    JSON.parse(raw);
    return {
      check,
      status: "ok",
      message: "stele.config.json is valid",
    };
  } catch (parseError) {
    return {
      check,
      status: "error",
      message: `stele.config.json is malformed JSON: ${errorMessage(parseError)}`,
      fix: "Fix the JSON syntax in stele.config.json.",
    };
  }
}

async function checkContractDir(projectDir: string, contractDir: string): Promise<DoctorFinding> {
  const check = "contract/ directory";
  const fullPath = resolve(projectDir, contractDir);
  try {
    const s = await stat(fullPath);
    if (s.isDirectory()) {
      return { check, status: "ok", message: `${contractDir}/ exists` };
    }
    return {
      check,
      status: "error",
      message: `${contractDir}/ exists but is not a directory`,
      fix: "Remove the file and run `stele init`.",
    };
  } catch {
    return {
      check,
      status: "error",
      message: `${contractDir}/ not found`,
      fix: "Run `stele init` to scaffold the contract directory.",
    };
  }
}

async function checkContractEntry(
  projectDir: string,
  entry: string,
): Promise<DoctorFinding & { _invariantCount?: number }> {
  const check = "contract/main.stele";
  const fullPath = resolve(projectDir, entry);
  try {
    await access(fullPath);
  } catch {
    return {
      check,
      status: "error",
      message: `${entry} not found`,
      fix: "Run `stele init` to scaffold the contract file.",
    };
  }

  try {
    const contract = await loadContract(fullPath);
    const invariantCount = contract.invariants.length;
    return {
      check,
      status: "ok",
      message: `${entry} parses (${invariantCount} invariant${invariantCount === 1 ? "" : "s"})`,
      _invariantCount: invariantCount,
    };
  } catch (parseError) {
    return {
      check,
      status: "error",
      message: `${entry} has parse errors: ${errorMessage(parseError)}`,
      fix: "Fix the CDL syntax in the contract file.",
    };
  }
}

async function checkGeneratedDir(projectDir: string, generatedDir: string): Promise<DoctorFinding> {
  const check = "generated tests directory";
  const fullPath = resolve(projectDir, generatedDir);
  try {
    const s = await stat(fullPath);
    if (s.isDirectory()) {
      return { check, status: "ok", message: `${generatedDir}/ exists` };
    }
    return {
      check,
      status: "error",
      message: `${generatedDir}/ exists but is not a directory`,
      fix: "Remove the file and run `stele generate`.",
    };
  } catch {
    return {
      check,
      status: "warn",
      message: `${generatedDir}/ not found — run \`stele generate\` first`,
      fix: "Run `stele generate` to create generated tests.",
    };
  }
}

async function checkGeneratedSync(projectDir: string): Promise<DoctorFinding> {
  const check = "generated tests in sync";
  // Save and restore process.exitCode so internal check mutations don't leak.
  const savedExitCode = process.exitCode;
  try {
    const { checkProject } = await import("./check.js");
    await checkProject(projectDir, {});
    process.exitCode = savedExitCode;
    return { check, status: "ok", message: "Generated tests are in sync (no drift)" };
  } catch (error: unknown) {
    process.exitCode = savedExitCode;
    const exitCode =
      typeof error === "object" &&
      error !== null &&
      "exitCode" in error &&
      typeof (error as { exitCode: unknown }).exitCode === "number"
        ? (error as { exitCode: number }).exitCode
        : undefined;

    if (exitCode === 2) {
      return {
        check,
        status: "error",
        message: "Generated tests are out of sync (drift detected)",
        fix: "Run `stele generate` to regenerate tests.",
      };
    }
    // Other errors (contract violations, missing config, etc.) are not drift
    return {
      check,
      status: "ok",
      message: "Generated tests are in sync (no drift)",
    };
  }
}

async function checkManifest(projectDir: string, manifestPath: string): Promise<DoctorFinding> {
  const check = "manifest lock";
  const fullPath = resolve(projectDir, manifestPath);
  try {
    await access(fullPath);
    // Manifest exists — we don't run full verify here (that's stele check's job)
    return { check, status: "ok", message: `${manifestPath} exists (manifest is locked)` };
  } catch {
    return {
      check,
      status: "warn",
      message: `No ${manifestPath} — run \`stele lock --reason "initial baseline"\``,
      fix: 'Run `stele lock --reason "initial baseline"` to lock the manifest.',
    };
  }
}

async function checkToolchain(targetLanguage: string): Promise<DoctorFinding> {
  const check = "backend toolchain";
  try {
    switch (targetLanguage) {
      case "python":
        return await checkPythonToolchain();
      case "typescript":
        return await checkTypescriptToolchain();
      case "go":
        return await checkGoToolchain();
      case "rust":
        return await checkRustToolchain();
      case "java":
        return await checkJavaToolchain();
      default:
        return {
          check,
          status: "warn",
          message: `Unknown targetLanguage "${targetLanguage}" — cannot check toolchain`,
        };
    }
  } catch (error) {
    return {
      check,
      status: "error",
      message: `Toolchain check failed: ${errorMessage(error)}`,
    };
  }
}

async function checkPythonToolchain(): Promise<DoctorFinding> {
  const check = "backend toolchain";
  for (const cmd of ["python3", "python"]) {
    try {
      const { stdout: vOut } = await execFileAsync(cmd, ["--version"], { windowsHide: true });
      const version = vOut.trim();
      try {
        const { stdout: pOut } = await execFileAsync(cmd, ["-m", "pytest", "--version"], {
          windowsHide: true,
        });
        const pytestVersion = pOut.trim().split("\n")[0] ?? "pytest";
        return {
          check,
          status: "ok",
          message: `${version}, ${pytestVersion}`,
        };
      } catch {
        return {
          check,
          status: "error",
          message: `${version} found but pytest is not installed`,
          fix: "Run `pip install pytest` to install pytest.",
        };
      }
    } catch {
      continue;
    }
  }
  return {
    check,
    status: "error",
    message: "python3 not found on PATH",
    fix: "Install Python 3.10+ and ensure it is on your PATH.",
  };
}

async function checkTypescriptToolchain(): Promise<DoctorFinding> {
  const check = "backend toolchain";
  try {
    const { stdout } = await execFileAsync("npx", ["vitest", "--version"], { windowsHide: true });
    return { check, status: "ok", message: `vitest ${stdout.trim()}` };
  } catch {
    return {
      check,
      status: "error",
      message: "vitest not found (npx vitest --version failed)",
      fix: "Run `npm install --save-dev vitest` to install vitest.",
    };
  }
}

async function checkGoToolchain(): Promise<DoctorFinding> {
  const check = "backend toolchain";
  try {
    const { stdout } = await execFileAsync("go", ["version"], { windowsHide: true });
    return { check, status: "ok", message: stdout.trim() };
  } catch {
    return {
      check,
      status: "error",
      message: "go not found on PATH",
      fix: "Install Go and ensure it is on your PATH.",
    };
  }
}

async function checkRustToolchain(): Promise<DoctorFinding> {
  const check = "backend toolchain";
  try {
    const { stdout } = await execFileAsync("cargo", ["--version"], { windowsHide: true });
    return { check, status: "ok", message: stdout.trim() };
  } catch {
    return {
      check,
      status: "error",
      message: "cargo not found on PATH",
      fix: "Install Rust (rustup) and ensure cargo is on your PATH.",
    };
  }
}

async function checkJavaToolchain(): Promise<DoctorFinding> {
  const check = "backend toolchain";
  for (const cmd of ["mvn", "gradle"]) {
    try {
      const args = cmd === "mvn" ? ["--version"] : ["--version"];
      const { stdout } = await execFileAsync(cmd, args, { windowsHide: true });
      return { check, status: "ok", message: stdout.trim().split("\n")[0] ?? cmd };
    } catch {
      continue;
    }
  }
  return {
    check,
    status: "error",
    message: "Neither mvn nor gradle found on PATH",
    fix: "Install Maven or Gradle and ensure it is on your PATH.",
  };
}

async function checkClaudeCodePlugin(
  projectDir: string,
  claudeDir: string,
): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = [];

  // Check if ~/.claude/ exists at all
  try {
    await access(claudeDir);
  } catch {
    findings.push({
      check: "Claude Code plugin",
      status: "warn",
      message: "~/.claude/ not detected; skipping plugin checks",
    });
    return findings;
  }

  // Check installed_plugins.json
  const installedPluginsPath = join(claudeDir, "plugins", "installed_plugins.json");
  type PluginEntry = { scope: string; projectPath: string; installPath: string };
  type InstalledPlugins = Record<string, PluginEntry[]>;

  let pluginsData: InstalledPlugins | undefined;
  try {
    const raw = await readFile(installedPluginsPath, "utf8");
    pluginsData = JSON.parse(raw) as InstalledPlugins;
  } catch {
    pluginsData = undefined;
  }

  const absProjectDir = resolve(projectDir);
  const steleEntries = pluginsData?.["stele@local"] ?? [];
  const hasEntry = steleEntries.some((e) => resolve(e.projectPath) === absProjectDir);

  findings.push(
    hasEntry
      ? {
          check: "Claude Code plugin: installed_plugins.json",
          status: "ok",
          message: "~/.claude/plugins/installed_plugins.json registers this project",
        }
      : {
          check: "Claude Code plugin: installed_plugins.json",
          status: "warn",
          message: "~/.claude/plugins/installed_plugins.json does not register this project",
          fix: "Run `stele plugin install --claude-code` to fix",
        },
  );

  // Check settings.json
  const settingsPath = join(claudeDir, "settings.json");
  let settingsData: { enabledPlugins?: Record<string, boolean> } | undefined;
  try {
    const raw = await readFile(settingsPath, "utf8");
    settingsData = JSON.parse(raw) as { enabledPlugins?: Record<string, boolean> };
  } catch {
    settingsData = undefined;
  }

  const isEnabled = settingsData?.enabledPlugins?.["stele@local"] === true;
  findings.push(
    isEnabled
      ? {
          check: "Claude Code plugin: settings.json",
          status: "ok",
          message: "~/.claude/settings.json has enabledPlugins.stele@local = true",
        }
      : {
          check: "Claude Code plugin: settings.json",
          status: "warn",
          message: "~/.claude/settings.json does not enable stele@local",
          fix: "Run `stele plugin install --claude-code` to fix",
        },
  );

  return findings;
}

async function checkCustomCheckers(
  projectDir: string,
  checkerImplDir: string,
  targetLanguage: string,
): Promise<DoctorFinding> {
  const check = "custom checkers";
  if (targetLanguage !== "python") {
    return {
      check,
      status: "ok",
      message: `${checkerImplDir}/: custom checker import check is Python-only`,
    };
  }

  const fullPath = resolve(projectDir, checkerImplDir);
  let entries: string[];
  try {
    entries = await readdir(fullPath);
  } catch {
    return {
      check,
      status: "ok",
      message: `${checkerImplDir}/: no custom checkers`,
    };
  }

  // Exclude private modules, test files, and conftest — only checker modules
  // are imported as checkers. (test_*.py / conftest.py are pytest infra, not
  // checkers, and importing them standalone is meaningless.)
  const pyFiles = entries.filter(
    (f) => f.endsWith(".py") && !f.startsWith("_") && !f.startsWith("test_") && f !== "conftest.py",
  );
  if (pyFiles.length === 0) {
    return {
      check,
      status: "ok",
      message: `${checkerImplDir}/: no custom checkers`,
    };
  }

  const errors: string[] = [];
  for (const pyFile of pyFiles) {
    const modulePath = join(fullPath, pyFile);
    try {
      await execFileAsync(
        "python3",
        // Put the checker dir on sys.path first: checker modules may be split
        // across sibling files (e.g. an entry module that re-exports `from
        // sp_shared import *`), which only resolve when their own directory is
        // importable — exactly how conftest.py loads them at runtime.
        ["-c", `import sys, importlib.util; sys.path.insert(0, ${JSON.stringify(fullPath)}); spec = importlib.util.spec_from_file_location("m", ${JSON.stringify(modulePath)}); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)`],
        { windowsHide: true },
      );
    } catch (error) {
      errors.push(`${pyFile}: ${errorMessage(error)}`);
    }
  }

  if (errors.length > 0) {
    return {
      check,
      status: "error",
      message: `${checkerImplDir}/: ${errors.length} checker(s) have import errors`,
      fix: errors.join("; "),
    };
  }

  return {
    check,
    status: "ok",
    message: `${checkerImplDir}/: ${pyFiles.length} checker(s) import cleanly`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
