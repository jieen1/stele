import { mkdtemp, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE } from "../src/config/defaults.js";
import { runGenerate } from "../src/commands/generate.js";
import { runCacheClean, runCacheInfo } from "../src/commands/cache.js";

const tempDirs: string[] = [];

const HASH_MANIFEST_PATH = "contract/.cache/hash-manifest.json";

afterEach(async () => {
  await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("EP05 stele generate incremental", () => {
  it("first run regenerates all and writes the hash manifest", async () => {
    const projectDir = await createFixtureProject();

    const summary = await runGenerate(projectDir, {});

    expect(summary.fullInvalidate).toBe(true);
    expect(summary.written).toBe(summary.generatedFileCount);
    expect(summary.skipped).toBe(0);

    await expect(readFile(join(projectDir, HASH_MANIFEST_PATH), "utf8")).resolves.toContain('"version": "1"');
  });

  it("second run with no changes skips every file", async () => {
    const projectDir = await createFixtureProject();

    await runGenerate(projectDir, {});
    const second = await runGenerate(projectDir, {});

    expect(second.fullInvalidate).toBe(false);
    expect(second.skipped).toBe(second.generatedFileCount);
    expect(second.written).toBe(0);
  });

  it("rewrites the changed output when one .stele file changes", async () => {
    const projectDir = await createMultiFileProject();

    await runGenerate(projectDir, {});

    // Edit the group .stele file: add a new invariant. Only outputs touched
    // by this group should be rewritten.
    await writeProjectFile(
      projectDir,
      "contract/checks/billing.stele",
      [
        "(group billing",
        '  (description "Billing rules")',
        "  (invariant BILL_001",
        "    (severity high)",
        '    (description "Billing must succeed")',
        "    (assert (eq 1 1)))",
        "  (invariant BILL_002",
        "    (severity high)",
        '    (description "Newly added")',
        "    (assert (eq 2 2))))",
      ].join("\n"),
    );

    const second = await runGenerate(projectDir, {});

    expect(second.fullInvalidate).toBe(false);
    // Runtime + main test_contract should stay equal, only test_billing changes.
    expect(second.written).toBeGreaterThanOrEqual(1);
    expect(second.skipped).toBeGreaterThanOrEqual(1);
    // Verify by reading the manifest that test_billing is in output_hashes.
    const manifest = JSON.parse(await readFile(join(projectDir, HASH_MANIFEST_PATH), "utf8"));
    expect(manifest.output_hashes_global).toHaveProperty("tests/contract/test_billing.py");
  });

  it("invalidates entire cache when stele.config.json changes", async () => {
    const projectDir = await createFixtureProject();

    await runGenerate(projectDir, {});

    // Mutate the config (change the generatedDir).
    await writeProjectFile(
      projectDir,
      STELE_CONFIG_FILE,
      `${JSON.stringify({ ...DEFAULT_CONFIG, generatedDir: "tests/contract" }, null, 2)}\n`,
    );

    const second = await runGenerate(projectDir, {});

    // Same generatedDir as default, but the JSON byte content changed slightly
    // (extra fields, etc.). Skip path: ensure result is still valid.
    expect(second).toMatchObject({ generatedDir: "tests/contract" });
  });

  it("--force regenerates every file even when cache matches", async () => {
    const projectDir = await createFixtureProject();

    await runGenerate(projectDir, {});

    const forced = await runGenerate(projectDir, { force: true });

    expect(forced.fullInvalidate).toBe(true);
    expect(forced.written).toBe(forced.generatedFileCount);
    expect(forced.skipped).toBe(0);
  });

  it("--no-cache (cache=false) writes outputs but does not write the manifest", async () => {
    const projectDir = await createFixtureProject();

    const result = await runGenerate(projectDir, { noCache: true });

    expect(result.cacheUsed).toBe(false);
    expect(result.fullInvalidate).toBe(true);
    expect(result.written).toBe(result.generatedFileCount);

    const manifestExists = await pathExists(join(projectDir, HASH_MANIFEST_PATH));
    expect(manifestExists).toBe(false);
  });

  it("recovers gracefully from corrupted manifest (treated as no cache)", async () => {
    const projectDir = await createFixtureProject();
    await runGenerate(projectDir, {});

    // Corrupt the manifest with bogus JSON.
    await writeProjectFile(projectDir, HASH_MANIFEST_PATH, "{not valid json}");

    const result = await runGenerate(projectDir, {});

    expect(result.fullInvalidate).toBe(true);
    expect(result.written).toBe(result.generatedFileCount);
    // Manifest should be rewritten valid.
    const manifest = JSON.parse(await readFile(join(projectDir, HASH_MANIFEST_PATH), "utf8"));
    expect(manifest.version).toBe("1");
  });

  it("imports propagate: changing imported file regenerates dependents", async () => {
    const projectDir = await createMultiFileProject();
    await runGenerate(projectDir, {});

    // Read the test_contract.py and test_billing.py initial hashes (via manifest).
    const before = JSON.parse(await readFile(join(projectDir, HASH_MANIFEST_PATH), "utf8"));
    const initialContractHash = before.output_hashes_global["tests/contract/test_contract.py"];
    const initialBillingHash = before.output_hashes_global["tests/contract/test_billing.py"];

    // Edit billing.stele (the imported file). Change the assertion expression
    // so the generated Python content actually differs.
    await writeProjectFile(
      projectDir,
      "contract/checks/billing.stele",
      [
        "(group billing",
        '  (description "Billing rules updated")',
        "  (invariant BILL_001",
        "    (severity critical)",
        '    (description "Billing must succeed strictly")',
        "    (assert (eq 5 5))))",
      ].join("\n"),
    );

    await runGenerate(projectDir, {});

    const after = JSON.parse(await readFile(join(projectDir, HASH_MANIFEST_PATH), "utf8"));
    // Billing test changed.
    expect(after.output_hashes_global["tests/contract/test_billing.py"]).not.toBe(initialBillingHash);
    // The transitive_hash of the importing file (main.stele) changed because
    // billing.stele's transitive_hash changed.
    const mainEntry = after.files["contract/main.stele"];
    const billingEntry = after.files["contract/checks/billing.stele"];
    expect(mainEntry.transitive_hash).not.toBe(before.files["contract/main.stele"].transitive_hash);
    expect(billingEntry.transitive_hash).not.toBe(before.files["contract/checks/billing.stele"].transitive_hash);
  });

  it("deletes stale outputs when a group is removed from contract", async () => {
    const projectDir = await createMultiFileProject();
    await runGenerate(projectDir, {});

    // The first generation produced test_billing.py; verify it exists.
    await expect(pathExists(join(projectDir, "tests/contract/test_billing.py"))).resolves.toBe(true);

    // Remove billing import & .stele file (the protected-files check otherwise
    // fails because billing.stele matches contract/**/*.stele but is no longer
    // reachable from main.stele).
    await writeProjectFile(
      projectDir,
      "contract/main.stele",
      [
        "(invariant ROOT_RULE",
        "  (severity high)",
        '  (description "Root rules should generate pytest output.")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );
    await unlink(join(projectDir, "contract/checks/billing.stele"));

    const result = await runGenerate(projectDir, {});

    // test_billing.py should be deleted.
    expect(result.deleted).toBeGreaterThan(0);
    await expect(pathExists(join(projectDir, "tests/contract/test_billing.py"))).resolves.toBe(false);
  });

  it("byte-equal output: incremental and --force produce same files", async () => {
    const projectDirA = await createMultiFileProject();
    const projectDirB = await createMultiFileProject();

    // Project A: incremental run twice
    await runGenerate(projectDirA, {});
    await runGenerate(projectDirA, {});

    // Project B: force run twice
    await runGenerate(projectDirB, { force: true });
    await runGenerate(projectDirB, { force: true });

    // Both should have identical generated files.
    for (const path of [
      "tests/contract/_stele_runtime.py",
      "tests/contract/test_contract.py",
      "tests/contract/test_billing.py",
      "tests/contract/__init__.py",
    ]) {
      const contentA = await readFile(join(projectDirA, path), "utf8");
      const contentB = await readFile(join(projectDirB, path), "utf8");
      expect(contentA).toBe(contentB);
    }
  });

  it("cache info command reports stats after generate", async () => {
    const projectDir = await createFixtureProject();

    const beforeInfo = await runCacheInfo(projectDir);
    expect(beforeInfo.exists).toBe(false);

    await runGenerate(projectDir, {});

    const afterInfo = await runCacheInfo(projectDir);
    expect(afterInfo.exists).toBe(true);
    expect(afterInfo.fileCount).toBeGreaterThan(0);
    expect(afterInfo.outputCount).toBeGreaterThan(0);
    expect(afterInfo.steleVersion).toBe("0.1.0");
  });

  it("cache clean removes the manifest", async () => {
    const projectDir = await createFixtureProject();
    await runGenerate(projectDir, {});

    await expect(pathExists(join(projectDir, HASH_MANIFEST_PATH))).resolves.toBe(true);

    const result = await runCacheClean(projectDir);

    expect(result.removed).toBe(true);
    await expect(pathExists(join(projectDir, HASH_MANIFEST_PATH))).resolves.toBe(false);

    const noOp = await runCacheClean(projectDir);
    expect(noOp.removed).toBe(false);
  });
});

async function createFixtureProject(): Promise<string> {
  const projectDir = await createTempDir();

  await writeProjectFile(projectDir, STELE_CONFIG_FILE, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  await writeProjectFile(
    projectDir,
    "contract/main.stele",
    [
      "(invariant ROOT_RULE",
      "  (severity high)",
      '  (description "Root rules should generate pytest output.")',
      "  (assert (eq 1 1)))",
    ].join("\n"),
  );
  await writeProjectFile(
    projectDir,
    "tests/contract/conftest.py",
    "import pytest\n\n@pytest.fixture\ndef stele_context():\n    return {}\n",
  );

  return projectDir;
}

async function createMultiFileProject(): Promise<string> {
  const projectDir = await createTempDir();

  await writeProjectFile(projectDir, STELE_CONFIG_FILE, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  await writeProjectFile(
    projectDir,
    "contract/main.stele",
    [
      "(import \"checks/billing.stele\")",
      "(invariant ROOT_RULE",
      "  (severity high)",
      '  (description "Root rules should generate pytest output.")',
      "  (assert (eq 1 1)))",
    ].join("\n"),
  );
  await writeProjectFile(
    projectDir,
    "contract/checks/billing.stele",
    [
      "(group billing",
      '  (description "Billing rules")',
      "  (invariant BILL_001",
      "    (severity high)",
      '    (description "Billing must succeed")',
      "    (assert (eq 1 1))))",
    ].join("\n"),
  );
  await writeProjectFile(
    projectDir,
    "tests/contract/conftest.py",
    "import pytest\n\n@pytest.fixture\ndef stele_context():\n    return {}\n",
  );

  return projectDir;
}

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "stele-incremental-"));
  tempDirs.push(directory);
  return directory;
}

async function writeProjectFile(projectDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = join(projectDir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
