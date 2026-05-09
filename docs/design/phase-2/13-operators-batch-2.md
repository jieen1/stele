# EP13 详细设计：CDL 操作符批次 2

> PRD: [prd-phase-2.md §5](../../prd-phase-2.md) | 估算: 1-2 周 | 类别: 语言扩展

## 1. 目标

新增 5 个操作符，让 Phase 2 末注册总数达到 75（74 用户面）。每操作符必须在 Python + TypeScript + Go 三 backend 行为一致。

## 2. 操作符语义钉死

### 2.1 5 个新操作符

| 操作符 | 签名 | 钉死语义 |
|---|---|---|
| `max-by` | `(Collection, Path) -> Unknown` | 按路径值最大的元素；空集合**抛 SteleRuntimeError**；并列时返回**第一个出现**；NaN 视为最小（被忽略）；缺路径值的元素被忽略 |
| `min-by` | `(Collection, Path) -> Unknown` | 同 max-by 反向 |
| `unique-by` | `(Collection, Path) -> Collection` | 按路径值去重，保留**第一次出现**；保持原顺序；缺路径值的元素**视为唯一各保留**；比较用 `eq`（容差 1e-9 同 backend） |
| `contains-all` | `(Collection, Collection) -> Boolean` | 第二集合是第一集合子集；按值比较（non-strict equality + 容差）；空第二集合 → true（vacuous truth）|
| `contains-any` | `(Collection, Collection) -> Boolean` | 两集合交集非空；空集合（任一）→ false |

### 2.2 已删除（来自 v1.0 草稿）

| 操作符 | 删除原因 |
|---|---|
| `entries` | 无 lambda 支持时是死代码；与 `group-by` 一起 Phase 3 落地 |
| `slice` | 跨语言负数索引 / saturating 语义碎片化 |
| `flatten` | 递归深度限制策略未定 |
| `index-of` | 罕见使用 + 弱语义 |
| `stddev` | 总体 vs 样本（ddof=0/1）跨语言不一致 |
| `median` | 偶长度集合插值方法多 |
| `percentile` | NumPy 9 种插值方法 |

## 3. 实现（每操作符的 11 项）

EP13 的实施模式与 [EP04 §3](../phase-1/04-operators-batch-1.md) 一致。**关键差异**：EP13 引入 Go runtime 落地（与 EP04 仅 Python+TS 不同），所以每操作符现在需要 11 项：

1. `@stele/core/src/registry/operators.ts`：注册条目
2. `@stele/core/src/validator/types.ts`：类型校验
3. `@stele/backend-python/src/translator.ts`：Python 翻译
4. `@stele/backend-python/src/runtime/_stele_runtime.py`：Python runtime
5. `@stele/backend-typescript/src/translator.ts`：TS 翻译
6. `@stele/backend-typescript/src/runtime/_stele_runtime.ts`：TS runtime
7. `@stele/backend-go/src/translator.ts`：Go 翻译
8. `@stele/backend-go/src/runtime/stele_runtime.go`：Go runtime
9. **conformance fixture**：`tests/conformance/fixtures/ep13-<op>/`
10. **正反单测**：每 backend 一对
11. **CDL spec 文档**：`docs/spec/cdl.md` 操作符表 + Operator semantics across backends 表

## 4. 实现细节

### 4.1 max-by

```python
# Python
def stele_max_by(coll, path):
    if not isinstance(coll, list):
        raise SteleRuntimeError(f"max-by: expected collection, got {type(coll).__name__}")
    if not coll:
        raise SteleRuntimeError("max-by: empty collection")
    items_with_keys = []
    for item in coll:
        try:
            key = stele_get_path(item, path)
            if isinstance(key, float) and math.isnan(key): continue  # NaN 忽略
            items_with_keys.append((item, key))
        except SteleRuntimeError:
            continue  # 缺路径值的元素忽略
    if not items_with_keys:
        raise SteleRuntimeError(f"max-by: no element has path {path}")
    return max(items_with_keys, key=lambda iwk: iwk[1])[0]
```

```typescript
// TS
export function steleMaxBy(coll: unknown[], path: string[]): unknown {
  if (!Array.isArray(coll)) throw new SteleRuntimeError(`max-by: expected collection`);
  if (coll.length === 0) throw new SteleRuntimeError("max-by: empty collection");
  let best: { item: unknown; key: number | string } | null = null;
  for (const item of coll) {
    let key: unknown;
    try { key = steleGetPath(item, path); } catch { continue; }
    if (typeof key === "number" && Number.isNaN(key)) continue;
    if (typeof key !== "number" && typeof key !== "string") continue;  // 仅 comparable
    if (best === null || (key as number | string) > (best.key as never)) {
      best = { item, key: key as number | string };
    }
  }
  if (best === null) throw new SteleRuntimeError(`max-by: no element has path ${path.join(".")}`);
  return best.item;
}
```

```go
// Go
func steleMaxBy(coll []interface{}, path []string) (interface{}, error) {
    if len(coll) == 0 {
        return nil, fmt.Errorf("max-by: empty collection")
    }
    var best interface{}
    var bestKey interface{}
    for _, item := range coll {
        key, err := steleGetPath(item, path)
        if err != nil { continue }
        if keyF, isF, _, _ := steleNumeric(key); isF && math.IsNaN(keyF) { continue }
        if best == nil {
            best, bestKey = item, key
            continue
        }
        if cmp, err := steleCompare(key, bestKey); err == nil && cmp > 0 {
            best, bestKey = item, key
        }
    }
    if best == nil {
        return nil, fmt.Errorf("max-by: no element has path %v", path)
    }
    return best, nil
}
```

跨 backend `steleCompare` 必须按相同规则：

- number vs number → numeric compare
- string vs string → lexicographic byte compare
- 类型混合 → SteleRuntimeError

### 4.2 unique-by

`unique-by` 保留**第一次出现**：

```typescript
import { stableStringify } from "@stele/core/report/types";  // 已存在（types.ts:156-175）

export function steleUniqueBy(coll: unknown[], path: string[]): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const item of coll) {
    let key: unknown;
    try { key = steleGetPath(item, path); } catch {
      // 路径不存在的元素：单独保留（视为"唯一"）
      result.push(item);
      continue;
    }
    // 用 stableStringify（递归排序对象 keys）保证 deterministic
    // 早期草稿用 JSON.stringify 在对象 key 顺序敏感；现修正
    const keyStr = stableStringify(key);
    if (!seen.has(keyStr)) {
      seen.add(keyStr);
      result.push(item);
    }
  }
  return result;
}
```

⚠️ 即使用 `stableStringify`，**validator 阶段仍拒绝非 scalar path**（添加新错误码 E0312）：

```typescript
// validator/types.ts (在 unique-by 处理时)
if (operatorName === "unique-by") {
  const pathParam = args[1];
  if (pathParam.elementType !== "Number" && pathParam.elementType !== "String" && pathParam.elementType !== "Boolean") {
    throw new SteleError(
      "E0312",                 // code
      "TypeError",             // category
      `unique-by: path must point to a scalar (Number/String/Boolean); got ${pathParam.elementType}`, // message
    );
  }
}

// 注：`stableStringify` 当前在 packages/core/src/report/types.ts:156-175 是私有 helper（无 export）。
// EP05 + 本 EP 实施时需把它加 export 关键字（一行变更），并加到 packages/core/src/index.ts 的 barrel export。
// 不改属于 EP05/EP13 实施工作的一部分。
```

理由：v0.2 仅对 scalar path 提供严格语义保证；object/collection 路径让 stableStringify 兜底但跨 backend 边界条件难以等价。

### 4.3 contains-all / contains-any

```typescript
export function steleContainsAll(coll: unknown[], subset: unknown[]): boolean {
  for (const needle of subset) {
    if (!coll.some((item) => steleEq(item, needle))) return false;
  }
  return true;
}

export function steleContainsAny(coll: unknown[], probe: unknown[]): boolean {
  for (const needle of probe) {
    if (coll.some((item) => steleEq(item, needle))) return true;
  }
  return false;
}
```

`steleEq` 对 number 用容差 1e-9（与 EP04 `eq` 一致）。

## 5. CDL spec 更新

`docs/spec/cdl.md` 操作符表从 70 扩到 **75**：

```markdown
### `max-by`

- **Signature**: `(max-by collection: Collection, path: Path) -> Unknown`
- **Returns**: element with maximum value at path; first occurrence on ties
- **Errors**:
  - `SteleRuntimeError` if collection is empty
  - `SteleRuntimeError` if no element has the requested path
- **Cross-backend semantics**: identical (NaN ignored; tied → first; string lexicographic byte order)
- **Example**: `(max-by (collection orders) (path amount))` → highest-amount order
- **Since**: 0.3.0
```

每条目同样格式。

## 6. 总数（v2.0 钉死）

| 阶段边界 | 注册总数 | 用户面（去 alias）|
|---|---|---|
| Phase 1 末 | 70（51 + 18 新 + 1 alias filter）| 69 |
| Phase 2 末 (含本 EP) | 70 + 5 = **75** | 69 + 5 = **74** |

## 7. CI lint 校验

`scripts/check-spec-operators.mjs` 运行时校验。**关键修正**：早期草稿的 regex `/^### `([\w-]+)`/gm` 会误匹配 cdl.md 中顶层声明 form 的章节标题（`### \`metadata\``、`### \`import\`` 等），把它们当 operator。v0.2 限定到 `## Core operators` 章节内：

```javascript
import { CORE_OPERATOR_SPECS } from "../packages/core/src/registry/operators.js";
import fs from "node:fs";

const spec = fs.readFileSync("docs/spec/cdl.md", "utf-8");

// 用显式 marker 限定 operator 章节
const BEGIN = "<!-- BEGIN_CORE_OPERATORS -->";
const END = "<!-- END_CORE_OPERATORS -->";
const begin = spec.indexOf(BEGIN);
const end = spec.indexOf(END);
if (begin < 0 || end < 0) {
  console.error("cdl.md missing BEGIN_CORE_OPERATORS / END_CORE_OPERATORS markers");
  process.exit(1);
}
const opsSection = spec.slice(begin + BEGIN.length, end);

const docOps = [...opsSection.matchAll(/^### `([\w-]+)`/gm)].map(m => m[1]);
const regOps = CORE_OPERATOR_SPECS.map(s => s.name);

const inSpecNotInReg = docOps.filter(op => !regOps.includes(op));
const inRegNotInSpec = regOps.filter(op => !docOps.includes(op));

if (inSpecNotInReg.length > 0 || inRegNotInSpec.length > 0) {
  console.error("Operator drift between spec and registry:");
  console.error("  in spec, not in registry:", inSpecNotInReg);
  console.error("  in registry, not in spec:", inRegNotInSpec);
  process.exit(1);
}
console.log(`OK: ${regOps.length} operators in sync.`);
```

EP04 实施时在 cdl.md 的 "Core operators" 章节首尾插入 marker 注释；本 EP 直接复用。

`.github/workflows/ci.yml` 含此 step（Phase 1 EP04 已加；EP13 复用）。

## 8. 测试

每操作符 conformance fixture：

```
tests/conformance/fixtures/
  ep13-max-by/
    contract/main.stele
    app-state.json (含 collection of items with different path values)
    expected-violations.json (反例 fixture)
  ep13-min-by/
  ep13-unique-by/
  ep13-contains-all/
  ep13-contains-any/
```

每 fixture 在 Python + TypeScript + Go 三 backend 上必须**字节等价**输出。

## 9. 估算分解

| 工作 | 估算 |
|---|---|
| 注册条目 + validator | 1 天 |
| 5 操作符 × 3 backend × translator + runtime | 4 天 |
| Conformance fixture (5 个) | 1.5 天 |
| 单测（每 backend）| 1 天 |
| Spec 文档更新 + lint | 0.5 天 |
| **合计** | **8 天 ≈ 1.5 周（1 FTE）/ 0.7-1 周（2 FTE）**|

## 10. 验收标准（来自 PRD §5.5）

- [ ] 5 个操作符注册并通过类型校验
- [ ] 在 Python + TypeScript + Go 三个 backend 上 conformance fixture 字节等价
- [ ] 空集合行为（`max-by`、`min-by`）跨 backend 一致（皆抛 SteleRuntimeError）
- [ ] **不存在** `entries` 操作符注册
- [ ] CDL spec 操作符总数与注册表一致（CI lint 校验）
