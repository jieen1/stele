import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDoctor } from "../src/commands/doctor.js";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE } from "../src/config/defaults.js";

// Skip tests that need pytest when pytest is unavailable
const _PYTEST_AVAILABLE = (() => {
  try {
    execFileSync("python3", ["-c", "import pytest"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
// Reserved for future pytest-specific checks
const _itIfPytest = _PYTEST_AVAILABLE ? it : it.skip;

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stele-doctor-"));
  tempDirs.push(dir);
  return dir;
}

async function writeProjectFile(projectDir: string, rel: string, content: string): Promise<void> {
  const full = join(projectDir, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

async function createFixtureProject(projectDir: string): Promise<void> {
  await writeProjectFile(projectDir, STELE_CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  await writeProjectFile(
    projectDir,
    "contract/main.stele",
    [
      "(invariant TEST_RULE",
      "  (severity high)",
      '  (description "Test invariant.")',
      "  (assert (eq 1 1)))",
    ].join("\n") + "\n",
  );
  await mkdir(join(projectDir, "tests", "contract"), { recursive: true });
}

describe("stele doctor", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    // Reset exit code so tests are isolated
    process.exitCode = undefined;
    await Promise.allSettled(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  describe("stele.config.json check", () => {
    it("passes when stele.config.json exists and is valid JSON", async () => {
      const projectDir = await createTempDir();
      await createFixtureProject(projectDir);
      const stdout = captureStdout();

      await runDoctor(projectDir, {});

      expect(stdout.read()).toContain("stele.config.json is valid");
    });

    it("errors when stele.config.json is missing", async () => {
      const projectDir = await createTempDir();
      const stdout = captureStdout();

      await runDoctor(projectDir, {});

      expect(stdout.read()).toContain("not found");
      expect(process.exitCode).toBe(1);
    });

    it("errors when stele.config.json is malformed JSON", async () => {
      const projectDir = await createTempDir();
      await writeProjectFile(projectDir, STELE_CONFIG_FILE, "{ BAD JSON }");
      const stdout = captureStdout();

      await runDoctor(projectDir, {});

      expect(stdout.read()).toContain("malformed JSON");
      expect(process.exitCode).toBe(1);
    });
  });

  describe("contract/ directory check", () => {
    it("passes when contract/ exists", async () => {
      const projectDir = await createTempDir();
      await createFixtureProject(projectDir);
      const stdout = captureStdout();

      await runDoctor(projectDir, {});

      expect(stdout.read()).toContain("contract/ exists");
    });

    it("errors when contract/ is missing", async () => {
      const projectDir = await createTempDir();
      await writeProjectFile(projectDir, STELE_CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
      const stdout = captureStdout();

      await runDoctor(projectDir, {});

      const out = stdout.read();
      expect(out).toMatch(/contract\/.* not found/);
      expect(process.exitCode).toBe(1);
    });
  });

  describe("contract/main.stele check", () => {
    it("passes when main.stele parses and shows invariant count", async () => {
      const projectDir = await createTempDir();
      await createFixtureProject(projectDir);
      const stdout = captureStdout();

      await runDoctor(projectDir, {});

      expect(stdout.read()).toMatch(/parses \(\d+ invariant/);
    });

    it("errors when main.stele is missing", async () => {
      const projectDir = await createTempDir();
      await writeProjectFile(projectDir, STELE_CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
      await mkdir(join(projectDir, "contract"), { recursive: true });
      // No main.stele
      await mkdir(join(projectDir, "tests", "contract"), { recursive: true });
      const stdout = captureStdout();

      await runDoctor(projectDir, {});

      expect(stdout.read()).toContain("not found");
      expect(process.exitCode).toBe(1);
    });
  });

  describe("generated tests directory check", () => {
    it("passes when tests/contract/ exists", async () => {
      const projectDir = await createTempDir();
      await createFixtureProject(projectDir);
      const stdout = captureStdout();

      await runDoctor(projectDir, {});

      expect(stdout.read()).toContain("tests/contract/ exists");
    });

    it("warns when tests/contract/ is missing", async () => {
      const projectDir = await createTempDir();
      await writeProjectFile(projectDir, STELE_CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
      await writeProjectFile(
        projectDir,
        "contract/main.stele",
        "(invariant X (severity high) (description \"x\") (assert (eq 1 1)))\n",
      );
      // No tests/contract/
      const stdout = captureStdout();

      await runDoctor(projectDir, {});

      const out = stdout.read();
      expect(out).toContain("⚠");
      expect(out).toMatch(/tests\/contract\/.*not found/);
    });
  });

  describe("manifest check", () => {
    it("warns when contract/.manifest.json is missing", async () => {
      const projectDir = await createTempDir();
      await createFixtureProject(projectDir);
      const stdout = captureStdout();

      await runDoctor(projectDir, {});

      const out = stdout.read();
      expect(out).toContain("⚠");
      expect(out).toMatch(/No contract\/\.manifest\.json/);
    });

    it("passes when contract/.manifest.json exists", async () => {
      const projectDir = await createTempDir();
      await createFixtureProject(projectDir);
      await writeProjectFile(projectDir, "contract/.manifest.json", '{"protected_files":{}}\n');
      const stdout = captureStdout();

      await runDoctor(projectDir, {});

      expect(stdout.read()).toContain("manifest is locked");
    });
  });

  describe("Claude Code plugin checks", () => {
    it("outputs a line about Claude Code plugin status", async () => {
      const projectDir = await createTempDir();
      await createFixtureProject(projectDir);
      const stdout = captureStdout();

      // Run with real home dir — checks pass or warn depending on environment
      await runDoctor(projectDir, {});

      const out = stdout.read();
      // Either "not detected" (no ~/.claude/) or plugin check lines present
      expect(out).toMatch(/Claude Code|claude|plugin/i);
    });
  });

  describe("--json output", () => {
    it("emits a JSON array of findings", async () => {
      const projectDir = await createTempDir();
      await createFixtureProject(projectDir);
      const stdout = captureStdout();

      await runDoctor(projectDir, { json: true });

      const raw = stdout.read();
      const findings = JSON.parse(raw);
      expect(Array.isArray(findings)).toBe(true);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]).toHaveProperty("check");
      expect(findings[0]).toHaveProperty("status");
      expect(findings[0]).toHaveProperty("message");
    });

    it("json output includes fix field when there are warnings", async () => {
      const projectDir = await createTempDir();
      await createFixtureProject(projectDir);
      // No manifest — will produce a warning
      const stdout = captureStdout();

      await runDoctor(projectDir, { json: true });

      const findings = JSON.parse(stdout.read()) as Array<{
        check: string;
        status: string;
        message: string;
        fix?: string;
      }>;
      const manifestFinding = findings.find((f) => f.check === "manifest lock");
      expect(manifestFinding).toBeDefined();
      expect(manifestFinding?.status).toBe("warn");
      expect(manifestFinding?.fix).toBeTruthy();
    });
  });

  describe("summary line", () => {
    it("prints summary with counts", async () => {
      const projectDir = await createTempDir();
      await createFixtureProject(projectDir);
      const stdout = captureStdout();

      await runDoctor(projectDir, {});

      const out = stdout.read();
      expect(out).toMatch(/Summary: \d+ OK, \d+ warnings, \d+ errors\./);
    });
  });

  describe("exit code", () => {
    // Only assert clean exit when pytest is available; otherwise toolchain
    // check reports an error (which is correct behaviour, not a test bug).
    const itIfPytestAvail = _PYTEST_AVAILABLE ? it : it.skip;
    itIfPytestAvail("exits 0 (no exitCode change) when there are only warnings", async () => {
      const projectDir = await createTempDir();
      await createFixtureProject(projectDir);
      // afterEach resets process.exitCode to undefined between tests
      captureStdout();

      await runDoctor(projectDir, {});

      // No hard errors (just warnings like missing manifest) — exit stays undefined or 0
      expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
    });

    it("exits 1 when there is an error", async () => {
      const projectDir = await createTempDir();
      // No stele.config.json — guaranteed error
      captureStdout();

      await runDoctor(projectDir, {});

      expect(process.exitCode).toBe(1);
    });
  });
});

// --- helpers ---

function captureStdout(): { read(): string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write);
  return { read: () => chunks.join("") };
}
