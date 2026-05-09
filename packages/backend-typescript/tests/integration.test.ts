import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { coordinateGeneration, loadContract, type Contract } from "@stele/core";
import backend from "../src/backend.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "..", "..", "..");
const TSC_BIN = resolve(REPO_ROOT, "node_modules", ".bin", "tsc");
const REPO_NODE_MODULES = resolve(REPO_ROOT, "node_modules");

describe("@stele/backend-typescript integration", () => {
  afterEach(async () => {
    await Promise.allSettled(
      tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("emits the canonical layout (runtime + test_contract.ts) from a multi-operator contract that typechecks under tsc --strict", async () => {
    const contract = await createContract({
      "main.stele": [
        "(invariant ACCT_BAL",
        "  (severity high)",
        '  (description "balance must be positive")',
        "  (assert (gt (path account balance) 0)))",
        "(invariant ACCT_RANGE",
        "  (severity high)",
        '  (description "balance is within bounds")',
        "  (assert (and (gte (path account balance) 0) (lte (path account balance) 1000))))",
        "(invariant ACCT_OR",
        "  (severity high)",
        '  (description "or with negation")',
        "  (assert (or (eq (path account status) \"active\") (not (neq (path account balance) 0)))))",
        "(invariant ACCT_NULL",
        "  (severity low)",
        '  (description "explicit null comparison")',
        "  (assert (eq (path account label) null)))",
      ].join("\n"),
    });

    const projectRoot = await prepareProject("stele-ts-integration-");

    const files = coordinateGeneration(contract, backend, {
      projectRoot,
      outputDir: "tests/contract",
    });

    const filePaths = files.map((file) => file.path).sort();
    expect(filePaths).toEqual([
      "tests/contract/_stele_runtime.ts",
      "tests/contract/_stele_setup.ts",
      "tests/contract/test_contract.ts",
    ]);

    await materializeFiles(projectRoot, files);
    await writeFile(
      join(projectRoot, "tests", "contract", "conftest.ts"),
      [
        'import type { SteleContext } from "./_stele_runtime.js";',
        "",
        "export const steleContext: SteleContext = {",
        '  account: { balance: 100, status: "active", label: null },',
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    await runTsc(projectRoot);
  });

  it("emits Phase B operators (arithmetic / aggregate / string / control) that typecheck under tsc --strict", async () => {
    const contract = await createContract({
      "main.stele": [
        "(invariant ACCT_BAL_RANGE",
        "  (severity high)",
        '  (description "balance is within an inclusive range")',
        "  (assert (between (path account balance) 0 1000)))",
        "(invariant ACCT_NAME_NOT_NULL",
        "  (severity medium)",
        '  (description "account name is not null")',
        "  (assert (not-null (path account name))))",
        "(invariant ACCT_NAME_PREFIXED",
        "  (severity low)",
        '  (description "name starts with Mr or Ms")',
        "  (assert (or (starts-with (path account name) \"Mr.\") (starts-with (path account name) \"Ms.\"))))",
        "(invariant ACCT_NAME_PATTERN",
        "  (severity low)",
        '  (description "name matches a basic pattern")',
        "  (assert (matches (path account name) \"[A-Z]\")))",
        "(invariant TXN_ITEMS_NONEMPTY",
        "  (severity high)",
        '  (description "items are not empty")',
        "  (assert (not (is-empty (collection items)))))",
        "(invariant TXN_ITEM_COUNT",
        "  (severity medium)",
        '  (description "items has the expected length")',
        "  (assert (has-length (collection items) 2)))",
        "(invariant TXN_TOTAL",
        "  (severity high)",
        '  (description "sum equals 30 within tolerance")',
        "  (assert (approx-eq (sum (collection items) (path price)) 30 1e-9)))",
        "(invariant TXN_AVG_RANGE",
        "  (severity medium)",
        '  (description "average is within range")',
        "  (assert (and (gte (avg (collection items) (path price)) 0) (lte (avg (collection items) (path price)) 100))))",
        "(invariant TXN_MIN_MAX",
        "  (severity medium)",
        '  (description "min and max bracket the sum")',
        "  (assert (lte (min (collection items) (path price)) (max (collection items) (path price)))))",
        "(invariant TXN_DISTINCT",
        "  (severity medium)",
        '  (description "ids are unique")',
        "  (assert (unique (collection items) (path id))))",
        "(invariant TXN_FEE",
        "  (severity medium)",
        '  (description "absolute fee equals 5 plus 5 minus 5")',
        "  (assert (eq (abs (neg (path account fee))) (sub (add 5 5) 5))))",
        "(invariant TXN_DOUBLED",
        "  (severity medium)",
        '  (description "doubled fee equals 10")',
        "  (assert (eq (mul (path account fee) 2) (div 20 2))))",
        "(invariant TXN_FEE_IF",
        "  (severity low)",
        '  (description "if-then-else mirrors the fee")',
        "  (assert (eq (if (gt (path account fee) 0) (path account fee) (neg (path account fee))) 5)))",
        "(invariant TXN_IMPLIES",
        "  (severity low)",
        '  (description "logical equivalence and implication evaluate")',
        "  (assert (and (implies (gt (path account fee) 0) (not-null (path account name))) (iff (gt (path account fee) 0) (not (eq (path account fee) 0))))))",
        "(invariant TXN_WHEN",
        "  (severity low)",
        '  (description "lazy implication via when")',
        "  (assert (when (gt (path account fee) 0) (gt (count (collection items)) 0))))",
        "(invariant TXN_CONTAINS",
        "  (severity low)",
        '  (description "name contains uppercase letter substring")',
        "  (assert (and (contains (path account name) \"Mr.\") (ends-with (path account name) \"Smith\"))))",
        "(invariant TXN_EXISTS_IN",
        "  (severity low)",
        '  (description "fee tier id exists in the recognized tier list")',
        "  (assert (exists-in (path account tier) (collection valid-tiers))))",
      ].join("\n"),
    });

    const projectRoot = await prepareProject("stele-ts-integration-phase-b-");

    const files = coordinateGeneration(contract, backend, {
      projectRoot,
      outputDir: "tests/contract",
    });

    await materializeFiles(projectRoot, files);
    await writeFile(
      join(projectRoot, "tests", "contract", "conftest.ts"),
      [
        'import type { SteleContext } from "./_stele_runtime.js";',
        "",
        "export const steleContext: SteleContext = {",
        "  account: {",
        "    balance: 100,",
        '    name: "Mr. Smith",',
        '    tier: "gold",',
        "    fee: 5,",
        "  },",
        "  items: [",
        '    { id: "a", price: 10 },',
        '    { id: "b", price: 20 },',
        "  ],",
        '  "valid-tiers": ["bronze", "silver", "gold"],',
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    await runTsc(projectRoot);
  });

  it("emits Phase C operators (forall / exists / temporal / scenario / checker / when) that typecheck under tsc --strict", async () => {
    const contract = await createContract({
      "main.stele": [
        "(checker balance-change-has-transaction",
        '  (description "fixture checker"))',
        "(scenario fund-flow",
        "  (sandbox transactional)",
        "  (executor python-import)",
        "  (step setup",
        '    (call "tests.contract_scenarios:open"',
        '      (body (object (name (gen unique-name "fund")))))',
        "    (capture fund))",
        "  (capture-state pnl",
        '    (call "tests.contract_scenarios:get_pnl"',
        "      (body (object (fund-id (ref fund id)))))))",
        "(invariant ALL_BALANCES_POSITIVE",
        "  (severity high)",
        '  (description "every account has a positive balance")',
        "  (assert (forall acct (collection accounts) (gt (path acct balance) 0))))",
        "(invariant ANY_GOLD",
        "  (severity medium)",
        '  (description "at least one user is gold tier")',
        "  (assert (exists user (collection users) (eq (path user tier) \"gold\"))))",
        "(invariant NO_BAD",
        "  (severity high)",
        '  (description "no flagged users")',
        "  (assert (none user (collection users) (eq (path user flagged) true))))",
        "(invariant FILTERED_NONEMPTY",
        "  (severity medium)",
        '  (description "filtered orders cardinality > 0")',
        "  (assert (gt (count (where order (collection orders) (gt (path order amount) 0))) 0)))",
        "(invariant BALANCE_CHANGED",
        "  (severity high)",
        '  (description "balance was modified during the transaction")',
        "  (assert (modified (path account balance))))",
        "(invariant CHECKER_RULE",
        "  (severity high)",
        '  (description "checker enforces the law")',
        '  (uses-checker balance-change-has-transaction (account-id "ACC-1")))',
        "(invariant SCENARIO_RULE",
        "  (severity high)",
        '  (description "fund flow yields positive pnl")',
        "  (uses-scenario fund-flow)",
        "  (assert (gt (path pnl value) 0)))",
        "(invariant WHEN_GUARDED",
        "  (severity low)",
        '  (description "balance non-negative when account active")',
        '  (when (eq (path account status) "active"))',
        "  (assert (gte (path account balance) 0)))",
      ].join("\n"),
    });

    const projectRoot = await prepareProject("stele-ts-integration-phase-c-");

    const files = coordinateGeneration(contract, backend, {
      projectRoot,
      outputDir: "tests/contract",
    });

    await materializeFiles(projectRoot, files);
    await writeFile(
      join(projectRoot, "tests", "contract", "conftest.ts"),
      [
        'import type { SteleContext } from "./_stele_runtime.js";',
        "",
        'const beforeSnapshot = { account: { balance: 100, status: "active" } };',
        'const afterSnapshot = { account: { balance: 90, status: "active" } };',
        "",
        "export const steleContext: SteleContext = {",
        '  account: { balance: 100, status: "active" },',
        "  pnl: { value: 50 },",
        "  accounts: [{ balance: 100 }, { balance: 50 }],",
        "  users: [",
        '    { tier: "gold", flagged: false },',
        '    { tier: "silver", flagged: false },',
        "  ],",
        "  orders: [{ amount: 10 }, { amount: 0 }],",
        '  "state-before": beforeSnapshot,',
        '  "state-after": afterSnapshot,',
        "  _stele_checkers: {",
        '    "balance-change-has-transaction": (_ctx: SteleContext, _args: Record<string, unknown>) => ({ passed: true, message: null }),',
        "  },",
        "  _stele_scenario_targets: {",
        '    "tests.contract_scenarios:open": (_body: unknown, _ctx: SteleContext) => ({ id: "fund-1" }),',
        '    "tests.contract_scenarios:get_pnl": (_body: unknown, _ctx: SteleContext) => ({ value: 50 }),',
        "  },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    await runTsc(projectRoot);
  });

  it("emits per-group test files plus the canonical top-level test file that typecheck under tsc --strict", async () => {
    const contract = await createContract({
      "main.stele": [
        "(group ACCOUNT-RULES",
        '  (description "account-related invariants")',
        "  (invariant GROUP_RULE",
        "    (severity high)",
        '    (description "balance is positive")',
        "    (assert (gt (path account balance) 0))))",
        "(invariant TOP_RULE",
        "  (severity high)",
        '  (description "top-level invariant")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    });

    const projectRoot = await prepareProject("stele-ts-integration-groups-");

    const files = coordinateGeneration(contract, backend, {
      projectRoot,
      outputDir: "tests/contract",
    });

    const filePaths = files.map((file) => file.path).sort();
    expect(filePaths).toEqual([
      "tests/contract/_stele_runtime.ts",
      "tests/contract/_stele_setup.ts",
      "tests/contract/test_ACCOUNT_RULES.ts",
      "tests/contract/test_contract.ts",
    ]);

    await materializeFiles(projectRoot, files);
    await writeFile(
      join(projectRoot, "tests", "contract", "conftest.ts"),
      [
        'import type { SteleContext } from "./_stele_runtime.js";',
        "",
        "export const steleContext: SteleContext = {",
        "  account: { balance: 100 },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    await runTsc(projectRoot);
  });
});

async function createContract(files: Record<string, string>): Promise<Contract> {
  const directory = await mkdtemp(join(tmpdir(), "stele-backend-typescript-int-"));
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

async function prepareProject(prefix: string): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(projectRoot);
  await symlink(REPO_NODE_MODULES, join(projectRoot, "node_modules"), "dir");
  await writeFile(
    join(projectRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          skipLibCheck: true,
          forceConsistentCasingInFileNames: true,
          types: ["node"],
        },
        include: ["tests/contract/**/*.ts"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return projectRoot;
}

async function materializeFiles(projectRoot: string, files: ReadonlyArray<{ path: string; content: string }>): Promise<void> {
  for (const file of files) {
    const fullPath = join(projectRoot, file.path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, file.content, "utf8");
  }
}

async function runTsc(projectRoot: string): Promise<void> {
  await execFileAsync(TSC_BIN, ["--project", "tsconfig.json", "--noEmit", "--pretty", "false"], {
    cwd: projectRoot,
    windowsHide: true,
  });
}
