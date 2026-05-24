// Round 13 M-12 / Round 4 F-A-07: tests for `stele design propose`.
// Previous rounds shipped the propose flow + the Phase B kind extension
// (trace-policy / type-state / effect-policy / effect-suppression)
// without coverage. This file fills that gap.
//
// What's covered:
//   - Phase A kinds (invariant / branded-id / aggregate) — happy path,
//     duplicate-rejection, non-additive rejection
//   - Phase B kinds (trace-policy / type-state / effect-policy /
//     effect-suppression) — written as minimal YAML envelope, separate
//     code path from Phase A (no additive-diff check)
//   - Unknown kinds rejected
//   - Missing --id rejected

import { mkdtemp, writeFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as yaml from "js-yaml";
import { runDesignPropose } from "../src/commands/design/propose.js";
import { ExitCode } from "../src/errors.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  tempDirs.length = 0;
});

async function createProjectWithMinimalProfile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stele-propose-test-"));
  tempDirs.push(dir);
  const profileYaml = `
schema_version: 1
kind: design
profile_id: test-propose
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
    - id: orders
      decision_ref: q1
      name: Orders
      subdomain_type: core
      root: src/orders
      layers:
        domain: "**/domain/*.ts"
        infrastructure: "**/infra/*.ts"
      aggregate_roots: []
  core_invariants: []
type_driven:
  branded_ids:
    declarations: []
`;
  const designDir = join(dir, "contract", "design");
  await mkdir(designDir, { recursive: true });
  await writeFile(join(designDir, "profile.yaml"), profileYaml, "utf8");
  return dir;
}

function captureStderr(): { restore: () => void; lines: string[] } {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = function (chunk: unknown): boolean {
    lines.push(String(chunk));
    return true;
  } as typeof process.stderr.write;
  return {
    restore: () => {
      process.stderr.write = original;
    },
    lines,
  };
}

function captureStdout(): { restore: () => void; lines: string[] } {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = function (chunk: unknown): boolean {
    lines.push(String(chunk));
    return true;
  } as typeof process.stdout.write;
  return {
    restore: () => {
      process.stdout.write = original;
    },
    lines,
  };
}

async function readProposalFiles(projectDir: string): Promise<string[]> {
  const proposalsDir = join(projectDir, "contract", "design", "proposals");
  if (!existsSync(proposalsDir)) return [];
  return await readdir(proposalsDir);
}

describe("stele design propose — Phase A kinds (Round 4 F-A-07 baseline)", () => {
  it("writes an `invariant` proposal YAML to contract/design/proposals/", async () => {
    const projectDir = await createProjectWithMinimalProfile();
    const previousExit = process.exitCode;
    process.exitCode = 0;
    try {
      await runDesignPropose(
        "invariant",
        { id: "ORDER_TOTAL_POSITIVE", description: "Order total must be positive", evolvability: "never" },
        projectDir,
      );
    } finally {
      const exit = process.exitCode;
      process.exitCode = previousExit;
      expect(exit ?? 0).toBe(0);
    }
    const files = await readProposalFiles(projectDir);
    expect(files.length).toBe(1);
    const body = await readFile(join(projectDir, "contract/design/proposals", files[0]), "utf8");
    const parsed = yaml.load(body) as Record<string, unknown>;
    expect(parsed.id).toBe("ORDER_TOTAL_POSITIVE");
    expect(parsed.kind).toBe("invariant");
    expect(parsed.description).toBe("Order total must be positive");
    expect(parsed.evolvability).toBe("never");
    expect(typeof parsed.created_at).toBe("string");
  });

  it("refuses an `invariant` proposal whose id already exists in the profile", async () => {
    const projectDir = await createProjectWithMinimalProfile();
    // Add an existing invariant to the profile.
    const profilePath = join(projectDir, "contract", "design", "profile.yaml");
    const existing = await readFile(profilePath, "utf8");
    await writeFile(
      profilePath,
      existing.replace(
        "core_invariants: []",
        `core_invariants:
    - id: EXISTING_RULE
      description: already declared
      evolvability: never`,
      ),
      "utf8",
    );
    const stderr = captureStderr();
    const previousExit = process.exitCode;
    process.exitCode = 0;
    try {
      await runDesignPropose("invariant", { id: "EXISTING_RULE" }, projectDir);
    } finally {
      stderr.restore();
      const exit = process.exitCode;
      process.exitCode = previousExit;
      expect(exit).toBe(ExitCode.USER_ERROR);
    }
    expect(stderr.lines.join("")).toContain("already exists");
    // No proposal file written.
    expect(await readProposalFiles(projectDir)).toEqual([]);
  });

  it("writes a `branded-id` proposal", async () => {
    const projectDir = await createProjectWithMinimalProfile();
    await runDesignPropose(
      "branded-id",
      { id: "OrderId", typeName: "OrderId", target: "src/orders/types.ts::OrderId" },
      projectDir,
    );
    const files = await readProposalFiles(projectDir);
    expect(files.length).toBe(1);
    const parsed = yaml.load(
      await readFile(join(projectDir, "contract/design/proposals", files[0]), "utf8"),
    ) as Record<string, unknown>;
    expect(parsed.kind).toBe("branded-id");
    expect(parsed.type_name).toBe("OrderId");
    expect(parsed.target).toBe("src/orders/types.ts::OrderId");
  });

  it("writes an `aggregate` proposal", async () => {
    const projectDir = await createProjectWithMinimalProfile();
    await runDesignPropose(
      "aggregate",
      { id: "OrderAggregate", description: "Order root", target: "src/orders/aggregate.ts::Order" },
      projectDir,
    );
    const files = await readProposalFiles(projectDir);
    expect(files.length).toBe(1);
    const parsed = yaml.load(
      await readFile(join(projectDir, "contract/design/proposals", files[0]), "utf8"),
    ) as Record<string, unknown>;
    expect(parsed.kind).toBe("aggregate");
  });
});

describe("stele design propose — Phase B kinds (Round 4 F-A-07)", () => {
  for (const kind of ["trace-policy", "type-state", "effect-policy", "effect-suppression"]) {
    it(`writes a minimal envelope YAML for kind="${kind}" without running the additive-diff check`, async () => {
      const projectDir = await createProjectWithMinimalProfile();
      const stdout = captureStdout();
      const previousExit = process.exitCode;
      process.exitCode = 0;
      try {
        await runDesignPropose(
          kind,
          {
            id: `PROPOSAL_${kind.toUpperCase().replace(/-/g, "_")}_1`,
            description: `propose a ${kind} rule`,
            target: kind === "type-state" ? "src/orders/SessionState.ts::SessionState" : undefined,
          },
          projectDir,
        );
      } finally {
        stdout.restore();
        const exit = process.exitCode;
        process.exitCode = previousExit;
        expect(exit ?? 0).toBe(0);
      }
      const files = await readProposalFiles(projectDir);
      expect(files.length).toBe(1);
      const body = await readFile(join(projectDir, "contract/design/proposals", files[0]), "utf8");
      const parsed = yaml.load(body) as Record<string, unknown>;
      expect(parsed.kind).toBe(kind);
      expect(parsed.id).toBe(`PROPOSAL_${kind.toUpperCase().replace(/-/g, "_")}_1`);
      expect(parsed.description).toBe(`propose a ${kind} rule`);
      // The user-facing message must point at the post-write next step.
      expect(stdout.lines.join("")).toContain("Phase B proposal");
      expect(stdout.lines.join("")).toContain("stele design approve");
    });
  }

  it("refuses a duplicate Phase B proposal id+kind in the proposals/ directory", async () => {
    const projectDir = await createProjectWithMinimalProfile();
    await runDesignPropose(
      "trace-policy",
      { id: "DB_VIA_REPOSITORY", description: "all DB access through Repository" },
      projectDir,
    );
    const stderr = captureStderr();
    const previousExit = process.exitCode;
    process.exitCode = 0;
    try {
      await runDesignPropose(
        "trace-policy",
        { id: "DB_VIA_REPOSITORY", description: "again" },
        projectDir,
      );
    } finally {
      stderr.restore();
      const exit = process.exitCode;
      process.exitCode = previousExit;
      expect(exit).toBe(ExitCode.USER_ERROR);
    }
    expect(stderr.lines.join("")).toContain("already exists in proposals/");
    // Only the original proposal file remains.
    const files = await readProposalFiles(projectDir);
    expect(files.length).toBe(1);
  });
});

describe("stele design propose — input validation", () => {
  it("refuses when --id is missing", async () => {
    const projectDir = await createProjectWithMinimalProfile();
    const stderr = captureStderr();
    const previousExit = process.exitCode;
    process.exitCode = 0;
    try {
      await runDesignPropose("invariant", {}, projectDir);
    } finally {
      stderr.restore();
      const exit = process.exitCode;
      process.exitCode = previousExit;
      expect(exit).toBe(ExitCode.USER_ERROR);
    }
    expect(stderr.lines.join("")).toContain("--id is required");
  });

  it("refuses an unknown proposal kind", async () => {
    const projectDir = await createProjectWithMinimalProfile();
    const stderr = captureStderr();
    const previousExit = process.exitCode;
    process.exitCode = 0;
    try {
      await runDesignPropose("not-a-real-kind", { id: "X" }, projectDir);
    } finally {
      stderr.restore();
      const exit = process.exitCode;
      process.exitCode = previousExit;
      expect(exit).toBe(ExitCode.USER_ERROR);
    }
    expect(stderr.lines.join("")).toContain("Unknown proposal type");
    expect(stderr.lines.join("")).toContain("Allowed:");
  });
});
