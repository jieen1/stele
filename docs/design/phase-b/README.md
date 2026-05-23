# Phase B 设计稿

## 设计目标

在 Stele v0.2 已有 architecture / code-shape / type-driven (branded-id + smart-ctor) 基础上，新增三个语言无关的"机械联锁"机制 + 对现有架构进行精简重构：

1. **Trace-Based Policy**：声明合法调用链（必经路径 / 必前置 / 必后继 / 禁直达）
2. **Type State**：实体状态机契约化，状态依赖操作 AST 校验
3. **Effect System**：函数副作用集合传播，关键路径副作用隔离

**核心定位**：Stele 做语言无关的 AST 静态分析层，不依赖宿主语言的类型系统能力。5 语言 (TS / Python / Go / Java / Rust) 等价支持。

## 文档索引

| 文件 | 内容 |
| --- | --- |
| [00-overview.md](00-overview.md) | 全局视角 / 决策记录 / 跨语言策略总览 |
| [01-call-graph-extractor.md](01-call-graph-extractor.md) | 跨语言基础抽象：CallGraphExtractor + EffectAnnotationExtractor + TypeStateInferenceExtractor |
| [02-trace-based-policy.md](02-trace-based-policy.md) | 机制 1：trace-policy CDL form + evaluator + 5 语言 AST 实现路径 |
| [03-type-state.md](03-type-state.md) | 机制 2：type-state CDL form + AST 模式校验 + 5 语言原生/非原生支持 |
| [04-effect-system.md](04-effect-system.md) | 机制 3：effect-declaration + effect-policy + 集合传播算法 |
| [05-refactor-cleanup.md](05-refactor-cleanup.md) | 现有系统重构清单（删除死形式、check stage 注册化、typescript-shape 统一） |
| [06-cdl-extensions.md](06-cdl-extensions.md) | CDL 新增 form 总清单 + grammar 改动 + 错误码 |
| [07-cross-language-strategy.md](07-cross-language-strategy.md) | 5 语言适配优先级 + backend trait 接口 + 各语言落地路径 |

## 不做范围

- ❌ ADT exhaustiveness（用户明确选择不做）
- ❌ 量化腐化分数 / SLO（用户：先做功能）
- ❌ 治理元契约（用户：契约 agent 不能改，不需要元契约保护）
- ❌ 任何要求"人审"的设计（用户：违背 agent 独立维护核心思想）

## 实施序列（Round 1 综合后重新切片）

**B.1（4-6 周，TypeScript only）**：证明三机制能跑通 + 性能能 take + 错误反馈能用。
**B.2（4-6 周，加入 Python）**：pyright daemon 集成 + 真实性能基准。
**B.3（独立立项，6-9 周）**：Go / Java / Rust CallGraphExtractor + evaluator 适配。

每阶段顺序：重构基础 → 公共抽象 → Trace → Type State → Effect → 收尾。每步 sub-agent 实施 → 我验证 → commit → push → 下一步。

详细切片：见 `00-overview.md` §六 + `round-1-synthesis.md` §五。

## Round 1 综合（已完成）

- 3 独立 reviewer (A 架构/跨语言 / B 可行性/工程量 / C Stele 契合/重构) 反馈汇总：`round-1-synthesis.md`
- 8 个 Critical Issue + 15 个 Major Concern 已纳入修订
- 关键裁决：采用 B 的"TS-only 起步"方案（CI-5 致命前提错误：backend 0 行 AST 解析能力）

## 与已有 Stele 的关系

- 复用：5 个 backend 已有 AST 解析能力（codegen 用）
- 扩展：在每个 backend 加 call-graph 提取器 trait
- 重构：把 typescript-shape 统一为 type-driven-evaluator 模块（容纳新 branded-id + smart-ctor + type-state + effect）
- 注册化：check.ts 的 stage 拼装从硬编码改为 stage registry
