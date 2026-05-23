# Phase B Design Round 2 Review — Reviewer E (Agent UX + Error Feedback)

视角：模拟 Claude Code / Cursor 在 stele check 失败后能否一次自修复。一旦 agent 困惑、走错、放弃，那就是 UX bug。

## Critical UX Issues

### U1. Effect 错误反馈缺"已声明 effects"列表 → agent 不知从何加 suppression

04 §七 样例：
```
effective_effects: [render, db.read, http.outgoing]
forbidden_in_scope: [db.*, http.*, fs.write, payment.*]
propagation_chain: UserCard → useEffect → fetchUserData → getUserFromDb [declares: db.read]
```
缺一项：**UserCard 自身是否已显式声明 effects**。Agent 看不出"我是不是只要补一个 @stele:effects 标注就行 vs 必须删调用"。建议加一行 `direct_effects_on_node: []`（说明全是 propagation 来的），让 agent 立刻知道"这不是标注问题，是代码问题"。

### U2. Trace path_exceeded_max_depth 是"契约失效"还是"契约通过"模糊

02 §三 渲染（`[warning] ... Rule not fully enforced for this path`）严重低估了 agent 的解读能力盲点。Agent 看到 warning 通常忽略——但这里**契约可能正在被违反，只是看不见**。
- 当前 fix-hint 让 agent "refactor or pass `--trace-max-depth 20`" 二选一。agent 无能力判断该选哪个。
- 缺关键信息：**还有多少未探索路径**（"sampled 100, abandoned at depth 10, ≥ N more paths exist"）。
- 推荐：在该 warning 上加 `enforcement_completeness: partial`，并加 `actionability: human-review-required`，让 agent 不要假装它通过了。

### U3. Type-state 错误反馈缺"o 来自哪里"的 inference_source

03 §六 样例只说 `inferred_state: Paid` `receiver: order`，没说**Paid 是怎么推出来的**——是从 `createOrder()` 返回，还是从 `pay()` 返回，还是从函数参数标注。Agent 拿不到这条信息时，无法判断要不要重排代码顺序还是改参数标注。

建议加：
```
inference_source:
  origin: src/services/order.ts:74:9  ; order = await orderService.pay(orderId)
  reason: "return type of pay() is Order<\"Paid\">"
```
这是让 agent "看到自己写的代码是什么样"的关键缺失。

### U4. Lenient mode notice 文案不具操作性

03 §四：`type-state inference failed for <function>: consider adding parameter annotation or (type-state-binding ...) for this function`。
- "consider adding" 是模糊建议，不是 action。
- agent 不知道**应该加哪个 state**（Submitted? Paid?）。
- agent 不知道 `(type-state-binding ...)` 写在哪个文件（main.stele？生成 stele？）。

修：notice 应附带"基于当前调用点最常见 state 是 X，模板：`(type-state-binding (function "<NodeId>") (param 0 state X))`"。

## Concrete Fix-Hint Audit

逐条 grep 文档现有 fix-hint，分级：

| 文件 | fix-hint | 评价 |
|---|---|---|
| 02 §六 例子 | `Insert \`await permission.verify(orderId, "payment")\` before calling stripe.charges.create.` | **具体** — agent 可直接照写 |
| 02 §五 PAYMENT_GATEWAY_GUARD | `External payment calls must verify permission first and audit the result.` | **模糊** — 缺函数名、缺顺序、缺参数 |
| 02 §五 FS_WRITE_SANDBOX | `File writes must go through sandbox.writeSafe / sandbox.writeChecked` | **半具体** — 给了函数名但没给签名 |
| 02 §五 TENANT_SCOPED_QUERIES | `Repository queries must read tenant context before query` | **模糊** — `read tenant context` 不是代码 |
| 03 §六 ORDER_LIFECYCLE | `(a) Change order's state before this call (b) Move addItem call to before submit() (c) propose a design update` | **半具体** — 选项明确但 "(a) refund → re-create draft" 是文字，不是模板 |
| 04 §三 NO_IO_IN_UI | `Move IO to services/. UI should receive pre-fetched data via props.` | **模糊** — "move to services" 没指哪个 service、没说函数签名 |
| 04 §三 PURE_LIB_ONLY | `Pure library functions must not depend on IO or external state.` | **极模糊** — 这是定义不是 fix |
| 04 §三 REDUCERS_PURE | `Reducers must be pure functions of (state, action) -> state.` | **极模糊** — 同上 |

**结论**：约 60% fix-hint 是模糊的，agent 拿到后会自己瞎猜。建议规范"fix-hint 模板必须含可粘贴代码片段或具体 file:line 引用"。

## Multi-Violation Handling

文档 **没有**讨论以下任一项，全是空白：

1. **排序规则**：50 个 violation 时按 severity 排？按 fingerprint 排？按 location 排？未定义。
2. **优先级字段**：Violation schema 没有 `priority` / `blocking` 字段。Agent 无法从输出推断"先修哪个"。
3. **同一根源 collapse**：00-overview §六 `also_violates: [...]` 提到 trace + effect 同一函数同根源 dedup，但**只有一句话**——dedup key 怎么算？trace.PAYMENT_AUDIT 和 effect.NO_PAYMENT_IN_CONTROLLER 即使指向同一行，root cause 也未必相同（trace 视角是缺前置，effect 视角是禁副作用）。dedup 实际形态从未演示样例。
4. **同函数多 violation**：例如 OrderController.payOrder 同时缺 predecessor + 缺 successor + 含 forbidden effect——会输出 3 条独立 violation 还是 1 条 grouped？文档无答案。

**这是 round 2 最大的盲区**。Agent 在 50-violation 输出下会卡死。

## Inference Failure UX

### 推断失败的反馈链断了

Type-state 推断失败时（03 §四）：
- 默认 lenient → notice，agent **不一定读 notice**（多数 CLI 默认只看 error/warning）
- strict 启用 → error E0349，但 E0349 错误信息没在文档中样例
- agent 切换 strict 后看到 50 个 E0349 全是"加 type-state-binding"——但**应该加什么 state 完全没说**

### Effect 推断在高阶函数 / async 下溢出

04 §五 worklist 算法把 db.read 自动传染到 caller，**没有 propagation 上限**。某 utility 函数 `pipe()` 调过 db.read 一次，整个项目的 caller 都会被污染 db.read effect。该函数的 propagation_chain 渲染会包含成百上千个 caller——agent 抓不到重点。

建议：propagation_chain 限制 depth = 5；超出后 collapse 为 `[... N more callees, run \`stele explain effect <node>\` to see full\`]`。

## Propagation Chain 5-Language 一致性

04 §七 给了 5 语言模板。一致性问题：

- TS `[async-context]` vs Java `[async]` vs Rust `[tokio-task]` vs Go `[goroutine]` — 4 种"异步"标签 4 种叫法。Agent 跨语言 reading 时心智模型断裂。建议统一为 `[async]` 加可选限定（`[async:goroutine]`、`[async:tokio]`）。
- Python `[context-manager]` 和 `[decorator]` 是 Python 独有 — 其他语言遇到类似形态（TS HOF、Rust trait-impl）没有对应 tag。建议规范"6 种通用 tag" + 语言原生 tag 作为后缀。

## End-to-End Simulation

### 场景：Agent 实现 OrderController.payOrder

```python
class OrderController:
    def pay_order(self, order_id: str):
        order = self.repo.find(order_id)
        result = stripe.charges.create(amount=order.amount)
        return result
```

`stele check` 报：
1. `trace.PAYMENT_AUDIT.missing_predecessor` (stripe call requires permission.verify)
2. `trace.PAYMENT_AUDIT.missing_successor` (stripe call requires audit.write)
3. `effect.NO_PAYMENT_IN_CONTROLLER.forbidden_effect` (controller has payment.* effect)

**Agent 实际行为预测**（基于现有 fix-hint 文案）：

- 看到 violation 1 → fix-hint 是 `Insert await permission.verify(orderId, "payment") before stripe.charges.create` → ✅ 加上
- 看到 violation 2 → fix-hint 是模糊的 "must verify permission first and audit the result" → ❌ agent 可能不加 audit.write 调用，只在 violation 1 上补完就 retry
- 看到 violation 3 → fix-hint 是 "Move IO to services" → ⚠️ agent 会把 stripe 调用挪到 OrderService，但**违例 1+2 仍存在于 OrderService**（PAYMENT_AUDIT 不限 scope）
- Agent 修了 violation 3 后 retry → violation 1+2 转移到 OrderService 上 → agent 困惑"我刚才在 controller 加了 verify，怎么 service 还是缺？"
- 此时 agent **大概率**复制 controller 的 verify 调用到 service —— 但忘了 audit
- 至少 **2 次 retry 才能收敛**，可能进 3-4 次循环

**修复成功率预估**：
- 一次性修复 3 个违例：约 **30%**（依赖 agent 读懂 effect 后果链 + 不被模糊 fix-hint 误导）
- 2-3 次 retry 后修复：约 **70%**
- 卡死 / 放弃：约 **15-20%**（特别是 violation 1+2 在 controller 修复后又转移到 service 时的"为什么还报错"困惑）

**关键 UX 失败点**：文档没意识到"effect-policy 把代码挪走，trace-policy 会跟着挪到新位置"——agent 看不到这个 coupling。应在 violation 输出里加 cross-reference："此 violation 与 trace.X 相关，修了 effect 后 trace.X 会在 <新位置> 重新触发"。

## Recommended Fixes

按 ROI 排：

1. **(P0)** 给 violation 加 `priority: blocking|major|minor` 字段 + `group_id`（同函数 same group），让 agent 知道修哪个、哪些一起修
2. **(P0)** 所有 fix-hint 强制改写为"包含可粘贴代码片段或具体 file:line 引用"；为此在 CDL `(fix-hint ...)` 内加 grammar 校验，禁止超过 X% 模糊词（"must", "should", "ensure"）
3. **(P0)** Effect 错误反馈加 `direct_effects_on_node` 和 `propagation_root_node` 让 agent 区分"补标注"vs"删调用"
4. **(P1)** Type-state notice / error 加 `inference_source` 显示 state 怎么推出来的
5. **(P1)** Multi-violation 输出加章节"Cross-Rule References"：trace + effect 互相指向同一根源时显式 link
6. **(P1)** path_exceeded_max_depth 加 `enforcement_completeness: partial` 标志和"≥ N more paths exist"提示
7. **(P2)** Propagation chain 标签统一（async / decorator / context / concurrent 等 6 个通用 tag）
8. **(P2)** Lenient notice 必须含可粘贴的 type-state-binding 模板
9. **(P2)** Propagation chain depth cap = 5，超出 collapse
10. **(P3)** End-to-end fixture 加一组 multi-violation fixture，验证修复 N 个违例只需 1 次 retry

**Bottom line**：现有错误反馈格式在**单 violation 简单场景**下 agent 能修复（70%+）；在 **multi-violation + 跨规则 coupling + 推断失败**场景下 agent **大概率多次重试或放弃**（< 40% 一次修复成功率）。Phase B 上线前必须补 P0 三项，否则会成为 agent 反复失败的源头。
