# Phase B 最终设计稿（Final Spec）

经过 1 轮初稿 + 2 轮独立 reviewer 审查（共 5 个 reviewer）+ 2 轮修订后的最终设计。

## 一、最终决策摘要

### 范围

Phase B 新增三个机械联锁机制：

1. **Trace-Based Policy** — 调用链合法性（必经路径 / 必前置 / 必后继 / 禁直达）
2. **Type State** — 实体状态机契约化
3. **Effect System** — 函数副作用集合传播 + scope 限制

**不做**：
- ADT exhaustiveness（用户决策）
- 量化腐化分数 / SLO（后续阶段）
- 治理元契约
- 任何"必须人审"的设计
- Multi-agent 协同（删除 4 个 dead form）

### 切片

| 阶段 | 范围 | 时间 |
|---|---|---|
| **B.1** | TypeScript-only：三机制完整 + 重构基础 + 性能基准 | 4-6 周 |
| **B.2** | Python 加入：pyright daemon + 跨语言 conformance | 4-6 周 |
| **B.3** | Go/Java/Rust（独立立项） | 6-9 周，独立 sprint |

### 关键安全设计（Round 2 强化）

1. **默认 strict**：effect-suppression / type-state inference failure / callgraph unresolved / trace depth-exceeded 默认 **error**。`--lenient-*` opt-out 仅开发本地用，CI 不允许。
2. **CDL-only suppression**：源码内 `@stele:effects.suppress` 注解被完全忽略。所有 suppression 必须写在 protected 的 contract 文件里 + 强制 `(reason "...")` 字段。
3. **新增 invariant 自检自身设计**：
   - `ALL_EVALUATORS_COMPILE` —— Phase B 新包必须可编译
   - `STRICT_MODE_DEFAULT_IN_CI` —— 本仓库 CI 不允许 lenient flag
   - `FIX_HINT_REQUIRES_ANALYSIS_BRANCH` (renamed from `FIX_HINT_NOT_VAGUE` in Round 3 P1-2, severity promoted `warning → error` in Round 4 F-C-01) —— Every default fix-hint must teach the [A] code-issue / [B] contract-issue split + reference the propose flow + the proposals dir.
4. **Unresolved fail-closed**：callgraph 无法解析的调用在 effect / trace 评估中**默认违例**，agent 必须显式 annotation 或重构。

### 关键 UX 设计（Round 2 强化）

1. **Violation Schema 扩展**：增加 `priority` / `group_id` / `also_violates` / `resolves_with` / `cross_rule_note` 字段。Stele 输出按 priority + group + severity 排序，让 agent 一次看清所有相关违例。
2. **fix-hint Grammar 验证**：CDL 验证器强制 fix-hint 含可粘贴代码片段或 file:line 引用。模糊文本（仅 "must"/"should"/"ensure"）报 E0339。
3. **Effect 反馈分离 `direct_effects_on_node` vs `inherited_effects`**：agent 立刻知道是"补 annotation"还是"删调用"。
4. **Type-state 反馈包含 `inference_source`**：agent 知道推断的 state 从哪条调用链推出来。
5. **Cross-rule note**：trace + effect 同一根源 violation 显式提示"修了 X 之后 Y 会跟着挪到新位置"。
6. **Propagation tag 统一 6 通用** + 语言原生 tag 后缀：`[async:goroutine]` / `[async:tokio]` 等，agent 跨语言心智模型一致。

## 二、文档结构

完整设计文档（修订后）：

| 文件 | 内容 | 状态 |
|---|---|---|
| `README.md` | 索引 + 实施序列 | Round 2 修订完毕 |
| `00-overview.md` | 决策记录 + 能力矩阵 + decision tree | Round 2 修订完毕 |
| `01-call-graph-extractor.md` | 跨语言 AST 抽象 + NodeId disambiguator | Round 1 修订完毕 |
| `02-trace-based-policy.md` | trace 机制 + 模板按阶段拆分 | Round 1 修订完毕 |
| `03-type-state.md` | type-state 机制 + 跨函数边界限制坦白 | Round 1 修订完毕 |
| `04-effect-system.md` | effect 机制 + worklist 算法 + suppression 安全化 | Round 1 修订完毕 |
| `05-refactor-cleanup.md` | 现有重构清单 + self-bootstrapping safety | Round 1 修订完毕 |
| `06-cdl-extensions.md` | CDL 扩展总清单 + extern-alias + type-state-binding | Round 1 修订完毕 |
| `07-cross-language-strategy.md` | 5 语言适配 + Go 局限诚实承认 + pyright daemon | Round 1 修订完毕 |

审查记录：

| 文件 | 内容 |
|---|---|
| `round-1-reviewer-A.md` | 架构与跨语言一致性 |
| `round-1-reviewer-B.md` | 实施可行性 + 工程量 + 性能 |
| `round-1-reviewer-C.md` | Stele 契合 + 重构 + 哲学 |
| `round-1-synthesis.md` | Round 1 综合（8 critical + 15 major） |
| `round-2-reviewer-D.md` | 安全 + 契约自我保护 |
| `round-2-reviewer-E.md` | Agent UX + 错误反馈质量 |
| `round-2-synthesis.md` | Round 2 综合（6 critical security + 3 P0 UX） |
| `FINAL-SPEC.md` | 本文档 |

## 三、Round 2 收尾修订清单（待 sub-agent 实施时处理）

Round 1 修订已落入 draft 文件。Round 2 修订涉及以下文件，在 Phase B sub-agent 实施时**一次性应用**：

### 修订文件清单

1. **04-effect-system.md**：
   - §五.3 suppression 升级 default error（D-CG-1）
   - §十四 risk 表删除 "warning" 描述（D-CG-6）
   - §五 Step 3 unresolved fail-closed（D-CG-5）
   - §七 加 `direct_effects_on_node` + `propagation_root_nodes` 字段（E-P0-3）
   - §七 propagation chain depth cap = 5（E-P2-3）
   - §七 propagation tag 统一 6 通用（E-P2-1）

2. **03-type-state.md**：
   - §四 inference failure default error（D-CG-1）
   - §六 加 `inference_source` 字段（E-P1-1）

3. **02-trace-based-policy.md**：
   - §三 depth-cap-exceeded default error（D-CG-2）
   - §六 加 cross-rule reference 字段（E-P1-2）

4. **01-call-graph-extractor.md**：
   - §七 unresolved default error（D-CG-1）

5. **05-refactor-cleanup.md**：
   - §九 / 新增"all-evaluators-compile invariant"章节（D-CG-3）
   - §一.A REQUIRED_STAGE_IDS 按 phase 分级（D-Self-Bootstrap）
   - §二 加 `buildRawCheckReport` 切换约束（D-Self-Bootstrap）
   - §四 rule_id 用真实约定 `typedriven.{form}.{id}`（D-CG-4）

6. **06-cdl-extensions.md**：
   - 新增 Violation schema 扩展章节（E-P0-1）
   - 错误码 E0339 fix-hint vague check 加入（E-P0-2）
   - 新增 fix-hint substitution 章节（E-P0-2）
   - rule_id 命名约定章节加入（D-CG-4）

7. **00-overview.md**：
   - §四 加 D-B-008：Severity Default Matrix（D-CG-1）
   - §四 加 D-B-009：Violation Schema 扩展（E-P0-1）

### 新增检查项（contract/main.stele 自检 — Phase B 实施时加）

```cdl
(checker all-evaluators-compile
  (description "All Phase B evaluator packages must build to dist/index.js + dist/index.d.ts."))

(invariant ALL_EVALUATORS_COMPILE
  (severity error)
  (description "@stele/call-graph-core, @stele/trace-evaluator, @stele/type-state-evaluator, @stele/effect-evaluator, @stele/type-driven-evaluator must each have valid dist/ output.")
  (uses-checker all-evaluators-compile))

(checker strict-mode-default-in-ci
  (description "Stele's own CI workflow must not pass --lenient-* flags."))

(invariant STRICT_MODE_DEFAULT_IN_CI
  (severity error)
  (description "Self-protection: this repo's CI workflow must use Stele's default strict behavior (no --lenient-* opt-outs).")
  (uses-checker strict-mode-default-in-ci))

(checker fix-hint-requires-analysis-branch
  (description "Every default fix-hint emitted by a trace/type-state/effect evaluator must teach the [A] code-issue / [B] contract-issue split."))

(invariant FIX_HINT_REQUIRES_ANALYSIS_BRANCH
  (severity error)
  (description "fix-hint substantive guidance: every default hint must contain the literal anchors `[A] Code issue` and `[B] Contract issue`, the trailing `Choose [A] or [B] before acting` prompt, and a pointer at the propose flow.")
  (uses-checker fix-hint-requires-analysis-branch))
```

> **Round 4 F-C-01 update.** The invariant historically declared above as
> `FIX_HINT_NOT_VAGUE` (severity `warning`) was renamed and promoted during
> Round 3 P1-2: shipping as `FIX_HINT_REQUIRES_ANALYSIS_BRANCH` at severity
> `error`. The structural check anchors on the canonical `[A] Code issue`
> and `[B] Contract issue` literals, requires a code-action verb (or a
> template-string interpolation) inside the `[A]` region, and rejects the
> hint when the `[B]` region misses the propose flow / proposals-dir
> pointer. The pre-rename name is preserved here as a historical pointer
> only — `docs/spec/cdl.md` is authoritative.

## 四、Phase B 实施 Sub-Agent 任务图

按 Round 1 综合的串行链分析，Phase B 实施任务图：

### B.1（TypeScript only，4-6 周）

```
[Week 1: 重构基础 — 必须按此顺序串行]
  T1.0  agent-0a  删除 multi-agent (含 normalize.ts + spec)
  T1.1  agent-0b  stage registry PR1 (双轨保留)
  T1.2  agent-0c  render-stele 拆分 + byte-stability snapshot test
  T1.3  agent-0d  typescript-shape → @stele/type-driven-evaluator 包提取
                  (rule_id 用真实约定 typedriven.{form}.{id})
  T1.4  agent-0e  profile.yaml 清理 (并行 T1.5)
  T1.5  agent-0f  architecture-runtime 精简 (并行 T1.4)
  T1.6  agent-0g  stage registry PR2 (主入口切换 + buildRawCheckReport 切换)
                  Self-check ratchet 必须 pass

[Week 2: 公共基础]
  T2.1  agent-1a  @stele/call-graph-core 包
                  (CallGraph types + NodeId disambiguator + extern-alias)
  T2.2  agent-1b  pattern matcher
                  (NodeId glob 跨语言一致)
  T2.3  agent-2   TS CallGraphExtractor
                  (含 methodResolutionHash cache + unresolved tracking)
  T2.4  agent-3   Violation schema 扩展 (priority/group_id/cross_rule)
                  (在 @stele/core 加新字段，向后兼容)

[Week 3: Trace-Based Policy]
  T3.1  agent-4a  structure-types.ts + structure-parse.ts 加 trace-policy form
                  (与 multi-agent 删除依赖串行)
  T3.2  agent-4b  @stele/trace-evaluator 包 (worklist 算法 + cross-rule emission)
  T3.3  agent-4c  check stage 注册到 registry
  T3.4  agent-4d  design-generator render + fix-hint grammar 验证
  T3.5  agent-4e  10+ fixtures (含 multi-violation scenario)

[Week 4: Type State]
  T4.1  agent-5a  structure-types.ts 加 type-state form + type-state-binding form
                  (依赖 T3.1)
  T4.2  agent-5b  @stele/type-state-evaluator 包
                  (local + annotated only, async 坦白文档)
  T4.3  agent-5c  TS phantom-type 推断 (含 inference_source 渲染)
  T4.4  agent-5d  check stage + 10+ fixtures

[Week 5: Effect System]
  T5.1  agent-6a  structure-types.ts 加 effect 4 forms
                  (依赖 T4.1)
  T5.2  agent-6b  @stele/effect-evaluator 包
                  (worklist + suppression CDL-only + unresolved fail-closed)
  T5.3  agent-6c  TS JSDoc 解析 + propagation_chain 渲染 (含 6 通用 tag)
  T5.4  agent-6d  check stage + 10+ fixtures
  T5.5  agent-6e  `stele explain effect <NodeId>` 命令

[Week 6: 收尾]
  T6.1  agent-7a  Stele 自身契约更新
                  (新增 ALL_EVALUATORS_COMPILE / STRICT_MODE_DEFAULT_IN_CI / FIX_HINT_NOT_VAGUE)
                  + 对应 checker_impls 函数
  T6.2  agent-7b  性能基准 (finance-guard + 10x 放大测试)
                  Target: B.1 MVP 性能预算 (中等项目 < 60s 全检查)
  T6.3  agent-7c  spec 文档 + 错误码表 + 用户指引
  T6.4  agent-7d  release tag v0.3.0-b1
```

### B.2（Python 加入，4-6 周）

```
Week 7-8:
  Python CallGraphExtractor (pyright daemon 集成)
  Python EffectAnnotationExtractor (decorator)
  Python TypeStateInferenceExtractor (typing.Generic + pyright)

Week 9-10:
  跨语言 conformance (TS + Python，10 fixture × 2 lang = 20 case)
  Python decorator suppress 安全化
  
Week 11-12:
  真实性能基准 (target: B.2 中等项目 < 30s)
  release tag v0.3.0-b2
```

### B.3（独立立项）

```
Go / Java / Rust CallGraphExtractor + evaluator 适配
- 每语言独立 sub-project
- 宿主语言子进程 / 二进制构建
- 跨平台分发（5 平台 binary）
- CI 矩阵扩展
- 不在 B.1/B.2 范围内
```

### 任务依赖图（文件级冲突）

```
structure-types.ts 必须串行：
  T1.0 → T3.1 → T4.1 → T5.1

check.ts 必须串行：
  T1.1 → T1.6 → T3.3 → T4.4 → T5.4

render-stele/ 必须串行：
  T1.2 → T3.4 → T4.4 → T5.4

可并行（无文件冲突）：
  T1.4 / T1.5
  T2.1-T2.4
  Week 3-5 的各 evaluator 包内部 sub-task
```

每条串行链单独 sub-agent（保证不冲突）。链间可并行。

## 五、实施验收标准

每个 sub-agent 完成时必须满足：

1. **`pnpm build` 全绿**
2. **`pnpm test` 全绿**（含 Phase B 新加 fixtures）
3. **`pnpm typecheck` 全绿**
4. **`node packages/cli/dist/index.js check` 全绿** —— Stele 自检
5. **覆盖率不下降**（每个新包带单元测试）
6. **byte-stability snapshot 不变**（refactor 任务专项）
7. **rule_id stability test 通过**（refactor 任务专项）

## 六、风险登记表

| 风险 | 缓解 | 监测 |
|---|---|---|
| TS CallGraphExtractor 性能不达 60s | Round 2 渐进性能预算 + worklist 算法 | Week 2 实测 finance-guard |
| Multi-violation 输出仍让 agent 困惑 | Round 2 schema 扩展 + 排序规则 | Week 3 fixture 验证 |
| Refactor 期间 stele check 自检失效 | 渐进 PR1-PR3 + ratchet test | 每个 PR 必须自检 pass |
| Python pyright daemon 集成复杂 | B.2 独立 sprint + 7 天工程量 buffer | Week 7 启动评估 |
| Strict default 让现有用户工程升级痛 | release notes 列出所有 breaking + migration guide | Pre-v0.3 alpha 测试 |
| Rule_id 命名空间分裂 | 统一 `typedriven.{form}.{id}` + Phase B 新形态同模式 | rule_id stability test |

## 七、最终设计稿验收

本文档（FINAL-SPEC.md）作为 Phase B 实施的**契约**。任何与本文档冲突的设计变更必须：

1. 走 propose 流程
2. 经过 maintainer 决策
3. 更新此文档
4. 触发新一轮 reviewer 审查

实施 sub-agent 不可单方面偏离此 spec。

## 八、给用户的最终建议

Phase B 设计**已经经过**：

- 8 个文件 ~7000 字详细设计
- 5 个独立 reviewer 两轮审查
- 8 个 critical issue + 6 个 critical security gap + 3 个 P0 UX issue 全部纳入修订
- 工程量重估（Round 1 reviewer B 数据 + 渐进性能预算）
- 实施 sub-agent 任务图（按文件级冲突分析）

**可以开始实施**。建议启动顺序：

1. 先确认 FINAL-SPEC 与你设想一致
2. 启动 Week 1 重构基础（T1.0-T1.6）—— 这是 Phase B 一切的前提
3. Week 2-5 各机制实施
4. Week 6 收尾 + release

每个 Week 的 sub-agent 完成后我亲自验证（按"不相信 sub-agent 承诺，只认事实"规则）。

每周一个 release-able milestone（可独立部署）。
