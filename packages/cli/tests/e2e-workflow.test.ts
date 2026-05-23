import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";

const execFileAsync = promisify(execFile);
const STELE = join(__dirname, "..", "dist", "index.js");

describe("e2e workflow", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(os.tmpdir(), "stele-e2e-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
    try {
      const result = await execFileAsync(process.execPath, [STELE, ...args], { cwd: tmpDir, timeout: 30000 });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (error: any) {
      return {
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
        code: error.status ?? 1,
      };
    }
  }

  async function fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  async function createContract(content: string): Promise<void> {
    await mkdir(join(tmpDir, "contract"), { recursive: true });
    await writeFile(join(tmpDir, "contract", "main.stele"), content, "utf8");
  }

  it("full init workflow", async () => {
    const init = await run(["init"]);
    expect(init.code).toBe(0);
    expect(await fileExists(join(tmpDir, "stele.config.json"))).toBe(true);
    expect(await fileExists(join(tmpDir, "contract", "main.stele"))).toBe(true);
    expect(await fileExists(join(tmpDir, "tests", "contract", "conftest.py"))).toBe(true);
  });

  it("init dry-run does not create files", async () => {
    const dryRun = await run(["init", "--dry-run"]);
    expect(dryRun.code).toBe(0);
    expect(dryRun.stdout).toContain("Dry run");
    expect(await fileExists(join(tmpDir, "stele.config.json"))).toBe(false);
  });

  it("init is idempotent (existing files not overwritten)", async () => {
    await run(["init"]);
    const before = await readFile(join(tmpDir, "contract", "main.stele"), "utf8");
    await run(["init"]);
    const after = await readFile(join(tmpDir, "contract", "main.stele"), "utf8");
    expect(before).toBe(after);
  });

  it("full workflow: init → contract → generate → lock → check", async () => {
    // Init
    await run(["init"]);
    expect(await fileExists(join(tmpDir, "stele.config.json"))).toBe(true);

    // Create contract with all operator types
    await createContract(`(invariant TEST_001
  (severity high)
  (description "Balance must be non-negative.")
  (assert (gte (path account balance) 0)))

(invariant TEST_002
  (severity critical)
  (description "Account must have a non-null identifier.")
  (assert (not-null (path account id))))

(invariant TEST_003
  (severity medium)
  (description "Balance must be between 0 and 100000.")
  (assert (between (path account balance) 0 100000)))

(invariant TEST_004
  (severity medium)
  (description "Approximate equality for floating-point values.")
  (assert (approx-eq (path account total_equity) (path account positions_plus_cash) 0.01)))

(invariant TEST_005
  (severity high)
  (description "Status must contain active.")
  (assert (contains (path account status) "active")))

(invariant TEST_006
  (severity medium)
  (description "Transactions must not be empty.")
  (assert (not (is-empty (collection transactions)))))

(invariant TEST_007
  (severity low)
  (description "Status must start with uppercase A.")
  (assert (starts-with (path account status) "A")))

(invariant TEST_008
  (severity low)
  (description "Currency must end with D.")
  (assert (ends-with (path account currency) "D")))

(invariant TEST_009
  (severity medium)
  (description "Must have at least 3 transactions.")
  (assert (has-length (collection transactions) 3)))`);

    // List invariants
    const list = await run(["list", "--format", "json"]);
    expect(list.code).toBe(0);
    const listResult = JSON.parse(list.stdout);
    expect(listResult.length).toBeGreaterThan(0);
    expect(listResult.some((inv: any) => inv.id === "TEST_001")).toBe(true);

    // Generate tests
    const gen = await run(["generate", "--force"]);
    expect(gen.code).toBe(0);
    expect(await fileExists(join(tmpDir, "tests", "contract", "test_contract.py"))).toBe(true);

    // Verify generated test content for new operators
    const testContent = await readFile(join(tmpDir, "tests", "contract", "test_contract.py"), "utf8");
    // Test names preserve case from invariant IDs: TEST_001 → test_TEST_001
    expect(testContent).toContain("test_TEST_001");
    expect(testContent).toContain("0 <="); // between operator
    expect(testContent).toContain("abs("); // approx-eq operator
    expect(testContent).toContain("startswith"); // starts-with operator
    expect(testContent).toContain("endswith"); // ends-with operator

    // Lock manifest
    const lock = await run(["lock", "--reason", "e2e test"]);
    expect(lock.code).toBe(0);
    expect(await fileExists(join(tmpDir, "contract", ".manifest.json"))).toBe(true);

    // Check
    const check = await run(["check", "--lenient"]);
    expect(check.code).toBe(0);
    expect(check.stdout).toContain("checked");
  });

  it("explain command works", async () => {
    await run(["init"]);
    await createContract(`(invariant EXPLAIN_ME
  (severity high)
  (description "Test explanation invariant.")
  (assert (eq 1 1)))`);
    const explain = await run(["explain", "EXPLAIN_ME"]);
    expect(explain.code).toBe(0);
    expect(explain.stdout).toContain("EXPLAIN_ME");
    expect(explain.stdout).toContain("Test explanation invariant.");
  });

  it("rules command lists all invariants", async () => {
    await run(["init"]);
    await createContract(`(invariant RULE_001
  (severity high)
  (description "Test rule.")
  (assert (eq 1 1)))`);
    const rules = await run(["rules"]);
    expect(rules.code).toBe(0);
    expect(rules.stdout).toContain("RULE_001");
  });

  it("doc command generates markdown", async () => {
    await run(["init"]);
    await createContract(`(invariant DOC_001
  (severity high)
  (description "Test documentation.")
  (assert (eq 1 1)))`);
    const doc = await run(["doc", "--format", "markdown"]);
    expect(doc.code).toBe(0);
    // Doc writes to docs/contract/contract.md by default
    const docPath = join(tmpDir, "docs", "contract", "contract.md");
    expect(await fileExists(docPath)).toBe(true);
    const content = await readFile(docPath, "utf8");
    expect(content).toContain("DOC_001");
  });

  it("agent-context command produces JSON", async () => {
    await run(["init"]);
    await createContract(`(invariant AGENT_001
  (severity high)
  (description "Test agent context.")
  (assert (eq 1 1)))`);
    const ctx = await run(["agent-context", "--json"]);
    expect(ctx.code).toBe(0);
    const parsed = JSON.parse(ctx.stdout);
    expect(parsed.policy).toBeDefined();
    expect(parsed.relevant_rules).toBeDefined();
  });

  it("list filters work correctly", async () => {
    await run(["init"]);
    await createContract(`(invariant SEV_CRITICAL
  (severity critical)
  (description "Critical invariant.")
  (assert (eq 1 1)))

(invariant SEV_HIGH
  (severity high)
  (description "High invariant.")
  (assert (eq 1 1)))

(invariant SEV_MEDIUM
  (severity medium)
  (description "Medium invariant.")
  (assert (eq 1 1)))`);
    const filtered = await run(["list", "--severity", "critical", "--format", "json"]);
    expect(filtered.code).toBe(0);
    const results = JSON.parse(filtered.stdout);
    for (const inv of results) {
      expect(inv.severity).toBe("critical");
    }
  });

  it("generated test contains new operators", async () => {
    await run(["init"]);
    await createContract(`(invariant OP_BETWEEN
  (severity high)
  (description "Between operator test.")
  (assert (between (path account balance) 0 100000)))

(invariant OP_APPROX
  (severity medium)
  (description "Approx-eq operator test.")
  (assert (approx-eq (path account balance) 100 0.01)))

(invariant OP_CONTAINS
  (severity high)
  (description "Contains operator test.")
  (assert (contains (path account status) "active")))

(invariant OP_ISEMPTY
  (severity critical)
  (description "Is-empty operator test.")
  (assert (not (is-empty (collection transactions)))))

(invariant OP_STARTSWITH
  (severity low)
  (description "Starts-with operator test.")
  (assert (starts-with (path account status) "A")))

(invariant OP_ENDSWITH
  (severity low)
  (description "Ends-with operator test.")
  (assert (ends-with (path account currency) "D")))

(invariant OP_HASLENGTH
  (severity medium)
  (description "Has-length operator test.")
  (assert (has-length (collection transactions) 3)))`);
    await run(["generate", "--force"]);
    const content = await readFile(join(tmpDir, "tests", "contract", "test_contract.py"), "utf8");

    // Verify each operator generated correct Python code
    expect(content).toContain("0 <="); // between
    expect(content).toContain("abs("); // approx-eq
    expect(content).toContain("in "); // contains
    expect(content).toContain("startswith"); // starts-with
    expect(content).toContain("endswith"); // ends-with
    expect(content).toContain("== 0"); // is-empty
    expect(content).toContain("=="); // has-length
  });
});
