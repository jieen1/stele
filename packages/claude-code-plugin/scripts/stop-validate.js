#!/usr/bin/env node
import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const STOP_BLOCK_EXIT_CODE = 2;
const projectDir = path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
const steleLocalCommandNames = process.platform === "win32" ? ["stele.cmd", "stele.bat"] : ["stele"];
const stelePathCommandNames = process.platform === "win32" ? ["stele.cmd", "stele.bat"] : ["stele"];
const pythonLocalCommandNames =
  process.platform === "win32" ? ["python.exe", "python.cmd", "python.bat"] : ["python", "python3"];
const pythonPathCommandNames =
  process.platform === "win32" ? ["python.exe", "python.cmd", "python.bat"] : ["python", "python3"];
const venvSearchExcludedDirs = new Set([
  ".git",
  ".hg",
  ".svn",
  ".turbo",
  ".yarn",
  "coverage",
  "dist",
  "build",
  "node_modules",
  "out",
  "target",
]);
const maxNestedVenvSearchDirectories = 250;

await main();

async function main() {
  const pathValue = process.env.PATH ?? "";
  const steleCommandPath = await resolveSteleCommand(projectDir, pathValue);

  if (steleCommandPath === null) {
    blockStop(
      'Unable to run "stele check". Checked project-local node_modules/.bin and PATH. Ensure the stele CLI is installed in the project or available on PATH.\n',
    );
    return;
  }

  const steleResult = await runCommand({
    stageName: "stele check",
    commandPath: steleCommandPath,
    args: ["check"],
    cwd: projectDir,
  });

  if (steleResult.code !== 0) {
    blockStop(`stele check failed with exit code ${steleResult.code}.\n`);
    return;
  }

  const pythonCommandPath = await resolvePythonCommand(projectDir, pathValue);

  if (pythonCommandPath === null) {
    blockStop(
      'Unable to run "python -m pytest tests/contract -q". Checked project-local .venv, nested **/.venv environments, and PATH. Ensure Python and pytest are available in the project venv or on PATH.\n',
    );
    return;
  }

  const pytestResult = await runCommand({
    stageName: "pytest tests/contract",
    commandPath: pythonCommandPath,
    args: ["-m", "pytest", "tests/contract", "-q"],
    cwd: projectDir,
  });

  if (pytestResult.code !== 0) {
    if (isPytestUnavailable(pytestResult.stderr)) {
      blockStop(
        "python -m pytest tests/contract -q could not start the contract tests. Checked project-local .venv, nested **/.venv environments, and PATH. Ensure Python and pytest are available in the project venv or on PATH.\n",
      );
      return;
    }

    blockStop(`pytest tests/contract failed with exit code ${pytestResult.code}.\n`);
    return;
  }

  process.exit(0);
}

function spawnCommand(commandPath, args, cwd) {
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: cwd,
  };

  if (process.platform === "win32") {
    const command = [`"${commandPath}"`, ...args].join(" ");
    return spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  return spawn(commandPath, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function runCommand({ stageName, commandPath, args, cwd }) {
  const child = spawnCommand(commandPath, args, cwd);
  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
    process.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
    process.stderr.write(chunk);
  });

  return await new Promise((resolve, reject) => {
    let finished = false;

    child.on("error", (error) => {
      if (finished) {
        return;
      }

      finished = true;
      reject(new Error(`Unable to run ${stageName}: ${error instanceof Error ? error.message : String(error)}`));
    });

    child.on("close", (code, signal) => {
      if (finished) {
        return;
      }

      finished = true;

      if (signal !== null) {
        reject(new Error(`${stageName} terminated with signal ${signal}.`));
        return;
      }

      resolve({ code: code ?? 1, stdout, stderr });
    });
  }).catch((error) => {
    blockStop(`${error instanceof Error ? error.message : String(error)}\n`);
  });
}

function isPytestUnavailable(stderr) {
  return /no module named pytest|modulenotfounderror:\s*no module named ['"]?pytest['"]?/iu.test(stderr);
}

async function resolveCommandOnPath(commands, pathValue) {
  for (const rawEntry of pathValue.split(path.delimiter)) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/u, "$1");

    if (entry.length === 0) {
      continue;
    }

    for (const command of commands) {
      const candidate = path.resolve(entry, command);

      try {
        await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
  }

  return null;
}

async function resolveSteleCommand(cwd, pathValue) {
  const localCommandPath = await resolveCommandAtLocations(
    [path.join(cwd, "node_modules", ".bin")],
    steleLocalCommandNames,
  );

  if (localCommandPath !== null) {
    return localCommandPath;
  }

  return await resolveCommandOnPath(stelePathCommandNames, pathValue);
}

async function resolvePythonCommand(cwd, pathValue) {
  const localSearchDirs = [getVenvCommandDirectory(cwd), ...(await findNestedVenvCommandDirectories(cwd))];
  const localCommandPath = await resolveCommandAtLocations(localSearchDirs, pythonLocalCommandNames);

  if (localCommandPath !== null) {
    return localCommandPath;
  }

  return await resolveCommandOnPath(pythonPathCommandNames, pathValue);
}

async function resolveCommandAtLocations(searchDirs, commands) {
  for (const searchDir of searchDirs) {
    for (const command of commands) {
      const candidate = path.join(searchDir, command);

      try {
        await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
  }

  return null;
}

function getVenvCommandDirectory(dirPath) {
  return process.platform === "win32"
    ? path.join(dirPath, ".venv", "Scripts")
    : path.join(dirPath, ".venv", "bin");
}

async function findNestedVenvCommandDirectories(rootDir) {
  const directories = [];
  const queue = [rootDir];
  let visited = 0;

  while (queue.length > 0 && visited < maxNestedVenvSearchDirectories) {
    const currentDir = queue.shift();

    if (!currentDir) {
      continue;
    }

    visited += 1;

    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const entryPath = path.join(currentDir, entry.name);

      if (entry.name === ".venv") {
        directories.push(process.platform === "win32" ? path.join(entryPath, "Scripts") : path.join(entryPath, "bin"));
        continue;
      }

      if (venvSearchExcludedDirs.has(entry.name)) {
        continue;
      }

      queue.push(entryPath);
    }
  }

  return directories;
}

function blockStop(message) {
  process.stderr.write(message);
  process.exit(STOP_BLOCK_EXIT_CODE);
}
