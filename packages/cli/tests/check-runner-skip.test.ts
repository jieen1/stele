import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Contract } from "@stele/core";
import { runAllStages } from "../src/commands/check-stages-registry.js";
import { buildProtectedStageReport } from "../src/commands/check-stages-protected.js";
import type { PreparedCheckContext, ProtectedCheckState } from "../src/architecture/types.js";

// ----------------------------------------------------------------
// P1-#1: runAllStages honors skipStages WITHOUT hiding non-skipped violations.
//
// Orchestration-layer teeth for the incremental skip path in
// check-stages-registry.ts (runAllStages: `if (skipStages?.has(stage.id)) continue`).
// A skip-set passed to the runner must drop ONLY the named stage's violations;
// every non-skipped stage's violation must still surface in the merged result.
// ----------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function createTempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stele-runner-skip-"));
  tempDirs.push(dir);
  return dir;
}

async function writeFileEnsuringDir(root: string, rel: string, content: string): Promise<void> {
  const abs = resolve(root, rel);
  await mkdir(resolve(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

// A class-shape declaration that demands a method the target class lacks =>
// the code-shape stage emits one rule violation (rule_id === declaration.id).
function mkClassShape(id: string, target: string, missingMethod: string): unknown {
  return {
    kind: "class-shape",
    filePath: "contract/test.stele",
    node: {} as unknown,
    span: { file: "contract/test.stele", line: 1, column: 1 },
    id,
    lang: "typescript",
    target,
    mustHaveFields: [],
    mustHaveMethods: [missingMethod],
    mustExtend: [],
    aggregateMembers: [],
  };
}

// A core-node with a sloc max of 1 on a multi-line class => the complexity
// stage emits one rule violation (rule_id === `complexity.<id>.sloc`).
function mkCoreNode(id: string, target: string): unknown {
  return {
    kind: "core-node",
    filePath: "contract/test.stele",
    node: {} as unknown,
    span: { file: "contract/test.stele", line: 1, column: 1 },
    id,
    lang: "typescript",
    role: "business-core-service",
    target,
    metrics: [{ name: "sloc", ideal: 1, max: 1 }],
  };
}

function mkContract(overrides: Record<string, unknown>): Contract {
  return {
    rootPath: "/tmp/fixture",
    files: [],
    metadata: [],
    imports: [],
    operators: [],
    checkers: [],
    scenarios: [],
    groups: [],
    invariants: [],
    codeShapes: [],
    architectures: [],
    coreNodes: [],
    brandedIds: [],
    smartCtors: [],
    tracePolicies: [],
    typeStates: [],
    effectPolicies: [],
    ...overrides,
  } as unknown as Contract;
}

function mkContext(projectDir: string, contract: Contract): PreparedCheckContext {
  return {
    projectDir,
    config: {
      targetLanguage: "typescript",
      entry: "contract/main.stele",
      manifestPath: "contract/.manifest.json",
    } as unknown as PreparedCheckContext["config"],
    contract,
    generated: { ok: true, files: [] } as unknown as PreparedCheckContext["generated"],
    invariantCount: 0,
  };
}

const PROTECTED_STATE: ProtectedCheckState = {
  protectedPaths: [],
  contractHash: "0".repeat(64),
  summary: { invariantCount: 0, generatedFileCount: 0, protectedFileCount: 0 },
};

describe("runAllStages — skipStages drops only the named stage, never the rest", () => {
  it("skipping code-shape keeps the complexity violation and removes the code-shape one", async () => {
    const projectDir = await createTempProject();
    // A real multi-line TS class targeted by BOTH a class-shape (code-shape
    // stage) and a core-node (complexity stage). Each declaration independently
    // produces exactly one violation against this file.
    await writeFileEnsuringDir(
      projectDir,
      "src/order.ts",
      ["export class Order {", "  total = 0;", "  add(x: number): void {", "    this.total += x;", "  }", "}", ""].join("\n"),
    );
    // A clean, empty manifest whose contract hash matches PROTECTED_STATE so the
    // protected stage produces no violations and does not pollute the assertion.
    await writeFileEnsuringDir(
      projectDir,
      "contract/.manifest.json",
      JSON.stringify(
        {
          version: "1",
          generated_at: "2026-01-01T00:00:00.000Z",
          stele_version: "0.1.0",
          contract_hash: "0".repeat(64),
          protected_files: {},
        },
        null,
        2,
      ) + "\n",
    );

    const contract = mkContract({
      codeShapes: [mkClassShape("cs1", "src/order.ts::Order", "settle")],
      coreNodes: [mkCoreNode("cn1", "src/order.ts::Order")],
    });
    const context = mkContext(projectDir, contract);

    // Sanity: with NO skip set, BOTH violations are present.
    const fullReports = await runAllStages(context, PROTECTED_STATE, "check", {}, {}, undefined);
    const fullIds = fullReports.flatMap((r) => r.violations.map((v) => v.rule_id as string));
    expect(fullIds).toContain("cs1");
    expect(fullIds.some((id) => id.startsWith("complexity.cn1."))).toBe(true);

    // Now skip ONLY code-shape. The complexity violation must survive; the
    // code-shape violation must be gone.
    const reports = await runAllStages(context, PROTECTED_STATE, "check", {}, {}, new Set(["code-shape"]));
    const ids = reports.flatMap((r) => r.violations.map((v) => v.rule_id as string));

    // Non-skipped stage's violation is STILL reported.
    expect(ids.some((id) => id.startsWith("complexity.cn1."))).toBe(true);
    // Skipped stage's violation is NOT reported.
    expect(ids).not.toContain("cs1");
  });
});

// ----------------------------------------------------------------
// P1-#3: contract-hash mismatch is reported when the contract is swapped
// under an otherwise-valid manifest. Targets buildProtectedStageReport /
// createContractHashMismatchViolation in check-stages-protected.ts. This is the
// "approve a contract, then quietly edit it" attack: the manifest still verifies
// every protected file, but its recorded contract_hash no longer matches the
// live contract. The protected stage MUST emit `contract_hash_mismatch`.
// ----------------------------------------------------------------

async function writeCleanManifest(projectDir: string, contractHash: string): Promise<void> {
  await writeFileEnsuringDir(
    projectDir,
    "contract/.manifest.json",
    JSON.stringify(
      {
        version: "1",
        generated_at: "2026-01-01T00:00:00.000Z",
        stele_version: "0.1.0",
        contract_hash: contractHash,
        protected_files: {},
      },
      null,
      2,
    ) + "\n",
  );
}

function mkProtectedContext(projectDir: string): PreparedCheckContext {
  return mkContext(projectDir, mkContract({}));
}

describe("buildProtectedStageReport — contract_hash_mismatch (swapped contract under a valid manifest)", () => {
  it("reports contract_hash_mismatch when manifest.contract_hash != protectedState.contractHash", async () => {
    const projectDir = await createTempProject();
    // Manifest recorded a contract hash of all-A; the live contract now hashes
    // to all-B. Every protected file still verifies (none here), so the ONLY
    // signal of the swap is the contract-hash comparison.
    const manifestHash = "a".repeat(64);
    const liveContractHash = "b".repeat(64);
    await writeCleanManifest(projectDir, manifestHash);

    const protectedState: ProtectedCheckState = {
      protectedPaths: [],
      contractHash: liveContractHash,
      summary: { invariantCount: 0, generatedFileCount: 0, protectedFileCount: 0 },
    };

    const report = await buildProtectedStageReport(mkProtectedContext(projectDir), protectedState, "check");

    expect(report.ok).toBe(false);
    const mismatch = report.violations.find((v) => v.rule_kind === "contract_hash_mismatch");
    expect(mismatch).toBeDefined();
    expect((mismatch!.cause as { expected_hash?: string; actual_hash?: string }).expected_hash).toBe(manifestHash);
    expect((mismatch!.cause as { expected_hash?: string; actual_hash?: string }).actual_hash).toBe(liveContractHash);
  });

  it("does NOT report contract_hash_mismatch when the hashes agree (no false positive)", async () => {
    const projectDir = await createTempProject();
    const hash = "c".repeat(64);
    await writeCleanManifest(projectDir, hash);

    const protectedState: ProtectedCheckState = {
      protectedPaths: [],
      contractHash: hash,
      summary: { invariantCount: 0, generatedFileCount: 0, protectedFileCount: 0 },
    };

    const report = await buildProtectedStageReport(mkProtectedContext(projectDir), protectedState, "check");

    expect(report.ok).toBe(true);
    expect(report.violations.some((v) => v.rule_kind === "contract_hash_mismatch")).toBe(false);
  });
});
