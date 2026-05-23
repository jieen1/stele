# 00 — Phase B 全局视角与决策记录

## 一、Phase B 想解决的问题

Stele v0.2 当前覆盖的契约面：

| 机制 | 表达什么 | 当前状态 |
| --- | --- | --- |
| `invariant` + checker | 值约束（"balance >= 0"） | 已实现 |
| `architecture` | 模块路径分层（A 能 import B） | 已实现 |
| `code-shape` (class/function/file/type/boundary) | 结构性（类必须有字段 X） | 已实现 |
| `core-node` + complexity | 聚合根复杂度阈值 | 已实现 |
| `branded-id` / `smart-ctor` | 类型层"值不可乱构造" | Phase A 刚补完闭环 |

**仍然无法表达**（agent 在合法 import / 合法类型下还有大量腐化空间）：

1. **谁能调谁的"调用链"约束**：DDD 的 `allow-dependency` 是二元（A 能 import B），不能表达"DB 访问必须经过 Repository"。
2. **实体状态依赖操作**：Order 在 Paid 状态不能 .addItem()。当前只能写成运行时 if 检查，长尾必然漏写。
3. **副作用边界**：UI 函数不能偷偷调网络。当前 layer 检查只看 import 文件，不看实际副作用。

这三个空白是 agent 长期独立维护时最容易腐化的位置——因为它们**不在静态文件路径层面**，而是在**函数行为层面**。

## 二、核心设计原则

### 原则 1：机械联锁，不要求人审

Agent 违约 → Stele evaluator → 自动拒绝。人不在热路径。

人介入的唯一场景：契约本身演化时通过 propose 流程（已在 v0.2 实现）。

### 原则 2：语言无关的 AST 静态分析层

不依赖宿主语言的类型系统能力。Stele 自己跑 AST 级别的检查。

各语言原生能做的（如 Rust 的 typestate、Java 的 sealed），Stele 顺手校验一致性（奖励性）。原生做不到的（如 Go 的 typestate），Stele 补位用 AST 校验。

### 原则 3：契约规则是模式级，非实例级

20-30 条 trace-policy 覆盖 5000 个方法。Agent 加新方法时**自动落入某条规则**被检查，不需要为每个新方法写新规则。

### 原则 4：通过重构提升系统设计

现有有问题的代码（multi-agent 死形式、render-stele 760+ 行混合、check.ts stage 硬编码）在 Phase B 落地时**同步重构**。重构是项目焕发新生的方式，不是因循守旧。

## 三、跨语言一致性策略

Phase B 三个机制的**公共基础**：调用图分析。把这个抽象做成跨语言一致的 trait（详见 `01-call-graph-extractor.md`）。各 backend 实现该 trait，Stele core 的三个 evaluator 都消费同一抽象。

| 机制 | 依赖 | 语言无关程度 |
| --- | --- | --- |
| Trace-Based Policy | CallGraph | 完全 |
| Type State | CallGraph + TypeStateAnnotation | 完全（语言原生支持是 bonus） |
| Effect System | CallGraph + EffectAnnotation | 完全 |

**Effect / TypeState 的"注解"在不同语言形态不同**（Rust trait / TS phantom / Go 注释 / Python decorator / Java annotation），但都规约到统一抽象层。

## 四、关键决策记录

### D-B-001：实施顺序（Round 1 修订）

依据：Round 1 发现 backend 已有 AST 能力前提不成立。重新切片为三波：

```
B.1 (4-6 周, TypeScript only):
  ├─ 重构基础（含 multi-agent 删除 + stage registry + render-stele 拆分）
  ├─ @stele/call-graph-core 抽象（types + pattern matcher + NodeId 规范）
  ├─ TS CallGraphExtractor
  ├─ Trace-Based Policy
  ├─ Type State (local + annotated only, async 不夸大能力)
  ├─ Effect System (suppression CDL-only, strict default)
  └─ 性能基准 + release tag v0.3.0-b1

B.2 (4-6 周, Python 加入):
  ├─ pyright daemon 集成
  ├─ Python CallGraphExtractor
  ├─ Python evaluator 适配
  ├─ TS+Python conformance suite
  └─ release tag v0.3.0-b2

B.3 (独立立项, 6-9 周):
  ├─ Go / Java / Rust CallGraphExtractor + evaluator
  ├─ 跨平台二进制分发
  ├─ CI 矩阵扩展
  └─ 不在 B.1/B.2 范围内
```

### D-B-002：不做 ADT exhaustiveness

用户决策：Rust / TS / Java / Python 都有原生支持；Go 唯一缺位但不强求。Phase B 不做。

### D-B-003：跨语言落地优先级（Round 1 修订）

**B.1**：TypeScript only。
**B.2**：Python 加入。
**B.3**：Go / Java / Rust（独立立项）。

**重要修正**：Round 1 reviewer B 发现 backend 0 行 AST 解析代码，"复用 backend 已有 AST 能力"前提**不成立**。Go/Java/Rust 每个 CallGraphExtractor 实际是 10-14 天（建宿主语言子进程 + IPC + 5 平台二进制分发），不是 4 天。所以 5 语言 CallGraph 移到 B.3。

B.1 / B.2 只交付 TS+Python，但**接口设计兼容未来 5 语言**（trait 不变，只是实现延迟）。

### D-B-004：删除 multi-agent 死形式

`agent` / `scope` / `inter-agent-contract` / `conflict` 四个 CDL form 当前有 parser 但**没有 evaluator**，是 v0.2 设计阶段的占位符。用户明确不需要 multi-agent 协同。Phase B 删除四个 form + 对应类型定义 + parser 分支。

### D-B-005：现有重构清单

详见 `05-refactor-cleanup.md`：
- 删除 multi-agent 死形式
- typescript-shape 统一为 type-driven-evaluator 包
- check.ts stage 拼装改 registry 模式
- render-stele.ts 按形态拆分（架构 / 核心节点 / 类型驱动 / 上下文映射 / Phase B 新形态）
- profile.yaml 字段清理（移除 ADT，明确 type_state / effect 字段）

### D-B-006：错误反馈给 Agent 的格式

Agent 违约时，Stele 输出必须包含：
1. 违例规则的 `rule_id`（如 `trace.PAYMENT_AUDIT.missing_predecessor`）
2. 违例位置（文件:行:列）
3. **当前实际调用链**（让 agent 看到自己写的代码是什么样）
4. **期望调用链**（required transit / predecessor / successor）
5. **修复提示**（自然语言指引）

这套统一格式让 agent 从错误信息直接推出修改方向，最大化自动修复率。详见 `02-trace-based-policy.md` §6 错误反馈规范。

### D-B-007：性能预算（Round 1 修订 — 分阶段渐进）

Round 1 reviewer B 用 ts-morph / typescript-eslint / SonarQube / pyright 真实基准校准后发现原预算偏差 3-10×。重写为分阶段渐进目标：

| 阶段 | 中等项目（1000 文件）| 大项目（10000 文件）| 增量 |
|---|---|---|---|
| B.1 MVP | < 60s | < 5 min | < 20s |
| B.2 基准后 | < 30s | < 3 min | < 10s |
| 长期目标（v0.4+）| < 10s | < 60s | < 5s |

**MVP 不承诺 v0.4 性能**。每阶段实测基准，逐步逼近。

实现策略：
- call graph 缓存进 `contract/.cache/call-graph.json`
- 新增 `methodResolutionHash` 跟踪 interface impl 变化（避免 polymorphism cache stale）
- 不动点算法用 **worklist + reverse postorder**（非教学版本，1-2 趟收敛）
- trace path enumeration cap = 10（覆盖现实调用链），超过 emit warning 不静默跳过

## 五、First-Wave Capability Matrix（单点说清楚每阶段能做什么）

为避免文档各处零散描述自相矛盾，所有"哪个机制 × 哪个语言 × 哪个阶段可用"以此表为权威：

| 机制 | TypeScript | Python | Go | Java | Rust |
|---|---|---|---|---|---|
| Trace-Based Policy | B.1 ✅ | B.2 ✅ | B.3 | B.3 | B.3 |
| Type State (lenient default) | B.1 ✅ | B.2 ✅ | B.3 (mode=off default) | B.3 (sealed only) | B.3 |
| Effect System | B.1 ✅ | B.2 ✅ | B.3 | B.3 | B.3 |
| CallGraphExtractor | B.1 ✅ | B.2 ✅ | B.3 | B.3 | B.3 |
| trace-policy template `extern:stripe::*` | B.1 ✅ (via extern-alias) | B.2 ✅ | B.3 | B.3 | B.3 |

各机制文档（02 / 03 / 04）的"5 语言模板"段引用此表。模板列出 Go/Java/Rust 时同时标注"B.3 可用"。

## 六、Choosing Between Trace-Based Policy and Effect-Policy（避免用户选择困境）

二者表达力部分重叠。Decision tree：

```
你想表达的契约是？

├─ "必经路径"（A 到 C 必须穿过 B）  
│   → trace-policy（精确指定中间层）
│
├─ "前置/后继顺序"（A 之前必须 X，A 之后必须 Y）
│   → trace-policy must-be-preceded-by / must-be-followed-by
│
├─ "禁止行为"（X 不能做 Y）
│   → effect-policy（不关心怎么到的，只看叶子节点）
│
├─ "调用合规链"（外部 API 必须经过指定服务 + 审计）
│   → trace-policy（多约束组合）
│
└─ 不确定 / 通用"不能调"
    → 默认 effect-policy（更鲁棒，传播自动）
```

**Violation Dedup**：当同一 violation 被 trace + effect 同时 catch（相同 function + 相同 root cause），evaluator 层 dedup：报一个，附加 `also_violates: [...]`。

## 七、Phase B 完成后的契约表达力

```
v0.2:   "balance >= 0"                                    # invariant
        "controllers/** 可以 import services/**"          # architecture
        "User 必须有 email 字段"                          # code-shape
        "UserId 不能是 raw string"                        # branded-id

Phase B 新增:
        "DB 访问必经 Repository → 业务无法绕过 ORM 抽象"  # trace-policy
        "Order 在 Paid 状态不能 addItem"                  # type-state
        "UI 函数不能调网络（任何 http.* effect 被禁）"    # effect-policy
```

完整覆盖：值 / 路径 / 结构 / 类型 / 调用链 / 状态 / 副作用 七个维度。
