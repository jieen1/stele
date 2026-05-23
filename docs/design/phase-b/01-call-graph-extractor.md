# 01 — Call Graph Extractor 抽象

Phase B 三个机制的公共基础。先把这个抽象做对，三个 evaluator 才能跨语言统一实现。

## 一、为什么需要这个抽象

Trace / Type State / Effect 三个机制都需要回答同一类问题：

- 函数 F 直接调用哪些函数？（callee 集）
- 函数 F 被哪些函数调用？（caller 集）
- 从函数 X 到函数 Y 的所有可能调用路径？（reachability）
- 这条调用路径上经过了哪些其他函数？（transit set）

这些问题答案与"语言"无关——本质都是有向图查询。所以应该：
- 各 backend 负责把宿主语言 AST → 标准化 CallGraph 数据结构
- Stele core 在 CallGraph 上做跨语言通用的查询

## 二、数据结构

```typescript
/** 跨语言统一的调用图。serialize 后可缓存到 contract/.cache/call-graph.json */
export interface CallGraph {
  schemaVersion: "1";
  language: SupportedLanguage;        // 用于 sanity check
  generatedAt: string;                 // ISO timestamp
  projectRoot: string;                 // 绝对路径，便于 deserialize 时校验
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
  unresolvedCalls: UnresolvedCall[];   // 静态分析无法解析的（动态调用、反射、依赖注入）
  ambiguousCalls: AmbiguousCall[];     // 解析到多个候选（如方法多态）
}

export interface CallGraphNode {
  id: NodeId;                  // 跨语言唯一标识，见 §3 NodeId 规范
  kind: "function" | "method" | "constructor" | "lambda" | "module-init";
  filePath: string;            // 相对 projectRoot
  span: SourceSpan;            // 定义位置
  signature: string;           // 文本签名（best effort，用于错误反馈展示）
  isExported: boolean;
  isAsync: boolean;
  effects?: string[];          // 显式声明的副作用标签（详见 effect-system.md）
  typeStateAnnotations?: TypeStateAnnotation[];  // 详见 type-state.md
}

export interface CallGraphEdge {
  fromId: NodeId;
  toId: NodeId;
  callSite: SourceSpan;        // 调用点位置（行/列）
  isConditional: boolean;      // 在 if/switch/try 等分支里
  isLoop: boolean;             // 在循环体内
  isAsync: boolean;            // await / .then() / Promise.all 等
}

export interface UnresolvedCall {
  fromId: NodeId;
  callSite: SourceSpan;
  rawText: string;             // 调用的原文，例如 "handler(args)"
  reason: "dynamic" | "reflection" | "module-not-resolved" | "external-lib";
}

export interface AmbiguousCall {
  fromId: NodeId;
  callSite: SourceSpan;
  candidates: NodeId[];        // 多个可能的目标
}

export interface SourceSpan {
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export type SupportedLanguage = "typescript" | "python" | "go" | "java" | "rust";
```

## 三、NodeId 规范（跨语言一致性的关键）

NodeId 必须在所有 5 语言里有统一形式。**Round 1 修订**：增加 disambiguator 段处理重载，明确排除隐式 receiver。

### 3.1 格式

```
{relativeFilePath}::{containerChain}::{symbolName}({arity})[#{disambiguator}]
```

- `relativeFilePath`：POSIX 路径，相对 projectRoot
- `containerChain`：`>` 分隔的容器序列。class > inner-class > method 等
- `symbolName`：函数 / 方法 / lambda 名。lambda 用 `lambda@line:col`
- `arity`：**业务参数**个数，**显式排除隐式 receiver**（详 3.2）
- `disambiguator`：仅当同 (file, container, name, arity) 存在 ≥2 时填入。值为参数类型规范化字符串的 SHA-1 前 8 位。无重载时此段缺失。

### 3.2 隐式 Receiver 计数规则（跨语言一致）

| 语言 | 隐式 receiver | 是否计入 arity |
|---|---|---|
| Python | `self` (instance method), `cls` (classmethod) | **否** |
| TypeScript | `this`（implicit） | **否** |
| Java | `this`（implicit） | **否** |
| Rust | `&self`, `&mut self`, `self` | **否** |
| Go | pointer / value receiver `func (o *Order) Pay()` | **否** |

**例**：
- Python `def pay(self, amount, currency)` → `Order::pay(2)`（不是 3）
- TS `pay(amount, currency)` → `Order::pay(2)`
- Go `func (o *Order) Pay(amount, currency)` → `Order::Pay(2)`

跨语言匹配 `**::Order::pay(2)` 在所有语言里语义一致：接 2 个业务参数。

### 3.3 NodeId 示例（修订后）

| 语言 | 源码 | NodeId |
| --- | --- | --- |
| TS | `class Order { pay(amount) }` | `src/order.ts::Order::pay(1)` |
| Python | `class Order: def pay(self, amount)` | `src/order.py::Order::pay(1)` |
| Go | `func (o *Order) Pay(amount float64)` | `src/order.go::Order::Pay(1)` |
| Java | `class Order { void pay(BigDecimal amount) }` | `.../Order.java::Order::pay(1)` |
| Rust | `impl Order { fn pay(&self, amount: f64) }` | `src/order.rs::Order::pay(1)` |

**Java/Rust 重载情形**：

```java
class Wallet {
  void debit(BigDecimal amount);              // src/wallet.java::Wallet::debit(1)#a3f5b7c2
  void debit(MoneyAmount amount);             // src/wallet.java::Wallet::debit(1)#e2d8a4f9
  void debit(BigDecimal amount, String why);  // src/wallet.java::Wallet::debit(2)
}
```

参数类型规范化：去除 generic 实参 → 取 erasure → SHA-1。规范化规则在 `packages/call-graph-core/src/disambiguator.ts`。

Pattern 匹配 `**::Wallet::debit(1)` 在重载时 **匹配所有 disambiguator**（缺失视通配）。要精确：`**::Wallet::debit(1)#a3f5b7c2`。

### 3.4 外部库 NodeId 与 extern-alias

外部库 NodeId 用 `extern:<logical-name>::` 前缀：

```
extern:stripe::Charges::create(2)
extern:django-db::Model::save(1)
extern:gorm::DB::Where(1)
```

**logical-name** 是契约里声明的逻辑别名，与具体语言的包名解耦。映射通过新增 CDL form `(extern-alias ...)` 声明（详 `06-cdl-extensions.md` extern-alias 章节）：

```cdl
(extern-alias stripe
  (typescript "stripe")
  (python "stripe")
  (rust "stripe-rust")
  (java "com.stripe:stripe-java")
  (go "github.com/stripe/stripe-go/v74"))
```

各 backend 解析 import 时根据当前语言把实际包名解析回 logical-name，统一存进 CallGraph。

**Preset alias**：`@stele/preset-aliases/common.stele`（npm 包）提供常见库的预制 alias。用户：

```cdl
(import "@stele/preset-aliases/common.stele")
```

## 四、Extractor Trait（各 backend 必须实现）

```typescript
export interface CallGraphExtractor {
  language: SupportedLanguage;

  /**
   * 提取项目的完整调用图。
   *
   * @param options.projectRoot 项目根目录绝对路径
   * @param options.sourceFiles 要分析的源文件相对路径（POSIX）。空数组 = 全项目
   * @param options.tsconfigPath 仅 TS：tsconfig 路径
   * @param options.cacheDir 缓存目录（contract/.cache/）；为 undefined 则不使用缓存
   */
  extract(options: ExtractOptions): Promise<CallGraph>;

  /**
   * 增量提取：给定一组改动文件，返回更新后的 CallGraph。
   * Stele incremental check 时调用。
   *
   * 默认实现：合并 changedFiles 的 transitive callers 全量重析，其他文件复用缓存。
   */
  extractIncremental(options: ExtractOptions & {
    changedFiles: string[];
    previous: CallGraph;
  }): Promise<CallGraph>;
}

export interface ExtractOptions {
  projectRoot: string;
  sourceFiles?: string[];
  tsconfigPath?: string;
  cacheDir?: string;
}
```

## 五、5 语言实现路径

### TypeScript

依赖：`typescript` 编译器 API。
入口：`ts.createProgram` + `program.getSourceFiles()` + `ts.forEachChild` 遍历 AST 找 `ts.CallExpression`。
解析：用 `ts.TypeChecker.getSymbolAtLocation` 把 CallExpression 解析到定义节点 → NodeId。
难点：
- 异步：`await` / `.then()` / `Promise.all` 在 AST 上有不同形态，统一标准化为 `isAsync: true`
- 高阶函数：`arr.map(fn)` 中 fn 的间接调用，记为 `UnresolvedCall.reason = "dynamic"`
- 装饰器：`@decorator(fn)` 的 fn 算作被装饰器调用，记 edge

### Python

依赖：标准库 `ast` 模块（Python 3.10+）。
入口：`ast.parse` + `ast.walk` 找 `ast.Call`。
解析：用静态作用域分析 + import resolution → NodeId。对于动态属性访问（`getattr(obj, name)()`），标 unresolved。
难点：
- 鸭子类型：`obj.method()` 不一定知道 obj 是什么类。用 `mypy` / `pyright` 类型推断辅助；推断不出来时记为 ambiguous
- decorator：与 TS 类似

### Go

依赖：`go/ast` + `go/types` + `go/parser` + `golang.org/x/tools/go/packages`。
入口：`packages.Load` + 遍历 `*ast.File`，找 `*ast.CallExpr`。
解析：`types.Info.Uses` 解析 callee 到定义。
难点：
- interface 多态：`io.Reader.Read` 调用解析到多个实现 → `AmbiguousCall.candidates`
- goroutine：`go fn()` 标为 `isAsync: true`

### Java

依赖：JavaParser 或 Spoon。
入口：`StaticJavaParser.parse` + 访问者模式找 `MethodCallExpr`。
解析：JavaParser 的 symbol resolution 引入 `JavaSymbolSolver`。
难点：
- 重载：用 arity + 参数类型一起解析
- 反射 / Spring DI：记 unresolved

### Rust

依赖：`syn` crate + `rust-analyzer` （可选，增强 type resolution）。
入口：`syn::parse_file` + visitor。
解析：基本静态作用域。trait 方法多态用 `rust-analyzer` 辅助。
难点：
- macro 展开：宏内调用很难解析，可能需要 `cargo expand`
- trait dispatch：static dispatch 可解析，dynamic dispatch (`dyn Trait`) 记 ambiguous

## 六、缓存策略（Round 1 修订）

CallGraph 提取在大项目上不便宜。结合 v0.2 已有的 hash-manifest 增量基础：

```json
// contract/.cache/call-graph.json
{
  "schemaVersion": "1",
  "language": "typescript",
  "generatedAt": "...",
  "projectRoot": "/abs/path",
  "fileHashes": {
    "src/order.ts": "sha256-..."
  },
  "methodResolutionHash": "sha256-...",   // 跟踪 interface impl 变化
  "callGraph": { ... }
}
```

### 缓存失效判定

每次 `stele check`：

1. 读 `call-graph.json`
2. 对比 `fileHashes` 与当前文件实际 SHA256
3. **对比 `methodResolutionHash`**（项目全局 interface 实现关系摘要 SHA-256）：
   - 不变 → 增量析变动文件 + transitive callers
   - 变化 → **所有含 ambiguous calls 的文件全量重析**（避免 polymorphism cache stale）
4. 用新 CallGraph 跑 trace / typestate / effect evaluator

`methodResolutionHash` 计算：所有 `interface name → impl set` 关系的规范化字符串排序后 SHA-256。

### 增量分析的 transitive radius

- 改动文件 F 自身重新解析
- F 的所有直接 callers 重新解析
- callers 的 caller 不必（callee→F 关系没变，除非 ambiguous）
- 共享 utils 改动情形（被 80% 文件调用）退化为全量——**这是已知限制**，不假装能避免。文档 §D-B-007 性能预算"增量 < 20s（B.1 MVP）"覆盖此情形。

默认保守。`stele check --strict-callgraph` 触发全量重析。

## 七、错误处理

各 backend 解析失败应**降级而非崩溃**：

- 单个文件 parse 失败 → `notices` 字段加 warning，跳过该文件
- 整个 callgraph 提取失败 → exit 3（CONFIG_ERROR），明确报告原因
- 部分调用无法解析 → 记入 `unresolvedCalls`，不阻塞主流程

`stele check --strict-callgraph` 把 unresolved calls 升级为 error（严格模式，确保契约真正闭环）。

## 八、与 v0.2 已有提取器的关系

`packages/cli/src/architecture/typescript-extractor.ts` 当前只提取 **import edges**。Phase B 的 CallGraphExtractor 是它的超集（imports → calls）。

**重构方案**：

- 当前 `typescript-extractor.ts` 重命名为 `typescript-import-extractor.ts`
- 新增 `typescript-call-extractor.ts`（实现 CallGraphExtractor trait）
- `architecture-core` 包继续消费 import-extractor（因为 architecture rule 看的是 import）
- 新增 `call-graph-core` 包消费 call-extractor（trace / typestate / effect 都消费它）

两个 extractor **独立运行 / 独立缓存**。架构 check 不受 call-graph 提取性能影响；call-graph 提取失败也不影响架构 check。

各语言 backend 类似拆分：
```
packages/backend-typescript/src/extractors/
  ├─ imports.ts          # 仅 imports（现有，重命名而已）
  └─ calls.ts            # 新增 call graph

packages/backend-python/src/extractors/
  ├─ imports.ts          # 新增（Python backend 目前没 import extractor，code-shape 用）
  └─ calls.ts            # 新增
```

## 九、最小可行实现（MVP 边界）

Phase B 第一版**不要**追求完美调用图。允许的简化：

1. 高阶函数参数不追溯（记 unresolved）
2. interface / abstract method polymorphism 不追溯（记 ambiguous）
3. 反射 / DI / macro 不追溯
4. 跨包外部库 NodeId 用 `extern:` 前缀但不解析内部

理由：契约检查的目的是**抓常见违例**，不是 100% 闭环。漏掉 1% 罕见动态调用换 10× 实现速度，划算。`--strict-callgraph` 给追求闭环的项目用。

## 十、单元测试要点

每个 backend 的 CallGraphExtractor 必须通过以下 fixtures（统一在 `tests/conformance/fixtures/callgraph-*/`）：

1. `simple-direct-call`：A → B 一条边
2. `chain-three-functions`：A → B → C
3. `mutual-recursion`：A → B → A
4. `method-on-class`：obj.method() 正确解析到 class
5. `async-call`：await fn() 标 isAsync
6. `conditional-call`：if 内调用标 isConditional
7. `loop-call`：for 内调用标 isLoop
8. `polymorphic-call`：interface method 返回 AmbiguousCall.candidates
9. `dynamic-call`：getattr / reflection 进 UnresolvedCall
10. `external-lib-call`：调 npm/pip/cargo package 返回 `extern:` NodeId

5 语言 × 10 fixtures = 50 conformance test，每个 backend 必须全过才能 ship。
