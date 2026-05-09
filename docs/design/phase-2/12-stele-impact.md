# EP12 详细设计：stele impact 变更影响分析

> PRD: [prd-phase-2.md §4](../../prd-phase-2.md) | 估算: 1 周 | 类别: CLI 扩展

## 1. 目标

让用户在编辑前/PR 评审中识别"哪些 invariant 会受影响"。**仅确定性匹配**（无 AI、无 AST diff），仅 3 个维度：direct / uncovered / orphan。`indirect` v1.0 提议被 v2.0 删除（依赖 `depends-on` 字段，用户填写率低）。

## 2. 命令

```bash
stele impact
stele impact --diff-from main
stele impact --json
```

## 3. 算法

### 3.1 输入

- 当前工作区 vs `--diff-from`（默认 HEAD~）的 `git diff` 文件列表
- 当前 contract（`loadContract` 加载的所有 invariant）
- 每个 invariant 的 `applies-to` 字段（可选；当前是文本节点）

### 3.2 流程

```typescript
// packages/cli/src/commands/impact.ts
async function runImpact(opts: ImpactOpts): Promise<void> {
  const projectRoot = process.cwd();
  const config = await loadConfig(projectRoot);
  const diffFrom = opts.diffFrom ?? "HEAD~";

  // 1. git diff
  const changedFiles = await getChangedFiles(diffFrom, projectRoot);
  // 含 staged / unstaged / untracked

  // 2. 加载契约
  const contract = await loadContract(config.entry, projectRoot);

  // 3. 直接影响：applies-to 与 changed file 匹配
  // 字段名与 cli-output.md §4.3 一致：rule_id（不是 invariant_id），generated_at（不是 timestamp）
  const directImpacts: AffectedInvariant[] = [];
  for (const inv of contract.invariants) {
    if (!inv.appliesTo) continue;
    const matched = changedFiles.filter((f) => matchesAppliesTo(f, inv.appliesTo));
    if (matched.length > 0) {
      directImpacts.push({
        rule_id: inv.id,
        matched_files: matched,
        applies_to: inv.appliesTo,
        recommendation: "review",
      });
    }
  }

  // 4. 未覆盖：changed file 未被任何 invariant 的 applies-to 覆盖
  const uncoveredChanges: UncoveredChange[] = [];
  for (const f of changedFiles) {
    const covered = contract.invariants.some(
      (inv) => inv.appliesTo && matchesAppliesTo(f, inv.appliesTo)
    );
    if (!covered) {
      uncoveredChanges.push({
        file: f,
        matched_by_no_applies_to: true,
        recommendation: "consider-adding-invariant",
      });
    }
  }

  // 5. 孤儿：applies-to 引用的文件已删除
  const orphanInvariants: OrphanInvariant[] = [];
  for (const inv of contract.invariants) {
    if (!inv.appliesTo) continue;
    if (!await fileOrPatternExists(inv.appliesTo, projectRoot)) {
      orphanInvariants.push({
        rule_id: inv.id,
        applies_to: inv.appliesTo,
        reason: "applies-to file does not exist",
        recommendation: "consider-removing",
      });
    }
  }

  // 6. 输出
  const report: ImpactReport = {
    schema_version: "1",
    tool: "@stele/cli",
    command: "impact",
    diff_from: diffFrom,
    head_ref: await getHeadRef(),
    generated_at: new Date().toISOString(),
    changed_files: changedFiles,
    affected_invariants: directImpacts,
    uncovered_changes: uncoveredChanges,
    orphan_invariants: orphanInvariants,
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report);
  }
}
```

### 3.3 git diff 实现

```typescript
async function getChangedFiles(diffFrom: string, cwd: string): Promise<string[]> {
  // 浅克隆检测（GitHub Actions 默认 fetch-depth=1）
  const { stdout: shallowOut } = await runGit(["rev-parse", "--is-shallow-repository"], cwd);
  if (shallowOut.trim() === "true") {
    throw new SteleError(
      "E_SHALLOW_REPOSITORY",
      "ImpactError",
      `Repository is shallow-cloned; cannot diff from ${diffFrom}.`,
      undefined, undefined,
      "Set actions/checkout `fetch-depth: 0` (full clone) before running stele impact."
    );
  }

  const { stdout: diffOut } = await runGit(["diff", "--name-only", diffFrom, "HEAD"], cwd);
  const { stdout: stagedOut } = await runGit(["diff", "--cached", "--name-only"], cwd);
  const { stdout: unstagedOut } = await runGit(["diff", "--name-only"], cwd);
  const { stdout: untrackedOut } = await runGit(["ls-files", "--others", "--exclude-standard"], cwd);

  const files = new Set<string>();
  for (const out of [diffOut, stagedOut, unstagedOut, untrackedOut]) {
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) files.add(trimmed);
    }
  }
  return Array.from(files).sort();
}
```

### 3.4 applies-to 匹配

`applies-to` 字段当前是单个 value 节点（可能是 string 或 atom）。匹配逻辑（v0.2 修正：Windows 路径处理）：

```typescript
function matchesAppliesTo(filePath: string, appliesTo: string): boolean {
  // 规则：
  // 1. 完全字面匹配
  // 2. minimatch glob 匹配
  // 3. 前缀匹配（含 file:symbol 形式，如 "ledger/account.py:Account.balance"）
  //    Windows 路径含 `C:\...` 也含冒号；区分依据：split-on-last-colon 后，
  //    若后缀符合 identifier 形状（`/^[A-Za-z_][\w.]*$/`）则视为 file:symbol；否则全字符串视为 file
  const filePart = extractFilePart(appliesTo);

  if (filePart === filePath) return true;
  if (minimatch(filePath, filePart, { dot: true })) return true;
  return false;
}

function extractFilePart(appliesTo: string): string {
  const colonIdx = appliesTo.lastIndexOf(":");
  if (colonIdx <= 0) return appliesTo;
  const suffix = appliesTo.slice(colonIdx + 1);
  // 后缀必须是 identifier 形（含点）才视为 file:symbol
  if (/^[A-Za-z_][\w.]*$/.test(suffix)) {
    return appliesTo.slice(0, colonIdx);
  }
  return appliesTo;  // Windows path 或不规范形式 → 全字符串视为 file
}
```

注意：

- v0.2 **不**支持 `applies-to` 中的符号级匹配（如 `Account.balance` 后缀）作为变更影响判定依据
- 仅 file-level 匹配；这是边界，文档化在 [`docs/spec/cdl.md`](../../spec/cdl.md) "applies-to semantics" 节

### 3.5 fileOrPatternExists（orphan 检测）

```typescript
async function fileOrPatternExists(appliesTo: string, projectRoot: string): Promise<boolean> {
  const filePart = extractFilePart(appliesTo);  // 同 §3.4

  // 直接文件
  try {
    await fs.access(join(projectRoot, filePart));
    return true;
  } catch {
    // not a literal file; try as glob via minimatch + git ls-files
  }

  // 用 git ls-files 列出**所有** tracked 文件，然后 JS 端 minimatch 过滤
  // （不直接传 pattern 给 git ls-files，避免 git pathspec ≠ minimatch 的 glob 语义差异）
  const { stdout } = await runGit(["ls-files", "--full-name"], projectRoot);
  const allFiles = stdout.trim().split("\n").filter(Boolean);
  return allFiles.some((f) => minimatch(f, filePart, { dot: true }));
}
```

## 4. 输出格式

### 4.1 人类可读

```
Stele Impact Analysis
diff from: main
head:      feature/balance-refactor

Changed files: 5
  ledger/account.py
  ledger/transaction.py
  api/routes/accounts.py
  tests/api/test_accounts.py
  README.md

Direct impacts (2):
  BALANCE_NON_NEGATIVE
    applies-to: ledger/account.py
    matched: ledger/account.py
    → Recommendation: review

  ACCOUNT_HAS_OWNER
    applies-to: ledger/account.py:Account
    matched: ledger/account.py
    → Recommendation: review

Uncovered changes (3):
  ledger/transaction.py
  api/routes/accounts.py
  tests/api/test_accounts.py
  → Recommendation: consider adding invariants

Orphan invariants (0):
  (none)

Total: 2 direct, 3 uncovered, 0 orphan.
```

### 4.2 JSON

参见 [`docs/spec/cli-output.md` § 4](../../spec/cli-output.md)：

```json
{
  "schema_version": "1",
  "tool": "@stele/cli",
  "command": "impact",
  "diff_from": "main",
  "head_ref": "feature/balance-refactor",
  "generated_at": "2026-05-08T10:00:00Z",
  "changed_files": ["ledger/account.py", "ledger/transaction.py"],
  "affected_invariants": [
    {
      "rule_id": "BALANCE_NON_NEGATIVE",
      "matched_files": ["ledger/account.py"],
      "applies_to": "ledger/account.py",
      "recommendation": "review"
    }
  ],
  "uncovered_changes": [
    {
      "file": "ledger/transaction.py",
      "matched_by_no_applies_to": true,
      "recommendation": "consider-adding-invariant"
    }
  ],
  "orphan_invariants": []
}
```

**显式不含**：`indirect_impacts` 字段（v2.0 删除）。

## 5. CI 集成

EP02 GitHub Action 加 `mode: impact`：

```typescript
// packages/github-action/src/modes/impact.ts (新增)
export async function runImpact() {
  const result = await spawnCli(["impact", "--diff-from", core.getInput("diff-from"), "--json"]);
  if (result.exitCode !== 0) { core.setFailed(/* ... */); return; }
  const report: ImpactReport = JSON.parse(result.stdout);
  if (core.getBooleanInput("pr-comment")) {
    await upsertImpactPrComment(report);  // 与 check 评论分开（不同 marker）
  }
}
```

PR comment marker `<!-- stele-impact:v1 -->`，避免与 check 评论冲突。

## 6. 性能

`stele impact` 在 100+ 变更文件场景 < 5s。瓶颈是 `git diff`（不可控）+ minimatch（可控）。

可选优化：

- 把所有 invariant 的 applies-to glob 编译为单个组合 regex
- minimatch 缓存

## 7. 测试

```typescript
describe("stele impact", () => {
  describe("direct impacts", () => {
    it("matches literal file path", async () => { /* ... */ });
    it("matches glob applies-to", async () => { /* ... */ });
    it("handles applies-to with symbol part", async () => {
      // applies-to: "ledger/account.py:Account.balance"
      // changed: "ledger/account.py"
      // → matches (取冒号前)
    });
  });
  describe("uncovered changes", () => {
    it("flags files with no covering invariant", async () => { /* ... */ });
    it("ignores changed .stele files", async () => {
      // 用户改 contract/main.stele 不视为 uncovered
    });
  });
  describe("orphan invariants", () => {
    it("detects applies-to file deleted", async () => { /* ... */ });
    it("detects applies-to glob with zero matches", async () => { /* ... */ });
  });
  describe("not in v0.2 scope", () => {
    it("does NOT emit indirect_impacts field", async () => {
      const report = await runImpactJson();
      expect(report).not.toHaveProperty("indirect_impacts");
    });
    it("does NOT call any AI service", async () => {
      // 不存在 fetch / OpenAI / Anthropic 调用
    });
  });
});
```

## 8. 文档

`docs/guides/stele-impact.md`：

- 何时用 `stele impact`（编辑前；PR 评审中）
- 与 `stele check` 区别表
- `applies-to` 字段最佳实践

## 9. 估算分解

| 工作 | 估算 |
|---|---|
| `runImpact` 主流程 | 1 天 |
| git diff + getChangedFiles | 0.5 天 |
| matchesAppliesTo（含 symbol part 处理）| 0.5 天 |
| orphan 检测 | 0.5 天 |
| 人类输出 + JSON 输出 | 0.5 天 |
| GitHub Action `mode: impact` | 1 天 |
| 测试 + 边界 | 1 天 |
| 文档 | 0.5 天 |
| **合计** | **5.5 天 ≈ 1 周（1 FTE）/ 0.5-0.7 周（2 FTE）**|

## 10. 验收标准（来自 PRD §4.4）

- [ ] `stele impact` 在 examples/finance-guard 上正确识别直接影响
- [ ] orphan invariant 检测准确（人造 fixture：删除一个 applies-to 引用的文件）
- [ ] uncovered changes 准确（人造 fixture：变更一个无 applies-to 覆盖的文件）
- [ ] **不存在** indirect impact 输出字段（v2.0 删除）
- [ ] `--json` 输出 schema 文档化在 `docs/spec/cli-output.md`
- [ ] **不**调用任何外部服务（AI、网络）；离线可用
- [ ] 大变更（100+ files）分析时间 < 5s
