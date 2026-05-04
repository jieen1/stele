import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publishPackageDirs = [
  join(repoRoot, "packages", "core"),
  join(repoRoot, "packages", "backend-python"),
  join(repoRoot, "packages", "cli"),
  join(repoRoot, "packages", "claude-code-plugin"),
];
const adoptionPackageDirs = publishPackageDirs.slice(0, 3);
const pnpmTool = resolveTool("pnpm", ["node_modules", "pnpm", "bin", "pnpm.cjs"]);
const npmTool = resolveTool("npm", ["node_modules", "npm", "bin", "npm-cli.js"]);
const npxTool = resolveTool("npx", ["node_modules", "npm", "bin", "npx-cli.js"]);
const pythonCommand = "python";
const npmWarningPatterns = [/npm warn Unknown env config/i];

async function main() {
  const tempRoot = await mkdtemp(join(tmpdir(), "stele packed adoption "));
  const packDir = join(tempRoot, "packs");
  const projectDir = join(tempRoot, "fresh-python-app");

  try {
    await runTool(pnpmTool, ["build"], { cwd: repoRoot });
    await mkdir(packDir, { recursive: true });

    for (const packageDir of publishPackageDirs) {
      await verifyNpmReleasePack(packageDir);
    }

    const tarballs = [];

    for (const packageDir of adoptionPackageDirs) {
      tarballs.push(await packPackage(packageDir, packDir));
    }

    await mkdir(projectDir, { recursive: true });

    await runTool(npmTool, ["init", "-y"], sanitizedNpmOptions({ cwd: projectDir }));
    await runTool(npmTool, ["install", "--save-dev", ...tarballs], sanitizedNpmOptions({ cwd: projectDir }));
    await runTool(npxTool, ["stele", "init", "--language", "python"], sanitizedNpmOptions({ cwd: projectDir }));

    await writeProjectFile(
      projectDir,
      "contract/main.stele",
      [
        "(invariant APP_BALANCE_TOTAL",
        "  (severity high)",
        '  (description "Account total value equals position market value plus cash.")',
        "  (assert",
        "    (eq (path account total-value)",
        "        (add (sum (collection positions) (path market-value))",
        "             (path account cash)))))",
      ].join("\n") + "\n",
    );
    await writeProjectFile(
      projectDir,
      "tests/contract/conftest.py",
      [
        "import pytest",
        "",
        "",
        "@pytest.fixture",
        "def stele_context():",
        "    return {",
        '        "account": {"total-value": 6000, "cash": 1500},',
        '        "positions": [',
        '            {"market-value": 2000},',
        '            {"market-value": 2500},',
        "        ],",
        "    }",
      ].join("\n") + "\n",
    );

    await runTool(npxTool, ["stele", "generate"], sanitizedNpmOptions({ cwd: projectDir }));
    await run(pythonCommand, ["-m", "pytest", "tests/contract", "-q"], { cwd: projectDir });
    await runTool(npxTool, ["stele", "lock", "--reason", "initial adoption baseline"], sanitizedNpmOptions({ cwd: projectDir }));
    await runTool(npxTool, ["stele", "check"], sanitizedNpmOptions({ cwd: projectDir }));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function packPackage(packageDir, packDir) {
  const { stdout } = await runTool(pnpmTool, ["pack", "--pack-destination", packDir], {
    cwd: packageDir,
    capture: true,
  });
  const tarballName = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);

  if (!tarballName) {
    throw new Error(`Unable to determine tarball name for ${packageDir}.`);
  }

  return isAbsolute(tarballName) ? tarballName : join(packDir, tarballName);
}

async function verifyNpmReleasePack(packageDir) {
  const { stdout } = await runTool(npmTool, ["pack", "--dry-run", "--json"], sanitizedNpmOptions({
    cwd: packageDir,
    capture: true,
  }));
  const packEntries = parseTrailingJsonLine(stdout, packageDir);

  if (!Array.isArray(packEntries) || packEntries.length === 0 || typeof packEntries[0]?.filename !== "string") {
    throw new Error(`npm pack --dry-run did not return a usable pack result for ${packageDir}.`);
  }
}

function parseTrailingJsonLine(stdout, packageDir) {
  const trimmed = stdout.trim();

  for (let index = trimmed.lastIndexOf("["); index >= 0; index = trimmed.lastIndexOf("[", index - 1)) {
    try {
      const parsed = JSON.parse(trimmed.slice(index));

      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0]?.filename === "string") {
        return parsed;
      }
    } catch {
      // Keep scanning for the root JSON array after lifecycle log output.
    }
  }

  throw new Error(`npm pack --dry-run did not emit JSON output for ${packageDir}.`);
}

async function writeProjectFile(projectDir, relativePath, content) {
  const fullPath = join(projectDir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

function resolveTool(commandName, windowsCliSegments) {
  if (process.platform !== "win32") {
    return { command: commandName, argsPrefix: [] };
  }

  const candidates = execFileSync("where.exe", [`${commandName}.cmd`], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const candidate of candidates) {
    const scriptPath = join(dirname(candidate), ...windowsCliSegments);

    if (existsSync(scriptPath)) {
      return {
        command: process.execPath,
        argsPrefix: [scriptPath],
      };
    }
  }

  throw new Error(`Unable to resolve a Windows CLI script for ${commandName}.`);
}

function runTool(tool, args, options) {
  return run(tool.command, [...tool.argsPrefix, ...args], options);
}

function sanitizedNpmOptions(options) {
  return {
    ...options,
    env: sanitizeNpmEnv(process.env),
    forbiddenStderrPatterns: npmWarningPatterns,
  };
}

function sanitizeNpmEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !/^npm_config_/i.test(key)),
  );
}

async function run(command, args, options) {
  const printable = [command, ...args].join(" ");
  process.stdout.write(`$ ${printable}\n`);

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (!options.capture) {
        process.stdout.write(text);
      }
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      if (!options.capture) {
        process.stderr.write(text);
      }
    });

    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0 && options.forbiddenStderrPatterns?.some((pattern) => pattern.test(stderr))) {
        rejectPromise(new Error(`Command emitted forbidden stderr output: ${printable}\n${stderr}`));
        return;
      }

      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }

      rejectPromise(new Error(`Command failed with exit code ${code}: ${printable}\n${stderr || stdout}`));
    });
  });
}

await main();
