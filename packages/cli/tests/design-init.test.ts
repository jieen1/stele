import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as yaml from "js-yaml";
import { runDesignInit } from "../src/commands/design/init.js";
import { loadProfile, profilePathExists } from "../src/design-profile/load.js";
import { validateProfile } from "../src/design-profile/validate.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

beforeEach(() => {
  process.exitCode = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  await Promise.allSettled(
    tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stele-design-init-"));
  tempDirs.push(dir);
  return dir;
}

function captureStdout(): { read: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  return { read: () => chunks.join("") };
}

function captureStderr(): { read: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  return { read: () => chunks.join("") };
}

// ---------------------------------------------------------------------------
// --preset ddd-typedriven (basic)
// ---------------------------------------------------------------------------

describe("design init --preset ddd-typedriven", () => {
  it("creates profile.yaml with all required sections", async () => {
    const dir = await createTempDir();

    await runDesignInit({ preset: "ddd-typedriven" }, dir);

    expect(profilePathExists(dir)).toBe(true);
    const profile = loadProfile(dir);

    expect(profile.schema_version).toBe(1);
    expect(profile.kind).toBe("stele-design-profile");
    expect(profile.profile_id).toBe("ddd-typedriven");
    expect(profile.created_at).toBeDefined();
    expect(profile.updated_at).toBeDefined();

    expect(profile.project).toBeDefined();
    expect(profile.project!.language).toBe("typescript");
    expect(profile.project!.source_roots).toEqual(["src"]);
    expect(profile.project!.ignore).toEqual([]);
    expect(profile.project!.tsconfig).toBe("tsconfig.json");

    expect(profile.ddd).toBeDefined();
    expect(profile.ddd!.bounded_context_strategy).toBe("by_business_function");
    expect(profile.ddd!.contexts).toEqual([]);
    expect(profile.ddd!.shared_kernels).toEqual([]);
    expect(profile.ddd!.integrations).toEqual([]);

    expect(profile.type_driven).toBeDefined();
    expect(profile.type_driven!.enabled).toBe(false);
    expect(profile.type_driven!.branded_ids!.mode).toBe("core_ids_only");
    expect(profile.type_driven!.branded_ids!.declarations).toEqual([]);
    expect(profile.type_driven!.smart_constructors!.mode).toBe("all_value_objects");
    expect(profile.type_driven!.smart_constructors!.value_objects).toEqual([]);

    expect(profile.toolchain_contracts).toBeDefined();
    expect(profile.toolchain_contracts!.typescript_config).toBeDefined();
  });

  it("creates a profile that passes validateProfile with zero errors", async () => {
    const dir = await createTempDir();

    await runDesignInit({ preset: "ddd-typedriven" }, dir);

    const profile = loadProfile(dir);
    expect(validateProfile(profile)).toEqual([]);
  });

  it("creates contract/design directory structure", async () => {
    const dir = await createTempDir();

    await runDesignInit({ preset: "ddd-typedriven" }, dir);

    const profile = loadProfile(dir);
    expect(profile.schema_version).toBe(1);
  });

  it("sets created_at and updated_at to ISO timestamps", async () => {
    const dir = await createTempDir();

    await runDesignInit({ preset: "ddd-typedriven" }, dir);

    const profile = loadProfile(dir);
    expect(new Date(profile.created_at!).toISOString()).toBe(profile.created_at);
    expect(new Date(profile.updated_at!).toISOString()).toBe(profile.updated_at);
  });
});

// ---------------------------------------------------------------------------
// --dry-run
// ---------------------------------------------------------------------------

describe("design init --dry-run", () => {
  it("prints YAML output without writing to disk", async () => {
    const dir = await createTempDir();
    const stdout = captureStdout();

    await runDesignInit({ preset: "ddd-typedriven", dryRun: true }, dir);

    const output = stdout.read();
    expect(output).toContain("schema_version");
    expect(output).toContain("ddd-typedriven");
    expect(output).toContain("by_business_function");
    expect(output).toContain("Dry-run");

    // File should NOT exist
    expect(profilePathExists(dir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// --answers
// ---------------------------------------------------------------------------

describe("design init --answers", () => {
  it("merges source_roots from answers file", async () => {
    const dir = await createTempDir();
    const answersPath = join(dir, "answers.yaml");
    await writeFile(
      answersPath,
      yaml.dump({ source_roots: ["src/app", "src/lib"] }),
      "utf8",
    );

    await runDesignInit({ preset: "ddd-typedriven", answers: "answers.yaml" }, dir);

    const profile = loadProfile(dir);
    expect(profile.project!.source_roots).toEqual(["src/app", "src/lib"]);
  });

  it("merges contexts from answers file", async () => {
    const dir = await createTempDir();
    const answersPath = join(dir, "answers.yaml");
    await writeFile(
      answersPath,
      yaml.dump({
        contexts: [
          { id: "billing", name: "Billing", subdomain_type: "core", root: "src/billing" },
          { id: "customer", name: "Customer", subdomain_type: "supporting", root: "src/customer" },
        ],
      }),
      "utf8",
    );

    await runDesignInit({ preset: "ddd-typedriven", answers: "answers.yaml" }, dir);

    const profile = loadProfile(dir);
    expect(profile.ddd!.contexts!.length).toBe(2);
    expect(profile.ddd!.contexts![0].id).toBe("billing");
    expect(profile.ddd!.contexts![0].subdomain_type).toBe("core");
    expect(profile.ddd!.contexts![1].id).toBe("customer");
    expect(profile.ddd!.contexts![1].subdomain_type).toBe("supporting");
  });

  it("merges integrations from answers file", async () => {
    const dir = await createTempDir();
    const answersPath = join(dir, "answers.yaml");
    await writeFile(
      answersPath,
      yaml.dump({
        contexts: [
          { id: "billing", name: "Billing", subdomain_type: "core", root: "src/billing" },
          { id: "customer", name: "Customer", subdomain_type: "supporting", root: "src/customer" },
        ],
        integrations: [
          { from: "billing", to: "customer", pattern: "anti_corruption_layer" },
        ],
      }),
      "utf8",
    );

    await runDesignInit({ preset: "ddd-typedriven", answers: "answers.yaml" }, dir);

    const profile = loadProfile(dir);
    expect(profile.ddd!.integrations!.length).toBe(1);
    expect(profile.ddd!.integrations![0].from).toBe("billing");
    expect(profile.ddd!.integrations![0].to).toBe("customer");
  });

  it("merges branded_ids from answers file", async () => {
    const dir = await createTempDir();
    const answersPath = join(dir, "answers.yaml");
    await writeFile(
      answersPath,
      yaml.dump({
        branded_ids: [
          { id: "invoice-id", type_name: "InvoiceId", type_target: "src/billing/domain/InvoiceId.ts::InvoiceId" },
        ],
      }),
      "utf8",
    );

    await runDesignInit({ preset: "ddd-typedriven", answers: "answers.yaml" }, dir);

    const profile = loadProfile(dir);
    expect(profile.type_driven!.enabled).toBe(true);
    expect(profile.type_driven!.branded_ids!.declarations!.length).toBe(1);
    expect(profile.type_driven!.branded_ids!.declarations![0].type_name).toBe("InvoiceId");
  });

  it("merges aggregate_roots from answers file", async () => {
    const dir = await createTempDir();
    const answersPath = join(dir, "answers.yaml");
    await writeFile(
      answersPath,
      yaml.dump({
        contexts: [
          { id: "billing", name: "Billing", subdomain_type: "core", root: "src/billing" },
        ],
        aggregate_roots: {
          billing: [
            { id: "invoice", class: "Invoice", target: "src/billing/domain/Invoice.ts::Invoice" },
          ],
        },
      }),
      "utf8",
    );

    await runDesignInit({ preset: "ddd-typedriven", answers: "answers.yaml" }, dir);

    const profile = loadProfile(dir);
    const ctx = profile.ddd!.contexts![0];
    expect(ctx.aggregate_roots!.length).toBe(1);
    expect(ctx.aggregate_roots![0].id).toBe("invoice");
    expect(ctx.aggregate_roots![0].class).toBe("Invoice");
  });

  it("merged profile still passes validation", async () => {
    const dir = await createTempDir();
    const answersPath = join(dir, "answers.yaml");
    await writeFile(
      answersPath,
      yaml.dump({
        source_roots: ["src/app"],
        contexts: [
          { id: "billing", name: "Billing", subdomain_type: "core", root: "src/billing" },
          { id: "customer", name: "Customer", subdomain_type: "supporting", root: "src/customer" },
        ],
        integrations: [
          { from: "billing", to: "customer", pattern: "anti_corruption_layer" },
        ],
        branded_ids: [
          { id: "invoice-id", type_name: "InvoiceId", type_target: "src/billing/InvoiceId.ts::InvoiceId" },
        ],
      }),
      "utf8",
    );

    await runDesignInit({ preset: "ddd-typedriven", answers: "answers.yaml" }, dir);

    const profile = loadProfile(dir);
    expect(validateProfile(profile)).toEqual([]);
  });

  it("fails when answers file does not exist", async () => {
    const dir = await createTempDir();
    const stderr = captureStderr();

    await runDesignInit({ preset: "ddd-typedriven", answers: "nonexistent.yaml" }, dir);

    const err = stderr.read();
    expect(err).toContain("not found");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

// ---------------------------------------------------------------------------
// --replace
// ---------------------------------------------------------------------------

describe("design init --replace", () => {
  it("refuses to overwrite existing profile without --replace", async () => {
    const dir = await createTempDir();
    await runDesignInit({ preset: "ddd-typedriven" }, dir);
    const stderr = captureStderr();

    await runDesignInit({ preset: "ddd-typedriven" }, dir);

    const err = stderr.read();
    expect(err).toContain("--replace");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("overwrites existing profile with --replace", async () => {
    const dir = await createTempDir();
    await runDesignInit({ preset: "ddd-typedriven" }, dir);

    const stdout = captureStdout();
    await runDesignInit({ preset: "ddd-typedriven", replace: true }, dir);

    const output = stdout.read();
    expect(output).toContain("WARNING");
    expect(output).toContain("Review guidance");
    expect(output).toContain("stele design check");

    const profile = loadProfile(dir);
    expect(validateProfile(profile)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// --preset validation
// ---------------------------------------------------------------------------

describe("design init --preset validation", () => {
  it("requires --preset flag", async () => {
    const dir = await createTempDir();
    const stderr = captureStderr();

    await runDesignInit({}, dir);

    const err = stderr.read();
    expect(err).toContain("--preset is required");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("rejects unsupported preset", async () => {
    const dir = await createTempDir();
    const stderr = captureStderr();

    await runDesignInit({ preset: "unknown-preset" }, dir);

    const err = stderr.read();
    expect(err).toContain("Unsupported preset");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

// ---------------------------------------------------------------------------
// --generate flag
// ---------------------------------------------------------------------------

describe("design init --generate", () => {
  it("runs design generate after init when --generate is set + STELE_APPROVED_BY env is set (Round 4 D-03)", async () => {
    const dir = await createTempDir();
    const stdout = captureStdout();

    const previousApprover = process.env.STELE_APPROVED_BY;
    process.env.STELE_APPROVED_BY = "test:fixture@round-5";
    try {
      await runDesignInit({ preset: "ddd-typedriven", generate: true }, dir);
    } finally {
      if (previousApprover === undefined) {
        delete process.env.STELE_APPROVED_BY;
      } else {
        process.env.STELE_APPROVED_BY = previousApprover;
      }
    }

    const output = stdout.read();
    expect(output).toContain("Created");
    expect(output).toContain("Generated");
  });

  it("refuses --generate when there's no TTY and no STELE_APPROVED_BY (Round 4 D-03)", async () => {
    const dir = await createTempDir();
    const previousExit = process.exitCode;
    process.exitCode = 0;
    const previousApprover = process.env.STELE_APPROVED_BY;
    delete process.env.STELE_APPROVED_BY;
    const stderr = (() => {
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
    })();
    captureStdout();
    try {
      await runDesignInit({ preset: "ddd-typedriven", generate: true }, dir);
    } finally {
      stderr.restore();
      if (previousApprover !== undefined) {
        process.env.STELE_APPROVED_BY = previousApprover;
      }
    }

    const captured = stderr.lines.join("");
    const exit = process.exitCode;
    process.exitCode = previousExit;
    expect(exit).toBe(1);
    expect(captured).toContain("STELE_APPROVED_BY");
  });
});

// ---------------------------------------------------------------------------
// Combined flags
// ---------------------------------------------------------------------------

describe("design init combined flags", () => {
  it("supports --dry-run with --generate", async () => {
    const dir = await createTempDir();
    const stdout = captureStdout();

    await runDesignInit({ preset: "ddd-typedriven", dryRun: true, generate: true }, dir);

    const output = stdout.read();
    expect(output).toContain("Dry-run");
    expect(profilePathExists(dir)).toBe(false);
  });

  it("supports --answers with --dry-run", async () => {
    const dir = await createTempDir();
    const answersPath = join(dir, "answers.yaml");
    await writeFile(
      answersPath,
      yaml.dump({ source_roots: ["src/ui", "src/domain"] }),
      "utf8",
    );
    const stdout = captureStdout();

    await runDesignInit(
      { preset: "ddd-typedriven", dryRun: true, answers: "answers.yaml" },
      dir,
    );

    const output = stdout.read();
    expect(output).toContain("Dry-run");
    expect(output).toContain("src/ui");
    expect(output).toContain("src/domain");

    expect(profilePathExists(dir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// YAML round-trip
// ---------------------------------------------------------------------------

describe("design init YAML round-trip", () => {
  it("writes valid YAML that can be reloaded", async () => {
    const dir = await createTempDir();

    await runDesignInit({ preset: "ddd-typedriven" }, dir);

    const profile = loadProfile(dir);
    expect(profile.schema_version).toBe(1);
    expect(profile.kind).toBe("stele-design-profile");
    expect(profile.profile_id).toBe("ddd-typedriven");
  });

  it("YAML output is deterministic (excluding timestamps)", async () => {
    const dir1 = await createTempDir();
    const dir2 = await createTempDir();

    await runDesignInit({ preset: "ddd-typedriven" }, dir1);
    await runDesignInit({ preset: "ddd-typedriven" }, dir2);

    const p1 = loadProfile(dir1);
    const p2 = loadProfile(dir2);

    // Normalize timestamps for comparison
    const n1 = { ...p1, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };
    const n2 = { ...p2, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };

    expect(n1).toEqual(n2);
  });
});
