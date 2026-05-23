import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { MAX_EVENT_LOG_SIZE } from "../config/defaults.js";
import { resolvePythonRuntime } from "../utils/shared-utils.js";
import { runGenerate } from "./generate.js";
import { checkProject } from "./check.js";

const execFileAsync = promisify(execFile);

export type DevOptions = {
  once?: boolean;
};

const DEBOUNCE_MS = 500;

export async function runDev(projectDir: string, options: DevOptions): Promise<void> {
  const contractDir = join(projectDir, "contract");

  if (!(await dirExists(contractDir))) {
    process.stderr.write(`[stele] No "contract" directory found in "${projectDir}". Run "stele init" first.\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`[stele] Watching "${contractDir}" for contract changes...\n`);

  if (options.once) {
    process.stdout.write(`[stele] Running once (no watch).\n`);
    await runDevCycle(projectDir);
    return;
  }

  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    for (const w of watchers) {
      w.close();
    }
    if (timer !== null) {
      clearTimeout(timer);
    }
  };

  const scheduleCycle = () => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      runDevCycle(projectDir).catch((error) => {
        process.stderr.write(`[stele] Error: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    }, DEBOUNCE_MS);
  };

  try {
    const steleFiles = await collectSteleFiles(contractDir);
    for (const file of steleFiles) {
      const absPath = join(contractDir, file);
      const w = watch(absPath, { persistent: true }, (event) => {
        if (event === "change") {
          scheduleCycle();
        }
      });
      watchers.push(w);
    }
    // Watch the directory itself for new/deleted files
    const dirWatch = watch(contractDir, { persistent: true }, (event, filename) => {
      if (filename && filename.endsWith(".stele")) {
        scheduleCycle();
      }
    });
    watchers.push(dirWatch);
  } catch (error) {
    process.stderr.write(`[stele] Failed to watch contract directory: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const originalSigint = process.listeners("SIGINT").length;
  process.on("SIGINT", () => {
    process.stdout.write(`\n[stele] Stopping watch.\n`);
    cleanup();
    // Restore default SIGINT behavior if there were no original handlers
    if (originalSigint === 0) {
      process.exit();
    }
  });

  // Initial run
  await runDevCycle(projectDir);
}

async function runDevCycle(projectDir: string): Promise<void> {
  process.stdout.write(`\n[stele] Generating contract tests...\n`);
  await runGenerate(projectDir, {});
  process.stdout.write(`[stele] Running contract checks...\n`);

  const pythonRuntime = await resolvePythonRuntime();
  if (pythonRuntime !== undefined) {
    const { stdout, stderr } = await execFileAsync(pythonRuntime.command, [...pythonRuntime.args, "-m", "pytest", "tests/contract", "-q", "--tb=short"], {
      cwd: projectDir,
      windowsHide: true,
      maxBuffer: MAX_EVENT_LOG_SIZE,
    });
    process.stdout.write(stdout);
    if (stderr && !stderr.includes("no tests ran")) {
      process.stderr.write(stderr);
    }
  }

  try {
    await checkProject(projectDir, {});
    process.stdout.write(`[stele] All checks passed.\n`);
  } catch (error) {
    process.stderr.write(`[stele] Check failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  process.stdout.write(`[stele] Watching...\n`);
}

async function collectSteleFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".stele")) {
      files.push(entry.name);
    }
  }

  return files;
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    return st.isDirectory();
  } catch {
    return false;
  }
}

