import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { STELE_CONFIG_FILE, DEFAULT_CONFIG } from "../src/config/defaults.js";
import { hashFile } from "../src/design-profile/hash.js";
import type { DesignProfile } from "../src/design-profile/types.js";
import { runDesignGenerate } from "../src/commands/design/generate.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stele-design-gate-"));
  tempDirs.push(dir);
  return dir;
}

function writeConfig(projectDir: string): void {
  const configPath = join(projectDir, STELE_CONFIG_FILE);
  const config = JSON.stringify({ ...DEFAULT_CONFIG, entry: "contract/main.stele" }, null, 2) + "\n";
  writeFileSync(configPath, config, "utf8");
}

function writeProfile(projectDir: string): void {
  const profile: DesignProfile = {
    schema_version: 1,
    kind: "stele-design-profile",
    profile_id: "gate-test",
    created_at: "2026-05-23T00:00:00.000Z",
    updated_at: "2026-05-23T00:00:00.000Z",
    project: {
      language: "typescript",
      source_roots: ["src"],
      ignore: [],
      tsconfig: "tsconfig.json",
    },
    ddd: {
      bounded_context_strategy: "by_business_function",
      contexts: [
        {
          id: "billing",
          name: "Billing",
          subdomain_type: "core",
          root: "src/billing",
          layers: { domain: "src/billing/domain/**/*.ts" },
        },
      ],
    },
  };
  const path = join(projectDir, "contract/design/profile.yaml");
  mkdirSync(join(projectDir, "contract/design"), { recursive: true });
  writeFileSync(path, yaml.dump(profile), "utf8");
}

function writeMatchingApproval(projectDir: string): void {
  const profileHash = hashFile(join(projectDir, "contract/design/profile.yaml"));
  const approvalsDir = join(projectDir, "contract/design/approvals");
  mkdirSync(approvalsDir, { recursive: true });
  writeFileSync(
    join(approvalsDir, "2026-05-23T00-00-00-test.json"),
    JSON.stringify(
      {
        schema_version: 1,
        approved_profile_sha256: profileHash,
        reason: "test setup",
        approved_by: "test",
        approved_at: "2026-05-23T00:00:00.000Z",
      },
      null,
      2,
    ),
    "utf8",
  );
}

function captureStderr(): { lines: string[]; restore: () => void } {
  const original = process.stderr.write.bind(process.stderr);
  const lines: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  return {
    lines,
    restore: () => {
      process.stderr.write = original;
    },
  };
}

describe("runDesignGenerate — approval gate (Round 3 P0-4)", () => {
  // @tcb-negative design
  it("refuses to write when no matching approval record exists", async () => {
    const projectDir = await createTempDir();
    writeConfig(projectDir);
    writeProfile(projectDir);

    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    const stderr = captureStderr();
    try {
      await runDesignGenerate({}, projectDir);
    } finally {
      stderr.restore();
    }
    const captured = stderr.lines.join("");
    const exit = process.exitCode;
    process.exitCode = previousExitCode;

    // P-06: refusing without approval is a contract-gate failure
    // (ExitCode.CONTRACT_FAIL = 2), not a generic user error.
    expect(exit).toBe(2);
    expect(captured).toContain("No approval record matches");
    expect(captured).toContain("stele design approve");
    // The protected outputs must NOT have been written.
    expect(existsSync(join(projectDir, "contract/generated/ddd-typedriven.stele"))).toBe(false);
    expect(existsSync(join(projectDir, "contract/main.stele"))).toBe(false);
  });

  it("proceeds when an approval record matches the current profile hash", async () => {
    const projectDir = await createTempDir();
    writeConfig(projectDir);
    writeProfile(projectDir);
    writeMatchingApproval(projectDir);

    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await runDesignGenerate({}, projectDir);
    } finally {
      process.stdout.write = originalStdoutWrite;
    }

    expect(existsSync(join(projectDir, "contract/generated/ddd-typedriven.stele"))).toBe(true);
    const main = readFileSync(join(projectDir, "contract/main.stele"), "utf8");
    expect(main).toContain('(import "generated/ddd-typedriven.stele")');
  });

  it("requires --reason when --force is passed", async () => {
    const projectDir = await createTempDir();
    writeConfig(projectDir);
    writeProfile(projectDir);

    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    const stderr = captureStderr();
    try {
      await runDesignGenerate({ force: true }, projectDir);
    } finally {
      stderr.restore();
    }
    const captured = stderr.lines.join("");
    const exit = process.exitCode;
    process.exitCode = previousExitCode;

    expect(exit).toBe(1);
    expect(captured).toContain("--force requires --reason");
    expect(existsSync(join(projectDir, "contract/generated/ddd-typedriven.stele"))).toBe(false);
  });

  it("writes (with loud warning) when --force --reason is supplied even without approval", async () => {
    const projectDir = await createTempDir();
    writeConfig(projectDir);
    writeProfile(projectDir);

    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    const stderr = captureStderr();
    try {
      await runDesignGenerate(
        { force: true, reason: "override for unit test" },
        projectDir,
      );
    } finally {
      stderr.restore();
      process.stdout.write = originalStdoutWrite;
    }
    const captured = stderr.lines.join("");

    expect(captured).toContain("WARNING: --force bypassing approval gate");
    expect(captured).toContain("override for unit test");
    expect(existsSync(join(projectDir, "contract/generated/ddd-typedriven.stele"))).toBe(true);
  });
});
