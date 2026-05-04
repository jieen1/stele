import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { Contract } from "../src/index";
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
    await delay(20);
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
    expect(manifestA.generated_at).not.toBe(manifestB.generated_at);
    expect(manifestB.contract_hash).toBe(contractHashA);
    expect(Object.keys(manifestA.protected_files)).toEqual(["../protected/nested/check.py"]);
    expect(manifestA.protected_files["../protected/nested/check.py"]).toMatchObject({
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
    const changedEntry = verification.files.find((file) => file.path === "../protected/alpha.bin");
    const missingEntry = verification.files.find((file) => file.path === "../protected/beta.bin");

    expect(verification.ok).toBe(false);
    expect(verification.contractHash).toBe(contractHash);
    expect(verification.changed).toEqual(["../protected/alpha.bin"]);
    expect(verification.missing).toEqual(["../protected/beta.bin"]);
    expect(changedEntry).toMatchObject({
      status: "changed",
      expected: manifest.protected_files["../protected/alpha.bin"],
    });
    expect(changedEntry?.actual?.sha256).toBe(sha256(Buffer.from([0x00, 0x10, 0x21, 0xff])));
    expect(changedEntry?.actual?.sha256).not.toBe(manifest.protected_files["../protected/alpha.bin"].sha256);
    expect(missingEntry).toMatchObject({
      status: "missing",
      expected: manifest.protected_files["../protected/beta.bin"],
    });
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
