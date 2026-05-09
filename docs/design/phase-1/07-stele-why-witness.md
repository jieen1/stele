# EP07 详细设计：stele why 失败见证

> PRD: [prd-phase-1.md §8](../../prd-phase-1.md) | 估算: 1 周 | 类别: 可观察性

## 1. 目标

当 `forall`/`exists`/`where`/`none` 失败时，捕获**单步失败见证**（哪个元素、哪个值、什么谓词）并嵌入到 `ViolationReport.cause.failure_witness`。无新文件、无新环境变量、无重运行。

## 2. 与 v1.0 设计的偏离

v1.0 提议持久化 `eval-trace.jsonl` + `STELE_TRACE=1` + `--evaluate` 子模式。**v2.0 全部删除**，理由：

- 持久化文件违反"determinism is load-bearing"原则
- pytest-xdist 并发写 jsonl 是设计噩梦
- 单步见证已覆盖 80%+ 用户场景
- 多步 trace 留作 Phase 3 候选

## 3. 数据结构

### 3.1 类型扩展

⚠️ 真实 `ViolationCause`（`packages/core/src/report/types.ts:22-31`）字段是 `summary`、`detail?`、`missing?`、`changed?`、`extra?` 等，**不是** `kind` / `expected_value` / `actual_value`（早期 design doc 引用错误）。

v0.2 在 `ViolationCause` 加**可选 sibling 字段** `failure_witness`：

```typescript
// packages/core/src/report/types.ts (v0.2 修改)
export type ViolationCause = {
  summary: string;
  detail?: string;
  missing?: string[];
  changed?: string[];
  extra?: string[];
  new_files?: string[];
  expected_hash?: string;
  actual_hash?: string;
  // v0.2 新增：
  failure_witness?: FailureWitness;
};

export type FailureWitness = {
  /** 触发失败的操作符 */
  operator: "forall" | "exists" | "where" | "none";
  /** 集合长度 */
  collection_size: number;
  /** 失败发生在第几个元素（forall/exists/where/none 适用）*/
  failed_at_index?: number;
  /** 失败元素的浅层快照（max_depth=2，敏感字段已 redact）*/
  failed_item?: unknown;
  /** 失败子表达式的源代码字符串 */
  predicate_source?: string;
  /** 序列化是否被截断（深度、字节数、或数组长度任一）*/
  truncated: boolean;
};
```

`FailureWitness` **单一定义**在 `packages/core/src/report/types.ts`；EP01/02/10/11 都从此 import，不重复定义。

新增 helpers（同文件）导出：

```typescript
export function safeSerialize(
  value: unknown,
  maxDepth: number,
  redactionPatterns?: RegExp[],
): { serialized: unknown; truncated: boolean };

export function buildFailureWitness(
  operator: FailureWitness["operator"],
  collectionSize: number,
  failedIndex: number | undefined,
  failedItem: unknown,
  predicateSource: string,
): FailureWitness;
```

`Violation` 顶层字段保持 `rule_id`（**不是** `invariant_id`）、`location.path`（**不是** `location.file`）、`cause.detail` 是 `string`（**不是** 对象）。早期 design doc 草稿引用的不正确字段名已经在 [`docs/spec/cli-output.md`](../../spec/cli-output.md) 钉死。

### 3.2 序列化与 redaction

```typescript
const MAX_WITNESS_BYTES = 64 * 1024;        // 64 KB（v2.0 round 2 提升从 16 KB）
const MAX_PREDICATE_SOURCE_BYTES = 4 * 1024;
const MAX_FAILED_ITEM_BYTES = 8 * 1024;
const MAX_ARRAY_ITEMS = 100;

const DEFAULT_REDACTION_PATTERNS = [
  /password/i,
  /token/i,
  /secret/i,
  /api[_-]?key/i,
];

export function safeSerialize(
  value: unknown,
  maxDepth: number,
  redactionPatterns: RegExp[] = DEFAULT_REDACTION_PATTERNS,
): { serialized: unknown; truncated: boolean } {
  let truncated = false;

  function visit(v: unknown, depth: number): unknown {
    if (depth > maxDepth) { truncated = true; return "<depth-limit>"; }
    if (v == null || typeof v !== "object") return v;
    if (Array.isArray(v)) {
      if (v.length > MAX_ARRAY_ITEMS) truncated = true;
      return v.slice(0, MAX_ARRAY_ITEMS).map((x) => visit(x, depth + 1));
    }
    const obj: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (redactionPatterns.some((p) => p.test(k))) {
        obj[k] = "<redacted>";
      } else {
        obj[k] = visit(val, depth + 1);
      }
    }
    return obj;
  }
  let result = visit(value, 0);

  // byte cap on whole serialized payload
  let serialized = JSON.stringify(result);
  if (serialized.length > MAX_WITNESS_BYTES) {
    truncated = true;
    result = { _truncated: true, _original_size: serialized.length };
  }

  return { serialized: result, truncated };
}
```

子项 cap 由 `buildFailureWitness` 在组装时再次裁剪 `predicate_source`（≥ 4 KB 截断 + 标记 truncated）和 `failed_item`（≥ 8 KB 截断）。三层 cap 防御任一字段超大撑爆整体。

## 4. Runtime 集成

### 4.1 Python

```python
# _stele_runtime.py
class SteleAssertionFailed(AssertionError):
    """携带 witness 的 assertion 失败"""
    def __init__(self, message, witness=None):
        super().__init__(message)
        self.witness = witness

def stele_forall(collection, predicate, predicate_source):
    if not isinstance(collection, list):
        raise SteleRuntimeError(f"forall: expected collection, got {type(collection).__name__}")
    for i, item in enumerate(collection):
        if not predicate(item):
            witness = {
                "operator": "forall",
                "collection_size": len(collection),
                "failed_at_index": i,
                "failed_item": _safe_serialize(item, max_depth=2),
                "predicate_source": predicate_source,
                "truncated": False,  # _safe_serialize 内部更新
            }
            raise SteleAssertionFailed(
                f"forall failed at index {i}",
                witness=witness,
            )
    return True

def stele_exists(collection, predicate, predicate_source):
    if not isinstance(collection, list):
        raise SteleRuntimeError(f"exists: expected collection")
    for item in collection:
        if predicate(item):
            return True
    # exists 失败：没有任何元素满足
    raise SteleAssertionFailed(
        f"exists failed: no element in collection of size {len(collection)} satisfies predicate",
        witness={
            "operator": "exists",
            "collection_size": len(collection),
            "predicate_source": predicate_source,
            "truncated": False,
        },
    )

def _safe_serialize(value, max_depth):
    # 同 §3.2 TS 实现等价
    pass
```

### 4.2 TypeScript

参见 [EP01 §4.3](01-typescript-backend.md)。

### 4.3 Go（Phase 2 EP10 落地）

参见 [EP10 设计](../phase-2/10-go-backend.md)。

## 5. conftest 集成（修正：generator 不动用户 conftest）

⚠️ 关键：**`tests/contract/conftest.py` 是 application-owned**（`docs/spec/cdl.md` Path semantics 节、`README.md`），generator **不**覆盖它。早期草稿写"generator emit 的 conftest 中加 hook"是错误的。

正确机制：generator emit **独立文件** `tests/contract/_stele_conftest.py`，含 pytest hook：

```python
# tests/contract/_stele_conftest.py (generator emit; protected file)
"""Stele-managed pytest plugin. Auto-generated by stele generate; do not edit."""
import pytest
from _stele_runtime import SteleAssertionFailed

@pytest.hookimpl(tryfirst=True, hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    rep = outcome.get_result()
    if call.when == "call" and call.excinfo is not None:
        exc = call.excinfo.value
        if isinstance(exc, SteleAssertionFailed):
            # 把 witness 注入到 item 的 user_properties；junitxml 会序列化
            item.user_properties.append(("stele_witness", exc.witness))
```

用户的 `conftest.py` 通过 `pytest_plugins` 注册：

```python
# tests/contract/conftest.py (user-owned; stele init 会在已有 conftest 中加这一行)
pytest_plugins = ["_stele_conftest"]

@pytest.fixture
def stele_context():
    return { ... }
```

`stele init --language python` 与 `stele init --pre-commit` 都需要：

1. 检测用户已存 `conftest.py` → 在文件顶部追加 `pytest_plugins = ["_stele_conftest"]`（如已含此行则跳过）
2. 不存在 conftest.py → 创建 stub 含 pytest_plugins + 注释指引用户填 stele_context

TypeScript backend 等价（vitest）：emit `tests/contract/_stele_setup.ts` 含 `afterEach` hook 把 witness 写入累积器；用户 `vitest.config.ts` 中 `setupFiles` 数组加 `["./tests/contract/_stele_setup.ts"]`（由 stele init 自动写入）。

Go backend（Phase 2 EP10）：witness 通过 file-based channel 传输（参见 [EP10 设计](../phase-2/10-go-backend.md) §9）。

`stele check` 命令的 test-runner 解析层从 junitxml `user_properties` 中读 `stele_witness`，组装到 `Violation.cause.failure_witness`。

## 6. CLI 输出

### 6.1 stele why <id>

```typescript
// packages/cli/src/commands/why.ts
async function runWhy(idOrFingerprint: string): Promise<void> {
  const contract = await loadContract();
  const inv = contract.invariants.find((i) => i.id === idOrFingerprint || /* fingerprint */);
  if (!inv) { /* error */ }

  // 读最近的 violation report
  const lastReport = await readLastReport();
  // v0.2 schema：rule_id（不是 invariant_id），cause.summary（不是 cause.kind）
  const violation = lastReport.violations.find((v) => v.rule_id === inv.id);

  console.log(`Invariant: ${inv.id}`);
  console.log(`Severity: ${inv.severity}`);
  console.log(`Description: ${inv.description}`);
  console.log("");

  if (violation) {
    console.log(`Last check: ${lastReport.generated_at ?? "(unknown)"} (failed)`);
    console.log("");
    if (violation.cause.failure_witness) {
      printWitness(violation.cause.failure_witness);
    } else {
      console.log("Cause:", violation.cause.summary);
      if (violation.cause.detail) console.log("Detail:", violation.cause.detail);
    }
  } else {
    console.log("Last check: passing");
  }

  console.log("");
  console.log("How to fix:");
  console.log(`  - Inspect the affected code`);
  console.log(`  - Run: stele check --diff-from main`);
  console.log(`  - Suppress (only if intentional): npx stele baseline-update --reason "..."`);
}

function printWitness(w: FailureWitness): void {
  console.log("Failure witness:");
  console.log(`  operator: ${w.operator}`);
  console.log(`  collection_size: ${w.collection_size}`);
  if (w.failed_at_index !== undefined) {
    console.log(`  failed at index: ${w.failed_at_index}`);
  }
  if (w.failed_item !== undefined) {
    console.log(`  failed item: ${JSON.stringify(w.failed_item, null, 2).split("\n").map((l) => "    " + l).join("\n").trimStart()}`);
  }
  if (w.predicate_source) {
    console.log(`  predicate: ${w.predicate_source}`);
  }
  if (w.truncated) {
    console.log(`  (truncated to fit ${MAX_WITNESS_BYTES / 1024} KB cap)`);  // 64 KB per §3.2
  }
}
```

### 6.2 stele why --json

输出符合 [`docs/spec/cli-output.md` §4.2](../../spec/cli-output.md) schema。`failure_witness` 嵌套在 `violation.cause` 内部（与 ViolationReport 结构一致）：

```json
{
  "schema_version": "1",
  "tool": "@stele/cli",
  "command": "why",
  "rule_id": "BALANCE_NON_NEGATIVE",
  "severity": "error",
  "description": "Account balance must be non-negative.",
  "rationale": "...",
  "last_check_at": "2026-05-08T10:00:00Z",
  "last_check_status": "failed",
  "violation": {
    "rule_id": "BALANCE_NON_NEGATIVE",
    "rule_kind": "invariant",
    "severity": "error",
    "fingerprint": "sha256:...",
    "scope_paths": ["account.balance"],
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
    }
  }
}
```

### 6.3 删除 v1.0 的 --evaluate

v1.0 PRD 提议 `stele why <id> --evaluate` 重新运行 pytest。**v2.0 不实现**。witness 始终随 `stele check` 产生；`stele why` 直接读最近 violation report。

## 7. baseline-suppressed violation

baseline 抑制是**报告层**操作（`@stele/core/src/baseline/types.ts:filterViolationReport`），不影响 runtime。即：

- runtime helper 仍构造 witness
- check 仍把 witness 写入完整 violation report
- baseline filter 应用在 report 后处理；被抑制的违约的 witness **保留**
- `stele why <suppressed-id>` 仍可显示 witness

## 8. 配置（可选）

`stele.config.json` 新增可选字段：

```json
{
  "witnessRedactionPatterns": ["custom_pii", "ssn"]
}
```

合并到 `DEFAULT_REDACTION_PATTERNS`：

```typescript
const finalPatterns = [
  ...DEFAULT_REDACTION_PATTERNS,
  ...(config.witnessRedactionPatterns ?? []).map((p) => new RegExp(p, "i")),
];
```

## 9. 性能影响

witness 构造仅在**失败时**发生：

- 成功路径：runtime helper 走原代码（无变化）
- 失败路径：原本抛 AssertionError，现在抛 SteleAssertionFailed with witness
- 序列化开销：单 witness ≤ 64 KB；100 violations ≤ 6.4 MB

预期 `stele check` 总时间增量 < 5%。

## 10. 测试

```typescript
// packages/core/tests/report/witness.test.ts
describe("FailureWitness", () => {
  it("safeSerialize respects max_depth", () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    const { serialized, truncated } = safeSerialize(deep, 2);
    expect(serialized).toEqual({ a: { b: { c: "<depth-limit>" } } });
    expect(truncated).toBe(true);
  });
  it("redacts password field", () => { /* ... */ });
  it("redacts api_key field (case-insensitive)", () => { /* ... */ });
  it("truncates >64KB to stub", () => { /* ... */ });
  it("custom redaction patterns from config", () => { /* ... */ });
});

// 跨 backend conformance
describe("witness conformance", () => {
  it("Python and TypeScript produce structurally equivalent witness for forall failure", async () => {
    // 用同一 fixture 在两 backend 跑
    // 比较 witness 结构（字段名、嵌套）；具体值因 backend 而异允许
  });
});
```

## 11. 文档

`docs/spec/cli-output.md` § 3 填 `stele why --json` schema。

`docs/guides/python-integration.md` + `docs/guides/typescript-integration.md` 加 "Diagnosing failures with `stele why`" 节。

## 12. 验收标准（来自 PRD §8.4）

- [ ] `forall`/`exists`/`where`/`none` 失败时 ViolationReport 含 `failure_witness`
- [ ] `stele why <id>` 显示 witness 与"如何修复"
- [ ] `--json` 输出 schema 文档化在 `docs/spec/cli-output.md`
- [ ] witness 序列化 ≤ 64 KB；超过截断并标记（子项：predicate_source ≤ 4 KB；failed_item ≤ 8 KB）
- [ ] 敏感字段 redaction 工作（password/token/secret/api_key）
- [ ] conformance fixture 验证 witness 在 Python + TypeScript backend 上结构等价
- [ ] **零额外文件**写入 `contract/.cache/` 或其他位置
- [ ] **零额外环境变量**（无 STELE_TRACE）
- [ ] baseline-suppressed violation 仍含 witness
