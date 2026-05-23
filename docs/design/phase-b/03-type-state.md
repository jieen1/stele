# 03 — Type State

## 一、目标

把实体的"状态机"上提到契约层。声明：

- 实体有哪些状态
- 状态之间的合法转换
- 每个状态允许哪些操作

Stele 静态分析：当代码在"X 状态"上调用了一个"X 状态不允许"的操作，自动拒绝。Agent 即使想写错也写不出。

## 二、为什么单独做（不能用 trace-policy 替代）

`trace-policy` 关心"调用链"——A 必经 B。但状态机问题是：

- 同一个函数 X，调它需要看**实参的状态**
- 状态由调用历史决定，不在调用图边上

例：

```typescript
const o: Order = createOrder();  // Draft
o.addItem(...);                  // OK (Draft 状态)
const submitted = o.submit();    // Order<Submitted>
submitted.pay();                 // OK
submitted.addItem(...);          // ❌ 应该被拒绝
```

`addItem` 函数本身没问题，trace-policy 也通过。但**在 submitted 上调用** addItem 违反状态机。需要单独机制。

## 三、CDL Form 规范

```cdl
(type-state <STATE_MACHINE_ID>
  (description "...")
  ;; target: 单 path::TypeName 或 NodeId glob（Round 1 修订）。
  ;; - 单值: TS / Rust phantom-type 情形 (e.g., "src/order.ts::Order")
  ;; - glob: Go separate-types 情形 (e.g., "src/order/*.go::*Order")
  (target "<file>::<TypeName>" | "<NodeId-glob>")
  (severity error|warning)
  
  ;; Go separate-types 时声明 state → 具体类型映射（B.3）
  [(state-type-mapping
    <state> "<file>::<TypeName>"
    <state> "<file>::<TypeName>")]
  
  ;; 状态集合
  (states <state1> <state2> ...)
  
  ;; 初始状态（构造后）
  (initial <state>)
  
  ;; 终态（不能再 transition）
  (terminal <state> [<state> ...])
  
  ;; 转换：from 支持多源（Round 1 修订 N-4 语法糖）
  ;; (from A) (via m) (to B) 单源转换
  ;; (from A B C) (via cancel) (to Cancelled) 多源转换（等价 3 条）
  (transition
    (from <state> [<state> ...]) (via <method>) (to <state>))
  ...
  
  ;; 每个状态允许的操作（缺省 = transitions 涉及的方法 + 显式列出的方法）
  (allowed-ops <state> <method> [<method> ...])
  
  ;; 修复指引
  (fix-hint "..."))
```

### 例：Order 状态机

```cdl
(type-state ORDER_LIFECYCLE
  (description "Order can only transition: Draft → Submitted → Paid → Shipped, or Cancel/Refund branches")
  (target "src/models/order.ts::Order")
  
  (states Draft Submitted Paid Shipped Cancelled Refunded)
  (initial Draft)
  (terminal Shipped Cancelled Refunded)
  
  (transition (from Draft)     (via submit)  (to Submitted))
  (transition (from Submitted) (via pay)     (to Paid))
  (transition (from Submitted) (via cancel)  (to Cancelled))
  (transition (from Paid)      (via ship)    (to Shipped))
  (transition (from Paid)      (via refund)  (to Refunded))
  
  (allowed-ops Draft addItem removeItem submit)
  (allowed-ops Submitted cancel pay)
  (allowed-ops Paid ship refund)
  ;; Shipped / Cancelled / Refunded 是终态，无 allowed-ops（除查询方法）
  
  (fix-hint "Check the order's current state before invoking this method."))
```

## 四、AST 静态校验算法

### 输入

- `CallGraph`（5 语言一致）
- `TypeStateInferenceTrait` 各 backend 提供的"局部状态推断"
- `TypeStateDeclaration[]`

### 状态推断（各 backend 实现）

不同语言对"实体状态"的表达不同：

**TypeScript**（phantom states 模式）：

```typescript
type Order<S extends OrderState = "Draft"> = { __state: S; ... };
function createOrder(): Order<"Draft">;
function submit(o: Order<"Draft">): Order<"Submitted">;
function pay(o: Order<"Submitted">): Order<"Paid">;
```

backend-typescript 的 `TypeStateInference` trait 检查：
- `createOrder()` 返回类型为 `Order<"Draft">` → 推断状态 Draft
- 链式调用 `submit(o)` 返回 `Order<"Submitted">` → 推断状态 Submitted
- 当看到 `o.addItem(...)` 时，`o` 的推断状态 ∈ allowed-ops[addItem] 否则违例

**Rust**（原生 typestate）：

```rust
struct Order<S> { _state: PhantomData<S>, ... }
struct Draft;
struct Submitted;
impl Order<Draft> { fn submit(self) -> Order<Submitted> }
```

backend-rust 直接读 PhantomData / generic argument。

**Python**（typing.Generic + mypy）：

```python
TState = TypeVar("TState", "Draft", "Submitted", "Paid")
class Order(Generic[TState]): ...
def submit(o: "Order[Draft]") -> "Order[Submitted]": ...
```

backend-python 用 mypy / pyright 推断类型参数。

**Go / Java**（无 phantom，用 separate types）：

```go
type DraftOrder struct { ... }
type SubmittedOrder struct { ... }
func Submit(o DraftOrder) SubmittedOrder
```

backend-go / backend-java 用类型本身代表状态。`Order` 在契约里映射到 `DraftOrder | SubmittedOrder | ...`。

### 通用算法

```pseudocode
function evaluateTypeState(declaration, callGraph):
    violations = []
    inferenceMap = backend.inferTypeStates(callGraph, declaration.target)
    
    // inferenceMap: { (filePath, line, col): { variableName: state } }
    
    for each callSite in callGraph.edges where edge.toId matches declaration.target methods:
        receiverVar = identifyReceiver(callSite)  // e.g., "o" in "o.addItem()"
        callerScope = (callSite.filePath, callSite.fromLine, callSite.fromCol)
        inferredState = inferenceMap.lookup(callerScope, receiverVar)
        
        if inferredState is None:
            // 推断失败：在严格模式下报警，否则跳过
            continue
        
        methodName = extractMethodName(callSite.toId)
        allowedOps = declaration.allowedOps.get(inferredState, [])
        
        if methodName not in allowedOps:
            violations.append({
                rule_id: f"typestate.{declaration.id}.disallowed_op",
                location: callSite.callSite,
                cause: {
                    summary: f"Method {methodName} not allowed in state {inferredState}",
                    inferred_state: inferredState,
                    allowed_in_state: allowedOps,
                    transition_to_enable: findTransitionTo(declaration, methodName),
                }
            })
    
    return violations
```

### 状态推断失败的处理（Round 1 修订）

**B.1 + B.2 阶段明确声明能力**：只做"函数内推断 + 显式参数标注"。复杂控制流（async / promise / callback / 高阶函数）下推断率 < 50%。**不夸大能力**。

许多情况无法静态推断。处理：

1. 局部变量直接构造 → 100% 推断成功
2. 通过 transition 方法链 → 推断成功
3. 函数参数 **必须显式标注**才能推断：
   - TS / Rust：phantom type `Order<"Paid">`
   - 或 CDL 显式：

     ```cdl
     (type-state-binding
       (function "src/order/handler.ts::OrderHandler::process(1)")
       (param 0 state Submitted))
     ```

4. 推断不出 → 默认 **lenient mode**（不报违例，emit notice "type-state inference failed for `<function>`: consider adding parameter annotation or `(type-state-binding ...)` for this function"）
5. `--strict-typestate` 启用 strict mode：推断不出即 error，强制 agent 加标注

### 跨函数边界传播限制

**第一波**（B.1 + B.2）**不做**自动跨函数边界传播。如果一个函数 `f(o: Order)` 没有参数标注，调用它的代码即使知道 o 是 Submitted 状态，f 内部对 o.addItem() 也**不报违例**。

这是已知的契约绕过路径："多套一层函数"绕过 type-state。文档诚实承认。

**为什么不做**：自动跨函数推断需要全程序数据流分析，工程量爆炸（参考 mypy / pyright 在 generic phantom 上的实测推断率 < 40%）。强制显式标注换回 90%+ 准确率。

**规避方式**：

1. 用 `--strict-typestate`：所有以 type-state target 为参数的函数必须有显式状态标注，否则 E0349-noncompliant
2. CI 默认开启 strict-typestate
3. 这是 trade-off：用户接受"多写标注"换回"agent 绕不过去"

### async / promise / callback 的实际限制

```typescript
// 这种代码 type-state 看不见状态：
const o = await orderService.submit(orderId);       // 类型擦除到 Promise<Order>
queue.push(() => o.addItem(...));                   // callback 里
events.on("change", function(o: Order) { ... });    // 事件回调
```

第一波不解决这些。**只解决"直接调用链 + 显式标注参数"**。

后续版本（v0.4+）考虑：
- async/await 链的状态传播（typed Promise + decoder）
- callback 内的状态推断（需要类型化的 callback signature）

现在不承诺。

## 五、5 语言适配

| 语言 | 状态表达 | 推断方法 | 难度 |
| --- | --- | --- | --- |
| Rust | 原生 typestate (PhantomData + sealed traits) | 直接读类型参数 | ⭐⭐⭐⭐⭐ 最简单 |
| TS | phantom types `Order<S>` | tsc TypeChecker 解析泛型实参 | ⭐⭐⭐⭐ 简单 |
| Java | sealed types or separate classes | JavaParser 类型解析 | ⭐⭐⭐ 中等 |
| Python | typing.Generic + mypy | 调用 mypy 或 pyright（外部 SQLite-like） | ⭐⭐⭐ 中等 |
| Go | separate struct types | go/types 类型推断 | ⭐⭐ 较难（无泛型 phantom 模式） |

**Phase B 第一波 TS + Python 先行**（D-B-003）。Go 的实现可能延后，原因：Go 缺少 phantom types 模式，必须用 separate struct types，对现有代码改造大。

## 六、错误反馈格式

```
[error] typestate.ORDER_LIFECYCLE.disallowed_op
  source: typestate/check
  location: src/services/order-handler.ts:84:5
  summary: Method `addItem` is not allowed when Order is in state `Paid`
  
  inferred_state: Paid
  receiver: order
  allowed_methods_in_state: [ship, refund]
  
  to_call_addItem_first_transition_to: Draft
    (no transition path from Paid back to Draft — addItem on Paid is permanently illegal)
  
  fix: This is a design-time violation. Either:
    (a) Change order's state before this call (e.g., refund → re-create draft)
    (b) Move addItem call to before submit()
    (c) If business rules legitimately changed, propose a design update via
        `stele design propose --type-state ORDER_LIFECYCLE`. Do NOT edit the
        contract file directly — it is protected from agent modifications.
  
  fingerprint: typestate.ORDER_LIFECYCLE.OrderHandler.addItemAfterPay
```

## 七、CDL 解析

`packages/core/src/validator/structure-type-state.ts` (NEW)：

```typescript
export interface TypeStateDeclaration {
  kind: "type-state";
  filePath: string;
  span: SourceSpan;
  id: string;
  target: string;
  description?: string;
  severity: "error" | "warning";
  states: string[];
  initial: string;
  terminal: string[];
  transitions: TypeStateTransition[];
  allowedOps: Map<string, string[]>;   // state → allowed method names
  fixHint?: string;
}

export interface TypeStateTransition {
  from: string;
  via: string;       // method name
  to: string;
  span: SourceSpan;
}
```

Validator 检查：
- states 非空
- initial ∈ states
- terminal ⊆ states
- transition.from / .to ∈ states
- allowed-ops 的 state ∈ states
- 终态不能在 transitions 的 from 出现（除显式声明 `allow-terminal-transition`）
- target 必须是 `path::TypeName` 形式

Error codes: E0340-E0349

## 八、Check Stage

`packages/cli/src/commands/check-stages-type-state.ts` (NEW)：

```typescript
export async function buildTypeStateStage(
  context: PreparedCheckContext,
  protectedState: ProtectedCheckState,
  command: string,
): Promise<ViolationReport>
```

调用 `@stele/type-state-evaluator`（新包）。注册到 check stage registry。

## 九、profile.yaml 集成

profile.yaml 当前已有占位 `type_driven.type_state.mode: hard`。Phase B 扩展：

```yaml
type_driven:
  enabled: true
  type_state:
    mode: hard  # hard | soft | off
    machines:
      - id: ORDER_LIFECYCLE
        target: "src/models/order.ts::Order"
        states: [Draft, Submitted, Paid, Shipped, Cancelled, Refunded]
        initial: Draft
        terminal: [Shipped, Cancelled, Refunded]
        transitions:
          - from: Draft
            via: submit
            to: Submitted
          - from: Submitted
            via: pay
            to: Paid
          # ...
        allowed_ops:
          Draft: [addItem, removeItem, submit]
          Submitted: [cancel, pay]
          Paid: [ship, refund]
```

design-generator 把 `type_driven.type_state.machines[]` 渲染成 `(type-state ...)` CDL form 写入 `contract/generated/ddd-typedriven.stele`（沿用 Phase A branded-id / smart-ctor 同样的链路）。

## 十、与 Branded-ID / Smart-Ctor 的关系

Phase A 的 branded-id 和 smart-ctor 解决"值不能乱构造"。Type State 解决"已构造的值上不能乱调方法"。二者**正交且互补**：

- branded-id：`UserId` ≠ `OrderId`（不能交叉传错）
- smart-ctor：`User.id` 必须通过 `parseUserId(...)` 构造（不能 raw string）
- type-state：`Order<Paid>` 上不能调 `.addItem`（不能错状态操作）

## 十一、测试

### 各语言提取器单元测试

5 个 `packages/<backend>/tests/typestate-inference.test.ts`，每个跑：

1. Local 构造 + 方法链 → 推断状态正确
2. 函数参数标注状态 → 推断正确
3. 分支控制流（if/else 后状态不一致）→ 推断为 `union`
4. 推断不出 → 标记 `unknown`

### Evaluator 集成测试

`packages/cli/tests/check-stages-type-state.test.ts`：

10+ fixture：
1. `typestate-allowed-op-ok.stele` + 合规代码 → 0
2. `typestate-disallowed-op-violation.stele` + Paid 上 addItem → 1
3. `typestate-undefined-state-error.stele` + 引用未声明状态 → parse error
4. `typestate-cycle-warning.stele` + 转换图有环 → warning
5. `typestate-unreachable-state.stele` + 状态从 initial 不可达 → warning
6. `typestate-inference-fallback-lenient.stele` → 推断不出不报
7. `typestate-inference-fallback-strict.stele` + --strict-typestate → 推断不出报错
8. `typestate-transition-method-not-found.stele` → method 不存在 warning
9. `typestate-multi-receiver.stele` → 多个 receiver 各自独立判断
10. `typestate-cross-function-flow.stele` → 函数边界状态传播

### Conformance（跨语言）

`tests/conformance/fixtures/typestate-cross-lang/`：同一 Order 状态机用 5 语言写，TS + Python 必须通过；Go + Java + Rust 在 Phase B 第二波必须通过。

## 十二、工程量

| 子任务 | 工程量 |
| --- | --- |
| `@stele/type-state-core` 包：types + state graph algorithm | 1 天 |
| TS TypeStateInferenceExtractor | 3 天 |
| Python TypeStateInferenceExtractor | 3 天 |
| Go/Java/Rust 各 | 4 天 × 3（第二波） |
| `@stele/type-state-evaluator` 包：核心算法 | 2 天 |
| CDL 解析 + validator + uniqueness | 1 天 |
| design-generator 渲染（profile.yaml → CDL） | 1 天 |
| check stage + CLI 集成 | 1 天 |
| 单元 + 集成 + conformance 测试 | 3 天 |
| **第一波（TS + Python）合计** | **~15 天** |

## 十三、风险

| 风险 | 缓解 |
| --- | --- |
| Go 没有 phantom types，typestate 编程范式不自然 | Phase B 第二波；用户实际项目要求时再推进 |
| 状态推断在复杂控制流下失败 | lenient mode 缺省；`--strict-typestate` 给追求闭环的项目 |
| 用户改一次状态机要改一堆代码 | 这是 type-state 的代价，但**正是 agent 不漏改的保证**——比"忘了改运行时 if-else"健壮 10× |
| profile.yaml type_state DSL 嵌套深 | YAML schema validator + 友好错误消息 |
