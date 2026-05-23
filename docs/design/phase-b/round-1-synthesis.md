# Round 1 综合报告

汇总 3 个独立 reviewer（A=架构/跨语言、B=可行性/工程量、C=Stele 契合/重构）的反馈，列出每条决策的处理方式。

## 一、共识 Critical Issues（多 reviewer 指出）

### CI-1. NodeId arity 在重载语言下塌进同一 ID

提出者：A C1 + B C2。

**问题**：`name(arity)` 不能区分 Java/Rust 同名同 arity 不同参数类型的重载。trace-policy 会误归因。

**解决**：NodeId 规范增加 disambiguator 字段。在 `01-call-graph-extractor.md` §3 重写：

```
NodeId = {filePath}::{containerChain}::{symbolName}({arity})[#{disambiguator}]
```

- `disambiguator` 仅在同 (file, container, name, arity) 出现 ≥2 时填入
- 内容是参数类型规范化字符串的 SHA-1 前 8 位
- pattern 匹配时 `#disambiguator` 段如缺失视为通配
- 重载场景下 pattern 必须显式带 `#` 才精确定位

修改文件：`01-call-graph-extractor.md` §3, `02-trace-based-policy.md` §四, `06-cdl-extensions.md` §5.1。

### CI-2. Python self / Go receiver 计入 arity 不一致

提出者：A C2。

**问题**：文档 §3 表格 Python `Order::pay(2)` 而 TS `Order::pay(1)`——同样"接 1 个业务参数"NodeId 不同。

**解决**：NodeId arity 规范**明确排除隐式 receiver**：

- Python: `self` 不计
- Python: classmethod 的 `cls` 不计
- Go: pointer / value receiver 不计（`func (o *Order) Pay(amount)` → arity = 1）
- Java / TS / Rust: 没有隐式 receiver 概念，arity 即业务参数

修改文件：`01-call-graph-extractor.md` §3 表格 + 添加 "implicit receiver excluded" 规范段。

### CI-3. extern: 跨包名空间映射缺失

提出者：A C3。

**问题**：`extern:stripe::*` 在 npm / pip / cargo / maven / go module 是 5 个不同名字，pattern 不可移植。

**解决**：新增 CDL form `(extern-alias ...)`：

```cdl
(extern-alias stripe
  (typescript "stripe")
  (python "stripe")
  (rust "stripe-rust")
  (java "com.stripe:stripe-java")
  (go "github.com/stripe/stripe-go/v74"))
```

pattern `extern:stripe::*` 经 alias 展开到当前项目语言的实际包名。多语言项目把每个 alias 写一次，所有规则共享。

`@stele/preset-aliases` npm 包提供常见库（stripe/typeorm/django.db/gorm/etc）的预制 alias。用户在 main.stele 里 `(import "@stele/preset-aliases/common.stele")`。

修改文件：新增 `02b-extern-aliases.md`；更新 `06-cdl-extensions.md` 加 `extern-alias` form (E0360-E0364)。

### CI-4. Effect suppression 是契约后门

提出者：A C4 + C "Philosophy"。

**问题**：源码内 `@stele:effects.suppress` 注解让 agent 一行代码绕过整套 effect 系统。warn-only 不够。

**解决**：

1. **删除源码内 suppress 注解** 的支持。
2. Suppression 只能通过 CDL `(effect-suppression ...)` 声明（受 contract 保护，agent 不可改）。
3. CDL 内 suppression 必须强制 `(reason "...")` 字段。
4. `--strict-effects` 把所有 suppression 升级为 **error**（不是 warning）。
5. Suppression 默认在 `stele check` 主流程里 emit informational notice："Effect X suppressed in function Y by contract <span>"——让 review 时可追踪。

修改文件：`04-effect-system.md` §五 完全重写。

### CI-5. Backend 0 行 AST 解析能力（致命前提错误）

提出者：B C1。

**问题**：5 个 backend 当前只有 codegen translator，文档假设"复用 backend 已有 AST 能力"完全不成立。Go/Java/Rust 每个 CallGraphExtractor 实际 10-14 天（建宿主语言子进程 + IPC + 跨平台分发），不是 4 天。

**解决**：Phase B **重新切片**：

- **B.1（4-6 周）TS-only**：只 TypeScript backend 实现 CallGraphExtractor + 三机制 evaluator + check stage 集成。证明三机制能跑通、性能能 take、UX 能用。
- **B.2（4-6 周）Python 加入**：Python CallGraphExtractor + 真实性能基准。conformance fixture 收敛到 TS+Python 2 语言（不是 5）。
- **B.3（独立立项，6-9 周）Go / Java / Rust**：每语言独立项目，含宿主语言子进程构建 + 二进制分发 + CI 矩阵。

**修改文件**：
- `00-overview.md` D-B-001 实施顺序重写
- `00-overview.md` D-B-003 跨语言落地优先级重写
- 新增 `00b-phase-slicing.md` 详细切片说明
- `02 / 03 / 04` 工程量段重估算
- `README.md` 实施序列更新

### CI-6. Multi-agent 删除清单漏文件

提出者：C C1。

**问题**：`packages/core/src/normalizer/normalize.ts` 第 28-72, 233, 253 行**消费** agent / scope / inter-agent-contract / conflict。删除清单漏了。另外 `docs/spec/cdl.md` §286-362 公开文档**错误**声称 MCP `validate-edit` 使用这些 form。

**解决**：

1. `05-refactor-cleanup.md` §一 删除清单增加：
   - `packages/core/src/normalizer/normalize.ts`（删除 4 个 form 的处理分支）
   - `docs/spec/cdl.md` §286-362（删除 multi-agent 章节，并在 deprecation history 说明"原 v0.2 spec 错误声称 MCP 集成，实际未实现"）

2. 删除后必须跑 `pnpm test:packed-adoption` 验证下游用户的 .stele 文件解析仍正常（除了用了 4 form 的部分会被拒——这是 intended）。

### CI-7. render-stele 拆分缺 byte-stability 验收

提出者：C C2。

**问题**：当前测试只 per-function `toEqual`，没有 full-output golden snapshot。拆分可能静默 drift `contract/generated/ddd-typedriven.stele`，破坏用户的 protected file 状态。

**解决**：拆分前**强制**：

1. 写 `tests/golden-snapshots/render-stele.snap.txt`——`renderAllDeclarations` 的完整输出。
2. 拆分前后 `diff -u` 必须空 diff。
3. 拆分 PR 必须包含这个 snapshot test 作为新 unit test。
4. `pnpm test:packed-adoption` 跑通验证下游 manifest.json 不变。

修改文件：`05-refactor-cleanup.md` §四 加 acceptance criterion。

### CI-8. Phase A rule_id stability

提出者：C C3。

**问题**：Phase A 引入的 `type_driven.branded_id.*` / `type_driven.smart_ctor.*` rule_id 已在用户 baselines 里。Phase B 重构 typescript-shape → type-driven-evaluator 包时如果 rule_id 变了，用户 baselines 全失效。

**解决**：`05-refactor-cleanup.md` §三 增加硬约束：

> "rule_id strings 在 Phase A 已发布的格式 (`type_driven.branded_id.*`, `type_driven.smart_ctor.*`) 是**冻结的契约**。包的物理位置变化时 rule_id 字符串保持完全一致。新增 Phase B 形态 (`type_driven.type_state.*`, `type_driven.effect.*`) 才能用新前缀。"

新增冒烟测试：解包前一个版本的 .last-check-report.json，运行 check 后验证 rule_id 集合是超集关系（无删除）。

## 二、需要解决的 Major Concerns

### MC-1. trace-policy vs effect-policy 重叠会让用户陷选择困境

提出者：A M1。

**解决**：

1. 在 `00-overview.md` 加入 decision tree：
   - 关心"必经路径"（有第三方中间层）→ trace-policy
   - 关心"行为外观"（叶子节点的副作用）→ effect-policy
   - 不确定 → 默认 effect-policy（更鲁棒）
2. Evaluator 层加 dedup：相同 (function, root_cause_node) 的两个 violation 只报一个，标 `also_violates: [...]`。
3. 在 `02 / 04` 末尾加交叉引用："此规则也可用 effect-policy 表达，见..."

### MC-2. Type-state 跨函数边界传播

提出者：A M2 + B M3。

**解决**：

1. **第一波**只支持函数内推断 + 显式参数标注。文档明确写"local + annotated only"。
2. CDL 可以显式标注函数参数状态：

   ```cdl
   (type-state-binding
     (function "src/order/handler.ts::OrderHandler::process(1)")
     (param 0 state Submitted))
   ```

3. 推断不出时**默认 lenient 不报，但生成 notice**"type-state 推断在此函数失败：considerare adding parameter annotation"。`--strict-typestate` 升级为 error。
4. async/promise/callback 在 `03-type-state.md` §四 单独一节坦白：第一波默认推断率 < 50%。**不夸大能力**。

### MC-3. Go separate-types ≠ TS phantom

提出者：A M3。

**解决**：`07-cross-language-strategy.md` §六 重写：

- 不说"等价"，明说"不同语言对状态的表达根本不同"
- Go 上 type-state mode 默认为 `off`，仅在显式 opt-in 目录启用
- Go 项目推荐用 trace-policy + effect-policy 替代 type-state
- Java 17+ 用 sealed types 自动识别（自动）；非 17 项目 mode default off
- 工程量在 B.3 阶段重估

### MC-4. CallGraph 缓存对 interface 变化失效

提出者：A M4。

**解决**：缓存文件增加 `methodResolutionHash`（项目全局 interface 实现关系摘要）：

```json
{
  "schemaVersion": "1",
  "fileHashes": {...},
  "methodResolutionHash": "sha256-of-all-interface-impl-relationships",
  ...
}
```

当 `methodResolutionHash` 变化即触发 ambiguous calls 全量重析。修改文件：`01-call-graph-extractor.md` §六。

### MC-5. 第一波能力矩阵不清晰

提出者：A M5。

**解决**：`00-overview.md` 增加单点能力矩阵章节"First-Wave Capability Matrix"——清楚列出每个机制 × 每个语言在 B.1 / B.2 / B.3 各阶段的状态。后面其他文档统一引用此矩阵，避免散落各处自相矛盾。

### MC-6. 不动点算法用 worklist + reverse postorder

提出者：B M1。

**解决**：`04-effect-system.md` §五 算法部分**完全重写**为 worklist 算法（不动点教学版换 production 版）：

```pseudo
worklist = topologicalSort(callGraph in reverse postorder)
while worklist not empty:
  node = worklist.pop()
  oldEffects = effects[node]
  newEffects = unionOf(effects[callee] for callee in callees(node))
  if newEffects != oldEffects:
    effects[node] = newEffects
    add all callers(node) to worklist
```

中等项目实测 1-2 趟收敛。性能预算更新（见 MC-7）。

### MC-7. 性能预算偏差 3-10× 的现实校准

提出者：B Performance Reality Check。

**解决**：`00-overview.md` §D-B-007 性能预算**重写为分阶段渐进目标**：

| 阶段 | 中等项目（1000 文件）| 大项目（10000 文件）| 增量 |
|---|---|---|---|
| B.1 MVP（TS-only） | < 60s | < 5 min | < 20s |
| B.2 性能基准后 | < 30s | < 3 min | < 10s |
| 长期目标（v0.4+）| < 10s | < 60s | < 5s |

**MVP 不承诺 v0.4 的性能**。基准实测后逐步逼近。

修改文件：`00-overview.md` §D-B-007 + 各机制文档的工程量段附加性能脚注。

### MC-8. trace path depth cap 超过时显式 warning

提出者：B M2。

**解决**：`02-trace-based-policy.md` §三 算法部分增加：

- 超过 maxDepth 时**不静默跳过**，emit warning `trace.<POLICY_ID>.path_exceeded_max_depth` 让用户知道该路径未完整检查。
- maxDepth 默认从 6 提升到 **10**（覆盖现实项目调用链）。
- `--trace-max-depth N` CLI 标志允许覆盖。

### MC-9. pyright daemon 模式

提出者：B M4。

**解决**：`07-cross-language-strategy.md` §五 Python CallGraphExtractor 章节增加：

- B.2 阶段实现 pyright daemon (`pyright --watch` 长连接 JSON-RPC) 而非每次 stele check 冷启动子进程。
- 子进程生命周期由 stele 管理（项目首次 check 启动；空闲 5 分钟自动停）。
- 工程量重估算：B.2 Python CallGraphExtractor 从 3 天调到 **7 天**（含 daemon 集成）。

### MC-10. Stage registry 重构期间 self-check 失效

提出者：B M6 + C "Refactor Item 2"。

**解决**：

1. 重构 commit 前先加 **meta-check**：`tests/registry-completeness.test.ts` 断言 `CHECK_STAGES.map(s => s.id)` 必须包含所有 v0.2 + Phase A 的 stage id。
2. stage 移入 registry 时**先加，再删旧**（不是同时改两端）。
3. 提交 plan：先 PR1（加 registry，仍走旧硬编码）→ PR2（旧硬编码改用 registry，跑 self-check） → PR3（删旧 hardcoded 调用）。
4. CI 工作流中 stele check 自身 fail 视为 PR block，不允许 force-merge。

修改文件：`05-refactor-cleanup.md` §二 + 增加新 §二.X "Self-Bootstrapping Safety"。

### MC-11. 多 sub-agent 并发改 structure-types.ts 必然冲突

提出者：B M7。

**解决**：`05-refactor-cleanup.md` §十 实施 plan 章节**重写**——把所有 sub-agent 任务图按文件级冲突分析：

```
锁 structure-types.ts 的串行链：
  1. multi-agent 删除（agent 0）
  2. trace-policy 加 (agent 1)
  3. type-state 加 (agent 2)
  4. effect form 加 (agent 3)

锁 check.ts 的串行链：
  1. stage registry 重构（agent 0）
  2. 三个新 stage 注册（agent 1-3，可并行）

锁 render-stele.ts 的串行链：
  1. 拆分（agent 0，含 byte-stability snapshot）
  2. 各 render 函数增量（agent 1-3，可并行）
```

每条串行链单独 sub-agent。链之间可并行。

### MC-12. 新包必须 register 到 ALL_BACKENDS_COMPILE

提出者：C C7。

**解决**：

1. `05-refactor-cleanup.md` §九 + `06-cdl-extensions.md` 增加：每个新增包 (`@stele/call-graph-core`, `@stele/trace-evaluator`, `@stele/type-state-evaluator`, `@stele/effect-evaluator`, `@stele/type-driven-evaluator`) 必须注册到 `packages/cli/src/backend-registry.ts` 类似的 evaluator-registry，或者扩展 `ALL_BACKENDS_COMPILE` checker 改名为 `ALL_PACKAGES_COMPILE` 覆盖所有 evaluator 包。
2. 实施 sub-agent 完成包构建后，必须先跑 `node packages/cli/dist/index.js check` 验证包不破坏 invariant。

### MC-13. type-state.target 单值 vs glob 不一致

提出者：C "CDL Coherence"。

**解决**：允许 `type-state.target` 是 glob：

```cdl
(type-state ORDER_LIFECYCLE
  (target "src/order/order.go::*Order")    ; glob for Go separate-types
  ...
  (state-type-mapping
    Draft     "src/order/order.go::DraftOrder"
    ...))
```

修改文件：`03-type-state.md` §三 grammar 更新 + `06-cdl-extensions.md` §4.2 grammar 更新。

### MC-14. Stage registry 必须处理 filter pipeline + 明示 declaration order

提出者：C "Refactor Item 2 / 5"。

**解决**：`05-refactor-cleanup.md` §二 stage registry 设计完善：

1. `CheckStage` 接口增加 `applyFilters` 责任 OR `runAllStages` 把 filter wrapper 显式做：

   ```typescript
   for (const stage of orderedStages) {
     const report = await stage.build(...);
     reports.push(applyFiltersToReport(report, filters));
   }
   ```

2. Stage 排序明确写：**declaration order in CHECK_STAGES array**。`dependsOn` 仅作 topological 提升（不允许 cycle）。

### MC-15. Type-state fix-hint 不能让 agent 改契约

提出者：C "Philosophy" 1。

**解决**：`03-type-state.md` §六 fix copy 重写：

- 删除 "(c) Modify ORDER_LIFECYCLE.allowed-ops if business rules changed"
- 替换为 "(c) If business rules legitimately changed, **propose** a design update via `stele design propose`. Do not edit the contract directly."

同模式扫描其他 fix-hint，确保没有"让 agent 改契约"的话。

## 三、修订后还需补充的内容

### N-1. trace-policy template 第一波 / 第二波拆分

提出者：A M5。

`02-trace-based-policy.md` §五 模板章节按语言可用性拆：

- "第一波（TS）可用 templates"
- "第一波（TS+Python）可用 templates"
- "需要第二波（Go/Java/Rust）才完整 templates"

### N-2. CallGraphExtractor 5 语言 polish

提出者：B / C 多点。

不再在 Phase B 第一波承诺 5 语言齐全。`01-call-graph-extractor.md` §四 trait 定义保留（接口先做），但 §五 5 语言实现路径**只交付 TypeScript**（B.1）；其他 4 语言路径文档保留作为 future reference。

### N-3. propagation_chain 5 语言渲染模板

提出者：A N1。

`04-effect-system.md` §七 增加单独章节"Propagation Chain Rendering Across Languages"——5 语言每个一个渲染模板（async / decorator / context manager / goroutine / lifetime 怎么显示）。

### N-4. transition 多 source/target 语法糖

提出者：A N3。

`03-type-state.md` §三 grammar 允许：

```cdl
(transition (from Draft Submitted) (via cancel) (to Cancelled))
```

等价于两条独立 transition。修改 parser 处理逻辑。

### N-5. effect-declarations 每文件/多文件规则统一

提出者：A N4。

**决策**：允许每文件多 block + 跨文件合并去重。`06-cdl-extensions.md` §4.3 重写。删除"每文件最多一个"的约束（费解）。

## 四、不修订的部分（保留原设计）

以下点经过分析**保留原设计**：

- ✅ 三机制（trace / type-state / effect）的整体定位
- ✅ CallGraph 作为公共抽象
- ✅ 错误反馈格式（rule_id + actual + expected + fix-hint + fingerprint）
- ✅ TS+Python 第一波（但工程量 / 时间表重估）
- ✅ profile.yaml 演化（删 adt + 加 effect / type-state，含 deprecation period）
- ✅ design-generator 渲染（typescript-shape → type-driven-evaluator 重构方向）
- ✅ MVP 边界（高阶函数 unresolved，acceptable）
- ✅ 删除 multi-agent dead forms（但补全清单包含 normalize.ts）

## 五、Phase B 重切片后的执行 plan

基于 CI-5（B 切片建议）+ MC-7（性能渐进）+ MC-11（sub-agent 串行化），重写实施序列：

```
============= B.1 (4-6 周, TypeScript only) =============

Week 1: 重构基础
├─ 删除 multi-agent（含 normalize.ts）
├─ CDL form 类型扩展（structure-types.ts 串行：先 multi-agent 删，再加新 5 form 类型定义）
├─ check stage registry（含 self-bootstrapping safety + ratchet test）
├─ render-stele 拆分（含 byte-stability snapshot 验收）
└─ typescript-shape → type-driven-evaluator 包提取

Week 2: 公共基础
├─ @stele/call-graph-core 包（types + pattern matcher + NodeId 规范 + extern-alias 解析）
└─ TS CallGraphExtractor (含 method-resolution-hash 缓存)

Week 3: Trace-Based Policy
├─ CDL 解析 + validator + uniqueness
├─ @stele/trace-evaluator 包（worklist 算法）
├─ check stage + design-generator 渲染
└─ 单元测试 + TS-only integration test

Week 4: Type State
├─ CDL 解析（含 state-type-mapping for future Go）
├─ @stele/type-state-evaluator 包（local + annotated only）
├─ TS phantom-type 推断
└─ async/promise 坦白文档

Week 5: Effect System
├─ CDL 解析（含 strict effect-suppression policy）
├─ @stele/effect-evaluator 包（worklist 不动点）
├─ TS JSDoc / phantom 注解解析
└─ propagation_chain 渲染

Week 6: 收尾 + 性能基准
├─ stele 自身契约更新（main.stele 加 trace-policy / type-state / effect-policy 自检规则）
├─ 性能基准：finance-guard / 内部 Python adoption / 10x 同义放大测试
├─ 错误码 / spec 文档更新
└─ release tag v0.3.0-b1

============= B.2 (4-6 周, Python 加入) =============

Week 7-8: Python CallGraphExtractor
├─ pyright daemon 集成
├─ 子进程生命周期管理
├─ JSON-RPC IPC 协议

Week 9-10: Python evaluator 适配
├─ Python decorator 解析（effect annotation）
├─ Python typing.Generic 推断（type-state, 第一波 lenient）
└─ TS+Python conformance suite（不强求 5 语言）

Week 11-12: B.2 收尾
├─ 真实性能基准（target: 接近 B.1 + 50% 允许）
├─ release tag v0.3.0-b2

============= B.3 (6-9 周, 独立立项) =============

Go / Java / Rust CallGraphExtractor + evaluator 适配
- 每语言独立 sub-project
- 宿主语言子进程 / 二进制构建
- 跨平台分发（5 平台 binary）
- CI 矩阵扩展
- 不在 B.1/B.2 范围内
```

## 六、Round 2 审查重点

修订 draft 完成后，启动 round 2 两个 reviewer：

- **Reviewer D（安全与契约自我保护）**：复核 CI-4 effect-suppression、CI-7 byte-stability、CI-8 rule_id stability、MC-10 self-bootstrapping safety 这几条是否真把"agent 不能绕过契约"覆盖严密。
- **Reviewer E（Agent UX 与错误反馈）**：复核 MC-2 lenient/strict 默认、MC-15 fix-hint 不让 agent 改契约、N-3 propagation_chain 渲染、MC-1 dedup 等是否真让 agent 拿到错误后能直接自修复。

Round 2 不审查工程量（B 已经处理）和跨语言一致性（A 已经处理），聚焦最关键的两个 Stele 价值轴。

## 七、决策记录差异

三个 reviewer 中 B 主张"B.1 = TS-only"，A 主张"5 语言 callgraph 全做但 evaluator TS+Python"。

**裁决**：采用 B 的方案（B.1 TS-only）。理由：

1. 5 语言 callgraph 全做后才发现 TS+Python evaluator 跑不通——返工成本高
2. TS-only 先验证三机制 *能跑通*、*性能能 take*、*错误反馈能用* 三件事
3. 5 语言 callgraph 基础设施虽然必要，但应在 evaluator 稳定后再投入
4. B 给出了具体工程量数据；A 没有数据反驳

`00-overview.md` D-B-001 + D-B-003 按此裁决修订。
