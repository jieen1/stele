import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadContract, parseFile, SteleError, type AstNode, type Contract } from "@stele/core";
import * as backendPython from "../src/index";

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

// Round 4 F-D-01: skip-if guard for the local-dev case where pytest is
// not installed. Without this, 10 of these tests fail not because of a
// regression but because the test environment lacks pytest — drowning
// real failures in noise. The CI workflow installs pytest before
// running this suite (see .github/workflows/ci.yml) so detection runs
// once at module load and the suite still exercises everything in CI.
const _PYTEST_AVAILABLE = (() => {
  try {
    execFileSync("python3", ["-c", "import pytest"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const itIfPytest = _PYTEST_AVAILABLE ? it : it.skip;

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
    const runtimeContent = (runtimeFile?.content ?? "").replace(/\r\n/g, "\n");
    expect(runtimeContent).toContain("def stele_get_path(root, parts):");
    expect(runtimeContent).toContain("current = root");
    expect(runtimeContent).toContain("for part in parts:");
    expect(runtimeContent).toContain("if isinstance(current, dict) and part in current:");
    expect(runtimeContent).toContain("current = current[part]");
    expect(runtimeContent).toContain("elif hasattr(current, part):");
    expect(runtimeContent).toContain("current = getattr(current, part)");
    expect(runtimeContent).toContain('elif hasattr(current, part.replace("-", "_")):');
    expect(runtimeContent).toContain('current = getattr(current, part.replace("-", "_"))');
    expect(runtimeContent).toContain('raise KeyError(f"Stele path segment not found: {part}")');
    expect(runtimeContent).toContain("return current");
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

  itIfPytest("writes package-shaped pytest artifacts that import and collect with python -m pytest", async () => {
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

  itIfPytest("runs cross-table filtered sum, avg, min, and max aggregations", async () => {
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

  itIfPytest("disambiguates sanitized sibling invariant ids so pytest collects both tests", async () => {
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

  itIfPytest("allocates keyword-safe quantifier bindings for generated pytest", async () => {
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

  itIfPytest("runs modified assertions against state-before/state-after through the generated runtime", async () => {
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

  it("uses stele_assert_context for temporal expressions in scenario-backed invariants", async () => {
    const contract = await createContract({
      "main.stele": [
        "(scenario account-balance-flow",
        "  (sandbox transactional)",
        "  (executor python-import)",
        "  (capture-state state-before",
        '    (call "tests.contract_scenarios:get_state_before"))',
        "  (capture-state state-after",
        '    (call "tests.contract_scenarios:get_state_after")))',
        "(invariant BALANCE_MODIFIED_FROM_SCENARIO",
        "  (uses-scenario account-balance-flow)",
        "  (severity high)",
        '  (description "Scenario-provided state snapshots drive modified checks.")',
        "  (assert (modified (path account balance))))",
      ].join("\n"),
    });

    const testSource = getGeneratedTestFile(contract);

    expect(testSource).toContain('assert stele_is_modified(stele_assert_context, ["account","balance"])');
  });

  itIfPytest("executes python-import scenarios end to end with sandbox fixtures and captured state", async () => {
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

  itIfPytest("executes scenario-backed temporal assertions against merged scenario state", async () => {
    const contract = await createContract({
      "main.stele": [
        "(scenario account-balance-flow",
        "  (sandbox transactional)",
        "  (executor python-import)",
        "  (capture-state state-before",
        '    (call "tests.contract_scenarios:get_state_before"))',
        "  (capture-state state-after",
        '    (call "tests.contract_scenarios:get_state_after")))',
        "(invariant BALANCE_MODIFIED_FROM_SCENARIO",
        "  (uses-scenario account-balance-flow)",
        "  (severity high)",
        '  (description "Scenario-provided state snapshots drive modified checks.")',
        "  (assert (modified (path account balance))))",
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
        '    return {"state-before": {"account": {"balance": 1}}, "state-after": {"account": {"balance": 1}}}',
        "",
        "",
        "@pytest.fixture",
        "def stele_sandbox():",
        "    return nullcontext()",
      ],
      {
        "tests/contract_scenarios.py": [
          "def get_state_before(body, stele_context):",
          '    return {"account": {"balance": 10}}',
          "",
          "",
          "def get_state_after(body, stele_context):",
          '    return {"account": {"balance": 12}}',
        ].join("\n"),
      },
    );

    const result = await runGeneratedPytest(projectDir);

    expect(result.stdout).toContain("1 passed");
  });

  itIfPytest("fails generated pytest when scenario-backed assertions are false", async () => {
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

  itIfPytest("allocates scope-unique nested quantifier bindings when sanitized names collide", async () => {
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

  itIfPytest("parenthesizes comparison operands so boolean expressions keep CDL precedence", async () => {
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
    expect(translateExpression(parseExpression("(state-before)"))).toBe('stele_context["state-before"]');
    expect(translateExpression(parseExpression("(state-after)"))).toBe('stele_context["state-after"]');
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

  it("all core operators have Python backend handlers", async () => {
    const { createCoreOperatorRegistry } = await import("@stele/core");
    const registry = createCoreOperatorRegistry();
    const operatorNames = registry.list().map((spec) => spec.name);
    const translateExpression = getTranslateExpression();
    const missing: string[] = [];

    for (const name of operatorNames) {
      try {
        let expr: string;
        if (name === "path") {
          expr = "(path account value)";
        } else if (name === "field") {
          expr = "(field account value)";
        } else if (name === "value") {
          expr = "(value 1)";
        } else {
          expr = "(path account value)";
        }
        translateExpression(parseExpression(`(${name} ${expr})`));
      } catch (error) {
        if (error instanceof SteleError && error.code === "E0601") {
          missing.push(name);
        }
      }
    }
    expect(missing.length).toBe(0);
  });

  // ---------------------------------------------------------------------
  // EP06: Code Shape pytest emit. Each shape kind owns one test that
  // verifies a representative declaration becomes a real pytest function
  // backed by the runtime helpers shipped in `_stele_runtime.py`.
  // ---------------------------------------------------------------------

  describe("Code Shape emit (EP06)", () => {
    it("emits test_code_shape.py only when the contract carries Code Shape declarations", async () => {
      const empty = await createContract({
        "main.stele": [
          "(invariant FOO",
          "  (severity high)",
          '  (description "no code shapes")',
          "  (assert (eq 1 1)))",
        ].join("\n"),
      });
      const emptyFiles = getGeneratePytestFiles()(empty);
      expect(emptyFiles.map((file) => file.path)).not.toContain("tests/contract/test_code_shape.py");

      const withShapes = await createContract({
        "main.stele": [
          "(invariant FOO",
          "  (severity high)",
          '  (description "smoke")',
          "  (assert (eq 1 1)))",
          "(class-shape demo",
          "  (lang python)",
          '  (target "app/account.py::Account")',
          "  (must-have-method save))",
        ].join("\n"),
      });
      const shapeFiles = getGeneratePytestFiles()(withShapes);
      expect(shapeFiles.map((file) => file.path)).toContain("tests/contract/test_code_shape.py");
    });

    it("class-shape emits stele_resolve_class plus stele_has_field / stele_has_callable assertions", async () => {
      const contract = await createContract({
        "main.stele": [
          "(invariant SMOKE",
          "  (severity high)",
          '  (description "smoke")',
          "  (assert (eq 1 1)))",
          "(class-shape account_class",
          "  (lang python)",
          '  (target "app/account.py::Account")',
          '  (must-have-field id "str")',
          "  (must-have-field created_at)",
          "  (must-have-method deposit)",
          "  (must-extend BaseAccount))",
        ].join("\n"),
      });
      const file = getGeneratedCodeShapeFile(contract);

      expect(file).toContain("def test_class_shape_account_class(stele_context):");
      expect(file).toContain('cls = stele_resolve_class("app.account.Account")');
      expect(file).toContain('stele_has_field(cls, "id", expected_type="str")');
      expect(file).toContain('stele_has_field(cls, "created_at")');
      expect(file).toContain('stele_has_callable(cls, "deposit")');
      expect(file).toContain("getattr(cls, \"__mro__\", [cls])[1:]");
      expect(file).toContain("must extend BaseAccount");
    });

    it("function-shape emits stele_resolve_function and inspect.signature parameter checks", async () => {
      const contract = await createContract({
        "main.stele": [
          "(invariant SMOKE",
          "  (severity high)",
          '  (description "smoke")',
          "  (assert (eq 1 1)))",
          "(function-shape calculate_total_fn",
          "  (lang python)",
          '  (target "app/totals.py::calculate_total")',
          "  (must-have-parameter cart)",
          "  (must-have-parameter tax-rate)",
          "  (must-have-decorator login_required)",
          '  (must-have-call "transaction.atomic"))',
        ].join("\n"),
      });
      const file = getGeneratedCodeShapeFile(contract);

      expect(file).toContain("def test_function_shape_calculate_total_fn(stele_context):");
      expect(file).toContain('fn = stele_resolve_function("app.totals.calculate_total")');
      expect(file).toContain("signature = inspect.signature(fn)");
      expect(file).toContain('"cart" not in actual_parameters');
      // kebab-to-snake conversion for parameter names
      expect(file).toContain('"tax_rate" not in actual_parameters');
      expect(file).toContain("__stele_decorators__");
      // must-have-call defers to AST analysis in stele check
      expect(file).toContain("must-have-call rules are enforced by AST analysis in 'stele check'");
      expect(file).toContain("return_hints = stele_get_type_hints(fn)");
    });

    it("boundary emits stele_glob plus stele_collect_imports / stele_import_allowed iteration", async () => {
      const contract = await createContract({
        "main.stele": [
          "(invariant SMOKE",
          "  (severity high)",
          '  (description "smoke")',
          "  (assert (eq 1 1)))",
          "(boundary api_boundary",
          "  (lang python)",
          '  (target "src/api/*.py")',
          '  (deny-import "requests" "urllib3")',
          '  (allow-target "src/api/safe.py"))',
        ].join("\n"),
      });
      const file = getGeneratedCodeShapeFile(contract);

      expect(file).toContain("def test_boundary_api_boundary(stele_context):");
      expect(file).toContain('matched = stele_glob("src/api/*.py")');
      expect(file).toContain('allowed_targets = ["src/api/safe.py"]');
      expect(file).toContain('denied_imports = ["requests", "urllib3"]');
      expect(file).toContain("imports = stele_collect_imports(filepath)");
      expect(file).toContain("stele_import_allowed(imp, allowed=[], forbidden=denied_imports)");
      expect(file).toContain("forbidden import");
    });

    it("type-policy emits stele_resolve_class + stele_get_class_fields when a class selector is present", async () => {
      const contract = await createContract({
        "main.stele": [
          "(invariant SMOKE",
          "  (severity high)",
          '  (description "smoke")',
          "  (assert (eq 1 1)))",
          "(type-policy account_typing",
          "  (lang python)",
          '  (target "app/account.py::Account")',
          '  (require-type "str")',
          '  (deny-type "Any"))',
        ].join("\n"),
      });
      const file = getGeneratedCodeShapeFile(contract);

      expect(file).toContain("def test_type_policy_account_typing(stele_context):");
      expect(file).toContain('cls = stele_resolve_class("app.account.Account")');
      expect(file).toContain("fields = stele_get_class_fields(cls)");
      expect(file).toContain('stele_type_matches(field_type, "str")');
      expect(file).toContain('uses denied type Any');
    });

    it("type-policy without selector falls back to glob + textual scan over matched files", async () => {
      const contract = await createContract({
        "main.stele": [
          "(invariant SMOKE",
          "  (severity high)",
          '  (description "smoke")',
          "  (assert (eq 1 1)))",
          "(type-policy module_typing",
          "  (lang python)",
          '  (target "app/**/*.py")',
          '  (require-type "Decimal")',
          '  (deny-type "Any"))',
        ].join("\n"),
      });
      const file = getGeneratedCodeShapeFile(contract);

      expect(file).toContain("def test_type_policy_module_typing(stele_context):");
      expect(file).toContain('required_names = ["Decimal"]');
      expect(file).toContain('denied_names = ["Any"]');
      expect(file).toContain('for filepath in stele_glob("app/**/*.py"):');
      expect(file).toContain("text = stele_read_file(filepath)");
    });

    it("file-policy emits glob + stele_read_file substring / ending checks", async () => {
      const contract = await createContract({
        "main.stele": [
          "(invariant SMOKE",
          "  (severity high)",
          '  (description "smoke")',
          "  (assert (eq 1 1)))",
          "(file-policy formatting_rules",
          "  (lang python)",
          '  (target "src/settings.py")',
          '  (must-contain "from __future__ import annotations")',
          '  (must-end-with "\\n"))',
        ].join("\n"),
      });
      const file = getGeneratedCodeShapeFile(contract);

      expect(file).toContain("def test_file_policy_formatting_rules(stele_context):");
      expect(file).toContain('required_substrings = ["from __future__ import annotations"]');
      expect(file).toContain('required_endings = ["\\n"]');
      expect(file).toContain('for filepath in stele_glob("src/settings.py"):');
      expect(file).toContain("text = stele_read_file(filepath)");
      expect(file).toContain("missing required substring");
      expect(file).toContain("does not end with");
    });

    it("class-shape rejects glob targets (cannot resolve a single module from a wildcard)", async () => {
      const contract = await createContract({
        "main.stele": [
          "(class-shape glob_class",
          "  (lang python)",
          '  (target "app/**/*.py::Account")',
          "  (must-have-method save))",
        ].join("\n"),
      });
      expect(() => getGeneratePytestFiles()(contract)).toThrow(SteleError);
      expect(() => getGeneratePytestFiles()(contract)).toThrow(/cannot use glob metacharacters/);
    });

    it("class-shape requires a class name selector after ::", async () => {
      const contract = await createContract({
        "main.stele": [
          "(class-shape no_selector",
          "  (lang python)",
          '  (target "app/account.py")',
          "  (must-have-method save))",
        ].join("\n"),
      });
      expect(() => getGeneratePytestFiles()(contract)).toThrow(SteleError);
      expect(() => getGeneratePytestFiles()(contract)).toThrow(/must specify a class name after "::"/);
    });

    it("test_code_shape.py imports the EP06 runtime helpers it references", async () => {
      const contract = await createContract({
        "main.stele": [
          "(invariant SMOKE",
          "  (severity high)",
          '  (description "smoke")',
          "  (assert (eq 1 1)))",
          "(class-shape demo",
          "  (lang python)",
          '  (target "app/account.py::Account")',
          "  (must-have-method save))",
        ].join("\n"),
      });
      const file = getGeneratedCodeShapeFile(contract);

      expect(file.startsWith("import inspect\nimport pytest\nfrom ._stele_runtime import")).toBe(true);
      expect(file).toContain("stele_resolve_class");
      expect(file).toContain("stele_has_callable");
      expect(file).toContain("stele_glob");
    });

    it("runtime helpers are present on the embedded runtime source", () => {
      const source = getRuntimeSource()();
      expect(source).toContain("def stele_resolve_class(qualified_name");
      expect(source).toContain("def stele_resolve_function(qualified_name");
      expect(source).toContain("def stele_has_field(cls, field_name");
      expect(source).toContain("def stele_has_callable(cls, method_name");
      expect(source).toContain("def stele_get_class_fields(cls):");
      expect(source).toContain("def stele_get_type_hints(obj):");
      expect(source).toContain("def stele_type_matches(actual_type, expected_name");
      expect(source).toContain("def stele_glob(pattern");
      expect(source).toContain("def stele_read_file(filepath");
      expect(source).toContain("def stele_collect_imports(filepath");
      expect(source).toContain("def stele_import_allowed(imp");
      // EP06 allowlist split: both names must coexist; the user list must
      // not gain stdlib modules like importlib (security boundary).
      expect(source).toContain("_STELE_USER_ALLOWED_MODULES = frozenset");
      expect(source).toContain("_STELE_INTERNAL_ALLOWED_MODULES = frozenset");
      expect(source).toContain("_STELE_ALLOWED_MODULES = _STELE_USER_ALLOWED_MODULES");
      expect(source).toContain("def _stele_user_module_allowed(module_name");
    });
  });

  it("translates json-path via stele_json_path runtime helper", () => {
    const translateExpression = getTranslateExpression();
    const result = translateExpression(parseExpression('(json-path (path data) "accounts[*].balance")'));
    expect(result).toBe('stele_json_path(stele_get_path(stele_context, ["data"]), "accounts[*].balance")');
  });

  it("translates decimal-eq via stele_decimal_eq runtime helper", () => {
    const translateExpression = getTranslateExpression();
    const result = translateExpression(parseExpression("(decimal-eq (path amount) 1234.56)"));
    expect(result).toBe('stele_decimal_eq(stele_get_path(stele_context, ["amount"]), 1234.56)');
  });
});

function getGeneratedCodeShapeFile(contract: Contract): string {
  const file = getGeneratePytestFiles()(contract).find((entry) => entry.path === "tests/contract/test_code_shape.py");

  expect(file?.content).toBeTypeOf("string");

  return file!.content;
}

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
  return (contract) => [
    ...(backendPython.backend.supportFiles?.(contract, { projectRoot: "." }) ?? []),
    ...backendPython.backend.generate(contract, { projectRoot: "." }),
  ];
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
