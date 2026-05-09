# P0.3 详细设计：LanguageBackend 注册表

> PRD: [prd-phase-0.md §6](../../prd-phase-0.md) | 估算: 2-3 天 | 类别: 重构

## 1. 目标

替换 `packages/cli/src/commands/generate.ts:75-82` 的硬编码 backend 调度，使后续 EP01 (TypeScript)、EP10 (Go) 可通过注册表新增 backend，而不修改 `@stele/cli` 命令代码。

## 1.1 关键前置子任务（v2.0 新增）

`@stele/backend-python` 当前**没有** `LanguageBackend` 默认导出 —— 包导出 `getPythonRuntimeSource`、`generatePytestSource`、`sanitizePythonIdentifier` 等命名函数；`createLanguageBackend` 主体在 `cli/src/commands/generate.ts:75-129`。

P0.3 实施时**必须先**：

1. 把 `createLanguageBackend` 主体从 `cli/src/commands/generate.ts` 移入新文件 `packages/backend-python/src/backend.ts`
2. `packages/backend-python/src/index.ts` 加 `export { default } from "./backend.js"` 与 `export { default as backend } from "./backend.js"`
3. 更新 `cli/src/commands/check.ts:29` 与其他引用点，改通过 `loadBackend()` 而非 `createLanguageBackend()` 直接调用

完成此前置后，`@stele/backend-python` 才能被 `loadBackend()` 通过 `mod.default ?? mod.backend` 装载。EP01 (TS backend) 与 EP10 (Go backend) 同样模式：每个 backend 包导出 `default: LanguageBackend`。

## 2. 公开 API

### 2.1 新增模块：`packages/cli/src/backend-registry.ts`

```typescript
import type { LanguageBackend } from "@stele/core";
import { SteleError } from "@stele/core";

/** 注册表条目：language + framework → npm 包 + 显示名 */
export interface RegisteredBackend {
  /** stele.config.json 中 targetLanguage 字段值 */
  language: string;
  /** stele.config.json 中 testFramework 字段值；undefined 表示任意 framework 都匹配 */
  framework?: string;
  /** 动态导入的 npm 包名 */
  packageName: string;
  /** CLI 输出展示名 */
  displayName: string;
}

/** v0.2 内置注册条目；Phase 1 EP01 / Phase 2 EP10 在此追加 */
export const REGISTERED_BACKENDS: readonly RegisteredBackend[] = Object.freeze([
  {
    language: "python",
    framework: "pytest",
    packageName: "@stele/backend-python",
    displayName: "Python (pytest)",
  },
  // EP01 加: { language: "typescript", framework: "vitest", packageName: "@stele/backend-typescript", displayName: "TypeScript (vitest)" }
  // EP01 加: { language: "typescript", framework: "jest", packageName: "@stele/backend-typescript", displayName: "TypeScript (jest)" }
  // EP10 加: { language: "go", framework: "testing", packageName: "@stele/backend-go", displayName: "Go (testing)" }
]);

/** 根据 language + framework 加载 backend */
export async function loadBackend(
  language: string,
  framework: string | undefined
): Promise<LanguageBackend>;

/** 列出所有注册 backend（用于错误信息 + stele init 提示）*/
export function listRegisteredBackends(): readonly RegisteredBackend[];
```

### 2.2 错误码（新增）

错误码作为 SteleError 的 `code` 参数（位置参数 #1，字符串字面量）：

- `"E_UNSUPPORTED_BACKEND"` —— 用户配置的 language/framework 没注册
- `"E_BACKEND_LOAD_FAILED"` —— 注册的包存在但加载失败（import 错误、缺 default 导出）

`docs/spec/cdl.md` "Error codes" 章节追加这两条目。**不**引入 `STELE_ERROR_CODES` 常量对象（v0.1 没此约定，新增会破坏一致性）。

### 2.3 SteleError 真实 API

⚠️ 注意：`SteleError` 是**位置参数**构造，不是对象参数：

```typescript
// 实际签名（packages/core/src/errors/SteleError.ts，15 行）
new SteleError(code: string, category: string, message: string, span?, detail?, hint?)
```

设计文档中所有 `new SteleError({ code, message, ... })` 用法**已修正**为：

```typescript
throw new SteleError(
  "E_UNSUPPORTED_BACKEND",
  "BackendError",
  `Unsupported backend: ${language}/${framework}. Supported: ${supported}.`,
  undefined, // span
  undefined, // detail
  `Run 'npm install @stele/backend-${language}' to add support.` // hint
);
```

## 3. 实现

### 3.1 loadBackend 实现

```typescript
interface BackendModule {
  default?: LanguageBackend;
  backend?: LanguageBackend;
}

export async function loadBackend(
  language: string,
  framework: string | undefined
): Promise<LanguageBackend> {
  // 第一轮：找 language 精确匹配；framework 既可严格匹配又可 wildcard
  let candidates = REGISTERED_BACKENDS.filter(
    (b) => b.language === language && (framework === undefined || b.framework === framework)
  );

  // 兼容：用户没传 framework 时，若注册条目有 framework，仅匹配第一条
  // （Python entry 有 framework: "pytest"，缺 testFramework 时仍可工作）
  if (candidates.length === 0 && framework === undefined) {
    candidates = REGISTERED_BACKENDS.filter((b) => b.language === language);
  }

  if (candidates.length === 0) {
    const supported = REGISTERED_BACKENDS.map((b) => b.displayName).join(", ");
    throw new SteleError(
      "E_UNSUPPORTED_BACKEND",
      "BackendError",
      `Unsupported backend: ${language}/${framework ?? "*"}. Supported: ${supported}.`,
      undefined,
      undefined,
      `If this language is planned, run 'npm install @stele/backend-${language}'.`,
    );
  }

  // 多 candidate 时取第一个（注册表顺序定义优先级）
  const entry = candidates[0];

  let mod: BackendModule;
  try {
    mod = (await import(entry.packageName)) as BackendModule;
  } catch (cause) {
    throw new SteleError(
      "E_BACKEND_LOAD_FAILED",
      "BackendError",
      `Failed to import ${entry.packageName}: ${(cause as Error).message}`,
      undefined,
      undefined,
      `Run 'npm install ${entry.packageName}' if not yet installed.`,
    );
  }

  const backend = mod.default ?? mod.backend;
  if (!backend) {
    throw new SteleError(
      "E_BACKEND_LOAD_FAILED",
      "BackendError",
      `Backend package ${entry.packageName} did not export a default backend.`,
    );
  }

  // 校验 backend 形状
  if (typeof backend.generate !== "function") {
    throw new SteleError(
      "E_BACKEND_LOAD_FAILED",
      "BackendError",
      `Backend ${entry.packageName} does not implement LanguageBackend.generate.`,
    );
  }

  return backend;
}
```

### 3.2 既有调用点改造

替换以下文件中的硬编码分支：

```typescript
// packages/cli/src/commands/generate.ts (改造前)
if (targetLanguage !== "python") {
  throw new Error(`Unsupported target language: ${targetLanguage}.`);
}
const backend = await import("@stele/backend-python");

// 改造后
import { loadBackend } from "../backend-registry.js";
const backend = await loadBackend(targetLanguage, testFramework);
```

需改造的文件：

- `packages/cli/src/commands/generate.ts` （主调用点）
- `packages/cli/src/commands/init.ts` （init 时校验 language 已注册：调 `listRegisteredBackends()` 检查；如果用户传 `--language ruby` 立即报错）

### 3.3 init.ts 的 SUPPORTED_LANGUAGES

`packages/cli/src/commands/init.ts:11`:

```typescript
// 改造前
const SUPPORTED_LANGUAGES = ["python"] as const;

// 改造后
import { listRegisteredBackends } from "../backend-registry.js";
function getSupportedLanguages(): string[] {
  return Array.from(new Set(listRegisteredBackends().map((b) => b.language)));
}
```

## 4. 测试设计

`packages/cli/tests/backend-registry.test.ts`:

```typescript
describe("backend-registry", () => {
  describe("loadBackend", () => {
    it("returns python backend for python/pytest", async () => {
      const b = await loadBackend("python", "pytest");
      expect(b.name).toBe("python");
    });
    it("returns python backend when framework is undefined", async () => { /* ... */ });
    it("throws E_UNSUPPORTED_BACKEND for unknown language", async () => {
      await expect(loadBackend("ruby", "rspec")).rejects.toMatchObject({ code: "E_UNSUPPORTED_BACKEND" });
    });
    it("includes supported list in error message", async () => {
      const err = await loadBackend("ruby", "rspec").catch((e) => e);
      expect(err.message).toContain("Python (pytest)");
    });
    it("rejects when backend package fails to import", async () => {
      // 模拟 import 失败：vi.mock 一个 fake registered backend with bad package name
    });
    it("rejects when backend export missing default", async () => { /* mock module without default */ });
  });

  describe("listRegisteredBackends", () => {
    it("returns frozen snapshot", () => {
      const list = listRegisteredBackends();
      expect(Object.isFrozen(list)).toBe(true);
    });
  });
});
```

## 5. 多 backend 共存

后续 EP01 加注册条目后，多 backend 可同时被一个 `--recursive` 跨项目运行装载（参见 [EP08 设计](../phase-1/08-recursive-flag.md)）。`loadBackend` 是无状态工厂函数：

- 每次调用都 `await import(packageName)`（Node ESM 自动缓存重复 import）
- **不**维护进程级单例
- 项目 A `targetLanguage: "python"` + 项目 B `targetLanguage: "typescript"` 在同一 CLI 调用中共存正常

## 6. 错误处理矩阵

| 场景 | 错误码 | 用户可读消息 |
|---|---|---|
| `--language ruby` (init 阶段) | `E_UNSUPPORTED_BACKEND` | `Unsupported language: ruby. Supported: Python (pytest).` |
| `targetLanguage: "go"` 但 `@stele/backend-go` 未注册 | `E_UNSUPPORTED_BACKEND` | 同上 |
| `targetLanguage: "typescript"` `testFramework: "mocha"` (TS 后端但 framework 错) | `E_UNSUPPORTED_BACKEND` | `Multiple backends match "typescript" but framework "mocha" is not exact. Specify testFramework in stele.config.json.` |
| `@stele/backend-python` 包损坏（import throws）| `E_BACKEND_LOAD_FAILED` | `Failed to import @stele/backend-python: <inner message>` |
| 包存在但 export shape 错（无 default 或 backend）| `E_BACKEND_LOAD_FAILED` | `Backend package ... did not export a default backend.` |

## 7. 向后兼容

**完全加性**：

- 现有 `stele.config.json` 含 `targetLanguage: "python"` `testFramework: "pytest"` → 同样工作
- 现有不传 `testFramework` 字段 → registry framework 为 undefined 的条目匹配（"任意 framework"）
- 现有命令所有标志 → 不变

## 8. 验收标准

- [ ] `stele init --language python` 行为与重构前完全一致
- [ ] `stele init --language ruby` 报 `E_UNSUPPORTED_BACKEND`，错误信息列出 `Python (pytest)`
- [ ] `packages/cli/src/commands/generate.ts` 中**不再含** `if (targetLanguage !== "python")` 分支
- [ ] EP01 / EP10 可通过仅在 `REGISTERED_BACKENDS` 加一行接入新 backend，无其他文件修改
- [ ] backend-registry.test.ts 全部通过
- [ ] 错误码 `E_UNSUPPORTED_BACKEND`、`E_BACKEND_LOAD_FAILED` 在 `docs/spec/cdl.md` 文档化
- [ ] 现有 861 测试全部通过

## 9. CLI exports 配置

`packages/cli/package.json` 加 subpath export，让 conformance suite 与其他 internal consumer 可 import:

```json
{
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./backend-registry": { "types": "./dist/backend-registry.d.ts", "import": "./dist/backend-registry.js" }
  }
}
```

## 10. 不在范围内

- 用户自定义 backend 注册（参见 v0.1 PRD EP11 已丢弃；如有需求是 Phase 3 候选）
- backend hot-reload（开发期不需要）
- 同 language 多 backend 共存（如 python-pytest + python-unittest，v0.2 仅一种）
