import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dependencyManifestFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const publishPackageDirs = [
  join(repoRoot, "packages", "core"),
  join(repoRoot, "packages", "backend-python"),
  join(repoRoot, "packages", "backend-go"),
  join(repoRoot, "packages", "backend-rust"),
  join(repoRoot, "packages", "backend-java"),
  join(repoRoot, "packages", "backend-typescript"),
  join(repoRoot, "packages", "cli"),
  join(repoRoot, "packages", "claude-code-plugin"),
];

// adoptionPackageDirs is the FULL workspace-dependency closure of the adoption
// entrypoints {core, backend-python, cli}. `npm pack` rewrites each tarball's
// `workspace:*` deps to a concrete `@0.1.0`; if any transitive @stele dep is not
// also handed to `npm install`, npm 404s it against the public registry (this is
// what silently broke once core grew a `@stele/call-graph-core` dependency in
// Phase B). Deriving the closure from package.json keeps the install set honest
// as the dependency graph evolves, instead of a hand-maintained index list.
const adoptionEntrypoints = ["@stele/core", "@stele/backend-python", "@stele/cli"];
const adoptionPackageDirs = computeWorkspaceClosureDirs(adoptionEntrypoints);

function computeWorkspaceClosureDirs(entrypointNames) {
  const nameToDir = new Map();
  const nameToWorkspaceDeps = new Map();
  for (const entry of readdirSync(join(repoRoot, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = join(repoRoot, "packages", entry.name, "package.json");
    if (!existsSync(pkgJsonPath)) continue;
    const manifest = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    nameToDir.set(manifest.name, join(repoRoot, "packages", entry.name));
    const deps = [];
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [depName, range] of Object.entries(manifest[field] ?? {})) {
        if (typeof range === "string" && range.startsWith("workspace:")) deps.push(depName);
      }
    }
    nameToWorkspaceDeps.set(manifest.name, deps);
  }
  const seen = new Set();
  const stack = [...entrypointNames];
  while (stack.length > 0) {
    const name = stack.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    for (const dep of nameToWorkspaceDeps.get(name) ?? []) {
      if (!seen.has(dep)) stack.push(dep);
    }
  }
  const dirs = [];
  for (const name of seen) {
    const dir = nameToDir.get(name);
    if (!dir) throw new Error(`Adoption closure references ${name}, which is not a workspace package.`);
    dirs.push(dir);
  }
  return dirs.sort();
}

// Every adoption tarball must also be packed/release-verified: extend the pack
// set with any closure member not already listed above.
for (const dir of adoptionPackageDirs) {
  if (!publishPackageDirs.includes(dir)) publishPackageDirs.push(dir);
}

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

    const packedTarballs = new Map();

    for (const packageDir of publishPackageDirs) {
      const tarballPath = await packPackage(packageDir, packDir);
      await verifyPackedPackageManifest(tarballPath);
      packedTarballs.set(packageDir, tarballPath);
    }

    const tarballs = adoptionPackageDirs.map((packageDir) => {
      const tarballPath = packedTarballs.get(packageDir);

      if (!tarballPath) {
        throw new Error(`Missing packed tarball for ${packageDir}.`);
      }

      return tarballPath;
    });

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
        "(invariant BUDGET_TOTALS_WITHIN_LIMIT",
        "  (severity high)",
        '  (description "Budget totals are derived from related transaction rows.")',
        "  (assert",
        "    (forall budget (collection budgets)",
        "      (lte",
        "        (sum",
        "          (where txn (collection transactions)",
        "            (eq (path txn budget-id) (path budget id)))",
        "          (path amount))",
        "        (path budget limit)))))",
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
        '        "budgets": [',
        '            {"id": "ops", "limit": 100},',
        '            {"id": "rd", "limit": 80},',
        "        ],",
        '        "transactions": [',
        '            {"budget-id": "ops", "amount": 40},',
        '            {"budget-id": "ops", "amount": 55},',
        '            {"budget-id": "rd", "amount": 30},',
        '            {"budget-id": "rd", "amount": 45},',
        "        ],",
        "    }",
      ].join("\n") + "\n",
    );

    const generateResult = await runTool(npxTool, ["stele", "generate"], sanitizedNpmOptions({ cwd: projectDir, capture: true }));
    assertIncludes(generateResult.stdout, "OK generated 3 files in tests/contract", "generate success summary");
    await run(pythonCommand, ["-m", "pytest", "tests/contract", "-q"], { cwd: projectDir });
    const lockResult = await runTool(
      npxTool,
      ["stele", "lock", "--reason", "initial adoption baseline"],
      sanitizedNpmOptions({ cwd: projectDir, capture: true }),
    );
    assertIncludes(lockResult.stdout, "OK manifest locked:", "lock success summary");
    const checkResult = await runTool(npxTool, ["stele", "check"], sanitizedNpmOptions({ cwd: projectDir, capture: true }));
    assertIncludes(checkResult.stdout, "OK 2 invariants checked;", "check success summary");

    // Multi-language adoption: verify init + generate + check for each supported language.
    // Only init/generate/check — framework-specific test runners (go/cargo/mvn)
    // are not available in the CI environment.
    const languageChecks = [
      { language: "go", expectedFiles: ["go.mod", "tests/contract/setup_test.go"] },
      { language: "rust", expectedFiles: ["Cargo.toml", "src/lib.rs", "tests/contract/mod.rs"] },
      { language: "java", expectedFiles: ["pom.xml", "src/test/java/contract/SteleConftest.java"] },
      { language: "typescript", expectedFiles: ["tests/contract/conftest.ts"] },
    ];

    for (const { language, expectedFiles } of languageChecks) {
      const langDir = join(tempRoot, `fresh-${language}-app`);
      await mkdir(langDir, { recursive: true });

      await runTool(npmTool, ["init", "-y"], sanitizedNpmOptions({ cwd: langDir }));
      await runTool(npmTool, ["install", "--save-dev", ...tarballs], sanitizedNpmOptions({ cwd: langDir }));
      await runTool(npxTool, ["stele", "init", "--language", language], sanitizedNpmOptions({ cwd: langDir }));

      // Write a minimal contract for generation.
      await writeProjectFile(
        langDir,
        "contract/main.stele",
        [
          "(invariant STELE_STRUCTURE_CHECK",
          "  (severity high)",
          '  (description "Minimal invariant to verify generation works for this language.")',
          "  (assert (eq 1 1))",
          ")",
        ].join("\n") + "\n",
      );

      const genResult = await runTool(npxTool, ["stele", "generate"], sanitizedNpmOptions({ cwd: langDir, capture: true }));
      assertIncludes(genResult.stdout, "OK generated", `${language} generate success`);

      // Verify expected scaffold files exist.
      for (const expectedFile of expectedFiles) {
        if (!existsSync(join(langDir, expectedFile))) {
          throw new Error(`${language} init: missing expected file ${expectedFile}`);
        }
      }

      const lockResult = await runTool(
        npxTool,
        ["stele", "lock", "--reason", `${language} adoption baseline`],
        sanitizedNpmOptions({ cwd: langDir, capture: true }),
      );
      assertIncludes(lockResult.stdout, "OK manifest locked:", `${language} lock success`);

      const checkResult = await runTool(npxTool, ["stele", "check"], sanitizedNpmOptions({ cwd: langDir, capture: true }));
      assertIncludes(checkResult.stdout, "OK", `${language} check success`);
    }
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

async function verifyPackedPackageManifest(tarballPath) {
  const { stdout } = await run("tar", ["-xOf", tarballPath, "package/package.json"], {
    cwd: repoRoot,
    capture: true,
  });
  const manifest = JSON.parse(stdout);
  const workspaceDependencies = [];

  for (const field of dependencyManifestFields) {
    for (const [dependencyName, dependencyVersion] of Object.entries(manifest[field] ?? {})) {
      if (typeof dependencyVersion === "string" && dependencyVersion.startsWith("workspace:")) {
        workspaceDependencies.push(`${field}.${dependencyName}=${dependencyVersion}`);
      }
    }
  }

  if (workspaceDependencies.length > 0) {
    throw new Error(
      `Packed manifest ${basename(tarballPath)} still contains workspace protocol dependencies: ${workspaceDependencies.join(", ")}`,
    );
  }
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

function assertIncludes(value, expected, label) {
  if (!value.includes(expected)) {
    throw new Error(`Expected ${label} to include ${JSON.stringify(expected)}, received:\n${value}`);
  }
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
