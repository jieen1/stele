# Stele Phase 2 需求文档

> 版本: 2.0 | 日期: 2026-05-08 | 状态: 已审查 (Round 1 + Round 2)
> 范围: Phase 2 平台扩张（约 8-10 周，2 FTE / 14-16 周，1 FTE）
> 前置: [Phase 1](prd-phase-1.md) 必须先完成
> 审查记录: [Round 1](internal/prd-round-1-review.md) · [Round 2](internal/prd-round-2-review.md)

---

## 目录

1. [概述](#1-概述)
2. [EP10: Go 后端](#2-ep10-go-后端)
3. [EP11: VS Code 扩展 (MVP)](#3-ep11-vs-code-扩展-mvp)
4. [EP12: stele impact 变更影响分析](#4-ep12-stele-impact-变更影响分析)
5. [EP13: CDL 操作符增强批次 2](#5-ep13-cdl-操作符增强批次-2)
6. [里程碑和依赖](#6-里程碑和依赖)
7. [验收标准](#7-验收标准)
8. [Phase 3 候选项（信息性）](#8-phase-3-候选项信息性)

---

## 1. 概述

### 1.1 目标

完成跨语言扩张与编辑器独立性。Phase 2 完成后 Stele 需具备：

- Go 语言后端
- VS Code 扩展 MVP（语法高亮 + 命令面板 + 内联诊断）
- 确定性变更影响分析（`stele impact`）
- 70 → 76 个注册操作符（69 → 75 用户面，+ 1 内部 `entries` 占位）

### 1.2 与 PRD v1.0 的差异

| v1.0 编号 / 主题 | v2.0 决定 | 理由 |
|---|---|---|
| EP09 Go 后端 | **保留**，重编号 v2.0 EP10 | 受众清晰；加显式 Phase 0 W0.3 引用 |
| EP10 VS Code 扩展 MVP | **保留**，重编号 v2.0 EP11 | 删除"publisher 在 Phase 0 W0.1 已设置"声明（Phase 0 仅做 GitHub Marketplace；VS Code 在 Phase 0 W0.1.5 增加 Microsoft publisher 占名）|
| EP11 `stele impact` | **保留并下修**，重编号 v2.0 EP12 | 仅含 direct + uncovered + orphan；删除 indirect impact（依赖 `depends-on` 字段，但用户当前几乎不填写；用户实际行为优先于规范理想）|
| EP12 `stele report --format json` | **完全丢弃** | 无命名消费者；`stele check --json` + `manifest.json` 已覆盖机器可读需求；移到 Phase 3 候选，触发条件"首次书面用户请求"|
| EP13 操作符批次 2 | **保留并裁剪**，编号不变 v2.0 EP13 | 6 → 5 个用户面操作符；删除 `entries`（无 lambda 支持时是死代码）；保留 `max-by`、`min-by`、`unique-by`、`contains-all`、`contains-any` |
| EP14 agent-hooks SDK + Cursor | **提到 Phase 1 EP09** | Cursor 是最大 AI IDE；竞争窗口不能等 5 个月（Round 2 战略反虚饰审查）|

净结果：Phase 2 从 6 个 EP（v1.0：EP09-EP14）缩到 4 个 EP（v2.0：EP10-EP13）；EP14 上升到 Phase 1；EP12 (JSON) 丢弃。

### 1.3 设计原则

- **不引入非确定性服务依赖**：所有功能离线可用；不假设 Anthropic API 可达
- **复刻 Phase 0 一致性套件**：Go 后端、新操作符必须在 `tests/conformance/` 中有 fixture；扩展到 3 个 backend（Python + TypeScript + Go）
- **VS Code 扩展不与 Claude Code 插件竞争**：MVP 仅覆盖 Claude Code 不在的场景（独立 IDE 用户）
- **删除即删除**：丢弃的 EP 不在 Phase 2 测试套件 / 文档 / acceptance 中残留

### 1.4 团队规模假设

本计划假设 **2 FTE 并行执行**。单 FTE 时间线 1.6×（约 14-16 周）。

### 1.5 交付物

| # | 交付物 | 包 | 估算 | 关键路径? |
|---|---|---|---|---|
| EP10 | `@stele/backend-go` v0.1.0 | 新包 | 4-6 周 | 是 |
| EP11 | `stelehq.stele-vscode` MVP | 新包 | 2-3 周 | 否 |
| EP12 | `stele impact` 命令（直接 + 未覆盖 + orphan）| `@stele/cli` | **1 周**（v1.0 是 2 周）| 否 |
| EP13 | 5 个新操作符 | `@stele/core` + 后端 | 1-2 周 | 否 |

合计原始估算：~8-12 周；2 FTE 并行约 8-10 周。

---

## 2. EP10: Go 后端

> v1.0 时编号为 EP09；v2.0 重编号为 EP10。

### 2.1 背景

Go 是云基础设施和微服务的标准语言。AI 基础设施（LLM serving、向量数据库）大量使用 Go。Go 的 `testing` 标准库简单直接。

### 2.2 与 v0.1 草稿的差异（沿用 v1.0 修正）

| 草稿 v0.1 | v1.0 / v2.0 | 原因 |
|---|---|---|
| 文件名 `test_contract_test.go` | **`contract_main_test.go`** | 草稿命名违反 `coordinator.ts:175-213` 的 E0505 校验 |
| `Number → float64` 一律 | **保留 int / float64 区分** | 强类型语言一律 `float64` 在比较 ID 等场景 panic |
| `testify` 强制 | **可选**，默认用标准 `testing` | 不必要的依赖 |
| `steleWhere(t *testing.T, ...)` | **`steleWhere(coll, pred)` 不接受 t** | 查询助手不应让测试失败 |
| Scenario / checker runtime 缺失 | **完整移植 Python helpers** | PRD 缺口必须修复 |
| 与 Phase 0 W0.3 关系隐含 | **§2.3.1 显式引用 W0.3** | v2.0 加：`通过 Phase 0 W0.3 的 backend 注册表装配，与 EP01 同模式` |

### 2.3 需求规格

#### 2.3.1 包结构

```
packages/backend-go/
  src/
    translator.ts              -- 主翻译器
    runtime/
      stele_runtime.go         -- Go 运行时辅助源码（generator emit 时重命名为 _stele_runtime.go 以满足 E0505 校验）
      arithmetic.go.tmpl
      collection.go.tmpl
      ...
    templates/
      test-file.go.tmpl        -- *_test.go 模板
    index.ts                   -- LanguageBackend 实现（通过 Phase 0 W0.3 backend 注册表装配，与 EP01 同模式）
  tests/
    translator.test.ts
    runtime/
      stele_runtime_test.go    -- Go 端单测
    integration.test.ts
```

源码模板用 `stele_runtime.go`（无前缀，便于 Go 包内引用与开发；命名约定）；generator emit 时按 E0505 重命名为 `_stele_runtime.go`。

#### 2.3.2 测试框架

- **默认**：标准库 `testing`（无外部依赖）
- **可选**：`testify` 通过 `stele.config.json` 中 `testFramework: "testify"` 启用
- 文件命名：`contract_main_test.go`、`contract_<group>_test.go`（snake_case 与 Python `test_<group>.py` 对应）
- 输出目录：`contract_test/`（Go 习惯将 contract test 放在 standalone 包，单独目录避免污染）

#### 2.3.3 类型模型

CDL 动态类型 → Go 静态类型映射：

| CDL 类型 | Go 类型 | 注 |
|---|---|---|
| `Number` (整数语境) | `int64` | 通过 path 类型推断或上下文 |
| `Number` (小数语境) | `float64` | sum/avg 自动 promote 为 float64 |
| `String` | `string` | |
| `Boolean` | `bool` | |
| `Collection` | `[]interface{}` | runtime 动态访问 |
| `Path` | `[]string` 至 `interface{}` | 通过 `steleGetPath` |

混合 int + float64 比较：

- runtime helper `steleNumeric(v interface{}) (int64, float64, bool)` 返回 `(intVal, floatVal, isFloat)`
- 比较先尝试 int 比较，若任一边是 float 则提升

```go
func steleEq(a, b interface{}) bool {
    if ai, af, isFloat := steleNumeric(a); isFloat {
        bf := steleAsFloat(b)
        return math.Abs(af - bf) < 1e-9
    } else {
        bi := steleAsInt(b)
        return ai == bi
    }
}
```

#### 2.3.4 路径访问语义

与 Python / TypeScript backend 完全等价（参见 EP01 §2.2.4）：

```go
func steleGetPath(obj interface{}, segments []string) (interface{}, error) {
    current := obj
    for _, seg := range segments {
        m, ok := current.(map[string]interface{})
        if !ok {
            return nil, fmt.Errorf("path navigation hit non-map at %q", seg)
        }
        if v, hit := m[seg]; hit {
            current = v
            continue
        }
        // kebab → snake fallback (与 Python 一致；Go 习惯 snake_case)
        snake := strings.ReplaceAll(seg, "-", "_")
        if v, hit := m[snake]; hit {
            current = v
            continue
        }
        return nil, fmt.Errorf("path not found: %q", seg)
    }
    return current, nil
}
```

#### 2.3.5 Scenario / Checker Runtime

完整移植 Python：

- `steleRunScenario(steps []Step, ctx *Context) error`
- `steleCallChecker(name string, args []interface{}, ctx *Context) (CheckerResult, error)`
- `steleMergeContexts(a, b *Context) *Context`
- `steleIsModified(before, after interface{}, path []string) bool`

Checker 注册接口：

```go
// contract_test/setup_test.go (用户编写)
package contract_test

import "stele/runtime"

func SetupSteleContext() *runtime.Context {
    ctx := runtime.NewContext()
    ctx.Data["account"] = realAccountSnapshot()
    ctx.Data["positions"] = loadOpenPositions()
    ctx.RegisterChecker("balance-change-has-transaction", func(args []interface{}, c *runtime.Context) runtime.CheckerResult {
        return runtime.CheckerOk()
    })
    return ctx
}
```

`TestMain(m *testing.M)` 通过 generator 在每个 `*_test.go` 顶部生成，自动调用 `SetupSteleContext`。

#### 2.3.6 Failure Witness（与 Phase 1 EP07 一致）

Go runtime helpers 在 `forall`/`exists`/`where`/`none` 失败时构造 `FailureWitness` 结构（与 Python/TS backend 等价的字段），通过 helper 返回值传播到 violation report。witness 字段名与 Phase 1 EP07 §8.2.1 定义一致。

#### 2.3.7 配置扩展

```json
{
  "targetLanguage": "go",
  "testFramework": "testing",
  "generatedDir": "contract_test",
  "goModulePath": "github.com/example/myapp/contract_test"
}
```

`goModulePath` 是 Go-specific，用于 generator 在文件顶部 emit `package contract_test` 和 import 路径。

`stele init --language go` 可用前置：Phase 0 W0.3 backend 注册表已支持新增条目，CLI 在 init 时校验 language 已注册。

### 2.4 非功能性需求

- **Go 版本**：Go >= 1.21（slices 包）
- **生成性能**：100 invariant 套件 < 1s（GitHub Actions ubuntu-latest 4-core）
- **编译**：生成的代码通过 `go build ./contract_test/...` 与 `go vet ./contract_test/...` 无错误
- **执行**：通过 `go test ./contract_test/...` 全通

### 2.5 验收标准

- [ ] `stele init --language go` 生成正确的 contract 与 setup_test.go 骨架
- [ ] `stele generate` 生成的 Go 代码通过 `go build` 与 `go vet`
- [ ] `tests/conformance/` 5 个 Phase 0 fixture + EP04 新增 fixture 全部在 Go backend 上通过
- [ ] **跨 backend 一致性**：每个 fixture 在 Python + TypeScript + Go 三 backend 上 violation report 字节等价（含 failure_witness 结构等价）
- [ ] Scenario fixture 在 Go backend 上行为等价
- [ ] `_stele_runtime.go` 不引入 `testify` 依赖（除非 user 在 config 显式启用）
- [ ] `examples/go-project/` 演示
- [ ] `docs/guides/go-integration.md` 完整

---

## 3. EP11: VS Code 扩展 (MVP)

> v1.0 时编号为 EP10；v2.0 重编号为 EP11。

### 3.1 背景

VS Code 是全球最大 IDE。MVP 扩展使 Stele 不依赖 Claude Code，独立可用。

**关键决定**（v1.0）：v0.1 草稿的"完整 VS Code 扩展（含 LSP + Tree View + Tree-sitter + 5 命令）"被降范围至 MVP。Tree View / LSP / Tree-sitter 推迟到 Phase 3。

### 3.2 MVP 范围

| 包含 | 不包含（推迟到 Phase 3）|
|---|---|
| TextMate 语法高亮（`.stele` 文件）| LSP 服务器（complete/hover/goto-def）|
| 命令：`Stele: Check`（运行 `stele check`）| 命令：`Stele: Generate / Lock / Explain`|
| 内联诊断（基于 `stele check --json` 输出）| Tree View（与 Claude Code 插件功能重复）|
| Quick Fix：`Suppress in baseline`| Tree-sitter 文法 |
| 状态栏：违约数显示 | 自定义 UI 面板 |

### 3.3 需求规格

#### 3.3.1 包结构

```
packages/vscode-extension/
  package.json                 -- 扩展 manifest
  src/
    extension.ts               -- activate / deactivate
    cliRunner.ts               -- 调用 stele 二进制（带版本检查）
    diagnostics.ts             -- 解析 violation report 转 vscode.Diagnostic
    commands/
      check.ts                 -- vscode.commands.registerCommand("stele.check", ...)
    statusBar.ts               -- 违约数显示
    quickFix.ts                -- baseline-update 行动
  syntaxes/
    stele.tmLanguage.json      -- TextMate 文法（手写，不依赖 tree-sitter）
  resources/
    icon.svg
  __tests__/
    extension.test.ts
```

#### 3.3.2 CLI 调用模型

扩展通过用户工作区的 `npx stele` 调用 CLI（不内嵌）：

- 启动时检查 `npx stele --version`，若失败 → 状态栏显示"Stele CLI not found, install with: npm install --save-dev @stele/cli"
- 不内嵌 CLI 二进制
- 调用通过 `child_process.spawn` 异步

#### 3.3.3 内联诊断

```typescript
async function runCheck(workspaceFolder: vscode.WorkspaceFolder) {
  const result = await runCli(["check", "--json"], workspaceFolder.uri.fsPath);
  const violations = JSON.parse(result.stdout) as ViolationReport;
  const diagsByFile = new Map<string, vscode.Diagnostic[]>();
  for (const v of violations.violations) {
    const file = v.location?.file ?? v.scope_paths[0];
    const line = (v.location?.line ?? 1) - 1; // VS Code 0-based
    const witness = v.cause.failure_witness;  // EP07 嵌入字段
    const witnessSummary = witness
      ? `\n  Witness: index ${witness.failed_at_index} of ${witness.collection_size}`
      : "";
    const diag = new vscode.Diagnostic(
      new vscode.Range(line, 0, line, 1000),
      `[${v.invariant_id}] ${v.detail?.message ?? "Contract violation"}${witnessSummary}`,
      severityToVsCode(v.severity),
    );
    diag.source = "Stele";
    diag.code = v.invariant_id;
    addToMap(diagsByFile, file, diag);
  }
  diagnosticCollection.clear();
  for (const [file, diags] of diagsByFile) {
    diagnosticCollection.set(vscode.Uri.file(file), diags);
  }
}
```

触发：

- `vscode.workspace.onDidSaveTextDocument`（带 1s debounce）
- 命令面板 `Stele: Check` 显式触发

#### 3.3.4 TextMate 语法

手写 `stele.tmLanguage.json`，覆盖：

- 顶层声明 `(invariant`、`(group`、`(checker`、`(scenario`、`(metadata`、`(import`、`(operator`、`(boundary`、`(class-shape`、`(function-shape`、`(type-policy`、`(file-policy`
- 关键字：`assert`、`uses-checker`、`severity`、`description`、`category`、`tags`、`when`、`tolerance`、`depends-on`、`rationale`、`since`、`applies-to`
- 操作符：完整列表
- 字符串、数字、关键字（`:critical`/`:high`/`:medium`/`:low`）
- 注释：`;` 到行尾
- 平衡括号高亮（VS Code 内建）

测试：手写 fixture `.stele` 文件 + `vscode-tmgrammar-test` 工具校验 token 类型。

#### 3.3.5 配置项

```json
{
  "stele.checkOnSave": true,
  "stele.checkOnSaveDebounceMs": 1000,
  "stele.cliCommand": "npx stele",
  "stele.diagnosticSeverity": {
    "error": "Error",
    "warning": "Warning",
    "info": "Information"
  }
}
```

#### 3.3.6 Quick Fix

仅 1 个 quick fix：

- **"Suppress this violation in baseline"** —— 运行 `npx stele baseline-update --reason "<file>:<line>"` 并刷新诊断
- 不引入 "auto-fix" 或 "ai suggestion"（保持确定性）

#### 3.3.7 发布渠道

VS Code Marketplace（**不**通过 npm publish）。`vsce publish` 流程独立于 `scripts/publish-npm.mjs`。

**前置**：[Phase 0 §4.2.5](prd-phase-0.md) 已完成 Microsoft publisher 账户准备 + `stelehq.stele-vscode` placeholder 0.0.1 占名。本 EP 启动时升级到 0.1.0 含 MVP 功能。

### 3.4 非功能性需求

- **启动时间**：扩展激活 < 200ms（`onLanguage:stele` 事件触发；VS Code 1.85 cold start in 4-core 测试机）
- **内存**：稳定运行 < 100 MB
- **VS Code 兼容**：>= 1.85（2023-12 发布）

### 3.5 新增依赖

| 依赖 | 用途 | 备注 |
|---|---|---|
| `vscode-tmgrammar-test` | TextMate 语法 token 单测 | npm devDependency |
| `@vscode/vsce` | Marketplace 发布 | 已在 [Phase 0 §4.2.5](prd-phase-0.md) 安装 |

### 3.6 验收标准

- [ ] `.stele` 文件正确语法高亮（`vscode-tmgrammar-test` 通过 ≥ 95% token）
- [ ] `Stele: Check` 命令在 Command Palette 出现并可执行
- [ ] 违约显示为内联诊断，hover 显示 invariant_id + message + witness 摘要（基于 EP07）
- [ ] Quick Fix "Suppress in baseline" 工作
- [ ] 状态栏显示违约总数（实时更新）
- [ ] 无 LSP 依赖（无 Tree View、无 goto-def，**这是有意为之**）
- [ ] 扩展在 VS Code Marketplace 列出（升级 0.0.1 placeholder → 0.1.0），icon 与 README 完整

---

## 4. EP12: stele impact 变更影响分析

> v1.0 时编号为 EP11；v2.0 重编号为 EP12。**v2.0 进一步下修**：删除 indirect impact 分析。

### 4.1 背景

代码变更可能影响现有契约。变更分析在编辑**之前**给出预防性提示。

**关键决定**：v0.1 草稿的 EP08（自我修复）丢弃；v1.0 EP11 → v2.0 EP12 仅保留**确定性**的影响分析。v2.0 进一步删除"indirect impact"维度（依赖 `depends-on` 字段，实际用户填写率低；不如把那部分代码省了）。

### 4.2 与 v1.0 的差异

| v1.0 | v2.0 |
|---|---|
| direct + indirect + uncovered + orphan | direct + uncovered + orphan |
| 通过 `depends-on` 链推断 indirect | 删除 |
| 估算 2 周 | **1 周** |

### 4.3 需求规格

#### 4.3.1 命令

```bash
stele impact                          # 当前 worktree vs HEAD
stele impact --diff-from main         # 当前 worktree vs main
stele impact --json                   # 机器可读
```

#### 4.3.2 算法

```
1. 计算 git diff（从 --diff-from 到当前 worktree，含 staged/unstaged/untracked）
2. 对每个变更的 file path：
   a. 查找所有 invariant 的 applies-to 字段
   b. 若 applies-to 与变更 file 进行 minimatch / 字符串匹配
      - 匹配 → "直接影响"
3. 收集**未被任何 invariant 的 applies-to 覆盖**的变更 file → "未覆盖"
4. 收集 applies-to 引用了**已删除的 file**的 invariant → "孤儿"
5. 输出报告
```

注意：

- **不**做 AST diff
- **不**做 indirect / depends-on 链传递（v2.0 删除）
- 用户填 `depends-on` 时仍可手动追踪；本命令不替代 review

#### 4.3.3 输出（机器可读）

```json
{
  "diff_from": "main",
  "head_ref": "feature/balance-refactor",
  "timestamp": "2026-05-08T10:00:00Z",
  "changed_files": ["ledger/account.py", "ledger/transaction.py"],
  "affected_invariants": [
    {
      "invariant_id": "BALANCE_NON_NEGATIVE",
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
  "orphan_invariants": [
    {
      "invariant_id": "OLD_VALIDATION",
      "applies_to": "legacy/validate.py",
      "reason": "applies-to file does not exist",
      "recommendation": "consider-removing"
    }
  ]
}
```

JSON schema 文档化在 `docs/spec/cli-output.md`（**不**在 CDL spec）。

#### 4.3.4 与 stele check 的关系

`stele impact` 是**预防性**（编辑前 / PR 评审中）；`stele check` 是**强制性**（CI gate）。两者不重叠。

CI 集成（在 EP02 GitHub Action 中可加 mode）：

```yaml
- uses: stelehq/stele-action@v1
  with:
    mode: impact          # 新增模式
    diff-from: ${{ github.event.pull_request.base.sha }}
    pr-comment: true      # impact 报告作为单独评论
```

### 4.4 验收标准

- [ ] `stele impact` 在 examples/finance-guard 上正确识别直接影响
- [ ] orphan invariant 检测准确（人造 fixture：删除一个 applies-to 引用的文件）
- [ ] uncovered changes 准确（人造 fixture：变更一个无 applies-to 覆盖的文件）
- [ ] **不存在** indirect impact 输出字段（v2.0 删除）
- [ ] `--json` 输出 schema 文档化在 `docs/spec/cli-output.md`
- [ ] **不**调用任何外部服务（AI、网络）；离线可用
- [ ] 大变更（100+ files）分析时间 < 5s

---

## 5. EP13: CDL 操作符增强批次 2

### 5.1 v2.0 操作符清单

5 个新操作符（v1.0 是 6 个；v2.0 删除 `entries`）：

| 操作符 | 签名 | 语义钉死 |
|---|---|---|
| `max-by` | `(Collection, Path) -> Unknown` | 按路径值最大的元素；空集合抛错；并列时返回**第一个** |
| `min-by` | `(Collection, Path) -> Unknown` | 按路径值最小的元素；空集合抛错；并列时返回第一个 |
| `unique-by` | `(Collection, Path) -> Collection` | 按路径值去重，保留**第一次出现**；保持原顺序 |
| `contains-all` | `(Collection, Collection) -> Boolean` | 第二集合是第一集合的子集；按值比较（non-strict equality）|
| `contains-any` | `(Collection, Collection) -> Boolean` | 两集合交集非空 |

**已删除 `entries`**：v1.0 PRD 提议 `entries` 把 Map 转为 Pair Collection，目的是配合 lambda + `group-by`。但：

- v0.2 没有 lambda 支持
- `group-by` 在 EP04 中已标记为 internal-only
- 没有 lambda 时 `entries` 是死代码

`entries` 移到 Phase 3 候选，触发条件"lambda 支持落地"。

### 5.2 实现范围（每个操作符）

每个操作符需在 EP04 §5.4 的同样 8 项中**全部**完成：注册、validator、Python translator、Python runtime、TypeScript translator、TypeScript runtime、Go translator、Go runtime、conformance fixture、正反单测。

由于 Phase 2 引入 Go backend，每个操作符需在 **3 个 backend** 实现。每操作符约 6-8 小时；5 个操作符 ≈ 30-40 小时；约 1-1.5 周（2 FTE 并行）。

### 5.3 总数（v2.0 钉死）

| 阶段边界 | 注册总数 | 用户面（去 alias，去内部）|
|---|---|---|
| Phase 1 末 | 70 注册（51 + 18 新 + 1 内部 group-by + 1 alias filter）| 69 |
| Phase 2 末 (含本 EP) | 70 + 5 = **75** 注册 | 69 + 5 = **74** |

> v1.0 PRD §6.4 的 "76" 假设 `entries` 也注册。v2.0 删除 `entries` 后修正为 75 注册（74 用户面）。

### 5.4 文档

- 更新 `docs/spec/cdl.md` 操作符总数到 **75 注册（74 用户面）**
- 更新 "Operator semantics across backends" 表格

### 5.5 验收标准

- [ ] 5 个操作符注册并通过类型校验
- [ ] 在 Python + TypeScript + Go 三个 backend 上 conformance fixture 字节等价
- [ ] 空集合行为（`max-by`、`min-by`）跨 backend 一致（皆抛 SteleRuntimeError）
- [ ] **不存在** `entries` 操作符注册
- [ ] CDL spec 操作符总数与注册表一致（CI lint 校验）

---

## 6. 里程碑和依赖

### 6.1 团队 2 FTE 规划（8-10 周）

| 周 | Eng A（核心 + Go）| Eng B（IDE + 集成）|
|---|---|---|
| W1-2 | EP10 Go 后端骨架 + 操作符翻译 | EP11 VS Code MVP（语法 + 命令）|
| W3 | EP10 runtime + scenario | EP11 内联诊断 + Quick Fix |
| W4 | EP10 完成 + 狗食 | EP11 完成 + Marketplace 0.1.0 升级 |
| W5 | EP13 操作符批次 2（Go 落地）| EP12 stele impact（1 周）|
| W6 | EP13 完成 | EP12 完成 + 文档 |
| W7-8 | conformance suite 扩充（含 Go）| 文档收尾 + 发布前修复 |

### 6.2 依赖图

```
Phase 1 完成
   │
   ├──→ EP10 (Go 后端) ────────┐
   │                            │
   ├──→ EP11 (VS Code MVP)      │
   │                            │
   └──→ EP12 (stele impact)     │
                                │
                                ↓
                            EP13 (操作符批次 2)  ← 必须等 EP10 完成（Go runtime 落地）
                                │
                                ↓
                            Phase 2 验收
```

### 6.3 关键路径

`Phase 1 完成 → EP10 → EP13` 是关键路径。EP11、EP12 在关键路径之外可并行。

---

## 7. 验收标准（总）

### 7.1 功能验收

- [ ] Go 项目可正常生成与执行契约测试（含 failure_witness 结构等价）
- [ ] VS Code 扩展 MVP 在 Marketplace 列出，`.stele` 高亮 + 内联诊断（含 EP07 witness 摘要）工作
- [ ] `stele impact` 离线确定性输出（无 AI 调用，无 indirect 字段）
- [ ] **75 个注册操作符（74 用户面）跨 Python / TypeScript / Go 三个 backend 一致**
- [ ] **不存在** `stele report --format json` 命令（v2.0 已丢弃）
- [ ] **不存在** `entries` 操作符（v2.0 已删除）
- [ ] **不存在** v1.0 EP14 (Cursor 适配器) 在 Phase 2 中（已上升到 Phase 1 EP09）

### 7.2 质量验收

- [ ] 全部 conformance fixture（Phase 0 五个 + Phase 1 新增 + Phase 2 新增）在三 backend 上通过
- [ ] 所有新增代码测试覆盖率 ≥ 80%
- [ ] tsc --strict 无错误
- [ ] Go 后端生成的代码通过 `go build` 与 `go vet`

### 7.3 文档验收

- [ ] `docs/guides/go-integration.md`
- [ ] `docs/guides/vscode-extension.md`
- [ ] `docs/spec/cdl.md` 操作符表更新到 **75 注册（74 用户面）**
- [ ] `docs/spec/cli-output.md` 含 `stele impact --json` schema
- [ ] `examples/go-project/`
- [ ] `CHANGELOG.md` 0.3.0 段落

---

## 8. Phase 3 候选项（信息性）

以下功能在 Round 1 / Round 2 评审中被裁出 Phase 1/2，不构成本 PRD 的承诺，但记录于此为 Phase 3 规划提供输入：

| 候选 | 来源 | 触发条件（可验证）|
|---|---|---|
| **Java 后端** | roadmap §4.2.2 | Stele 用户群中 Java 项目 ≥ 5 个并提出请求 |
| **Rust 后端** | 原 EP12 | 安全关键场景客户出现，且 proptest 集成路径清晰；至少 3 个用户请求 |
| **HTML 报告** | 原 EP10 | 大团队明确请求；持久化历史的 trends 设计完成 |
| **Prometheus exporter** | 原 EP10 | HTML 报告先落地，且明确 SRE 集成场景 |
| **`stele report --format json`** | v1.0 EP12 | **首次书面用户请求**（issue + 使用场景描述）|
| **多项目工作区文件格式（`stele.workspace.json`）**| v1.0 EP08 | **首次书面用户请求**：用户场景超出 `--recursive` 标志能力范围（如需要拓扑排序、shared imports）|
| **完整 evaluation trace（多步轨迹）**| Phase 1 EP07 推迟部分 | 用户报告 single-step witness 不够诊断时（issue + 具体例子）|
| **插件系统** | 原 EP11 | 第三方操作符 / backend 作者出现：至少 1 个外部 PR 包含完整 backend 实现 |
| **Self-Healing 契约（确定性版本）**| 原 EP08 重思 | Phase 1 EP07 + Phase 2 EP12 GA 后 6 个月，**有用户**报告需要自动应用 baseline-update（issue 量化）|
| **VS Code LSP / Tree View / Tree-sitter** | EP11 推迟部分 | MVP 用户反馈强烈需要 hover / goto-def（issue ≥ 5）|
| **`stele audit`（陈旧 invariant 检测）**| Round 1 评审建议 | Phase 1+2 部署后 6 个月有数据可分析 |
| **Continue.dev 完整适配器** | EP09 推迟部分 | Continue.dev SDK 接口稳定（v1.0+）后 |
| **`entries` + lambda 操作符** | v1.0 EP13 推迟 | lambda 支持落地后；v0.2 未实现 |

每一项进入 Phase 3 PRD 前必须独立评审（依赖性、用户价值、可行性）。
