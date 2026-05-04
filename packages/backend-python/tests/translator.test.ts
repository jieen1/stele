import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadContract, parseFile, SteleError, type AstNode, type Contract } from "@stele/core";
import * as backendPython from "../src/index";

const tempDirs: string[] = [];

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
      "from ._stele_runtime import stele_call_checker, stele_get_path, stele_sum",
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
      "        stele_get_path(txn, [\"amount\"]) > 0",
      "        for txn in stele_context[\"transactions\"]",
      "    )",
      "",
    ].join("\n"));
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
      "all(stele_get_path(txn, [\"amount\"]) > 0 for txn in stele_context[\"transactions\"])",
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
