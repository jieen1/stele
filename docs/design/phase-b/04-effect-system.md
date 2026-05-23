# 04 — Effect System

## 一、目标

把"函数运行时会做什么副作用"声明出来。Stele 在调用图上传播副作用集合，对"某层不允许某副作用"的约束做静态校验。

例：
- UI 层函数不能有 `db.*` / `http.*` effect
- "pure" 工具库函数不能有任何 effect
- 调 `stripe.charge` 必须显式标 `payment.charge`，传染整个调用栈

Agent 即使想偷偷在 UI 层加数据库查询，**它写出来的函数自动带上 db.read effect**，UI 层契约自动报违例。

## 二、Effect 的"集合传播"语义

```
基本规则：函数 F 调 函数 G  ⇒  F.effects ⊇ G.effects
```

副作用是**单向上传染**的——caller 必须声明自己用了 callee 的所有 effect（除非显式 catch / handle）。

> 这与 Rust 的 `Send`/`Sync`、Haskell 的 monad、Koka 的 effect type 同源。语义都一样，只是宿主语言表达不同。

## 三、CDL Form 规范

### 3.1 Effect 声明（项目级 effect 名字表）

```cdl
(effect-declarations
  (effect <name> (description "..."))
  (effect <name> (description "..."))
  ...)
```

例：

```cdl
(effect-declarations
  (effect db.read         (description "Reading from database"))
  (effect db.write        (description "Writing to database"))
  (effect db.transaction  (description "Beginning/committing DB transaction"))
  (effect http.outgoing   (description "Outbound HTTP request"))
  (effect fs.read         (description "Reading filesystem"))
  (effect fs.write        (description "Writing filesystem"))
  (effect crypto.random   (description "Reading crypto-grade randomness"))
  (effect time.now        (description "Reading current time"))
  (effect time.sleep      (description "Blocking on time delay"))
  (effect payment.charge  (description "Calling payment provider for charge"))
  (effect payment.refund  (description "Calling payment provider for refund"))
  (effect mail.send       (description "Sending email"))
  (effect log.audit       (description "Writing audit log"))
  (effect log.debug       (description "Writing debug log")))
```

Effect 名字用 dot-notation 表示层级。`payment.*` 匹配 `payment.charge` 和 `payment.refund`。

### 3.2 Effect 注解（哪些函数有哪些 effect）

```cdl
(effect-annotation
  (target <pattern> [<pattern> ...])
  (annotates <effect> [<effect> ...]))
```

例：

```cdl
;; 数据库底层全部标 db.* effect
(effect-annotation
  (target "extern:typeorm::*" "extern:prisma::*"
          "**/db/raw/**::*")
  (annotates db.read db.write))

;; 网络全部标 http
(effect-annotation
  (target "extern:fetch" "extern:axios::*" "extern:requests::*"
          "extern:net/http::*" "extern:reqwest::*")
  (annotates http.outgoing))

;; 支付
(effect-annotation
  (target "extern:stripe::*")
  (annotates payment.charge payment.refund http.outgoing))

;; 时间
(effect-annotation
  (target "extern:Date::now" "extern:time::time"
          "extern:time/std::Instant::now")
  (annotates time.now))
```

### 3.3 Effect 策略（哪个 scope 不允许哪些 effect）

```cdl
(effect-policy <POLICY_ID>
  (description "...")
  (target-scope <pattern> [<pattern> ...])
  (forbid <effect> [<effect> ...])
  ;; 或反向：仅允许列表
  (allow-only <effect> [<effect> ...])
  (severity error|warning)
  (fix-hint "..."))
```

例：

```cdl
;; UI 层禁所有 DB / HTTP
(effect-policy NO_IO_IN_UI
  (description "UI components must be pure render functions")
  (target-scope "**/views/**" "**/components/**")
  (forbid db.* http.* fs.write payment.*)
  (fix-hint "Move IO to services/. UI should receive pre-fetched data via props."))

;; 纯工具库只允许有限副作用
(effect-policy PURE_LIB_ONLY
  (target-scope "**/lib/pure/**")
  (allow-only time.now)
  (fix-hint "Pure library functions must not depend on IO or external state."))

;; Reducer / state-update 函数必须纯
(effect-policy REDUCERS_PURE
  (target-scope "**/reducers/**" "**/state/transforms/**")
  (allow-only ())   ; 空 = 不允许任何 effect
  (fix-hint "Reducers must be pure functions of (state, action) -> state."))

;; 测试代码允许任意 effect
(effect-policy TEST_NO_RESTRICTION
  (target-scope "**/tests/**" "**/*.test.{ts,py,go,java,rs}")
  (allow-only db.* http.* fs.* time.* crypto.* mail.* log.*))
```

## 四、Effect 注解的"语言原生形态"映射

Effect 通过 CDL 集中声明，但在每个语言源代码里，**Stele 也读取语言原生的注解**作为补充信号。

### TypeScript

```typescript
/** @stele:effects db.read,db.write */
async function getUser(id: UserId): Promise<User> { ... }
```

或基于 phantom types（用户可选）：

```typescript
type Effect<E extends string, T> = T & { readonly __effect: E };
async function getUser(id: UserId): Promise<Effect<"db.read", User>> { ... }
```

backend-typescript 解析 JSDoc `@stele:effects` 标签 OR phantom type 标注。

### Python

```python
@stele.effects("db.read", "db.write")
async def get_user(id: UserId) -> User: ...
```

backend-python 解析 decorator。

### Go

```go
// stele:effects db.read,db.write
func GetUser(id UserId) (*User, error) { ... }
```

backend-go 解析特殊注释（go 没 decorator）。

### Java

```java
@Effects({"db.read", "db.write"})
public User getUser(UserId id) { ... }
```

backend-java 解析自定义 annotation。

### Rust

```rust
#[stele::effects(db::read, db::write)]
pub fn get_user(id: UserId) -> Result<User> { ... }
```

backend-rust 解析自定义 attribute macro。Rust 还原生有 `Send`/`Sync` 等 marker traits 作为 effect 候选。

### 显式 vs 推断

显式声明（CDL `effect-annotation` 或源码注解）**优先**。
**推断**：函数没显式声明时，effect set = ∪ (callee.effects)，从调用图反向传播。

## 五、Evaluator 算法

### 输入

- `CallGraph`
- `EffectDeclaration[]`、`EffectAnnotation[]`、`EffectPolicy[]`

### 算法

```pseudocode
function evaluateEffects(declarations, annotations, policies, callGraph):
    // Step 1: 初始化每个 node 的 effect set（直接声明）
    effects = Map<NodeId, Set<EffectName>>()
    
    for annotation in annotations:
        for node in matchPattern(annotation.target, callGraph.nodes):
            effects[node.id] ∪= annotation.annotates
    
    // 也读取语言原生注解（JSDoc / decorator / annotation）
    for node in callGraph.nodes:
        if node.effects:  // backend extractor 写入
            effects[node.id] ∪= node.effects
    
    // Step 2: 传播 — worklist + reverse postorder（Round 1 修订）
    // 教学版的不动点迭代实测在大项目上要 15+ 轮收敛 / 3-10s。
    // 改用 worklist 算法，平均 1-2 趟收敛。
    
    worklist = topologicalReversePostorderNodes(callGraph)  // leaves first
    enqueued = Set(worklist)
    
    while worklist not empty:
        node = worklist.popFront()
        enqueued.remove(node)
        
        oldEffects = effects[node]
        newEffects = oldEffects ∪ union(effects[callee] for callee in callees(node))
        
        if newEffects != oldEffects:
            effects[node] = newEffects
            for caller in callers(node):
                if caller not in enqueued:
                    worklist.pushBack(caller)
                    enqueued.add(caller)
    
    // Step 3: 对每个 policy 检查 scope 内函数的 effect set
    violations = []
    for policy in policies:
        scopeNodes = matchPattern(policy.targetScope, callGraph.nodes)
        for node in scopeNodes:
            actualEffects = effects.get(node.id, ∅)
            
            if policy.forbid:
                forbidden = expandEffectPatterns(policy.forbid)  // payment.* → {payment.charge, payment.refund}
                violated = actualEffects ∩ forbidden
                if violated:
                    violations.append(...)
            
            if policy.allowOnly is not None:
                allowed = expandEffectPatterns(policy.allowOnly)
                disallowed = actualEffects - allowed
                if disallowed:
                    violations.append(...)
    
    return violations
```

### 性能（Round 1 修订）

worklist 算法：每条边平均 visit 1-2 次。中等项目（1000 节点 5000 边 20 effect）实测 < 2s。

大项目（10000 节点 50000 边）：B.1 MVP < 30s；B.2 优化后 < 10s；v0.4+ < 3s。

参考：`00-overview.md` §D-B-007 性能预算分阶段表。

### Effect 衰减（CDL-only escape hatch）

**Round 1 修订**：源码内 `@stele:effects.suppress` 注解被**删除**。理由：agent 加一行 JSDoc 就能绕过整套 effect 系统，是契约后门，违反"机械联锁"原则。

Suppression **必须**通过 contract 文件里的 CDL form 声明（受 protected files 保护，agent 不可修改）：

```cdl
(effect-suppression
  (target "src/cache/cached-get.ts::cachedGet(1)")
  (suppresses db.read)
  (reason "Caching wrapper around getUser. The db.read leakage is intentional for the cache invalidation path."))
```

约束：

1. **`(reason "...")` 是强制字段**（empty string 不行）。无 reason → E0359 parse error。
2. Source 内的 `@stele:effects.suppress` 注解被 evaluator **完全忽略**（不再读取）。
3. `--strict-effects` 把 suppression 的存在升级为 **error**（不是 warning）。这是 CI 强制档位。
4. 每个 suppression 在 `stele check` 主流程 emit informational notice：

   ```
   [notice] effect.suppression_active
     target: src/cache/cached-get.ts::cachedGet(1)
     suppresses: db.read
     reason: "Caching wrapper around getUser..."
   ```

   review 时可追踪所有"被吞掉"的 effect。

5. Suppression 在违例报告里也会展示给被影响的下游 effect-policy："此函数原本应该违反 NO_IO_IN_UI 但被 X 处 suppression 吞掉"——避免静默失效。

## 六、5 语言适配

| 语言 | 注解形态 | 推断难度 | Phase B 第一波? |
| --- | --- | --- | --- |
| TypeScript | JSDoc tag `@stele:effects` + phantom 可选 | 简单 | ✅ |
| Python | decorator `@stele.effects(...)` | 简单 | ✅ |
| Go | 注释 `// stele:effects ...` | 中等 | 第二波 |
| Java | annotation `@Effects(...)` | 中等 | 第二波 |
| Rust | attribute macro `#[stele::effects(...)]` + marker traits | 较复杂（macro 元编程） | 第二波 |

第一波专注 TypeScript + Python。这两个语言的 effect 注解机制简单，能验证整套机制。

## 七、错误反馈

```
[error] effect.NO_IO_IN_UI.forbidden_effects
  source: effect/check
  location: src/components/UserCard.tsx:23:5
  summary: UI component function has forbidden effects: db.read, http.outgoing
  
  function: UserCard
  effective_effects: [render, db.read, http.outgoing]
  forbidden_in_scope: [db.*, http.*, fs.write, payment.*]
  
  propagation_chain (why this function has db.read):
    UserCard
      → useEffect callback
        → fetchUserData @ src/components/UserCard.tsx:18:7
          → getUserFromDb @ src/db/users.ts:42 (declares db.read)
  
  fix: Move data fetching out of UserCard. Use a hook/store that pre-fetches at higher level (route loader, redux thunk, or server component).
  
  fingerprint: effect.NO_IO_IN_UI.UserCard.db.read
```

**propagation_chain 是关键**——agent 看到不是"UserCard 自己声明了 db.read"，而是"UserCard 调了 fetchUserData 调了 getUserFromDb 才间接污染"，知道具体修哪。

### Propagation Chain 渲染：5 语言一致格式

不同语言的"间接调用"形式不同（async / decorator / context manager / goroutine / lifetime）。统一渲染模板：

**TypeScript**：

```
propagation_chain:
  UserCard
    → @line:col useEffect(callback) [async-context]
      → @line:col fetchUserData()
        → @line:col getUserFromDb [declares: db.read]
```

**Python**：

```
propagation_chain:
  UserCard
    → @line:col @cached_property fetch_user_data() [decorator]
      → @line:col with db.transaction() [context-manager]
        → @line:col Model.objects.filter() [declares: db.read]
```

**Go**：

```
propagation_chain:
  UserCard
    → @line:col go fetchUserData() [goroutine]
      → @line:col gorm.DB.Where() [declares: db.read]
```

**Java**：

```
propagation_chain:
  UserCard
    → @line:col CompletableFuture.supplyAsync(this::fetchUserData) [async]
      → @line:col jdbcTemplate.queryForObject() [declares: db.read]
```

**Rust**：

```
propagation_chain:
  UserCard
    → @line:col tokio::spawn(async move { fetch_user_data() }) [tokio-task]
      → @line:col diesel::query_dsl::filter() [declares: db.read]
```

通用规则：
- 每行 = 一个调用步骤
- `@line:col` 总是引用 caller 的调用点位置
- 方括号 `[...]` 标注调用的"特殊形态"（async / decorator / goroutine / lifetime）
- 末尾节点用 `[declares: ...]` 标注 effect 直接来源

## 八、CDL 解析

新增三个 CDL kind：

```typescript
// effect-declarations 整个块（每文件最多一个）
export interface EffectDeclarationsBlock {
  kind: "effect-declarations";
  filePath: string;
  span: SourceSpan;
  effects: { name: string; description?: string }[];
}

export interface EffectAnnotationDeclaration {
  kind: "effect-annotation";
  filePath: string;
  span: SourceSpan;
  target: string[];
  annotates: string[];
}

export interface EffectPolicyDeclaration {
  kind: "effect-policy";
  filePath: string;
  span: SourceSpan;
  id: string;
  description?: string;
  severity: "error" | "warning";
  targetScope: string[];
  forbid?: string[];
  allowOnly?: string[];
  fixHint?: string;
}
```

Validator：
- effect names 全 lowercase + dot-notation
- effect-annotation 的 target 至少一个
- effect-policy 必须 forbid 或 allow-only 二选一
- effect-policy 的 effect 名字必须在 effect-declarations 里声明过（**或** glob `*` / `payment.*`）

Error codes: E0350-E0359

## 九、Check Stage

`packages/cli/src/commands/check-stages-effect.ts` (NEW)：

```typescript
export async function buildEffectStage(
  context: PreparedCheckContext,
  protectedState: ProtectedCheckState,
  command: string,
): Promise<ViolationReport>
```

调用 `@stele/effect-evaluator`（新包）。注册到 check stage registry。

## 十、profile.yaml 集成

profile.yaml 当前**没有** effect 相关字段。新增：

```yaml
effect:
  declarations:
    - name: db.read
      description: "Reading from database"
    - name: db.write
      description: "Writing to database"
    # ...
  
  annotations:
    - target: ["extern:typeorm::*", "**/db/raw/**::*"]
      annotates: [db.read, db.write]
    # ...
  
  policies:
    - id: NO_IO_IN_UI
      target_scope: ["**/views/**", "**/components/**"]
      forbid: [db.*, http.*, fs.write, payment.*]
      fix_hint: "Move IO to services/"
    # ...
```

design-generator 把 `effect.*` 渲染成 CDL `(effect-*)` forms 写入 `contract/generated/effect.stele`（独立文件，与 ddd-typedriven.stele 平级）。

## 十一、与 trace-policy 的协同

| 维度 | trace-policy | effect-policy |
| --- | --- | --- |
| 关注 | 调用链拓扑（A→B→C） | 副作用集合（A 间接做了什么） |
| 形式 | "必经路径" | "禁止副作用" |
| 用例 | "DB 必经 Repository" | "UI 不能有 db.* effect" |

二者**互补**。同一约束可两种角度表达：

- 拓扑视角：`trace-policy DB_VIA_REPOSITORY`（UI 调 DB 必经 repository）
- 行为视角：`effect-policy NO_DB_IN_UI`（UI 函数不能含 db.* effect）

trace-policy 更精确（指定中间层），effect-policy 更聚合（不关心怎么到的，只看最终行为）。两者结合给最强契约。

## 十二、测试

10+ fixture + 各 backend extractor 单元测试 + 跨语言 conformance（与前文同模式）。

## 十三、工程量

| 子任务 | 工程量 |
| --- | --- |
| `@stele/effect-core` 包：types + effect pattern matcher | 1 天 |
| TS EffectAnnotationExtractor（JSDoc + phantom） | 2 天 |
| Python EffectAnnotationExtractor（decorator） | 2 天 |
| `@stele/effect-evaluator`：传播算法 + policy check | 3 天 |
| CDL 解析 + validator（3 个新 form） | 2 天 |
| design-generator 渲染 | 1 天 |
| check stage + CLI 集成 | 1 天 |
| 单元 + 集成 + conformance 测试 | 3 天 |
| **第一波（TS + Python）合计** | **~15 天** |

## 十四、风险

| 风险 | 缓解 |
| --- | --- |
| 外部库 effect 标注工作量大 | 维护 `presets/` 目录提供常见库的 effect-annotation 包：`@stele/preset-typeorm`, `@stele/preset-stripe` 等 |
| Effect 集合爆炸（项目里几十个 effect） | 用 dot-notation 层级 + `*` 通配 |
| 推断 + 显式声明冲突 | 显式优先；冲突时 warning |
| Suppression 被滥用作为绕过 | `--strict-effects` 把所有 suppression 升级为 warning，CI 强制 |
| Agent 写新函数忘标 effect | effect 通过调用图自动推断；显式声明只是文档化 |
