# Stele Phase 1 需求文档

> 版本: 2.0 | 日期: 2026-05-08 | 状态: 已审查 (Round 1 + Round 2)
> 范围: Phase 1 快速见效（约 11-13 周，2 FTE / 17-20 周，1 FTE）
> 前置: [Phase 0](prd-phase-0.md) 必须先完成
> 审查记录: [Round 1](internal/prd-round-1-review.md) · [Round 2](internal/prd-round-2-review.md)

---

## 目录

1. [概述](#1-概述)
2. [EP01: TypeScript/JavaScript 后端](#2-ep01-typescriptjavascript-后端)
3. [EP02: GitHub Action（含 PR 评论）](#3-ep02-github-action含-pr-评论)
4. [EP03: pre-commit 钩子](#4-ep03-pre-commit-钩子)
5. [EP04: CDL 操作符增强批次 1](#5-ep04-cdl-操作符增强批次-1)
6. [EP05: 增量生成性能优化](#6-ep05-增量生成性能优化)
7. [EP06: Code Shape Python 后端补全](#7-ep06-code-shape-python-后端补全)
8. [EP07: stele why 失败见证](#8-ep07-stele-why-失败见证)
9. [EP08: 多项目支持（--recursive 标志）](#9-ep08-多项目支持--recursive-标志)
10. [EP09: agent-hooks SDK + Cursor 适配器](#10-ep09-agent-hooks-sdk--cursor-适配器)
11. [里程碑和依赖](#11-里程碑和依赖)
12. [验收标准](#12-验收标准)

---

## 1. 概述

### 1.1 目标

扩大语言覆盖、建立 CI 集成、加固 AI 代理护城河。Phase 1 完成后 Stele 需具备：

- TypeScript 项目可用 Vitest 测试契约（Jest 通过 `testFramework` 切换）
- GitHub PR 自动契约验证 + live-updating 评论
- 开发者本地 pre-commit 保护
- 51 → 70 个注册操作符（69 用户面）
- 大型项目增量生成性能（90%+ 加速）
- Python 后端 Code Shape 类声明完整支持
- `stele why` 在违约时显示**哪个**元素**哪个**值导致失败（嵌入 ViolationReport.cause）
- 多项目仓库通过 `--recursive` 标志一次扫描所有子项目契约
- Cursor / Claude Code / Continue.dev 共用的 `@stele/agent-hooks` SDK + 至少一个 Cursor 适配器

### 1.2 设计原则

- **基座先稳后扩**：所有工作叠加在 [Phase 0](prd-phase-0.md) 完成的基座上（npm 发布、≥50% 核心覆盖率、Backend 注册表、一致性测试套件）
- **复用一致性套件**：每个新 backend、每个新 EP 在交付前必须把验收 fixture 加入 `tests/conformance/`
- **跨语言语义先定后写**：操作符必须先在 spec 中钉死语义（regex 方言、取整模式、浮点精度等），再启动多 backend 实现
- **零新功能假设依赖** AI **服务**：所有 Phase 1 功能在离线环境可完整工作；Cursor 适配器明文承认其执行能力的边界
- **狗食**：TypeScript 后端首先保护 Stele 自己的代码库

### 1.3 团队规模假设

本计划假设 **2 FTE 并行执行**（一名核心开发 + 一名集成开发）。单 FTE 执行时间线 1.6×（约 17-20 周）。

### 1.4 v2.0 与 v1.0 PRD 主要差异

参见 [Round 2 审查综合](internal/prd-round-2-review.md)。摘要：

- **EP07 重大变更**：删除 `eval-trace.jsonl` 文件格式；将 `failure_witness` 嵌入到 `ViolationReport.cause`。删除 `stele why --evaluate` 子模式（traces 始终随 `stele check` 产生，由 `stele why <id>` 直接读取）
- **EP08 重大变更**：删除 `stele.workspace.json` 文件格式；改为 `stele check --recursive` / `stele generate --recursive` 标志，walking 嵌套 `stele.config.json` 文件。多项目工作区文件格式延后到 Phase 3
- **EP09 新增**：从 v1.0 Phase 2 EP14 (agent-hooks SDK + Cursor 适配器) 提升到 Phase 1，作为竞争窗口防御
- **EP04 算术修正**：51 + 18 (新) + 1 (filter alias) = 70 注册（69 用户面，filter 是 alias）；`group-by` 延后到 Phase 3（与 `entries` + lambda 一起落地）；原 PRD §5.2.6 的算术不一致已修正
- **路径修正**：`packages/cli/src/init.ts:11` → `packages/cli/src/commands/init.ts:11`

### 1.5 交付物

| # | 交付物 | 包 | 估算 | 关键路径? |
|---|---|---|---|---|
| EP01 | `@stele/backend-typescript` v0.1.0 | 新包 | **3-4 周** | 是 |
| EP02 | `@stele/github-action` v0.1.0 + live PR comment | 新包 | 2-3 周 | 否 |
| EP03 | pre-commit 模板 + `stele init --pre-commit` | `@stele/cli` | 1 周 | 否 |
| EP04 | 操作符 18 个新增 + 1 alias | `@stele/core` + 各后端 | 2-3 周 | 是 |
| EP05 | 增量生成（含 import 依赖图）| `@stele/core` | 2-3 周 | 否 |
| EP06 | Code Shape Python 后端补全 | `@stele/backend-python` | 1-2 周 | 否 |
| EP07 | `stele why` 失败见证 | `@stele/core` + `@stele/cli` | **1 周**（v1.0 是 2-3 周）| 否 |
| EP08 | 多项目 `--recursive` 标志 | `@stele/cli` | **3-5 天**（v1.0 是 2 周）| 否 |
| EP09 | `@stele/agent-hooks` + Cursor 适配器 | 新包 | 3-4 周 | 否 |

合计原始估算：~17-22 周；2 FTE 并行约 11-13 周。

---

## 2. EP01: TypeScript/JavaScript 后端

### 2.1 背景

TypeScript 是 AI 编码的主要语言。Stele 核心本身是 TypeScript 写的，复用 `@stele/core` 的 AST 与校验逻辑。

### 2.2 需求规格

#### 2.2.1 包结构

```
packages/backend-typescript/
  src/
    translator.ts              -- 主翻译器（镜像 backend-python/translator.ts 结构）
    runtime/
      _stele_runtime.ts        -- 运行时辅助（与 Python 等价的 helpers，文件名遵循 coordinator.ts E0505 约定）
      arithmetic.ts            -- add/sub/mul/div/neg/abs/mod/pow/round/ceil/floor
      collection.ts            -- where/forall/exists/none/sum/count/avg/min/max/distinct/length/concat/sort-by
      comparison.ts            -- eq/neq/gt/gte/lt/lte/in/between/approx-eq
      logic.ts                 -- and/or/not/implies/iff/when/if
      string.ts                -- contains/starts-with/ends-with/trim/lower/upper/split/join
      temporal.ts              -- within/after/before/modified/state-before/state-after
      path.ts                  -- 路径访问（kebab-case → camelCase fallback）
      scenario.ts              -- 场景执行（Python 等价 stele_run_scenario）
      checker.ts               -- 自定义 checker 调用（Python 等价 stele_call_checker）
    templates/
      test-file.ts             -- pytest test_*.py 等价的 vitest test 文件模板
    index.ts                   -- LanguageBackend 实现 + 导出
  tests/
    translator.test.ts         -- 操作符翻译单测
    runtime.test.ts            -- 运行时辅助单测
    integration.test.ts        -- 完整 generate + run 流程
```

文件命名遵循 `coordinator.ts:175-213` 强制的 `_stele_runtime${fileExtension}` 命名约定（E0505 错误）。

#### 2.2.2 测试框架

- **默认**: Vitest（新项目推荐）
- **可选**: Jest（用户在 `stele.config.json` 中设 `testFramework: "jest"`）
- 切换通过 generator 阶段切换 emit 模板，**不**通过 runtime 探测
- 仅切换的差异：`expect()` 来源（`vitest` vs `@jest/globals`）、test 修饰符（`it`/`test` 都两边支持）；其余共享

#### 2.2.3 生成文件布局

```
tests/contract/
  _stele_runtime.ts            -- 运行时辅助（@stele/backend-typescript 注入）
  test_contract.ts             -- 主测试（无 group 时）
  test_<group>.ts              -- 各 group 的测试（保持 snake_case 与 Python 后端一致）
  conftest.ts                  -- 用户拥有，不被生成器覆盖（保存 stele_context 装配）
```

**移除**：早期草稿包含 `__init__.js`（Python 习惯泄漏，Node.js 无此约定）。

#### 2.2.4 路径访问语义（与 Python 完全一致）

`steleGetPath(obj, ['account', 'balance-history'])` 必须复刻 Python `_stele_runtime.py` 行为：

```ts
// 简化伪代码
function steleGetPath(obj: unknown, segments: string[]): unknown {
  let current = obj;
  for (const seg of segments) {
    if (current == null) {
      throw new SteleRuntimeError(`Path not found: segment "${seg}" on null/undefined`);
    }
    if (typeof current === "object") {
      // 1. 直接 key 命中
      if (seg in current) {
        current = (current as Record<string, unknown>)[seg];
        continue;
      }
      // 2. kebab-case → camelCase fallback（与 Python 的 snake_case fallback 等价）
      const camel = seg.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (camel in current) {
        current = (current as Record<string, unknown>)[camel];
        continue;
      }
      // 3. 不存在 → 抛错（与 Python 一致）
      throw new SteleRuntimeError(`Path not found: "${seg}" missing on ${typeof current}`);
    }
    throw new SteleRuntimeError(`Path navigation hit non-object at "${seg}"`);
  }
  return current;
}
```

`spec/cdl.md` 必须新增 "Path semantics" 节，明文说明 kebab→camel（TS）/kebab→snake（Python）的双重 fallback **是规范的一部分**。

#### 2.2.5 数值语义

- 默认 `Number` 类型映射到 JS `number`（IEEE-754 双精度）
- **大整数告警**：当 invariant 涉及 `sum`/`avg` 且 collection size > 1000 或单个数值 > Number.MAX_SAFE_INTEGER 时，translator 在生成的注释中加入 warning，建议用户改用 `bigint` 或拆分契约
- 不引入 `bigint` 自动 promotion（保持与 Python 一致的运行时简洁度）

#### 2.2.6 正则语义

- **唯一支持的正则方言**：ECMAScript RegExp 子集，限制为 `re.search` 等价的"任意位置子串匹配"
- TypeScript 后端：`new RegExp(pattern).test(str)`（test 方法不锚定）
- Python 后端必须改为 `re.search(pattern, str) is not None`（非 `re.match`）以保持等价
- `validator/structure-invariant.ts` 在 invariant 解析阶段拒绝下列特性：
  - 锚 `^` `$`（如需可在 pattern 字符串中显式加但被告警）
  - 反向引用 `\1`、`\g<name>`
  - 后顾 `(?<=...)` `(?<!...)`（JS 支持但 v0.2 暂不保证跨 backend 一致）
- 测试：每个支持/拒绝特性必须在 `tests/conformance/` 中有 fixture

#### 2.2.7 Scenario 与 Checker Runtime

**这是 PRD v0.1 完全缺失的部分**。Python `_stele_runtime.py` 提供了 ~120 行的场景执行与 checker 调用代码。TypeScript 后端必须提供等价语义：

| Python helper | TypeScript helper | 语义 |
|---|---|---|
| `stele_run_scenario(steps, ctx)` | `steleRunScenario(steps, ctx)` | 顺序执行 sandbox 步骤，捕获状态 |
| `stele_call_checker(name, args, ctx)` | `steleCallChecker(name, args, ctx)` | 从 `_stele_checkers` 注册表查找并调用 |
| `stele_merge_contexts(a, b)` | `steleMergeContexts(a, b)` | 合并 state-before/state-after |
| `stele_is_modified(before, after, path)` | `steleIsModified(before, after, path)` | 时态变更检测 |
| `_STELE_ALLOWED_MODULES`（白名单）| `STELE_ALLOWED_IMPORTS` | python-import executor 等价的安全约束（v0.2 仅暴露 `Math`、`JSON`，不允许 `fs`/`net`/`process`） |
| `_STELE_BLOCKED_MODULES`（黑名单）| `STELE_BLOCKED_IMPORTS` | 防御深度第二层；TypeScript 等价显式 deny `fs`、`child_process`、`net`、`http`、`https`、`os`、`path` 等 Node 内置 |

**Checker 注入接口**：

```ts
// tests/contract/conftest.ts (用户编写)
import type { SteleContext } from "@stele/backend-typescript";

export const steleContext: SteleContext = {
  account: realAccountSnapshot(),
  positions: loadOpenPositions(),
  _stele_checkers: {
    "balance-change-has-transaction": (args, ctx) => {
      // ...
      return { ok: true };
    },
  },
};
```

`conftest.ts` 用户拥有；生成器不会覆盖。

#### 2.2.8 LanguageBackend 实现

```ts
import type { LanguageBackend, GenerationConfig, GeneratedFile, Contract } from "@stele/core";

const backend: LanguageBackend = {
  name: "typescript",
  framework: "vitest",     // 实际值由 config 决定，由 createBackend 工厂函数注入
  fileExtension: ".ts",
  version: "0.1.0",
  generate(contract: Contract, config: GenerationConfig): GeneratedFile[] {
    // 同步返回，与 LanguageBackend 接口约定一致
    // 不能 async（接口契约）
  },
  supportFiles(contract: Contract, config: GenerationConfig): GeneratedFile[] {
    // 可选，但 TS 后端需要返回 _stele_runtime.ts，所以一定实现
  },
};
export default backend;
```

注意：

- `GenerationConfig`（不是 `GenerateConfig`），与 `packages/core/src/generator/coordinator.ts:9-12` 一致
- 同步返回（不是 `Promise<GeneratedFile[]>`），与接口约定一致
- 通过 `Phase 0 W0.3` 的 backend 注册表装配，不需要修改 `cli` 命令代码

#### 2.2.9 配置扩展

`stele.config.json` 字段（**扩展现有 schema，不替换**）：

```json
{
  "version": "0.1",
  "contractDir": "contract",
  "entry": "main.stele",
  "generatedDir": "tests/contract",
  "checkerImplDir": "contract/checker_impls",
  "manifestPath": "contract/.manifest.json",
  "targetLanguage": "typescript",
  "testFramework": "vitest",
  "pathMode": "auto",
  "protected": ["..."]
}
```

EP01 可选新字段（用于 TypeScript-specific 行为）：

```json
{
  "tsConfigPath": "tsconfig.json",
  "moduleType": "esm"
}
```

`@stele/cli` 的 `init` 命令必须在 `SUPPORTED_LANGUAGES`（`packages/cli/src/commands/init.ts:11`）中添加 `"typescript"`。

### 2.3 非功能性需求

- **生成性能**：100 个 invariant 生成时间 < 1s（GitHub Actions ubuntu-latest 4-core 上测量）
- **类型安全**：生成的 TS 代码通过 `tsc --strict --noEmit`，禁止 `any` 出现在 generator output（仅允许在用户的 `stele_context` 中）
- **测试覆盖**：51 个内置操作符 + EP04 新 18 个 = 69 个用户面操作符翻译都有正反测试
- **Node 版本**：Node.js >= 18 (与 Stele 自身一致)

### 2.4 验收标准

- [ ] **conformance suite**：`tests/conformance/` 5 个 Phase 0 fixture 全部在 TypeScript backend 上通过
- [ ] **跨 backend 一致性**：每个 fixture 在 Python + TypeScript 两个 backend 上 `expected-violations.json` 字节相等（数值类型容差 1e-9）
- [ ] **运行时完整性**：scenario + checker fixture 在 TS backend 上通过，与 Python backend 等价
- [ ] **路径语义**：kebab-case→camelCase fallback 测试通过
- [ ] **Jest 切换**：相同契约在 `testFramework: "jest"` 切换下 emit 文件可被 Jest runner 执行通过
- [ ] **狗食**：在 `packages/core` 中加 `.stele` 文件保护一个核心不变量，`stele check` 通过
- [ ] **类型检查**：emit 的 TS 代码通过 `tsc --strict --noEmit`
- [ ] **生成性能**：100 invariant 套件生成时间在 GitHub Actions ubuntu-latest 4-core CI 环境 < 1s
- [ ] **不可破坏 Python 后端**：现有 Python 后端 conformance fixture 仍全部通过

---

## 3. EP02: GitHub Action（含 PR 评论）

（v2.0 与 v1.0 内容完全一致。略，参见 [PRD v1.0 EP02 章节](internal/prd-round-1-review.md) 与 [Round 2 cross-doc check](internal/prd-round-2-review.md) 对其的 VERIFIED 评级。）

### 3.1 背景

GitHub Actions 是最广泛使用的 CI 平台。一个 workflow 文件即可为每个 PR 添加契约验证。本 EP 同时承担 Action 主体和 live-updating PR 评论功能。

### 3.2 需求规格

#### 3.2.1 Action 类型

**JS Action**（不是 composite）。

```
packages/github-action/
  action.yml                     -- Action 元数据 + 输入定义
  dist/                          -- ncc 打包后的单文件 JS
  src/
    main.ts                      -- 入口分派
    modes/
      check.ts                   -- 运行 stele check
      generate.ts                -- 运行 stele generate（漂移检测）
    annotate.ts                  -- ::error/::warning 行注解
    pr-comment.ts                -- 单个 live-updating PR 评论
    cli-runner.ts                -- 调用 stele 二进制（包含版本检查）
  tests/
    main.test.ts
    pr-comment.test.ts
```

#### 3.2.2 模式

```yaml
- uses: stelehq/stele-action@v1
  with:
    mode: check                       # "check" | "generate"
    diff-from: ${{ github.event.pull_request.base.sha }}
    fail-on: error                    # "error" | "warning" | "all"
    annotate: true                    # 行注解
    pr-comment: true                  # 单个 live-updating 评论
    token: ${{ github.token }}
```

| mode | 行为 | 退出码 |
|---|---|---|
| `generate` | 运行 `stele generate`，比对 git 状态检测漂移 | 0 = 无漂移；2 = 生成漂移 |
| `check` | 运行 `stele check --diff-from <sha>` | 0 = 无违约；3 = manifest 漂移；非零 = 违约（按 fail-on 决定） |

**移除**（自 v1.0）：原 PRD 的 `mode: lock`。**理由**：自动 lock 会在任何人 push 到 main 时静默批准漂移。重新 lock 走专用的 `workflow_dispatch` workflow，不通过 PR Action 自动化。

#### 3.2.3 退出码与字段引用

退出码语义按 [`docs/spec/cdl.md` Exit codes](spec/cdl.md) 钉死：

| 来源 | 退出码 | 含义 |
|---|---|---|
| `stele check` | 2 | 生成的测试与契约不一致 |
| `stele check` | 3 | manifest 校验失败（contract_hash / protected_files 漂移）|
| `stele check` | 1 | 加载失败 / 类型错误 / I/O 错误 |
| `stele generate` | 2 | 生成漂移（仅当 `--check` 模式下）|

**违约本身不是退出码**——通过 `--json` 输出的 `ViolationReport` 表达。Action 的 `fail-on` 决定 violation 是否升级为非零退出。

#### 3.2.4 注解输出

```typescript
// 真实字段（与 packages/core/src/report/types.ts 一致）
interface Violation {
  invariant_id: string;
  severity: "error" | "warning" | "info";
  scope_paths: string[];           // 排序的唯一字符串
  location?: ViolationLocation;    // 可选；若有则含 file/line
  cause: ViolationCause;
  detail?: { message?: string };
}

const file = violation.location?.file ?? violation.scope_paths[0];
const line = violation.location?.line ?? 1;
const sev = violation.severity === "error" ? "error" : "warning";
core[sev](`${violation.detail?.message ?? "Contract violation"}`, {
  title: `Stele: ${violation.invariant_id}`,
  file,
  startLine: line,
});
```

GitHub 限制：单次 check run 最多 50 个 error + 50 个 warning 注解。**当违约数 > 50** 时：

- 保留 severity 最高 + 文件最唯一的 50 条
- 在 PR 评论中列出**所有**违约（评论无 50 条上限）
- Action 输出 summary 写明 "Showing X of Y violations as inline annotations"

#### 3.2.5 Live-updating PR 评论

每次 Action 运行：

1. 用 `gh api repos/{owner}/{repo}/issues/{number}/comments` 列出该 PR 的所有评论
2. 找到 body 以 `<!-- stele-report:v1 -->` 开头的现有评论
3. 如果存在 → `gh api ... PATCH` 更新 body；否则 → `gh api ... POST` 创建新评论
4. 评论 body 模板:

```markdown
<!-- stele-report:v1 -->
## 🛡️ Stele Contract Report

**Status**: ❌ 3 violations | **Run**: [#12345](https://...)

### Violations

#### `BALANCE_NON_NEGATIVE` (error)
- **Where**: `ledger/account.py` (line 42)
- **Cause**: `(gt (path balance) 0)` evaluated to false
- **Witness**: account[3] (id="acc-789") balance=-50, expected > 0
- **Why**: [stele why BALANCE_NON_NEGATIVE](https://...)
- **Suppress**: `npx stele baseline-update --reason "..."`

(2 more...)

---
*This comment auto-updates on every push. Generated at 2026-05-08T10:00:00Z by `@stele/github-action@0.1.0`.*
```

> "Witness" 行使用 EP07 嵌入的 `ViolationReport.cause.failure_witness` 字段。

#### 3.2.6 必需的 GitHub permissions

```yaml
permissions:
  contents: read
  pull-requests: write   # PR 评论
  checks: write          # 注解
```

#### 3.2.7 推荐 Workflow 模板

```yaml
# .github/workflows/stele-check.yml
name: Stele Contract Check

on:
  pull_request:
    branches: [main]

permissions:
  contents: read
  pull-requests: write
  checks: write

jobs:
  stele:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npx stele generate
      - uses: stelehq/stele-action@v1
        with:
          mode: check
          diff-from: ${{ github.event.pull_request.base.sha }}
          annotate: true
          pr-comment: true
          token: ${{ github.token }}
```

### 3.3 非功能性需求

- **首次运行时间**：< 30s（不含 npm install）
- **打包**：`@vercel/ncc` 打包到 `dist/index.js`，单文件 < 5 MB
- **测试**：annotate / pr-comment 各有单测；本地用 `act` 验证

### 3.4 新增依赖

| 依赖 | 用途 | 提供路径 |
|---|---|---|
| `@vercel/ncc` | Action 打包到单文件 dist | npm devDependency |
| `gh` CLI | PR 评论 API | GitHub Actions runner 自带 |

### 3.5 验收标准

- [ ] 在公开示例仓库 PR 触发 Stele check 通过
- [ ] 违约时 PR diff 上 ≤ 50 条注解；超出时评论内列全部
- [ ] PR 评论 live-updating（同一 PR 多次 push 只有一条评论）
- [ ] PR 评论 Witness 字段在 `forall`/`exists` 失败时显示具体元素与值（依赖 EP07）
- [ ] `generate` 模式检测漂移并以退出码 2 失败
- [ ] **不存在** `mode: lock`
- [ ] permissions 不足时给出明确错误信息
- [ ] Action 在 GitHub Marketplace 列出（前置：[Phase 0](prd-phase-0.md) W0.1 npm 发布）

---

## 4. EP03: pre-commit 钩子

（v2.0 与 v1.0 内容完全一致；不重复正文。摘要：）

- 模板：`stele-generate` + `stele-check` 钩子；**不**包含 `stele-lock` pre-push（v1.0 已删除）
- `stele init --pre-commit` 幂等行为（不存在则创建；已含 Stele hooks 则跳过；只含其他 repo 则追加 Stele 块）
- `docs/contributing/pre-commit-setup.md` 文档（含 Windows 注意事项）
- 估算 1 周
- 详细规格见 [v1.0 EP03 §4](internal/prd-round-1-review.md) 中保留的版本

### 4.1 验收标准

- [ ] `stele init --pre-commit` 在新项目中正确生成 `.pre-commit-config.yaml`
- [ ] 同一项目反复运行 `stele init --pre-commit` 不重复 hooks
- [ ] `pre-commit run stele-check --all-files` 拦截违约提交
- [ ] 不存在 `stele-lock` 钩子
- [ ] `docs/contributing/pre-commit-setup.md` 涵盖 Windows 已知问题

---

## 5. EP04: CDL 操作符增强批次 1

### 5.1 现状

注册表当前 **51 个**操作符（`packages/core/src/registry/operators.ts`），CDL 规范文档化 **44 个**（差 7 个：`between`、`approx-eq`、`contains`、`is-empty`、`starts-with`、`ends-with`、`has-length`）。Phase 0 测试债冲刺**不**修复 spec 文档；本 EP 必须先补齐文档再添加新操作符。

### 5.2 操作符清单

#### 5.2.1 集合（4 个）

| 操作符 | 签名 | 语义钉死 |
|---|---|---|
| `length` | `(Collection) -> Number` | 元素数。空集合 → 0 |
| `concat` | `(Collection, Collection, ...) -> Collection` | 任意数量 collection 顺序拼接，保留重复 |
| `sort-by` | `(Collection, Path) -> Collection` | 按路径值升序；缺失值排在末尾；NaN 排在最前 |
| `sort-by-desc` | `(Collection, Path) -> Collection` | 同 sort-by 反向 |

**`group-by` 延后到 Phase 3**（与 `entries` + lambda 一起落地）。理由：返回 `Map<K, Collection>` 类型，用户只有配 lambda 才能消费；v0.2 引入会成死代码。

#### 5.2.2 算术（5 个）

| 操作符 | 签名 | 语义钉死 |
|---|---|---|
| `mod` | `(Number, Number) -> Number` | **取除数符号**（Python 行为）：`mod(-7, 3) = 2`。所有 backend 必须在 runtime 强制此语义 |
| `pow` | `(Number, Number) -> Number` | IEEE-754 双精度 `Math.pow` 等价 |
| `round` | `(Number, Number?) -> Number` | **Banker's rounding**（Python 3 / IEEE-754 默认）：`round(0.5) = 0`、`round(1.5) = 2`。第二参数可选小数位，缺省 0 |
| `ceil` | `(Number) -> Number` | 向 +∞ |
| `floor` | `(Number) -> Number` | 向 -∞ |

#### 5.2.3 字符串（5 个）

| 操作符 | 签名 | 语义钉死 |
|---|---|---|
| `trim` | `(String) -> String` | Unicode whitespace（与 JS `trim()` 一致；Python 后端用 `re.sub(r"^\s+|\s+$", "", s)` 等价） |
| `lower` | `(String) -> String` | Unicode lowercase（locale-independent） |
| `upper` | `(String) -> String` | Unicode uppercase |
| `split` | `(String, String) -> Collection<String>` | **空分隔符抛错**（一致跨语言）。最大切分次数 = 全部 |
| `join` | `(Collection<String>, String) -> String` | 集合元素必须全为 String，否则 `validateTypes` 阶段报错 |

#### 5.2.4 数据访问（1 个，原 PRD 3 个裁剪 2 个）

| 操作符 | 签名 | 语义钉死 |
|---|---|---|
| `type-of` | `(Unknown) -> String` | 返回 "number" / "string" / "boolean" / "collection" / "object" / "null" 之一 |

**裁剪**（v1.0 已决定）：

- `json-path` 移除（JSONPath 方言碎片化）
- `regex-groups` 移除（跨语言 regex 捕获组语义差异大）

#### 5.2.5 来自原 EP13 提前的（3 个 + 1 别名）

| 操作符 | 签名 | 语义钉死 |
|---|---|---|
| `map` | `(Collection, Path) -> Collection` | 提取路径值为新 collection。等价 `[steleGetPath(item, path) for item in coll]` |
| `first` | `(Collection) -> Unknown` | 第一个元素；**空集合抛 SteleRuntimeError**（不返回 null/undefined，跨语言一致） |
| `last` | `(Collection) -> Unknown` | 最后一个元素；空集合抛错 |
| `filter` | `(Collection, Predicate) -> Collection` | **`where` 的别名**（同语义、同绑定方式；翻译时 lower 到同 IR）；为 FP 习惯用户提供 |

### 5.3 总数（v2.0 钉死）

| 类别 | 数量 |
|---|---|
| §5.2.1 集合 | 4 |
| §5.2.2 算术 | 5 |
| §5.2.3 字符串 | 5 |
| §5.2.4 数据访问 | 1 |
| §5.2.5 来自 EP13 提前 | 4（3 新 + 1 alias）|
| **本 EP 新增小计** | **19 注册**（18 新用户面 + 1 alias）|

| 阶段边界 | 注册总数 | 用户面（去 alias）|
|---|---|---|
| Phase 1 起 | 51 | 51 |
| Phase 1 末 (含本 EP) | 51 + 18 (新) + 1 (filter alias) = **70** | 51 + 18 = **69** |

> 注：v1.0 PRD §5.2.6 误算为 "51 + 18 + 5 + 5 + 1 + 3 = 83"；v2.0 修正为 70 注册（69 用户面）。`group-by` 延后到 Phase 3（与 `entries` + lambda 一起落地），不计入 v0.2 总数。

### 5.4 实现范围（每个操作符）

每个操作符需以下 8 项**全部**完成才视为交付：

1. `@stele/core/src/registry/operators.ts`：注册条目
2. `@stele/core/src/validator/types.ts`：类型检查支持
3. `@stele/backend-python/src/translator.ts`：Python 翻译处理器
4. `@stele/backend-python/src/runtime/_stele_runtime.py`：Python runtime helper（如需）
5. `@stele/backend-typescript/src/translator.ts`：TypeScript 翻译处理器
6. `@stele/backend-typescript/src/runtime/_stele_runtime.ts`：TypeScript runtime helper（如需）
7. **conformance fixture**：在 `tests/conformance/fixtures/` 中至少 1 个用例覆盖
8. **正反单测**：在每个 backend 的 translator 测试中各 1 个

**估算**：每操作符约 4-6 小时（含跨 backend）；19 个新注册 ≈ 80-115 小时；并行 2 FTE 约 2-3 周。

### 5.5 文档变更

- `docs/spec/cdl.md`：将 §"Core operators" 从 44 条扩到 70 条用户面（+ 1 内部），每条钉死跨语言语义
- 新增 "Path semantics" 节（参见 EP01 §2.2.4）
- 新增 "Operator semantics across backends" 章节
- CI lint：操作符总数与注册表自动对齐（差异 → fail）

### 5.6 验收标准

- [ ] 19 个新操作符（18 新 + 1 filter alias）注册到核心注册表
- [ ] 51 + 18 = 69 用户面操作符在 Python 与 TypeScript backend 翻译都通过
- [ ] 每个新用户面操作符在 `tests/conformance/` 至少有 1 个 fixture，**两个 backend 输出 byte-equal**
- [ ] `mod`、`round`、`split` 边界条件测试通过（负数、空分隔符等）
- [ ] `docs/spec/cdl.md` 操作符总数与注册表一致（CI lint 校验）
- [ ] `filter` 与 `where` 在 conformance suite 上产生**字节相同**的生成代码
- [ ] **不存在** `group-by` 注册（Phase 3 候选；与 `entries` + lambda 一起落地）

---

## 6. EP05: 增量生成性能优化

### 6.1 背景与架构纠正（与 v1.0 同）

PRD v0.1 草稿"对每个 .stele 文件计算哈希"忽略 import 依赖图。v1.0 修正为 transitive_hash 算法。v2.0 在此基础上**进一步加固**两点：

- 引入 `operator_registry_hash`：后端 bug-fix release 在 `stele_version` 不变时改变 emit 时仍能正确失效
- 显式指明 `normalize` = `@stele/core` 的 `normalizeContract`

### 6.2 需求规格

#### 6.2.1 缓存路径

```
contract/.cache/
  hash-manifest.json
```

#### 6.2.2 Schema

```typescript
interface HashManifest {
  version: string;                     // "1"
  generated_at: string;                // ISO 8601
  stele_version: string;               // 生成时的 CLI 版本
  backend: string;                     // 生成时的 targetLanguage
  operator_registry_hash: string;      // SHA-256 of CORE_OPERATOR_SPECS（v2.0 新增）
  config_hash: string;                 // SHA-256 of stele.config.json
  files: Record<string, {
    own_hash: string;                  // 文件本身归一化后的哈希（normalizeContract → SHA-256）
    transitive_hash: string;           // 含传递依赖的哈希
    deps: string[];                    // 直接依赖文件相对路径（排序）
    output_paths: string[];
    output_hashes: Record<string, string>;
  }>;
}
```

snake_case 与 `packages/core/src/manifest/manifest.ts` 现有约定一致。

#### 6.2.3 算法

```
1. 读取 contract/.cache/hash-manifest.json
2. 失效检查（任一不匹配则全量失效）：
   a. config_hash mismatch → 全量
   b. backend mismatch → 全量
   c. stele_version mismatch → 全量（保守）
   d. operator_registry_hash mismatch → 全量（v2.0 新增；后端 bug-fix release 也强制 invalidate）
3. loadContract 得到 import DAG
4. 对每个 .stele 文件 f：
   a. own_hash[f] = SHA-256(normalizeContract(f).serialized) — 显式使用 @stele/core 的 normalizer
   b. 拓扑排序后 transitive_hash[f] = SHA-256(own_hash[f] || sort(transitive_hash[d] for d in deps))
   c. 比对 manifest.files[f].transitive_hash
5. 删除 manifest.files 中不再存在的 .stele 对应的 output_paths
6. 重新生成被标记文件，更新 manifest（atomic rename）
```

`normalizeContract` 引用：`@stele/core/src/normalizer/normalize.ts`（在 `index.ts:42` 导出）。

#### 6.2.4 并发安全

- 写 `hash-manifest.json` 用临时文件 + atomic `rename()`
- 读 manifest 容忍部分写入：JSON parse 失败 → 视为无缓存，全量
- 不主动加文件锁；并发 `stele generate` 落败者退化为全量

#### 6.2.5 CLI

```bash
stele generate            # 默认增量
stele generate --force    # 全量（忽略缓存）
stele generate --no-cache # 全量但不写缓存
stele cache clean         # 清缓存
stele cache info          # 显示缓存条目数与大小
```

#### 6.2.6 Migration 注

**这是一项行为变更，非纯加性**：v0.1 的 `stele generate` 默认全量；v0.2 默认增量。Migration 文档（`docs/contributing/migration-v0.2.md`）须说明：

- 现有 CI/local 流程**不需要变更**；增量结果与全量 byte-equal（acceptance 验证）
- 如需保持 v0.1 行为：使用 `stele generate --force`
- 缓存目录 `contract/.cache/` 可由用户的 `.gitignore` 排除（推荐，但 Stele 不强制）

### 6.3 非功能性需求

- **性能**：100 个 .stele 文件项目，单文件改动场景生成时间减少 ≥ 90%
- **正确性**：增量生成结果与全量生成结果**byte-equal**

### 6.4 验收标准

- [ ] **import 依赖正确性**：改 B.stele 时，所有 import 它的文件被重新生成
- [ ] config 改动 → 全量失效
- [ ] CLI 升级（stele_version 变化）→ 全量失效
- [ ] 操作符注册表变化（operator_registry_hash 变化）→ 全量失效
- [ ] 缓存损坏 → 优雅退化为全量
- [ ] 并发两个 `stele generate` 不互相破坏
- [ ] 增量与全量输出**byte-equal**（用 conformance suite 5 个 fixture 双跑验证）
- [ ] Migration 文档 `docs/contributing/migration-v0.2.md` 含本节内容

---

## 7. EP06: Code Shape Python 后端补全

（v2.0 与 v1.0 内容完全一致。摘要：）

补齐 v0.1 Python 后端对 `boundary` / `class-shape` / `function-shape` / `type-policy` / `file-policy` 的翻译；当前仅生成 placeholder 注释。

新增 runtime helpers：`stele_resolve_class`、`stele_resolve_function`、`stele_check_function_signature`、`stele_check_file_policy`。`_STELE_ALLOWED_MODULES` 白名单扩展支持 `inspect`、`importlib`。

新增 conformance fixture `tests/conformance/fixtures/06-code-shape/`。

### 7.1 验收标准

- [ ] 5 种 shape 在 Python backend 上生成可执行的 pytest assertion
- [ ] runtime helpers 通过 Python pytest 单测
- [ ] conformance fixture 06 通过
- [ ] `_STELE_ALLOWED_MODULES` 白名单变更不破坏现有 fixtures
- [ ] `examples/finance-guard/` 添加 1 个 class-shape 演示

---

## 8. EP07: stele why 失败见证

### 8.1 v2.0 重大变更

v1.0 提议持久化 `contract/.cache/eval-trace.jsonl` 文件 + `stele why --evaluate` 重新运行 pytest。**v2.0 删除文件格式与重运行子模式**，改为：

- 在 `forall`/`exists`/`where` runtime helpers 中**始终**捕获**单步失败见证**
- 失败见证嵌入到 `ViolationReport.cause.failure_witness` 字段（`@stele/core/src/report/types.ts`）
- `stele why <invariant-id>` 直接读取最近一次 `stele check` 的 violation report，渲染 witness
- 没有新文件，没有重运行，没有 `STELE_TRACE` 环境变量，没有 pytest-xdist 并发问题

理由（[Round 2 战略反虚饰审查](internal/prd-round-2-review.md) §4）：

- 持久化 trace 文件违反"determinism is load-bearing"（架构白皮书）
- pytest-xdist 并行写入 jsonl 是设计噩梦
- 单步见证（哪个元素、哪个值）已覆盖 80%+ 用户场景
- 多步 trace（每个 sub-evaluation）作为 Phase 3 候选保留

### 8.2 需求规格

#### 8.2.1 ViolationReport 扩展

`@stele/core/src/report/types.ts` 中 `ViolationCause` 类型新增可选字段：

```typescript
export interface ViolationCause {
  kind: "assertion-failed" | "checker-error" | ...;  // 现有
  expected_value?: unknown;                           // 现有
  actual_value?: unknown;                             // 现有
  // v2.0 新增：
  failure_witness?: FailureWitness;
}

export interface FailureWitness {
  /** 触发失败的操作符（forall/exists/where 等）*/
  operator: string;
  /** 集合长度（forall/exists 适用）*/
  collection_size?: number;
  /** 失败发生在第几个元素（forall/exists/where 适用）*/
  failed_at_index?: number;
  /** 失败元素的浅层快照（max_depth=2，敏感字段已 redact）*/
  failed_item?: unknown;
  /** 失败子表达式的源代码字符串（如 "(gt (path balance) 0)"）*/
  predicate_source?: string;
  /** 子表达式逐步求值（仅 1 层；见 §8.2.4 redaction 与 budget）*/
  sub_evaluations?: Array<{
    expression: string;
    value: unknown;
  }>;
}
```

#### 8.2.2 Runtime helper 行为

每个集合类操作符（`forall`、`exists`、`where`、`none`）的 Python/TypeScript runtime helper 在失败时**就地构造** `FailureWitness` 并通过 helper 的返回值/异常对象向上传播。

```python
# Python runtime
def stele_forall(collection, predicate, predicate_source):
    for i, item in enumerate(collection):
        result = predicate(item)
        if not result:
            raise SteleAssertionFailed(
                operator="forall",
                witness={
                    "operator": "forall",
                    "collection_size": len(collection),
                    "failed_at_index": i,
                    "failed_item": _safe_serialize(item, max_depth=2),
                    "predicate_source": predicate_source,
                },
            )
    return True
```

`SteleAssertionFailed` 继承自 `AssertionError`；pytest 捕获后由 conftest fixture 提取 witness 写入 violation report。

#### 8.2.3 命令行行为

```bash
stele why <invariant-id>          # 静态：契约 + rationale + 最近 witness（如有）
stele why <fingerprint>           # 通过违约 fingerprint 反查
stele why <id> --json             # 机器可读
```

**移除**：v1.0 的 `--evaluate` 子模式（不再单独重运行）。

#### 8.2.4 安全：witness 数据 redaction 与 budget

- `_safe_serialize(item, max_depth=2)` 限制嵌套深度，防止深度对象图把 witness 撑爆
- 单个 witness 序列化后 ≤ 16 KB（超过截断）
- 字段名包含 `password`、`token`、`secret`、`api_key`（不区分大小写）→ 替换为 `"<redacted>"`
- 用户可通过 `stele.config.json` 的 `witnessRedactionPatterns: string[]` 扩展

#### 8.2.5 输出渲染

```
$ stele why BALANCE_NON_NEGATIVE

Invariant: BALANCE_NON_NEGATIVE
Severity: error
Description: Account balance must be non-negative.

Last check: 2026-05-08T10:00:00Z (failed)

Failure witness:
  operator: forall
  collection_size: 47
  failed at index: 3
  failed item: { "id": "acc-789", "balance": -50, "currency": "USD" }
  predicate: (gt (path balance) 0)

How to fix:
  - Inspect ledger/account.py near accounts[3] (acc-789)
  - Run: stele check --diff-from main 看变更
  - Suppress (only if intentional): npx stele baseline-update --reason "..."
```

### 8.3 不在范围内

- 多步 sub_evaluation trace（Phase 3 候选；触发条件"用户报告 single-step witness 不够用"）
- AI 解释建议（保持确定性；架构白皮书要求）
- 修复建议（参见已丢弃的原 EP08）

### 8.4 验收标准

- [ ] `forall`/`exists`/`where`/`none` 失败时 ViolationReport 含 `failure_witness`
- [ ] `stele why <id>` 显示 witness 与"如何修复"
- [ ] `--json` 输出 schema 文档化在 `docs/spec/cli-output.md`（**不**在 cdl.md，因为是 CLI 输出 schema）
- [ ] witness 序列化 ≤ 16 KB；超过截断并标记
- [ ] 敏感字段 redaction 工作（password/token/secret/api_key）
- [ ] conformance fixture 验证 witness 在 Python + TypeScript backend 上**结构等价**（字段名、嵌套关系一致；具体值因 backend 而异允许）
- [ ] **零额外文件**写入 `contract/.cache/` 或其他位置
- [ ] **零额外环境变量**（无 STELE_TRACE）
- [ ] baseline-suppressed violation 仍含 witness（suppression 在 report 层，witness 在 runtime 层；两者解耦）

---

## 9. EP08: 多项目支持（--recursive 标志）

### 9.1 v2.0 重大变更

v1.0 提议引入 `stele.workspace.json` 文件格式 + 拓扑排序 + 共享 imports。**v2.0 删除整个文件格式**，改为更简洁的 `--recursive` 标志方案。理由：

- v0.1 已支持每子目录独立 `stele.config.json`（loadConfig 从 cwd 向上解析）
- 用户当前唯一未解决的痛点是"在仓库根一次性扫描所有子项目"——这只需要一个 `--recursive` 标志，不需要新文件格式
- 拓扑排序、共享 imports、`depends-on` 都属于"用户没正式请求过"的特性
- 新文件格式一旦发布就成永久 API 包袱

完整工作区文件格式延后到 Phase 3 候选（触发条件："首次书面用户请求"）。

### 9.2 需求规格

#### 9.2.1 命令行扩展

```bash
# 在仓库根目录
stele check --recursive             # 自动发现所有 stele.config.json 子项目并按目录字典序逐项 check
stele generate --recursive          # 同上
stele lock --recursive --reason "..." # 同上（require --reason 仍强制）

# 单项目模式（默认；与 v0.1 一致）
stele check                          # 在当前目录或祖先目录找 stele.config.json
```

#### 9.2.2 自动发现

`--recursive` 模式下：

- 从指定目录（默认 cwd）出发，递归扫描所有子目录
- 跳过 `.git/`、`node_modules/`、`__pycache__/`、`.venv/`、`.pnpm-store/`
- 对每个找到的 `stele.config.json`，提取所在目录作为 project root
- 按 project root 路径字典序遍历
- 每个项目独立调用 `loadConfig(projectRoot)` + 后续 check/generate/lock 逻辑

#### 9.2.3 与 BackendRegistry 的交互

Phase 0 W0.3 的 `loadBackend(language, framework)` 是无状态的工厂函数，每次调用都根据传入参数动态 import backend 包。多项目下：

- 项目 A `targetLanguage: "python"` → loadBackend 返回 backend-python 实例
- 项目 B `targetLanguage: "typescript"` → loadBackend 返回 backend-typescript 实例
- 两次调用互不干扰

CLI 在 `--recursive` 模式下**为每个项目独立 load backend**，不缓存全局单例。

#### 9.2.4 输出与退出码

每个子项目的输出按以下格式分组：

```
[1/3] checking ./packages/core
  ✓ check passed (12 invariants, 0 violations)

[2/3] checking ./packages/cli
  ✗ check failed: 2 violations
  ...

[3/3] checking ./apps/api
  ✓ check passed (8 invariants, 0 violations)

Summary: 2/3 projects passed; 1/3 failed.
```

退出码：**所有项目都成功 → 0；任何一个失败 → 取该项目的退出码（多个失败时取最大值）**。`--json` 输出包含 per-project 子报告。

#### 9.2.5 Migration

**纯加性**：

- 单项目用法（无 `--recursive`）行为与 v0.1 完全一致
- 没有新配置文件，没有新 schema
- 用户从 monorepo 中希望一次扫描时直接加 `--recursive`

#### 9.2.6 不在范围内

| 功能 | 处置 |
|---|---|
| `stele.workspace.json` 文件格式 | Phase 3 候选；触发"首次书面用户请求" |
| 项目间 `depends-on` / 拓扑排序 | 同上 |
| `shared_imports` 跨项目共享 CDL | 同上；用户当前可用相对路径 import |
| `stele init --workspace` | 不需要（无文件格式则无需 init）|

### 9.3 验收标准

- [ ] `stele check --recursive` 在 `examples/monorepo-demo/` 三项目环境正确发现并执行
- [ ] 项目间 `targetLanguage` 异构（Python + TypeScript 共存）正确装载各自 backend
- [ ] 退出码：全部成功 0；任一失败时取最大错误码
- [ ] `--json` 输出含 per-project 子报告
- [ ] `--recursive` 跳过 `.git/`、`node_modules/`、`.venv/` 等忽略目录
- [ ] **不存在** `stele.workspace.json` 解析逻辑（PRD 与代码均无）
- [ ] 单项目用法（无 `--recursive`）行为与 v0.1 完全一致
- [ ] `examples/monorepo-demo/` 演示 + `docs/guides/monorepo.md` 文档

---

## 10. EP09: agent-hooks SDK + Cursor 适配器

> 注：v1.0 时 EP14 在 Phase 2；v2.0 提到 Phase 1 EP09 作为竞争窗口防御。

### 10.1 背景

竞品分析（`docs/strategy/competitive-analysis.md`）：Cursor 是最大的 AI IDE，Stele 没有覆盖。Phase 1 的 Claude Code 插件 + Phase 2 的 VS Code 扩展加起来仍未触及 Cursor 用户。通用 `@stele/agent-hooks` SDK 把 Claude Code 插件中的 PreToolUse / Stop / SessionStart 模式抽象为编辑器无关的 SDK，并提供至少 1 个适配器（Cursor）。

### 10.2 关于"hooks 强度"的诚实表述

Cursor 的 hook 机制不等价于 Claude Code：

- Claude Code: 提供 `PreToolUse` 钩子可硬阻止（deny）任意工具调用
- Cursor: 仅提供 `.cursor/rules/*.md` 静态规则（注入到 prompt）+ composer rules（动态触发 shell）；**没有等价 PreToolUse 的硬阻止**

因此 Cursor 适配器仅提供：

- ✅ 层 1 (CDL) + 层 2 (生成测试) 通过 CLI / CI fallback 完整保护（与所有用户一致）
- ✅ 层 3 (编辑器钩子) 的**最佳努力上下文注入**——agent **可以**忽略 .cursor/rules（架构白皮书警示的失效模式）
- ✅ Composer rule shell hook 触发 `stele check`——是 Cursor 上最接近 PreToolUse 的可用机制

EP02 GitHub Action 是 Cursor 用户的硬强制层。

### 10.3 需求规格

#### 10.3.1 SDK 包结构

```
packages/agent-hooks/
  src/
    index.ts                   -- 公共 API
    protocol.ts                -- 通用 hook 协议
    adapters/
      claude-code.ts           -- 把现有 Claude Code 插件 hooks 适配为 SDK 形式
      cursor.ts                -- Cursor 适配器
      continue-dev.ts          -- 仅 SDK 层接口（完整适配器留 Phase 3）
    handlers/
      pre-edit-protect.ts      -- 通用 PreToolUse 等价
      post-edit-observe.ts     -- 通用 PostToolUse 等价
      session-start-context.ts
      stop-validate.ts
  tests/
    adapters/
      claude-code.test.ts
      cursor.test.ts
```

#### 10.3.2 通用 Hook 协议

```typescript
export interface AgentHookContext {
  agent: "claude-code" | "cursor" | "continue-dev" | string;
  tool: string;
  args: Record<string, unknown>;
  projectRoot: string;
  prompt?: string;
}

export interface HookDecision {
  action: "allow" | "deny" | "warn";
  reason?: string;
  injectContext?: string;
}

export interface PreEditHook {
  (ctx: AgentHookContext): Promise<HookDecision>;
}
```

`@stele/agent-hooks` 提供：

- `createPreEditProtect(steleConfig)` —— 复用 Claude Code 插件 `pre-tool-protect.js` 的核心逻辑
- `createSessionStartContext(steleConfig)` 
- `createStopValidate(steleConfig, runStele)`

#### 10.3.3 Claude Code 适配器（refactor）

`@stele/claude-code-plugin` 现有 hooks 重构为消费 `@stele/agent-hooks`：

```typescript
// 重构后的 packages/claude-code-plugin/scripts/pre-tool-protect.js
import { createPreEditProtect, ClaudeCodeAdapter } from "@stele/agent-hooks";
const hook = createPreEditProtect(loadConfig());
const adapter = new ClaudeCodeAdapter();
await adapter.run(hook);
```

行为完全等价；`packages/claude-code-plugin/tests/` 的 6 个现有测试文件（`hooks-config.test.ts`、`lifecycle-context.test.ts`、`observation-hook-extended.test.ts`、`observation-hook.test.ts`、`pre-tool-protect.test.ts`、`stop-validate.test.ts`）必须**全部继续通过**。

> v1.0 PRD 写"8 个 conformance test"是错的；实际是 6 个 test 文件，验收按文件聚合。

#### 10.3.4 Cursor 适配器

策略（与 §10.2 诚实表述一致）：

1. **静态规则注入**：`createCursorRulesFile(steleConfig)` 生成 `.cursor/rules/stele.md`：
   - 受保护文件 glob 列表
   - 当前 invariant 的 id 与 description（不含 rationale 的敏感细节）
   - 关键 CDL 规则的自然语言摘要
2. **动态规则**（用户配置允许时）：`stele install --agent cursor --enable-shell` 在 `.cursor/composer/stele-check.sh` 写入运行 `npx stele check` 的脚本
3. **PR 时强制**：依赖 EP02 GitHub Action（Cursor 客户端无强制能力）

**安装命令**：

```bash
npx stele install --agent cursor                  # 仅静态规则
npx stele install --agent cursor --enable-shell   # 静态规则 + composer shell hook
npx stele install --agent cursor --uninstall      # 移除
```

#### 10.3.5 Continue.dev 适配器

v0.2 仅提供 SDK 接口（`adapters/continue-dev.ts` 含设计签名），**不交付**完整 Continue.dev 集成。完整适配器作为 Phase 3 候选（触发"Continue.dev SDK 接口稳定"）。

### 10.4 与未来 EP11（VS Code MVP）的关系

Phase 2 EP11 (VS Code 扩展 MVP) 与本 EP 互补不重叠：

| 维度 | EP11 (VS Code 扩展) | EP09 (agent-hooks SDK) |
|---|---|---|
| 用户 | 不用 AI agent 的 VS Code 用户 | 用 AI agent 的开发者 |
| 触发 | 文件保存 | agent 工具调用 |
| 主要功能 | 内联诊断 | 编辑前拦截 + 上下文注入 |
| 强制性 | 软（可绕过）| 硬（PreToolUse deny；Cursor 适配器是软）|

### 10.5 安全约束

- Cursor 适配器**默认不**安装代码执行钩子，除非用户在 `--enable-shell` 显式启用
- 静态规则文件不含敏感信息（不导出 stele.config.json 全部内容，仅 invariant id + description）
- agent-hooks SDK 不依赖任何外部网络服务

### 10.6 新增依赖

| 依赖 | 用途 | 是否新增 |
|---|---|---|
| 无外部 npm 依赖 | SDK 与适配器是纯 TS | 仅 workspace 内部依赖 |

### 10.7 验收标准

- [ ] `@stele/agent-hooks` 公开 API 文档化（`docs/guides/agent-hooks-sdk.md`）
- [ ] Claude Code 插件重构后**全部 6 个 tests 文件**通过（无新增 fail，无 skip）
- [ ] `stele install --agent cursor` 在 examples/finance-guard 生成有效 `.cursor/rules/stele.md`
- [ ] `stele install --agent cursor --enable-shell` 生成有效 composer shell script
- [ ] `stele install --agent cursor --uninstall` 干净撤销
- [ ] Cursor 适配器在真实 Cursor 客户端中加载（人工验证 + 截图归档）
- [ ] Continue.dev SDK 层签名稳定（design review approved）
- [ ] `docs/guides/agent-hooks-sdk.md` + `docs/guides/cursor-integration.md` 完整
- [ ] PRD 与文档**明文承认 Cursor 适配器是软约束**，硬强制依赖 CI（EP02）

---

## 11. 里程碑和依赖

### 11.1 团队 2 FTE 规划（11-13 周）

| 周 | Eng A（核心 + Cursor）| Eng B（集成 + 操作符）|
|---|---|---|
| W0 | Phase 0 W0.2 测试债 | Phase 0 W0.1 npm 发布 + W0.3 Backend 注册表 |
| W0+ | W0.4 conformance suite | W0.4 conformance suite（共建）|
| W1-2 | EP01 TS 后端骨架 + 操作符翻译核心 | EP02 GitHub Action 主体 |
| W3 | EP01 runtime + scenario/checker | EP02 PR comment + EP03 pre-commit |
| W4 | EP01 完成 + 狗食 | EP06 Code Shape Python 补全 |
| W5-6 | EP04 操作符批次 1 | EP05 增量生成（含依赖图、operator_registry_hash）|
| W7 | EP07 stele why 失败见证（嵌入 ViolationReport）| EP08 `--recursive` 标志（3-5 天）+ 文档 |
| W8 | EP09 agent-hooks SDK 设计 + Claude Code 重构 | EP09 Cursor 适配器 |
| W9 | EP09 Cursor 测试 + 文档 | conformance suite 扩充 + 验收 |
| W10-11 | 集成测试 + Marketplace 提交 | 文档收尾 + 发布前修复 |
| (W12-13) | 缓冲 / 回归修复 | 缓冲 |

### 11.2 单 FTE 规划（17-20 周）

EP01 后串行：EP02 → EP03 → EP04 → EP05 → EP06 → EP07 → EP08 → EP09。无并行。

### 11.3 依赖图

```
Phase 0 (W0)
   │
   ├──→ EP01 (TS 后端) ─────────┐
   │                              │
   ├──→ EP02 (GH Action) ←────── │  (EP02 依赖 W0.1 npm 发布)
   │       │                      │
   │       └──→ PR comment        │
   │                              │
   └──→ EP03 (pre-commit)         │
                                  ↓
                              EP04 (操作符)
                                  │
                                  ↓
                              EP05 (增量)
                                  │
                                  ↓
                              EP06 (Code Shape)
                                  │
                                  ↓
                              EP07 (stele why witness)─→ feeds EP02 PR comment
                                  │
                                  ↓
                              EP08 (--recursive)
                                  │
                                  ↓
                              EP09 (agent-hooks SDK + Cursor)
                                  │
                                  ↓
                          Phase 1 验收
```

### 11.4 关键路径

`Phase 0 → EP01 → EP04 → EP05` 是关键路径。EP07 看似在末尾但实际上在 EP02 PR comment 文档化"witness 字段"前必须完成 schema（建议 EP07 在 W7 上半部完成）。

---

## 12. 验收标准（总）

### 12.1 Phase 0 前置（每项必须为真）

- [ ] @stele/core 测试覆盖率 ≥ 50%
- [ ] @stele/* 已发布到 npm registry
- [ ] Backend 注册表替换硬编码调度
- [ ] tests/conformance/ 5 个 fixture 在 Python backend 通过

### 12.2 功能验收

- [ ] TypeScript 项目可用 Vitest 生成与执行契约测试
- [ ] Jest 切换工作（同 fixture 在两个 framework 下输出等价）
- [ ] GitHub PR 触发 Stele check 并获得 live-updating 评论（含 EP07 witness）
- [ ] pre-commit 钩子拦截违约提交
- [ ] 51 + 18 = **69 用户面操作符**跨 Python/TypeScript backend 一致（70 注册）
- [ ] 增量生成在 100 文件单改场景加速 ≥ 90%（含 operator_registry_hash 失效测试）
- [ ] Code Shape 5 种声明在 Python backend 真正执行
- [ ] `stele why <id>` 显示 failure_witness（嵌入 ViolationReport，零新文件）
- [ ] `stele check --recursive` 在 examples/monorepo-demo 工作
- [ ] `@stele/agent-hooks` SDK + Cursor 适配器在真实 Cursor 客户端工作

### 12.3 质量验收

- [ ] 所有新增代码测试覆盖率 ≥ 80%
- [ ] 全部 conformance fixture（Phase 0 五个 + EP04 新增 + EP06 新增 + EP08 新增 + EP09 新增）通过
- [ ] 全部 861（Phase 0 W0.2 baseline）+ Phase 0 + Phase 1 新增测试通过
- [ ] tsc --strict --noEmit 无错误
- [ ] 生成代码无 `any`（generator output）
- [ ] 不引入新的 `contract/.cache/eval-trace.jsonl` 或类似 trace 文件（EP07 不允许）
- [ ] 不引入 `stele.workspace.json` 解析（EP08 不允许）

### 12.4 文档验收

- [ ] `docs/guides/typescript-integration.md`
- [ ] `docs/guides/github-actions.md`
- [ ] `docs/contributing/pre-commit-setup.md`（含 Windows）
- [ ] `docs/spec/cdl.md` —— 操作符列表更新到 70 注册（69 用户面），新增 "Path semantics"、"Operator semantics across backends"
- [ ] `docs/spec/cli-output.md` —— **新建**：含 `stele check --json`、`stele why --json`、`stele check --recursive --json` schema
- [ ] `docs/guides/monorepo.md` —— `--recursive` 用法
- [ ] `docs/guides/agent-hooks-sdk.md` + `docs/guides/cursor-integration.md`
- [ ] `docs/contributing/migration-v0.2.md` —— EP05 默认增量行为变更
- [ ] `examples/typescript-project/`
- [ ] `examples/monorepo-demo/`
- [ ] `examples/cursor-demo/`
- [ ] `CHANGELOG.md` 0.2.0 段落
