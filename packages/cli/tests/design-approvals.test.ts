import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDesignApprove } from "../src/commands/design/approve.js";
import { readFileSync } from "node:fs";

const tempDirs: string[] = [];

// Round 4 D-02 follow-up: design-approvals tests run runDesignApprove
// non-interactively; the new human-identity gate requires either an
// interactive TTY or STELE_APPROVED_BY env. Set the env for the entire
// suite so every test exercises the post-gate code paths.
// Round 10 Q-04 follow-up: the denylist now splits on `:` / `@` and
// rejects `test`, `fixture`, and round-N tokens. Use a realistic
// email-shaped value that passes all current checks.
const _previousApprovedBy = process.env.STELE_APPROVED_BY;
process.env.STELE_APPROVED_BY = "qa-operator@stele.example.com";

afterEach(() => {
  // Cleanup temp directories
  for (const dir of tempDirs) {
    try {
      require("node:fs/promises").rm(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
  tempDirs.length = 0;
});

// Restore the original env after the suite completes.
process.on("exit", () => {
  if (_previousApprovedBy === undefined) {
    delete process.env.STELE_APPROVED_BY;
  } else {
    process.env.STELE_APPROVED_BY = _previousApprovedBy;
  }
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stele-approve-test-"));
  tempDirs.push(dir);
  return dir;
}

function createProfile(content: Record<string, unknown>): string {
  // Simple YAML-like serialization for test purposes
  const lines: string[] = [];
  for (const [key, value] of Object.entries(content)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const [k, v] of Object.entries(value)) {
        lines.push(`  ${k}: ${JSON.stringify(v)}`);
      }
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  return lines.join("\n");
}

describe("design approve — computeDesignDiff integration", () => {
  it("uses computeDesignDiff when --from is provided", async () => {
    const projectDir = await createTempDir();

    // Create old profile
    const oldProfileYaml = `
schema_version: 1
kind: design
profile_id: test-profile-v1
created_at: "2026-01-01T00:00:00Z"
updated_at: "2026-01-01T00:00:00Z"
project:
  language: typescript
  source_roots:
    - "src/v1"
  ignore: []
`;
    const oldProfilePath = join(projectDir, "old-profile.yaml");
    await writeFile(oldProfilePath, oldProfileYaml, "utf8");

    // Create new profile (with new context added)
    const newProfileYaml = `
schema_version: 1
kind: design
profile_id: test-profile-v2
created_at: "2026-01-01T00:00:00Z"
updated_at: "2026-01-02T00:00:00Z"
project:
  language: typescript
  source_roots:
    - "src/v1"
    - "src/v2"
  ignore: []
ddd:
  bounded_context_strategy: explicit
  contexts:
    - id: billing
      decision_ref: q1
      name: Billing
      subdomain_type: core
      root: src/billing
      layers:
        domain: "**/domain/*.ts"
        infrastructure: "**/infra/*.ts"
`;
    const designDir = join(projectDir, "contract", "design");
    await mkdir(designDir, { recursive: true });
    await writeFile(join(designDir, "profile.yaml"), newProfileYaml, "utf8");

    let capturedOutput = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = function(chunk: string) {
      capturedOutput += chunk;
      return true;
    };

    await runDesignApprove({ from: "old-profile.yaml", reason: "Test approval" }, projectDir);

    process.stdout.write = originalWrite;

    // Read the approval file
    const approvalsDir = join(projectDir, "contract", "design", "approvals");
    const files = require("node:fs").readdirSync(approvalsDir);
    expect(files.length).toBe(1);

    const approval = JSON.parse(readFileSync(join(approvalsDir, files[0]), "utf8"));

    // diff_classification should be "additive" (source root added, context added — all additive)
    expect(approval.diff_classification).toBe("additive");

    // affected_source_scope should include affected paths from the diff
    expect(Array.isArray(approval.affected_source_scope)).toBe(true);

    // Output should mention classification
    expect(capturedOutput).toContain("Classification: additive");
  });

  it("classifies as additive for first approval when no old profile exists", async () => {
    const projectDir = await createTempDir();

    // Create profile only (no manifest, no previous approval)
    const profileYaml = `
schema_version: 1
kind: design
profile_id: first-profile
created_at: "2026-01-01T00:00:00Z"
updated_at: "2026-01-01T00:00:00Z"
project:
  language: typescript
  source_roots:
    - "src"
  ignore: []
`;
    const designDir = join(projectDir, "contract", "design");
    await mkdir(designDir, { recursive: true });
    await writeFile(join(designDir, "profile.yaml"), profileYaml, "utf8");

    let capturedOutput = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = function(chunk: string) {
      capturedOutput += chunk;
      return true;
    };

    await runDesignApprove({ reason: "First approval" }, projectDir);

    process.stdout.write = originalWrite;

    const approvalsDir = join(projectDir, "contract", "design", "approvals");
    const files = require("node:fs").readdirSync(approvalsDir);
    expect(files.length).toBe(1);

    const approval = JSON.parse(readFileSync(join(approvalsDir, files[0]), "utf8"));

    // First approval with no old profile should default to "additive"
    expect(approval.diff_classification).toBe("additive");
    expect(approval.affected_source_scope).toEqual([]);
  });

  it("detects weakening changes when profile removes contexts", async () => {
    const projectDir = await createTempDir();

    // Old profile with two contexts
    const oldProfileYaml = `
schema_version: 1
kind: design
profile_id: test-profile
created_at: "2026-01-01T00:00:00Z"
updated_at: "2026-01-01T00:00:00Z"
project:
  language: typescript
  source_roots:
    - "src"
  ignore: []
ddd:
  bounded_context_strategy: explicit
  contexts:
    - id: billing
      decision_ref: q1
      name: Billing
      subdomain_type: core
      root: src/billing
      layers:
        domain: "**/domain/*.ts"
    - id: shipping
      decision_ref: q2
      name: Shipping
      subdomain_type: supporting
      root: src/shipping
      layers:
        domain: "**/domain/*.ts"
`;
    const oldProfilePath = join(projectDir, "old-profile.yaml");
    await writeFile(oldProfilePath, oldProfileYaml, "utf8");

    // New profile with only one context (shipping removed = weakening)
    const newProfileYaml = `
schema_version: 1
kind: design
profile_id: test-profile
created_at: "2026-01-01T00:00:00Z"
updated_at: "2026-01-02T00:00:00Z"
project:
  language: typescript
  source_roots:
    - "src"
  ignore: []
ddd:
  bounded_context_strategy: explicit
  contexts:
    - id: billing
      decision_ref: q1
      name: Billing
      subdomain_type: core
      root: src/billing
      layers:
        domain: "**/domain/*.ts"
`;
    const designDir = join(projectDir, "contract", "design");
    await mkdir(designDir, { recursive: true });
    await writeFile(join(designDir, "profile.yaml"), newProfileYaml, "utf8");

    await runDesignApprove({ from: "old-profile.yaml", reason: "Remove shipping context" }, projectDir);

    const approvalsDir = join(projectDir, "contract", "design", "approvals");
    const files = require("node:fs").readdirSync(approvalsDir);
    const approval = JSON.parse(readFileSync(join(approvalsDir, files[0]), "utf8"));

    // Removing a context is weakening
    expect(approval.diff_classification).toBe("weakening");

    // affected_source_scope is populated from diff results
    // For removed contexts, the new profile doesn't have the root, so scope may be empty
    expect(Array.isArray(approval.affected_source_scope)).toBe(true);
  });

  it("requires --reason flag", async () => {
    const projectDir = await createTempDir();

    const designDir = join(projectDir, "contract", "design");
    await mkdir(designDir, { recursive: true });
    await writeFile(join(designDir, "profile.yaml"), "schema_version: 1\n", "utf8");

    let capturedError = "";
    const originalWrite = process.stderr.write;
    process.stderr.write = function(chunk: string) {
      capturedError += chunk;
      return true;
    };

    await runDesignApprove({}, projectDir);

    process.stderr.write = originalWrite;

    expect(capturedError).toContain("--reason is required");
    expect(process.exitCode).toBe(1);
  });

  it("requires profile to exist", async () => {
    const projectDir = await createTempDir();

    let capturedError = "";
    const originalWrite = process.stderr.write;
    process.stderr.write = function(chunk: string) {
      capturedError += chunk;
      return true;
    };

    await runDesignApprove({ reason: "test" }, projectDir);

    process.stderr.write = originalWrite;

    expect(capturedError).toContain("No profile found");
    expect(process.exitCode).toBe(1);
  });
});
