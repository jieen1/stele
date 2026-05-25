import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildFailureWitness,
  createViolation,
  createViolationReport,
  type Violation,
  type ViolationReport,
} from "@stele/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWhy } from "../src/commands/why.js";
import { writeLastReport } from "../src/last-report.js";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE } from "../src/config/defaults.js";

const tempDirs: string[] = [];

describe("stele why with failure witness", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("renders failure witness fields in human output when last report contains one", async () => {
    const projectDir = await createWitnessFixtureProject();
    await persistFailingReportWithWitness(projectDir, { ruleId: "balance-non-negative" });
    const stdout = captureStdout();

    await runWhy(projectDir, "balance-non-negative", {});

    const output = stdout.read();
    expect(output).toContain("Rule: balance-non-negative");
    expect(output).toContain("Last check:");
    expect(output).toContain("(failed)");
    expect(output).toContain("Failure witness:");
    expect(output).toContain("operator: forall");
    expect(output).toContain("collection_size: 47");
    expect(output).toContain("failed at index: 3");
    expect(output).toContain("\"id\": \"acc-789\"");
    expect(output).toContain("predicate: (gt (path balance) 0)");
  });

  it("falls back to summary/detail when failure_witness is absent", async () => {
    const projectDir = await createWitnessFixtureProject();
    await persistFailingReportWithoutWitness(projectDir, { ruleId: "balance-non-negative" });
    const stdout = captureStdout();

    await runWhy(projectDir, "balance-non-negative", {});

    const output = stdout.read();
    expect(output).toContain("Cause: balance dropped below zero");
    expect(output).toContain("Detail: account acc-789 had a negative balance after charge");
    expect(output).not.toContain("Failure witness:");
  });

  it("emits cli-output §4.2 schema in --json mode with embedded witness", async () => {
    const projectDir = await createWitnessFixtureProject();
    const generatedAt = await persistFailingReportWithWitness(projectDir, { ruleId: "balance-non-negative" });
    const stdout = captureStdout();

    await runWhy(projectDir, "balance-non-negative", { json: true });

    const parsed = JSON.parse(stdout.read());
    expect(parsed.schema_version).toBe("1");
    expect(parsed.tool).toBe("@stele/cli");
    expect(parsed.command).toBe("why");
    expect(parsed.rule_id).toBe("balance-non-negative");
    expect(parsed.severity).toBe("high");
    expect(parsed.last_check_at).toBe(generatedAt);
    expect(parsed.last_check_status).toBe("failed");
    expect(parsed.violation).toBeDefined();
    expect(parsed.violation.rule_id).toBe("balance-non-negative");
    expect(parsed.violation.cause.failure_witness).toMatchObject({
      operator: "forall",
      collection_size: 47,
      failed_at_index: 3,
      predicate_source: "(gt (path balance) 0)",
    });
    // Must use rule_id, not invariant_id, and last_check_at, not timestamp.
    expect(parsed).not.toHaveProperty("invariant_id");
    expect(parsed).not.toHaveProperty("timestamp");
  });

  it("reports last_check_status=no-report when no persisted report exists", async () => {
    const projectDir = await createWitnessFixtureProject();
    const stdout = captureStdout();

    await runWhy(projectDir, "balance-non-negative", { json: true });

    const parsed = JSON.parse(stdout.read());
    expect(parsed.last_check_status).toBe("no-report");
    expect(parsed.violation).toBeUndefined();
    expect(parsed.last_check_at).toBeUndefined();
  });

  it("shows graceful no-report message in human mode when no persisted report exists", async () => {
    const projectDir = await createWitnessFixtureProject();
    const stdout = captureStdout();

    await runWhy(projectDir, "balance-non-negative", {});

    const output = stdout.read();
    expect(output).toContain("Last check: no recent report");
    expect(output).toContain("stele check");
    expect(output).not.toContain("Failure witness:");
  });

  it("surfaces witness for baseline-suppressed violations with status=suppressed", async () => {
    const projectDir = await createWitnessFixtureProject();
    const generatedAt = await persistSuppressedReportWithWitness(projectDir, { ruleId: "balance-non-negative" });
    const humanStdout = captureStdout();

    await runWhy(projectDir, "balance-non-negative", {});
    const humanOutput = humanStdout.read();
    expect(humanOutput).toContain("(suppressed)");
    expect(humanOutput).toContain("Failure witness:");
    expect(humanOutput).toContain("operator: forall");

    vi.restoreAllMocks();
    const jsonStdout = captureStdout();
    await runWhy(projectDir, "balance-non-negative", { json: true });
    const parsed = JSON.parse(jsonStdout.read());
    expect(parsed.last_check_at).toBe(generatedAt);
    expect(parsed.last_check_status).toBe("suppressed");
    expect(parsed.violation.status).toBe("suppressed");
    expect(parsed.violation.cause.failure_witness.operator).toBe("forall");
  });

  it("matches by fingerprint when an unknown id is provided", async () => {
    const projectDir = await createWitnessFixtureProject();
    const violation = createViolation({
      rule_id: "balance-non-negative",
      rule_kind: "rule_violation",
      severity: "error",
      source: { tool: "stele", command: "check", kind: "rule" },
      location: { path: "ledger/account.py" },
      cause: {
        summary: "forall failed",
        failure_witness: buildFailureWitness("forall", 47, 3, { id: "acc-789" }, "(gt (path balance) 0)"),
      },
      scope_paths: ["ledger/account.py"],
    });
    const report = createViolationReport({
      tool: "stele",
      command: "check",
      ok: false,
      summary: { violation_count: 1, active_violation_count: 1 },
      violations: [violation],
    });
    await writeLastReport(projectDir, report);
    const stdout = captureStdout();

    await runWhy(projectDir, violation.fingerprint, { json: true });

    const parsed = JSON.parse(stdout.read());
    expect(parsed.command).toBe("why");
    expect(parsed.violation.fingerprint).toBe(violation.fingerprint);
    expect(parsed.violation.cause.failure_witness.operator).toBe("forall");
  });
});

async function createWitnessFixtureProject(): Promise<string> {
  const projectDir = await createTempDir();

  await writeProjectFile(projectDir, STELE_CONFIG_FILE, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  await writeProjectFile(
    projectDir,
    "contract/main.stele",
    [
      "(invariant balance-non-negative",
      "  (severity high)",
      '  (description "Account balance must be non-negative.")',
      '  (rationale "Banking regulation forbids negative balances.")',
      "  (assert (forall account (collection accounts) (gt (path account balance) 0))))",
    ].join("\n") + "\n",
  );

  return projectDir;
}

async function persistFailingReportWithWitness(
  projectDir: string,
  options: { ruleId: string },
): Promise<string> {
  const witness = buildFailureWitness(
    "forall",
    47,
    3,
    { id: "acc-789", balance: -50, currency: "USD" },
    "(gt (path balance) 0)",
  );
  const violation = createViolation({
    rule_id: options.ruleId,
    rule_kind: "rule_violation",
    severity: "error",
    source: { tool: "stele", command: "check", kind: "rule" },
    location: { path: "ledger/account.py", line: 12 },
    cause: {
      summary: "forall failed at index 3 of 47",
      detail: "(forall accounts (gt (path balance) 0)) evaluated to false on accounts[3]",
      failure_witness: witness,
    },
    scope_paths: ["ledger/account.py"],
  });

  return await persistReport(projectDir, [violation]);
}

async function persistFailingReportWithoutWitness(
  projectDir: string,
  options: { ruleId: string },
): Promise<string> {
  const violation = createViolation({
    rule_id: options.ruleId,
    rule_kind: "rule_violation",
    severity: "error",
    source: { tool: "stele", command: "check", kind: "rule" },
    location: { path: "ledger/account.py", line: 12 },
    cause: {
      summary: "balance dropped below zero",
      detail: "account acc-789 had a negative balance after charge",
    },
    scope_paths: ["ledger/account.py"],
  });

  return await persistReport(projectDir, [violation]);
}

async function persistSuppressedReportWithWitness(
  projectDir: string,
  options: { ruleId: string },
): Promise<string> {
  const witness = buildFailureWitness(
    "forall",
    47,
    3,
    { id: "acc-789", balance: -50, currency: "USD" },
    "(gt (path balance) 0)",
  );
  const violation: Violation = createViolation({
    rule_id: options.ruleId,
    rule_kind: "rule_violation",
    severity: "error",
    source: { tool: "stele", command: "check", kind: "rule" },
    location: { path: "ledger/account.py", line: 12 },
    cause: {
      summary: "forall failed at index 3 of 47",
      failure_witness: witness,
    },
    scope_paths: ["ledger/account.py"],
    status: "suppressed",
    suppressed_by: "baseline",
  });

  return await persistReport(projectDir, [violation], { ok: true, activeCount: 0, suppressedCount: 1 });
}

async function persistReport(
  projectDir: string,
  violations: Violation[],
  options: { ok?: boolean; activeCount?: number; suppressedCount?: number } = {},
): Promise<string> {
  const ok = options.ok ?? false;
  const activeCount = options.activeCount ?? violations.filter((v) => (v.status ?? "active") === "active").length;
  const suppressedCount = options.suppressedCount ?? violations.filter((v) => v.status === "suppressed").length;
  const report: ViolationReport = createViolationReport({
    tool: "stele",
    command: "check",
    ok,
    summary: {
      violation_count: violations.length,
      active_violation_count: activeCount,
      suppressed_violation_count: suppressedCount,
    },
    violations,
  });

  await writeLastReport(projectDir, report);
  // Return the persisted generated_at so tests can assert exact equality.
  const persistedRaw = await import("node:fs/promises").then(async (fs) =>
    fs.readFile(join(projectDir, "contract", ".last-check-report.json"), "utf8"),
  );
  return JSON.parse(persistedRaw).generated_at as string;
}

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "stele-cli-why-"));
  tempDirs.push(directory);
  return directory;
}

async function writeProjectFile(projectDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = join(projectDir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

function captureStdout(): { read(): string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write);
  return {
    read: () => chunks.join(""),
  };
}
