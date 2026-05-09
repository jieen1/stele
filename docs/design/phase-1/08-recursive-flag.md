# EP08 详细设计：多项目 --recursive 标志

> PRD: [prd-phase-1.md §9](../../prd-phase-1.md) | 估算: 3-5 天 | 类别: CLI 扩展

## 1. 目标

让 monorepo 用户在仓库根一次性扫描所有子项目，**不**引入新文件格式（`stele.workspace.json` 延后到 Phase 3）。每个子项目仍独立维护 `stele.config.json` + `contract/.manifest.json`。

## 2. 命令扩展

`packages/cli/src/index.ts` 中三个命令加 `--recursive` 标志：

```typescript
program.command("check")
  .option("--recursive", "Auto-discover all stele.config.json under cwd and check each", false)
  .option("--diff-from <ref>", "...")
  // 现有 ...
  .action(async (opts) => {
    if (opts.recursive) {
      await runCheckRecursive(opts);
    } else {
      await runCheckSingle(opts);
    }
  });
```

同样改 `generate`、`lock`：

```bash
stele check --recursive
stele generate --recursive
stele lock --recursive --reason "..."
```

## 3. 项目发现

`packages/cli/src/recursive-discovery.ts`（新增）：

```typescript
import { promises as fs } from "node:fs";
import { join } from "node:path";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  ".pnpm-store",
  ".npm",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache",
]);

export async function discoverProjects(rootDir: string): Promise<string[]> {
  const projects: string[] = [];
  await walk(rootDir, projects);
  return projects.sort(); // 字典序保证 deterministic
}

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  // 检查当前目录是否含 stele.config.json
  if (entries.some((e) => e.isFile() && e.name === "stele.config.json")) {
    out.push(dir);
    // 找到后**不再**深入：嵌套项目不允许（避免歧义）
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
      await walk(join(dir, entry.name), out);
    }
  }
}
```

**禁止嵌套项目**：在某子目录找到 `stele.config.json` 后不再深入。如用户结构是 `apps/api/stele.config.json` + `apps/api/internal/stele.config.json`，仅 `apps/api/` 被发现。这避免父项目 manifest 与子项目 manifest 互相干涉的歧义。

## 4. 执行流程

```typescript
// packages/cli/src/commands/check.ts
async function runCheckRecursive(opts: CheckOpts): Promise<void> {
  const cwd = process.cwd();
  const projects = await discoverProjects(cwd);

  if (projects.length === 0) {
    throw new SteleError(
      "E_NO_PROJECTS_FOUND",
      "RecursiveError",
      `No stele.config.json found under ${cwd}. Run 'stele init' in a sub-directory first.`,
    );
  }

  console.log(`Found ${projects.length} project${projects.length > 1 ? "s" : ""}:`);
  for (let i = 0; i < projects.length; i++) {
    console.log(`  [${i + 1}/${projects.length}] ${projects[i]}`);
  }
  console.log("");

  let maxExitCode = 0;
  const subReports: SubReport[] = [];

  for (let i = 0; i < projects.length; i++) {
    const project = projects[i];
    console.log(`[${i + 1}/${projects.length}] checking ${project}`);

    const subOpts = { ...opts, recursive: false };
    const result = await runCheckSingleQuiet(project, subOpts);

    subReports.push({
      project,
      exitCode: result.exitCode,
      summary: result.summary,
    });

    if (result.exitCode > maxExitCode) maxExitCode = result.exitCode;

    const status = result.exitCode === 0 ? "✓ passed" : `✗ failed (exit ${result.exitCode})`;
    console.log(`  ${status} (${result.summary.violations} violations)`);
    console.log("");
  }

  // 输出 summary
  const passed = subReports.filter((r) => r.exitCode === 0).length;
  const failed = subReports.length - passed;
  console.log(`Summary: ${passed}/${subReports.length} passed; ${failed}/${subReports.length} failed.`);

  // JSON 输出（如 --json）
  if (opts.json) {
    process.stdout.write(JSON.stringify({
      schema_version: "1",
      timestamp: new Date().toISOString(),
      projects: subReports,
    }, null, 2));
  }

  process.exit(maxExitCode);
}
```

## 5. 退出码

优先级规则（v0.2 修正）：**任一 project exit 1 → 总 exit 1**（保留错误信号）；否则取剩余 project 退出码的最大值。理由：1 = 内部错误（解析失败、I/O）；2/3 = 数据漂移（recoverable）。把 1 隐藏在 2/3 后会让 CI 误以为问题是"运行时漂移"。

| 情况 | 总退出码 |
|---|---|
| 全部 project 成功 | 0 |
| 任一 project exit 1（错误） | 1 |
| 否则 + 任一 exit 2/3 | max(2, 3) of remaining |
| 没找到任何 project | 1（E_NO_PROJECTS_FOUND） |

伪代码：

```typescript
const failedOnes = subReports.filter((r) => r.exit_code === 1);
const driftOnes = subReports.filter((r) => r.exit_code === 2 || r.exit_code === 3);
let total = 0;
if (failedOnes.length > 0) total = 1;
else if (driftOnes.length > 0) total = Math.max(...driftOnes.map((r) => r.exit_code));
process.exit(total);
```

## 6. Backend 注册表交互

各 project 的 `targetLanguage` 可不同（Python + TS 共存）。每次执行 sub-check 时：

```typescript
async function runCheckSingleQuiet(projectDir: string, opts: CheckOpts) {
  const config = await loadConfig(projectDir);  // 各 project 独立加载
  const backend = await loadBackend(config.targetLanguage, config.testFramework);
  // backend 可能在 project A (python) 和 project B (typescript) 之间切换
  // loadBackend 是无状态工厂；ESM import 缓存自动复用
  // ...
}
```

## 7. 输出格式

### 7.1 Console（人类可读）

```
Found 3 projects:
  [1/3] /repo/packages/core
  [2/3] /repo/packages/api
  [3/3] /repo/apps/web

[1/3] checking /repo/packages/core
  ✓ passed (12 invariants, 0 violations)

[2/3] checking /repo/packages/api
  ✗ failed (exit 2): 2 violations
    BALANCE_NON_NEGATIVE (error) at ledger/account.py:42
    TRANSACTION_SUM_MATCHES (error) at ledger/transaction.py:18

[3/3] checking /repo/apps/web
  ✓ passed (5 invariants, 0 violations)

Summary: 2/3 passed; 1/3 failed.
```

### 7.2 JSON（CI 集成）

参见 [`docs/spec/cli-output.md` §4.4](../../spec/cli-output.md)。字段名：`generated_at`（不是 `timestamp`）；violation 内部用真实 schema（`rule_id`、`location.path`、`cause.summary`）。

```json
{
  "schema_version": "1",
  "tool": "@stele/cli",
  "command": "check",
  "generated_at": "2026-05-08T10:00:00Z",
  "cwd": "/repo",
  "projects": [
    {
      "project": "/repo/packages/core",
      "exit_code": 0,
      "summary": { "invariant_count": 12, "violation_count": 0 }
    },
    {
      "project": "/repo/packages/api",
      "exit_code": 2,
      "summary": { "invariant_count": 8, "violation_count": 2 },
      "violations": [
        { "rule_id": "BALANCE_NON_NEGATIVE", "rule_kind": "invariant", "severity": "error", "cause": { "summary": "..." }, /* ... */ }
      ]
    },
    {
      "project": "/repo/apps/web",
      "exit_code": 0,
      "summary": { "invariants": 5, "violations": 0, "by_severity": {} }
    }
  ],
  "max_exit_code": 2,
  "passed": 2,
  "failed": 1
}
```

schema 文档在 `docs/spec/cli-output.md` § 5。

## 8. lock 命令的特殊处理

`stele lock --recursive --reason "..."` 对每个 project 执行 lock，**保留**单个 `--reason` 应用到所有 project 的 unlock log。如果用户想给不同 project 不同 reason，建议手动逐个 lock；不引入 `--reason-per-project` 选项。

## 9. 错误处理

| 错误 | 行为 |
|---|---|
| 没找到任何 project | 退出 1，错误信息引导用户运行 `stele init` |
| 某 project loadConfig 失败 | 该 project 退出码 1；继续下一个；最终 max 取 |
| 某 project backend 加载失败 | 同上 |
| 跨 project 死循环（理论上不可能，因为 walk 不重入）| 静态防护 |

## 10. 测试

```typescript
// packages/cli/tests/recursive.test.ts
describe("stele check --recursive", () => {
  it("discovers nested stele.config.json", async () => {
    // 创建 tmpdir/packages/a/stele.config.json + tmpdir/packages/b/stele.config.json
    const projects = await discoverProjects(tmpdir);
    expect(projects).toEqual([
      join(tmpdir, "packages/a"),
      join(tmpdir, "packages/b"),
    ]);
  });

  it("does not descend into nested project", async () => {
    // tmpdir/a/stele.config.json + tmpdir/a/b/stele.config.json
    const projects = await discoverProjects(tmpdir);
    expect(projects).toEqual([join(tmpdir, "a")]);  // b 不出现
  });

  it("skips ignored dirs", async () => {
    // tmpdir/node_modules/stele.config.json 不应被发现
    const projects = await discoverProjects(tmpdir);
    expect(projects).not.toContain(join(tmpdir, "node_modules"));
  });

  it("max exit code propagation", async () => {
    // 模拟 project A exit 0, B exit 2, C exit 3
    // 期望最终 process.exit(3)
  });

  it("heterogeneous backends", async () => {
    // project A targetLanguage python, B typescript
    // 期望两个都被检查；输出有两个 sub-report
  });

  it("zero projects found", async () => {
    // 空 tmpdir → exit 1
  });
});
```

## 11. examples/monorepo-demo

新建 `examples/monorepo-demo/`：

```
examples/monorepo-demo/
  packages/
    core/
      stele.config.json (targetLanguage: python)
      contract/main.stele
      ...
    api/
      stele.config.json (targetLanguage: typescript)
      contract/main.stele
      ...
  README.md
```

`README.md` 演示：

```bash
cd examples/monorepo-demo
stele check --recursive
```

## 12. 不在范围内（Phase 3 候选）

- `stele.workspace.json` 文件格式
- 项目间 `depends-on` / 拓扑排序
- 共享 imports（`shared/contract/common.stele` 跨 project 共用）
- `--include <project>` / `--exclude <project>` 过滤
- `stele init --workspace` （没有 workspace 文件就不需要 init）

## 13. 验收标准（来自 PRD §9.3）

- [ ] `stele check --recursive` 在 `examples/monorepo-demo` 三项目环境正确发现并执行
- [ ] 项目间 `targetLanguage` 异构（Python + TypeScript 共存）正确装载各自 backend
- [ ] 退出码：全部成功 0；任一失败时取最大错误码
- [ ] `--json` 输出含 per-project 子报告
- [ ] `--recursive` 跳过 `.git/`、`node_modules/`、`.venv/` 等忽略目录
- [ ] **不存在** `stele.workspace.json` 解析逻辑
- [ ] 单项目用法（无 `--recursive`）行为与 v0.1 完全一致
- [ ] `docs/guides/monorepo.md` 文档
