import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAddChecker } from "../src/commands/addChecker.js";
import { runAgentContext } from "../src/commands/agentContext.js";
import { runExplain } from "../src/commands/explain.js";
import { runList } from "../src/commands/list.js";
import { runMaintenanceSummary } from "../src/commands/maintenance.js";
import { runPropose } from "../src/commands/propose.js";
import { runRules } from "../src/commands/rules.js";
import { runWhy } from "../src/commands/why.js";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE } from "../src/config/defaults.js";
import { createProgram, runCli } from "../src/index.js";

const tempDirs: string[] = [];
const CHECKER_STUB = `def check(inputs: dict) -> dict:
    return {
        "passed": False,
        "message": "Checker implementation has not been approved yet.",
        "context": inputs,
    }
`;
const CHECKER_BLOCK = `(checker fresh_checker
  (description "TODO: describe what this checker validates."))
`;
const HYPHENATED_CHECKER_BLOCK = `(checker fresh-checker
  (description "TODO: describe what this checker validates."))
`;

describe("inspection commands", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("list prints stable columns and includes top-level plus group invariants from the real contract", async () => {
    const projectDir = await createInspectionFixtureProject();

    const stdout = captureStdout();
    await runList(projectDir, {});

    expect(stdout.read()).toBe(
      [
        "ID\tSeverity\tCategory\tDescription\tFile Path",
        "PAYMENT_BASELINE\thigh\t<none>\tBaseline rule used as a dependency target.\tcontract/main.stele",
        'ROOT_PAYMENT_BALANCE\tcritical\tdata-integrity\tPayments remain balanced before settlement.\tcontract/main.stele',
        'COMMENT_RULE\thigh\t<none>\tComment rule with ) and ; inside the string.\tcontract/main.stele',
        'TSV_RULE\thigh\t<none>\tTabbed\\\\path\\tline\\nnext\\rreturn\tcontract/main.stele',
        'GROUP_CHECKED_SETTLEMENT\tmedium\t(domain ledger)\tSettlement batches require an approved checker.\tcontract/main.stele',
      ].join("\n") + "\n",
    );
  });

  it("list escapes user-controlled cells so each row remains stable TSV", async () => {
    const projectDir = await createInspectionFixtureProject();
    const stdout = captureStdout();

    await runList(projectDir, { severity: "high" });

    const output = stdout.read().trimEnd().split("\n");
    const tsvRow = output.find((line) => line.startsWith("TSV_RULE\t"));

    expect(tsvRow).toBeDefined();
    expect(tsvRow!.split("\t")).toHaveLength(5);
    expect(tsvRow).toContain("Tabbed\\\\path\\tline\\nnext\\rreturn");
  });

  it("list applies severity, category, and tag filters against parsed field values", async () => {
    const projectDir = await createInspectionFixtureProject();

    await expectListOutput(projectDir, { severity: "critical" }, [
      "ID\tSeverity\tCategory\tDescription\tFile Path",
      'ROOT_PAYMENT_BALANCE\tcritical\tdata-integrity\tPayments remain balanced before settlement.\tcontract/main.stele',
    ]);
    await expectListOutput(projectDir, { category: "data-integrity" }, [
      "ID\tSeverity\tCategory\tDescription\tFile Path",
      'ROOT_PAYMENT_BALANCE\tcritical\tdata-integrity\tPayments remain balanced before settlement.\tcontract/main.stele',
    ]);
    await expectListOutput(projectDir, { tag: "payment" }, [
      "ID\tSeverity\tCategory\tDescription\tFile Path",
      'ROOT_PAYMENT_BALANCE\tcritical\tdata-integrity\tPayments remain balanced before settlement.\tcontract/main.stele',
      'GROUP_CHECKED_SETTLEMENT\tmedium\t(domain ledger)\tSettlement batches require an approved checker.\tcontract/main.stele',
    ]);
    await expectListOutput(projectDir, { tag: ":priority" }, [
      "ID\tSeverity\tCategory\tDescription\tFile Path",
      'ROOT_PAYMENT_BALANCE\tcritical\tdata-integrity\tPayments remain balanced before settlement.\tcontract/main.stele',
    ]);
    await expectListOutput(projectDir, { tag: "(scope nightly)" }, [
      "ID\tSeverity\tCategory\tDescription\tFile Path",
      'GROUP_CHECKED_SETTLEMENT\tmedium\t(domain ledger)\tSettlement batches require an approved checker.\tcontract/main.stele',
    ]);
  });

  it("list combines filters and keeps a stable header when nothing matches", async () => {
    const projectDir = await createInspectionFixtureProject();

    await expectListOutput(projectDir, { severity: "medium", category: "(domain ledger)", tag: "(scope nightly)" }, [
      "ID\tSeverity\tCategory\tDescription\tFile Path",
      'GROUP_CHECKED_SETTLEMENT\tmedium\t(domain ledger)\tSettlement batches require an approved checker.\tcontract/main.stele',
    ]);
    await expectListOutput(projectDir, { severity: "low", category: "missing", tag: "missing" }, [
      "ID\tSeverity\tCategory\tDescription\tFile Path",
    ]);
  });

  it("explain prints the full top-level invariant source, generated path, dependencies, rationale, and checker placeholder", async () => {
    const projectDir = await createInspectionFixtureProject();
    const stdout = captureStdout();

    await runExplain(projectDir, "ROOT_PAYMENT_BALANCE");

    expect(stdout.read()).toContain("ID: ROOT_PAYMENT_BALANCE\n");
    expect(stdout.read()).toContain("Generated Test Path: tests/contract/test_contract.py\n");
    expect(stdout.read()).toContain("Dependencies: PAYMENT_BASELINE\n");
    expect(stdout.read()).toContain('Rationale: "Preserve the accounting invariant before settlement."\n');
    expect(stdout.read()).toContain("Checker ID: <none>\n");
    expect(stdout.read()).toContain(
      [
        "Source:",
        "(invariant ROOT_PAYMENT_BALANCE",
        "  (severity critical)",
        '  (description "Payments remain balanced before settlement.")',
        "  (category data-integrity)",
        '  (tags payment :priority "batch window")',
        '  (rationale "Preserve the accounting invariant before settlement.")',
        "  (depends-on PAYMENT_BASELINE)",
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );
  });

  it("rules --json emits a machine-readable contract inventory for agents", async () => {
    const projectDir = await createInspectionFixtureProject();
    const stdout = captureStdout();

    await runRules(projectDir, { json: true });

    const index = JSON.parse(stdout.read()) as {
      schema_version: string;
      summary: {
        invariant_count: number;
        checker_count: number;
        scenario_count: number;
        code_shape_count: number;
      };
      protected: string[];
      rules: Array<{
        id: string;
        kind: string;
        severity?: string;
        category?: string;
        tags?: string[];
        file_path: string;
        line: number;
        generated_test_path?: string;
        dependencies?: string[];
        checker_id?: string | null;
        scenario_id?: string | null;
      }>;
      scenarios: Array<{ id: string; executor: string; sandbox: string; operations: string[] }>;
      code_shapes: Array<{ id: string; kind: string; lang: string; target: string; deny_imports?: string[] }>;
    };

    expect(index.schema_version).toBe("1");
    expect(index.summary).toMatchObject({
      invariant_count: 5,
      checker_count: 1,
      scenario_count: 1,
      code_shape_count: 1,
    });
    expect(index.protected).toContain("contract/**/*.stele");
    expect(index.scenarios).toMatchObject([
      {
        id: "payment-smoke-flow",
        executor: "python-import",
        sandbox: "transactional",
        operations: ["seed-payment", "payment"],
      },
    ]);
    expect(index.code_shapes).toMatchObject([
      {
        id: "PAYMENT_LAYER_BOUNDARY",
        kind: "boundary",
        lang: "python",
        target: "src/payments/**/*.py",
        deny_imports: ["app.infrastructure"],
      },
    ]);
    expect(index.rules.find((rule) => rule.id === "ROOT_PAYMENT_BALANCE")).toMatchObject({
      id: "ROOT_PAYMENT_BALANCE",
      kind: "invariant",
      severity: "critical",
      category: "data-integrity",
      tags: ["payment", ":priority", "batch window"],
      file_path: "contract/main.stele",
      line: 9,
      generated_test_path: "tests/contract/test_contract.py",
      dependencies: ["PAYMENT_BASELINE"],
      checker_id: null,
      scenario_id: null,
    });
  });

  it("explain --json returns the exact rule object and source for agent consumption", async () => {
    const projectDir = await createInspectionFixtureProject();
    const stdout = captureStdout();

    await runExplain(projectDir, "ROOT_PAYMENT_BALANCE", { json: true });

    const explanation = JSON.parse(stdout.read()) as {
      rule: {
        id: string;
        severity: string;
        category: string;
        dependencies: string[];
      };
      source: string;
    };

    expect(explanation.rule).toMatchObject({
      id: "ROOT_PAYMENT_BALANCE",
      severity: "critical",
      category: "data-integrity",
      dependencies: ["PAYMENT_BASELINE"],
    });
    expect(explanation.source).toContain("(invariant ROOT_PAYMENT_BALANCE");
    expect(explanation.source).toContain('(rationale "Preserve the accounting invariant before settlement.")');
  });

  it("agent-context gives agents focused maintenance guidance before editing", async () => {
    const projectDir = await createInspectionFixtureProject();
    const stdout = captureStdout();

    await runAgentContext(projectDir, { json: false, focus: ["src/payments/service.py"] });

    const output = stdout.read();
    expect(output).toContain("# Stele Agent Context");
    expect(output).toContain("Protected contract files");
    expect(output).toContain("Prefer source-code or fixture repairs before contract edits.");
    expect(output).toContain("Modifying or deleting existing contract rules requires explicit user review.");
    expect(output).toContain("New rules may be added with `stele propose invariant --apply`.");
    expect(output).toContain("ROOT_PAYMENT_BALANCE");
    expect(output).toContain("PAYMENT_LAYER_BOUNDARY");
  });

  it("agent-context focus does not match every rule through empty optional fields", async () => {
    const projectDir = await createInspectionFixtureProject();
    const main = await readFile(join(projectDir, "contract", "main.stele"), "utf8");
    await writeProjectFile(projectDir, "contract/main.stele", `${main}(import "./modules/other.stele")\n`);
    await writeProjectFile(
      projectDir,
      "contract/modules/other.stele",
      [
        "(invariant OTHER_MODULE_RULE",
        "  (severity high)",
        '  (description "Other module rule should not match main focus.")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );
    const stdout = captureStdout();

    await runAgentContext(projectDir, { json: true, focus: ["contract/main.stele"] });

    const context = JSON.parse(stdout.read()) as {
      relevant_rules: Array<{ id: string; file_path: string }>;
    };

    expect(context.relevant_rules.map((rule) => rule.id)).toEqual([
      "PAYMENT_BASELINE",
      "ROOT_PAYMENT_BALANCE",
      "COMMENT_RULE",
      "TSV_RULE",
      "GROUP_CHECKED_SETTLEMENT",
    ]);
    expect(context.relevant_rules.every((rule) => rule.file_path === "contract/main.stele")).toBe(true);
  });

  it("why explains a rule id with repair guidance for agents", async () => {
    const projectDir = await createInspectionFixtureProject();
    const stdout = captureStdout();

    await runWhy(projectDir, "ROOT_PAYMENT_BALANCE", { json: false });

    const output = stdout.read();
    expect(output).toContain("ROOT_PAYMENT_BALANCE");
    expect(output).toContain("Payments remain balanced before settlement.");
    expect(output).toContain("First repair ordinary source code, fixtures, or scenario setup if they drifted.");
    expect(output).toContain("Only ask to modify this contract when the intended behavior changed.");
  });

  it("propose invariant appends new rules through an add-only proposal file without refreshing the manifest", async () => {
    const projectDir = await createInspectionFixtureProject();
    const stdout = captureStdout();
    await writeProjectFile(projectDir, "contract/.manifest.json", '{"protected_files":{"contract/main.stele":{"sha256":"locked","size":1}}}\n');
    const manifestBefore = await readFile(join(projectDir, "contract", ".manifest.json"), "utf8");

    await runPropose(projectDir, {
      kind: "invariant",
      id: "AGENT_PAYMENT_IDEMPOTENT",
      severity: "warning",
      description: "Payment commands remain idempotent.",
      category: "payments",
      rationale: "Learned from recent payment command work.",
      assert: "(eq 1 1)",
      apply: true,
    });

    expect(stdout.read()).toContain("OK proposed invariant AGENT_PAYMENT_IDEMPOTENT");
    await expect(readFile(join(projectDir, "contract", "main.stele"), "utf8")).resolves.toContain(
      '(import "./proposals/agent-additions.stele")',
    );
    await expect(readFile(join(projectDir, "contract", "proposals", "agent-additions.stele"), "utf8")).resolves.toContain(
      "(invariant AGENT_PAYMENT_IDEMPOTENT",
    );
    await expect(readFile(join(projectDir, "contract", ".manifest.json"), "utf8")).resolves.toBe(manifestBefore);
  });

  it("propose invariant refuses duplicate ids instead of modifying existing rules", async () => {
    const projectDir = await createInspectionFixtureProject();

    await expect(
      runPropose(projectDir, {
        kind: "invariant",
        id: "ROOT_PAYMENT_BALANCE",
        severity: "warning",
        description: "Duplicate rule.",
        assert: "(eq 1 1)",
        apply: true,
      }),
    ).rejects.toThrow(/already exists|duplicate/i);
  });

  it("maintenance-summary writes a periodic agent maintenance artifact with add-only next steps", async () => {
    const projectDir = await createInspectionFixtureProject();
    const stdout = captureStdout();

    await runMaintenanceSummary(projectDir, {
      from: "HEAD~1",
      output: ".stele/maintenance/summary.md",
    });

    expect(stdout.read()).toContain("OK wrote Stele maintenance summary");
    const summary = await readFile(join(projectDir, ".stele", "maintenance", "summary.md"), "utf8");
    expect(summary).toContain("# Stele Maintenance Summary");
    expect(summary).toContain("Contract inventory");
    expect(summary).toContain("Candidate questions for newly learned behavior");
    expect(summary).toContain("stele propose invariant --apply");
    expect(summary).toContain("Modifications and deletions require explicit user review");
  });

  it("explain prints group invariant details including checker id and generated group path", async () => {
    const projectDir = await createInspectionFixtureProject();
    const stdout = captureStdout();

    await runExplain(projectDir, "GROUP_CHECKED_SETTLEMENT");

    expect(stdout.read()).toContain("Generated Test Path: tests/contract/test_batch_reconciliation.py\n");
    expect(stdout.read()).toContain("Dependencies: <none>\n");
    expect(stdout.read()).toContain("Rationale: <none>\n");
    expect(stdout.read()).toContain("Checker ID: approved_checker\n");
    expect(stdout.read()).toContain(
      [
        "Source:",
        "(invariant GROUP_CHECKED_SETTLEMENT",
        "    (severity medium)",
        '    (description "Settlement batches require an approved checker.")',
        "    (category (domain ledger))",
        "    (tags payment (scope nightly) 7)",
        "    (uses-checker approved_checker))",
      ].join("\n"),
    );
  });

  it("explain preserves source when comments contain closing parens and strings contain comment-like characters", async () => {
    const projectDir = await createInspectionFixtureProject();
    const stdout = captureStdout();

    await runExplain(projectDir, "COMMENT_RULE");

    expect(stdout.read()).toContain(
      [
        "Source:",
        "(invariant COMMENT_RULE",
        "  (severity high)",
        "  ; note: this comment mentions ) and should not end the invariant",
        '  (description "Comment rule with ) and ; inside the string.")',
        '  (rationale "Rationale keeps ) and ; as literal text.")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );
  });

  it("explain rejects unknown ids and CLI exit handling includes the missing id", async () => {
    const projectDir = await createInspectionFixtureProject();
    const stderr = captureStderr();
    const originalExitCode = process.exitCode;

    await expect(runExplain(projectDir, "MISSING_RULE")).rejects.toThrow(/MISSING_RULE/);

    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    process.exitCode = 0;
    await runCli(["node", "stele", "explain", "MISSING_RULE"]);

    expect(process.exitCode).toBe(1);
    expect(stderr.read()).toContain("MISSING_RULE");
    process.exitCode = originalExitCode;
  });

  it("add-checker creates the exact stub file and prints the checker block", async () => {
    const projectDir = await createInspectionFixtureProject();
    const stdout = captureStdout();

    await runAddChecker(projectDir, "fresh_checker");

    await expect(readFile(join(projectDir, "contract", "checker_impls", "fresh_checker.py"), "utf8")).resolves.toBe(CHECKER_STUB);
    expect(stdout.read()).toBe(CHECKER_BLOCK);
  });

  it("add-checker creates a missing checker implementation directory inside the project", async () => {
    const projectDir = await createInspectionFixtureProject();
    const stdout = captureStdout();

    await rm(join(projectDir, "contract", "checker_impls"), { recursive: true, force: true });
    await runAddChecker(projectDir, "fresh_checker");

    await expect(readFile(join(projectDir, "contract", "checker_impls", "fresh_checker.py"), "utf8")).resolves.toBe(CHECKER_STUB);
    expect(stdout.read()).toBe(CHECKER_BLOCK);
  });

  it("add-checker accepts a hyphenated CDL checker id, creates an underscore Python filename, and prints the CDL id unchanged", async () => {
    const projectDir = await createInspectionFixtureProject();
    const stdout = captureStdout();

    await runAddChecker(projectDir, "fresh-checker");

    await expect(readFile(join(projectDir, "contract", "checker_impls", "fresh_checker.py"), "utf8")).resolves.toBe(CHECKER_STUB);
    expect(stdout.read()).toBe(HYPHENATED_CHECKER_BLOCK);
  });

  it("add-checker rejects invalid or dangerous ids", async () => {
    const projectDir = await createInspectionFixtureProject();

    for (const checkerId of ["", "../escape", "nested/checker", "C:\\evil", "\\\\server\\share", "-bad", "name.py"]) {
      await expect(runAddChecker(projectDir, checkerId)).rejects.toThrow(/checker/i);
    }
  });

  it("add-checker refuses to overwrite an existing checker implementation", async () => {
    const projectDir = await createInspectionFixtureProject();

    await expect(runAddChecker(projectDir, "approved_checker")).rejects.toThrow(/approved_checker/i);
    await expect(readFile(join(projectDir, "contract", "checker_impls", "approved_checker.py"), "utf8")).resolves.toBe(
      "def approved_checker(context):\n    return {\"passed\": True, \"message\": None}\n",
    );
  });

  it("add-checker refuses filename collisions between hyphenated and underscored ids", async () => {
    const projectDir = await createInspectionFixtureProject();
    const stdout = captureStdout();

    await runAddChecker(projectDir, "fresh_checker");

    await expect(runAddChecker(projectDir, "fresh-checker")).rejects.toThrow(/fresh-checker|fresh_checker|already exists|collision/i);
    await expect(readFile(join(projectDir, "contract", "checker_impls", "fresh_checker.py"), "utf8")).resolves.toBe(CHECKER_STUB);
    expect(stdout.read()).toBe(CHECKER_BLOCK);
  });

  it("add-checker rejects case-insensitive collisions across hyphenated and underscored ids", async () => {
    const projectDir = await createInspectionFixtureProject();
    const stdout = captureStdout();

    await runAddChecker(projectDir, "Fresh-Checker");

    await expect(runAddChecker(projectDir, "fresh_checker")).rejects.toThrow(/Fresh-Checker|fresh_checker|collision|already exists/i);
    await expect(runAddChecker(projectDir, "fresh-checker")).rejects.toThrow(/Fresh-Checker|fresh-checker|collision|already exists/i);
    await expect(readFile(join(projectDir, "contract", "checker_impls", "Fresh_Checker.py"), "utf8")).resolves.toBe(CHECKER_STUB);
    expect(stdout.read()).toBe(
      `(checker Fresh-Checker
  (description "TODO: describe what this checker validates."))
`,
    );
  });

  it("add-checker rejects checker directories that escape the project root via symlink or junction", async () => {
    const projectDir = await createInspectionFixtureProject();
    const externalDir = await createTempDir();
    const checkerImplDir = join(projectDir, "contract", "checker_impls");

    await rm(checkerImplDir, { recursive: true, force: true });

    const createdLink = await tryCreateNonRegularEntry(externalDir, checkerImplDir);

    if (!createdLink) {
      return;
    }

    await expect(runAddChecker(projectDir, "probe_checker")).rejects.toThrow(/checkerImplDir|project root|symlink|junction|non-regular/i);
    await expect(readdir(externalDir)).resolves.toEqual([]);
  });

  it("add-checker rejects linked checker ancestors before creating external directories", async () => {
    const projectDir = await createTempDir();
    const outsideDir = await createTempDir();

    await writeProjectFile(projectDir, STELE_CONFIG_FILE, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);

    const createdLink = await tryCreateNonRegularEntry(outsideDir, join(projectDir, "contract"));

    if (!createdLink) {
      return;
    }

    await expect(runAddChecker(projectDir, "probe_checker")).rejects.toThrow(/checkerImplDir|project root|symlink|junction|non-regular/i);
    await expect(readdir(outsideDir)).resolves.toEqual([]);
  });

  it("CLI wiring forwards cwd, filters, ids, and checker names to the new handlers", async () => {
    const handlers = {
      list: vi.fn(async () => undefined),
      explain: vi.fn(async () => undefined),
      addChecker: vi.fn(async () => undefined),
      rules: vi.fn(async () => undefined),
      agentContext: vi.fn(async () => undefined),
      why: vi.fn(async () => undefined),
      propose: vi.fn(async () => undefined),
      maintenanceSummary: vi.fn(async () => undefined),
    };
    const program = createProgram({
      cwd: () => "E:/tmp/project",
      runList: handlers.list,
      runExplain: handlers.explain,
      runAddChecker: handlers.addChecker,
      runRules: handlers.rules,
      runAgentContext: handlers.agentContext,
      runWhy: handlers.why,
      runPropose: handlers.propose,
      runMaintenanceSummary: handlers.maintenanceSummary,
    });

    await program.parseAsync(["node", "stele", "list", "--severity", "critical", "--category", "data-integrity", "--tag", "payment"]);
    await program.parseAsync(["node", "stele", "explain", "ROOT_PAYMENT_BALANCE", "--json"]);
    await program.parseAsync(["node", "stele", "add-checker", "fresh_checker"]);
    await program.parseAsync(["node", "stele", "rules", "--json"]);
    await program.parseAsync(["node", "stele", "agent-context", "--focus", "src/payments/service.py", "--json"]);
    await program.parseAsync(["node", "stele", "why", "ROOT_PAYMENT_BALANCE", "--json"]);
    await program.parseAsync([
      "node",
      "stele",
      "propose",
      "invariant",
      "--id",
      "AGENT_RULE",
      "--severity",
      "medium",
      "--description",
      "Agent rule.",
      "--assert",
      "(eq 1 1)",
      "--apply",
    ]);
    await program.parseAsync(["node", "stele", "maintenance-summary", "--from", "main", "--output", ".stele/maintenance/summary.md"]);

    expect(handlers.list).toHaveBeenCalledWith("E:/tmp/project", {
      severity: "critical",
      category: "data-integrity",
      tag: "payment",
      format: "table",
    });
    expect(handlers.explain).toHaveBeenCalledWith("E:/tmp/project", "ROOT_PAYMENT_BALANCE", { json: true });
    expect(handlers.addChecker).toHaveBeenCalledWith("E:/tmp/project", "fresh_checker");
    expect(handlers.rules).toHaveBeenCalledWith("E:/tmp/project", { json: true });
    expect(handlers.agentContext).toHaveBeenCalledWith("E:/tmp/project", {
      focus: ["src/payments/service.py"],
      json: true,
    });
    expect(handlers.why).toHaveBeenCalledWith("E:/tmp/project", "ROOT_PAYMENT_BALANCE", { json: true });
    expect(handlers.propose).toHaveBeenCalledWith("E:/tmp/project", {
      kind: "invariant",
      id: "AGENT_RULE",
      severity: "medium",
      description: "Agent rule.",
      assert: "(eq 1 1)",
      apply: true,
    });
    expect(handlers.maintenanceSummary).toHaveBeenCalledWith("E:/tmp/project", {
      from: "main",
      output: ".stele/maintenance/summary.md",
    });
  });
});

async function createInspectionFixtureProject(): Promise<string> {
  const projectDir = await createTempDir();

  await writeProjectFile(projectDir, STELE_CONFIG_FILE, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  await writeProjectFile(
    projectDir,
    "contract/main.stele",
    [
      "(checker approved_checker",
      '  (description "Checker for settlement approvals."))',
      "",
      "(invariant PAYMENT_BASELINE",
      "  (severity high)",
      '  (description "Baseline rule used as a dependency target.")',
      "  (assert (eq 1 1)))",
      "",
      "(invariant ROOT_PAYMENT_BALANCE",
      "  (severity critical)",
      '  (description "Payments remain balanced before settlement.")',
      "  (category data-integrity)",
      '  (tags payment :priority "batch window")',
      '  (rationale "Preserve the accounting invariant before settlement.")',
      "  (depends-on PAYMENT_BASELINE)",
      "  (assert (eq 1 1)))",
      "",
      "(invariant COMMENT_RULE",
      "  (severity high)",
      "  ; note: this comment mentions ) and should not end the invariant",
      '  (description "Comment rule with ) and ; inside the string.")',
      '  (rationale "Rationale keeps ) and ; as literal text.")',
      "  (assert (eq 1 1)))",
      "",
      "(invariant TSV_RULE",
      "  (severity high)",
      '  (description "Tabbed\\\\path\\tline\\nnext\\rreturn")',
      "  (assert (eq 1 1)))",
      "",
      "(group batch-reconciliation",
      '  (description "Group for settlement checks.")',
      "  (invariant GROUP_CHECKED_SETTLEMENT",
      "    (severity medium)",
      '    (description "Settlement batches require an approved checker.")',
      "    (category (domain ledger))",
      "    (tags payment (scope nightly) 7)",
      "    (uses-checker approved_checker)))",
      "",
      "(scenario payment-smoke-flow",
      "  (sandbox transactional)",
      "  (executor python-import)",
      "  (step seed-payment",
      '    (call "tests.contract_scenarios:seed_payment")',
      "    (capture payment))",
      "  (capture-state payment",
      '    (call "tests.contract_scenarios:get_payment")))',
      "",
      "(boundary PAYMENT_LAYER_BOUNDARY",
      "  (lang python)",
      '  (target "src/payments/**/*.py")',
      '  (deny-import "app.infrastructure"))',
    ].join("\n") + "\n",
  );
  await writeProjectFile(
    projectDir,
    "contract/checker_impls/approved_checker.py",
    "def approved_checker(context):\n    return {\"passed\": True, \"message\": None}\n",
  );
  await writeProjectFile(
    projectDir,
    "tests/contract/conftest.py",
    "import pytest\n\n@pytest.fixture\ndef stele_context():\n    return {}\n",
  );

  return projectDir;
}

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "stele-cli-"));
  tempDirs.push(directory);
  return directory;
}

async function writeProjectFile(projectDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = join(projectDir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

async function expectListOutput(projectDir: string, options: { severity?: string; category?: string; tag?: string }, lines: string[]) {
  const stdout = captureStdout();
  await runList(projectDir, options);
  expect(stdout.read()).toBe(`${lines.join("\n")}\n`);
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

function captureStderr(): { read(): string } {
  const chunks: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write);
  return {
    read: () => chunks.join(""),
  };
}

async function tryCreateNonRegularEntry(targetDirectory: string, linkPath: string): Promise<boolean> {
  for (const type of ["junction", "dir"] as const) {
    try {
      await symlink(targetDirectory, linkPath, type);
      return true;
    } catch (error) {
      if (!isSymlinkPermissionError(error)) {
        throw error;
      }
    }
  }

  return false;
}

function isSymlinkPermissionError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES" || error.code === "UNKNOWN");
}
