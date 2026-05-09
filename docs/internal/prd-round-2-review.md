# PRD Round 2 Review — Synthesis

> 日期: 2026-05-08 | 状态: 完成 | 审查者: 3 个独立子 Agent
> 上一轮: [Round 1 综合](prd-round-1-review.md)

经过 Round 1 的大幅裁剪与重写，v1.0 PRD 由 3 个新独立子 Agent 重新审查。本轮目标：验证 Round 1 决定落实，发现新引入的问题，再做最终化前的最后一轮收紧。

## 1. 审查者构成

| Agent | 关注点 | 主要输出 |
| --- | --- | --- |
| **A — 战略反虚饰** | 审查 v1.0 是否仍含虚饰；新增 EP 是否真正承载使命 | 5 项更激进的裁剪建议；3 项 Phase 排序改造 |
| **B — 可行性 & 技术正确性** | 接口、文件路径、行数、数学是否与代码一致 | 5 项关键事实错误（操作符数学、行数、路径、EP14 测试数）；EP07/EP08 技术缺口 |
| **C — 跨文档一致性** | Phase 0 → 1 → 2 是否互相自洽，与 README/roadmap 是否对齐 | 操作符算术不一致；docs/README/roadmap 仍有 stale 引用；Phase 3 触发条件一项偏弱 |

## 2. 三个 Agent 一致的关键事实错误

### 2.1 操作符计数算术不自洽（A、B、C 都独立发现）

PRD v1.0 中**五个不同的数字在流传**：

| 出现位置 | 数字 | 含义不清 |
|---|---|---|
| Phase 1 §1.1 | "51 → 71" | "71" 来源不明 |
| Phase 1 EP04 §5.2.6 | "51 + 18 + 5 + 5 + 1 + 3 = 83" | 与 §5.2.x 详列不符 |
| Phase 1 §11.2 | "51 + 19 = 70" | 与 §5.2.6 矛盾 |
| Phase 2 §1.1 | "70 → 76" | "70" 来源不明（未声明 Phase 1 末态）|
| Phase 2 §6.4 | "76 个操作符" | |

**调和**（采用 C 的清算）：

| Phase 边界 | 注册总数 | 用户面（去 alias、去内部 group-by）|
|---|---|---|
| Phase 1 起 | 51 | 51 |
| Phase 1 末 | 51 + 18 (EP04 新) + 1 (filter alias) = **70** | 51 + 18 = **69** |
| Phase 2 末 | 70 + 6 (EP13) = **76** | 69 + 6 = **75** |

`group-by` 注册但内部使用，不计用户面。`filter` 注册为 `where` 的 alias 计 +1 注册但不计用户面。

### 2.2 EP14 "8 个 conformance test" 是错的（B、C 独立发现）

`packages/claude-code-plugin/tests/` 实际有 **6 个**测试文件：

```
hooks-config.test.ts
lifecycle-context.test.ts
observation-hook-extended.test.ts
observation-hook.test.ts
pre-tool-protect.test.ts
stop-validate.test.ts
```

PRD §7.2.3 与 §7.5 的 "8 个 conformance test" 是错的；应改为"`packages/claude-code-plugin/tests/` 现有所有测试"以避免数字漂移。

### 2.3 Phase 0 §5.1 行数引用过时（B 发现）

代码已重构，PRD 引用的旧行数在文件实际：

| PRD 声称 | 实际（post-refactor）|
|---|---|
| `validator/structure.ts` ~1700 行 | **72 行**（已拆分）|
| `validator/structure-code-shape.ts` 不存在 | 524 行（拆分产物）|
| `validator/structure-invariant.ts` 不存在 | 316 行 |
| `validator/structure-parse.ts` 不存在 | 329 行 |
| `validator/structure-scenario.ts` 不存在 | 392 行 |
| `validator/structure-types.ts` 不存在 | 286 行 |
| `validator/structure-error.ts` 不存在 | 14 行 |
| `errors/SteleError.ts` ~120 行 | **15 行** |
| `baseline/io.ts` ~200 行 | **83 行** |
| `loader/loadContract.ts` ~300 行 | **87 行** |

Phase 0 §5.1 测试覆盖目标必须按新文件结构重写。

### 2.4 路径漂移（B、C 都发现）

PRD §2.2.9 引用 `packages/cli/src/init.ts:11`；实际路径是 `packages/cli/src/commands/init.ts:11`。`packages/cli/src/init.ts` 不存在。

### 2.5 EP10 (VS Code) 引用 Phase 0 W0.1 的不存在前置（C 发现）

PRD prd-phase-2.md:367 写 "VS Code Marketplace publisher 账户在 Phase 0 W0.1 已设置"。但 Phase 0 §4.2.4 仅设置 GitHub Marketplace publisher，**不**包括 VS Code Marketplace（Microsoft）publisher。需要修正。

## 3. 技术正确性缺口（B 发现）

### 3.1 EP05 哈希链不完整

PRD §6.3.2 计算 `transitive_hash` 仅含 `own_hash + sort(transitive_hash[deps])`。**缺**：

- `operator_registry_hash`：后端 bug-fix 释放可能在 `stele_version` 不变时改变 emit
- `normalize()` 未指明等同于 `@stele/core` 现有的 `normalizeContract`

### 3.2 EP07 trace 机制有多个未规约项

- `STELE_TRACE=1` 通过 pytest spawn 传递的环境变量未规约
- pytest-xdist 并行写 `eval-trace.jsonl` 的并发策略未规约
- 缺"trace 模式破坏 byte-equal 是 by-design，CI gate 不依赖它"明文 carve-out
- baseline-suppressed violation 是否仍产生 trace 未规约

### 3.3 EP08 (workspace) 与 BackendRegistry 交互未规约

Phase 0 W0.3 设计的 `BackendRegistry` 是单例。多 project 工作区中各项目可能 `targetLanguage` 不同（Python + TypeScript 共存），但 PRD 没说 registry 如何同时持有多个 backend。同时 `stele init --workspace` 与 `stele init --project <id>` 流程缺失。

## 4. 战略再裁剪（A 推动）

A 进一步推动了几项裁剪，超越 Round 1：

| 议题 | A 的建议 | 决策 |
|---|---|---|
| EP07 `eval-trace.jsonl` 文件 | **删除文件格式**，把 `failure_witness` 嵌入 `ViolationReport.cause` | **采纳**：确定性更好，无新工件，无 pytest-xdist 并发问题 |
| EP08 `stele.workspace.json` | **替换为 `--recursive` 标志**：v0.1 已支持每子目录配置 | **采纳**：保留性更好，新文件格式留待真实用户请求 |
| EP12 stele report --format json | **完全丢弃**：无命名消费者；`stele check --json` + `manifest.json` 已覆盖 | **采纳**：移到 Phase 3 候选，触发条件"首次书面用户请求" |
| EP13 `entries` 操作符 | **延后**：无 lambda 支持时是死代码 | **采纳**：从 EP13 移除 |
| EP14 (Cursor / agent-hooks) | **提到 Phase 1**：Cursor 是最大 AI IDE，竞争窗口不能等 5 个月 | **采纳**：Phase 1 新增 EP09 |
| Phase 0 单独 phase | **折叠为 Phase 1 W0**：2 周不够格做一个 phase | 不采纳：保留分阶段以维持 gating 纪律 |
| EP09 Go 后端 | **延后到 Phase 3**：AI 编码 Go 受众小于 Java | 不采纳：Go 在云基础设施有清晰早期采用者；保留 |

## 5. v2.0 重组结构

### Phase 0（不变）

W0.1 + W0.2 + W0.3 + W0.4，约 2 周。线数表更新；W0.1 扩展含 VS Code Marketplace 占名。

### Phase 1（9 个 EP，10-12 周）

| # | EP | v1.0 → v2.0 变化 |
|---|---|---|
| EP01 | TypeScript 后端 | 不变 |
| EP02 | GitHub Action + PR comment | 不变 |
| EP03 | pre-commit | 不变 |
| EP04 | 操作符批次 1 | 计数修正：51 + 18 新 + 1 alias = 70 注册 |
| EP05 | 增量生成 | 加 `operator_registry_hash`；pin `normalizeContract` |
| EP06 | Code Shape Python 补全 | 不变 |
| EP07 | stele why 评估解释 | **重大变更**：删除 eval-trace.jsonl 文件格式；改为嵌入 `ViolationReport.cause.failure_witness`；删除 `--evaluate` 子模式 |
| EP08 | 多项目支持 | **重大变更**：删除 `stele.workspace.json`；改为 `stele check --recursive` 标志 |
| EP09 | agent-hooks SDK + Cursor | **NEW**（从 Phase 2 EP14 提升）|

### Phase 2（4 个 EP，8-10 周）

| v2.0 # | EP | v1.0 → v2.0 变化 |
|---|---|---|
| EP10 | Go 后端 | 重编号（v1.0 EP09）；加显式 W0.3 引用 |
| EP11 | VS Code 扩展 MVP | 重编号（v1.0 EP10）；删除"publisher 在 W0.1 已设置"引用，改为本 EP 启动时设置 |
| EP12 | stele impact | 重编号（v1.0 EP11）；下修：仅含 direct + uncovered + orphan，删除 indirect impact |
| EP13 | 操作符批次 2 | 数量从 6 降到 5（删除 `entries`）；总数 70 + 5 = **75 用户面（76 注册）** |

**丢弃**：v1.0 EP12 (stele report JSON)、v1.0 EP14 (now Phase 1 EP09)。

### Phase 3 候选（信息性）

新增项：

- HTML report / Prometheus / `stele report --format json`（v1.0 EP12 移到这里）
- 多项目工作区文件格式（`stele.workspace.json` 移到这里，触发"首次书面用户请求"）
- EP07 完整 evaluation trace（多步轨迹文件，触发"用户报告 single-step witness 不够用"）

修正：v0.1 草稿 Self-Healing 触发条件改写为可验证条件。

## 6. 非 PRD 文档的同步修正

C 发现的清单：

1. **`docs/README.md`**: 添加 "Phase plans (refined v2.0)" 段落，列 prd-phase-0/1/2.md
2. **`docs/strategy/roadmap.md`**: 顶部添加 "实施计划见 prd-phase-{0,1,2}.md (v2.0)" 注；标注 "46 操作符" 为历史基线
3. **`README.md`**: 文档表格添加"Phased plans"行
4. **`docs/spec/cli-output.md`** (NEW): 创建独立的 CLI JSON 输出 schema 文档；`stele check --json`、`stele why --json`、`stele impact --json` schema 都放这里（不放 CDL spec）

## 7. 用户决策记录（Round 2）

| 议题 | 选项 | 决定 |
|---|---|---|
| EP07 trace 机制 | **嵌入 ViolationReport.cause** / 保留文件 | **嵌入** |
| EP08 多项目 | **`--recursive` 标志** / 保留 workspace.json | **`--recursive` 标志** |
| EP12 JSON 报告 | **丢弃** / 保留 | **丢弃** |
| EP14 阶段 | **提到 Phase 1** / 留 Phase 2 | **提到 Phase 1** |

## 8. 后续动作

1. ✅ 保存本审查记录到 `docs/internal/prd-round-2-review.md`
2. ✅ 重写 prd-phase-0.md（行数表更新；§4.2.5 VS Code Marketplace 准备）
3. ✅ 重写 prd-phase-1.md（EP07/EP08 重大变更；新增 EP09；EP04 算术修正）
4. ✅ 重写 prd-phase-2.md（重编号；删除 EP12；删除 EP14；EP13 删 `entries`；EP12 stele impact 删 indirect）
5. ✅ 创建 docs/spec/cli-output.md
6. ✅ 更新 docs/README.md / docs/strategy/roadmap.md / README.md
7. ✅ Round 3 聚焦事实正确性 spot-check（1 个独立 Agent，3 个小问题已修）
8. → 拆解为详细设计文档（next）

## 9. Round 3 spot-check 修正（2026-05-08）

经独立 fact-check Agent 验证，v2.0 主体 15/18 项合格；3 个小问题已修：

| # | 问题 | 修正 |
|---|---|---|
| 1 | EP04 §5.3 末态 "= 71" 与其他位置 "= 70" 不一致 | 重新解读：`group-by` 完全延后到 Phase 3（不仅是"内部使用"），Phase 1 末态钉死 70 注册 / 69 用户面 |
| 2 | Phase 2 引用 "W0.1.5" 但 Phase 0 无此编号 | Phase 2 引用改为 `Phase 0 §4.2.5` |
| 3 | Phase 0 acceptance "validator/structure.ts ≥ 60%" 但该文件已成 72 行 shim | 改为 "validator/structure-*.ts 5 拆分文件聚合 ≥ 60%" |

至此 v2.0 PRD 套件**事实正确**，可作为详细设计文档拆解的基础。
