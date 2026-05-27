import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "stele-init-"));
  tempDirs.push(directory);
  return directory;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("stele init --with-example-fixtures (python)", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("creates validate_sku.py and validate_email.py under contract/checker_impls/", async () => {
    const projectDir = await createTempDir();

    await runInit(projectDir, { language: "python", withExampleFixtures: true });

    const skuChecker = join(projectDir, "contract", "checker_impls", "validate_sku.py");
    const emailChecker = join(projectDir, "contract", "checker_impls", "validate_email.py");

    expect(await fileExists(skuChecker)).toBe(true);
    expect(await fileExists(emailChecker)).toBe(true);

    const skuContent = await readFile(skuChecker, "utf-8");
    expect(skuContent).toContain("def check(");
    expect(skuContent).toContain("SKU_PATTERN");
    expect(skuContent).toContain("passed");

    const emailContent = await readFile(emailChecker, "utf-8");
    expect(emailContent).toContain("def check(");
    expect(emailContent).toContain("EMAIL_PATTERN");
    expect(emailContent).toContain("passed");
  });

  it("writes a main.stele with uses-checker invariants for validate-sku and validate-email", async () => {
    const projectDir = await createTempDir();

    await runInit(projectDir, { language: "python", withExampleFixtures: true });

    const contractSource = await readFile(join(projectDir, "contract", "main.stele"), "utf-8");
    expect(contractSource).toContain("(uses-checker validate-sku");
    expect(contractSource).toContain("(uses-checker validate-email");
    expect(contractSource).toContain("ORDER_TOTAL_POSITIVE");
    expect(contractSource).toContain("ORDER_ID_PRESENT");
    expect(contractSource).toContain("USER_STATUS_ENUM");
  });

  it("writes a richer conftest.py with orders, user, account fixtures", async () => {
    const projectDir = await createTempDir();

    await runInit(projectDir, { language: "python", withExampleFixtures: true });

    const conftest = await readFile(join(projectDir, "tests", "contract", "conftest.py"), "utf-8");
    expect(conftest).toContain("stele_context");
    expect(conftest).toContain('"orders"');
    expect(conftest).toContain('"user"');
    expect(conftest).toContain('"account"');
    expect(conftest).toContain("_stele_checkers");
    expect(conftest).toContain("Decimal");
  });

  it("without --with-example-fixtures produces the minimal conftest without Decimal import", async () => {
    const projectDir = await createTempDir();

    await runInit(projectDir, { language: "python" });

    const conftest = await readFile(join(projectDir, "tests", "contract", "conftest.py"), "utf-8");
    expect(conftest).toContain("stele_context");
    // The rich fixture imports Decimal; the minimal one does not
    expect(conftest).not.toContain("from decimal import Decimal");
    // No example checker files
    expect(await fileExists(join(projectDir, "contract", "checker_impls", "validate_sku.py"))).toBe(false);
    expect(await fileExists(join(projectDir, "contract", "checker_impls", "validate_email.py"))).toBe(false);
  });
});

describe("stele init --with-example-fixtures (typescript)", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("creates validate-sku.ts and validate-email.ts under contract/checker_impls/", async () => {
    const projectDir = await createTempDir();

    await runInit(projectDir, { language: "typescript", withExampleFixtures: true });

    const skuChecker = join(projectDir, "contract", "checker_impls", "validate-sku.ts");
    const emailChecker = join(projectDir, "contract", "checker_impls", "validate-email.ts");

    expect(await fileExists(skuChecker)).toBe(true);
    expect(await fileExists(emailChecker)).toBe(true);

    const skuContent = await readFile(skuChecker, "utf-8");
    expect(skuContent).toContain("export function check(");
    expect(skuContent).toContain("SKU_PATTERN");
    expect(skuContent).toContain("passed");

    const emailContent = await readFile(emailChecker, "utf-8");
    expect(emailContent).toContain("export function check(");
    expect(emailContent).toContain("EMAIL_PATTERN");
    expect(emailContent).toContain("passed");
  });

  it("writes stele_context.ts with orders, user, account data", async () => {
    const projectDir = await createTempDir();

    await runInit(projectDir, { language: "typescript", withExampleFixtures: true });

    const contextFile = join(projectDir, "tests", "contract", "stele_context.ts");
    expect(await fileExists(contextFile)).toBe(true);

    const content = await readFile(contextFile, "utf-8");
    expect(content).toContain("steleContext");
    expect(content).toContain("orders");
    expect(content).toContain("user");
    expect(content).toContain("account");
    expect(content).toContain("_stele_checkers");
  });

  it("writes a main.stele with uses-checker invariants", async () => {
    const projectDir = await createTempDir();

    await runInit(projectDir, { language: "typescript", withExampleFixtures: true });

    const contractSource = await readFile(join(projectDir, "contract", "main.stele"), "utf-8");
    expect(contractSource).toContain("(uses-checker validate-sku");
    expect(contractSource).toContain("(uses-checker validate-email");
  });
});

describe("stele init --with-example-fixtures negative tests", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("is a no-op for go (no example checker files, uses default contract)", async () => {
    const projectDir = await createTempDir();

    await runInit(projectDir, { language: "go", withExampleFixtures: true });

    // No example checker files for go
    expect(await fileExists(join(projectDir, "contract", "checker_impls", "validate_sku.py"))).toBe(false);
    expect(await fileExists(join(projectDir, "contract", "checker_impls", "validate-sku.ts"))).toBe(false);

    // Contract should be the default, not the example fixtures one
    const contractSource = await readFile(join(projectDir, "contract", "main.stele"), "utf-8");
    expect(contractSource).not.toContain("ORDER_TOTAL_POSITIVE");
  });

  it("is a no-op for rust (no example checker files, uses default contract)", async () => {
    const projectDir = await createTempDir();

    await runInit(projectDir, { language: "rust", withExampleFixtures: true });

    // No example checker files for rust
    expect(await fileExists(join(projectDir, "contract", "checker_impls", "validate_sku.py"))).toBe(false);
    expect(await fileExists(join(projectDir, "contract", "checker_impls", "validate-sku.ts"))).toBe(false);

    // Contract should be the default, not the example fixtures one
    const contractSource = await readFile(join(projectDir, "contract", "main.stele"), "utf-8");
    expect(contractSource).not.toContain("ORDER_TOTAL_POSITIVE");
  });
});
