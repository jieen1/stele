import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { posix } from "node:path";
import {
  coordinateGeneration,
  loadContract,
  normalizeContract,
  type Contract,
  type GeneratedVerificationResult,
  type LanguageBackend,
  writeManifest,
} from "@stele/core";
import { generatePytestSource, getPythonRuntimeSource, sanitizePythonIdentifier } from "@stele/backend-python";
import { loadConfig } from "../config/loadConfig.js";

export type GenerateOptions = {
  force?: boolean;
};

export async function runGenerate(projectDir: string, options: GenerateOptions): Promise<void> {
  const config = await loadConfig(projectDir);
  const contract = await loadContract(resolve(projectDir, config.entry));
  const backend = createLanguageBackend(config.generatedDir, config.targetLanguage, config.testFramework);
  const verification = await verifyManagedGeneratedFiles(projectDir, config.generatedDir, contract, backend);

  if (!options.force && (verification.changed.length > 0 || verification.extra.length > 0)) {
    throw new Error("Generated files differ from the canonical layout. Re-run stele generate --force to replace them.");
  }

  if (options.force) {
    await Promise.all(verification.extra.map((path) => rm(join(projectDir, path), { recursive: true, force: true })));
  }

  const generatedFiles = coordinateGeneration(contract, backend, {
    projectRoot: projectDir,
    outputDir: config.generatedDir,
  });

  await Promise.all(
    generatedFiles.map(async (file) => {
      const fullPath = join(projectDir, file.path);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, file.content, "utf8");
    }),
  );

  const protectedPaths = await collectProtectedPaths(projectDir, {
    contractDir: config.contractDir,
    checkerImplDir: config.checkerImplDir,
    generatedDir: config.generatedDir,
  });

  await writeManifest(protectedPaths, resolve(projectDir, config.manifestPath), sha256(normalizeContract(contract)));
}

export function createLanguageBackend(generatedDir: string, targetLanguage: string, testFramework: string): LanguageBackend {
  if (targetLanguage !== "python") {
    throw new Error(`Unsupported target language "${targetLanguage}".`);
  }

  if (testFramework !== "pytest") {
    throw new Error(`Unsupported test framework "${testFramework}".`);
  }

  return {
    name: "python",
    framework: "pytest",
    fileExtension: ".py",
    version: "0.1.0",
    generate(contract) {
      const files = [
        {
          path: posix.join(generatedDir, "_stele_runtime.py"),
          content: getPythonRuntimeSource(),
        },
      ];
      const topLevelInvariants = contract.invariants.filter((invariant) => invariant.groupId === undefined);

      if (topLevelInvariants.length > 0) {
        files.push({
          path: posix.join(generatedDir, "test_contract.py"),
          content: generatePytestSource({
            ...contract,
            invariants: topLevelInvariants,
          }),
        });
      }

      for (const group of contract.groups) {
        files.push({
          path: posix.join(generatedDir, `test_${sanitizePythonIdentifier(group.id, "group")}.py`),
          content: generatePytestSource({
            ...contract,
            invariants: group.invariants,
          }),
        });
      }

      return files;
    },
    supportFiles() {
      return [
        {
          path: posix.join(generatedDir, "__init__.py"),
          content: "",
        },
      ];
    },
  };
}

export async function collectProtectedPaths(
  projectDir: string,
  paths: {
    contractDir: string;
    checkerImplDir: string;
    generatedDir: string;
  },
): Promise<string[]> {
  const protectedPaths = [
    ...(await collectFiles(resolve(projectDir, paths.contractDir), (path) => path.endsWith(".stele"))),
    ...(await collectFiles(resolve(projectDir, paths.checkerImplDir), (path) => !isIgnoredPythonCacheArtifact(path))),
    ...(await collectFiles(resolve(projectDir, paths.generatedDir), (path) => !isIgnoredPythonCacheArtifact(path))),
  ];

  return uniqueSortedPaths(protectedPaths);
}

export async function collectProtectedManifestPaths(
  projectDir: string,
  paths: {
    contractDir: string;
    checkerImplDir: string;
    generatedDir: string;
  },
): Promise<string[]> {
  const protectedPaths = await collectProtectedPaths(projectDir, paths);
  const normalizedProjectRoot = resolve(projectDir);

  return protectedPaths
    .map((path) => normalizeProjectRelativePath(normalizedProjectRoot, path))
    .sort((left, right) => left.localeCompare(right));
}

export async function verifyManagedGeneratedFiles(
  projectDir: string,
  generatedDir: string,
  contract: Contract,
  backend: LanguageBackend,
): Promise<GeneratedVerificationResult> {
  const { verifyGenerated } = await import("@stele/core");
  const verification = await verifyGenerated(contract, backend, {
    projectRoot: projectDir,
    outputDir: generatedDir,
  });
  const allowedExtras = new Set([posix.join(generatedDir, "conftest.py")]);
  const files = verification.files.filter(
    (file) => !(file.status === "extra" && (allowedExtras.has(file.path) || isIgnoredGeneratedArtifact(file.path, generatedDir))),
  );
  const extra = verification.extra.filter((path) => !allowedExtras.has(path) && !isIgnoredGeneratedArtifact(path, generatedDir));
  const changed = files.filter((file) => file.status === "changed").map((file) => file.path);
  const missing = files.filter((file) => file.status === "missing").map((file) => file.path);
  const unchanged = files.filter((file) => file.status === "unchanged").map((file) => file.path);

  return {
    ...verification,
    ok: missing.length === 0 && changed.length === 0 && extra.length === 0,
    files,
    unchanged,
    missing,
    changed,
    extra,
  };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function collectFiles(directory: string, filter?: (path: string) => boolean): Promise<string[]> {
  try {
    const directoryStat = await stat(directory);

    if (!directoryStat.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const files = await walkFiles(directory);
  return filter === undefined ? files : files.filter(filter);
}

async function walkFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const results = await Promise.all(
    entries
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const fullPath = join(directory, entry.name);

        if (entry.isDirectory()) {
          return walkFiles(fullPath);
        }

        if (entry.isFile()) {
          return [fullPath];
        }

        return [];
      }),
  );

  return results.flat();
}

function uniqueSortedPaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))].sort((left, right) => normalizeForSort(left).localeCompare(normalizeForSort(right)));
}

function normalizeForSort(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

function normalizeProjectRelativePath(projectDir: string, absolutePath: string): string {
  return relative(projectDir, absolutePath).replaceAll("\\", "/");
}

function isIgnoredGeneratedArtifact(projectRelativePath: string, generatedDir: string): boolean {
  const normalizedPath = projectRelativePath.replaceAll("\\", "/");
  const normalizedGeneratedDir = generatedDir.replaceAll("\\", "/");

  if (!normalizedPath.startsWith(`${normalizedGeneratedDir}/`)) {
    return false;
  }

  return isIgnoredPythonCacheArtifact(normalizedPath.slice(normalizedGeneratedDir.length + 1));
}

function isIgnoredPythonCacheArtifact(path: string): boolean {
  const normalizedPath = path.replaceAll("\\", "/");
  const segments = normalizedPath.split("/").filter((segment) => segment.length > 0);
  const basename = segments[segments.length - 1] ?? "";

  return segments.includes("__pycache__") || basename.endsWith(".pyc") || basename.endsWith(".pyo");
}
