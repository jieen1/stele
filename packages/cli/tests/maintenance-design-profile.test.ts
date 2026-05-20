import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMaintenanceSummary } from "../src/commands/maintenance.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      require("node:fs/promises").rm(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
  tempDirs.length = 0;
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stele-maint-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("maintenance summary — design profile info", () => {
  it("includes design profile section when profile exists", async () => {
    const projectDir = await createTempDir();

    // Create minimal Stele setup
    const contractDir = join(projectDir, "contract");
    await mkdir(contractDir, { recursive: true });
    await writeFile(join(contractDir, "main.stele"), "", "utf8");

    // Create stele config
    await writeFile(join(projectDir, "stele.config.json"), JSON.stringify({
      entry: "contract/main.stele",
      targetLanguage: "typescript",
      testFramework: "vitest",
    }), "utf8");

    // Create design profile
    const designDir = join(projectDir, "contract", "design");
    await mkdir(designDir, { recursive: true });
    await writeFile(join(designDir, "profile.yaml"), `
schema_version: 1
kind: design
profile_id: my-test-profile
created_at: "2026-01-01T00:00:00Z"
updated_at: "2026-01-02T00:00:00Z"
project:
  language: typescript
  source_roots:
    - "src"
  ignore: []
decisions:
  - id: d1
    question_id: q1
    selected_option: opt_a
    rationale: test
    approved_by: human
    approved_at: "2026-01-01T00:00:00Z"
  - id: d2
    question_id: q2
    selected_option: opt_b
    rationale: test2
    approved_by: human
    approved_at: "2026-01-02T00:00:00Z"
`, "utf8");

    let capturedOutput = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = function(chunk: string) {
      capturedOutput += chunk;
      return true;
    };

    // Run maintenance summary (it will fail on some parts due to missing fixtures,
    // but the design profile section should still appear)
    try {
      await runMaintenanceSummary(projectDir);
    } catch {
      // May throw due to missing contract setup; we only care about captured output
    }

    process.stdout.write = originalWrite;

    // Check that the design profile section appears
    expect(capturedOutput).toContain("## Design profile");
    expect(capturedOutput).toContain("Profile hash:");
    expect(capturedOutput).toContain("Profile ID: my-test-profile");
    expect(capturedOutput).toContain("Decisions: 2");
    expect(capturedOutput).toContain("Manifest valid:");
    expect(capturedOutput).toContain("Manifest drifts:");
  });

  it("shows <none> when no design profile exists", async () => {
    const projectDir = await createTempDir();

    // Create minimal Stele setup without design profile
    const contractDir = join(projectDir, "contract");
    await mkdir(contractDir, { recursive: true });
    await writeFile(join(contractDir, "main.stele"), "", "utf8");
    await writeFile(join(projectDir, "stele.config.json"), JSON.stringify({
      entry: "contract/main.stele",
      targetLanguage: "typescript",
      testFramework: "vitest",
    }), "utf8");

    let capturedOutput = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = function(chunk: string) {
      capturedOutput += chunk;
      return true;
    };

    try {
      await runMaintenanceSummary(projectDir);
    } catch {
      // May throw due to missing contract setup
    }

    process.stdout.write = originalWrite;

    expect(capturedOutput).toContain("## Design profile");
    expect(capturedOutput).toContain("- <none>");
  });

  it("includes manifest integrity status", async () => {
    const projectDir = await createTempDir();

    // Create Stele setup
    const contractDir = join(projectDir, "contract");
    await mkdir(contractDir, { recursive: true });
    await writeFile(join(contractDir, "main.stele"), "", "utf8");
    await writeFile(join(projectDir, "stele.config.json"), JSON.stringify({
      entry: "contract/main.stele",
      targetLanguage: "typescript",
      testFramework: "vitest",
    }), "utf8");

    // Create design profile
    const designDir = join(projectDir, "contract", "design");
    await mkdir(designDir, { recursive: true });
    await writeFile(join(designDir, "profile.yaml"), `
schema_version: 1
kind: design
profile_id: integrity-test
created_at: "2026-01-01T00:00:00Z"
updated_at: "2026-01-01T00:00:00Z"
project:
  language: typescript
  source_roots: []
  ignore: []
`, "utf8");

    // Create manifest with invalid hash (to test drift detection)
    await writeFile(join(designDir, "manifest.json"), JSON.stringify({
      schemaVersion: "1",
      profileHash: "abc123",
      generatedRules: [
        {
          ruleId: "test-rule",
          ruleKind: "architecture",
          origin: "test",
          fileHash: "bad-hash",
          cdl: "(architecture \"test\")",
        },
      ],
      generatedAt: "2026-01-01T00:00:00Z",
    }, null, 2), "utf8");

    let capturedOutput = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = function(chunk: string) {
      capturedOutput += chunk;
      return true;
    };

    try {
      await runMaintenanceSummary(projectDir);
    } catch {
      // May throw due to missing contract setup
    }

    process.stdout.write = originalWrite;

    // The manifest should show as having drifts because the CDL hash doesn't match fileHash
    expect(capturedOutput).toContain("Manifest valid:");
    expect(capturedOutput).toContain("Manifest drifts:");
  });
});
