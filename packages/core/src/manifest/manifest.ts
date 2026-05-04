import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { SteleError } from "../errors/SteleError.js";

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
  const files = await Promise.all(
    paths.map(async (path) => {
      const absolutePath = resolve(path);
      return {
        path: normalizeManifestPath(relative(manifestDirectory, absolutePath)),
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
  const manifestDirectory = dirname(absoluteManifestPath);
  const manifest = await readManifestDocument(absoluteManifestPath);
  const files: VerifiedProtectedFile[] = [];

  for (const path of Object.keys(manifest.protected_files).sort((left, right) => left.localeCompare(right))) {
    const expected = manifest.protected_files[path]!;
    const absolutePath = resolve(manifestDirectory, path);

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
  let content: string;

  try {
    content = await readFile(manifestPath, "utf8");
  } catch (error) {
    throw toManifestError(
      "E0401",
      `Unable to read manifest "${manifestPath}".`,
      error,
      "Check that the manifest exists and that Stele has permission to read it.",
    );
  }

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
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.version !== "string" ||
    typeof value.generated_at !== "string" ||
    typeof value.stele_version !== "string" ||
    typeof value.contract_hash !== "string" ||
    !isRecord(value.protected_files)
  ) {
    return false;
  }

  return Object.values(value.protected_files).every(
    (entry) => isRecord(entry) && typeof entry.sha256 === "string" && typeof entry.size === "number",
  );
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function normalizeManifestPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function toManifestError(code: string, message: string, error: unknown, hint: string): SteleError {
  const detail = error instanceof Error ? error.message : "Unknown manifest error.";
  return new SteleError(code, "Manifest Error", message, undefined, detail, hint);
}
