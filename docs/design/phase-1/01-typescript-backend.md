# EP01 详细设计：TypeScript/JavaScript 后端

> PRD: [prd-phase-1.md §2](../../prd-phase-1.md) | 估算: 3-4 周 | 类别: 新后端（关键路径）

## 1. 目标

把 CDL 翻译到 Vitest（默认）/ Jest 测试代码。完整复刻 Python backend 的语义与 runtime helpers，含 scenario / checker / failure_witness。

## 2. 公开 API

### 2.1 包导出

`packages/backend-typescript/src/index.ts`：

```typescript
import type { LanguageBackend, GenerationConfig, GeneratedFile, Contract } from "@stele/core";

const backend: LanguageBackend = {
  name: "typescript",
  framework: "vitest",  // 默认；可被 stele.config.json 中 testFramework 覆盖
  fileExtension: ".ts",
  version: "0.1.0",

  generate(contract: Contract, config: GenerationConfig): GeneratedFile[] {
    /* 同步实现 */
  },

  supportFiles(contract: Contract, config: GenerationConfig): GeneratedFile[] {
    /* 返回 _stele_runtime.ts */
  },
};

export default backend;
export { translateExpression } from "./translator.js";
export { getTypeScriptRuntimeSource } from "./runtime/index.js";
```

注意：

- `GenerationConfig`（与 `@stele/core` 约定一致）
- 同步返回（接口契约）
- `supportFiles` 必须实现（runtime 必须 emit）

### 2.2 注册到 backend-registry

[Phase 0 P0.3 设计](../phase-0/03-backend-registry.md) 完成后，`packages/cli/src/backend-registry.ts` 中 `REGISTERED_BACKENDS` 加：

```typescript
{ language: "typescript", framework: "vitest", packageName: "@stele/backend-typescript", displayName: "TypeScript (vitest)" },
{ language: "typescript", framework: "jest", packageName: "@stele/backend-typescript", displayName: "TypeScript (jest)" },
```

`init.ts` 的 `getSupportedLanguages()` 自动拿到 `"typescript"`。

## 3. 翻译器

### 3.1 总体结构

`src/translator.ts` 镜像 `backend-python/src/translator.ts`：

```typescript
type Translator = (node: AstNode, ctx: TranslateContext) => string;

const TRANSLATORS: Record<string, Translator> = {
  invariant: translateInvariant,
  scenario: translateScenario,
  group: translateGroup,
  // ... 顶层
};

const OPERATOR_TRANSLATORS: Record<string, Translator> = {
  and: translateAnd,
  or: translateOr,
  // ... 51 baseline + 18 EP04
};

export function translateExpression(node: AstNode, ctx: TranslateContext): string {
  if (node.kind === "list" && node.children[0].kind === "atom") {
    const op = node.children[0].value;
    const handler = OPERATOR_TRANSLATORS[op];
    if (handler) return handler(node, ctx);
  }
  return translateAtom(node);
}
```

### 3.2 测试文件模板

每 group 一个文件 `test_<group>.ts`：

```typescript
// 生成的 test_account.ts
import { describe, it, expect, beforeEach } from "vitest"; // 或 @jest/globals
import { steleContext } from "./conftest";
import * as runtime from "./_stele_runtime";

describe("Account contract", () => {
  let ctx: SteleContext;
  beforeEach(() => { ctx = steleContext; });

  it("BALANCE_NON_NEGATIVE", () => {
    // (forall accounts (gt (path balance) 0)) 翻译
    const accounts = runtime.steleGetPath(ctx, ["account"]) as Account[];
    runtime.steleForall(accounts, (a) => {
      const balance = runtime.steleGetPath(a, ["balance"]) as number;
      return balance > 0;
    }, "(gt (path balance) 0)"); // predicate_source for witness
  });
});
```

`testFramework: "jest"` 切换时仅 import 行变化（`@jest/globals`）；`vitest` 与 `jest` API 共享 `describe`/`it`/`expect`。

### 3.3 操作符翻译详情

主要操作符的翻译模板（以 forall/exists/where/sum 为例）：

```typescript
function translateForall(node: ListNode, ctx: TranslateContext): string {
  const [, varName, collExpr, predExpr] = node.children;
  const coll = translateExpression(collExpr, ctx);
  const childCtx = { ...ctx, scope: { ...ctx.scope, [varName.value]: "__item" } };
  const pred = translateExpression(predExpr, childCtx);
  const predSource = JSON.stringify(serializeAst(predExpr));
  return `runtime.steleForall(${coll}, (__item) => ${pred}, ${predSource})`;
}

function translateSum(node: ListNode, ctx: TranslateContext): string {
  const [, collExpr, pathExpr] = node.children;
  const coll = translateExpression(collExpr, ctx);
  const path = translatePath(pathExpr);
  return `runtime.steleSum(${coll}, ${JSON.stringify(path)})`;
}
```

完整列表见 `tests/translator.test.ts` 的 fixture。

## 4. Runtime helpers

### 4.1 `_stele_runtime.ts` 结构

```typescript
// 公共导出
export class SteleRuntimeError extends Error {
  constructor(message: string, public details?: object) { super(message); }
}

// 路径
export function steleGetPath(obj: unknown, segments: string[]): unknown { /* §4.2 */ }

// 集合
export function steleForall(coll: unknown[], pred: (i: unknown) => boolean, predSource: string): boolean { /* §4.3 */ }
export function steleExists(coll: unknown[], pred: (i: unknown) => boolean, predSource: string): boolean { /* ... */ }
export function steleWhere(coll: unknown[], pred: (i: unknown) => boolean): unknown[] { /* ... */ }
export function steleSum(coll: unknown[], path: string[]): number { /* ... */ }
export function steleAvg(coll: unknown[], path: string[]): number { /* ... */ }
export function steleCount(coll: unknown[]): number { /* ... */ }
// ... 51 baseline 个

// 比较 / 算术 / 字符串 / 时态 (略)

// Scenario / Checker
export function steleRunScenario(steps: ScenarioStep[], ctx: SteleContext): SteleContext { /* §5 */ }
export function steleCallChecker(name: string, args: unknown[], ctx: SteleContext): CheckerResult { /* §5 */ }
export function steleMergeContexts(a: SteleContext, b: SteleContext): SteleContext { /* §5 */ }
export function steleIsModified(before: SteleContext, after: SteleContext, path: string[]): boolean { /* §5 */ }

// Failure witness（与 EP07 集成）
export interface FailureWitness {
  operator: string;
  collection_size?: number;
  failed_at_index?: number;
  failed_item?: unknown;
  predicate_source?: string;
}
```

### 4.2 路径访问

```typescript
export function steleGetPath(obj: unknown, segments: string[]): unknown {
  let current = obj;
  for (const seg of segments) {
    if (current == null) {
      throw new SteleRuntimeError(`Path not found: segment "${seg}" on null/undefined`);
    }
    if (typeof current === "object" && !Array.isArray(current)) {
      const record = current as Record<string, unknown>;
      // 1. 直接命中
      if (Object.prototype.hasOwnProperty.call(record, seg)) {
        current = record[seg];
        continue;
      }
      // 2. kebab-case → camelCase fallback
      const camel = seg.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (Object.prototype.hasOwnProperty.call(record, camel)) {
        current = record[camel];
        continue;
      }
      // 3. 不存在 → 抛错
      throw new SteleRuntimeError(`Path not found: "${seg}" missing on object`);
    }
    if (Array.isArray(current)) {
      throw new SteleRuntimeError(`Path navigation hit array at "${seg}"; arrays must be navigated via collection operators`);
    }
    throw new SteleRuntimeError(`Path navigation hit primitive at "${seg}"`);
  }
  return current;
}
```

**与 Python 等价矩阵**：

| 输入 | Python `_stele_runtime.py` | TypeScript |
|---|---|---|
| `{"balance": 100}.balance` | dict[k] 命中 | record[k] 命中 |
| 类实例 `account.balance` | getattr(obj, "balance") | record["balance"] (假设 JSON-shaped) |
| `account.balance-history` | getattr(obj, "balance_history") | record["balanceHistory"] |
| 路径不存在 | KeyError → 包装 SteleRuntimeError | SteleRuntimeError 直接 |
| null 中段 | None.attr → AttributeError | TypeError → SteleRuntimeError |

注意 TS 端不需要"snake_case fallback"（因为 JS 习惯 camelCase）；Python 端不需要"camelCase fallback"。**两个 fallback 在各自 backend 是规范的一部分**，由 `docs/spec/cdl.md` § "Path semantics" 钉死。

### 4.3 forall + witness

```typescript
export function steleForall(
  coll: unknown[],
  pred: (item: unknown) => boolean,
  predSource: string,
): boolean {
  if (!Array.isArray(coll)) {
    throw new SteleRuntimeError(`forall: expected collection, got ${typeof coll}`);
  }
  for (let i = 0; i < coll.length; i++) {
    const item = coll[i];
    if (!pred(item)) {
      // EP07 witness 集成
      const err = new SteleAssertionFailed("forall failed");
      (err as SteleAssertionFailed).witness = {
        operator: "forall",
        collection_size: coll.length,
        failed_at_index: i,
        failed_item: safeSerialize(item, 2), // max_depth=2
        predicate_source: predSource,
      };
      throw err;
    }
  }
  return true;
}

class SteleAssertionFailed extends Error {
  witness?: FailureWitness;
}
```

`safeSerialize(item, maxDepth)` 防止深嵌套对象 + redact 敏感字段（参见 [EP07 §8.2.4](07-stele-why-witness.md)）。

## 5. Scenario / Checker

### 5.1 接口

```typescript
export interface SteleContext {
  [key: string]: unknown;
  _stele_checkers?: Record<string, CheckerFunction>;
  "state-before"?: SteleContext;
  "state-after"?: SteleContext;
}

export type CheckerFunction = (args: unknown[], ctx: SteleContext) => CheckerResult;

export interface CheckerResult {
  ok: boolean;
  message?: string;
  details?: unknown;
}

export interface ScenarioStep {
  type: "execute" | "capture-state" | "import";
  module?: string;
  function?: string;
  args?: unknown[];
  captureKey?: string;
}
```

### 5.2 用户编写 conftest

```typescript
// tests/contract/conftest.ts (用户拥有，generator 不覆盖)
import type { SteleContext } from "./_stele_runtime";

export const steleContext: SteleContext = {
  account: realAccountSnapshot(),
  positions: loadOpenPositions(),
  _stele_checkers: {
    "balance-change-has-transaction": (args, ctx) => {
      const accountId = args[0] as string;
      const before = ctx["state-before"]?.account as { balance: number };
      const after = ctx["state-after"]?.account as { balance: number };
      const txs = (ctx as any).transactions as Array<{ accountId: string; amount: number }>;
      const expected = (after.balance ?? 0) - (before.balance ?? 0);
      const found = txs.find((t) => t.accountId === accountId && t.amount === expected);
      return { ok: !!found };
    },
  },
};
```

### 5.3 Scenario 执行

```typescript
export function steleRunScenario(steps: ScenarioStep[], ctx: SteleContext): SteleContext {
  let current: SteleContext = { ...ctx };
  for (const step of steps) {
    if (step.type === "import") {
      assertImportAllowed(step.module!);
      // dynamic import 受限于 STELE_ALLOWED_IMPORTS
      // ...
    } else if (step.type === "execute") {
      // 调用 user-provided function
    } else if (step.type === "capture-state") {
      current = { ...current, [step.captureKey!]: deepClone(getCurrentAppState()) };
    }
  }
  return current;
}
```

### 5.4 安全：import allowlist

```typescript
const STELE_ALLOWED_IMPORTS: ReadonlySet<string> = new Set([
  // 仅安全 stdlib + 用户应用代码
  "Math",
  "JSON",
  // 用户的 conftest 可手动 import 应用代码；不通过 scenario step 动态 import
]);

const STELE_BLOCKED_IMPORTS: ReadonlySet<string> = new Set([
  "fs", "fs/promises", "child_process", "net", "http", "https",
  "os", "path", "process", "vm",
  "node:fs", "node:child_process", /* ... */
]);

function assertImportAllowed(moduleName: string): void {
  if (STELE_BLOCKED_IMPORTS.has(moduleName)) {
    throw new SteleRuntimeError(`Module "${moduleName}" is blocked by Stele safety policy`);
  }
  if (!STELE_ALLOWED_IMPORTS.has(moduleName)) {
    throw new SteleRuntimeError(`Module "${moduleName}" is not in Stele allowlist`);
  }
}
```

## 6. 数值语义

JS `number` 是 IEEE-754 双精度。Python `int` 是任意精度；当用户契约涉及大整数时：

```typescript
function checkNumericPrecision(coll: unknown[], operator: string): void {
  if (coll.length > 1000 || coll.some((v) => typeof v === "number" && Math.abs(v) > Number.MAX_SAFE_INTEGER)) {
    console.warn(
      `[Stele] ${operator}: collection size or element magnitude may exceed JS number precision. Consider splitting the contract or using bigint.`
    );
  }
}
```

仅 warning（**不**抛错），由 generator 在 emit 处加注释。bigint 自动 promotion **不**实现（保持与 Python 一致的运行时简洁度）。

## 7. 正则语义

支持的子集：

- ECMAScript regex
- 行为等价于 Python `re.search()`（任意位置子串匹配）

禁止特性（validator 阶段拒绝；E0606 规则细化）：

- `^` `$` 锚（如需用户在 pattern 字符串显式加，但被 lint 警告）
- 反向引用 `\1`、`\g<name>`
- 后顾 `(?<=...)` `(?<!...)`

```typescript
function steleMatches(s: string, pattern: string): boolean {
  // 拒绝高级特性（在 validator 阶段已 reject；这里 defensive）
  if (/\(\?<[!=]/.test(pattern)) {
    throw new SteleRuntimeError(`matches: lookbehind not supported (pattern: ${pattern})`);
  }
  return new RegExp(pattern).test(s);  // RegExp.test 本身不锚定
}
```

Python 端必须改为 `re.search(pattern, s) is not None`（**不是** `re.match`，那个是从开头匹配）。

## 8. 配置

`stele.config.json` 字段：

```json
{
  "version": "0.1",
  "targetLanguage": "typescript",
  "testFramework": "vitest",
  "generatedDir": "tests/contract",
  "tsConfigPath": "tsconfig.json",
  "moduleType": "esm"
}
```

注意路径用现有 schema 字段名（`targetLanguage` 不是 `backend`；`testFramework` 不是 `framework`；`generatedDir` 不是 `outputDir`）。

## 9. SUPPORTED_LANGUAGES 扩展

`packages/cli/src/commands/init.ts:11`：

```typescript
// 改造前（v0.1）
const SUPPORTED_LANGUAGES = ["python"] as const;

// 改造后（依赖 P0.3 已落地）
import { listRegisteredBackends } from "../backend-registry.js";
function getSupportedLanguages(): string[] {
  return Array.from(new Set(listRegisteredBackends().map((b) => b.language)));
}
// 现在自动包含 "python", "typescript"（在 P0.3 + EP01 注册条目落地后）
```

## 10. 测试

### 10.1 单测

`packages/backend-typescript/tests/translator.test.ts`：每个操作符正反测试。

`packages/backend-typescript/tests/runtime.test.ts`：runtime helpers 单测。

### 10.2 conformance

5 个 Phase 0 fixture + 18 个 EP04 新 fixture 全部跑 TypeScript backend。CI 加 `STELE_CONFORMANCE_BACKENDS=python,typescript`。

### 10.3 跨 backend 一致性

`tests/conformance/` runner 对每 fixture 执行：

```typescript
const pyReport = await runFixtureOnBackend(fixture, "python");
const tsReport = await runFixtureOnBackend(fixture, "typescript");
assertViolationReportsEqual(pyReport, tsReport, { tolerance: 1e-9 });
```

## 11. 狗食

在 `packages/core/contract/main.stele` 加 1 个 invariant 保护核心，e.g.

```lisp
(invariant CORE_OPERATOR_REGISTRY_HAS_LENGTH
  (severity high)
  (description "Core operator registry must contain length operator")
  (assert (exists-in (collection (path operators)) (eq (path name) "length"))))
```

`packages/core` 自身 npm script `stele:check` 用 TypeScript backend 验证（demo Stele 保护自己）。

## 12. 估算分解

| 工作 | 估算 |
|---|---|
| 包 scaffold + LanguageBackend 注册 | 0.5 天 |
| 51 baseline 操作符翻译 + runtime | 5 天 |
| Path access (kebab→camel)            | 0.5 天 |
| 18 个 EP04 新操作符（与 EP04 共享工作）| 3 天 |
| Scenario / checker runtime | 4 天 |
| Failure witness（与 EP07 集成）| 1 天（EP07 主体）|
| Vitest + Jest 兼容层 | 1 天 |
| Conformance fixture 验证 + 修 bug | 3 天 |
| 狗食验证 + 文档 | 2 天 |
| **合计** | **20 天 ≈ 4 周（1 FTE）/ 2-2.5 周（2 FTE）**|

## 13. 验收标准（来自 PRD §2.4）

- [ ] **conformance suite**：`tests/conformance/` 5 个 Phase 0 fixture 全部在 TypeScript backend 上通过
- [ ] **跨 backend 一致性**：每个 fixture 在 Python + TypeScript 字节相等（容差 1e-9）
- [ ] **运行时完整性**：scenario + checker fixture 通过
- [ ] **路径语义**：kebab-case→camelCase fallback 测试通过
- [ ] **Jest 切换**：相同契约在 `testFramework: "jest"` emit 文件可被 Jest runner 执行通过
- [ ] **狗食**：`packages/core` 加 `.stele` 文件保护核心不变量，`stele check` 通过
- [ ] **类型检查**：emit 的 TS 代码通过 `tsc --strict --noEmit`
- [ ] **生成性能**：100 invariant 套件生成时间在 GitHub Actions ubuntu-latest 4-core CI 环境 < 1s
- [ ] **不可破坏 Python 后端**：现有 Python 后端 conformance fixture 仍全部通过
