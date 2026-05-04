import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDirs = [
  join(repoRoot, "packages", "core"),
  join(repoRoot, "packages", "backend-python"),
  join(repoRoot, "packages", "cli"),
];
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const pythonCommand = "python";

async function main() {
  const tempRoot = await mkdtemp(join(tmpdir(), "stele-packed-adoption-"));
  const packDir = join(tempRoot, "packs");
  const projectDir = join(tempRoot, "fresh-python-app");

  try {
    await mkdir(packDir, { recursive: true });

    const tarballs = [];

    for (const packageDir of packageDirs) {
      tarballs.push(await packPackage(packageDir, packDir));
    }

    await mkdir(projectDir, { recursive: true });

    await run(npmCommand, ["init", "-y"], { cwd: projectDir });
    await run(npmCommand, ["install", "--save-dev", ...tarballs], { cwd: projectDir });
    await run(npxCommand, ["stele", "init", "--language", "python"], { cwd: projectDir });

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

    await run(npxCommand, ["stele", "generate"], { cwd: projectDir });
    await run(pythonCommand, ["-m", "pytest", "tests/contract", "-q"], { cwd: projectDir });
    await run(npxCommand, ["stele", "check"], { cwd: projectDir });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function packPackage(packageDir, packDir) {
  const { stdout } = await run(pnpmCommand, ["pack", "--pack-destination", packDir], {
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

async function writeProjectFile(projectDir, relativePath, content) {
  const fullPath = join(projectDir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

async function run(command, args, options) {
  const printable = [command, ...args].join(" ");
  process.stdout.write(`$ ${printable}\n`);

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: process.platform === "win32",
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
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }

      rejectPromise(new Error(`Command failed with exit code ${code}: ${printable}\n${stderr || stdout}`));
    });
  });
}

await main();
