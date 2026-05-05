import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadContract, parseFile, SteleError, type AstNode, type Contract } from "@stele/core";
import * as backendPython from "../src/index";

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

describe("@stele/backend-python translator", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("emits the generated runtime helper file with path lookup, summation, and checker invocation helpers", async () => {
    const contract = await createContract({
      "main.stele": [
        "(invariant RUNTIME_001",
        "  (severity high)",
        '  (description "Runtime file generation smoke test.")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });

    const files = getGeneratePytestFiles()(contract);
    const runtimeFile = files.find((file) => file.path === "tests/contract/_stele_runtime.py");

    expect(files.map((file) => file.path)).toEqual([
      "tests/contract/__init__.py",
      "tests/contract/_stele_runtime.py",
      "tests/contract/test_contract.py",
    ]);
    expect(runtimeFile?.content).toContain([
      "def stele_get_path(root, parts):",
      "    current = root",
      "    for part in parts:",
      "        if isinstance(current, dict) and part in current:",
      "            current = current[part]",
      "        elif hasattr(current, part):",
      "            current = getattr(current, part)",
      "        elif hasattr(current, part.replace(\"-\", \"_\")):",
      "            current = getattr(current, part.replace(\"-\", \"_\"))",
      "        else:",
      "            raise KeyError(f\"Stele path segment not found: {part}\")",
      "    return current",
    ].join("\n"));
    expect(runtimeFile?.content).toContain("def stele_sum(items, parts):");
    expect(runtimeFile?.content).toContain("def stele_call_checker(name, stele_context, kwargs):");
    expect(runtimeFile?.content).toContain("def stele_is_modified(stele_context, parts):");
    expect(runtimeFile?.content).toContain("def stele_merge_contexts(*contexts):");
    expect(runtimeFile?.content).toContain("def stele_run_scenario(scenario, stele_context, stele_sandbox):");
    expect(getRuntimeSource()()).toBe(runtimeFile?.content);
  });

  it("generates deterministic pytest for assertions, checker calls, and sanitized invariant ids", async () => {
    const contract = await createContract({
      "main.stele": [
        "(checker balance-change-has-transaction",
        '  (description "fixture checker declaration"))',
        "(invariant ACCT_001",
        "  (severity critical)",
        '  (description "account total equals positions plus cash")',
        "  (assert",
        "    (eq (path account total-value)",
        "        (add (sum (collection positions) (path value))",
        "             (path account cash)))))",
        "(invariant ACCT-003",
        "  (severity high)",
        '  (description "checker-backed validation")',
        "  (uses-checker balance-change-has-transaction))",
        "(invariant ACCT_004",
        "  (severity medium)",
        '  (description "every transaction amount is positive")',
        "  (assert",
        "    (forall txn (collection transactions)",
        "      (gt (path txn amount) 0))))",
      ].join("\n"),
    });

    const files = getGeneratePytestFiles()(contract);
    const testFile = files.find((file) => file.path === "tests/contract/test_contract.py");

    expect(testFile?.content).toBe([
      "from ._stele_runtime import stele_call_checker, stele_get_path, stele_is_modified, stele_sum",
      "",
      "",
      "def test_ACCT_001(stele_context):",
      "    assert stele_get_path(stele_context[\"account\"], [\"total-value\"]) == (",
      "        stele_sum(stele_context[\"positions\"], [\"value\"])",
      "        + stele_get_path(stele_context[\"account\"], [\"cash\"])",
      "    )",
      "",
      "",
      "def test_ACCT_003(stele_context):",
      "    result = stele_call_checker(\"balance-change-has-transaction\", stele_context, {})",
      "    assert result[\"passed\"], result.get(\"message\") or \"Checker failed: balance-change-has-transaction\"",
      "",
      "",
      "def test_ACCT_004(stele_context):",
      "    assert all(",
      "        (stele_get_path(txn, [\"amount\"])) > (0)",
      "        for txn in stele_context[\"transactions\"]",
      "    )",
      "",
    ].join("\n"));
  });

  it("writes package-shaped pytest artifacts that import and collect with python -m pytest", async () => {
    const contract = await createContract({
      "main.stele": [
        "(invariant ACCT_001",
        "  (severity critical)",
        '  (description "account total equals positions plus cash")',
        "  (assert",
        "    (eq (path account total-value)",
        "        (add (sum (collection positions) (path value))",
        "             (path account cash)))))",
      ].join("\n"),
    });
    const projectDir = await writeGeneratedPytestProject(
      contract,
      [
        "import pytest",
        "",
        "",
        "@pytest.fixture",
        "def stele_context():",
        "    return {",
        "        \"account\": {\"total-value\": 15, \"cash\": 5},",
        "        \"positions\": [{\"value\": 4}, {\"value\": 6}],",
        "    }",
      ],
    );

    const result = await runGeneratedPytest(projectDir);

    expect(result.stdout).toContain("1 passed");
  });

  it("runs cross-table filtered sum, avg, min, and max aggregations", async () => {
    const contract = await createContract({
      "main.stele": [
        "(invariant BUDGETS_MATCH_TRANSACTIONS",
        "  (severity high)",
        '  (description "Budget aggregates are derived from related transaction rows.")',
        "  (assert",
        "    (forall budget (collection budgets)",
        "      (and",
        "        (lte",
        "          (sum",
        "            (where txn (collection transactions)",
        "              (eq (path txn budget-id) (path budget id)))",
        "            (path amount))",
        "          (path budget limit))",
        "        (lte",
        "          (avg",
        "            (where txn (collection transactions)",
        "              (eq (path txn budget-id) (path budget id)))",
        "            (path amount))",
        "          (path budget avg-limit))",
        "        (gte",
        "          (min",
        "            (where txn (collection transactions)",
        "              (eq (path txn budget-id) (path budget id)))",
        "            (path amount))",
        "          (path budget min-amount))",
        "        (lte",
        "          (max",
        "            (where txn (collection transactions)",
        "              (eq (path txn budget-id) (path budget id)))",
        "            (path amount))",
        "          (path budget max-amount))))))",
      ].join("\n"),
    });
    const projectDir = await writeGeneratedPytestProject(
      contract,
      [
        "import pytest",
        "",
        "",
        "@pytest.fixture",
        "def stele_context():",
        "    return {",
        "        \"budgets\": [",
        "            {\"id\": \"ops\", \"limit\": 100, \"avg-limit\": 50, \"min-amount\": 10, \"max-amount\": 60},",
        "            {\"id\": \"rd\", \"limit\": 90, \"avg-limit\": 45, \"min-amount\": 15, \"max-amount\": 45},",
        "        ],",
        "        \"transactions\": [",
        "            {\"budget-id\": \"ops\", \"amount\": 20},",
        "            {\"budget-id\": \"ops\", \"amount\": 55},",
        "            {\"budget-id\": \"rd\", \"amount\": 15},",
        "            {\"budget-id\": \"rd\", \"amount\": 45},",
        "        ],",
        "    }",
      ],
    );

    const result = await runGeneratedPytest(projectDir);
    const testSource = getGeneratedTestFile(contract);

    expect(testSource).toContain('[txn for txn in stele_context["transactions"] if');
    expect(testSource).toContain('stele_get_path(txn, ["budget-id"])');
    expect(testSource).toContain('stele_get_path(budget, ["id"])');
    expect(result.stdout).toContain("1 passed");
  });

  it("disambiguates sanitized sibling invariant ids so pytest collects both tests", async () => {
    const contract = await createContract({
      "main.stele": [
        "(invariant A-B",
        "  (severity high)",
        '  (description "hyphenated invariant id")',
        "  (assert (eq 1 1)))",
        "(invariant A_B",
        "  (severity high)",
        '  (description "underscored invariant id")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });
    const projectDir = await writeGeneratedPytestProject(
      contract,
      [
        "import pytest",
        "",
        "",
        "@pytest.fixture",
        "def stele_context():",
        "    return {}",
      ],
    );
    const result = await runGeneratedPytest(projectDir);
    const testSource = getGeneratedTestFile(contract);

    expect(testSource).toContain("def test_A_B(stele_context):");
    expect(testSource).toContain("def test_A_B_2(stele_context):");
    expect(result.stdout).toContain("2 passed");
  });

  it("allocates keyword-safe quantifier bindings for generated pytest", async () => {
    const contract = await createContract({
      "main.stele": [
        "(invariant KW_BINDING",
        "  (severity high)",
        '  (description "python keyword bindings stay valid")',
        "  (assert",
        "    (forall for (collection items)",
        "      (gt (path for value) 0))))",
      ].join("\n"),
    });
    const projectDir = await writeGeneratedPytestProject(
      contract,
      [
        "import pytest",
        "",
        "",
        "@pytest.fixture",
        "def stele_context():",
        "    return {",
        "        \"items\": [{\"value\": 1}, {\"value\": 2}],",
        "    }",
      ],
    );
    const result = await runGeneratedPytest(projectDir);
    const testSource = getGeneratedTestFile(contract);

    expect(testSource).toContain("for for_2 in stele_context[\"items\"]");
    expect(result.stdout).toContain("1 passed");
  });

  it("generates pytest that runs python-import scenarios before asserting on merged scenario state", async () => {
    const contract = await createContract({
      "main.stele": [
        "(scenario fund-pnl-flow",
        "  (sandbox transactional)",
        "  (executor python-import)",
        "  (step setup-fund",
        '    (call "tests.contract_scenarios:create_fund"',
        '      (body (object (name (gen unique-name "fund")))))',
        "    (capture fund))",
        "  (capture-state pnl",
        '    (call "tests.contract_scenarios:get_pnl"',
        "      (body (object (fund-id (ref fund id)))))))",
        "(invariant FUND_PNL_VALID",
        "  (uses-scenario fund-pnl-flow)",
        "  (severity high)",
        '  (description "Generated fund PnL remains valid.")',
        "  (assert (gt (path pnl value) 0)))",
      ].join("\n"),
    });

    const testSource = getGeneratedTestFile(contract);

    expect(testSource).toContain(
      "from ._stele_runtime import stele_call_checker, stele_get_path, stele_is_modified, stele_merge_contexts, stele_run_scenario, stele_sum",
    );
    expect(testSource).toContain("def test_FUND_PNL_VALID(stele_context, stele_sandbox):");
    expect(testSource).toContain("stele_scenario_context = stele_run_scenario(");
    expect(testSource).toContain('"target": "tests.contract_scenarios:create_fund"');
    expect(testSource).toContain('"name": {"$gen": {"kind": "unique-name", "prefix": "fund"}}');
    expect(testSource).toContain('"fund-id": {"$ref": ["fund", "id"]}');
    expect(testSource).toContain('stele_assert_context = stele_merge_contexts(stele_context, stele_scenario_context)');
    expect(testSource).toContain('assert (stele_get_path(stele_assert_context["pnl"], ["value"])) > (0)');
  });

  it("runs modified assertions against state-before/state-after through the generated runtime", async () => {
    const contract = await createContract({
      "main.stele": [
        "(invariant BALANCE_MODIFIED",
        "  (severity high)",
        '  (description "account balance changes are detectable from runtime state snapshots")',
        "  (assert (modified (path account balance))))",
      ].join("\n"),
    });
    const projectDir = await writeGeneratedPytestProject(
      contract,
      [
        "import pytest",
        "",
        "",
        "@pytest.fixture",
        "def stele_context():",
        "    return {",
        "        \"state-before\": {\"account\": {\"balance\": 10}},",
        "        \"state-after\": {\"account\": {\"balance\": 12}},",
        "    }",
      ],
    );
    const result = await runGeneratedPytest(projectDir);
    const testSource = getGeneratedTestFile(contract);

    expect(testSource).toContain('assert stele_is_modified(stele_context, ["account","balance"])');
    expect(result.stdout).toContain("1 passed");
  });

  it("executes python-import scenarios end to end with sandbox fixtures and captured state", async () => {
    const contract = await createContract({
      "main.stele": [
        "(scenario fund-pnl-flow",
        "  (sandbox transactional)",
        "  (executor python-import)",
        "  (step setup-fund",
        '    (call "tests.contract_scenarios:create_fund"',
        '      (body (object (name (gen unique-name "fund")))))',
        "    (capture fund))",
        "  (capture-state pnl",
        '    (call "tests.contract_scenarios:get_pnl"',
        "      (body (object (fund-id (ref fund id)))))))",
        "(invariant FUND_PNL_VALID",
        "  (uses-scenario fund-pnl-flow)",
        "  (severity high)",
        '  (description "Generated fund PnL remains valid.")',
        "  (assert (gt (path pnl value) 0)))",
      ].join("\n"),
    });
    const projectDir = await writeGeneratedPytestProject(
      contract,
      [
        "from contextlib import nullcontext",
        "import pytest",
        "",
        "",
        "@pytest.fixture",
        "def stele_context():",
        "    return {}",
        "",
        "",
        "@pytest.fixture",
        "def stele_sandbox():",
        "    return nullcontext()",
      ],
      {
        "tests/contract_scenarios.py": [
          "def create_fund(body, stele_context):",
          '    return {"id": "fund-123", "name": body["name"]}',
          "",
          "",
          "def get_pnl(body, stele_context):",
          '    assert body["fund-id"] == "fund-123"',
          '    return {"value": 5}',
        ].join("\n"),
      },
    );

    const result = await runGeneratedPytest(projectDir);

    expect(result.stdout).toContain("1 passed");
  });

  it("fails generated pytest when scenario-backed assertions are false", async () => {
    const contract = await createContract({
      "main.stele": [
        "(scenario fund-pnl-flow",
        "  (sandbox transactional)",
        "  (executor python-import)",
        "  (step setup-fund",
        '    (call "tests.contract_scenarios:create_fund"',
        '      (body (object (name (gen unique-name "fund")))))',
        "    (capture fund))",
        "  (capture-state pnl",
        '    (call "tests.contract_scenarios:get_pnl"',
        "      (body (object (fund-id (ref fund id)))))))",
        "(invariant FUND_PNL_INVALID",
        "  (uses-scenario fund-pnl-flow)",
        "  (severity high)",
        '  (description "Generated fund PnL must exceed an impossible threshold.")',
        "  (assert (gt (path pnl value) 10)))",
      ].join("\n"),
    });
    const projectDir = await writeGeneratedPytestProject(
      contract,
      [
        "from contextlib import nullcontext",
        "import pytest",
        "",
        "",
        "@pytest.fixture",
        "def stele_context():",
        "    return {}",
        "",
        "",
        "@pytest.fixture",
        "def stele_sandbox():",
        "    return nullcontext()",
      ],
      {
        "tests/contract_scenarios.py": [
          "def create_fund(body, stele_context):",
          '    return {"id": "fund-123", "name": body["name"]}',
          "",
          "",
          "def get_pnl(body, stele_context):",
          '    return {"value": 5}',
        ].join("\n"),
      },
    );

    const result = await runGeneratedPytestAllowFailure(projectDir);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("1 failed");
  });

  it("allocates scope-unique nested quantifier bindings when sanitized names collide", async () => {
    const contract = await createContract({
      "main.stele": [
        "(invariant NESTED_BINDINGS",
        "  (severity critical)",
        '  (description "outer and inner bindings remain distinct after sanitization")',
        "  (assert",
        "    (forall foo-bar (collection outers)",
        "      (forall foo_bar (collection inners)",
        "        (neq (path foo-bar value) (path foo_bar value))))))",
      ].join("\n"),
    });
    const projectDir = await writeGeneratedPytestProject(
      contract,
      [
        "import pytest",
        "",
        "",
        "@pytest.fixture",
        "def stele_context():",
        "    return {",
        "        \"outers\": [{\"value\": 1}],",
        "        \"inners\": [{\"value\": 2}],",
        "    }",
      ],
    );
    const result = await runGeneratedPytest(projectDir);
    const testSource = getGeneratedTestFile(contract);

    expect(testSource).toContain("for foo_bar in stele_context[\"outers\"]");
    expect(testSource).toContain("for foo_bar_2 in stele_context[\"inners\"]");
    expect(result.stdout).toContain("1 passed");
  });

  it("parenthesizes comparison operands so boolean expressions keep CDL precedence", async () => {
    const contract = await createContract({
      "main.stele": [
        "(invariant PRECEDENCE_OR",
        "  (severity high)",
        '  (description "or equality precedence")',
        "  (assert",
        "    (eq (or (gt (path account cash) 0)",
        "            (gt (path account cash) 1))",
        "        (gt (path account cash) 2))))",
      ].join("\n"),
    });
    const projectDir = await writeGeneratedPytestProject(
      contract,
      [
        "import pytest",
        "",
        "",
        "@pytest.fixture",
        "def stele_context():",
        "    return {",
        "        \"account\": {\"cash\": 1},",
        "    }",
      ],
    );
    const result = await runGeneratedPytestAllowFailure(projectDir);
    const testSource = getGeneratedTestFile(contract);

    expect(testSource).toContain(") == (");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("1 failed");
  });

  it("translates core expression forms used by the backend templates", () => {
    const translateExpression = getTranslateExpression();

    expect(translateExpression(parseExpression("(path account cash)"))).toBe(
      "stele_get_path(stele_context[\"account\"], [\"cash\"])",
    );
    expect(translateExpression(parseExpression("(collection positions)"))).toBe("stele_context[\"positions\"]");
    expect(translateExpression(parseExpression("(sum (collection positions) (path value))"))).toBe(
      "stele_sum(stele_context[\"positions\"], [\"value\"])",
    );
    expect(translateExpression(parseExpression("(forall txn (collection transactions) (gt (path txn amount) 0))"))).toBe(
      "all((stele_get_path(txn, [\"amount\"])) > (0) for txn in stele_context[\"transactions\"])",
    );
    expect(
      translateExpression(
        parseExpression(
          "(where txn (collection transactions) (eq (path txn budget-id) (path budget id)))",
        ),
      ),
    ).toBe(
      "[txn for txn in stele_context[\"transactions\"] if (stele_get_path(txn, [\"budget-id\"])) == (stele_get_path(stele_context[\"budget\"], [\"id\"]))]",
    );
    expect(translateExpression(parseExpression("(modified (path account balance))"))).toBe(
      "stele_is_modified(stele_context, [\"account\",\"balance\"])",
    );
  });

  it("rejects unsupported operators with backend error context", () => {
    const translateExpression = getTranslateExpression();

    expect(() => translateExpression(parseExpression("(mystery-op 1 2)"))).toThrowError(SteleError);

    try {
      translateExpression(parseExpression("(mystery-op 1 2)"));
    } catch (error) {
      expect(error).toBeInstanceOf(SteleError);
      expect(error).toMatchObject({
        code: "E0601",
        category: "Backend Error",
        span: {
          file: "<translator-test>",
          line: 1,
          column: 9,
        },
      });
      expect((error as SteleError).message).toContain("Unsupported Python backend operator");
      expect((error as SteleError).message).toContain("mystery-op");
    }
  });
});

async function createContract(files: Record<string, string>): Promise<Contract> {
  const directory = await mkdtemp(join(tmpdir(), "stele-backend-python-"));
  tempDirs.push(directory);

  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const fullPath = join(directory, relativePath);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, "utf8");
    }),
  );

  return loadContract(join(directory, "main.stele"));
}

function parseExpression(source: string): AstNode {
  const parsed = parseFile(`(assert ${source})`, "<translator-test>");
  const assertNode = parsed.body[0];

  expect(assertNode).toMatchObject({
    kind: "list",
    head: "assert",
  });

  return (assertNode as Extract<AstNode, { kind: "list" }>).items[0]!;
}

function getGeneratePytestFiles(): (contract: Contract) => Array<{ path: string; content: string }> {
  const value = (backendPython as Record<string, unknown>).generatePytestFiles;

  expect(value).toBeTypeOf("function");

  return value as (contract: Contract) => Array<{ path: string; content: string }>;
}

function getRuntimeSource(): () => string {
  const value = (backendPython as Record<string, unknown>).getPythonRuntimeSource;

  expect(value).toBeTypeOf("function");

  return value as () => string;
}

function getTranslateExpression(): (node: AstNode) => string {
  const value = (backendPython as Record<string, unknown>).translateExpression;

  expect(value).toBeTypeOf("function");

  return value as (node: AstNode) => string;
}

function getGeneratedTestFile(contract: Contract): string {
  const testFile = getGeneratePytestFiles()(contract).find((file) => file.path === "tests/contract/test_contract.py");

  expect(testFile?.content).toBeTypeOf("string");

  return testFile!.content;
}

async function writeGeneratedPytestProject(
  contract: Contract,
  conftestLines: string[],
  extraFiles: Record<string, string> = {},
): Promise<string> {
  const projectDir = await mkdtemp(join(tmpdir(), "stele-backend-python-smoke-"));
  tempDirs.push(projectDir);
  const generatedFiles = getGeneratePytestFiles()(contract);

  await Promise.all(
    generatedFiles.map(async (file) => {
      const fullPath = join(projectDir, file.path);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, file.content, "utf8");
    }),
  );

  await writeFile(join(projectDir, "tests", "contract", "conftest.py"), conftestLines.join("\n"), "utf8");
  await writeFile(join(projectDir, "tests", "__init__.py"), "", "utf8");
  await Promise.all(
    Object.entries(extraFiles).map(async ([relativePath, content]) => {
      const fullPath = join(projectDir, relativePath);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, "utf8");
    }),
  );

  return projectDir;
}

async function runGeneratedPytest(projectDir: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("python", ["-m", "pytest", "tests/contract", "-q"], {
    cwd: projectDir,
    windowsHide: true,
  });
}

async function runGeneratedPytestAllowFailure(
  projectDir: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const result = await runGeneratedPytest(projectDir);
    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    if (isExecFileError(error)) {
      return {
        exitCode: typeof error.code === "number" ? error.code : 1,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
      };
    }

    throw error;
  }
}

function isExecFileError(error: unknown): error is Error & { code?: number | string; stdout?: string; stderr?: string } {
  return error instanceof Error && ("stdout" in error || "stderr" in error || "code" in error);
}
