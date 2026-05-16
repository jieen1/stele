import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { posix as pathPosix } from "node:path";
import { isMissingFileError } from "../util/fs.js";
import { SteleError } from "../errors/SteleError.js";
import { isPlainRecord } from "../util/types.js";

const MANIFEST_VERSION = "1";
const STELE_VERSION = "0.1.0";

export type ManifestProtectedFile = {
  sha256: string;
  size: number;
};

export type ContractManifest = {
  version: string;
  generated_at: string;
  stele_version: string;
  protected_files: Record<string, ManifestProtectedFile>;
  contract_hash: string;
};

export type VerificationFileStatus = "ok" | "missing" | "changed";

export type VerifiedProtectedFile = {
  path: string;
  status: VerificationFileStatus;
  expected: ManifestProtectedFile;
  actual?: ManifestProtectedFile;
};

export type VerificationResult = {
  ok: boolean;
  manifestPath: string;
  generatedAt: string;
  contractHash: string;
  files: VerifiedProtectedFile[];
  missing: string[];
  changed: string[];
};

export async function writeManifest(paths: string[], manifestPath: string, contractHash: string): Promise<void> {
  const absoluteManifestPath = resolve(manifestPath);
  const manifestDirectory = dirname(absoluteManifestPath);
  const manifestBaseDirectory = getManifestBaseDirectory(absoluteManifestPath);
  const files = await Promise.all(
    paths.map(async (path) => {
      const absolutePath = resolve(path);
      return {
        path: normalizeManifestPath(relative(manifestBaseDirectory, absolutePath)),
        ...(await readProtectedFile(absolutePath)),
      };
    }),
  );
  const sortedFiles = files.slice().sort((left, right) => left.path.localeCompare(right.path));
  const protectedFiles: Record<string, ManifestProtectedFile> = {};

  for (const file of sortedFiles) {
    protectedFiles[file.path] = {
      sha256: file.sha256,
      size: file.size,
    };
  }

  const existingManifest = await tryReadManifestDocument(absoluteManifestPath);

  if (
    existingManifest !== undefined &&
    existingManifest.version === MANIFEST_VERSION &&
    existingManifest.stele_version === STELE_VERSION &&
    existingManifest.contract_hash === contractHash &&
    sameProtectedFiles(existingManifest.protected_files, protectedFiles)
  ) {
    return;
  }

  const manifest: ContractManifest = {
    version: MANIFEST_VERSION,
    generated_at: new Date().toISOString(),
    stele_version: STELE_VERSION,
    protected_files: protectedFiles,
    contract_hash: contractHash,
  };

  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(absoluteManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export async function verifyManifest(manifestPath: string): Promise<VerificationResult> {
  const absoluteManifestPath = resolve(manifestPath);
  const manifestBaseDirectory = getManifestBaseDirectory(absoluteManifestPath);
  const manifest = await readManifestDocument(absoluteManifestPath);
  const files: VerifiedProtectedFile[] = [];

  for (const path of Object.keys(manifest.protected_files).sort((left, right) => left.localeCompare(right))) {
    const expected = manifest.protected_files[path]!;
    validateManifestProtectedPath(path);
    const absolutePath = resolve(manifestBaseDirectory, path);

    try {
      const actual = await readProtectedFile(absolutePath);

      files.push({
        path,
        status: actual.sha256 === expected.sha256 ? "ok" : "changed",
        expected,
        actual,
      });
    } catch (error) {
      if (isMissingFileError(error)) {
        files.push({
          path,
          status: "missing",
          expected,
        });
        continue;
      }

      throw toManifestError(
        "E0403",
        `Unable to verify protected file "${path}".`,
        error,
        `Check that "${path}" is readable from the manifest directory.`,
      );
    }
  }

  const missing = files.filter((file) => file.status === "missing").map((file) => file.path);
  const changed = files.filter((file) => file.status === "changed").map((file) => file.path);

  return {
    ok: missing.length === 0 && changed.length === 0,
    manifestPath: absoluteManifestPath,
    generatedAt: manifest.generated_at,
    contractHash: manifest.contract_hash,
    files,
    missing,
    changed,
  };
}

async function readManifestDocument(manifestPath: string): Promise<ContractManifest> {
  try {
    return parseManifestDocument(manifestPath, await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error instanceof SteleError) {
      throw error;
    }

    throw toManifestError(
      "E0401",
      `Unable to read manifest "${manifestPath}".`,
      error,
      "Check that the manifest exists and that Stele has permission to read it.",
    );
  }
}

async function tryReadManifestDocument(manifestPath: string): Promise<ContractManifest | undefined> {
  try {
    return parseManifestDocument(manifestPath, await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    if (error instanceof SteleError) {
      throw error;
    }

    throw toManifestError(
      "E0401",
      `Unable to read manifest "${manifestPath}".`,
      error,
      "Check that the manifest exists and that Stele has permission to read it.",
    );
  }
}

function parseManifestDocument(manifestPath: string, content: string): ContractManifest {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw toManifestError(
      "E0402",
      `Manifest "${manifestPath}" is not valid JSON.`,
      error,
      "Regenerate the manifest or repair the JSON syntax.",
    );
  }

  if (!isManifestDocument(parsed)) {
    throw new SteleError(
      "E0402",
      "Manifest Error",
      `Manifest "${manifestPath}" has an invalid shape.`,
      undefined,
      "Expected version, generated_at, stele_version, protected_files, and contract_hash fields.",
      "Regenerate the manifest with Stele.",
    );
  }

  return parsed;
}

async function readProtectedFile(filePath: string): Promise<ManifestProtectedFile> {
  const buffer = await readFile(filePath);

  return {
    sha256: createHash("sha256").update(buffer).digest("hex"),
    size: buffer.byteLength,
  };
}

function isManifestDocument(value: unknown): value is ContractManifest {
  if (!isPlainRecord(value)) {
    return false;
  }

  if (
    typeof value.version !== "string" ||
    typeof value.generated_at !== "string" ||
    typeof value.stele_version !== "string" ||
    typeof value.contract_hash !== "string" ||
    !isPlainRecord(value.protected_files)
  ) {
    return false;
  }

  return Object.values(value.protected_files).every(
    (entry) => isPlainRecord(entry) && typeof entry.sha256 === "string" && typeof entry.size === "number",
  );
}

function sameProtectedFiles(
  left: Record<string, ManifestProtectedFile>,
  right: Record<string, ManifestProtectedFile>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every((key) => {
    const leftEntry = left[key];
    const rightEntry = right[key];
    return rightEntry !== undefined && leftEntry.sha256 === rightEntry.sha256 && leftEntry.size === rightEntry.size;
  });
}

function validateManifestProtectedPath(path: string): void {
  const segments = path.split("/");

  if (
    path.length === 0 ||
    path.includes("\\") ||
    pathPosix.isAbsolute(path) ||
    /^[A-Za-z]:\//.test(path) ||
    segments.includes("..") ||
    segments.includes(".")
  ) {
    throw new SteleError(
      "E0404",
      "Manifest Error",
      `Manifest contains an invalid protected path "${path}".`,
      undefined,
      "Protected paths must be POSIX-style relative paths inside the manifest directory.",
      "Regenerate the manifest with Stele or remove the invalid path entry.",
    );
  }
}

function normalizeManifestPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function getManifestBaseDirectory(manifestPath: string): string {
  return resolve(dirname(manifestPath), "..");
}

function toManifestError(code: string, message: string, error: unknown, hint: string): SteleError {
  const detail = sanitizeManifestError(error);
  return new SteleError(code, "Manifest Error", message, undefined, detail, hint);
}

function sanitizeManifestError(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    return `OS error: ${error.code}`;
  }
  if (error instanceof Error) {
    return error.name;
  }
  return "Unable to read manifest.";
}
