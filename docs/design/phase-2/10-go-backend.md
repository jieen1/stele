# EP10 详细设计：Go 后端

> PRD: [prd-phase-2.md §2](../../prd-phase-2.md) | 估算: 4-6 周 | 类别: 新后端（关键路径）

## 1. 目标

把 CDL 翻译到 Go 标准库 `testing`（默认）/ `testify`（可选）。完整复刻 Python + TypeScript backend 的语义与 runtime helpers，含 scenario / checker / failure_witness。

## 2. 公开 API

### 2.1 包导出

`packages/backend-go/src/index.ts`：

```typescript
import type { LanguageBackend, GenerationConfig, GeneratedFile, Contract } from "@stele/core";

const backend: LanguageBackend = {
  name: "go",
  framework: "testing",  // 默认；可被 testFramework: "testify" 覆盖
  fileExtension: ".go",
  version: "0.1.0",
  generate(contract, config) { /* ... */ },
  supportFiles(contract, config) { /* 返回 _stele_runtime.go */ },
};

export default backend;
```

### 2.2 注册到 backend-registry

```typescript
{ language: "go", framework: "testing", packageName: "@stele/backend-go", displayName: "Go (testing)" },
{ language: "go", framework: "testify", packageName: "@stele/backend-go", displayName: "Go (testify)" },
```

通过 [Phase 0 P0.3 backend 注册表](../phase-0/03-backend-registry.md) 装配，与 EP01 同模式。

## 3. 文件命名（修复 v0.1 草稿错误）

v0.1 草稿提议 `test_contract_test.go`（双 `_test`）违反 Go 约定 + 违反 `coordinator.ts:175-213` E0505 校验。**v2.0 修正**：

| 文件类型 | 命名 | 例子 |
|---|---|---|
| Runtime helper | `_stele_runtime.go`（E0505 强制） | `_stele_runtime.go` |
| 主测试 | `contract_main_test.go` | `contract_main_test.go` |
| group 测试 | `contract_<group>_test.go` | `contract_account_test.go` |
| 用户 setup | `setup_test.go`（用户拥有） | `setup_test.go` |

**源码模板**用 `stele_runtime.go`（无前缀）便于 Go 包内引用与开发；generator emit 时按 E0505 重命名。

## 4. 输出目录

```
contract_test/                         -- standalone Go 包
  _stele_runtime.go                    -- generator emit
  contract_main_test.go                -- generator emit
  contract_<group>_test.go             -- generator emit
  setup_test.go                        -- 用户编写
  go.mod                               -- 用户编写（指 module path）
```

`stele.config.json`：

```json
{
  "targetLanguage": "go",
  "testFramework": "testing",
  "generatedDir": "contract_test",
  "goModulePath": "github.com/example/myapp/contract_test"
}
```

`goModulePath` 用于生成器在文件顶部 emit `package contract_test`。

## 5. 类型模型

### 5.1 静态 vs 动态：混合策略

CDL 是动态类型；Go 是静态。Go runtime helper 用 `interface{}`（Go 1.21 后可用 `any` 别名）持有动态值，比较时按需提升。

**关键决定**：v1.0 草稿 "`Number → float64` 一律" **错**——它会 panic 在 ID 整数比较场景（`steleGetPath(...).(float64)` 当值是 int 时 panic）。v2.0 用 `steleNumeric` 提升策略：

```go
// _stele_runtime.go
package contract_test

import (
    "encoding/json"   // 必需：json.Number 用于 JSON 数值反序列化
    "fmt"
    "math"
    "reflect"
    "strings"
)

// steleNumeric 把任意数值返回为 (intVal, floatVal, isFloat)
// 用于比较 / 算术中的动态数值处理
func steleNumeric(v interface{}) (int64, float64, bool, error) {
    switch n := v.(type) {
    case int: return int64(n), float64(n), false, nil
    case int8: return int64(n), float64(n), false, nil
    case int16: return int64(n), float64(n), false, nil
    case int32: return int64(n), float64(n), false, nil
    case int64: return n, float64(n), false, nil
    case uint: return int64(n), float64(n), false, nil
    // ... uint variants
    case float32: return int64(n), float64(n), true, nil
    case float64:
        if n == math.Trunc(n) && !math.IsInf(n, 0) { return int64(n), n, false, nil }
        return 0, n, true, nil
    case json.Number:
        if i, err := n.Int64(); err == nil { return i, float64(i), false, nil }
        if f, err := n.Float64(); err == nil { return 0, f, true, nil }
        return 0, 0, false, fmt.Errorf("cannot parse number: %s", n)
    default:
        return 0, 0, false, fmt.Errorf("expected number, got %T", v)
    }
}

func steleEq(a, b interface{}) bool {
    ai, af, aIsFloat, aErr := steleNumeric(a)
    bi, bf, bIsFloat, bErr := steleNumeric(b)
    if aErr != nil || bErr != nil {
        // fallback: deep equal for non-numeric
        return reflect.DeepEqual(a, b)
    }
    if aIsFloat || bIsFloat {
        return math.Abs(af-bf) < 1e-9
    }
    return ai == bi
}
```

### 5.2 类型映射表

| CDL | Go runtime 持有 | 用户 stele_context 期望 |
|---|---|---|
| `Number` (整数) | `int64` (via `steleNumeric`) | `int`/`int64`/`json.Number` |
| `Number` (浮点) | `float64` | `float32`/`float64`/`json.Number` |
| `String` | `string` | `string` |
| `Boolean` | `bool` | `bool` |
| `Collection` | `[]interface{}` | 必须是 `[]interface{}`（非 `[]map[string]interface{}`） |
| `Path` | `[]string` | — |

### 5.3 v0.2 不支持的类型（明文限制）

以下类型**不**被 `steleNumeric` 处理；用户传入会得到 `expected number, got <T>` 错误：

- `*big.Int`、`*big.Float`、`*big.Rat`：任意精度数学不支持
- `decimal.Decimal`（`shopspring/decimal`）：金融场景常用；v0.2 未集成
- `time.Duration`、`time.Time`：用 ISO 字符串或 unix nano 表示
- 用户自定义数值类型（`type MyMoney int64`）：用 `int64()` 转换后再传入

如需支持，Phase 3 候选：注册用户提供的 `numeric coercer` 函数。

### 5.4 Collection 类型严格性

不像 Python/TS 端能动态转换，Go 静态类型要求 collection 必须是 `[]interface{}`。常见 Go 应用 `json.Unmarshal` 默认产 `[]interface{}` ✓。但 `map[string][]Entity` 这种业务 slice 必须用户在 `SetupSteleContext()` 中显式转：

```go
ctx.Data["accounts"] = make([]interface{}, len(realAccounts))
for i, a := range realAccounts {
    ctx.Data["accounts"].([]interface{})[i] = map[string]interface{}{
        "id": a.ID, "balance": a.Balance,
    }
}
```

文档明示此限制；examples/go-project 演示。

## 6. testify 依赖（可选）

默认**不**依赖 `testify`（与 idiomatic Go 一致）：

```go
// _stele_runtime.go (default, testing only)
import "testing"

func steleAssertTrue(t *testing.T, cond bool, msg string) {
    t.Helper()
    if !cond {
        t.Errorf(msg)
        t.FailNow()
    }
}
```

`testFramework: "testify"` 时 generator emit 用 `require`：

```go
import "github.com/stretchr/testify/require"

func TestAccountBalanceNonNegative(t *testing.T) {
    ctx := SetupSteleContext()
    accounts := ctx.Get("account").([]interface{})
    for i, a := range accounts {
        balance := steleGetPath(a, []string{"balance"})
        require.Greater(t, balance.(float64), 0.0, "balance[%d] non-negative", i)
    }
}
```

`go.sum` 由用户的 `go mod tidy` 处理；Stele 不强制版本（当 framework=testify 时 emit 注释指引用户运行 `go get github.com/stretchr/testify`）。

## 7. 路径访问

```go
func steleGetPath(obj interface{}, segments []string) (interface{}, error) {
    current := obj
    for _, seg := range segments {
        m, ok := current.(map[string]interface{})
        if !ok {
            return nil, fmt.Errorf("path navigation hit non-map at %q (got %T)", seg, current)
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
        return nil, fmt.Errorf("path not found: %q on map %v", seg, mapKeys(m))
    }
    return current, nil
}
```

与 Python（`getattr(obj, snake_case)`）和 TypeScript（`obj[camelCase]`）的 fallback 模式**对应不一致是规范的一部分**——每语言用自己的 idiomatic 命名约定。

## 8. Scenario / Checker

### 8.1 Context 接口

```go
package contract_test

type SteleContext struct {
    Data     map[string]interface{}
    Checkers map[string]CheckerFunc
    Before   *SteleContext  // state-before
    After    *SteleContext  // state-after
}

type CheckerFunc func(args []interface{}, ctx *SteleContext) CheckerResult

type CheckerResult struct {
    Ok      bool
    Message string
    Details interface{}
}

func NewContext() *SteleContext {
    return &SteleContext{
        Data:     make(map[string]interface{}),
        Checkers: make(map[string]CheckerFunc),
    }
}

func (c *SteleContext) Get(key string) interface{} {
    return c.Data[key]
}

func (c *SteleContext) RegisterChecker(name string, fn CheckerFunc) {
    c.Checkers[name] = fn
}

func steleCallChecker(name string, args []interface{}, ctx *SteleContext) (CheckerResult, error) {
    fn, ok := ctx.Checkers[name]
    if !ok {
        return CheckerResult{}, fmt.Errorf("checker %q not registered", name)
    }
    return fn(args, ctx), nil
}

func steleRunScenario(steps []ScenarioStep, ctx *SteleContext) (*SteleContext, error) {
    current := *ctx
    for _, step := range steps {
        // ... step execution (执行 / capture-state / import)
    }
    return &current, nil
}
```

### 8.2 用户 setup_test.go（修正：TestMain 唯一性）

⚠️ **关键约束**：Go 一个 test 包只能有一个 `TestMain`。Generator emit 的 `contract_main_test.go` 含唯一 TestMain；用户的 `setup_test.go` **仅导出** `SetupSteleContext()` 函数，**不**写 TestMain。

```go
// contract_test/setup_test.go (用户编写；不含 TestMain)
package contract_test

import (
    "github.com/example/myapp/ledger"
)

func SetupSteleContext() *SteleContext {
    ctx := NewContext()
    ctx.Data["account"] = ledger.RealAccountSnapshot()
    ctx.Data["positions"] = ledger.LoadOpenPositions()
    ctx.RegisterChecker("balance-change-has-transaction", func(args []interface{}, c *SteleContext) CheckerResult {
        // ...
        return CheckerResult{Ok: true}
    })
    return ctx
}
```

```go
// contract_test/contract_main_test.go (generator emit; protected)
package contract_test

import (
    "testing"
)

var globalCtx *SteleContext

func TestMain(m *testing.M) {
    globalCtx = SetupSteleContext()
    code := m.Run()
    // 退出前 flush witness 文件（参见 §9）
    flushWitnessChannel()
    os.Exit(code)
}

// 各 group test 函数也由 generator emit 在此文件或 contract_<group>_test.go
```

`stele init --language go` 创建 `setup_test.go` 模板含 SetupSteleContext stub + 注释指引用户填 stele_context；generator 不覆盖此文件。

## 9. Failure Witness（修正：file-based channel）

⚠️ 早期草稿用 `t.Logf("STELE_WITNESS:%s", ...)` 注入 witness 到 stdout，由 `stele check` parse。**v2.0 改为 file-based channel**，理由：

- `go test -v -parallel=N` 的输出在多 goroutine 间穿插；JSON 字符串可能被切碎
- 用户的 t.Logf 调试输出可能误命中 marker
- Marker 升级（v1 → v2）跨版本兼容麻烦

### 9.1 文件通道协议

Witness 文件位置：`${TMPDIR}/stele-witness-${PID}-${TEST_RUN_ID}/<test-name>-<timestamp>.json`

每次 `forall`/`exists`/`where`/`none` 失败时，runtime 写入一个 JSON 文件：

```go
type SteleAssertionError struct {
    Message string
    Witness FailureWitness
    TestName string  // 由 t.Name() 注入
}

func (e *SteleAssertionError) Error() string { return e.Message }

// runtime 在失败时调用
func emitWitness(t *testing.T, w *FailureWitness) {
    dir := os.Getenv("STELE_WITNESS_DIR")
    if dir == "" { return }  // 非 stele check 调用：不写
    safeName := strings.ReplaceAll(t.Name(), "/", "_")
    filename := fmt.Sprintf("%s-%d.json", safeName, time.Now().UnixNano())
    path := filepath.Join(dir, filename)
    data, _ := json.Marshal(map[string]interface{}{
        "test_name": t.Name(),
        "witness": w,
    })
    _ = os.WriteFile(path, data, 0644)  // 失败容忍（不影响 test 失败传播）
}

func steleForall(t *testing.T, coll []interface{}, pred func(interface{}) bool, predSource string) error {
    for i, item := range coll {
        if !pred(item) {
            w := FailureWitness{
                Operator:        "forall",
                CollectionSize:  len(coll),
                FailedAtIndex:   i,
                FailedItem:      safeSerialize(item, 2),
                PredicateSource: predSource,
            }
            emitWitness(t, &w)
            return &SteleAssertionError{
                Message: fmt.Sprintf("forall failed at index %d", i),
                Witness: w,
                TestName: t.Name(),
            }
        }
    }
    return nil
}
```

### 9.2 Generator emit 的 test 函数

```go
func TestAccountBalanceNonNegative(t *testing.T) {
    accounts := globalCtx.Get("account").([]interface{})
    err := steleForall(t, accounts, func(item interface{}) bool {
        balance, _ := steleGetPath(item, []string{"balance"})
        bi, bf, isFloat, _ := steleNumeric(balance)
        if isFloat { return bf > 0 }
        return bi > 0
    }, "(gt (path balance) 0)")
    if err != nil {
        t.Fatal(err)
    }
}
```

不需要 t.Logf；witness 通过 `emitWitness` 已写入文件通道。

### 9.3 stele check 收集流程

```typescript
// packages/cli/src/commands/check.ts (修改)
async function runGoTestRunner(projectRoot: string): Promise<{ exitCode: number; junitXml: string; witnesses: Witness[] }> {
  const witnessDir = join(tmpdir(), `stele-witness-${process.pid}-${Date.now()}`);
  await fs.mkdir(witnessDir, { recursive: true });

  const result = await runWithEnv(["go", "test", "-v", "./contract_test/..."], {
    cwd: projectRoot,
    env: { ...process.env, STELE_WITNESS_DIR: witnessDir },
  });

  // 收集 witness 文件
  const files = await fs.readdir(witnessDir);
  const witnesses: Witness[] = [];
  for (const f of files) {
    const data = JSON.parse(await fs.readFile(join(witnessDir, f), "utf-8"));
    witnesses.push(data);
  }
  // 清理
  await fs.rm(witnessDir, { recursive: true, force: true });

  return { exitCode: result.exitCode, junitXml: result.stdout, witnesses };
}
```

收集后按 `test_name` 把 witness 关联到对应 violation。

### 9.4 优势对比 t.Logf 方案

| 维度 | t.Logf 方案 | file-based |
|---|---|---|
| 并行 test 安全 | ❌ 输出可能穿插 | ✓ 各文件独立 |
| 用户日志误判 | ❌ 可能命中 marker | ✓ 隔离目录 |
| 跨版本演进 | ❌ marker 升级麻烦 | ✓ 文件 schema 直接演进 |
| Cleanup | n/a | 需 stele check 后清理 |
| Performance | 写 stdout | 写 fs（差不多）|

`-parallel=N` 默认行为不变；用户的 `go test -p X -parallel Y` 选项也不受影响。

## 10. 操作符翻译

每个 51 baseline + 18 EP04 新 + 1 alias filter + 5 EP13 = **75 registered（74 user-facing）** 个操作符在 Go runtime 实现 + translator emit。模式与 Python/TS 一致；具体实现见单测（`packages/backend-go/tests/runtime/stele_runtime_test.go`）。

跨语言精确语义：

- `mod`: 用 `((a%b)+b)%b` 实现 sign-of-divisor（Go `%` 默认 sign-of-dividend）
- `round`: 实现 banker's rounding helper（Go `math.Round` 是 half-away-from-zero）
- `split`: 空分隔符 panic → 转 SteleRuntimeError
- `filter`: alias of `where`，translator 阶段 lower 到 `where`，runtime 不需独立实现
- 其他

### 10.1 steleCompare helper（max-by/min-by 用）

EP13 `max-by` / `min-by` 依赖通用比较 helper：

```go
// _stele_runtime.go
// steleCompare 返回 -1/0/1；类型不可比时返回 error
func steleCompare(a, b interface{}) (int, error) {
    // 数值
    ai, af, aIsF, aErr := steleNumeric(a)
    bi, bf, bIsF, bErr := steleNumeric(b)
    if aErr == nil && bErr == nil {
        if aIsF || bIsF {
            if math.Abs(af - bf) < 1e-9 { return 0, nil }
            if af < bf { return -1, nil }
            return 1, nil
        }
        if ai < bi { return -1, nil }
        if ai > bi { return 1, nil }
        return 0, nil
    }
    // 字符串
    if as, ok := a.(string); ok {
        if bs, ok := b.(string); ok {
            return strings.Compare(as, bs), nil
        }
    }
    return 0, fmt.Errorf("cannot compare %T and %T", a, b)
}
```

### 10.2 safeSerialize helper

与 EP07 §3.2 等价的 Go 实现；同样限 max_depth=2、max_array=100、max_bytes=8 KB（per failed_item）；同样 redact 字段名含 password/token/secret/api_key。

## 11. 生成性能

100 invariant 套件生成时间 < 1s（GitHub Actions ubuntu-latest 4-core）。

## 12. 测试

### 12.1 TS 端

- `packages/backend-go/tests/translator.test.ts`：每操作符正反翻译测试
- `packages/backend-go/tests/integration.test.ts`：端到端 `stele generate` + `go build` + `go test`

### 12.2 Go 端

- `packages/backend-go/tests/runtime/stele_runtime_test.go`：Go runtime helpers Go 单测（`go test ./tests/runtime/...`）

### 12.3 Conformance

- `tests/conformance/` runner 加 `STELE_CONFORMANCE_BACKENDS=python,typescript,go`
- 5 个 Phase 0 fixture + 18 个 EP04 fixture + 5 个 EP13 fixture 全部跑 Go backend
- 跨 backend 字节等价（含 failure_witness 结构等价）

### 12.4 conformance fixture 06 跳过

`06-code-shape` Code Shape Python 后端独有；Go 后端 skip。runner 实现：

```typescript
if (fixture.id === "06-code-shape" && backend !== "python") {
  test.skip(`${fixture.id} on ${backend}: not yet supported`);
  return;
}
```

## 13. 估算分解

| 工作 | 估算 |
|---|---|
| 包 scaffold + LanguageBackend 注册 | 1 天 |
| 51 baseline 操作符翻译 + runtime | 8 天 |
| Path access (kebab→snake) | 0.5 天 |
| 18 个 EP04 + 5 个 EP13 操作符 | 4 天 |
| Scenario / checker runtime | 5 天 |
| Witness via t.Logf 编码 + stele check 解析 | 3 天 |
| Type 系统（steleNumeric 等）| 2 天 |
| testify 切换 | 1 天 |
| Conformance fixture + 修 bug | 5 天 |
| examples/go-project + 文档 | 2 天 |
| **合计** | **31.5 天 ≈ 6 周（1 FTE）/ 3-3.5 周（2 FTE）**|

## 14. 验收标准（来自 PRD §2.5）

- [ ] `stele init --language go` 生成正确的 contract 与 setup_test.go 骨架
- [ ] `stele generate` 生成的 Go 代码通过 `go build ./contract_test/...` 与 `go vet ./contract_test/...`
- [ ] `tests/conformance/` 5 个 Phase 0 fixture + EP04 新增 fixture 全部在 Go backend 上通过
- [ ] **跨 backend 一致性**：每个 fixture 在 Python + TypeScript + Go 三 backend 上 violation report 字节等价（含 failure_witness 结构等价）
- [ ] Scenario fixture 在 Go backend 上行为等价
- [ ] `_stele_runtime.go` 不引入 `testify` 依赖（除非 user 在 config 显式启用）
- [ ] `examples/go-project/` 演示
- [ ] `docs/guides/go-integration.md` 完整
