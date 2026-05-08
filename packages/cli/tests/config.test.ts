import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config/loadConfig.js";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE } from "../src/config/defaults.js";

const tempDirs: string[] = [];

describe("loadConfig", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("throws when stele.config.json does not exist", async () => {
    const projectDir = await createTempDir();
    await expect(loadConfig(projectDir)).rejects.toThrow();
  });

  it("throws SyntaxError for malformed JSON", async () => {
    const projectDir = await createTempDir();
    await writeFile(join(projectDir, STELE_CONFIG_FILE), "{ invalid json", "utf8");
    await expect(loadConfig(projectDir)).rejects.toThrow(SyntaxError);
  });

  it("loads empty object with all defaults", async () => {
    const projectDir = await createTempDir();
    await writeFile(join(projectDir, STELE_CONFIG_FILE), "{}", "utf8");
    const config = await loadConfig(projectDir);

    expect(config.version).toBe(DEFAULT_CONFIG.version);
    expect(config.contractDir).toBe(DEFAULT_CONFIG.contractDir);
    expect(config.entry).toBe(DEFAULT_CONFIG.entry);
    expect(config.generatedDir).toBe(DEFAULT_CONFIG.generatedDir);
    expect(config.checkerImplDir).toBe(DEFAULT_CONFIG.checkerImplDir);
    expect(config.manifestPath).toBe(DEFAULT_CONFIG.manifestPath);
    expect(config.targetLanguage).toBe(DEFAULT_CONFIG.targetLanguage);
    expect(config.testFramework).toBe(DEFAULT_CONFIG.testFramework);
    expect(config.pathMode).toBe(DEFAULT_CONFIG.pathMode);
    expect(config.protected).toEqual(DEFAULT_CONFIG.protected);
  });

  it("loads explicit values correctly", async () => {
    const projectDir = await createTempDir();
    const customConfig = {
      version: "1.0",
      contractDir: "custom-contract",
      entry: "custom-contract/main.stele",
      generatedDir: "custom-tests",
      checkerImplDir: "custom-checkers",
      manifestPath: "custom-contract/.manifest.json",
      targetLanguage: "typescript",
      testFramework: "jest",
      pathMode: "posix",
      protected: ["src/**/*", "lib/**/*"],
    };
    await writeFile(join(projectDir, STELE_CONFIG_FILE), JSON.stringify(customConfig), "utf8");
    const config = await loadConfig(projectDir);

    expect(config.version).toBe("1.0");
    expect(config.contractDir).toBe("custom-contract");
    expect(config.entry).toBe("custom-contract/main.stele");
    expect(config.generatedDir).toBe("custom-tests");
    expect(config.checkerImplDir).toBe("custom-checkers");
    expect(config.manifestPath).toBe("custom-contract/.manifest.json");
    expect(config.targetLanguage).toBe("typescript");
    expect(config.testFramework).toBe("jest");
    expect(config.pathMode).toBe("posix");
    expect(config.protected).toEqual(["src/**/*", "lib/**/*"]);
  });

  it("merges explicit fields with defaults for missing fields", async () => {
    const projectDir = await createTempDir();
    await writeFile(
      join(projectDir, STELE_CONFIG_FILE),
      JSON.stringify({ version: "2.0", targetLanguage: "java" }),
      "utf8",
    );
    const config = await loadConfig(projectDir);

    expect(config.version).toBe("2.0");
    expect(config.targetLanguage).toBe("java");
    expect(config.contractDir).toBe(DEFAULT_CONFIG.contractDir);
    expect(config.entry).toBe(DEFAULT_CONFIG.entry);
    expect(config.generatedDir).toBe(DEFAULT_CONFIG.generatedDir);
    expect(config.checkerImplDir).toBe(DEFAULT_CONFIG.checkerImplDir);
    expect(config.manifestPath).toBe(DEFAULT_CONFIG.manifestPath);
    expect(config.testFramework).toBe(DEFAULT_CONFIG.testFramework);
    expect(config.pathMode).toBe(DEFAULT_CONFIG.pathMode);
    expect(config.protected).toEqual(DEFAULT_CONFIG.protected);
  });

  it("rejects absolute path in contractDir", async () => {
    const projectDir = await createTempDir();
    await writeFile(
      join(projectDir, STELE_CONFIG_FILE),
      JSON.stringify({ contractDir: "/absolute/path" }),
      "utf8",
    );
    await expect(loadConfig(projectDir)).rejects.toThrow(/project-relative path/);
  });

  it("rejects parent traversal in contractDir", async () => {
    const projectDir = await createTempDir();
    await writeFile(
      join(projectDir, STELE_CONFIG_FILE),
      JSON.stringify({ contractDir: "../escape" }),
      "utf8",
    );
    await expect(loadConfig(projectDir)).rejects.toThrow(/must stay inside the project root/);
  });

  it("rejects absolute path in manifestPath", async () => {
    const projectDir = await createTempDir();
    await writeFile(
      join(projectDir, STELE_CONFIG_FILE),
      JSON.stringify({ manifestPath: "/absolute/manifest.json" }),
      "utf8",
    );
    await expect(loadConfig(projectDir)).rejects.toThrow(/project-relative path/);
  });

  it("rejects manifestPath with wrong segment count (3 segments)", async () => {
    const projectDir = await createTempDir();
    await writeFile(
      join(projectDir, STELE_CONFIG_FILE),
      JSON.stringify({ manifestPath: "too/many/segments.json" }),
      "utf8",
    );
    await expect(loadConfig(projectDir)).rejects.toThrow(/must live in a first-level project directory/);
  });

  it("rejects manifestPath with wrong segment count (1 segment)", async () => {
    const projectDir = await createTempDir();
    await writeFile(
      join(projectDir, STELE_CONFIG_FILE),
      JSON.stringify({ manifestPath: "contract" }),
      "utf8",
    );
    await expect(loadConfig(projectDir)).rejects.toThrow(/must live in a first-level project directory/);
  });

  it("rejects protected field that is not an array", async () => {
    const projectDir = await createTempDir();
    await writeFile(
      join(projectDir, STELE_CONFIG_FILE),
      JSON.stringify({ protected: "not-an-array" }),
      "utf8",
    );
    await expect(loadConfig(projectDir)).rejects.toThrow(/must be an array/);
  });

  it("rejects protected field with empty string entry", async () => {
    const projectDir = await createTempDir();
    await writeFile(
      join(projectDir, STELE_CONFIG_FILE),
      JSON.stringify({ protected: [""] }),
      "utf8",
    );
    await expect(loadConfig(projectDir)).rejects.toThrow(/must be an array of non-empty/);
  });

  it("rejects protected pattern with absolute path", async () => {
    const projectDir = await createTempDir();
    await writeFile(
      join(projectDir, STELE_CONFIG_FILE),
      JSON.stringify({ protected: ["/absolute/path"] }),
      "utf8",
    );
    await expect(loadConfig(projectDir)).rejects.toThrow(/project-relative glob strings/);
  });

  it("rejects protected pattern with parent traversal", async () => {
    const projectDir = await createTempDir();
    await writeFile(
      join(projectDir, STELE_CONFIG_FILE),
      JSON.stringify({ protected: ["../escape"] }),
      "utf8",
    );
    await expect(loadConfig(projectDir)).rejects.toThrow(/must not escape the project root/);
  });

  it("rejects protected pattern with bracket glob syntax", async () => {
    const projectDir = await createTempDir();
    await writeFile(
      join(projectDir, STELE_CONFIG_FILE),
      JSON.stringify({ protected: ["src/[test].py"] }),
      "utf8",
    );
    await expect(loadConfig(projectDir)).rejects.toThrow(/bracket glob syntax/);
  });

  it("rejects protected pattern that is not a string", async () => {
    const projectDir = await createTempDir();
    await writeFile(
      join(projectDir, STELE_CONFIG_FILE),
      JSON.stringify({ protected: [123, null] }),
      "utf8",
    );
    await expect(loadConfig(projectDir)).rejects.toThrow(/must be an array of non-empty/);
  });

  it("falls back to default for empty string entry field", async () => {
    const projectDir = await createTempDir();
    await writeFile(join(projectDir, STELE_CONFIG_FILE), JSON.stringify({ entry: "" }), "utf8");
    const config = await loadConfig(projectDir);
    expect(config.entry).toBe(DEFAULT_CONFIG.entry);
  });

  it("falls back to default for empty string checkerImplDir field", async () => {
    const projectDir = await createTempDir();
    await writeFile(
      join(projectDir, STELE_CONFIG_FILE),
      JSON.stringify({ checkerImplDir: "" }),
      "utf8",
    );
    const config = await loadConfig(projectDir);
    expect(config.checkerImplDir).toBe(DEFAULT_CONFIG.checkerImplDir);
  });

  it("returns independent copy of protected array", async () => {
    const projectDir = await createTempDir();
    await writeFile(join(projectDir, STELE_CONFIG_FILE), "{}", "utf8");
    const config = await loadConfig(projectDir);
    config.protected.push("mutated");

    const config2 = await loadConfig(projectDir);
    expect(config2.protected).not.toContain("mutated");
    expect(config2.protected).toEqual(DEFAULT_CONFIG.protected);
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stele-config-test-"));
  tempDirs.push(dir);
  return dir;
}
