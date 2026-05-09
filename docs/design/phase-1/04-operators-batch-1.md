# EP04 详细设计：CDL 操作符批次 1

> PRD: [prd-phase-1.md §5](../../prd-phase-1.md) | 估算: 2-3 周 | 类别: 语言扩展

## 1. 目标

新增 18 个用户面操作符 + 1 个 alias（`filter`）→ Phase 1 末注册总数 70（用户面 69）。每个操作符必须在 Python + TypeScript backend 行为一致。

## 2. 操作符语义钉死

跨语言一致性的关键是**先写规范再写代码**。本节是规范，而非实现说明。

### 2.1 集合（4 个）

| 操作符 | 签名 | 钉死语义 |
|---|---|---|
| `length` | `(Collection) -> Number` | 元素数；空集合返回 0；非 collection 抛 SteleRuntimeError |
| `concat` | `(Collection, Collection, ...) -> Collection` | 1+ 个 collection 顺序拼接；保留重复；类型混合（如 number + string）保留原类型不强转 |
| `sort-by` | `(Collection, Path) -> Collection` | 升序：null/undefined 排末尾；NaN 排最前；数值用 `<`；字符串用 lexicographic byte 比较（**不**locale-sensitive） |
| `sort-by-desc` | `(Collection, Path) -> Collection` | 同 sort-by 反向 |

### 2.2 算术（5 个）

| 操作符 | 签名 | 钉死语义 |
|---|---|---|
| `mod` | `(Number, Number) -> Number` | **取除数符号**（Python 行为）：`mod(-7, 3) = 2`、`mod(7, -3) = -2`；除数为 0 抛错 |
| `pow` | `(Number, Number) -> Number` | IEEE-754 双精度；`Math.pow` 等价；负底数 + 非整指数 → NaN（不抛错）|
| `round` | `(Number, Number?) -> Number` | **Banker's rounding**（half to even；Python 3 / IEEE-754 默认）：`round(0.5) = 0`、`round(1.5) = 2`、`round(2.5) = 2`；第 2 参数缺省 0 |
| `ceil` | `(Number) -> Number` | 向 +∞；NaN → NaN |
| `floor` | `(Number) -> Number` | 向 -∞；NaN → NaN |

跨语言注意：

- Python 3 `round()` 已是 banker's；JS `Math.round` 是 half-away-from-zero（**必须包装**：见 §3.2）
- Python 3 `%` 是 sign-of-divisor；JS `%` 是 sign-of-dividend（**必须包装**）

### 2.3 字符串（5 个）

| 操作符 | 签名 | 钉死语义 |
|---|---|---|
| `trim` | `(String) -> String` | Unicode whitespace（包括 NBSP ` `、CJK `　`）；与 JS `String.prototype.trim()` 一致 |
| `lower` | `(String) -> String` | Unicode lowercase；locale-independent（**不**用 `String.toLocaleLowerCase()`，用 `String.toLowerCase()`）|
| `upper` | `(String) -> String` | 同 lower 反向 |
| `split` | `(String, String) -> Collection<String>` | 分隔符**不可为空**（抛 SteleRuntimeError）；最大切分次数 = 全部；分隔符匹配整字面，不解析 regex |
| `join` | `(Collection<String>, String) -> String` | 集合元素必须全为 String；validateTypes 阶段拒绝混类型 |

### 2.4 数据访问（1 个）

| 操作符 | 签名 | 钉死语义 |
|---|---|---|
| `type-of` | `(Unknown) -> String` | 返回固定 7 个值之一：`"number"` / `"string"` / `"boolean"` / `"collection"` / `"object"` / `"null"` / `"undefined"` |

### 2.5 提前的 EP13 操作符（3 + 1 alias）

| 操作符 | 签名 | 钉死语义 |
|---|---|---|
| `map` | `(Collection, Path) -> Collection` | 提取路径值为新 collection；`[steleGetPath(item, path) for item in coll]`；路径不存在的元素被跳过（**不**抛错；与 forall/exists 不同）|
| `first` | `(Collection) -> Unknown` | 第一元素；空集合**抛 SteleRuntimeError**（不返回 null/undefined） |
| `last` | `(Collection) -> Unknown` | 最后元素；空集合抛错 |
| `filter` | `(Collection, Predicate) -> Collection` | **`where` 的 alias**；同绑定语法、同 IR；翻译时 lower 到 `where` |

## 3. 实现模式（每操作符的 8 项）

### 3.1 Registry（`@stele/core/src/registry/operators.ts`）

```typescript
{
  name: "length",
  description: "Number of elements in a collection",
  params: [
    { name: "collection", type: "Collection", required: true }
  ],
  returnType: "Number",
  category: "collection",
  since: "0.2.0"
}
```

`since` 字段 v0.2 引入。lint 校验：`since` 与 npm package version 对齐。

### 3.2 Python translator (`backend-python/src/translator.ts`) + runtime

**Banker's rounding** Python 已默认，无需 wrapper；`mod` Python 已是 sign-of-divisor，无需 wrapper。

```python
# _stele_runtime.py
def stele_length(coll):
    if not isinstance(coll, (list, tuple)):
        raise SteleRuntimeError(f"length: expected collection, got {type(coll).__name__}")
    return len(coll)

def stele_split(s, sep):
    if not sep:
        raise SteleRuntimeError("split: separator cannot be empty")
    return s.split(sep)
```

### 3.3 TypeScript translator + runtime

```typescript
// _stele_runtime.ts
export function steleLength(coll: unknown): number {
  if (!Array.isArray(coll)) {
    throw new SteleRuntimeError(`length: expected collection, got ${typeof coll}`);
  }
  return coll.length;
}

// banker's rounding wrapper（JS Math.round 是 half-away-from-zero）
export function steleRound(value: number, digits = 0): number {
  if (Number.isNaN(value) || !Number.isFinite(value)) return value;
  const m = Math.pow(10, digits);
  const scaled = value * m;
  // banker's
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded;
  if (diff < 0.5) rounded = floor;
  else if (diff > 0.5) rounded = floor + 1;
  else rounded = floor % 2 === 0 ? floor : floor + 1; // half to even
  return rounded / m;
}

// mod sign-of-divisor wrapper（JS % 是 sign-of-dividend）
export function steleMod(a: number, b: number): number {
  if (b === 0) throw new SteleRuntimeError("mod: divisor cannot be zero");
  return ((a % b) + b) % b;
}

export function steleSplit(s: string, sep: string): string[] {
  if (sep === "") throw new SteleRuntimeError("split: separator cannot be empty");
  return s.split(sep);
}
```

### 3.4 Validator (`@stele/core/src/validator/types.ts`)

类型检查靠 registry 中的 `params` + `returnType` 自动推导；新操作符**不需要**新代码——只要 registry 写对。但 `join` 需特殊检查：

```typescript
// validator/types.ts 加入 special-case
// SteleError 是位置参数 API：(code, category, message, span?, detail?, hint?)
if (operatorName === "join") {
  const collParam = args[0];
  if (collParam.elementType !== "String") {
    throw new SteleError(
      "E0311",
      "TypeError",
      `join: collection must contain only strings, got ${collParam.elementType}`,
    );
  }
}
```

> 注：错误码 `E0311` 给 join；`E0312` 给 EP13 unique-by（参见 EP13 §4.2）。

### 3.5 Conformance fixture

每个新用户面操作符在 `tests/conformance/fixtures/` 添加 1 个 fixture：

```
tests/conformance/fixtures/
  ep04-length/
  ep04-concat/
  ep04-sort-by/
  ep04-sort-by-desc/
  ep04-mod/
  ep04-pow/
  ep04-round/
  ...
```

每 fixture：

- contract/main.stele 用该操作符定义 1 个 invariant
- app-state.json 含**正例**（不违约）+ 1 个 fixture 副本含**反例**（违约带特定 cause）
- expected-violations.json 描述反例的违约结构

由于 18 个 fixture 略多，可合并相近语义到 1 个 fixture（如 `ceil`+`floor`+`round` 一个 fixture 含三个 invariant）。预计 ~12 个 fixture 总数。

### 3.6 单测

每 backend 的 `translator.test.ts` 加正反测试：

```typescript
describe("operator: round (TS)", () => {
  it("rounds half to even (banker's)", () => {
    expect(translateAndEval("(round 0.5)")).toBe(0);
    expect(translateAndEval("(round 1.5)")).toBe(2);
    expect(translateAndEval("(round 2.5)")).toBe(2);
  });
  it("respects digits parameter", () => {
    expect(translateAndEval("(round 3.14159 2)")).toBeCloseTo(3.14);
  });
});
```

## 4. CDL spec 文档

`docs/spec/cdl.md` § "Core operators" 当前 44 条。本 EP 完成后必须达到 70 条（51 + 18 新 + 1 alias），覆盖：

- 51 baseline 操作符（含原 PRD 漏 7：between、approx-eq、contains、is-empty、starts-with、ends-with、has-length）
- 18 个新用户面 + 1 alias

每条目格式：

```markdown
### `length`

- **Signature**: `(length collection: Collection) -> Number`
- **Returns**: number of elements
- **Errors**:
  - `SteleRuntimeError` if argument is not a collection
- **Example**: `(length (collection orders))` → 47
- **Cross-backend semantics**: identical (Python `len()`, TS `Array.length`, Go `len()`)
- **Since**: 0.2.0
```

新增章节："Path semantics"（kebab→snake/camel fallback；参见 [EP01 §2.2.4](01-typescript-backend.md)）和 "Operator semantics across backends"（汇总表，列每个操作符的跨语言注意点）。

CI lint：`scripts/check-spec-operators.mjs` 解析 cdl.md 与 operators.ts，差异即 fail。

## 5. CI 集成

`.github/workflows/ci.yml` 新 step：

```yaml
- name: Spec operator count match
  run: node scripts/check-spec-operators.mjs
```

## 6. 工作量估算

每操作符约 4-6 小时（含跨 backend）。19 个新注册 ≈ 80-115 小时。2 FTE 并行 2-3 周。

## 7. 验收标准（来自 PRD §5.6）

- [ ] 19 个新操作符（18 新 + 1 filter alias）注册到核心注册表
- [ ] 51 + 18 = 69 用户面操作符在 Python 与 TypeScript backend 翻译都通过
- [ ] 每个新用户面操作符在 `tests/conformance/` 至少有 1 个 fixture，**两个 backend 输出 byte-equal**
- [ ] `mod`、`round`、`split` 边界条件测试通过（负数、空分隔符等）
- [ ] `docs/spec/cdl.md` 操作符总数与注册表一致（CI lint 校验）
- [ ] `filter` 与 `where` 在 conformance suite 上产生**字节相同**的生成代码
- [ ] **不存在** `group-by` 注册（Phase 3 候选）
