# PRD Round 1 Review — Synthesis

> 日期: 2026-05-08 | 状态: 完成 | 审查者: 4 个独立子 Agent

四个独立子 Agent 平行审查 `prd-phase-1.md` 和 `prd-phase-2.md`，分别从可行性/完整性、战略价值/反虚饰、代码库一致性、排期/风险四个维度出发。本文档是综合记录与决策依据。

## 1. 审查者构成

| Agent | 职责 | 主要输出 |
| --- | --- | --- |
| **A — 可行性 & 完整性** | 检查每个 EP 的接口、边界、技术决策、估时、可验证性 | 13 个 EP 的具体技术缺口清单，10 大跨 EP 问题 |
| **B — 战略价值 / 反虚饰** | 按 Stele 三层防护核心论点过滤每个 EP，找出虚饰功能与缺失的真正高价值功能 | 每 EP "保留/裁剪/延后/丢弃"判定，5 个缺失功能候选 |
| **C — PRD vs 代码库一致性** | 用代码事实核对 PRD 中引用的接口、类型、文件路径、操作符数 | 10 项检查中 8 项漂移，逐行修订清单 |
| **D — 排期 & 风险** | 评估关键路径、隐藏依赖、估时现实性、向后兼容、并行化空间 | 关键路径分析、Top 5 隐藏风险、硬性建议 |

## 2. 关键发现（4 个 Agent 一致）

### 2.1 必须裁剪的 EP

| EP | 裁剪决定 | 多 Agent 一致理由 |
| --- | --- | --- |
| **EP08 自我修复契约** | **丢弃** | (A) AI 集成完全未指定，"80% 准确率"无评测集，无法可验证；`stele propose` 当前是 invariant-add-only，EP08 所述"通过 propose 流程"的修复机制不存在；AST diff 库未指定。(B) 与 Stele 核心命题矛盾——架构白皮书明文写"AI 不可信赖，只能靠结构强制"，EP08 把 AI 插入到违约消解循环里。(D) 真实成本 6-8 周 + 开放式评测期，估算 3-4 周严重低估。|
| **EP11 插件系统** | **丢弃** | (A) **架构性破损**：插件可注册 `OperatorSpec` 但**没有机制**提供各后端的翻译处理器，运行时会以 `E0601 Unsupported operator` 失败；无安全模型，"沙箱"未定义。(B) 当前没有任何第三方插件作者；插件 API 一旦发布就成永久包袱。(D) 真实设计成本 8-12 周。|
| **EP10 仪表板** | **延后到 Phase 3，仅保留 JSON 输出** | (A) Trends 需要持久化历史，存储未设计；`since` 字段不存在于 `InvariantDeclaration` 中——需要 CDL 语法变更。(B) 目标用户（小型 AI 编码团队）不会用 HTML 报告；这是企业功能蔓延。`stele report --format json` 是少量增量价值。|
| **EP12 Rust 后端** | **延后到 Phase 3，与 Java 互换** | (B) AI 编码 Rust 受众小于 Java；Phase 2 已经超载。(A) `proptest` 是另一种范式被悄悄塞入，应单独 EP。(D) 4-6 周对 Rust 类型系统约束过乐观；真实成本 6-8 周（含 scenario）。|
| **EP07 VS Code 扩展** | **降范围至 MVP** | (A) LSP 范围未定（"LSP 客户端或内建"是 4 倍范围差）；TextMate + LSP + 命令面板 + 诊断 + Tree View 五件套真实成本 8-10 周不是 4-6 周；Marketplace 发布与 npm 不同链路，`publish-npm.mjs` 不处理。MVP = 语法高亮 + 一个命令 + 内联诊断（2-3 周）。|

### 2.2 必须修正的事实错误（4 个 Agent 至少 2 个独立发现）

| 错误 | 真实情况 | 来源 |
| --- | --- | --- |
| 操作符数 "46+" | 注册表实际 **51 个**；CDL 规范仅记 44 个；EP04 实际新增 **19 个**而非"14+" | C |
| `LanguageBackend` 接口名 `GenerateConfig` | 真实是 `GenerationConfig`；`supportFiles?` 是**可选**；`generate` 是**同步**的；EP11 例子里的 `async` 与真实接口不符 | A, C |
| `stele.config.json` 字段 `backend`/`framework`/`outputDir` | 真实字段 `targetLanguage`/`testFramework`/`generatedDir`；EP01 当前如实施会无法加载 | A, C |
| `.stele/cache/hash-manifest.json` (camelCase) | 真实约定 `contract/.manifest.json` (snake_case)；新缓存路径应为 `contract/.cache/`；`.stele/violations.json` 同问题 | A, C |
| 测试数 "989+" | 实际运行时 **861** 个测试 | C |
| `__init__.js` 在 EP01 输出列表 | Python 习惯泄漏；Node.js 无此约定，应删除 | A, C |
| EP02 退出码"3 = 有违约" | 退出码 3 = manifest 校验失败；违约通过 violation report 通道 | A |
| EP02 `violation.detail.line` | 真实结构是 `scope_paths: string[]` + 可选 `location?: ViolationLocation`；该字段不存在 | A |
| EP05 增量生成"对每个 .stele 文件计算哈希" | **架构性错误**：忽略 import 依赖图，导致被 import 的文件改动后依赖文件的生成测试陈旧 | A |
| `LanguageBackend` 注册机制 | 当前在 `cli/src/commands/generate.ts:75-82` **硬编码**抛错 on non-python；EP01/EP06/EP12 都没说替换它 | A |
| 漏掉 roadmap §4.1.6 | "Code Shape Python 后端补全"是 P1 in Phase 1，PRD 完全缺失 | C |
| Phase 1 与 Phase 2 操作符 `filter` 别名 | EP13 把 `filter` 描述为 `where` 的别名——但 `where` 绑定标识符，`filter` 不绑定，**不是别名** | A |

### 2.3 跨语言操作符语义未确定（A、C）

每一项都是一行规范决定，遗漏即是多周调试地狱：

- **正则方言**：Python `re.search` 子串语义 vs JS `RegExp.test` 完整匹配；不同的 `\d` Unicode 行为；不同的回引用支持
- **`round` 取整模式**：banker's rounding (Python 3) vs round-half-away-from-zero (JS `Math.round`)
- **`mod` 负数**：Python 取除数符号 vs JS/C/Go 取被除数符号 vs Rust 双语义
- **`split` 空分隔符**：Python `ValueError` vs JS `[]` vs Go panic
- **`percentile` 插值方法**：NumPy 9 种方法 + 3 种行为模式
- **JSONPath 方言**：Goessner / RFC 9535 / jq / JMESPath 全部不同
- **路径访问**：Python 现行 `dict[k]` → `getattr` → `getattr(snake_case)` 三层 fallback；TS/Go/Rust 后端是否要复刻？kebab→camelCase 还是 kebab→snake_case？路径不存在时是抛错还是 None？

### 2.4 时间估算系统性 50–100% 偏低（A、D）

| EP | PRD 估算 | 现实估算（A/D） |
| --- | --- | --- |
| EP01 TypeScript 后端 | 2-3w | **3-4w**（需要复刻 scenario/checker runtime ~120 行 Python 代码） |
| EP04 操作符批次 1 | 1-2w | **2-3w**（19 个操作符 × 2 后端 + runtime + 测试 = 至少 60 个 PR 单元） |
| EP06 Go 后端 | 3-4w | **4-6w**（Go 静态类型 + scenario） |
| EP07 VS Code 扩展 | 4-6w | **8-10w**（含 LSP）；MVP **2-3w** |
| EP08 自我修复 | 3-4w | **6-8w + 开放式评测**（如保留） |
| EP11 插件系统 | 4-6w | **8-12w 仅设计** |

Phase 1 真实预算: **10-12w 单 FTE / 6-8w 双 FTE**（PRD 标 8w）。
Phase 2 真实预算: **24-32w 单 FTE / 14-18w 双 FTE**（PRD 标 16w）。

PRDs 必须显式声明团队规模假设。

## 3. 关键路径与隐藏依赖（D）

### 3.1 W0 前置（PRD 完全缺失）

- **npm 发布 v0.1**：EP02（GitHub Action）的 `npm install -g @stele/cli` 假设包已发布。当前仅 tarball 工作流。Marketplace 拒收依赖私有 tarball 的 Action。
- **测试债**：`@stele/core` 当前覆盖率约 35%，`structure.ts` (1700 行) / `SteleError.ts` / `baseline/io.ts` 直接单测为 0。在此之上加 EP01/EP04 是把新代码堆在未验证的基座上。
- **`LanguageBackend` 注册机制**：`cli/src/commands/generate.ts:75-82` 硬编码 `if (targetLanguage !== "python") throw`。所有后端 EP 都依赖这个被替换为注册表，但 PRD 没有任何 EP 拆出这个工作。
- **跨后端一致性测试套件**：EP01 验收要求"TS 后端与 Python 后端对同一 CDL 文件的行为一致"，但没有 fixture 集、没有比对工具、没有"一致"的定义。这必须先于 EP01 存在。

### 3.2 跨阶段相互依赖

- EP08 与 EP09 共享 git diff → AST diff → invariant 匹配管道；PRD 视它们为独立 epic，是浪费。EP08 丢弃后，EP09 应单独构建该共享层。
- EP04（操作符批次 1）与 EP01/EP06 强耦合：每个新操作符要在 registry + 类型校验 + Python runtime + TS runtime + Go runtime（如有）+ 跨后端测试落地。PRD §5.3 列了 5 步但只字未提 runtime 修改。

### 3.3 Top 5 隐藏风险（D，按可能性 × 影响排序）

1. **EP08 AI 集成未定义 → Phase 2 W15-16 滑期 4-6 周**（90% 可能）—— 通过裁剪 EP08 直接消除。
2. **npm 包未发布 → EP02 不能上 Marketplace**（80%）—— 通过 W0 npm 发布解决。
3. **操作符 × 后端组合数被低估 → EP04 滑期 1-2 周**（70%）—— 通过裁剪操作符数 + 重估解决。
4. **`structure.ts` 在 EP01 中被回归破坏未被测试发现**（50%）—— 通过 W0 测试债冲刺解决。
5. **EP07 LSP 范围爆炸**（60%）—— 通过 MVP 范围裁剪解决。

## 4. 缺失的高价值功能（B）

> 反虚饰审查者明确指出："这些会比 EP08/10/11 加起来更能加固三层防护模型。"

1. **`stele why` 增强（评估解释模式）** —— 当 `(forall accounts (gt balance 0))` 失败时，显示**哪个 account**、**哪个评估步骤**、**实际值是什么**。OPA Rego 的 `explain` 是市场最常被抄的特性。Stele 操作符调度集中在 `translate.ts`，加 explain 模式机械上直接。预算 2-3 周。
2. **Cursor / Continue.dev / 通用 agent-hooks SDK** —— competitive-analysis 明确把这列为护城河延展首选。Phase 2 花 4-6 周做 VS Code 主要复刻 Claude Code 插件，却忽略 Cursor（最大 AI IDE）。`@stele/agent-hooks` SDK + 顶 3 个 agentic IDE 适配器 ≥ Phase 2 一半价值。预算 3-4 周。
3. **真实 GitHub PR 评论** —— EP02 的 `::error` 注解是底线；团队真正想要的是**单个 live-updating PR comment** 包含违约分组、`stele why` 链接、抑制指令、`stele baseline-update` 命令。`gh pr comment` 管道，~1 周。
4. **Monorepo / workspace 支持** —— roadmap 提了跨语言契约但 PRD 对 monorepo 沉默。当前 `stele.config.json` 单根（`architecture.md` 暗示一项目一 CLI）；TS monorepo（`apps/`, `packages/`, 各自 tsconfig）是现代 TS 受众的硬前置。EP01 启用的受众正是这群人。预算 2 周。
5. **`stele audit`（陈旧不变量审计）** —— 类比 Vulture 死代码检测：从未失败过的 invariant 是陈旧/空洞/错误的。`stele audit` 用现存的 `stele check --json` 历史输出实现。预防真实团队最终会创建的"1000 个都断言 `(eq 1 1)`"失效模式。1-2 周。

## 5. 用户决策记录

| 议题 | 选项 | 用户决定 |
| --- | --- | --- |
| Phase 2 裁剪 | 保守 / 中度 / **激进** | **激进**：丢 EP08/EP10/EP11，延 EP12，降 EP07 至 MVP，新增 4 项缺失功能 |
| Phase 0 | **添加** / 内联 / 跳过 | **添加** Phase 0：npm 发布、测试债冲刺、后端调度重构、跨后端一致性套件 |
| 缺失功能 | （多选） | `stele why` 增强、monorepo 支持、PR live-updating 评论、Cursor/agent-hooks SDK |
| 输出格式 | **就地编辑 PRD** / 保留原版+v2 | **就地编辑** + 本审查记录归档到 `docs/internal/` |

## 6. 后续动作（已分配为任务）

1. ✅ 起草 `docs/prd-phase-0.md`（新）
2. ✅ 重写 `docs/prd-phase-1.md`（裁剪 + 修正 + 加 EP06/EP07/EP08）
3. ✅ 重写 `docs/prd-phase-2.md`（丢 EP08/EP10/EP11，延 EP12，降 EP07 MVP，加 EP14 Cursor）
4. → Round 2 PRD 评审：4 个独立子 Agent 重新审查
5. → 如有问题，再次细化
6. → 拆解为详细设计文档（`docs/design/phase-X/`）
7. → Round 1 设计文档评审
8. → 细化设计文档
9. → Round 2 设计文档评审

## 附录：4 个 Agent 完整原始报告

> 原始 transcript 保存在 `/tmp/claude-1002/-home-bot-project-stele/.../tasks/` 临时目录，会随 session 清理。本文是经过综合的可执行版本。如需追溯原始证据，相关代码引用都已含 file:line。
