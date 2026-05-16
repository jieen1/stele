import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { isMissingFileError } from "../util/fs.js";
import type { GeneratedFile, GeneratedVerificationFile, GeneratedVerificationResult } from "./types.js";

type ExistingGeneratedEntry = {
  path: string;
  kind: "file" | "non-regular";
};

export type { ExistingGeneratedEntry };

export async function collectExistingGeneratedEntries(
  projectRoot: string,
  outputDir: string,
): Promise<ExistingGeneratedEntry[]> {
  const outputDirectoryPath = resolve(projectRoot, outputDir);

  try {
    const directory = await stat(outputDirectoryPath);

    if (!directory.isDirectory()) {
      return [];
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }

    throw error;
  }

  const entries = await walkGeneratedDirectory(outputDirectoryPath, projectRoot);
  entries.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
  return entries;
}

export async function walkGeneratedDirectory(
  directoryPath: string,
  projectRoot: string,
): Promise<ExistingGeneratedEntry[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const results: ExistingGeneratedEntry[] = [];

  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const fullPath = resolve(directoryPath, entry.name);
    const pathOnDisk = relative(projectRoot, fullPath).replace(/\\/g, "/");
    const entryStats = await lstat(fullPath);

    if (entryStats.isSymbolicLink()) {
      results.push({ path: pathOnDisk, kind: "non-regular" });
      continue;
    }

    if (entry.isDirectory()) {
      results.push(...(await walkGeneratedDirectory(fullPath, projectRoot)));
      continue;
    }

    if (entry.isFile()) {
      results.push({ path: pathOnDisk, kind: "file" });
      continue;
    }

    results.push({ path: pathOnDisk, kind: "non-regular" });
  }

  return results;
}

export async function readGeneratedFile(projectRoot: string, generatedPath: string): Promise<string> {
  return readFile(resolve(projectRoot, generatedPath), "utf8");
}

export async function verifyFiles(
  projectRoot: string,
  outputDir: string,
  expectedFiles: GeneratedFile[],
): Promise<GeneratedVerificationResult> {
  const expectedByPath = new Map(expectedFiles.map((file) => [file.path, file.content]));
  const actualEntries = await collectExistingGeneratedEntries(projectRoot, outputDir);
  const actualByPath = new Map<string, string>();
  const actualEntryKinds = new Map(actualEntries.map((entry) => [entry.path, entry.kind]));

  await Promise.all(
    actualEntries.map(async (entry) => {
      if (entry.kind !== "file") {
        actualByPath.set(entry.path, "[non-regular entry]");
        return;
      }

      actualByPath.set(entry.path, await readGeneratedFile(projectRoot, entry.path));
    }),
  );

  const files: GeneratedVerificationFile[] = [];

  for (const expectedFile of expectedFiles) {
    const actualContent = actualByPath.get(expectedFile.path);
    const actualKind = actualEntryKinds.get(expectedFile.path);

    if (actualContent === undefined) {
      files.push({
        path: expectedFile.path,
        status: "missing",
        expectedContent: expectedFile.content,
      });
      continue;
    }

    files.push({
      path: expectedFile.path,
      status: actualKind === "file" && actualContent === expectedFile.content ? "unchanged" : "changed",
      expectedContent: expectedFile.content,
      actualContent,
    });
  }

  for (const actualEntry of actualEntries) {
    if (expectedByPath.has(actualEntry.path)) {
      continue;
    }

    files.push({
      path: actualEntry.path,
      status: "extra",
      actualContent: actualByPath.get(actualEntry.path),
    });
  }

  files.sort((left, right) => left.path.localeCompare(right.path));

  return {
    ok: files.every((file) => file.status === "unchanged"),
    outputDir,
    unchanged: files.filter((file) => file.status === "unchanged").map((file) => file.path),
    missing: files.filter((file) => file.status === "missing").map((file) => file.path),
    changed: files.filter((file) => file.status === "changed").map((file) => file.path),
    extra: files.filter((file) => file.status === "extra").map((file) => file.path),
    files,
  };
}
