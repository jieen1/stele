import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SteleError, type Contract } from "../src/index";
import * as stele from "../src/index";

const tempDirs: string[] = [];

describe("manifest", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("writes a deterministic manifest with a stable contract_hash and a non-hashed generated_at field", async () => {
    const projectA = await createTempProject({
      "main.stele": [
        "(invariant MANIFEST_RULE",
        "  (severity high)",
        '  (description "Semantically identical contracts should hash the same.")',
        "  (assert (eq 1 1))",
        '  (since "2026-05-04"))',
      ].join("\n"),
      "protected/nested/check.py": "print('alpha')\n",
    });
    const projectB = await createTempProject({
      "main.stele": [
        "(invariant MANIFEST_RULE",
        '  (since "2026-05-04")',
        "  (assert (eq 1 1))",
        '  (description "Semantically identical contracts should hash the same.")',
        "  (severity high))",
      ].join("\n"),
      "protected/nested/check.py": "print('alpha')\n",
    });
    const manifestPathA = join(projectA.directory, "contract", ".manifest.json");
    const manifestPathB = join(projectB.directory, "contract", ".manifest.json");
    const protectedFileA = join(projectA.directory, "protected", "nested", "check.py");
    const protectedFileB = join(projectB.directory, "protected", "nested", "check.py");
    const contractHashA = sha256(normalizeContract(await loadContract(projectA.rootPath)));
    const contractHashB = sha256(normalizeContract(await loadContract(projectB.rootPath)));

    expect(contractHashA).toBe(contractHashB);

    await writeManifest([protectedFileA], manifestPathA, contractHashA);
    await writeManifest([protectedFileB], manifestPathB, contractHashB);

    const manifestA = await readManifest(manifestPathA);
    const manifestB = await readManifest(manifestPathB);

    expect(manifestA).toMatchObject({
      version: "1",
      stele_version: "0.1.0",
      contract_hash: contractHashA,
    });
    expect(manifestA.generated_at).toBeTypeOf("string");
    expect(manifestB.generated_at).toBeTypeOf("string");
    expect(manifestB.contract_hash).toBe(contractHashA);
    expect(manifestA.contract_hash).toBe(manifestB.contract_hash);
    expect(Object.keys(manifestA.protected_files)).toEqual(["protected/nested/check.py"]);
    expect(manifestA.protected_files["protected/nested/check.py"]).toMatchObject({
      size: Buffer.byteLength("print('alpha')\n"),
    });
  });

  it("reports changed and missing protected files with byte-level hashes instead of throwing", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant VERIFY_RULE",
        "  (severity medium)",
        '  (description "Manifest verification should report details.")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });
    const manifestPath = join(project.directory, "contract", ".manifest.json");
    const changedPath = join(project.directory, "protected", "alpha.bin");
    const missingPath = join(project.directory, "protected", "beta.bin");
    const contractHash = sha256(normalizeContract(await loadContract(project.rootPath)));

    await mkdir(dirname(changedPath), { recursive: true });
    await writeFile(changedPath, Buffer.from([0x00, 0x10, 0x20, 0xff]));
    await writeFile(missingPath, Buffer.from([0x01, 0x02, 0x03, 0x04]));
    await writeManifest([changedPath, missingPath], manifestPath, contractHash);

    const manifest = await readManifest(manifestPath);

    await writeFile(changedPath, Buffer.from([0x00, 0x10, 0x21, 0xff]));
    await unlink(missingPath);

    const verification = await verifyManifest(manifestPath);
    const changedEntry = verification.files.find((file) => file.path === "protected/alpha.bin");
    const missingEntry = verification.files.find((file) => file.path === "protected/beta.bin");

    expect(verification.ok).toBe(false);
    expect(verification.contractHash).toBe(contractHash);
    expect(verification.changed).toEqual(["protected/alpha.bin"]);
    expect(verification.missing).toEqual(["protected/beta.bin"]);
    expect(changedEntry).toMatchObject({
      status: "changed",
      expected: manifest.protected_files["protected/alpha.bin"],
    });
    expect(changedEntry?.actual?.sha256).toBe(sha256(Buffer.from([0x00, 0x10, 0x21, 0xff])));
    expect(changedEntry?.actual?.sha256).not.toBe(manifest.protected_files["protected/alpha.bin"]!.sha256);
    expect(missingEntry).toMatchObject({
      status: "missing",
      expected: manifest.protected_files["protected/beta.bin"],
    });
  });

  it("preserves existing manifest content on no-op writes and refreshes generated_at only after real changes", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant STABLE_MANIFEST_RULE",
        "  (severity medium)",
        '  (description "Manifest writes should be no-ops when hashes stay stable.")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
      "protected/check.py": "print('alpha')\n",
    });
    const manifestPath = join(project.directory, "contract", ".manifest.json");
    const protectedPath = join(project.directory, "protected", "check.py");
    const contractHash = sha256(normalizeContract(await loadContract(project.rootPath)));

    await writeManifest([protectedPath], manifestPath, contractHash);
    const initialManifest = await readManifest(manifestPath);
    const pinnedGeneratedAt = "2026-05-04T00:00:00.000Z";
    await writeManifestFixture(manifestPath, initialManifest.protected_files, {
      contractHash,
      generatedAt: pinnedGeneratedAt,
    });

    await writeManifest([protectedPath], manifestPath, contractHash);
    await expect(readManifest(manifestPath)).resolves.toMatchObject({
      generated_at: pinnedGeneratedAt,
      contract_hash: contractHash,
      protected_files: initialManifest.protected_files,
    });

    await writeFile(protectedPath, "print('beta')\n", "utf8");
    await writeManifest([protectedPath], manifestPath, contractHash);

    const updatedManifest = await readManifest(manifestPath);
    expect(updatedManifest.generated_at).not.toBe(pinnedGeneratedAt);
    expect(updatedManifest.protected_files["protected/check.py"]!.sha256).toBe(sha256("print('beta')\n"));
  });

  it("writes a new manifest when the target file is missing", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant MISSING_MANIFEST_RULE",
        "  (severity medium)",
        '  (description "Missing manifests should be created.")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
      "protected/check.py": "print('alpha')\n",
    });
    const manifestPath = join(project.directory, "contract", ".manifest.json");
    const protectedPath = join(project.directory, "protected", "check.py");
    const contractHash = sha256(normalizeContract(await loadContract(project.rootPath)));

    await expect(writeManifest([protectedPath], manifestPath, contractHash)).resolves.toBeUndefined();

    await expect(readManifest(manifestPath)).resolves.toMatchObject({
      contract_hash: contractHash,
      protected_files: {
        "protected/check.py": {
          sha256: sha256("print('alpha')\n"),
          size: Buffer.byteLength("print('alpha')\n"),
        },
      },
    });
  });

  it("rejects invalid JSON manifests instead of silently overwriting them", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant INVALID_MANIFEST_RULE",
        "  (severity medium)",
        '  (description "Invalid manifests must fail closed.")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
      "protected/check.py": "print('alpha')\n",
    });
    const manifestPath = join(project.directory, "contract", ".manifest.json");
    const protectedPath = join(project.directory, "protected", "check.py");
    const contractHash = sha256(normalizeContract(await loadContract(project.rootPath)));

    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, "{bad json\n", "utf8");

    await expect(writeManifest([protectedPath], manifestPath, contractHash)).rejects.toThrowError(SteleError);
    await expect(readFile(manifestPath, "utf8")).resolves.toBe("{bad json\n");
  });

  it("rejects invalid manifest shapes instead of silently overwriting them", async () => {
    const project = await createTempProject({
      "main.stele": [
        "(invariant INVALID_MANIFEST_SHAPE_RULE",
        "  (severity medium)",
        '  (description "Invalid manifest shapes must fail closed.")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
      "protected/check.py": "print('alpha')\n",
    });
    const manifestPath = join(project.directory, "contract", ".manifest.json");
    const protectedPath = join(project.directory, "protected", "check.py");
    const contractHash = sha256(normalizeContract(await loadContract(project.rootPath)));
    const malformedShape = JSON.stringify(
      {
        version: "1",
        generated_at: "2026-05-04T00:00:00.000Z",
        stele_version: "0.1.0",
        protected_files: [],
        contract_hash: contractHash,
      },
      null,
      2,
    );

    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, malformedShape, "utf8");

    await expect(writeManifest([protectedPath], manifestPath, contractHash)).rejects.toThrowError(SteleError);
    await expect(readFile(manifestPath, "utf8")).resolves.toBe(malformedShape);
  });

  it("rejects manifest protected paths that traverse outside the manifest directory", async () => {
    const project = await createTempProject({});
    const manifestPath = join(project.directory, "contract", ".manifest.json");

    await writeManifestFixture(manifestPath, {
      "../../external-secret.txt": {
        sha256: "abc123",
        size: 1,
      },
    });

    await expect(verifyManifest(manifestPath)).rejects.toThrowError(SteleError);

    try {
      await verifyManifest(manifestPath);
    } catch (error) {
      expect(error).toBeInstanceOf(SteleError);
      expect(error).toMatchObject({
        code: "E0404",
        category: "Manifest Error",
      });
      expect((error as SteleError).message).toContain("invalid protected path");
    }
  });

  it("rejects manifest protected paths with dot segments", async () => {
    const project = await createTempProject({});
    const manifestPath = join(project.directory, "contract", "dot-segment.manifest.json");

    await writeManifestFixture(manifestPath, {
      "./relative.txt": {
        sha256: "abc123",
        size: 1,
      },
    });

    await expect(verifyManifest(manifestPath)).rejects.toThrowError(SteleError);

    try {
      await verifyManifest(manifestPath);
    } catch (error) {
      expect(error).toBeInstanceOf(SteleError);
      expect(error).toMatchObject({
        code: "E0404",
        category: "Manifest Error",
      });
      expect((error as SteleError).message).toContain("invalid protected path");
    }
  });

  it("rejects manifest protected paths that use backslashes or absolute paths", async () => {
    const project = await createTempProject({});

    for (const [label, protectedPath] of [
      ["backslash", "..\\external-secret.txt"],
      ["absolute", "/external-secret.txt"],
    ] as const) {
      const manifestPath = join(project.directory, "contract", `${label}.manifest.json`);

      await writeManifestFixture(manifestPath, {
        [protectedPath]: {
          sha256: "def456",
          size: 2,
        },
      });

      await expect(verifyManifest(manifestPath)).rejects.toThrowError(SteleError);

      try {
        await verifyManifest(manifestPath);
      } catch (error) {
        expect(error).toBeInstanceOf(SteleError);
        expect(error).toMatchObject({
          code: "E0404",
          category: "Manifest Error",
        });
        expect((error as SteleError).message).toContain("invalid protected path");
      }
    }
  });
});

async function createTempProject(files: Record<string, string>): Promise<{ directory: string; rootPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "stele-core-manifest-"));
  tempDirs.push(directory);

  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const fullPath = join(directory, relativePath);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, "utf8");
    }),
  );

  return {
    directory,
    rootPath: join(directory, "main.stele"),
  };
}

async function readManifest(manifestPath: string): Promise<{
  version: string;
  generated_at: string;
  stele_version: string;
  protected_files: Record<string, { sha256: string; size: number }>;
  contract_hash: string;
}> {
  return JSON.parse(await readFile(manifestPath, "utf8")) as {
    version: string;
    generated_at: string;
    stele_version: string;
    protected_files: Record<string, { sha256: string; size: number }>;
    contract_hash: string;
  };
}

async function writeManifestFixture(
  manifestPath: string,
  protectedFiles: Record<string, { sha256: string; size: number }>,
  options: {
    contractHash?: string;
    generatedAt?: string;
  } = {},
): Promise<void> {
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        version: "1",
        generated_at: options.generatedAt ?? "2026-05-04T00:00:00.000Z",
        stele_version: "0.1.0",
        protected_files: protectedFiles,
        contract_hash: options.contractHash ?? "fixed-contract-hash",
      },
      null,
      2,
    ),
    "utf8",
  );
}

function loadContract(rootPath: string): Promise<Contract> {
  const loadContractValue = (stele as Record<string, unknown>).loadContract;

  expect(loadContractValue).toBeTypeOf("function");

  return (loadContractValue as (path: string) => Promise<Contract>)(rootPath);
}

function normalizeContract(contract: Contract): string {
  const normalizeContractValue = (stele as Record<string, unknown>).normalizeContract;

  expect(normalizeContractValue).toBeTypeOf("function");

  return (normalizeContractValue as (value: Contract) => string)(contract);
}

function writeManifest(paths: string[], manifestPath: string, contractHash: string): Promise<void> {
  const writeManifestValue = (stele as Record<string, unknown>).writeManifest;

  expect(writeManifestValue).toBeTypeOf("function");

  return (writeManifestValue as (value: string[], path: string, hash: string) => Promise<void>)(paths, manifestPath, contractHash);
}

function verifyManifest(manifestPath: string): Promise<{
  ok: boolean;
  contractHash: string;
  changed: string[];
  missing: string[];
  files: Array<{
    path: string;
    status: string;
    expected: { sha256: string; size: number };
    actual?: { sha256: string; size: number };
  }>;
}> {
  const verifyManifestValue = (stele as Record<string, unknown>).verifyManifest;

  expect(verifyManifestValue).toBeTypeOf("function");

  return (verifyManifestValue as (path: string) => Promise<{
    ok: boolean;
    contractHash: string;
    changed: string[];
    missing: string[];
    files: Array<{
      path: string;
      status: string;
      expected: { sha256: string; size: number };
      actual?: { sha256: string; size: number };
    }>;
  }>)(manifestPath);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
