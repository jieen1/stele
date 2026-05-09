# P0.4 详细设计：跨后端一致性测试套件

> PRD: [prd-phase-0.md §7](../../prd-phase-0.md) | 估算: 2-3 天 | 类别: 测试基础设施

## 1. 目标

建立"两个 backend 对同一 CDL 文件输出**字节等价违约报告**"的可运行规范。Phase 0 仅含 Python backend；EP01 (TypeScript)、EP10 (Go) 复用同一套件作为验收门禁。

## 2. 目录结构

```
tests/conformance/                            -- 新增顶层目录（不在任何 package 内）
  README.md                                   -- 添加 fixture 流程
  runner.ts                                   -- vitest 套件入口
  runner-impl.ts                              -- 通用执行逻辑
  comparators.ts                              -- assertViolationReportsEqual 等比对工具
  fixtures/
    01-simple-invariant/
      contract/
        main.stele
      stele.config.json                       -- 不含 targetLanguage; runner 注入
      app-state.json                          -- 模拟 stele_context 数据
      expected-violations.json                -- 规范化违约报告
    02-forall-collection/
      ...
    03-scenario-checker/
      ...
    04-temporal-modified/
      ...
    05-baseline-suppression/
      ...
```

`tests/conformance` 不属于任何 npm 包；通过根 `package.json` 的 `test:conformance` script 调用：

```json
{
  "scripts": {
    "test:conformance": "vitest run --root tests/conformance"
  }
}
```

## 3. fixture 格式

### 3.1 contract/main.stele

普通 CDL 文件。Phase 0 用最简表达力。

### 3.2 stele.config.json

```json
{
  "version": "0.1",
  "contractDir": "contract",
  "entry": "main.stele",
  "generatedDir": "tests/contract",
  "checkerImplDir": "contract/checker_impls",
  "manifestPath": "contract/.manifest.json",
  "pathMode": "auto",
  "protected": ["contract/**", "tests/contract/**"]
}
```

**注意**：不含 `targetLanguage` / `testFramework`；runner 在执行时按 backend 注入。

### 3.3 app-state.json

`stele_context` 装配。runner 把它注入到生成的 conftest.py / conftest.ts / setup_test.go 中：

```json
{
  "account": { "id": "acc-001", "balance": 100, "currency": "USD" },
  "positions": []
}
```

### 3.4 expected-violations.json

规范化违约报告。**这是黄金真相**——每个 backend 必须产出与之结构等价的输出（按 §4 定义）。

> **schema 真实来源**：[`docs/spec/cli-output.md`](../../spec/cli-output.md) 与 `packages/core/src/report/types.ts`。早期草稿引用的 `invariant_id` / `location.file` / `cause.kind` 等字段**不存在**于实际 schema；本节使用真实字段名。

```json
{
  "schema_version": "1",
  "tool": "@stele/cli",
  "command": "check",
  "ok": false,
  "summary": {
    "violation_count": 1,
    "active_violation_count": 1,
    "invariant_count": 1
  },
  "violations": [
    {
      "rule_id": "BALANCE_NON_NEGATIVE",
      "rule_kind": "invariant",
      "severity": "error",
      "source": { "tool": "@stele/cli", "command": "check", "kind": "test-runner" },
      "location": { "path": "tests/contract/test_account.py", "line": 17 },
      "cause": {
        "summary": "forall failed at index 3 of 47",
        "detail": "(forall accounts (gt (path balance) 0)) evaluated to false on accounts[3]",
        "failure_witness": {
          "operator": "forall",
          "collection_size": 47,
          "failed_at_index": 3,
          "failed_item": { "id": "acc-789", "balance": -50, "currency": "USD" },
          "predicate_source": "(gt (path balance) 0)",
          "truncated": false
        }
      },
      "fingerprint": "sha256:...",
      "scope_paths": ["account.balance"],
      "status": "active"
    }
  ]
}
```

**不要求一致的字段**（runner ignore 列表）：`location.path`（不同 backend 路径不同）、`location.line`、`fingerprint`（含路径输入）、`source.tool`（一致即可）、`cause.detail` 文本（措辞差异允许）、`summary.invariant_count`（如 backend 计算差异）。runner 比较时按 §4 规则逐字段判定。

### 3.5 README.md (fixture 内)

```markdown
# Fixture 01: simple-invariant

**Purpose**: smoke test —— 单 invariant + assert，验证基础 path 与比较语义。

**CDL features exercised**:
- `(invariant ...)` 顶层声明
- `(assert ...)` 表达式
- `(eq ...)` 比较
- `(path ...)` 路径访问

**Why this fixture**: 任何 backend 必须最先在此 fixture 上通过。
```

每 fixture 必须含此 README，说明它测什么、为什么。

## 4. "结构等价" 的可执行定义

> 注：早期草稿用"字节等价"措辞；实际比较器忽略部分字段，**结构等价**更准确。

`comparators.ts`:

```typescript
export interface ViolationCompareOptions {
  /** 数值容差（IEEE-754 双精度比较）*/
  tolerance: number;
  /** 忽略 location.path（不同 backend 路径不同）*/
  ignoreLocationPath: boolean;
  /** 忽略 location.line（不同 backend 行号不同）*/
  ignoreLocationLine: boolean;
  /** 忽略 cause.detail 文本（措辞差异允许，结构等价即可）*/
  ignoreCauseDetailText: boolean;
  /** 忽略 fingerprint（包含路径输入，跨 backend 不同）*/
  ignoreFingerprint: boolean;
}

export const DEFAULT_OPTIONS: ViolationCompareOptions = {
  tolerance: 1e-9,
  ignoreLocationPath: true,
  ignoreLocationLine: true,
  ignoreCauseDetailText: true,
  ignoreFingerprint: true,
};

export function assertViolationReportsEqual(
  actual: ViolationReport,
  expected: ViolationReport,
  options: ViolationCompareOptions = DEFAULT_OPTIONS,
): void {
  // 1. summary.violation_count 等核心计数完全相等
  expect(actual.summary.violation_count).toBe(expected.summary.violation_count);
  expect(actual.summary.active_violation_count ?? 0).toBe(expected.summary.active_violation_count ?? 0);

  // 2. violations 数组长度相等
  expect(actual.violations.length).toBe(expected.violations.length);

  // 3. 按 rule_id + scope_paths 排序后逐项比较
  const sortedActual = sortViolations(actual.violations);
  const sortedExpected = sortViolations(expected.violations);
  for (let i = 0; i < sortedActual.length; i++) {
    compareViolation(sortedActual[i], sortedExpected[i], options);
  }
}

function compareViolation(actual: Violation, expected: Violation, options: ViolationCompareOptions) {
  // rule_id（不是 invariant_id）
  expect(actual.rule_id).toBe(expected.rule_id);
  expect(actual.rule_kind).toBe(expected.rule_kind);
  expect(actual.severity).toBe(expected.severity);
  expect(uniqueSorted(actual.scope_paths)).toEqual(uniqueSorted(expected.scope_paths));

  // cause.summary 必须相等；cause.detail 文本默认忽略
  expect(actual.cause.summary).toBe(expected.cause.summary);
  if (!options.ignoreCauseDetailText && expected.cause.detail) {
    expect(actual.cause.detail).toBe(expected.cause.detail);
  }

  // failure_witness 结构等价比较（v0.2 EP07）
  if (expected.cause.failure_witness) {
    compareWitness(actual.cause.failure_witness, expected.cause.failure_witness, options);
  }

  // location.path / line 默认忽略
  if (!options.ignoreLocationPath && expected.location?.path) {
    expect(actual.location?.path).toBe(expected.location.path);
  }
}

function compareWitness(actual: FailureWitness | undefined, expected: FailureWitness, options: ViolationCompareOptions) {
  expect(actual).toBeDefined();
  expect(actual!.operator).toBe(expected.operator);
  expect(actual!.collection_size).toBe(expected.collection_size);
  if (expected.failed_at_index !== undefined) {
    expect(actual!.failed_at_index).toBe(expected.failed_at_index);
  }
  if (expected.predicate_source !== undefined) {
    expect(actual!.predicate_source).toBe(expected.predicate_source);
  }
  // failed_item 结构等价比较（按容差处理数值）
  if (expected.failed_item !== undefined) {
    expectStructurallyEqual(actual!.failed_item, expected.failed_item, options.tolerance);
  }
}
```

## 5. Runner 设计

`runner.ts`:

```typescript
import { describe, test } from "vitest";
import { loadFixtures, runFixtureOnBackend } from "./runner-impl.js";
import { assertViolationReportsEqual } from "./comparators.js";

const FIXTURES = await loadFixtures("./fixtures");

// STELE_CONFORMANCE_BACKENDS 语法：language:framework[,language:framework...]
// 例：python:pytest,typescript:vitest
// 缺省：python:pytest
const BACKEND_SPECS = (process.env.STELE_CONFORMANCE_BACKENDS ?? "python:pytest")
  .split(",")
  .map((s) => {
    const [language, framework] = s.split(":");
    if (!language || !framework) throw new Error(`Bad STELE_CONFORMANCE_BACKENDS spec: ${s}`);
    return { language, framework };
  });

for (const fixture of FIXTURES) {
  describe(`fixture ${fixture.id}`, () => {
    for (const spec of BACKEND_SPECS) {
      const id = `${spec.language}:${spec.framework}`;
      // EP06 Code Shape 仅 Python 支持；其他 backend skip
      if (fixture.requiresCodeShape && spec.language !== "python") {
        test.skip(`${id}: code-shape not supported`);
        continue;
      }
      test(`on ${id} backend`, async () => {
        const actual = await runFixtureOnBackend(fixture, spec);
        const expected = fixture.expectedViolations;
        assertViolationReportsEqual(actual, expected);
      });
    }
  });
}
```

### 5.1 Runner-impl 流程

关键问题：v0.1 的 `stele check` 输出 **drift-shaped** violations（generated_drift / manifest_drift / contract_hash_mismatch），**不**输出 per-invariant pytest 失败。conformance fixture 验证的是 invariant 行为，因此需要解析 test runner 输出，不能仅依赖 `stele check`。

```typescript
export async function runFixtureOnBackend(fixture: Fixture, spec: BackendSpec): Promise<ViolationReport> {
  const tmpdir = await mkdtemp(`stele-conformance-${fixture.id}-${spec.language}-`);
  try {
    // 1. 拷贝 fixture
    await cp(fixture.dir, tmpdir, { recursive: true });

    // 2. 注入 backend 到 stele.config.json
    const configPath = join(tmpdir, "stele.config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.targetLanguage = spec.language;
    config.testFramework = spec.framework;
    await writeFile(configPath, JSON.stringify(config, null, 2));

    // 3. 运行 stele generate（通过 backend-registry 装载 backend）
    await run(["stele", "generate"], { cwd: tmpdir });

    // 4. 写入 fixture bootstrap（注入 app-state.json 到 stele_context）
    //    通过 LanguageBackend.writeFixtureBootstrap 扩展点（每 backend 自己提供）
    const backend = await loadBackend(spec.language, spec.framework);
    await backend.writeFixtureBootstrap?.(fixture, tmpdir);

    // 5. 运行 test runner with junitxml output
    const junitPath = join(tmpdir, ".conformance/junit.xml");
    await runTestRunnerWithJunit(spec, tmpdir, junitPath);

    // 6. 解析 junitxml 提取 per-invariant pass/fail + witness
    const invariantResults = await parseJunitXml(junitPath);

    // 7. 同时跑 stele check --json 验证 drift（独立 assertion）
    const { stdout: checkOut } = await run(["stele", "check", "--json"], { cwd: tmpdir });
    const driftReport = JSON.parse(checkOut) as ViolationReport;

    // 8. 合并：把 invariant failure 转换为 Violation 形态 + drift violations
    return mergeReports(invariantResults, driftReport);
  } finally {
    await rm(tmpdir, { recursive: true, force: true });
  }
}
```

### 5.2 LanguageBackend.writeFixtureBootstrap 扩展点

为支持多 backend 测试 setup，`LanguageBackend` 接口加可选方法（修改 `packages/core/src/generator/coordinator.ts`）：

```typescript
export interface LanguageBackend {
  // 现有：name, framework, fileExtension, version, generate, supportFiles
  /** v0.2 新增：conformance fixture 在 tmpdir 中写入 test runner setup 文件 */
  writeFixtureBootstrap?(fixture: Fixture, tmpdir: string): Promise<void>;
}
```

Python backend 实现：写 `tests/contract/conftest.py` 注入 stele_context（含 fixture 的 app-state.json）。
TypeScript backend 实现：写 `tests/contract/conftest.ts` + 配置 vitest.config 加载它。
Go backend 实现：写 `contract_test/setup_test.go` with SetupSteleContext。

`runner-impl` 不直接知道 conftest/setup_test 命名差异；通过 backend 接口委托。

## 6. Phase 0 初始 fixture 集

每个 fixture 由一名 engineer 完成 + 一名 reviewer 验证（独立人）。

| Fixture | 覆盖 | 估算 |
|---|---|---|
| 01-simple-invariant | invariant + assert + eq + path | 2 小时 |
| 02-forall-collection | forall + where + gt + sum | 3 小时 |
| 03-scenario-checker | scenario + step + uses-checker + custom checker | 4 小时 |
| 04-temporal-modified | state-before / state-after + modified | 3 小时 |
| 05-baseline-suppression | baseline-init + 新违约 | 2 小时 |

合计 ~14 小时；2 人并行 1 天。

## 7. 后续 EP 如何扩展

EP01 (TypeScript backend) 完成后：

1. 在 `BACKENDS` 默认列表加 `"typescript"`
2. 每个 EP 引入新 fixture 时把它加到 `tests/conformance/fixtures/`
3. CI 强制 `STELE_CONFORMANCE_BACKENDS=python,typescript pnpm test:conformance` 通过

EP10 (Go) 同样。

## 8. 失败诊断

当 conformance test 失败时，runner 输出（用真实 schema 字段）：

```
FAIL fixture 02-forall-collection on typescript backend

Expected:
  violations[0].cause.failure_witness.failed_item.balance = -50 (number)

Actual:
  violations[0].cause.failure_witness.failed_item.balance = "-50" (string)

Hint: 检查 typescript backend 是否在 path 访问后丢失了类型信息。
      参见 docs/design/phase-1/01-typescript-backend.md §2.2.4。
```

## 9. 不在范围内

- 自动 fixture 生成（手写为主）
- Property-based testing（`fast-check` / `hypothesis`）
- 性能 benchmarking（参见 EP05）

## 10. 验收标准

- [ ] `tests/conformance/` 目录与文件存在
- [ ] 5 个初始 fixture 各含 contract/ + stele.config.json + app-state.json + expected-violations.json + README.md
- [ ] `pnpm test:conformance` 在 Python backend 上 5/5 通过
- [ ] `assertViolationReportsEqual` 公开导出，被 `docs/contributing/testing.md` 引用
- [ ] `tests/conformance/README.md` 文档化添加 fixture 流程
- [ ] 任何 fixture 文件改动需 reviewer 批准（CODEOWNERS 钩子）
