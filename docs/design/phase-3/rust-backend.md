# Rust 后端详细设计

> PRD: [prd-phase-2.md](../../prd-phase-2.md) | 估算: 4-6 周 | 类别: 新后端（关键路径）
> 参照: [EP01 TypeScript 设计](../phase-1/01-typescript-backend.md) | [EP10 Go 设计](../phase-2/10-go-backend.md)

## 1. 目标

把 CDL 翻译到 Rust `cargo test`（默认）。完整复刻 Python + TypeScript + Go backend 的语义与 runtime helpers，含 scenario / checker / failure_witness。

## 2. 公开 API

### 2.1 包导出

`packages/backend-rust/src/index.ts`：

```typescript
import type { LanguageBackend, GenerationConfig, GeneratedFile, Contract } from "@stele/core";

const backend: LanguageBackend = {
  name: "rust",
  framework: "cargo-test",  // Rust 标准库测试
  fileExtension: ".rs",
  version: "0.1.0",
  generate(contract, config) { /* ... */ },
  supportFiles(contract, config) { /* 返回 _stele_runtime.rs */ },
};

export default backend;
```

### 2.2 注册到 backend-registry

```typescript
{ language: "rust", framework: "cargo-test", packageName: "@stele/backend-rust", displayName: "Rust (cargo test)" },
```

通过 [Phase 0 P0.3 backend 注册表](../phase-0/03-backend-registry.md) 装配。

## 3. 项目结构

Rust 的测试模型与 Go/Python 不同——测试代码作为 crate 的 `tests/` 目录（integration tests）或 `src/` 内的 `#[cfg(test)]` 模块。

**Stele 选择 integration test 模式**（`tests/` 目录），理由：
- 隔离：不污染源码 crate
- 用户只需 `Cargo.toml` 声明 `stele-runtime` 依赖
- `cargo test` 自动发现

```
tests/contract/                          -- Stele 生成目录
  _stele_runtime.rs                      -- generator emit (runtime helpers)
  test_contract.rs                       -- generator emit (主测试，包含 #[path] 指向 runtime)
  test_<group>.rs                        -- generator emit (group 测试，包含 #[path] 指向 runtime)
  conftest.rs                            -- 用户编写 (context 初始化)
```

**注意**：Rust 的 `tests/` 目录中每个 `.rs` 文件是独立的编译单元（integration test crate），不能使用 `mod.rs` 作为模块入口或 `mod _stele_runtime;` 声明子模块。Stele 采用 `#[path]` 属性将 runtime 嵌入到每个测试文件的命名空间中。

`stele.config.json`：

```json
{
  "targetLanguage": "rust",
  "testFramework": "cargo-test",
  "generatedDir": "tests/contract"
}
```

## 4. 文件命名（E0505 合规）

| 文件类型 | 命名 | 说明 |
|---|---|---|
| Runtime helper | `_stele_runtime.rs` | E0505 强制，通过 `#[path]` 嵌入各测试文件 |
| 主测试 | `test_contract.rs` | `#[test]` 函数集合，内含 `#[path]` 指向 runtime |
| group 测试 | `test_<group>.rs` | 每 group 一个文件，内含 `#[path]` 指向 runtime |
| 用户 setup | `conftest.rs` | 用户编写，不被 generator 覆盖 |

## 5. 类型模型

### 5.1 动态值表示

CDL 是动态类型；Rust 是静态。用 `enum` 表示所有可能值：

```rust
// _stele_runtime.rs
use std::collections::BTreeMap;

/// 包装 f64 以便实现 `Ord`（f64 本身不支持 Ord 因为 NaN）。
/// NaN 始终排在末尾，确保 `BTreeSet`/`BTreeMap` 排序稳定。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SteleFloat(pub f64);

impl PartialOrd for SteleFloat {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        self.0.partial_cmp(&other.0)
    }
}

impl Ord for SteleFloat {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        match self.0.partial_cmp(&other.0) {
            Some(ord) => ord,
            None => {
                // NaN 排序在末尾。两个都是 NaN 时按位序排序（确定性）。
                if self.0.is_nan() && other.0.is_nan() {
                    self.0.to_bits().cmp(&other.0.to_bits())
                } else if self.0.is_nan() {
                    std::cmp::Ordering::Greater
                } else {
                    std::cmp::Ordering::Less
                }
            }
        }
    }
}

/// Stele 动态值——等价于 Python `object`、JS `unknown`、Go `interface{}`。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
pub enum SteleValue {
    Absent,   // 路径不存在（CDL "absent"，不同于显式 null）
    Null,     // 显式 null 值
    Bool(bool),
    Int(i64),
    Float(SteleFloat),
    Str(String),
    List(Vec<SteleValue>),
    Map(BTreeMap<String, SteleValue>),
}
```

**设计决策**：
- `BTreeMap` 而非 `HashMap`：确定性迭代顺序（测试断言输出稳定）
- `i64` 而非 `isize`：跨平台一致性
- `serde` derive：witness 序列化、JSON 互操作
- `#[derive(PartialEq)]`：结构相等比较
- `Absent` 区分于 `Null`：CDL 区分显式 `null` 值和路径不存在（absent）。`stele_get_path` 在路径找不到时返回 `SteleValue::Absent` 而非 `Null`，使操作符（如 `exists`）能正确区分两者

### 5.2 数值提升策略

CDL 的 `Number` 不区分整数/浮点。Rust runtime 用 `SteleValue::Int` 和 `SteleValue::Float` 分离，比较时提升：

```rust
/// 数值提升：两个操作数中任一方为 Float 则提升到 f64。
/// 比较容忍度 1e-9（与 Python/TS/Go 一致）。
pub fn stele_numeric_cmp(a: &SteleValue, b: &SteleValue) -> Result<SteleCmp, SteleRuntimeError> {
    // 先尝试两个都是整数
    if let (SteleValue::Int(ai), SteleValue::Int(bi)) = (a, b) {
        return if ai < bi { Ok(SteleCmp::Less) }
               else if ai == bi { Ok(SteleCmp::Eq) }
               else { Ok(SteleCmp::Greater) };
    }
    // 任一方为 Float 则都提升到 f64
    let af = a.to_f64()?;
    let bf = b.to_f64()?;
    let diff = af - bf;
    if diff.abs() < 1e-9 { Ok(SteleCmp::Eq) }
    else if diff < 0.0 { Ok(SteleCmp::Less) }
    else { Ok(SteleCmp::Greater) }
}

impl SteleValue {
    /// 提取字符串值。仅当 `self` 为 `SteleValue::Str` 时返回 `Some`。
    pub fn as_str(&self) -> Option<&str> {
        match self {
            SteleValue::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn to_f64(&self) -> Result<f64, SteleRuntimeError> {
        match self {
            SteleValue::Int(n) => Ok(*n as f64),
            SteleValue::Float(f) => Ok(f.0),
            _ => Err(SteleRuntimeError::new(format!("expected number, got {:?}", self))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SteleCmp {
    Less,
    Eq,
    Greater,
}

/// 运行时错误：包装消息与可选的上下文值。
#[derive(Debug)]
pub struct SteleRuntimeError {
    pub message: String,
    pub context: Option<SteleValue>,
}

impl SteleRuntimeError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), context: None }
    }

    pub fn with_context(message: impl Into<String>, context: SteleValue) -> Self {
        Self { message: message.into(), context: Some(context) }
    }
}

impl std::fmt::Display for SteleRuntimeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SteleRuntimeError: {}", self.message)
    }
}

impl std::error::Error for SteleRuntimeError {}

/// 断言错误：扩展 SteleRuntimeError，附加 witness 数据。
#[derive(Debug)]
pub struct SteleAssertionError {
    pub message: String,
    pub witness: FailureWitness,
}

impl SteleAssertionError {
    pub fn new(message: impl Into<String>, witness: FailureWitness) -> Self {
        Self { message: message.into(), witness }
    }
}

impl std::fmt::Display for SteleAssertionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SteleAssertionError: {}", self.message)
    }
}

impl std::error::Error for SteleAssertionError {}
```

### 5.3 类型映射表

| CDL 类型 | Rust runtime | 用户 context 期望 |
|---|---|---|
| `Number` (整数) | `SteleValue::Int(i64)` | `i64` |
| `Number` (浮点) | `SteleValue::Float(SteleFloat)` | `f64` |
| `String` | `SteleValue::Str(String)` | `&str` 或 `String` |
| `Boolean` | `SteleValue::Bool(bool)` | `bool` |
| `Collection` | `SteleValue::List(Vec<SteleValue>)` | `Vec<SteleValue>` |
| `Path` | `&[&str]` | — |

### 5.4 不支持的类型

- `u128`/`i128`：超出 `i64` 范围的值会 panic。Phase 3 候选：`BigInt` 支持。
- `bigdecimal`：金融场景。v0.2 不支持。
- `NaiveDateTime`：用 ISO 字符串或 unix timestamp。

## 6. 路径访问

```rust
/// 路径导航：逐段从 SteleValue::Map 中查找。
/// 找不到时尝试 kebab -> snake_case fallback（与 Python 一致）。
/// 路径不存在时返回 `SteleValue::Absent`（而非 `Null`），使 `exists` 等操作符能区分两者。
///
/// 返回所有权（而非借用），因为需要容纳 `SteleValue::Absent` 这种"空"值。
/// 若需要借用版本（路径不存在时返回 Err），请使用 `stele_get_path_ref()`。
pub fn stele_get_path(obj: &SteleValue, segments: &[&str]) -> SteleValue {
    let mut current = obj;
    for &seg in segments {
        if let SteleValue::Map(ref map) = current {
            if let Some(val) = map.get(seg) {
                current = val;
                continue;
            }
            // kebab -> snake_case fallback
            let snake = seg.replace('-', "_");
            if let Some(val) = map.get(&snake) {
                current = val;
                continue;
            }
            return SteleValue::Absent;
        } else {
            return SteleValue::Absent;
        }
    }
    current.clone()
}

/// 借用版本：路径不存在时返回 Err（用于需要详细错误信息的场景）。
pub fn stele_get_path_ref<'a>(obj: &'a SteleValue, segments: &[&str]) -> Result<&'a SteleValue, SteleRuntimeError> {
    let mut current = obj;
    for &seg in segments {
        if let SteleValue::Map(ref map) = current {
            if let Some(val) = map.get(seg) {
                current = val;
                continue;
            }
            let snake = seg.replace('-', "_");
            if let Some(val) = map.get(&snake) {
                current = val;
                continue;
            }
            return Err(SteleRuntimeError::new(format!(
                "path not found: segment {:?} on Map with keys {:?}",
                seg, map.keys().collect::<Vec<_>>()
            )));
        } else {
            return Err(SteleRuntimeError::new(format!(
                "path navigation hit non-Map at segment {:?} (got {:?})",
                seg, current
            )));
        }
    }
    Ok(current)
}
```

## 7. 测试生成模板

### 7.1 测试文件结构（使用 `#[path]` 嵌入 runtime）

Rust 的 `tests/` 目录中每个 `.rs` 文件是独立的编译单元（独立的 integration test crate）。不能使用 `mod.rs` 入口或 `mod` 声明来共享代码。

**解决方案**：在每个生成的测试文件顶部使用 `#[path]` 属性将 `_stele_runtime.rs` 嵌入为私有模块，然后 `pub use` 重导出。

```rust
// tests/contract/test_contract.rs
#[path = "_stele_runtime.rs"]
mod _stele_runtime;
pub use _stele_runtime::*;

// conftest 由用户编写，通过相对路径引用
#[path = "conftest.rs"]
mod conftest;
pub use conftest::stele_context;
```

每个生成的测试文件（`test_contract.rs`、`test_<group>.rs`）都以相同的 `#[path]` 前缀开头。generator 在 emit 时自动添加这些行。

### 7.2 生成的测试函数

```rust
// tests/contract/test_contract.rs
// 注意：此处不写 `use super::*;` —— `tests/` 目录中每个文件是独立的 integration test crate，`super` 不存在。
// 文件顶部的 `#[path]` + `pub use _stele_runtime::*` 已将所有 runtime 符号导入当前命名空间。

#[test]
fn test_ACCT_BALANCE_POSITIVE() {
    let ctx = stele_context();
    // stele_get_path 现在返回所有权的 SteleValue，路径不存在时返回 Absent。
    // 若需要详细错误信息，使用 stele_get_path_ref() 返回 Result<&SteleValue, Error>。
    let accounts = stele_get_path(&ctx, &["accounts"]);
    let items = match accounts {
        SteleValue::List(items) => items,
        SteleValue::Absent => panic!("ACCT_BALANCE_POSITIVE: path accounts is absent"),
        _ => panic!("ACCT_BALANCE_POSITIVE: accounts is not a list"),
    };
    for (i, item) in items.iter().enumerate() {
        let balance = stele_get_path(item, &["balance"]);
        if matches!(&balance, SteleValue::Absent) {
            panic!("ACCT_BALANCE_POSITIVE: path balance[{}] is absent", i);
        }
        if let SteleCmp::Less | SteleCmp::Eq = stele_numeric_cmp(&balance, &SteleValue::Int(0)) {
            panic!("ACCT_BALANCE_POSITIVE: balance[{}] <= 0", i);
        }
    }
}
```

### 7.3 forall/exists 等量词

```rust
pub fn stele_forall<'a, F>(
    items: &'a [SteleValue],
    pred: F,
    pred_source: &str,
    test_name: &str,
) -> Result<(), SteleAssertionError>
where
    F: Fn(&'a SteleValue) -> bool,
{
    for (i, item) in items.iter().enumerate() {
        if !pred(item) {
            let witness = FailureWitness {
                operator: "forall".to_string(),
                collection_size: items.len(),
                failed_at_index: Some(i),
                failed_item: Some(safe_serialize(item, 2)),
                predicate_source: Some(pred_source.to_string()),
                truncated: false,
            };
            emit_witness(&witness, test_name);
            return Err(SteleAssertionError {
                message: format!("forall failed at index {}", i),
                witness,
            });
        }
    }
    Ok(())
}
```

## 8. Context 接口

### 8.1 用户 conftest.rs

```rust
// tests/contract/conftest.rs (用户编写)
// 注意：此处不写 `use super::*;` —— `tests/` 目录中每个文件是独立的 integration test crate。
// 该文件通过测试文件顶部的 `#[path]` 属性嵌入，共享同一命名空间。
// 因为 conftest.rs 本身也需要 `_stele_runtime` 中的类型（如 `SteleValue`），
// 需在文件顶部显式添加 `#[path]` 引入。
#[path = "_stele_runtime.rs"]
mod _stele_runtime;
use _stele_runtime::SteleValue;

pub fn stele_context() -> SteleValue {
    // 用户从应用加载真实数据
    SteleValue::Map(
        [
            ("account".to_string(), SteleValue::Map(
                [("balance".to_string(), SteleValue::Int(100))]
                    .into_iter().collect()
            )),
            ("accounts".to_string(), SteleValue::List(vec![
                SteleValue::Map([("balance".to_string(), SteleValue::Int(100))].into_iter().collect()),
                SteleValue::Map([("balance".to_string(), SteleValue::Int(50))].into_iter().collect()),
            ])),
        ]
        .into_iter()
        .collect()
    )
}
```

### 8.2 Checker

```rust
// Checker 注册和调用
pub type CheckerFn = Box<dyn Fn(&[SteleValue], &SteleValue) -> CheckerResult + Send + Sync>;

pub struct CheckerResult {
    pub ok: bool,
    pub message: Option<String>,
    pub details: Option<SteleValue>,
}

pub fn stele_call_checker(
    checkers: &BTreeMap<String, CheckerFn>,
    name: &str,
    args: &[SteleValue],
    ctx: &SteleValue,
) -> Result<CheckerResult, SteleRuntimeError> {
    checkers.get(name)
        .map(|f| f(args, ctx))
        .ok_or_else(|| SteleRuntimeError::new(format!("checker {:?} not registered", name)))
}
```

### 8.3 `writeFixtureBootstrap()`——Conformance Fixture Bootstrap

对于 Conformance fixture，generator 需要 emit 一个 fixture 专用的 bootstrap 文件，将 `ConformanceFixture.appState` 转换为 Rust 可执行的测试上下文。

`writeFixtureBootstrap(fixture: ConformanceFixture, config: GenerationConfig): GeneratedFile` 负责：

1. 读取 fixture 的 `appState` JSON
2. 将其序列化为 `SteleValue` 的字面量 Rust 代码
3. 生成 `tests/contract/_stele_fixture.rs`，内容为一个 `stele_fixture_context()` 函数返回该值

```rust
// tests/contract/_stele_fixture.rs (由 generator emit)
// 注意：此处不写 `use super::*;` —— `tests/` 目录中每个文件是独立的 integration test crate。
// 函数名使用 `stele_fixture_context()` 以避免与用户 conftest.rs 中的 `stele_context()` 碰撞。
use _stele_runtime::SteleValue;

pub fn stele_fixture_context() -> SteleValue {
    SteleValue::Map([
        ("account".to_string(), SteleValue::Map([
            ("balance".to_string(), SteleValue::Int(100)),
            ("owner".to_string(), SteleValue::Str("alice".to_string())),
        ].into_iter().collect())),
        ("accounts".to_string(), SteleValue::List(vec![
            SteleValue::Map([("balance".to_string(), SteleValue::Int(100))].into_iter().collect()),
            SteleValue::Map([("balance".to_string(), SteleValue::Int(50))].into_iter().collect()),
        ])),
    ].into_iter().collect())
}
```

生成策略：
- 使用 JSON → `SteleValue` 字面量的递归转换（类似 Python backend 的 `emitFixtureBootstrap`）
- 文件以 `_stele_` 前缀命名，确保不被误认为测试模块
- 仅 Conformance fixture 生成；正常的 `stele generate` 不生成此文件
- 与 Python/TypeScript 的 fixture bootstrap 语义等价：都是从 `ConformanceFixture.appState` 构造 fixture context 返回

与 Python/TypeScript 的对应关系：
| Backend | Bootstrap 文件 | 函数 |
|---|---|---|
| Python | `tests/contract/_stele_fixture.py` | `stele_context()` |
| TypeScript | `tests/contract/_stele_fixture.ts` | `steleContext()` |
| Rust | `tests/contract/_stele_fixture.rs` | `stele_fixture_context()` |

## 9. Failure Witness

### 9.1 文件通道协议

与 Go backend 一致，使用文件通道。Rust 版本用 `std::fs::write`：

```rust
/// 线程局部计数器：每个测试线程独立递增 witness 索引，避免多线程竞争。
/// cargo test 默认使用线程池运行测试，`thread_local!` 确保每个线程有自己的计数器。
/// 使用 `AtomicUsize` 而非 `Cell<usize>`：`Cell::new(0)` 不是 const 表达式（stable Rust），
/// 而 `AtomicUsize::new(0)` 是 const fn，可直接用于 `thread_local!` 初始化。
thread_local! {
    static WITNESS_INDEX: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
}

/// 获取并递增当前线程的 witness 索引。
fn next_witness_index() -> usize {
    WITNESS_INDEX.with(|idx| idx.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}

pub fn emit_witness(witness: &FailureWitness, test_name: &str) {
    let dir = std::env::var("STELE_WITNESS_DIR").ok()?;
    // 使用确定性文件名：测试名称 + 操作符 + 自动递增索引
    let index = next_witness_index();
    let filename = format!("witness-{}-{}-{}.json", test_name, witness.operator, index);
    let path = std::path::Path::new(&dir).join(filename);
    let json = serde_json::to_string(witness).ok()?;
    let _ = std::fs::write(&path, json); // best-effort
}

#[derive(Debug, serde::Serialize)]
pub struct FailureWitness {
    pub operator: String,
    pub collection_size: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_at_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_item: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub predicate_source: Option<String>,
    pub truncated: bool,
}
```

### 9.2 stele check 收集

CLI 侧与 Go 一致：创建临时目录、设置 `STELE_WITNESS_DIR`、运行 `cargo test`、收集 JSON 文件。

```typescript
// packages/cli/src/commands/check.ts
async function runRustTestRunner(projectRoot: string): Promise<RustResult> {
  const witnessDir = join(tmpdir(), `stele-witness-${process.pid}-${Date.now()}`);
  await mkdir(witnessDir, { recursive: true });

  // 运行所有 Stele 生成的测试文件（test_contract.rs + test_<group>.rs）。
  // 不能只用 `--test test_contract`，那只会运行 test_contract.rs 而忽略 group 测试。
  // 扫描 `tests/contract/` 目录，收集所有 `test_*.rs` 文件，逐一指定 `--test`。
  const generatedTests = await findGeneratedTests(projectRoot);
  const testArgs = generatedTests.flatMap(name => ["--test", name]);
  const result = await spawnAsync("cargo", ["test", ...testArgs], {
    cwd: projectRoot,
    env: { ...process.env, STELE_WITNESS_DIR: witnessDir },
  });

  const witnesses = await collectWitnessFiles(witnessDir);
  await rm(witnessDir, { recursive: true, force: true });

  return { exitCode: result.status, witnesses };
}

/// 扫描 `tests/contract/` 目录，返回所有 `test_*.rs` 文件的基名（不含 .rs）。
async function findGeneratedTests(projectRoot: string): Promise<string[]> {
  const contractDir = join(projectRoot, "tests", "contract");
  const files = await readdir(contractDir);
  return files
    .filter(f => f.startsWith("test_") && f.endsWith(".rs"))
    .map(f => f.slice(0, -3)); // strip .rs
}
```

## 10. 操作符翻译

与 Python/TS/Go 一致。每个 75 registered 操作符实现。

### 10.1 算术运算符

```rust
/// 注意：i64 算术使用 saturating 操作防止溢出 panic。
/// 溢出时使用 saturating_add（饱和到 i64::MAX / i64::MIN），与 Python 的大整数语义不一致，
/// 但避免了 Rust debug/release 模式的未定义行为差异。
pub fn stele_add(a: &SteleValue, b: &SteleValue) -> Result<SteleValue, SteleRuntimeError> {
    // 整数 + 整数 = 整数（使用 saturating_add 防止溢出）
    if let (SteleValue::Int(ai), SteleValue::Int(bi)) = (a, b) {
        return Ok(SteleValue::Int(ai.saturating_add(*bi)));
    }
    // 否则提升为 f64
    let af = a.to_f64()?;
    let bf = b.to_f64()?;
    Ok(SteleValue::Float(SteleFloat(af + bf)))
}

pub fn stele_mod(a: &SteleValue, b: &SteleValue) -> Result<SteleValue, SteleRuntimeError> {
    // 整数 % 整数 = 整数
    if let (SteleValue::Int(ai), SteleValue::Int(bi)) = (a, b) {
        if *bi == 0 {
            return Err(SteleRuntimeError::new("modulo by zero"));
        }
        let result = ((ai % bi) + bi) % bi; // sign-of-divisor
        return Ok(SteleValue::Int(result));
    }
    // 任一方为 Float 则提升到 f64
    let af = a.to_f64()?;
    let bf = b.to_f64()?;
    let result = ((af % bf) + bf) % bf; // sign-of-divisor
    Ok(SteleValue::Float(SteleFloat(result)))
}
```

### 10.2 集合运算符

```rust
pub fn stele_sum(items: &[SteleValue], path: &[&str]) -> Result<SteleValue, SteleRuntimeError> {
    // 当所有输入都是 Int 时，直接以 i64 累加（避免 f64 精度丢失）
    // 仅当存在 Float 时使用 f64 累加
    // 注意：i64 累加使用 saturating_add 防止溢出
    let mut int_total: i64 = 0;
    let mut float_total: f64 = 0.0;
    let mut has_float = false;
    let mut is_first = true;

    for item in items {
        // stele_get_path 返回所有权的 SteleValue；若路径不存在返回 Absent，
        // 此处 skip Absent 项（与 Python backend 的 "absent = skip" 语义一致）。
        let val = stele_get_path(item, path);
        match val {
            SteleValue::Int(n) => {
                if has_float {
                    float_total += n as f64;
                } else {
                    int_total = int_total.saturating_add(n);
                }
            }
            SteleValue::Absent => continue,
            _ => {
                if is_first && !has_float {
                    // 第一个值是 Float，将 int_total 转移
                    float_total = int_total as f64 + val.to_f64()?;
                    has_float = true;
                } else {
                    float_total += val.to_f64()?;
                    has_float = true;
                }
            }
        }
        is_first = false;
    }

    if has_float {
        Ok(SteleValue::Float(SteleFloat(float_total)))
    } else {
        Ok(SteleValue::Int(int_total))
    }
}

/// 语义说明：`unique` 是谓词（predicate），检查集合中所有元素的值是否互不相同。
/// 与 `distinct`（返回去重后的集合）不同，`unique` 返回布尔值：
/// - `true`：所有值唯一（无重复）
/// - `false`：存在重复值
/// CDL 规范: `unique(Collection, Path?) -> Boolean`
pub fn stele_unique(items: &[SteleValue], path: &[&str]) -> bool {
    let mut seen = std::collections::BTreeSet::new();
    for item in items {
        // 若路径不存在则跳过该条目（与 sum 的 Absent=skip 语义一致）。
        let val = match stele_get_path_ref(item, path) {
            Ok(v) => v.clone(),
            Err(_) => continue,
        };
        // SteleValue 实现 Ord，直接用 BTreeSet<SteleValue> 做唯一性判定
        if !seen.insert(val) {
            return false; // 发现重复
        }
    }
    true
}
```

### 10.3 字符串运算符

```rust
pub fn stele_starts_with(value: &SteleValue, prefix: &SteleValue) -> Result<bool, SteleRuntimeError> {
    let s = value.as_str().ok_or_else(|| SteleRuntimeError::new("expected string"))?;
    let p = prefix.as_str().ok_or_else(|| SteleRuntimeError::new("expected string"))?;
    Ok(s.starts_with(p))
}

pub fn stele_matches(value: &SteleValue, pattern: &SteleValue) -> Result<bool, SteleRuntimeError> {
    let s = value.as_str().ok_or_else(|| SteleRuntimeError::new("expected string"))?;
    let p = pattern.as_str().ok_or_else(|| SteleRuntimeError::new("expected string"))?;
    // ReDoS protection
    if has_redos_pattern(p) {
        return Err(SteleRuntimeError::new(format!("potentially dangerous regex pattern: {}", p)));
    }
    let re = regex::Regex::new(p).map_err(|e| SteleRuntimeError::new(e.to_string()))?;
    Ok(re.is_match(s))
}
```

### 10.4 辅助函数

```rust
/// 安全序列化：将 SteleValue 序列化为 JSON 字符串，限制最大嵌套深度防止爆炸。
/// 超过 max_depth 时截断为 "[truncated]"。
pub fn safe_serialize(value: &SteleValue, max_depth: usize) -> String {
    safe_serialize_inner(value, max_depth, 0)
}

fn safe_serialize_inner(value: &SteleValue, max_depth: usize, current_depth: usize) -> String {
    if current_depth > max_depth {
        return "[truncated]".to_string();
    }
    match value {
        SteleValue::Absent => "null".to_string(),
        SteleValue::Null => "null".to_string(),
        SteleValue::Bool(b) => b.to_string(),
        SteleValue::Int(n) => n.to_string(),
        SteleValue::Float(f) => f.0.to_string(),
        SteleValue::Str(s) => format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")),
        SteleValue::List(items) => {
            let elems: Vec<String> = items
                .iter()
                .map(|item| safe_serialize_inner(item, max_depth, current_depth + 1))
                .collect();
            format!("[{}]", elems.join(", "))
        }
        SteleValue::Map(map) => {
            let pairs: Vec<String> = map
                .iter()
                .map(|(k, v)| {
                    format!(
                        "\"{}\": {}",
                        k.replace('\\', "\\\\").replace('"', "\\\""),
                        safe_serialize_inner(v, max_depth, current_depth + 1)
                    )
                })
                .collect();
            format!("{{{}}}", pairs.join(", "))
        }
    }
}

/// ReDoS 防护：检查正则表达式是否包含嵌套量词（如 `(a+)+`、`(a*)*`）。
/// 检测到危险模式时返回 true，调用方应拒绝该模式。
pub fn has_redos_pattern(pattern: &str) -> bool {
    // 简易启发式：检查是否存在捕获组内包含量词（+/*），且组外也带量词。
    // 生产实现应使用 `regex_automata` 或 `re2` 做完整分析，此处为存根。
    pattern.contains("(+") || pattern.contains("(*)")
}

/// 合并上下文：将两个 SteleValue::Map 浅合并（right 优先）。
/// 若任一方不是 Map，返回 right。
pub fn merge_context(left: &SteleValue, right: &SteleValue) -> SteleValue {
    match (left, right) {
        (SteleValue::Map(lm), SteleValue::Map(rm)) => {
            let mut merged = lm.clone();
            merged.extend(rm.clone());
            SteleValue::Map(merged)
        }
        (_, other) => other.clone(),
    }
}
```

## 11. Scenario / Checker

### 11.0 ScenarioStep 结构

```rust
/// 场景步骤：描述场景中的一个操作。
/// 字段与 core conformance fixture 的 `ScenarioStep` 类型一致。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ScenarioStep {
    /// 步骤类型："execute", "capture-state", "import"
    pub r#type: String,
    /// 执行路径或模块路径（取决于 type）
    pub path: Option<String>,
    /// 期望结果（用于断言验证）
    pub expected: Option<SteleValue>,
    /// 调用参数
    pub args: Vec<SteleValue>,
    /// 函数名（"execute" 类型时使用）
    #[serde(default)]
    pub function: String,
    /// 模块名（"import" 类型时使用）
    #[serde(default)]
    pub module: String,
}
```

### 11.1 Scenario 执行

```rust
/// Rust 无法在运行时通过字符串名动态调用函数。
/// 使用 `ScenarioRegistry` trait 让用户代码注册可调用的函数名 → 闭包映射，
/// 生成的测试代码在编译期通过匹配分发到具体函数。

/// 场景步骤注册器：将函数名映射到可调用闭包。
pub trait ScenarioRegistry {
    fn execute_step(&self, name: &str, args: &[SteleValue], ctx: &SteleValue)
        -> Result<SteleValue, SteleRuntimeError>;
}

/// 生成的测试通过 match 分发（编译期确定，非运行时反射）。
/// 用户只需在 conftest.rs 中实现此 trait 或调用 `register_scenario_step`。
pub fn stele_run_scenario<R: ScenarioRegistry>(
    registry: &R,
    steps: &[ScenarioStep],
    ctx: &mut SteleValue,
) -> Result<SteleValue, SteleRuntimeError> {
    for step in steps {
        match step.r#type {
            "execute" => {
                let result = registry.execute_step(&step.function, &step.args, ctx)?;
                // 将结果合并回 ctx
                *ctx = merge_context(ctx, &result);
            }
            "capture-state" => { /* snapshot current state */ }
            "import" => {
                // 安全：import allowlist
                assert_import_allowed(&step.module)?;
            }
        }
    }
    Ok(ctx.clone())
}

/// 注册模式示例（用户 conftest.rs 中编写）：
///
/// struct MyAppRegistry;
///
/// impl ScenarioRegistry for MyAppRegistry {
///     fn execute_step(&self, name: &str, args: &[SteleValue], ctx: &SteleValue)
///         -> Result<SteleValue, SteleRuntimeError>
///     {
///         match name {
///             "create_order" => create_order(args, ctx),
///             "process_payment" => process_payment(args, ctx),
///             other => Err(SteleRuntimeError::new(format!(
///                 "scenario step {:?} not registered", other))),
///         }
///     }
/// }
```

### 11.2 Import 安全（生成时检查）

Rust 的 `use` 语句是编译期约束——如果导入的 crate 不存在，`cargo build` 直接失败。因此 Stele 的 import 安全检查在**代码生成时**执行，而非运行时：generator 在 emit `use` 语句前校验目标 crate 是否在 allowlist 中。若不在，generator 拒绝生成该导入并报错，而非生成一段运行时检查的代码。

使用 **allowlist** 而非 blocklist（与 TypeScript backend 的安全模型一致）。定义 `STELE_ALLOWED_CRATES` 仅包含安全的 crate，其余一律拒绝：

```rust
static STELE_ALLOWED_CRATES: once_cell::sync::Lazy<std::collections::HashSet<&'static str>> =
    once_cell::sync::Lazy::new(|| {
        [
            "stele_runtime",    // Stele runtime helpers
            "serde",            // 序列化
            "serde_json",       // JSON 互操作
            "std",              // 标准库核心类型（String, Vec, BTreeMap 等）
        ]
        .into_iter().collect()
    });

/// 用户 crate 配置：通过 `STELE_USER_CRATES` 环境变量或 `stele.config.json` 指定。
/// 用户的应用 crate 通常与测试在同一 workspace 中，是本地可信代码，应始终被允许导入。
/// 用法：`stele.config.json` 中添加 `"userCrates": ["my_app", "my_domain"]`，
/// 或通过环境变量 `STELE_USER_CRATES=my_app,my_domain` 注入。
static STELE_USER_CRATES: once_cell::sync::Lazy<std::collections::HashSet<String>> =
    once_cell::sync::Lazy::new(|| {
        std::env::var("STELE_USER_CRATES")
            .unwrap_or_default()
            .split(',')
            .filter(|s| !s.is_empty())
            .map(|s| s.trim().to_string())
            .collect()
    });

fn assert_import_allowed(module: &str) -> Result<(), SteleRuntimeError> {
    // 提取 crate 名（模块路径的第一个段）
    let crate_name = module.split("::").next().unwrap_or(module);

    // 用户应用 crate 总是允许（本地 workspace 内的代码是可信的）
    if STELE_USER_CRATES.contains(crate_name) {
        return Ok(());
    }

    if !STELE_ALLOWED_CRATES.contains(crate_name) {
        return Err(SteleRuntimeError::new(format!(
            "Module {:?} is not in the Stele allowlist. Allowed crates: {:?} + user crates: {:?}",
            module,
            STELE_ALLOWED_CRATES.iter().collect::<Vec<_>>(),
            STELE_USER_CRATES.iter().collect::<Vec<_>>()
        )));
    }
    Ok(())
}
```

## 12. Cargo.toml 依赖

生成的代码需要以下 crate：

| crate | 版本 | 来源 | 用途 |
|---|---|---|---|
| `serde` | `1.x` | 第三方 | `SteleValue` 序列化 |
| `serde_json` | `1.x` | 第三方 | witness JSON |
| `regex` | `1.x` | 第三方 | `matches` 运算符 |
| `once_cell` | `1.x` | 第三方 | 静态初始化 |
| `std::collections::BTreeMap` | std | 标准库 | `SteleValue::Map` |

**重要**：`_stele_runtime.rs` 仅需要 `serde`、`serde_json`、`regex`、`once_cell` 四个第三方 crate。不引入其他依赖。

`stele init --language rust` 在 `Cargo.toml` 中添加依赖：

```toml
[dev-dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
regex = "1"
once_cell = "1"
```

## 13. 测试策略

### 13.1 TS 端测试

- `packages/backend-rust/tests/translator.test.ts`：每操作符翻译测试
- `packages/backend-rust/tests/integration.test.ts`：端到端 `stele generate` + `cargo test`

### 13.2 Rust runtime 测试

- `packages/backend-rust/runtime/tests/_stele_runtime_test.rs`：runtime helpers 单测（`cargo test` 运行）

### 13.3 Conformance

- `tests/conformance/` runner 加 `STELE_CONFORMANCE_BACKENDS=...,rust`
- 全部 fixture 跑 Rust backend
- 跨 backend 字节等价验证

### 13.4 Code Shape 跳过

`06-code-shape` fixture 仅 Python backend 支持，Rust skip。

## 14. 估算分解

| 工作 | 估算 |
|---|---|
| 包 scaffold + LanguageBackend 注册 | 1 天 |
| SteleValue 类型系统 + 数值提升 | 2 天 |
| 51 baseline 操作符翻译 + runtime | 8 天 |
| Path access (kebab->snake) | 0.5 天 |
| 18 EP04 + 5 EP13 操作符 | 4 天 |
| Scenario / checker runtime | 4 天 |
| Witness file channel + CLI 集成 | 2 天 |
| Cargo.toml 依赖管理 + init 模板 | 1 天 |
| Conformance fixture + 修 bug | 5 天 |
| examples/rust-project + 文档 | 2 天 |
| **合计** | **30 天 ≈ 6 周（1 FTE）/ 3-3.5 周（2 FTE）** |

## 15. 验收标准

- [ ] `stele init --language rust` 生成正确的 project structure + Cargo.toml
- [ ] `stele generate` 生成的 Rust 代码通过 `cargo build --tests`
- [ ] `cargo clippy` 无 warning
- [ ] `tests/conformance/` 全部 fixture 在 Rust backend 通过
- [ ] 跨 backend 一致性：Python + TypeScript + Go + Rust violation report 字节等价
- [ ] `_stele_runtime.rs` 仅依赖标准库 + `serde`、`serde_json`、`regex`、`once_cell`，不引入其他第三方 crate
- [ ] `examples/rust-project/` 演示完整流程
- [ ] `docs/guides/rust-integration.md` 完整
