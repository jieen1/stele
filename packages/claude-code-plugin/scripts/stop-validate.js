#!/usr/bin/env node
import { constants, lstatSync } from "node:fs";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

const STOP_BLOCK_EXIT_CODE = 2;
const STOP_STATE_FILE = ".stele/stop-state.json";
const MAX_FINGERPRINT_INPUT = 4096;
const RESEARCH_TEMPLATE = [
  "",
  "=== RESEARCH MODE ===",
  "A contract violation occurred. Before asking to modify the contract:",
  "1. Read the failing source file",
  "2. Understand why the violation triggered",
  "3. If the code is wrong: fix the code",
  "4. If the contract is wrong: propose new invariant knowledge with `stele propose invariant --id <id> --severity <error|warning|info> --description <text> --assert <cdl> --apply`, or ask the human to review modifying existing contract files",
  "DO NOT edit contract files directly.",
  "",
].join("\n");

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
  RESEARCH_TEMPLATE,
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
  try {
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
    await blockStopWithLoopGuard(
      "stele check",
      steleResult.code,
      `stele check failed with exit code ${steleResult.code}.\n${CONTRACT_RECOVERY_GUIDANCE}`,
      `${steleResult.stderr}\n${steleResult.stdout}`,
    );
    return;
  }

  const pythonCommandPath = await resolvePythonCommand(projectDir, pathValue);

  if (pythonCommandPath === null) {
    // Python not available — check if this project has a Python target language.
    // If no tests/contract/ directory exists, skip pytest gracefully.
    const testsDir = path.join(projectDir, "tests", "contract");
    const hasContractTests = await fileExists(testsDir);

    if (!hasContractTests) {
      process.stderr.write(
        "Stele note: Python/pytest not found and no tests/contract/ directory. Skipping pytest check.\n",
      );
    } else {
      blockStop(
        'Unable to run "python -m pytest tests/contract -q". Checked project-local .venv, nested **/.venv environments, and PATH. Ensure Python and pytest are available in the project venv or on PATH.\n',
      );
      return;
    }
    // If no contract tests exist, skip pytest and continue.
  } else {

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

    await blockStopWithLoopGuard(
      "pytest tests/contract",
      pytestResult.code,
      `pytest tests/contract failed with exit code ${pytestResult.code}.\n${CONTRACT_RECOVERY_GUIDANCE}`,
      `${pytestResult.stderr}\n${pytestResult.stdout}`,
    );
    return;
  }
  }

  // Run TypeScript tests (pnpm). Gracefully skip if pnpm is not available —
  // not all Stele projects are pnpm monorepos.
  const pnpmCommandPath = await resolveCommandOnPath(
    process.platform === "win32" ? ["pnpm.cmd", "pnpm.bat"] : ["pnpm"],
    pathValue,
  );

  // Only run pnpm test if this looks like a Node.js project (has package.json).
  // Not all Stele-protected projects are pnpm monorepos.
  const packageJsonPath = path.join(projectDir, "package.json");
  const hasPackageJson = await fileExists(packageJsonPath);

  if (pnpmCommandPath !== null && hasPackageJson) {
    const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const pnpmResult = await runCommand({
      stageName: "pnpm test",
      commandPath: pnpmCommand,
      args: ["test"],
      cwd: projectDir,
      env: { STELE_CONFORMANCE_ALLOW_SKIP: "1" },
    });

    if (pnpmResult.code !== 0) {
      await blockStopWithLoopGuard(
        "pnpm test",
        pnpmResult.code,
        `pnpm test failed with exit code ${pnpmResult.code}.\n${CONTRACT_RECOVERY_GUIDANCE}`,
        `${pnpmResult.stderr}\n${pnpmResult.stdout}`,
      );
      return;
    }
  }

  await maybeRequestMaintenanceReview(hookPayload, steleCommandPath);

  // Success path: clear the loop-guard state so the next failure starts fresh
  // (i.e. is treated as a brand-new failure and gets one cycle of blocking before
  // being released to the user).
  await clearStopState();

  process.exit(0);
  } catch (error) {
    blockStop(`${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function spawnCommand(commandPath, args, cwd, timeoutMs, extraEnv) {
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: cwd,
    ...extraEnv,
  };

  // commandPath is resolved by our own resolution logic (resolveSteleCommand / resolvePythonCommand)
  // and never comes from user/agent input.
  // args are hardcoded strings in this script (e.g., ["check"], ["-m", "pytest", ...]).
  // On Windows, .cmd/.bat files require shell: true (CMD handles them).
  // On POSIX, shell: false for defense-in-depth — no shell interpolation needed.
  const child = spawn(commandPath, args, {
    cwd,
    env,
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (timeoutMs) {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already dead */ } }, 5000);
    }, timeoutMs);
    // Avoid keeping child alive for timer alone
    timer.unref();
  }

  return child;
}

async function runCommand({ stageName, commandPath, args, cwd, forwardOutput = true, blockOnSpawnError = true, timeoutMs = 120000, env: extraEnv }) {
  const child = spawnCommand(commandPath, args, cwd, timeoutMs, extraEnv);
  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", /** @stele:effects process */ (chunk) => {
    stdout += chunk.toString();
    if (forwardOutput) {
      process.stdout.write(chunk);
    }
  });
  child.stderr?.on("data", /** @stele:effects process */ (chunk) => {
    stderr += chunk.toString();
    if (forwardOutput) {
      process.stderr.write(chunk);
    }
  });

  return await new Promise((resolve, reject) => {
    let finished = false;

    child.on("error", /** @stele:effects process */ (error) => {
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

    child.on("close", /** @stele:effects process */ (code, signal) => {
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
      "Before finishing, review the summary. If you learned durable project behavior, add it with `stele propose invariant --id <id> --severity <error|warning|info> --description <text> --assert <cdl> --apply`.",
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

/** @stele:effects process */
async function readStdin() {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  }

  return chunks.join("");
}

/** @stele:effects */
function parseHookInput(stdin) {
  if (stdin.trim().length === 0) {
    return {};
  }

  return JSON.parse(stdin);
}

/** @stele:effects */
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

/** @stele:effects */
function safeFileName(value) {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 128);
}

function isPytestUnavailable(stderr) {
  return /no module named pytest|modulenotfounderror:\s*no module named ['"]?pytest['"]?/iu.test(stderr);
}

function isMissingFileError(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** @stele:effects fs.read */
async function resolveCommandOnPath(commands, pathValue) {
  for (const rawEntry of pathValue.split(path.delimiter)) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/u, "$1");

    if (entry.length === 0) {
      continue;
    }

    for (const command of commands) {
      const candidate = path.resolve(entry, command);

      try {
        // Reject symlinks to prevent supply chain bypass
        const stats = lstatSync(candidate);
        if (stats.isSymbolicLink()) {
          continue;
        }

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
        // Reject symlinks to prevent supply chain bypass
        const stats = lstatSync(candidate);
        if (stats.isSymbolicLink()) {
          continue;
        }

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

      // Reject symlinked directories (defense-in-depth: isDirectory() may
      // return true for symlinks on systems where d_type is DT_UNKNOWN).
      const entryPath = path.join(currentDir, entry.name);
      try {
        const lstats = lstatSync(entryPath);
        if (lstats.isSymbolicLink()) {
          continue;
        }
      } catch {
        continue;
      }

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

// Round 5 J-09: removed `blockStopWithContractRecovery` — the helper was
// defined but never invoked. CLAUDE.md "When you remove code, remove it"
// applies; if a future code-path needs the contract-recovery flavour of
// blockStop, it can be re-introduced together with the call site.

/**
 * Loop guard: when the same Stop-time failure recurs back-to-back, the second
 * attempt is allowed to stop so the user can intervene. Without this guard the
 * agent enters an infinite loop where every attempt to stop & ask the user is
 * blocked by the same failure that prompted the ask.
 *
 * Behavior:
 *   - First time we see a failure with fingerprint F → write state, exit 2 (block)
 *   - Subsequent attempt with same fingerprint F → write state (attempts++),
 *     emit a "released to user" message, exit 0 (allow stop)
 *   - Successful run (or a different fingerprint) → state is reset, so the next
 *     failure is treated as "first time" again (one cycle of blocking before release)
 *
 * State file lives at <project>/.stele/stop-state.json. Read/write failures
 * are tolerated — they degrade the guard to the legacy always-block behavior
 * (fail-closed for safety, not fail-open).
 */
async function blockStopWithLoopGuard(stage, exitCode, message, evidence) {
  const fingerprint = computeFailureFingerprint(stage, exitCode, evidence);
  const stateFilePath = path.join(projectDir, STOP_STATE_FILE);
  const previousState = await readStopState(stateFilePath);
  const previousFingerprint = previousState?.lastFingerprint;
  const previousAttempts =
    typeof previousState?.consecutiveAttempts === "number" ? previousState.consecutiveAttempts : 0;
  const sameAsPrevious = previousFingerprint === fingerprint && previousAttempts >= 1;

  if (sameAsPrevious) {
    await writeStopState(stateFilePath, {
      lastFingerprint: fingerprint,
      lastFailureAt: new Date().toISOString(),
      consecutiveAttempts: previousAttempts + 1,
      stage,
      exitCode,
      releasedToUser: true,
    });
    process.stderr.write(message);
    process.stderr.write(
      `\n[stele Stop hook] Same failure as the previous stop attempt (attempt #${
        previousAttempts + 1
      }, fingerprint ${fingerprint.slice(
        0,
        12,
      )}). Allowing this stop so the user can review and decide. Re-running stele check after a real change will reset this state.\n`,
    );
    process.exit(0);
  }

  await writeStopState(stateFilePath, {
    lastFingerprint: fingerprint,
    lastFailureAt: new Date().toISOString(),
    consecutiveAttempts: 1,
    stage,
    exitCode,
    releasedToUser: false,
  });
  blockStop(message);
}

function computeFailureFingerprint(stage, exitCode, evidence) {
  const norm = normalizeForFingerprint(evidence ?? "");
  const payload = `${stage}|${exitCode}|${norm}`;
  return createHash("sha256").update(payload).digest("hex");
}

function normalizeForFingerprint(text) {
  return String(text)
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<TS>")
    .replace(/\b[0-9a-f]{40,}\b/g, "<HASH>")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .slice(0, MAX_FINGERPRINT_INPUT);
}

async function readStopState(stateFilePath) {
  try {
    // Round 4 P2-1: refuse to read a symlinked .stele/stop-state.json. An
    // agent that replaced the file with a symlink to /dev/null or to an
    // attacker-controlled path could (a) erase the loop-guard fingerprint
    // every read, OR (b) read attacker-shaped JSON. Either way the loop
    // guard is defeated. Fail closed by treating it as "no state" — the
    // hook then degrades to the legacy "always block" behaviour, which is
    // the right thing under tampering.
    const stat = lstatSync(stateFilePath);
    if (stat.isSymbolicLink()) {
      process.stderr.write(
        `[stop-validate] Refusing symlinked stop-state.json at ${stateFilePath}; ` +
          `treating as no state (fail-closed). Round 4 P2-1.\n`,
      );
      return null;
    }
    if (!stat.isFile()) {
      // Same fail-closed posture for sockets / FIFOs / devices.
      return null;
    }
    const raw = await readFile(stateFilePath, "utf8");
    const parsed = JSON.parse(raw);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeStopState(stateFilePath, state) {
  try {
    // Round 4 P2-1: same symlink-rejection on write — refuse to follow a
    // symlink that's been placed where the state file should live, which
    // would otherwise let an attacker point a write at any target.
    try {
      const stat = lstatSync(stateFilePath);
      if (stat.isSymbolicLink()) {
        process.stderr.write(
          `[stop-validate] Refusing to write through symlinked stop-state.json at ${stateFilePath}.\n`,
        );
        return;
      }
    } catch {
      // File doesn't exist yet — that's normal first-run, proceed.
    }
    await mkdir(path.dirname(stateFilePath), { recursive: true });
    await writeFile(stateFilePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort. If we cannot persist state, future runs degrade to legacy
    // "always block" — that's safer than failing open.
  }
}

async function clearStopState() {
  try {
    const stateFilePath = path.join(projectDir, STOP_STATE_FILE);
    // Round 5 J-05: mirror writeStopState's symlink guard. An agent that
    // swaps the state file with a symlink between writeStopState and
    // clearStopState would otherwise redirect the clear-write to any
    // path the symlink points at.
    try {
      const stat = lstatSync(stateFilePath);
      if (stat.isSymbolicLink()) {
        process.stderr.write(
          `[stop-validate] Refusing to clear-write through symlinked stop-state.json at ${stateFilePath}.\n`,
        );
        return;
      }
    } catch {
      // File doesn't exist yet — proceed.
    }
    await writeFile(
      stateFilePath,
      `${JSON.stringify(
        {
          lastFingerprint: null,
          lastFailureAt: null,
          consecutiveAttempts: 0,
          stage: null,
          exitCode: 0,
          releasedToUser: false,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } catch {
    // Best-effort.
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null;
}
