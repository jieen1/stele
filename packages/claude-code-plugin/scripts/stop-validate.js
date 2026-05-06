#!/usr/bin/env node
import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const STOP_BLOCK_EXIT_CODE = 2;
const CONTRACT_RECOVERY_GUIDANCE = [
  "",
  "Stele guidance for this failure:",
  "Before editing contract-protected files, first assume the existing contract is still correct.",
  "Try to repair ordinary source code or fixtures first, then re-run the check.",
  "",
  "Ask yourself:",
  "- Did my recent source-code change violate an existing invariant?",
  "- Can I fix this without editing contract/, tests/contract/, baseline, or manifest?",
  "- Did I accidentally modify generated Stele files, baseline, or manifest?",
  "- Does the user request truly change the project contract, or did my implementation drift?",
  "",
  "If the requested behavior truly changes the contract, stop and ask the user to review.",
  "Explain which protected files need to change, why source-code-only repair is not enough, and what new invariant or baseline update is proposed.",
  "Do not bypass Stele by editing hooks, config, manifest, baseline, or generated tests to make the failure disappear.",
  "",
].join("\n");
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
  const hookPayload = parseHookInput(await readStdin());
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
    blockStopWithContractRecovery(`stele check failed with exit code ${steleResult.code}.\n`);
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

    blockStopWithContractRecovery(`pytest tests/contract failed with exit code ${pytestResult.code}.\n`);
    return;
  }

  await maybeRequestMaintenanceReview(hookPayload, steleCommandPath);

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

async function runCommand({ stageName, commandPath, args, cwd, forwardOutput = true, blockOnSpawnError = true }) {
  const child = spawnCommand(commandPath, args, cwd);
  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
    if (forwardOutput) {
      process.stdout.write(chunk);
    }
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
    if (forwardOutput) {
      process.stderr.write(chunk);
    }
  });

  return await new Promise((resolve, reject) => {
    let finished = false;

    child.on("error", (error) => {
      if (finished) {
        return;
      }

      finished = true;
      const message = `Unable to run ${stageName}: ${error instanceof Error ? error.message : String(error)}`;

      if (blockOnSpawnError) {
        reject(new Error(message));
        return;
      }

      resolve({ code: 1, stdout, stderr: `${stderr}${message}` });
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

async function maybeRequestMaintenanceReview(hookPayload, steleCommandPath) {
  const materialObservations = await readMaterialObservations(projectDir, resolveSessionId(hookPayload));

  if (materialObservations.length === 0 || isStopHookReentry(hookPayload)) {
    return;
  }

  const sessionId = resolveSessionId(hookPayload) ?? "default";
  const markerPath = path.join(projectDir, ".stele", "agent", `${safeFileName(sessionId)}.maintenance-review.json`);

  if (await fileExists(markerPath)) {
    return;
  }

  await runCommand({
    stageName: "stele maintenance-summary",
    commandPath: steleCommandPath,
    args: ["maintenance-summary", "--from", "main", "--output", ".stele/maintenance/summary.md"],
    cwd: projectDir,
    forwardOutput: false,
    blockOnSpawnError: false,
  });
  await mkdir(path.dirname(markerPath), { recursive: true });
  await writeFile(
    markerPath,
    `${JSON.stringify({
      session_id: sessionId,
      reviewed_at: new Date().toISOString(),
      material_observations: materialObservations.length,
    })}\n`,
    "utf8",
  );

  blockStop(
    [
      "Stele maintenance review required.",
      "A material source edit was observed, and Stele generated .stele/maintenance/summary.md.",
      "Before finishing, review the summary. If you learned durable project behavior, add it with stele propose invariant --apply.",
      "If no new contract rule is needed, say why.",
      "Modifying or deleting existing contract rules still requires explicit user review.",
      "",
    ].join("\n"),
  );
}

async function readMaterialObservations(cwd, sessionId) {
  const observationPath = path.join(cwd, ".stele", "agent", "session-observations.jsonl");
  let raw;

  try {
    raw = await readFile(observationPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }

    return [];
  }

  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseObservationLine)
    .filter((observation) => observation !== null)
    .filter((observation) => observation.material_change === true)
    .filter((observation) => sessionId === null || observation.session_id === sessionId);
}

function parseObservationLine(line) {
  try {
    const parsed = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

async function readStdin() {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  }

  return chunks.join("");
}

function parseHookInput(stdin) {
  if (stdin.trim().length === 0) {
    return {};
  }

  try {
    return JSON.parse(stdin);
  } catch {
    return {};
  }
}

function resolveSessionId(payload) {
  if (isObject(payload) && typeof payload.session_id === "string" && payload.session_id.trim().length > 0) {
    return payload.session_id;
  }

  if (isObject(payload) && typeof payload.sessionId === "string" && payload.sessionId.trim().length > 0) {
    return payload.sessionId;
  }

  return null;
}

function isStopHookReentry(payload) {
  return isObject(payload) && payload.stop_hook_active === true;
}

async function fileExists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function safeFileName(value) {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_");
}

function isPytestUnavailable(stderr) {
  return /no module named pytest|modulenotfounderror:\s*no module named ['"]?pytest['"]?/iu.test(stderr);
}

function isMissingFileError(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
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

function blockStopWithContractRecovery(message) {
  blockStop(`${message}${CONTRACT_RECOVERY_GUIDANCE}`);
}

function isObject(value) {
  return typeof value === "object" && value !== null;
}
