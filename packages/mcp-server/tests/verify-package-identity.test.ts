import { mkdirSync, writeFileSync, symlinkSync, rmSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { verifyPackageIdentity } from "../src/stele-binary.js";

/** Create a temp directory that is guaranteed unique. */
function makeTempDir(): string {
  const dir = join(tmpdir(), `stele-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Recursively remove a directory (best-effort). */
function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore — e.g. temp already cleaned up
  }
}

/**
 * Build a minimal @stele/cli directory tree:
 *   <base>/node_modules/@stele/cli/dist/index.js  (binary)
 *   <base>/node_modules/@stele/cli/package.json   (package)
 *
 * Returns { base, binaryPath, pkgPath }.
 */
function createCliStructure(
  base: string,
  pkgName: string = "@stele/cli",
): { base: string; binaryPath: string; pkgPath: string } {
  const cliDir = join(base, "node_modules", "@stele", "cli");
  const binDir = join(cliDir, "dist");
  mkdirSync(binDir, { recursive: true });

  const binaryPath = join(binDir, "index.js");
  writeFileSync(binaryPath, "#!/usr/bin/env node\nconsole.log('stele');\n");

  const pkgPath = join(cliDir, "package.json");
  writeFileSync(pkgPath, JSON.stringify({ name: pkgName, version: "0.1.0" }));

  return { base, binaryPath, pkgPath };
}

describe("verifyPackageIdentity", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    removeDir(tempDir);
  });

  it("rejects when binary path is a symlink", () => {
    const { binaryPath } = createCliStructure(tempDir);

    // Create a symlink pointing to the real binary
    const linkPath = join(tempDir, "linked-binary.js");
    symlinkSync(binaryPath, linkPath);

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(verifyPackageIdentity(linkPath)).toBe(false);
  });

  it("rejects when binary path does not exist", () => {
    const nonExistent = join(tempDir, "node_modules", "@stele", "cli", "dist", "does-not-exist.js");
    expect(verifyPackageIdentity(nonExistent)).toBe(false);
  });

  it("rejects when package.json is a symlink", () => {
    const { binaryPath, pkgPath } = createCliStructure(tempDir);

    // Move the real package.json aside and replace it with a symlink
    const asidePath = join(tempDir, "real-package.json");
    writeFileSync(asidePath, readFileSync(pkgPath));
    rmSync(pkgPath);
    symlinkSync(asidePath, pkgPath);

    expect(lstatSync(pkgPath).isSymbolicLink()).toBe(true);

    // The function walks up from resolve(binaryPath, "..", "..") which is
    // <base>/node_modules/@stele/cli.  The package.json there is a symlink,
    // so it should be rejected.
    expect(verifyPackageIdentity(binaryPath)).toBe(false);
  });

  it("rejects when package.json has wrong name", () => {
    const { binaryPath } = createCliStructure(tempDir, "@evil/cli");
    expect(verifyPackageIdentity(binaryPath)).toBe(false);
  });

  it("rejects when package.json is missing entirely", () => {
    const cliDir = join(tempDir, "node_modules", "@stele", "cli");
    mkdirSync(join(cliDir, "dist"), { recursive: true });
    const binaryPath = join(cliDir, "dist", "index.js");
    writeFileSync(binaryPath, "#!/usr/bin/env node\n");
    // No package.json at all
    expect(verifyPackageIdentity(binaryPath)).toBe(false);
  });

  it("accepts correct @stele/cli package", () => {
    const { binaryPath } = createCliStructure(tempDir, "@stele/cli");
    expect(verifyPackageIdentity(binaryPath)).toBe(true);
  });

  it("stops walking after 10 directory levels (depth limit)", () => {
    // Build a deeply nested path: <temp>/a/b/c/d/e/f/g/h/i/j/k/dist/index.js
    // Walking up from resolve(binaryPath, "..", "..") gives 10 levels of ascent
    // without finding a matching package.json.
    const parts = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"];
    const deepDir = parts.reduce((acc, p) => join(acc, p), tempDir);
    mkdirSync(join(deepDir, "dist"), { recursive: true });
    const binaryPath = join(deepDir, "dist", "index.js");
    writeFileSync(binaryPath, "#!/usr/bin/env node\n");

    // No package.json anywhere in the chain → depth limit hit → false
    expect(verifyPackageIdentity(binaryPath)).toBe(false);
  });

  it("finds @stele/cli package.json when nested deeper than default walk", () => {
    // Place the package.json 6 levels above the binary — within the 10-level limit.
    const deepPkgPath = join(tempDir, "node_modules", "@stele", "cli", "nested", "pkg", "package.json");
    mkdirSync(join(tempDir, "node_modules", "@stele", "cli", "nested", "pkg", "dist"), { recursive: true });
    const binaryPath = join(tempDir, "node_modules", "@stele", "cli", "nested", "pkg", "dist", "index.js");

    writeFileSync(deepPkgPath, JSON.stringify({ name: "@stele/cli", version: "0.1.0" }));
    writeFileSync(binaryPath, "#!/usr/bin/env node\n");

    // The function starts at resolve(binaryPath, "..", "..") which is the pkg dir,
    // finds package.json immediately.
    expect(verifyPackageIdentity(binaryPath)).toBe(true);
  });
});
