import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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
  // Note: the GitHub Action is distributed via git tag + Marketplace, not npm.
  // We still publish the npm artifact for name-squat / build provenance.
  join(repoRoot, "packages", "github-action"),
];
const pnpmTool = resolveTool("pnpm", ["node_modules", "pnpm", "bin", "pnpm.cjs"]);
const npmTool = resolveTool("npm", ["node_modules", "npm", "bin", "npm-cli.js"]);
const npmWarningPatterns = [/npm warn Unknown env config/i];

await main();

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tempRoot = await mkdtemp(join(tmpdir(), "stele npm publish "));
  const packDir = options.packDir ?? join(tempRoot, "packs");

  try {
    await mkdir(packDir, { recursive: true });
    await runTool(pnpmTool, ["build"], { cwd: repoRoot });

    const tarballs = [];

    for (const packageDir of publishPackageDirs) {
      const tarballPath = await packPackage(packageDir, packDir);
      const manifest = await readPackedManifest(tarballPath);
      verifyPackedManifest(tarballPath, manifest);
      tarballs.push({ tarballPath, manifest });
    }

    if (options.requireGitTagVersion) {
      await verifyGitTagVersion(tarballs.map(({ manifest }) => manifest));
    }

    for (const { tarballPath, manifest } of tarballs) {
      await publishTarball(tarballPath, manifest, options);
    }

    process.stdout.write(
      `${options.dryRun ? "OK dry-run completed for" : "OK published"} ${tarballs.length} Stele package(s).\n`,
    );
  } finally {
    if (options.packDir === undefined) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

function parseArgs(args) {
  const options = {
    access: "public",
    dryRun: false,
    provenance: true,
    requireGitTagVersion: false,
    tag: "latest",
    packDir: undefined,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--no-provenance") {
      options.provenance = false;
      continue;
    }

    if (arg === "--provenance") {
      options.provenance = true;
      continue;
    }

    if (arg === "--require-git-tag-version") {
      options.requireGitTagVersion = true;
      continue;
    }

    if (arg === "--tag" || arg === "--access" || arg === "--pack-dir") {
      const value = args[index + 1];

      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value.`);
      }

      if (arg === "--tag") {
        options.tag = value;
      } else if (arg === "--access") {
        options.access = value;
      } else {
        options.packDir = resolve(repoRoot, value);
      }

      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!["public", "restricted"].includes(options.access)) {
    throw new Error(`Invalid --access value: ${options.access}`);
  }

  return options;
}

async function packPackage(packageDir, packDir) {
  const { stdout } = await runTool(pnpmTool, ["pack", "--pack-destination", packDir], {
    cwd: packageDir,
    capture: true,
  });
  const tarballName = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);

  if (!tarballName) {
    throw new Error(`Unable to determine tarball name for ${packageDir}.`);
  }

  return isAbsolute(tarballName) ? tarballName : join(packDir, tarballName);
}

async function readPackedManifest(tarballPath) {
  const { stdout } = await run("tar", ["-xOf", tarballPath, "package/package.json"], {
    cwd: repoRoot,
    capture: true,
  });

  return JSON.parse(stdout);
}

function verifyPackedManifest(tarballPath, manifest) {
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

async function verifyGitTagVersion(manifests) {
  const tagName = process.env.GITHUB_REF_NAME ?? (await readCurrentGitTag());
  const version = tagName.replace(/^v/u, "");

  if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(version)) {
    throw new Error(`Current git tag must look like v<semver>; received ${JSON.stringify(tagName)}.`);
  }

  const mismatches = manifests
    .filter((manifest) => manifest.version !== version)
    .map((manifest) => `${manifest.name}@${manifest.version}`);

  if (mismatches.length > 0) {
    throw new Error(`Git tag ${tagName} does not match package version ${version}: ${mismatches.join(", ")}`);
  }
}

async function readCurrentGitTag() {
  const { stdout } = await run("git", ["describe", "--tags", "--exact-match"], {
    cwd: repoRoot,
    capture: true,
  });

  return stdout.trim();
}

async function publishTarball(tarballPath, manifest, options) {
  const args = [
    "publish",
    tarballPath,
    "--access",
    options.access,
    "--tag",
    options.tag,
  ];

  if (options.dryRun) {
    args.push("--dry-run");
  } else if (options.provenance) {
    args.push("--provenance");
  }

  process.stdout.write(`${options.dryRun ? "Dry-run publish" : "Publishing"} ${manifest.name}@${manifest.version}\n`);
  await runTool(npmTool, args, sanitizedNpmOptions({ cwd: repoRoot }));
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
    .split(/\r?\n/u)
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
