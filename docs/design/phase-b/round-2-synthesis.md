# Round 2 综合报告

汇总 round 2 两位独立 reviewer（D=安全/契约自我保护、E=Agent UX/错误反馈）的反馈，列出每条决策的处理方式。

## 一、Reviewer D 安全维度（6 个 Critical）

### D-CG-1（Critical）`--strict-*` opt-in 是新的契约后门

**问题**：round 1 把 effect suppression 从源码搬到 CDL，但 `--strict-effects` / `--strict-typestate` / `--strict-callgraph` 默认 warning。CI 不开 flag = 零成本绕过路径。Stele 自身 `contract/main.stele` 没有 strict-mode 自检。

**处理**：**默认行为反向**。

- `effect-suppression`、`type-state inference failure`、`callgraph unresolved` 默认 **error**。
- 加 opt-out flag `--lenient-effects` / `--lenient-typestate` / `--lenient-callgraph`，仅在开发本地能用。
- CI 任何情况都不允许 lenient（隐含约定：用户在 CI 配置里不显式加 `--lenient-*` 即可）。
- Stele 自身契约新增 invariant `STRICT_MODE_DEFAULT_IN_CI`，自检本仓库 CI 配置不含 lenient flag。

修订文件：`04-effect-system.md` §五.3、`03-type-state.md` §四、`01-call-graph-extractor.md` §七、`contract/main.stele` 自检新增。

### D-CG-2（Critical）Trace depth cap 静默失效

**问题**：`02-trace-based-policy.md` §三.2 文档说"超过 maxDepth 不静默跳过，emit warning"。但 warning 实际就是静默失效（不报违例）。Agent 故意套 11 层调用即可绕过整套 trace-policy。

**处理**：`depth-cap-exceeded` 默认 **error**。

- 用户需要 deep chain：在 CDL 显式 `(exempt "..." (reason "..."))`（受 protected 文件保护）
- 不要 warning 灰色地带
- `--lenient-trace` 允许本地降级到 warning（不在 CI 用）

修订文件：`02-trace-based-policy.md` §三优化部分。

### D-CG-3（Critical）Phase B 新包无法纳入 `ALL_BACKENDS_COMPILE`

**问题**：源码核对——`backend_registries()` checker 硬断言 `REGISTERED_BACKENDS` 必须正好 5 个 language backend (python/typescript/go/rust/java)。Phase B 新 evaluator 包不能塞进 `REGISTERED_BACKENDS`（它们没有 `generate()`），但又必须有等价 dist 检查。**直接加会破坏 backend_registries()**。

**处理**：新增独立 checker `all-evaluators-compile`，不动 `REGISTERED_BACKENDS`。

```cdl
(checker all-evaluators-compile
  (description "Every Phase B evaluator package must have buildable dist/index.js + dist/index.d.ts."))

(invariant ALL_EVALUATORS_COMPILE
  (severity error)
  (description "@stele/call-graph-core, @stele/trace-evaluator, @stele/type-state-evaluator, @stele/effect-evaluator, @stele/type-driven-evaluator must be built.")
  (uses-checker all-evaluators-compile))
```

Python 实现：硬编码 evaluator 包名列表，分别检查 dist/。

修订文件：`05-refactor-cleanup.md` §九、`06-cdl-extensions.md` §六、Phase B 实施时 `contract/main.stele` 加上述 invariant + `contract/checker_impls/self_protection.py` 加 checker 函数。

### D-CG-4（Major）Rule_id 文档前提错误

**问题**：源码核对——Phase A 实际 rule_id 是 `typedriven.branded-id.*` 和 `typedriven.smart-ctor.*`（dot + hyphen），不是设计文档说的 `type_driven.branded_id.*`（underscore）。所有 rule_id stability 断言基于错误前提。

**处理**：

- 修正所有设计文档里的 rule_id 占位字符串为真实约定 `typedriven.{form}.{id}`
- Phase B 新 rule_id 严格遵循同模式：
  - `typedriven.type-state.<id>.<violation_kind>`
  - `typedriven.effect.<policy_id>.<violation_kind>`
  - `trace.<policy_id>.<violation_kind>`（trace 独立 namespace）
- Stability test 用真实字符串

修订文件：`05-refactor-cleanup.md` §四、`06-cdl-extensions.md` 错误码段、`02 / 03 / 04` 错误反馈样例。

### D-CG-5（Major）Effect-policy unresolved calls fail-open

**问题**：`(allow-only ())` 在 unresolved call 场景下 fail-open——agent 写 `getattr(db, "query")()` 让 callgraph 标 unresolved，effect 集合空，policy 误通过。

**处理**：unresolved calls 在 effect 评估时 **fail-closed**。

- effect evaluator 见到 scope 内 node 含 `unresolvedCalls` → 默认违例（不通过）
- fix-hint："无法静态确定此函数的副作用，使用 `(effect-annotation ...)` 显式标注，或重构调用为静态可解析形式"
- 与 D-CG-1 一致：默认 strict，opt-out lenient

修订文件：`04-effect-system.md` §五 Step 3。

### D-CG-6（Major）文档自相矛盾

**问题**：`04-effect-system.md` §五.3（升级为 error）与 §十四 risk 表（升级为 warning）相反。

**处理**：统一为 error，删除 §十四 表中过期描述。

修订文件：`04-effect-system.md` §十四。

## 二、Reviewer D 其他发现

### D-Self-Bootstrap：PR 排期与 registry test 冲突

`REQUIRED_STAGE_IDS` 在 PR2 阶段要求 trace/typestate/effect 存在，但这些 stage 是 Week 3-5 实施。test 早写晚加 stage 会让 CI 永久 fail。

**处理**：

- `REQUIRED_STAGE_IDS` 按 phase 标签分级：

  ```typescript
  const REQUIRED_STAGE_IDS: Record<"v0.2" | "phase-a" | "phase-b", string[]> = {
    "v0.2":     ["generated", "protected", "toolchain", "code-shape", "architecture", "complexity"],
    "phase-a":  ["type-driven"],
    "phase-b":  ["trace", "type-state", "effect"],
  };
  
  it("CHECK_STAGES contains all stages for current PHASE", () => {
    const expected = [
      ...REQUIRED_STAGE_IDS["v0.2"],
      ...REQUIRED_STAGE_IDS["phase-a"],
      ...(process.env.STELE_PHASE === "phase-b" ? REQUIRED_STAGE_IDS["phase-b"] : []),
    ];
    expect(CHECK_STAGES.map(s => s.id)).toEqual(expect.arrayContaining(expected));
  });
  ```

- Phase B 实施完成后 CI 强制设 `STELE_PHASE=phase-b`

修订：`05-refactor-cleanup.md` §一.A。

### D-buildRawCheckReport 第二条链路

`check.ts` `runCheck` 有 `buildRawCheckReport` programmatic API（L240-270），同样硬编码 stage 调用。PR2 切换时**两处必须都切**。

修订：`05-refactor-cleanup.md` §二 + §一.A 加入此约束。

## 三、Reviewer E Agent UX 维度（3 个 P0）

### E-P0-1 多 Violation 处理盲点

**问题**：50 violation 时 agent 卡死。文档没有：

- 排序规则
- 优先级字段
- 同根源 collapse
- 同函数 grouped

**处理**：Violation schema 增加字段：

```typescript
interface Violation {
  // ... existing fields ...
  
  /** Round 2 新增：优先级提示 agent 处理顺序 */
  priority: "blocking" | "major" | "minor";
  
  /** 同一根源的 violation 集合标识。同 group_id 的 violations 应一并修复 */
  group_id: string;     // 通常是 function NodeId
  
  /** 跨规则交叉引用（trace + effect 同一根源时） */
  also_violates?: string[];     // 同 fingerprint 的其他 violation 的 rule_id
  
  /** 修了 X 之后 Y 会自动消失（agent 不需要再修） */
  resolves_with?: string[];     // 修了某 rule_id 后，本 violation 也会消失
}
```

**Stele 输出排序规则**：

1. priority desc (blocking → major → minor)
2. group_id（同 group 连续输出）
3. severity within group (error > warning)
4. location asc

**修订 cross-rule reference 实例**：

```
[error] effect.NO_PAYMENT_IN_CONTROLLER.forbidden_effect
  priority: blocking
  group_id: src/controllers/order.ts::OrderController::payOrder
  also_violates:
    - trace.PAYMENT_AUDIT.missing_predecessor
    - trace.PAYMENT_AUDIT.missing_successor
  ...
  
  cross-rule note: This function violates 3 rules. Fixing the effect violation by moving
  the stripe call to a service WILL NOT resolve the trace violations — they will follow
  the code to the new location. Plan your fix to satisfy all three at once.
```

修订文件：`00-overview.md` §六、`02 / 03 / 04` 错误反馈样例、新增 `06-cdl-extensions.md` violation schema 章节。

### E-P0-2 ~60% fix-hint 模糊

**问题**：很多 fix-hint 是"must verify permission first and audit the result"，不是"Insert `await permission.verify(...)` before `stripe.charge(...)`"。

**处理**：

1. CDL `(fix-hint "...")` 验证器强制：
   - 必须包含至少一个 backtick-quoted 代码片段 OR file:line 引用
   - 禁止仅含 "must"/"should"/"ensure"/"avoid"/"don't" 等模糊动词的纯散文
   - E0339 模糊 fix-hint 解析错误（建议格式给出）

2. 设计文档所有 fix-hint 例子重写为可粘贴模板。

3. 系统级 fix-hint 拼接：fix-hint 模板 + 当前 violation 上下文（actual location + 调用图节点名）自动填入：

   ```
   fix-hint template: "Insert `await {predecessor}({receiver_arg})` before `{target_call}` in {actual_file}:{actual_line}"
   resolved fix:      "Insert `await permission.verify(orderId, \"payment\")` before `stripe.charges.create(...)` in src/controllers/order.ts:42"
   ```

   template 用 `{...}` 占位，evaluator 替换。

修订文件：`02 / 03 / 04 / 06`（fix-hint grammar），新增 fix-hint substitution 章节。

### E-P0-3 Effect 反馈缺关键字段

**问题**：Agent 看到 effect violation 不知道是"补 annotation"还是"删调用"。

**处理**：Effect violation 反馈增加：

```yaml
direct_effects_on_node: []           # 此 node 自身声明的 effects
inherited_effects: [db.read, http.outgoing]   # 从 callees 继承的
propagation_root_nodes: [             # 最终来源
  "src/db/users.ts::getUserFromDb(1) [declares: db.read]",
  "extern:axios::*::request(2) [declares: http.outgoing]"
]
```

Agent 看到 `direct_effects_on_node: []` 就知道是 propagation 问题（应删调用或加 suppression）。看到非空就知道是注解问题（删调用或修改注解）。

修订文件：`04-effect-system.md` §七。

## 四、Reviewer E 其他发现

### E-P1-1 Type-state inference_source

**问题**：03 §六 错误反馈说 `inferred_state: Paid` 但没说"Paid 从哪推出来的"。

**处理**：Type-state violation 反馈增加：

```yaml
inferred_state: Paid
inference_source:
  origin: src/services/order.ts:74:9
  reason: "return type of pay() is Order<\"Paid\">"
  flow_steps:
    - "Order<\"Submitted\"> created at src/services/order.ts:62"
    - "→ Order<\"Paid\"> at src/services/order.ts:74 via pay()"
```

Agent 看了 flow_steps 立刻知道要么改顺序（在 line 74 之前调 addItem）要么走 propose 流程。

修订文件：`03-type-state.md` §六。

### E-P1-2 Effect/Trace 跨规则 coupling

**问题**：Agent 修了 effect-policy 把 stripe 挪到 service，发现 trace-policy 跟着挪到 service 报相同违例。Agent 困惑。

**处理**：见 E-P0-1 的 `cross-rule note` 字段。这是同一问题的两面。

### E-P1-3 path_exceeded_max_depth UX

**问题**：D-CG-2 已经把它改为 default error。Agent 看到 error 知道契约失效。问题自解。

### E-P2-1 Propagation chain 标签 5 语言一致

**问题**：TS `[async-context]` vs Java `[async]` vs Rust `[tokio-task]` vs Go `[goroutine]` 4 种异步叫法。

**处理**：统一为 **6 种通用 tag** + 语言原生 tag 后缀：

| 通用 tag | TS | Python | Go | Java | Rust |
|---|---|---|---|---|---|
| `[async]` | useEffect callback / await / Promise | async def / await | goroutine | CompletableFuture / @Async | tokio task / async fn |
| `[concurrent]` | Worker | multiprocessing | go func | Thread | std::thread |
| `[deferred]` | setTimeout | asyncio.sleep | time.AfterFunc | ScheduledExecutor | tokio::time::sleep |
| `[reflection]` | Reflect / Proxy | getattr / __dict__ | reflect.* | java.lang.reflect | std::any |
| `[macro-generated]` | (TSX compile) | decorator | go generate | annotation processor | macro_rules |
| `[higher-order]` | callback fn arg | callable arg | func arg | functional interface | Fn closure |

显示：`[async:goroutine]` / `[async:tokio]` / `[higher-order:trait-impl]` 等。

修订文件：`04-effect-system.md` §七、`07-cross-language-strategy.md` 新增"Propagation Tags"。

### E-P2-2 Lenient notice 必须含可粘贴 binding 模板

**处理**：见 E-P0-2 fix-hint substitution 同机制。

### E-P2-3 Propagation chain depth cap = 5

**处理**：超过 5 collapse 为 `[... N more callees, run `stele explain effect <node>` to see full]`。

`stele explain effect <NodeId>` 新增 CLI 命令展开完整 chain。

修订：`04-effect-system.md` §七、新增 `stele explain effect` 命令到 CLI。

## 五、要在最终设计稿明确的事项

### 1. Severity Default Matrix（Round 2 综合）

| 规则形态 | 默认 severity | Lenient 时 | Strict 时 |
|---|---|---|---|
| trace-policy 违例 | error | warning | error |
| trace-policy depth-cap-exceeded | error | warning | error |
| effect-policy forbid | error | warning | error |
| effect-policy allow-only | error | warning | error |
| effect-suppression active | warning | warning | error |
| type-state disallowed-op | error | warning | error |
| type-state inference-failure | error | warning | error |
| callgraph unresolved | warning | notice | error |

**关键**：`--lenient-*` 一律是 opt-out（开发本地用），CI 不允许配置。

### 2. Violation Schema 最终形态

```typescript
interface Violation {
  rule_id: string;
  rule_kind: "trace" | "type_state" | "effect" | ... ;
  severity: "error" | "warning" | "notice";
  source: { tool: "stele"; command: string; kind: string };
  location: { path: string; line: number; column: number };
  cause: { summary: string; ... };
  fingerprint: string;
  scope_paths: string[];
  
  // Round 2 新增
  priority: "blocking" | "major" | "minor";
  group_id: string;
  also_violates?: string[];
  resolves_with?: string[];
  cross_rule_note?: string;
}
```

### 3. Stele 自身契约新增 invariants（用于 Phase B 自检）

- `ALL_EVALUATORS_COMPILE`（D-CG-3）
- `STRICT_MODE_DEFAULT_IN_CI`（D-CG-1）
- `FIX_HINT_NOT_VAGUE`（E-P0-2 grammar 验证）—— 元检查所有 CDL 中 fix-hint 都符合可粘贴格式

### 4. CLI 命令新增

- `stele explain effect <NodeId>`（E-P2-3）

## 六、Round 2 修订总结

| 维度 | Round 2 修订量 |
|---|---|
| 默认 severity 反向（lenient → strict） | 涉及 4 个文件 §章节 |
| Trace depth cap default error | 1 处修订 |
| `all-evaluators-compile` 新增 invariant | 2 处文档 + 1 处 contract/main.stele 注释 |
| Rule_id 真实约定（`typedriven.{form}.{id}`） | 3 处文档全局替换 |
| Unresolved fail-closed | 1 处算法修订 |
| 文档矛盾删除（04 §十四） | 1 行删除 |
| Violation schema 扩展（priority/group_id/cross_rule） | 5 个章节修订 |
| fix-hint grammar + substitution | 5 个章节修订 + 新增 grammar 规则 |
| Effect 反馈 direct_effects/propagation_root | 1 章节修订 |
| Type-state inference_source | 1 章节修订 |
| Propagation tag 统一 6 通用 | 2 章节修订 + 新表 |
| Propagation chain depth cap | 1 行修订 |
| `stele explain effect` 命令 | 新增 §章节 |
| Self-bootstrap PR 排期 | 1 章节修订 |
| buildRawCheckReport 第二链路 | 1 行补充 |

## 七、Round 2 没解决的（限制）

按 Phase B 范围明确**不解决**：

1. **Type-state 跨函数边界自动传播**：仍需要 `(type-state-binding ...)` 显式标注。这是设计 trade-off（性能 + 推断准确率）
2. **async / promise / callback 内 type-state 推断**：v0.4+ 处理
3. **Effect-policy 在 dynamic dispatch 下完全闭环**：unresolved fail-closed 提高严格度但仍非 100% 闭环
4. **Go separate-types 真正 first-class type-state**：B.3 second-class，trace-policy + effect-policy 补位
5. **大规模 propagation chain 渲染优化**：cap 5 + explain 命令兜底

这些限制文档中诚实承认，不假装能解决。
