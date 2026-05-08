# Stele Phase 2 需求文档

> 版本: 0.1 | 日期: 2026-05-08 | 状态: 草稿
> 范围: 第二阶段平台扩张（3-6个月）

---

## 目录

1. [概述](#1-概述)
2. [EP06: Go 后端](#2-ep06-go-后端)
3. [EP07: VS Code 扩展](#3-ep07-vs-code-扩展)
4. [EP08: 自我修复契约](#4-ep08-自我修复契约)
5. [EP09: 契约变更检测与自动建议](#5-ep09-契约变更检测与自动建议)
6. [EP10: 观察性仪表板](#6-ep10-观察性仪表板)
7. [EP11: 插件生态系统](#7-ep11-插件生态系统)
8. [EP12: Rust 后端](#8-ep12-rust-后端)
9. [EP13: CDL 操作符增强（批次 2）](#9-ep13-cdl-操作符增强批次-2)
10. [里程碑和依赖](#10-里程碑和依赖)
11. [验收标准](#11-验收标准)

---

## 1. 概述

### 1.1 目标

覆盖更多语言，增强 AI 代理能力，建立观察性。Phase 2 完成后 Stele 需具备：

- Go 和 Rust 语言后端
- VS Code 扩展（语法高亮、内联提示、命令面板）
- 自我修复契约（违约后自动分析原因并建议修复）
- 契约变更检测（代码变更→影响分析→契约建议）
- 观察性仪表板（覆盖率、趋势、严重性分布）
- 插件系统（第三方操作符、后端、校验器）
- 70+ 操作符

### 1.2 设计原则

- **平台无关**: VS Code 扩展不依赖 Claude Code
- **AI 原生**: 自我修复和变更检测利用 AI 代理能力
- **可插拔**: 插件系统支持第三方扩展
- **渐进增强**: 不破坏现有工作流，增量增强

### 1.3 交付物

| # | 交付物 | 包 | 估算 |
|----|--------|-----|------|
| EP06 | `@stele/backend-go` | 新包 | 3-4 周 |
| EP07 | VS Code 扩展 | 新包 | 4-6 周 |
| EP08 | `stele fix` 命令 | `@stele/cli` | 3-4 周 |
| EP09 | `stele impact` 命令 | `@stele/cli` | 3-4 周 |
| EP10 | `stele doc --format html` | `@stele/cli` | 2 周 |
| EP11 | 插件加载器 | `@stele/core` | 4-6 周 |
| EP12 | `@stele/backend-rust` | 新包 | 4-6 周 |
| EP13 | 操作符 10+ 个 | `@stele/core` + 各后端 | 1-2 周 |

---

## 2. EP06: Go 后端

### 2.1 背景

Go 是云基础设施和微服务的标准语言。AI 基础设施（LLM serving、向量数据库）大量使用 Go。Go 的 `testing` 标准库简单直接。

### 2.2 需求规格

#### 2.2.1 包结构

```
packages/backend-go/
  src/
    translator.ts              -- 主翻译器
    runtime.ts                 -- Go 运行时源输出
    templates/
      comparison.ts            -- Go 比较操作符
      arithmetic.ts            -- Go 算术操作符
      collection.ts            -- Go 集合操作符
      logic.ts                 -- Go 逻辑操作符
      temporal.ts              -- Go 时间操作符
      string.ts                -- Go 字符串操作符
    index.ts                   -- LanguageBackend 实现 + 导出
  test/
    operator-coverage.test.ts
    integration.test.ts
```

#### 2.2.2 测试框架

- **框架**: Go 标准库 `testing`
- **断言**: `testify`（`require.Equal`, `require.True` 等）
- 文件命名: `*_test.go`
- 输出目录: `contract_test/`

#### 2.2.3 生成文件

```
contract_test/
  stele_helpers.go             -- 运行时辅助函数
  test_contract_test.go        -- 主测试文件
  test_<group>_test.go         -- 每个 group 一个测试文件（可选）
```

#### 2.2.4 Go 运行时辅助函数

```go
package contract_test

import "testing"

// 路径导航
func steleGetPath(obj map[string]interface{}, pathSegments []string) interface{}

// 集合操作
func steleWhere(t *testing.T, collection []map[string]interface{}, predicate func(map[string]interface{}) bool) []map[string]interface{}
func steleForEach(t *testing.T, collection []map[string]interface{}, predicate func(map[string]interface{}) bool) bool
func steleExists(t *testing.T, collection []map[string]interface{}, predicate func(map[string]interface{}) bool) bool

// 聚合
func steleSum(t *testing.T, collection []map[string]interface{}, pathSegments []string) float64
func steleAvg(t *testing.T, collection []map[string]interface{}, pathSegments []string) float64

// 断言包装
func requireTrue(t *testing.T, condition bool, msg string) {
    if !condition {
        t.Errorf(msg)
        t.FailNow()
    }
}
```

#### 2.2.5 操作符翻译映射

| CDL 操作符 | Go 表达 | 示例 |
|-----------|---------|------|
| `forall` | 循环 + `t.Errorf` | `for _, item := range accounts { if steleGetPath(item, []string{"balance"}) <= 0 { t.Errorf(...) } }` |
| `exists` | 循环 + `found` 标志 | `found := false; for _, item := range orders { if ... { found = true; break } }` |
| `sum` | 循环累加 | `var total float64; for _, item := range items { total += steleGetPath(item, path).(float64) }` |
| `matches` | `regexp.MustCompile(pattern).MatchString(str)` | |
| `in` | `slices.Contains` (Go 1.21+) | |

#### 2.2.6 类型推断

Go 是强类型语言。CDL 动态类型需映射到 Go 类型：

- `Number` → `float64`（统一用 float64 避免 int/float 混用问题）
- `String` → `string`
- `Boolean` → `bool`
- `Collection` → `[]map[string]interface{}`
- `Path` → 通过 `steleGetPath` 返回 `interface{}`，使用时类型断言

### 2.3 非功能性需求

- **Go 版本**: Go >= 1.21（使用 `slices` 包）
- **性能**: 100+ invariant 生成 < 1 秒
- **编译**: 生成的代码通过 `go build` 无错误

### 2.4 验收标准

- [ ] `stele generate` 在 Go 项目中生成有效的测试文件
- [ ] 生成的测试通过 `go test ./contract_test/` 执行
- [ ] 所有内置操作符翻译通过单元测试
- [ ] 生成的代码通过 `go vet` 检查

---

## 3. EP07: VS Code 扩展

### 3.1 背景

VS Code 是全球最大 IDE。扩展使 Stele 不依赖 Claude Code，独立可用。

### 3.2 需求规格

#### 3.2.1 包结构

```
packages/vscode-extension/
  package.json                 -- 扩展定义
  src/
    extension.ts               -- 扩展入口
    languageServer.ts          -- LSP 客户端（或内建）
    commands/
      check.ts                 -- Stele: Check
      generate.ts              -- Stele: Generate
      lock.ts                  -- Stele: Lock
      explain.ts               -- Stele: Explain This Violation
    providers/
      steleLanguageProvider.ts -- .stele 文件语法高亮
      diagnosticProvider.ts    -- 内联违约提示
      treeViewProvider.ts      -- 契约文件导航
  syntaxes/
    stele.tmGrammar.json       -- TextMate 语法高亮
    stele.tmLanguage.json
  resources/
    icons/
      stele.svg
      invariant.svg
```

#### 3.2.2 功能规格

**3.2.2.1 语法高亮**

基于 TextMate 语法的 `.stele` 文件高亮：

```json
{
  "scopeName": "source.stele",
  "patterns": [
    { "match": "\\(invariant", "name": "keyword.declaration.stele" },
    { "match": "\\(group", "name": "keyword.declaration.stele" },
    { "match": "\\(assert", "name": "keyword.control.stele" },
    { "match": ":\\w+", "name": "keyword.other.stele" },
    { "match": "\"[^\"]*\"", "name": "string.quoted.stele" },
    { "match": ";.*$", "name": "comment.line.stele" },
    { "match": "\\b(forall|exists|where|and|or|not)\\b", "name": "keyword.operator.stele" }
  ]
}
```

**3.2.2.2 命令面板**

- `Stele: Check` — 运行 `stele check`，结果输出到面板
- `Stele: Generate` — 运行 `stele generate`
- `Stele: Lock` — 运行 `stele lock`
- `Stele: Explain` — 光标所在行是违约时，解释原因

**3.2.2.3 内联诊断**

`stele check` 发现违约后：

- 在对应文件行上显示错误/警告波浪线
- hover 显示违约详情（invariant ID、描述、严重程度）
- quick fix：`stele baseline-init` 或 `stele explain`

**3.2.2.4 契约导航（Tree View）**

侧边栏树形视图：

```
📋 Stele Contracts
├── 📄 contracts/
│   ├── 📄 account.stele
│   │   ├── 🔒 BALANCE_NON_NEGATIVE (error)
│   │   ├── 🔒 TRANSACTION_SUM_MATCHES (error)
│   │   └── 📝 ACCOUNT_NAME_REQUIRED (warning)
│   └── 📄 transaction.stele
│       └── 🔒 NO_DBL_SPEND (error)
└── ⚠️ Violations (3)
    ├── ❌ BALANCE_NON_NEGATIVE
    ├── ❌ TRANSACTION_SUM_MATCHES
    └── ⚠️ ACCOUNT_NAME_REQUIRED
```

**3.2.2.5 Tree-sitter 语法（可选增强）**

```
packages/vscode-extension/grammars/
  stele.js                     -- tree-sitter 文法定义
```

#### 3.2.3 配置项

```json
{
  "stele.checkOnSave": true,
  "stele.checkOnSaveDebounceMs": 1000,
  "stele.cliPath": "npx stele",
  "stele.diagnosticSeverity": {
    "error": "error",
    "warning": "warning",
    "info": "information"
  }
}
```

### 3.3 非功能性需求

- **启动时间**: 扩展加载 < 500ms
- **内存**: 稳定运行 < 200MB
- **兼容性**: VS Code >= 1.90

### 3.4 验收标准

- [ ] `.stele` 文件正确语法高亮
- [ ] 命令面板命令正确执行
- [ ] 违约正确显示为内联诊断
- [ ] Tree View 正确展示契约结构
- [ ] 扩展发布到 VS Code Marketplace

---

## 4. EP08: 自我修复契约

### 4.1 背景

违约发生时，人工分析原因是瓶颈。自我修复自动分析代码变更和违约的关系，判断是合理漂移还是真正的 bug，然后生成修复方案。

### 4.2 需求规格

#### 4.2.1 命令设计

```bash
# 自动分析违约原因并给出建议
stele fix --suggest

# 自动应用修复（需确认）
stele fix --auto --confirm

# 对特定违约修复
stele fix --invariant BALANCE_NON_NEGATIVE
```

#### 4.2.2 分析流程

```
1. 获取当前违约列表（stele check --json）
2. 对每个违约:
   a. 获取 diff-from 的变更（git diff）
   b. 识别变更的代码区域（AST diff）
   c. 匹配受影响的 invariant（applies-to, depends-on 链）
   d. 分类原因:
      - 合理漂移: 代码正常演进，invariant 定义过时
      - 真正 bug: 代码变更确实破坏了不变量
      - 误报: invariant 定义有歧义
   e. 生成修复建议:
      - 合理漂移 → 提案更新 invariant
      - 真正 bug → 生成代码修复补丁
      - 误报 → 提案修改 invariant 描述或条件
3. 输出报告（JSON 或人类可读格式）
```

#### 4.2.3 输出格式

```json
{
  "fixId": "fix-2026-05-08-001",
  "invariantId": "BALANCE_NON_NEGATIVE",
  "violationFingerprint": "sha256:abc123...",
  "rootCause": "code-change",
  "classification": "reasonable-drift",
  "reasoning": "The `balance` field was changed from `int` to `float`, and the invariant uses `gt (path balance) 0` which fails for zero balances that are now valid.",
  "suggestedFix": {
    "type": "update-invariant",
    "currentAssert": "(gt (path balance) 0)",
    "proposedAssert": "(gte (path balance) 0)",
    "rationale": "Zero balance is valid after float migration."
  },
  "confidence": 0.85,
  "requiresHumanReview": true
}
```

#### 4.2.4 AI 代理集成

利用 AI 代理能力进行智能分析：

```typescript
interface FixAnalysisResult {
  classification: "reasonable-drift" | "real-bug" | "false-positive";
  reasoning: string;
  suggestedFix: SuggestedFix;
  confidence: number;
}

async function analyzeViolation(
  violation: Violation,
  diff: GitDiff,
  invariant: InvariantDeclaration,
  context: string
): Promise<FixAnalysisResult> {
  // 构建 prompt: 包含 invariant 定义、代码变更、违约详情
  // 调用 AI 代理进行分析
  // 返回分类和建议
}
```

#### 4.2.5 安全约束

- **所有修复必须经过人类审批**（`--confirm` 标志）
- **不允许直接修改 `.stele` 文件**（只生成提案，通过 `stele propose` 流程）
- **代码修复以补丁形式输出**（diff），用户手动应用
- **置信度 < 0.7 的修复标记为低置信度**，建议人工分析

### 4.3 非功能性需求

- **分析时间**: 单个违约分析 < 5 秒（含 AI 调用）
- **准确率**: 分类准确率 > 80%（基于测试集）

### 4.4 验收标准

- [ ] `stele fix --suggest` 输出合理的修复建议
- [ ] 修复建议包含原因分类、推理、建议代码
- [ ] 所有修复需人类审批
- [ ] 置信度低时明确标注

---

## 5. EP09: 契约变更检测与自动建议

### 5.1 背景

代码变更可能影响现有契约。变更检测在编辑**之前**提供预防性建议，而非违约**之后**的修复。

### 5.2 需求规格

#### 5.2.1 命令设计

```bash
# 分析当前变更对契约的影响
stele impact

# 指定对比基准
stele impact --diff-from main

# 输出 JSON（CI 集成）
stele impact --json
```

#### 5.2.2 分析流程

```
1. 获取 git diff（当前工作区 vs 指定基准）
2. 解析 diff，识别变更的代码元素:
   - 新增/删除/修改的函数
   - 新增/删除/修改的类
   - 新增/删除的字段
   - 方法签名变更
3. 对每个变更元素:
   a. 查找引用的 invariant（通过 applies-to 路径匹配）
   b. 查找 depends-on 链（传递依赖）
   c. 判断影响类型:
      - 直接影响: 代码元素被 invariant 直接引用
      - 间接影响: 通过 depends-on 链影响
      - 潜在影响: 路径模式可能匹配但不确定
4. 生成影响报告 + 建议:
   - 如果受影响 invariant 可能需要更新 → 建议 review
   - 如果新增代码缺乏契约覆盖 → 建议新增 invariant
   - 如果删除代码导致 orphan invariant → 建议清理
5. 输出报告
```

#### 5.2.3 输出格式

```json
{
  "analysisId": "impact-2026-05-08-001",
  "diffFrom": "main",
  "timestamp": "2026-05-08T10:00:00Z",
  "affectedInvariants": [
    {
      "invariantId": "BALANCE_NON_NEGATIVE",
      "impactLevel": "direct",
      "changedElements": ["ledger/account.py:Account.balance"],
      "recommendation": "review",
      "reasoning": "The `balance` field type changed from int to float. Invariant uses `gt` which may need to become `gte`."
    }
  ],
  "uncoveredChanges": [
    {
      "changedElement": "ledger/transaction.py:Transaction.refund_amount",
      "recommendation": "add-invariant",
      "suggestion": "Consider adding an invariant to ensure refund_amount <= original_amount."
    }
  ],
  "orphanInvariants": [
    {
      "invariantId": "OLD_VALIDATION",
      "reasoning": "The `validate_legacy` function referenced by this invariant was removed."
    }
  ]
}
```

#### 5.2.4 与 Self-Healing 的区别

| 维度 | Self-Healing (EP08) | 变更检测 (EP09) |
|------|---------------------|-----------------|
| 触发时机 | 违约发生后 | 代码变更时（编辑前） |
| 目标 | 修复已发生的违约 | 预防违约发生 |
| 输入 | 违约报告 + 代码 diff | 代码 diff |
| 输出 | 修复建议 | 影响分析 + 建议 |

### 5.3 验收标准

- [ ] `stele impact` 正确识别受影响的 invariant
- [ ] 直接影响和间接影响分类准确
- [ ] 未覆盖的代码变更有新增 invariant 建议
- [ ] orphan invariant 检测准确
- [ ] JSON 输出格式可用于 CI 集成

---

## 6. EP10: 观察性仪表板

### 6.1 背景

大型团队需要可视化的契约健康度报告。HTML 报告作为最低成本方案。

### 6.2 需求规格

#### 6.2.1 命令设计

```bash
# 生成 HTML 报告
stele doc --format html --output reports/contract-health.html

# 生成 JSON 数据（供 Grafana 等消费）
stele doc --format json --output reports/contract-health.json
```

#### 6.2.2 HTML 报告内容

单页 HTML 报告，内联样式（无需外部依赖）：

**6.2.2.1 概览卡片**

- 契约覆盖率: 多少代码被契约保护（受保护文件数 / 总文件数）
- 违约总数: 按严重程度分类
- 活跃不变量数
- 最近检查时间

**6.2.2.2 违约趋势**

折线图（使用纯 SVG/CSS，无外部库）：

- 按时间的违约数量变化
- 按严重程度的分布

**6.2.2.3 严重性分布**

饼图: error / warning / info

**6.2.2.4 热点文件**

列表: 违约最多的文件/模块

```
文件                          违约数  严重程度
──────────────────────────────────────────
ledger/account.py              3      2 error, 1 warning
ledger/transaction.py          2      2 error
api/handlers.py                1      1 warning
```

**6.2.2.5 契约清单**

可折叠的表格:

| ID | 描述 | 严重程度 | 分类 | 状态 | since |
|----|------|---------|------|------|-------|
| BALANCE_NON_NEGATIVE | 账户余额不得为负 | error | accounting | ✅ passing | 2026-01-15 |
| TRANSACTION_SUM_MATCHES | 交易金额之和等于总额 | error | accounting | ❌ failing | 2026-01-15 |

**6.2.2.6 契约时间线**

每个 invariant 的 `since` 时间线：

```
BALANCE_NON_NEGATIVE
├── 2026-01-15  创建 (initial)
├── 2026-03-01  更新 (relaxed condition)
└── 2026-05-01  更新 (added category)
```

#### 6.2.3 JSON 输出格式

```json
{
  "generatedAt": "2026-05-08T10:00:00Z",
  "coverage": {
    "totalFiles": 150,
    "protectedFiles": 45,
    "percentage": 30.0
  },
  "violations": {
    "total": 12,
    "bySeverity": { "error": 8, "warning": 3, "info": 1 },
    "byFile": { "ledger/account.py": 3, "ledger/transaction.py": 2, ... }
  },
  "invariants": {
    "total": 24,
    "passing": 20,
    "failing": 4
  },
  "trends": [
    { "date": "2026-04-01", "count": 15 },
    { "date": "2026-04-15", "count": 12 },
    { "date": "2026-05-01", "count": 10 }
  ]
}
```

#### 6.2.4 Prometheus 指标（可选，远期）

```
# Stele 契约违约总数
stele_violations_total{severity="error"} 8
stele_violations_total{severity="warning"} 3

# Stele 契约覆盖率
stele_coverage_ratio 0.3

# Stele 不变量状态
stele_invariants_total{status="passing"} 20
stele_invariants_total{status="failing"} 4
```

### 6.3 非功能性需求

- **报告大小**: < 500KB（内联样式，无外部依赖）
- **生成时间**: < 1 秒
- **兼容性**: Chrome/Edge/Firefox/Safari 最新两个版本

### 6.4 验收标准

- [ ] HTML 报告正确展示概览、趋势、分布、热点、清单
- [ ] JSON 输出格式正确
- [ ] 报告无外部依赖（内联样式）
- [ ] 浏览器兼容性测试通过

---

## 7. EP11: 插件生态系统

### 7.1 背景

允许第三方扩展 Stele 的能力（操作符、后端、校验器）。

### 7.2 需求规格

#### 7.2.1 插件 API

```typescript
// 插件接口
interface StelePlugin {
  name: string;
  version: string;

  // 注册自定义操作符
  operators?: OperatorSpec[];

  // 注册自定义后端
  backends?: LanguageBackend[];

  // 注册自定义校验器
  checkers?: CheckerSpec[];

  // 插件初始化钩子
  init?(context: PluginContext): void;
}

// 插件上下文
interface PluginContext {
  registerOperator(spec: OperatorSpec): void;
  registerBackend(backend: LanguageBackend): void;
  registerChecker(spec: CheckerSpec): void;
}
```

#### 7.2.2 插件配置

`stele.config.json` 中的 `plugins` 字段：

```json
{
  "plugins": [
    {
      "name": "@stele/plugin-http",
      "path": "./plugins/http-plugin.cjs"
    },
    {
      "name": "my-custom-operators",
      "path": "./plugins/custom-operators.cjs"
    }
  ]
}
```

#### 7.2.3 插件加载机制

```
1. 读取 stele.config.json 的 plugins 字段
2. 对每个插件:
   a. 解析 path（node_modules 或本地路径）
   b. 动态导入 (import())
   c. 验证返回对象符合 StelePlugin 接口
   d. 调用 init() 钩子
   e. 注册操作符/后端/校验器到全局注册表
3. 记录已加载插件列表（stele --version 显示）
```

#### 7.2.4 插件沙箱

- **操作符插件**: 只注册 `OperatorSpec`，不执行用户代码
- **后端插件**: 实现 `LanguageBackend` 接口，在沙箱中运行
- **校验器插件**: 外部进程执行（已有 checker 机制），不做额外沙箱

#### 7.2.5 插件示例

**操作符插件**:

```javascript
// plugins/custom-operators.cjs
module.exports = {
  name: "custom-operators",
  version: "1.0.0",
  operators: [
    {
      name: "http-get",
      description: "Perform HTTP GET request",
      params: [
        { name: "url", type: "String", required: true }
      ],
      returnType: "Unknown"
    }
  ]
};
```

**后端插件**:

```javascript
// plugins/php-backend.cjs
module.exports = {
  name: "php-backend",
  version: "1.0.0",
  backends: [
    {
      name: "php",
      framework: "phpunit",
      fileExtension: ".php",
      version: "0.1",
      generate: async (contract, config) => { /* ... */ },
      supportFiles: async (contract, config) => { /* ... */ }
    }
  ]
};
```

### 7.3 非功能性需求

- **加载时间**: 单插件加载 < 100ms
- **安全性**: 插件不能访问文件系统敏感区域（已有 import 路径限制）
- **向后兼容**: 插件 API 需版本化（`apiVersion: "1.0"`）

### 7.4 验收标准

- [ ] `stele.config.json` 正确加载插件
- [ ] 操作符插件注册后可在 CDL 中使用
- [ ] 后端插件注册后可通过 `stele generate` 选择
- [ ] 插件加载失败不阻塞 Stele 启动
- [ ] `stele --version` 显示已加载插件列表

---

## 8. EP12: Rust 后端

### 8.1 背景

Rust 在安全关键系统中广泛使用，社区重视正确性。Rust 的 `proptest` 库是属性测试的优秀选择。

### 8.2 需求规格

#### 8.2.1 包结构

```
packages/backend-rust/
  src/
    translator.ts
    runtime.ts
    templates/
      comparison.ts
      arithmetic.ts
      collection.ts
      logic.ts
      temporal.ts
      string.ts
    index.ts
  test/
    operator-coverage.test.ts
    integration.test.ts
```

#### 8.2.2 测试框架

- **框架**: Rust `#[test]`（标准库）
- **属性测试**: `proptest`（可选，通过配置开启）
- **断言**: `assert_eq!`, `assert!`
- 文件命名: `tests/contract_*.rs`

#### 8.2.3 生成文件

```
tests/
  contract_helpers.rs          -- 运行时辅助函数
  contract_main.rs             -- 主测试文件
  contract_<group>.rs           -- 每个 group 一个测试文件
```

#### 8.2.4 Rust 运行时辅助函数

```rust
use serde_json::Value;

// 路径导航
pub fn stele_get_path(obj: &Value, path_segments: &[String]) -> Option<&Value> {
    let mut current = obj;
    for segment in path_segments {
        match current {
            Value::Object(map) => {
                current = map.get(segment.as_str())?;
            }
            _ => return None,
        }
    }
    Some(current)
}

// 集合操作
pub fn stele_where(collection: &[Value], predicate: fn(&Value) -> bool) -> Vec<&Value> {
    collection.iter().filter(|item| predicate(item)).collect()
}

pub fn stele_forall(collection: &[Value], predicate: fn(&Value) -> bool) -> bool {
    collection.iter().all(|item| predicate(item))
}
```

#### 8.2.5 proptest 集成（可选）

```rust
use proptest::prelude::*;

proptest! {
    #[test]
    fn test_balance_never_negative(account in account_strategy()) {
        assert!(account["balance"].as_f64().unwrap_or(0.0) >= 0.0);
    }
}
```

### 8.3 非功能性需求

- **Rust 版本**: Rust >= 1.75
- **编译**: 生成的代码通过 `cargo test` 无错误

### 8.4 验收标准

- [ ] `stele generate` 在 Rust 项目中生成有效的测试文件
- [ ] 生成的测试通过 `cargo test` 执行
- [ ] 所有内置操作符翻译通过单元测试
- [ ] proptest 集成可选且默认关闭

---

## 9. EP13: CDL 操作符增强（批次 2）

### 9.1 新增操作符

| 操作符 | 签名 | 描述 |
|--------|------|------|
| `map` | `(Collection, Path) -> Collection` | 提取路径值到数组 |
| `filter` | `(Collection, Predicate) -> Collection` | 按谓词过滤（alias of `where`，更一致） |
| `max-by` | `(Collection, Path) -> Unknown` | 按路径值找到最大元素 |
| `min-by` | `(Collection, Path) -> Unknown` | 按路径值找到最小元素 |
| `median` | `(Collection, Path) -> Number` | 中位数 |
| `stddev` | `(Collection, Path) -> Number` | 标准差 |
| `first` | `(Collection) -> Unknown` | 第一个元素 |
| `last` | `(Collection) -> Unknown` | 最后一个元素 |
| `slice` | `(Collection, Number, Number) -> Collection` | 切片 `[start, end)` |
| `flatten` | `(Collection) -> Collection` | 展平嵌套集合 |
| `unique-by` | `(Collection, Path) -> Collection` | 按路径去重 |
| `contains-all` | `(Collection, Collection) -> Boolean` | 超集检查 |
| `contains-any` | `(Collection, Collection) -> Boolean` | 交集非空 |
| `index-of` | `(Collection, Path, Value) -> Number` | 按路径值查找索引 |

### 9.2 验收标准

同 EP04，所有操作符需注册、翻译、测试全覆盖。

---

## 10. 里程碑和依赖

### 10.1 第三个月

| 周 | 任务 | 依赖 |
|----|------|------|
| W9 | EP06: Go 后端骨架 + 核心操作符 | `@stele/core` |
| W10 | EP06: Go 运行时 + 完整操作符 + 集成测试 | EP06 W9 |
| W11 | EP10: HTML 报告生成器 | `@stele/cli` |
| W12 | EP13: 操作符增强批次 2 | `@stele/core` |

### 10.2 第四个月

| 周 | 任务 | 依赖 |
|----|------|------|
| W13 | EP07: VS Code 扩展骨架 + 语法高亮 | `@stele/cli` |
| W14 | EP07: 命令面板 + 诊断提供器 | EP07 W13 |
| W15 | EP08: Self-Healing 分析引擎 | `@stele/cli`, AI 集成 |
| W16 | EP08: 修复建议生成 + 安全约束 | EP08 W15 |

### 10.3 第五个月

| 周 | 任务 | 依赖 |
|----|------|------|
| W17 | EP09: 变更检测 diff 分析 | `@stele/cli` |
| W18 | EP09: 影响匹配 + 建议生成 | EP09 W17 |
| W19 | EP11: 插件加载器 + API 设计 | `@stele/core` |
| W20 | EP11: 操作符/后端/校验器插件支持 | EP11 W19 |

### 10.4 第六个月

| 周 | 任务 | 依赖 |
|----|------|------|
| W21 | EP12: Rust 后端骨架 | `@stele/core` |
| W22 | EP12: Rust 运行时 + 操作符 + proptest | EP12 W21 |
| W23 | EP07: Tree View + 完善 | EP07 W14 |
| W24 | 集成测试 + 文档 + Phase 2 验收 | 所有 EP |

### 10.5 依赖图

```
EP06 (Go) ─────────────────────→ EP13 (操作符批次2)
                                         ↓
EP10 (仪表板) ───→ EP11 (插件系统) ──→ Phase 2 验收
                                     ↑
EP07 (VS Code) ←── EP08 (Self-Healing)
                     ↑
                   EP09 (变更检测)
                     ↑
                   EP12 (Rust)
```

---

## 11. 验收标准（总）

### 11.1 功能验收

- [ ] Go 和 Rust 项目可正常生成和执行契约测试
- [ ] VS Code 扩展语法高亮、诊断、命令面板正常工作
- [ ] 自我修复能正确分类违约原因并给出建议
- [ ] 变更检测能准确识别受影响的 invariant
- [ ] HTML 报告正确展示契约健康度
- [ ] 插件系统支持第三方操作符和后端
- [ ] 70+ 操作符覆盖所有语言后端

### 11.2 质量验收

- [ ] 所有新增代码测试覆盖率 ≥ 80%
- [ ] 无 TypeScript 类型错误
- [ ] 所有现有测试仍然通过
- [ ] Go 后端生成的代码通过 `go vet`
- [ ] Rust 后端生成的代码通过 `cargo test`

### 11.3 文档验收

- [ ] `docs/go-backend.md` — Go 后端快速入门
- [ ] `docs/vscode-extension.md` — VS Code 扩展指南
- [ ] `docs/self-healing.md` — 自我修复契约指南
- [ ] `docs/plugins.md` — 插件开发指南
- [ ] `docs/rust-backend.md` — Rust 后端快速入门
- [ ] `examples/go-project/` — Go 示例项目
- [ ] `examples/rust-project/` — Rust 示例项目
- [ ] `CHANGELOG.md` 更新
