# 02 — Trace-Based Policy

## 一、目标

声明合法调用链：从某个 target 出发或到达，必须经过 / 必须前置 / 必须后继哪些函数。Stele 静态分析调用图，违反者自动拒绝。

## 二、CDL Form 规范

```cdl
(trace-policy <POLICY_ID>
  (description "...")
  (severity error|warning)            ; default error

  ;; 目标：哪些函数受此规则约束
  (target <pattern> [<pattern> ...])
  
  ;; 约束类型（可组合）
  (must-transit <pattern> [<pattern> ...])
  (must-be-preceded-by <pattern> [<pattern> ...])
  (must-be-followed-by <pattern> [<pattern> ...])
  (deny-direct <pattern> [<pattern> ...])
  (deny-transit <pattern> [<pattern> ...])
  
  ;; 作用域：规则只对哪些 caller 生效（缺省全项目）
  (scope <pattern> [<pattern> ...])
  
  ;; 排除：哪些 caller 豁免（用于已知合理的特殊情况，需 reason）
  (exempt <pattern> (reason "..."))
  
  ;; 修复指引：错误信息附带的人类语言提示
  (fix-hint "..."))
```

### Pattern 语法

Pattern 用 **NodeId glob**（统一所有跨语言场景）：

| Pattern | 含义 |
| --- | --- |
| `src/db/**` | src/db 目录下所有函数 |
| `**::Repository::*` | 任何文件里 Repository 类的任何方法 |
| `**::Repository::find(*)` | Repository.find 不限 arity |
| `stripe.*` | 用 `extern:stripe::*` 简写（自动加前缀） |
| `**/payment-service/*.ts::*` | 仅 TS 文件 |
| `**/payment-service/*.{ts,py,go,java,rs}::*` | 跨语言 |

### 约束语义

| 约束 | 语义 | 算法 |
| --- | --- | --- |
| `must-transit P` | 任何到达 target 的调用路径必须**穿过** P | 从 caller 到 target 的所有 DFS 路径，每条路径上必须有一个节点 ∈ P |
| `must-be-preceded-by P` | 调用 target 之前的**同函数体内**必须先调用过 P | caller 函数体内，target 调用点之前必须出现 P 调用 |
| `must-be-followed-by P` | 调用 target 之后的**同函数体内**必须后续调用 P | 调用点之后必须出现 P 调用 |
| `deny-direct P` | P 不允许**直接**调用 target | 直接 edge P→target 报违例 |
| `deny-transit P` | 调用路径上不能经过 P | 任何到 target 的路径不允许穿过 P |

`must-transit` 与 `deny-direct` 的区别：

- `must-transit "**/repository/**"`：从 controllers 到 DB，必须**穿过** repository
- `deny-direct "**/controllers/**"`：controllers **直接**调 DB 被禁，但通过 service 间接调可以

通常 `must-transit X` ⊃ `deny-direct A`（"必经 X" 隐含 "A 不能直达"），但有时只想禁直达不强求必经路径，分开表达更精确。

### Scope vs Target

- **target**：被保护的"目的地函数"（如 `db.query`、`stripe.charge`）
- **scope**：规则只看哪些"起点函数"（缺省全项目）

例：

```cdl
;; controllers 调 DB 必经 repository；其他文件随意
(trace-policy DB_ACCESS
  (target "**/db/*.{ts,py,go,java,rs}")
  (scope "**/controllers/**")
  (must-transit "**/repository/**"))
```

```cdl
;; 全项目调 stripe 都必须有 permission 前置 + audit 后置
(trace-policy PAYMENT_AUDIT
  (target "extern:stripe::*")
  ;; 缺省 scope = 全项目
  (must-be-preceded-by "**/permission/*.verify")
  (must-be-followed-by "**/audit/*.write"))
```

## 三、Evaluator 算法

### 输入

- `CallGraph` (cross-language)
- `TracePolicy[]`（从 contract 解析）

### 输出

`Violation[]`，每个违例包含：

```typescript
{
  rule_id: "trace.<POLICY_ID>.<violation_kind>",
  rule_kind: "trace_violation",
  severity: "error" | "warning",
  location: { path, line, column },
  cause: {
    summary: "...",
    actual_path: NodeId[],         // 当前实际调用链
    expected_constraint: string,   // 期望约束描述
    failure_witness: { ... }       // 详见 §6
  },
  fingerprint: "...",
  scope_paths: ["..."],
}
```

### 算法（每种约束独立）

```pseudocode
function evaluateTracePolicy(policy, callGraph):
    violations = []
    targetSet = matchPattern(policy.target, callGraph.nodes)
    callerSet = matchPattern(policy.scope ?? "**", callGraph.nodes)
    
    for each callerFn in callerSet:
        for each callPath in pathsFromTo(callerFn, targetSet, callGraph):
            // callPath = [callerFn, ..., targetFn]
            
            // must-transit
            for required in policy.mustTransit:
                if not any(node ∈ matchPattern(required) for node in callPath):
                    violations.append(missingTransit(callPath, required))
            
            // deny-direct
            if length(callPath) == 2 and callPath[0] ∈ matchPattern(policy.denyDirect):
                violations.append(directDenied(callPath))
            
            // deny-transit
            for forbidden in policy.denyTransit:
                if any(node ∈ matchPattern(forbidden) for node in callPath[1:-1]):
                    violations.append(forbiddenTransit(callPath, forbidden))
        
        // must-be-preceded-by / must-be-followed-by 看的是单个函数体内 call site 顺序
        callsInBody = callsInFunctionBody(callerFn, callGraph)
        for targetCall in callsInBody.filterTo(targetSet):
            for required in policy.mustBePrecededBy:
                if not any(c.line < targetCall.line for c in callsInBody.filter(required)):
                    violations.append(missingPredecessor(callerFn, targetCall, required))
            for required in policy.mustBeFollowedBy:
                if not any(c.line > targetCall.line for c in callsInBody.filter(required)):
                    violations.append(missingSuccessor(callerFn, targetCall, required))
    
    return violations
```

### 性能优化（Round 1 修订）

`pathsFromTo` 是 NP-hard 一般情形。优化：

1. **路径长度上界**：默认 max depth = **10**（覆盖现实项目调用链，原 6 偏紧）。可调 `--trace-max-depth N`
2. **超过 max depth 时 emit warning**（不是静默跳过）：

   ```
   [warning] trace.<POLICY_ID>.path_exceeded_max_depth
     source: trace/check
     summary: Call path from <caller> to <target> exceeded depth cap (10). Rule not fully enforced for this path.
     fix: Either refactor the call chain to be shorter, or run `stele check --trace-max-depth 20` if deep chains are intentional.
   ```

   这避免"契约静默失效"。

3. **路径数量上界**：每对 (caller, target) 最多分析 100 条路径。超过同样 emit warning。
4. **必经路径检查的短路**：找到第一条违例就停（除非 `--all-violations`）
5. **缓存 reachability**：CallGraph 上预计算每个节点的 reachable set，用 BitSet 表示

性能预算：参考 `00-overview.md` §D-B-007 分阶段表。B.1 MVP 中等项目 < 60s（含三机制），不只 trace。

## 四、5 语言一致性

`trace-policy` 完全语言无关。各 backend 提供 CallGraph，evaluator 在 Stele core 跑一份。

但 pattern 解析需要 cross-language 一致：

| Pattern | TS 匹配 | Python 匹配 | Go 匹配 | Java 匹配 | Rust 匹配 |
| --- | --- | --- | --- | --- | --- |
| `**::Order::pay(*)` | `Order.prototype.pay` | `Order.pay` | `(*Order).Pay` | `Order.pay` | `impl Order::pay` |
| `**/repository/*` | 任意 `.ts` 文件 | `.py` | `.go` | `.java` | `.rs` |
| `extern:stripe::*` | npm stripe | pip stripe | go module | maven stripe-java | crate |

跨语言匹配规则在 `packages/trace-evaluator/src/pattern-matcher.ts`，所有语言走同一份代码。

## 五、典型 Policy 模板（按可用阶段拆分）

模板按 First-Wave Capability Matrix (`00-overview.md` §五) 分组：

### 5.1 B.1 (TypeScript only) 可用

```cdl
;; ────────── 数据访问层隔离（TypeScript ORM） ──────────
(trace-policy DB_VIA_REPOSITORY_TS
  (description "All DB access must transit through Repository<T>")
  (target "**/db/**::*"
          "extern:typeorm::*"
          "extern:prisma::*")
  (must-transit "**/repository/**::*")
  (deny-direct "**/controllers/**" "**/views/**"))
```

### 5.2 B.2 (加入 Python) 可用

```cdl
(trace-policy DB_VIA_REPOSITORY_TS_PY
  (description "Cross TS/Python DB access via repository")
  (target "**/db/**::*"
          "extern:typeorm::*"
          "extern:prisma::*"
          "extern:django-db::*"          ; alias to django.db
          "extern:sqlalchemy::*")
  (must-transit "**/repository/**::*")
  (deny-direct "**/controllers/**" "**/views/**"))
```

### 5.3 B.3 (Go/Java/Rust 加入) 可用

```cdl
(trace-policy DB_VIA_REPOSITORY_FULL
  (description "All DB access must transit through Repository<T>")
  (target "**/db/**::*"
          "extern:typeorm::*"
          "extern:prisma::*"
          "extern:django-db::*"
          "extern:sqlalchemy::*"
          "extern:gorm::*"               ; B.3
          "extern:sea-orm::*"            ; B.3
          "extern:jdbc::*"               ; B.3
          "extern:hibernate::*")         ; B.3
  (must-transit "**/repository/**::*")
  (deny-direct "**/controllers/**" "**/views/**"))
```

### 5.4 通用模板（任何阶段，但只对该阶段语言生效）

下列模板使用 logical extern alias（通过 `(extern-alias ...)` 解析到具体语言的包名）：

```cdl
;; 全项目调 stripe（不论语言）都必须有 permission 前置 + audit 后继
;; 配套 (extern-alias stripe ...) 声明在 main.stele 或 preset 中

(trace-policy PAYMENT_GATEWAY_GUARD
  (target "extern:stripe::*")
  (must-be-preceded-by "**/permission/**::verify")
  (must-be-followed-by "**/audit/**::write")
  (fix-hint "External payment calls must verify permission first and audit the result."))

;; ────────── 外部调用合规链 ──────────
(trace-policy PAYMENT_GATEWAY_GUARD
  (target "extern:stripe::*" "extern:alipay::*" "extern:paypal::*")
  (must-be-preceded-by "**/permission/**::verify")
  (must-be-followed-by "**/audit/**::write")
  (fix-hint "External payment calls must verify permission first and audit the result."))

(trace-policy HTTP_VIA_SERVICE
  (description "External HTTP only from service layer")
  (target "extern:fetch" "extern:axios::*" "extern:requests::*"
          "extern:net/http::Get" "extern:reqwest::*")
  (must-transit "**/services/**")
  (deny-direct "**/controllers/**" "**/views/**" "**/components/**"))

;; ────────── 文件系统沙箱 ──────────
(trace-policy FS_WRITE_SANDBOX
  (target "extern:fs::write*" "extern:fs::append*" "extern:open*"
          "extern:os::write" "extern:fs/std::*")
  (must-transit "**/sandbox/**::write*")
  (fix-hint "File writes must go through sandbox.writeSafe / sandbox.writeChecked"))

;; ────────── 加密 / 安全 ──────────
(trace-policy CRYPTO_RANDOM_GUARD
  (description "Crypto-grade random required for secrets/tokens")
  (target "**/crypto/**::generateToken" "**/secrets/**::*")
  (must-transit "extern:crypto::randomBytes" "extern:secrets::token_bytes")
  (deny-direct "extern:Math::random" "extern:random::random"))

;; ────────── 多 Tenant 隔离 ──────────
(trace-policy TENANT_SCOPED_QUERIES
  (target "**/repository/**::find*" "**/repository/**::query*")
  (must-be-preceded-by "**/context/**::getTenantId")
  (fix-hint "Repository queries must read tenant context before query"))
```

## 六、错误反馈规范（Agent 接收的违例信息）

错误反馈必须让 agent **从信息直接推出修改方向**。统一格式：

```
[error] trace.<POLICY_ID>.<violation_kind>
  source: trace/check
  location: <file>:<line>:<col>
  summary: <one-sentence description>
  
  actual_call_chain:
    <caller> → <step1> → <step2> → <target>
  
  expected:
    must-transit: <pattern> (no match in actual chain)
  
  fix: <specific actionable hint from fix-hint>
  
  fingerprint: <stable id for baseline>
```

例子：

```
[error] trace.PAYMENT_GATEWAY_GUARD.missing_predecessor
  source: trace/check
  location: src/services/order.ts:42:5
  summary: stripe.charge call requires permission.verify before it in the same function body
  
  actual_call_chain:
    OrderService.fastPay(orderId)
      → @17:5 stripe.charges.create(orderId)
  
  expected:
    must-be-preceded-by: **/permission/**::verify  (no such call before stripe.charge)
  
  fix: Insert `await permission.verify(orderId, "payment")` before calling stripe.charges.create.
  
  fingerprint: trace.PAYMENT_GATEWAY_GUARD.OrderService.fastPay.stripe.charges.create
```

Agent 拿到这个直接知道：
1. 哪个函数有问题（OrderService.fastPay）
2. 哪一行有问题（17:5）
3. 缺什么调用（permission.verify）
4. 应该插在哪里（stripe.charges.create 之前）
5. 完整修复模板（`await permission.verify(orderId, "payment")`）

## 七、与已有 architecture rule 的区别 / 协同

| 维度 | architecture (v0.2) | trace-policy (Phase B) |
| --- | --- | --- |
| 关注 | import 关系 | 调用链 |
| 粒度 | 包/模块 | 函数 |
| 规则形态 | "allow A → B" 二元 | "from A, must transit B" 路径约束 |
| 用法 | 划分宏观层 | 锁定关键路径 |

不替代关系，是**互补**。架构规则继续保持（粗粒度宏观），trace-policy 补细粒度精确。Phase A 已经验证 architecture rule 工作良好（ddd-mcp 已修），不重构它。

## 八、CDL 语法新增

`packages/core/src/validator/structure-trace-policy.ts` (NEW)：

```typescript
export interface TracePolicyDeclaration {
  kind: "trace-policy";
  filePath: string;
  span: SourceSpan;
  id: string;
  description?: string;
  severity: "error" | "warning";
  target: string[];
  mustTransit: string[];
  mustBePrecededBy: string[];
  mustBeFollowedBy: string[];
  denyDirect: string[];
  denyTransit: string[];
  scope: string[];
  exempt: { pattern: string; reason: string }[];
  fixHint?: string;
}

export function parseTracePolicyDeclaration(...): TracePolicyDeclaration { ... }
```

Validator 检查：
- 必须至少一个约束（must-* 或 deny-*）
- target 非空
- exempt 必须带 reason
- severity 默认 error

Error codes: E0330-E0339（trace-policy 专用区段）

## 九、Check Stage

`packages/cli/src/commands/check-stages-trace.ts` (NEW)：

```typescript
export async function buildTraceStage(
  context: PreparedCheckContext,
  protectedState: ProtectedCheckState,
  command: string,
): Promise<ViolationReport>
```

调用 `@stele/trace-evaluator`（新包，与 `@stele/architecture-core` 并列）。

注册到 check stage registry（详见 `05-refactor-cleanup.md`）。

## 十、测试

### 单元测试（每语言独立）

`packages/<backend>/tests/call-extractor.test.ts`：基于 `tests/conformance/fixtures/callgraph-*/` 跑各语言提取器。

### 集成测试

`packages/cli/tests/check-stages-trace.test.ts`：

10+ fixture：
1. `trace-policy-must-transit-ok.stele` + 合规代码 → 0 violations
2. `trace-policy-must-transit-violation.stele` + 越过中间层代码 → 1 violation
3. `trace-policy-must-precede-ok.stele` → 0
4. `trace-policy-must-precede-violation.stele` → 1
5. `trace-policy-must-follow-ok.stele` → 0
6. `trace-policy-must-follow-violation.stele` → 1
7. `trace-policy-deny-direct-ok.stele` → 0
8. `trace-policy-deny-direct-violation.stele` → 1
9. `trace-policy-scope-narrows-ok.stele` → scope 外的 caller 即使直达也不违例
10. `trace-policy-exempt-ok.stele` → 显式 exempt 的 caller 豁免

### Conformance（跨语言）

`tests/conformance/fixtures/trace-policy-cross-lang/`：同一逻辑写 5 个语言版本，结果必须一致。

## 十一、实施工程量估算

| 子任务 | 工程量 |
| --- | --- |
| `@stele/call-graph-core` 包：CallGraph 类型、pattern matcher | 2 天 |
| TS CallGraphExtractor | 3 天 |
| Python CallGraphExtractor | 3 天 |
| Go CallGraphExtractor | 4 天 |
| Java CallGraphExtractor | 4 天 |
| Rust CallGraphExtractor | 4 天 |
| `@stele/trace-evaluator` 包：算法 + 5 类约束 | 4 天 |
| CDL 解析 + validator + uniqueness | 1 天 |
| check stage + CLI 集成 | 1 天 |
| 单元 + 集成 + conformance 测试 | 4 天 |
| **合计** | **~30 天 (1.5 人月)** |

**Phase B 第一波只交付 TS + Python**（D-B-003），可压缩到 **~18 天**。Go/Java/Rust 后续推进。

## 十二、风险

| 风险 | 缓解 |
| --- | --- |
| 大项目 callgraph 提取慢 | 缓存 + 增量 (§六 在 01) |
| 高阶函数 / DI 调用追溯困难 | MVP 接受 unresolved，`--strict` 升级为 error |
| 跨语言 pattern 语义不一致 | 统一 pattern matcher 实现，跨语言 conformance fixture |
| Agent 误以为 unresolved 是 bug | 错误反馈明确写"unresolved"+ 处理建议 |
