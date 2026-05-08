# Stele Phase 1 需求文档

> 版本: 0.1 | 日期: 2026-05-08 | 状态: 草稿
> 范围: 第一阶段快速见效（1-2个月）

---

## 目录

1. [概述](#1-概述)
2. [EP01: TypeScript/JavaScript 后端](#2-ep01-typescriptjavascript-后端)
3. [EP02: GitHub Actions 集成](#3-ep02-github-actions-集成)
4. [EP03: pre-commit 钩子](#4-ep03-pre-commit-钩子)
5. [EP04: CDL 操作符增强（批次 1）](#5-ep04-cdl-操作符增强批次-1)
6. [EP05: 增量生成性能优化](#6-ep05-增量生成性能优化)
7. [里程碑和依赖](#7-里程碑和依赖)
8. [验收标准](#8-验收标准)

---

## 1. 概述

### 1.1 目标

扩大语言覆盖，建立 CI 集成，提升核心体验。Phase 1 完成后 Stele 需具备：

- TypeScript 项目可用 Vitest/Jest 测试契约
- GitHub PR 自动契约验证
- 开发者本地 pre-commit 保护
- 46+ 个操作符扩展至 60+ 个
- 大型项目增量生成性能

### 1.2 设计原则

- **向后兼容**: 所有变更不破坏现有 Python 后端和 CLI 命令
- **复用**: TypeScript 后端复用 `@stele/core` 的 AST 类型和校验逻辑
- **零配置优先**: GitHub Actions 和 pre-commit 开箱即用
- **狗食**: TypeScript 后端首先保护 Stele 自己的代码库

### 1.3 交付物

| # | 交付物 | 包 | 估算 |
|---|--------|-----|------|
| EP01 | `@stele/backend-typescript` | 新包 | 2-3 周 |
| EP02 | `@stele/github-action` | 新包 | 1-2 周 |
| EP03 | pre-commit 模板和文档 | `@stele/cli` | 1 周 |
| EP04 | 操作符 14+ 个 | `@stele/core` + 各后端 | 1-2 周 |
| EP05 | 增量生成 | `@stele/core` | 2 周 |

---

## 2. EP01: TypeScript/JavaScript 后端

### 2.1 背景

TypeScript 是 AI 编码的主要语言（LangChain、Vercel AI SDK、Zod、Express 全部是 TS），且 Stele 核心本身是 TypeScript 写的。实现成本最低，市场价值最高。

### 2.2 需求规格

#### 2.2.1 包结构

```
packages/backend-typescript/
  src/
    translator.ts              -- 主翻译器（镜像 backend-python/translator.ts）
    runtime.ts                 -- TypeScript 运行时源输出
    templates/
      comparison.ts            -- eq, neq, gt, gte, lt, lte, in, between, approx-eq
      arithmetic.ts            -- add, sub, mul, div, neg, abs
      collection.ts            -- collection, sum, count, avg, min, max, where, forall, exists, none, distinct, unique, is-empty, has-length
      logic.ts                 -- and, or, not, implies, iff, when, if
      temporal.ts              -- within, after, before, modified, state-before, state-after
      string.ts                -- contains, starts-with, ends-with
      path-access.ts           -- path, field, value
    index.ts                   -- LanguageBackend 实现 + 导出
  test/
    operator-coverage.test.ts  -- 所有操作符的翻译测试
    integration.test.ts        -- 端到端生成 + 执行测试
```

#### 2.2.2 测试框架选择

- **主框架: Vitest**（新项目的默认选择，Jest 兼容 API）
- **兼容层: Jest**（通过配置 `stele.config.json` 的 `framework: "jest"` 开关）
- 断言: Vitest/Jest 内置 `expect`

#### 2.2.3 生成文件

每个契约生成以下文件：

```
tests/contract/
  stele-runtime.ts             -- 运行时辅助函数（路径导航、集合操作、聚合）
  __init__.js                  -- 空文件，确保目录被识别为包
  test_contract.ts             -- 主测试文件
  test_<group>.ts              -- 每个 group 一个测试文件（可选）
```

#### 2.2.4 运行时辅助函数

`stele-runtime.ts` 提供：

```typescript
// 路径导航
export function steleGetPath(obj: unknown, pathSegments: string[]): unknown

// 集合操作
export function steleWhere(collection: unknown[], predicate: (item: unknown) => boolean): unknown[]
export function steleForEach(collection: unknown[], predicate: (item: unknown) => boolean): boolean
export function steleExists(collection: unknown[], predicate: (item: unknown) => boolean): boolean
export function steleNone(collection: unknown[], predicate: (item: unknown) => boolean): boolean

// 聚合
export function steleSum(collection: unknown[], pathSegments: string[]): number
export function steleAvg(collection: unknown[], pathSegments: string[]): number
export function steleCount(collection: unknown[]): number
export function steleDistinct(collection: unknown[], pathSegments: string[]): unknown[]

// 字符串
export function steleContains(str: string, substr: string): boolean
export function steleStartsWith(str: string, prefix: string): boolean
export function steleEndsWith(str: string, suffix: string): boolean
```

#### 2.2.5 操作符翻译映射

| CDL 操作符 | TypeScript 表达 | 示例 |
|-----------|----------------|------|
| `forall` | `collection.every(predicate)` | `(forall (collection accounts) (gt (path balance) 0))` → `accounts.every(a => steleGetPath(a, ["balance"]) > 0)` |
| `exists` | `collection.some(predicate)` | |
| `where` | `collection.filter(predicate)` | |
| `sum` | `collection.reduce((s, i) => s + steleGetPath(i, path), 0)` | |
| `matches` | `RegExp.test(str)` | |
| `in` | `array.includes(value)` | |

#### 2.2.6 `LanguageBackend` 接口实现

```typescript
import type { LanguageBackend, Contract, GenerateConfig, GeneratedFile } from "@stele/core";

export class TypeScriptBackend implements LanguageBackend {
  name = "typescript";
  framework = "vitest";
  fileExtension = ".ts";
  version = "0.1";

  generate(contract: Contract, config: GenerateConfig): GeneratedFile[] {
    // 遍历所有 invariant → 生成 describe/it 块
    // 调用 templates/ 中的操作符处理器
    // 拼接运行时文件 + 测试文件
  }

  supportFiles(contract: Contract, config: GenerateConfig): GeneratedFile[] {
    // stele-runtime.ts + __init__.js
  }
}
```

#### 2.2.7 `stele.config.json` 扩展

```json
{
  "backend": "typescript",
  "framework": "vitest",  // "vitest" | "jest"
  "outputDir": "tests/contract",
  "tsConfigPath": "tsconfig.json"
}
```

### 2.3 非功能性需求

- **性能**: 100+ 个 invariant 的生成时间 < 1 秒
- **类型安全**: 生成的 TypeScript 代码通过 `tsc` 检查（无 `any` 泛滥）
- **测试覆盖**: 所有 46+ 个操作符有对应的翻译测试
- **兼容性**: Node.js >= 18

### 2.4 验收标准

- [ ] `stele generate` 在 TypeScript 项目中生成有效的 Vitest 测试文件
- [ ] 生成的测试可通过 `npx vitest run tests/contract` 执行
- [ ] Jest 模式（`framework: "jest"`）生成 `describe/it` + `expect`
- [ ] 所有内置操作符翻译通过单元测试
- [ ] Stele 自身代码库可被 Stele 保护（狗食）
- [ ] TypeScript 后端和 Python 后端对同一 CDL 文件的行为一致（对比测试）

---

## 3. EP02: GitHub Actions 集成

### 3.1 背景

GitHub Actions 是最广泛使用的 CI 平台。一个 workflow 文件即可为每个 PR 添加契约验证。

### 3.2 需求规格

#### 3.2.1 包结构

```
packages/github-action/
  action.yml                     -- 主 Action 定义
  dist/                          -- 打包后的 JS（通过 ncc 或 tsup 打包）
  src/
    main.ts                      -- Action 入口
    check.ts                     -- stele check 封装
    generate.ts                  -- stele generate 封装
    lock.ts                      -- stele lock 封装
    annotate.ts                  -- PR diff 注释
  __tests__/
    main.test.ts
```

#### 3.2.2 Action 设计

提供一个**复合 Action**，用户通过 `with.mode` 选择模式：

```yaml
# 示例用法
- uses: stelehq/stele-action@v1
  with:
    mode: check              # "generate" | "check" | "lock"
    diff-from: main          # 默认 ${{ github.event.pull_request.base.sha }}
    fail-on: error           # "error" | "warning" | "all"
    annotate: true           # 是否在 PR diff 上添加注释
    token: ${{ github.token }}
```

**模式说明**:

| mode | 行为 | 退出码 |
|------|------|--------|
| `generate` | 运行 `stele generate`，检测生成漂移 | 2（有漂移） |
| `check` | 运行 `stele check --diff-from <sha>` | 3（有违约） |
| `lock` | 运行 `stele lock`（仅在 main 分支 merge 后） | 1（锁失败） |

#### 3.2.3 PR Diff 注释

当 `stele check` 发现违约时：

1. 读取 `.stele/violations.json`（或 `--json` 输出）
2. 对每个违约，找到 `scope_paths` 对应的文件
3. 使用 GitHub Annotations (`::error` / `::warning` / `::notice`) 在 PR diff 上标注

```typescript
// 伪代码
for (const violation of violations) {
  const file = violation.scope_paths[0];
  const line = violation.detail.line ?? 1;
  const severity = violation.severity === "error" ? "error" : "warning";
  core.info(`::${severity} file=${file},line=${line}::[Stele] ${violation.message}`);
}
```

#### 3.2.4 推荐 Workflow 模板

```yaml
# .github/workflows/stele-check.yml
name: Stele Contract Check

on:
  pull_request:
    branches: [main]

jobs:
  stele:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # 需要完整历史用于 diff-from

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
          token: ${{ github.token }}
```

### 3.3 非功能性需求

- **首次运行时间**: < 30 秒（不含 npm install）
- **打包**: Action 发布前通过 ncc/tsup 打包，无需 CI 环境安装依赖

### 3.4 验收标准

- [ ] 在公开示例仓库中，PR 触发 Stele check 并通过
- [ ] 违约时 PR diff 上正确标注错误/警告
- [ ] `generate` 模式检测生成漂移并正确退出
- [ ] `lock` 模式在 main 分支 merge 后可更新锁定
- [ ] Action 发布到 GitHub Marketplace

---

## 4. EP03: pre-commit 钩子

### 4.1 背景

pre-commit 是最广泛使用的 Git 钩子框架。`stele check` 作为 pre-commit 钩子可在本地提交前检测违约。

### 4.2 需求规格

#### 4.2.1 `.pre-commit-config.yaml` 模板

```yaml
repos:
  - repo: local
    hooks:
      - id: stele-generate
        name: Stele Generate
        entry: npx stele generate
        language: node
        pass_filenames: false
        stages: [pre-commit]

      - id: stele-check
        name: Stele Check
        entry: npx stele check
        language: node
        pass_filenames: false
        stages: [pre-commit]

      - id: stele-lock
        name: Stele Lock
        entry: npx stele lock
        language: node
        pass_filenames: false
        stages: [pre-push]
        always_run: true
```

#### 4.2.2 `stele init` 扩展

新增 `--pre-commit` 标志，自动在 `.pre-commit-config.yaml` 中添加 Stele 钩子：

```bash
stele init --language typescript --pre-commit
```

#### 4.2.3 文档

- 新增 `docs/pre-commit-setup.md`（中英文）
- 说明 pre-commit 安装、配置、常见问题

### 4.3 验收标准

- [ ] `stele init --pre-commit` 正确生成 `.pre-commit-config.yaml`
- [ ] `pre-commit run stele-check` 能正确拦截违约提交
- [ ] 文档涵盖安装和使用指南

---

## 5. EP04: CDL 操作符增强（批次 1）

### 5.1 背景

46 个操作符覆盖基础场景。新增 14 个高价值操作符，扩展表达能力。

### 5.2 新增操作符清单

#### 5.2.1 集合操作

| 操作符 | 签名 | 描述 | CDL 示例 |
|--------|------|------|----------|
| `length` | `(Collection) -> Number` | 集合元素数量 | `(length (collection items))` |
| `concat` | `(Collection, Collection) -> Collection` | 拼接两个集合 | `(concat (path orders) (path returns))` |
| `sort-by` | `(Collection, Path) -> Collection` | 按路径排序（升序） | `(sort-by (collection items) (path price))` |
| `sort-by-desc` | `(Collection, Path) -> Collection` | 按路径排序（降序） | |
| `group-by` | `(Collection, Path) -> Collection` | 按路径分组 | `(group-by (collection orders) (path customer-id))` |

#### 5.2.2 算术

| 操作符 | 签名 | 描述 | CDL 示例 |
|--------|------|------|----------|
| `mod` | `(Number, Number) -> Number` | 取模 | `(mod (value total) (value 100))` |
| `pow` | `(Number, Number) -> Number` | 幂运算 | `(pow (value base) (value 2))` |
| `round` | `(Number, Number) -> Number` | 四舍五入 | `(round (value 3.14159) (value 2))` → 3.14 |
| `ceil` | `(Number) -> Number` | 向上取整 | `(ceil (value 3.2))` → 4 |
| `floor` | `(Number) -> Number` | 向下取整 | `(floor (value 3.9))` → 3 |

#### 5.2.3 字符串

| 操作符 | 签名 | 描述 | CDL 示例 |
|--------|------|------|----------|
| `trim` | `(String) -> String` | 去除首尾空白 | `(trim (path name))` |
| `lower` | `(String) -> String` | 转小写 | `(lower (path status))` |
| `upper` | `(String) -> String` | 转大写 | `(upper (path code))` |
| `split` | `(String, String) -> Collection` | 按分隔符分割 | `(split (path tags) ",")` |
| `join` | `(Collection, String) -> String` | 用分隔符拼接 | `(join (path names) ", ")` |

#### 5.2.4 数据访问

| 操作符 | 签名 | 描述 | CDL 示例 |
|--------|------|------|----------|
| `json-path` | `(Unknown, String) -> Unknown` | JSONPath 查询 | `(json-path (path data) "$.orders[*].id")` |
| `type-of` | `(Unknown) -> String` | 返回值的类型名 | `(type-of (path value))` |
| `regex-groups` | `(String, String) -> Collection` | 正则捕获组 | `(regex-groups (path url) "https://api.(\w+)\.com")` |

#### 5.2.5 统计

| 操作符 | 签名 | 描述 | CDL 示例 |
|--------|------|------|----------|
| `percentile` | `(Collection, Path, Number) -> Number` | 百分位计算 | `(percentile (collection scores) (path value) 95)` |

### 5.3 实现范围

每个操作符需：

1. `@stele/core`: 注册到 `CORE_OPERATOR_SPECS`，定义签名（参数名、参数类型、返回类型）
2. `@stele/core`: 在 `validateTypes` 中支持类型检查
3. `@stele/backend-python`: 添加翻译处理器
4. `@stele/backend-typescript`: 添加翻译处理器（与 EP01 并行时同步添加）
5. 测试: 每个操作符至少 1 个正向测试 + 1 个反向测试

### 5.4 验收标准

- [ ] 14+ 个操作符注册到核心操作符注册表
- [ ] Python 后端翻译全部通过
- [ ] TypeScript 后端翻译全部通过
- [ ] 类型检查对新操作符有效
- [ ] 每个操作符有正向和反向测试

---

## 6. EP05: 增量生成性能优化

### 6.1 背景

大型项目全量生成耗时较长。基于文件哈希的增量检测可以只重新生成变更的 `.stele` 文件对应的测试。

### 6.2 需求规格

#### 6.2.1 哈希缓存设计

```
.stele/cache/
  hash-manifest.json   -- 记录每个 .stele 文件内容的 SHA-256 + 对应生成的测试文件
```

```typescript
interface HashManifest {
  version: string;       // "1"
  generatedAt: string;   // ISO timestamp
  files: Record<string, {
    cdlHash: string;     // SHA-256 of normalized CDL content
    testHash: string;    // SHA-256 of generated test file
    outputPaths: string[]; // 生成的文件路径列表
  }>;
}
```

#### 6.2.2 增量检测算法

```
1. 读取 .stele/cache/hash-manifest.json
2. 遍历所有 .stele 文件
3. 对每个文件:
   a. 计算内容哈希 (normalizeContract → SHA-256)
   b. 对比缓存中的 cdlHash
   c. 如果相同 → 跳过（测试文件已是最新）
   d. 如果不同 → 重新生成该文件对应的测试
4. 删除缓存中存在但 .stele 已删除的测试文件
5. 更新 hash-manifest.json
```

#### 6.2.3 CLI 集成

- `stele generate` 默认启用增量检测
- `stele generate --force` 全量生成（忽略缓存）
- `stele generate --no-cache` 跳过缓存（只生成不写缓存）
- `stele cache clean` 清除缓存

#### 6.2.4 并行生成

多个 group 的测试文件可并行生成：

```typescript
// 伪代码
const changedGroups = detectChangedGroups(manifest);
const results = await Promise.all(
  changedGroups.map(group => generateTestFile(group, backend))
);
```

### 6.3 非功能性需求

- **性能提升**: 100 个 .stele 文件变更 1 个时，生成时间减少 90%+
- **正确性**: 增量生成结果必须与全量生成结果一致（通过哈希对比验证）
- **可回退**: 任何情况下 `--force` 可恢复到全量生成

### 6.4 验收标准

- [ ] 未变更的 .stele 文件不触发重新生成
- [ ] 变更的 .stele 文件正确触发重新生成
- [ ] 删除的 .stele 文件对应的测试文件被清理
- [ ] `--force` 强制全量生成
- [ ] 增量生成结果与全量生成结果一致（哈希对比）
- [ ] 100+ 文件场景性能测试: 增量 vs 全量 < 10% 时间

---

## 7. 里程碑和依赖

### 7.1 第一个月

| 周 | 任务 | 依赖 |
|----|------|------|
| W1 | EP01: TypeScript 后端骨架 + 核心操作符翻译 | `@stele/core` |
| W2 | EP01: 运行时 + 剩余操作符 + 狗食 | EP01 W1 |
| W3 | EP02: GitHub Action 开发 + EP03: pre-commit 模板 | `@stele/cli` |
| W4 | EP04: 操作符增强批次 1 + EP01 完善 | EP01 W2 |

### 7.2 第二个月

| 周 | 任务 | 依赖 |
|----|------|------|
| W5 | EP05: 增量生成哈希缓存 | `@stele/core` |
| W6 | EP05: 并行生成 + 性能基准测试 | EP05 W5 |
| W7 | 集成测试 + 文档 + GitHub Action 发布 | 所有 EP |
| W8 | 狗食验证 + 修复 + Phase 1 验收 | |

### 7.3 依赖图

```
EP01 (TypeScript 后端) ──────────────→ EP04 (操作符增强)
                                          ↓
EP02 (GitHub Actions) ──→ EP05 (增量生成)
                                          ↓
EP03 (pre-commit)              Phase 1 验收
```

---

## 8. 验收标准（总）

### 8.1 功能验收

- [ ] TypeScript 项目可正常生成和执行契约测试
- [ ] GitHub PR 流程自动检测契约违约
- [ ] pre-commit 钩子本地拦截违约提交
- [ ] 60+ 个操作符覆盖集合/算术/字符串/数据访问/统计
- [ ] 增量生成在大型项目中显著提速

### 8.2 质量验收

- [ ] 所有新增代码测试覆盖率 ≥ 80%
- [ ] 无 TypeScript 类型错误（`tsc` 通过）
- [ ] 所有 989+ 现有测试仍然通过
- [ ] 无新增 ESLint 警告

### 8.3 文档验收

- [ ] `docs/typescript-backend.md` — TypeScript 后端快速入门
- [ ] `docs/github-actions.md` — GitHub Actions 集成指南
- [ ] `docs/pre-commit-setup.md` — pre-commit 配置指南
- [ ] `examples/typescript-project/` — TypeScript 示例项目
- [ ] `CHANGELOG.md` 更新
