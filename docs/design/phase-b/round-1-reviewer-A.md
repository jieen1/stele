# Phase B Design Review — Reviewer A (Architecture + Cross-Language)

## Critical Issues

### C1. NodeId 用 arity 不用参数类型，在 Java/Rust 直接破坏唯一性

`01-call-graph-extractor.md` §3 规定 NodeId 是 `path::container::name(arity)`。Java 重载允许同名同 arity 不同参数类型：

```java
class Repo {
  User find(String email);     // Repo::find(1)
  User find(UserId id);        // Repo::find(1)  ← 同一 NodeId
}
```

trace-policy `**::Repo::find(1)` 匹配两个不同方法，evaluator 把它们的 caller 集合合并，违例归因失败。Rust 也一样——`impl Repo { fn find(name: &str); fn find(id: UserId); }` 合法。02-trace-policy.md §四 表格里 `**::Order::pay(*)` 暗示通配，但 §三 又说 arity 是定义的一部分，文档自相矛盾。

修改建议：NodeId 末段改为 `name(arity)#disambiguator`，其中 disambiguator 在重载冲突时填参数类型字符串的 hash；无重载时为空。pattern 匹配时 disambiguator 段缺省视为通配。或更直接：把 arity 改为参数类型签名 `name(T1,T2)`，pattern 一律通配 `name(*)`。

### C2. Python `arity` 是否含 `self`，文档未定，跨语言匹配立即破

§3 表格：Python `def pay(self, ...)` → `Order::pay(2)`。但 TS `pay(...)` → `Order::pay(1)`。同一个"Order.pay 接 1 个业务参数"在两个语言里 NodeId 不同，所以 02-trace.md §四 那张承诺的"`**::Order::pay(*)`"等价匹配根本不成立——只要 user 给定具体 arity 就一定漏匹配一边。Go receiver 是另外的语法位置（`func (o *Order) Pay()` arity=0），也对不上 Python 的 self。

修改建议：NodeId 规范**显式排除**隐式接收者（self/this/Go receiver）；arity 只计业务参数。01 文档表格里 Python 的 `(2)` 必须改成 `(1)`，并在规范段写死一条 "implicit receiver excluded"。同时给一段 spec：Python 静态方法、classmethod (`cls`)、Go pointer vs value receiver 都按此规则。

### C3. `extern:` 命名空间未给出跨语言映射规则，pattern 不可移植

01 §3 给了 3 个例子：`extern:stripe::*`、`extern:django.db.models::*`、`extern:net/http::Get(1)`。02 §五 PAYMENT_GATEWAY_GUARD 写 `extern:stripe::*`——但 npm `stripe`、pypi `stripe`、cargo `stripe-rust`、maven `com.stripe:stripe-java`、go `github.com/stripe/stripe-go/v74` **包名根本不同**。规则"自动加前缀"在 02 §二 出现，但没有规则定义"逻辑名 stripe 在 5 语言里映射到什么集合"。

更严重：02 §五 的模板里 `extern:typeorm::*` `extern:prisma::*` `extern:django.db.models::*` 一锅炖——同一条 trace-policy `DB_VIA_REPOSITORY` 表达"全 5 语言项目"是不可能的，因为单个项目就一种语言，混在一条规则里只是文档表演，未给 Stele 任何"逻辑名解析"机制。

修改建议：必须新增一节"Logical package aliases"。在 main.stele 或 profile.yaml 里允许声明：

```cdl
(extern-alias stripe
  (typescript "stripe")
  (python "stripe")
  (rust "stripe-rust")
  (java "com.stripe:stripe-java")
  (go "github.com/stripe/stripe-go/v74"))
```

pattern `extern:stripe::*` 经此别名表展开。否则跨语言项目根本写不出可重用规则，第二波 Go/Java/Rust 用户一上来就要为每条规则写 5 份。

### C4. Effect suppression 是契约绕过的官方后门

04-effect-system.md §五"Effect 衰减"：用 `@stele:effects.suppress db.read` 或 CDL `(effect-suppression ...)` 阻断传播。设计原则说"机械联锁、不要求人审"，但 suppression 把传播算法**直接关掉**。Agent 写新代码遇到 effect 违例时，最低能量路径就是**加 suppression**。

文档承认了这点（"`--strict-effects` 把所有 suppression 升级为 warning"），但 warning ≠ block，等于把违例移出热路径。这与原则 1 直接冲突。

修改建议：suppression 必须**至少 require 二选一**：(a) 是 CDL 中显式列出的 `(effect-suppression ...)`（即写在受保护的契约文件里，agent 不能改）；(b) 内联源码里的 suppress 注解必须同步在 CDL 里授权，否则 evaluator 忽略 inline suppression。把 suppression 当作"contract-grant"而非"code-claim"。

## Major Concerns

### M1. trace-policy 和 effect-policy 概念边界不对等，会把用户拖入选择困境

00-overview §5 表格上把二者并列。04 §11 写了"互补"。但实际语义重叠：`NO_IO_IN_UI`（effect-policy）和 `HTTP_VIA_SERVICE`+`DB_VIA_REPOSITORY`（trace-policy）覆盖几乎相同违例集合。用户面对"UI 不能调网络"这种朴素需求，会发现两种正确写法、两套语法、两套 fingerprint、两类 error code，且**同一违例可能被两套 evaluator 同时报告**。

文档没有说当用户两条都写时是 dedupe 还是双报。建议补一节"Choosing between trace-policy and effect-policy"，给一条 decision tree：

- 关心"必经路径"（有第三方中间层）→ trace-policy
- 关心"行为外观"（不在意怎么做到的，只看叶子节点是什么）→ effect-policy
- 默认推荐 effect-policy（更鲁棒，传播自动）

并在 violation report 层加显式 dedup：相同 (function, root_cause_node) 的两个 violation 只报一个，标 `also_violates: [...]`。

### M2. type-state 跨函数边界状态传播缺失

03 §四 算法只看"local 推断 + 函数参数签名标注"。如果一个函数 `f(o: Order)`（无 phantom state 参数标注）把 o 传给 `g(o: Order)`，且 g 内对 o.addItem()，evaluator 不知道 o 是什么状态，落入 lenient mode 不报。这意味着只要 agent 把违法调用**多套一层函数**就绕过。

文档 §四 "状态推断失败" 4 个 case 把这种情况吃掉了，但没有提到这是契约绕过路径。

修改建议：

1. 在 03 §四 加 "interprocedural propagation requirement"：对 type-state 的 target 类型，所有以该类型为参数的函数必须在 phantom-state 参数（或 CDL 中显式标注 `(param-state f.o Submitted)`）上明确状态，否则在 strict 模式下报 E0349-something。
2. 第一波（TS+Python）默认 strict（违设计文档 D-B-007 性能预算，但语义正确性优先）。

### M3. Go 的 separate-types + state-type-mapping 与 TS 的 phantom 不真正等价

07 §六：

```cdl
(state-type-mapping
  Draft     "src/order/order.go::DraftOrder"
  Submitted "src/order/order.go::SubmittedOrder")
```

TS 的 `Order<"Draft">` 和 `Order<"Submitted">` 是**同一标称类型**的不同实例化——共享方法定义、可以写一个 `function logOrder<S>(o: Order<S>)` 接所有状态。Go 的 DraftOrder 和 SubmittedOrder 是**完全独立的类型**——共享方法需要 interface，但加 interface 又冲走 type state（任何函数取 `Order` interface 就丢状态）。

后果：同一个业务逻辑"打印订单不管状态"在 TS 一行，在 Go 要么写 5 个重载、要么用 interface 丢状态。Stele 在 Go 上对状态保留代码会强迫用户写出 Go 社区认为反模式的代码。

修改建议：07 §六 必须诚实承认这点，给出两个候选：(a) Go 上 type-state mode 默认 off（只在显式 opt-in 的目录用），(b) Go 上把 type-state 降级为运行时检查模板生成（生成 `assertOrderState(o, "Draft")` 调用），由 trace-policy 补位。**不要把 state-type-mapping 包装成"等价"——它不是**。

### M4. CallGraphExtractor 跨包并发 / 缓存策略未规定

01 §六 缓存设计：`fileHashes` + 单文件粒度增量。但 §九 MVP 说"高阶函数 / interface 多态记 unresolved/ambiguous"。问题是：当 ambiguous candidate 集合改变（项目里新增一个 interface 实现），**所有跨 interface 的 caller 都要重新分析**，文件 hash 没变，缓存命中却语义错。

修改建议：缓存层除 fileHashes 外加 `interfaceImplementationsHash` / `methodResolutionHash`——记录全局解析所依赖的类型形状摘要。变化即全量重析。否则 incremental 模式会产生 stale violations。

### M5. D-B-003 "第一波 TS + Python" 让 Go/Java/Rust 用户成为二等公民，但 trace-policy 模板已混入 Go/Java/Rust 路径

02 §五 模板里 `"extern:gorm::*" "extern:jdbc::*" "extern:sea_orm::*"` 都列出来作为 sample。如果第一波只支持 TS+Python，这些 sample 是误导。要么把模板拆成"第一波"和"第二波"两份示例；要么明确写：第一波 CallGraphExtractor 5 语言全实现（trace-policy 全语言可用），但 type-state / effect 仅 TS+Python。

文档现在两边都说，没有一处单点把"第一波到底能跑什么"列清楚。**README + 00 + 07 需要统一"first-wave capability matrix"**。

## Minor Notes

### N1. D-B-006 propagation_chain 跨语言渲染未规范

04 §七 例子用 TS 的 `useEffect callback → fetchUserData` 渲染。Python 的 callback / decorator / context manager、Go 的 goroutine、Rust 的 async stream，propagation chain 渲染规则不一。建议补一个"propagation_chain rendering" 规范段，给 5 语言每个一个渲染模板。

### N2. NodeId pattern 里 `**/payment-service/*.{ts,py,go,java,rs}::*` brace expansion 语法没指定

01 §3 只给了几个例子；06 也没在 ParsedPattern 里说明 brace 展开规则。建议参考 globby/minimatch 明确定义并写入 §3。

### N3. `(transition (from X) (via m) (to Y))` 不允许多 source / 多 target

03 §三 grammar 一条 transition 只能一对 from→to。一个方法 `cancel` 在 Draft / Submitted 都可调（都 → Cancelled）要写两条 transition，重复。建议允许 `(from X Y) (via cancel) (to Cancelled)`。

### N4. effect-declarations "每文件最多一个" + "多文件合并去重"互相打架

06 §4.3 写了两条规则。如果多文件合并去重，那么"每文件最多一个"只是排版约束。建议：要么集中到一个文件（如 `contract/effects.stele`）—— uniqueness 检查；要么允许多 block 同文件，合并就好。当前规则费解。

### N5. 03 文档 §11 fixture 12 是 "cross-function-flow"，但 §四 算法根本不做跨函数

测试承诺的能力比算法强。要么补算法、要么删 fixture。见 M2。

## Specific Counter-Examples

**CE1** (NodeId arity / overload)：Java
```java
class Wallet {
  void debit(BigDecimal amount);      // Wallet::debit(1)
  void debit(BigDecimal amount, String reason); // Wallet::debit(2)
  void debit(MoneyAmount amount);     // Wallet::debit(1)  ← 与 #1 撞 NodeId
}
```
trace-policy `must-transit "**::Wallet::debit(1)"` 误匹配 MoneyAmount 重载，引出错误违例归因。

**CE2** (Python self)：
```python
class Order:
    def pay(self, amount): ...
```
文档说 NodeId = `Order::pay(2)`。TS `class Order { pay(amount) {} }` 是 `Order::pay(1)`。同一条 `**::Order::pay(1)` 规则在 Python 项目静默漏匹配；同一条 `**::Order::pay(2)` 在 TS 项目静默漏匹配。

**CE3** (extern alias)：trace-policy 模板 `(must-be-preceded-by "**/permission/**::verify")`——Java 用 `PermissionService.verify` 在 `com.acme.permission.PermissionService.java`，NodeId 路径段是 `src/main/java/com/acme/permission/PermissionService.java`。`**/permission/**` 这个 glob 当且仅当源码目录恰好用 `permission` 字符串才匹配——Java 项目按 `com/acme/auth/Permission*.java` 组织时整条规则失效。

**CE4** (Go state-type-mapping 副作用)：
```go
func PrintOrder(o interface{ Id() string }) { ... }
PrintOrder(draftOrder)     // 调用合法
PrintOrder(submittedOrder) // 调用合法
```
PrintOrder 是合法 Go 代码，但 type-state 看不见状态——interface 抹掉了。state-type-mapping 在这种代码上**完全失效**，但 03 / 07 没承认这个限制。

**CE5** (effect suppression 绕过)：
```typescript
/** @stele:effects.suppress db.read */
async function uiHelper(id: UserId) {
  return await db.findUser(id);  // db.read 被吞
}
// UI 组件直接调
function UserCard({ id }) {
  const u = uiHelper(id);  // effect-policy NO_IO_IN_UI 看不到 db.read
}
```
Agent 加一行 JSDoc 就绕过整套 effect 系统。

## What's Good

1. **CallGraph 作为公共基础抽象**是正确的设计选择。三个 evaluator 共享一个 IR 比各做一份合理得多。
2. **§九 MVP 边界**承认追溯简化（高阶函数、反射记 unresolved，不阻塞主流程）是务实的——"`--strict` 给追求闭环的项目用"分级正确。
3. **错误反馈格式（D-B-006）**带 actual_chain / expected / fix-hint / fingerprint 是清晰的契约，agent 可机械消费。propagation_chain 思路尤其好。
4. **删除 multi-agent 死形式**（D-B-004）干净利落，不背技术债。
5. **重构与功能实施捆绑**（05 §十）执行顺序合理——基础设施 4 步在前给 Phase B 干净起点。
6. **conformance fixture 跨语言 10 case × 5 backend**是验证跨语言一致性的唯一可靠手段。投入 5 天值得。
