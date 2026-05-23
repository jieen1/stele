# 05 — 现有系统重构与清理

> "系统是在重构中焕发新生的，不要因循守旧。"

Phase B 落地时，把现有系统这些已知问题一并清理。每项重构都和 Phase B 实施 sub-agent 的对应子任务**捆绑**——不是独立的"重构 sprint"。

## 一、删除 multi-agent 死形式

### 现状

`packages/core/src/validator/structure-types.ts` 定义了 4 个 CDL kind：
- `agent`
- `scope`
- `inter-agent-contract`
- `conflict`

它们的 parser 在 `structure-agent.ts`，但**没有任何 evaluator**。Stele check 不会校验任何 agent 相关规则。这是 v0.2 设计阶段的占位符。

### 决策（来自 Phase B 讨论）

用户明确表示不需要 multi-agent 协同：
- 单 agent 维护就是项目核心场景
- 多 agent 协同是不同的产品方向

→ **删除** 4 个 form 的全部代码（parser / types / TOP_LEVEL_DECLARATIONS 条目 / uniqueness 检查 / Contract 类型字段）。

### 影响范围（Round 1 修订：补全 normalize.ts + spec）

```
删除：
  packages/core/src/validator/structure-agent.ts   (整个文件)
  
修改：
  packages/core/src/validator/structure-types.ts
    - 删除 AgentDeclaration / ScopeDeclaration / InterAgentContractDeclaration / ConflictDeclaration
    - 从 TOP_LEVEL_DECLARATIONS 移除 4 项
    - 从 ContractFile / Contract 删 agents/scopes/interAgentContracts/conflicts 字段
  
  packages/core/src/validator/structure-parse.ts
    - 删除 4 个 switch case
    - 删除对应 push 操作
  
  packages/core/src/validator/uniqueness.ts
    - 删除 agent / inter-agent-contract uniqueness 检查
  
  packages/core/src/validator/structure.ts
    - 删除 4 个 re-export
  
  packages/core/src/index.ts
    - 删除 4 个 public exports
  
  ★ packages/core/src/normalizer/normalize.ts (Round 1 reviewer C 发现，原清单遗漏)
    - 删除 lines 28-31, 51-72, 233, 253 处对 agent/scope/inter-agent-contract/conflict 的处理
    - 这 4 form 之前虽无 evaluator 但参与 normalized output 和 contract diff
  
  ★ docs/spec/cdl.md (Round 1 reviewer C 发现)
    - 删除 §286-362 multi-agent 章节
    - 在 deprecation history 增加："原 v0.2 spec 错误声称 MCP validate-edit 集成
      这些 form，实际从未实现。Phase B 移除该章节并修正历史误述。"
  
  packages/core/tests/
    - 删除所有相关 fixture 和 assertion（structure-types fixtures, normalize fixtures）
```

### 验证

- `pnpm typecheck` 通过
- `pnpm test` 通过
- `stele check`（项目自身）通过
- `git grep -i "AgentDeclaration\|ScopeDeclaration\|InterAgentContract\|ConflictDeclaration"` 应只有删除痕迹

### 工程量

0.5 天。

---

## 一.A、Self-Bootstrapping Safety（Round 1 修订）

重构 stage registry / render-stele 都涉及 Stele 自身契约的执行链路。重构期间任何错误都可能让 `stele check` 自检失效而 CI 仍绿。**自举系统重构必须有元检查**。

### 元检查 1: Registry Completeness Test

新增 `packages/cli/tests/stage-registry-completeness.test.ts`：

```typescript
import { CHECK_STAGES } from "../src/commands/check-stages-registry.js";

const REQUIRED_STAGE_IDS = [
  "generated", "protected", "toolchain", "code-shape",
  "architecture", "complexity", "type-driven",
  // Phase B 加入后：
  "trace", "type-state", "effect",
];

it("CHECK_STAGES 必须包含所有已声明的 stage id", () => {
  const presentIds = CHECK_STAGES.map(s => s.id);
  for (const required of REQUIRED_STAGE_IDS) {
    expect(presentIds).toContain(required);
  }
});
```

CI 跑此测试。任何 stage 被遗漏即 fail。

### 元检查 2: Stele Self-Check 在 Refactor PR 必须绿

每个重构 PR 的 CI 中加入 step：

```yaml
- name: Stele self-check after refactor
  run: |
    pnpm build
    node packages/cli/dist/index.js check
    # exit 0 强制，否则 PR block
```

### 元检查 3: 渐进式重构（不允许"all in one go"）

stage registry 重构按三个 PR 顺序提交：

- **PR1**：加 CHECK_STAGES registry + runAllStages，**保留**原有的硬编码（双轨）。元检查 1 加入。
- **PR2**：check.ts 主入口改用 runAllStages 调用 registry，删除硬编码。元检查 2 必须绿。
- **PR3**：清理双轨遗留代码。

任何一步失败可独立回滚，最小化"重构期间自检失效"窗口。

### 元检查 4: byte-stability snapshot for render-stele

详 §四。

## 二、check.ts stage 拼装改 Registry 模式

### 现状

`packages/cli/src/commands/check.ts` 当前手工拼装 8 个 stage：

```typescript
reports.push(buildGeneratedStageReport(context, "check"));
reports.push(await buildProtectedStageReport(context, ...));
reports.push(await buildToolchainStage(context, ...));
if (codeShapeContext.contract.codeShapes.length > 0) {
  reports.push(await buildCodeShapeStageReport(...));
}
reports.push(await buildArchitectureStage(context, ...));
reports.push(await buildComplexityStage(context, ...));
reports.push(await buildTypeDrivenStage(context, ...));
// Phase B 还要加 trace / typestate / effect
```

Phase B 要加 3 个新 stage，硬编码会变得很长。改成 registry：

### 重构方案

```typescript
// packages/cli/src/commands/check-stages-registry.ts (NEW)

export interface CheckStage {
  id: string;                  // "generated" | "protected" | "trace" | ...
  description: string;
  shouldRun(context: PreparedCheckContext, options: CheckCommandOptions): boolean;
  build(
    context: PreparedCheckContext,
    protectedState: ProtectedCheckState,
    command: string,
  ): Promise<ViolationReport> | ViolationReport;
  /** Optional: stages that must complete first (true dependency, not parallel pref) */
  dependsOn?: string[];
}

export const CHECK_STAGES: readonly CheckStage[] = Object.freeze([
  {
    id: "generated",
    description: "Verify generated test files match contract",
    shouldRun: () => true,
    build: (ctx, _, cmd) => buildGeneratedStageReport(ctx, cmd),
  },
  {
    id: "protected",
    description: "Verify protected files unchanged",
    shouldRun: () => true,
    dependsOn: ["generated"],
    build: async (ctx, _, cmd) => buildProtectedStageReport(ctx, cmd),
  },
  // ... 其他
]);

export async function runAllStages(
  context: PreparedCheckContext,
  protectedState: ProtectedCheckState,
  command: string,
  options: CheckCommandOptions,
  filters: ReportFilters,    // Round 1 修订：filter pipeline 显式
): Promise<ViolationReport[]> {
  const reports: ViolationReport[] = [];
  for (const stage of topologicalSort(CHECK_STAGES)) {
    if (!stage.shouldRun(context, options)) continue;
    const rawReport = await stage.build(context, protectedState, command);
    // Round 1 修订（reviewer C）：filter wrapper 在 runAllStages 显式应用
    // 不是各 stage 自己 apply，避免每个 stage 重复 filter logic
    reports.push(applyFiltersToReport(rawReport, filters));
  }
  return reports;
}
```

**Round 1 修订（reviewer C）补充**：

- Stage 排序：**declaration order in CHECK_STAGES array**（不允许字母序或哈希序，必须 deterministic）。
- `dependsOn` 是 topological constraint，不是 ordering preference。环检测 fail-fast。
- `filters` 参数显式传入，stage 不感知 filter 逻辑。
```

`check.ts` 主入口变成：

```typescript
const reports = await runAllStages(context, protectedState, "check", options);
const merged = mergeReports(reports);
```

新增 stage（trace / typestate / effect）只需在 `CHECK_STAGES` 数组里加一项，不动 check.ts。

### 工程量

1 天（包括迁移 8 个现有 stage + 测试）。

---

## 三、typescript-shape → type-driven-evaluator 统一

### 现状

`packages/cli/src/typescript-shape/`：
- `branded-ids.ts`：branded ID 静态校验
- `smart-constructors.ts`：smart constructor 校验
- `types.ts`：相关类型
- `program.ts`：tsc Program 构造

每个 evaluator 是孤立函数。Phase B 加 type-state / effect 时再各自单独写一个文件会更乱。

### 重构方案

统一为 `packages/type-driven-evaluator/`（新独立包）：

```
packages/type-driven-evaluator/
├─ src/
│  ├─ index.ts                  # 统一入口
│  ├─ branded-id-checker.ts     # 从 typescript-shape/branded-ids.ts 迁
│  ├─ smart-ctor-checker.ts     # 从 typescript-shape/smart-constructors.ts 迁
│  ├─ type-state-checker.ts     # Phase B 新增
│  ├─ effect-checker.ts         # Phase B 新增
│  └─ types.ts
└─ tests/
```

每个 checker 实现统一 trait：

```typescript
export interface TypeDrivenChecker<TDeclaration, TViolation> {
  id: string;
  language: SupportedLanguage[];   // 支持哪些语言
  check(declarations: TDeclaration[], context: CheckContext): Promise<TViolation[]>;
}
```

CLI 的 `check-stages-type-driven.ts`（Phase A 加的）改为 dispatch 到这个包，按 declaration kind 路由：

```typescript
import { brandedIdChecker, smartCtorChecker, typeStateChecker, effectChecker } from "@stele/type-driven-evaluator";

// in stage:
const allViolations = [
  ...(await brandedIdChecker.check(contract.brandedIds, context)),
  ...(await smartCtorChecker.check(contract.smartCtors, context)),
  ...(await typeStateChecker.check(contract.typeStates, context)),  // Phase B
  ...(await effectChecker.check(contract.effectPolicies, context)), // Phase B
];
```

### 工程量

1.5 天（迁移现有 + 调整 import + 测试）。

---

## 四、render-stele.ts 按形态拆分

### 现状（Round 1 reviewer C 实测纠正）

`packages/cli/src/design-generator/render-stele.ts` 实际 **537 行**（不是 760+），混合渲染：
- architecture
- core-node
- branded-id
- smart-ctor
- ddd-context-map

Phase B 还要加 trace-policy / type-state / effect 3 种 form。继续单文件会变成 1500+ 行。

### 重构方案

按形态拆 6 个文件 + 主入口：

```
packages/cli/src/design-generator/render/
├─ architecture.ts          # renderArchitectureBlock
├─ core-node.ts             # renderCoreNodeBlock
├─ type-driven.ts           # renderBrandedId / renderSmartCtor / renderTypeStateBlock
├─ context-map.ts           # renderAclIntegration
├─ effect.ts                # renderEffectDeclarations / renderEffectAnnotation / renderEffectPolicy  (Phase B)
├─ trace.ts                 # renderTracePolicy  (Phase B)
└─ index.ts                 # 主入口：renderAllDeclarations
```

`index.ts`：

```typescript
import { renderArchitectureBlock } from "./architecture.js";
import { renderCoreNodeBlock } from "./core-node.js";
import { renderBrandedId, renderSmartCtor, renderTypeStateBlock } from "./type-driven.js";
import { renderAclIntegration } from "./context-map.js";
import { renderEffectDeclarations, renderEffectAnnotation, renderEffectPolicy } from "./effect.js";
import { renderTracePolicy } from "./trace.js";

export function renderAllDeclarations(profile: NormalizedProfile): RenderResult { ... }
```

### Byte-Stability 验收（Round 1 修订）

**强制**：拆分前后 `renderAllDeclarations(profile)` 输出必须 byte-equal。

实施步骤：

1. 拆分前：写 `packages/cli/tests/render-stele-snapshot.test.ts`，固定 fixture 的完整输出存入 `tests/golden-snapshots/render-stele.golden.stele`
2. 拆分后：snapshot 测试必须 pass（diff -u 空 diff）
3. PR 必须含 snapshot test 作为新 unit test
4. 额外跑 `pnpm test:packed-adoption` 验证下游 manifest.json 不变

**Phase A rule_id stability 也要守住**（Round 1 reviewer C）：

- type-driven evaluator 重新打包成 `@stele/type-driven-evaluator` 时，rule_id 字符串保持 `type_driven.branded_id.*` / `type_driven.smart_ctor.*`。物理位置变化不影响 rule_id contract。
- 新增 Phase B 形态用新前缀（`type_driven.type_state.*` / `type_driven.effect.*`）
- 新增冒烟测试：解包 Phase A 的 `.last-check-report.json`，验证 rule_id 集合是超集（无 rename）

### 工程量

2 天（迁移 + snapshot test + Phase A rule_id stability test）。

---

## 五、profile.yaml 字段一致性

### 现状

profile.yaml 当前字段：

```yaml
type_driven:
  enabled: true
  branded_ids: { ... }
  smart_constructors: { ... }
  adt: { mode: hard }              # 占位，无实现
  type_state: { mode: hard }       # 占位，无实现
```

ADT 不做（用户决策），type_state 要做。同时加 effect。

### 重构方案

清理为：

```yaml
type_driven:
  enabled: true
  branded_ids: { ... }
  smart_constructors: { ... }
  type_state:                       # Phase B
    mode: hard | soft | off
    machines: [ ... ]               # 见 03-type-state.md

trace:                              # Phase B
  policies: [ ... ]                 # 见 02-trace-based-policy.md

effect:                             # Phase B
  declarations: [ ... ]
  annotations: [ ... ]
  policies: [ ... ]                 # 见 04-effect-system.md
```

**删除**：`type_driven.adt`（占位字段，不做了）。

`packages/cli/src/design-profile/types.ts` 中 `adt` 字段标 `@deprecated` 一个版本，下版本删除。`design-profile/validate.ts` 移除 ADT 校验逻辑。

### 工程量

0.5 天。

---

## 六、architecture-runtime.ts 精简

### 现状

`packages/cli/src/architecture-runtime.ts` 480 行，有两个相似函数：
- `evaluateArchitectureFull`
- `evaluateArchitectureContract`

二者参数 / 实现高度重叠。

### 重构方案

合并为单一 `evaluateArchitectureRuntime`，返回结构带可选字段：

```typescript
export interface ArchitectureRuntimeResult {
  violations: ArchitectureViolation[];
  cycleViolations: CycleViolation[];
  layerDirectionViolations: LayerDirectionViolation[];
  publicEntryViolations: PublicEntryViolation[];
  ambiguousFiles: AmbiguousFile[];
  unresolvedSpecifiers: UnresolvedSpecifier[];
  /** Optional, set only when fullDetails=true */
  detailedReport?: DetailedReport;
}

export async function evaluateArchitectureRuntime(
  options: ArchitectureContractOptions & { fullDetails?: boolean }
): Promise<ArchitectureRuntimeResult>
```

Phase A 已经稳定，不动算法。仅消除重复。

### 工程量

0.5 天。

---

## 七、conformance 测试扩展

### 现状

`tests/conformance/fixtures/` 当前 6 个 fixture，全是 invariant / code-shape。

### Phase B 新增

```
tests/conformance/fixtures/
├─ 07-trace-policy-basic/           # trace-policy 基础
├─ 08-trace-policy-cross-lang/      # 同一规则 5 语言验证
├─ 09-type-state-basic/             # type-state 基础
├─ 10-type-state-cross-lang/        # 同一状态机 5 语言验证
├─ 11-effect-system-basic/          # effect 基础
├─ 12-effect-system-cross-lang/     # 同一 effect 5 语言验证
└─ 13-callgraph-extractor-suite/    # 10 个调用图提取测试，每个 5 语言 = 50 case
```

每个 fixture 含：
- `contract/main.stele`
- 各语言源代码（5 个子目录）
- `expected-violations.json`

conformance runner 跑每个 fixture × 每个 backend，断言违例集合相等。

### 工程量

5 天（含跨语言 fixture 撰写）。

---

## 八、文档清理

### 现状

`docs/` 目录有大量 v0.2 设计文档：
- `docs/design/phase-1/` ~17 个 EP 设计文档
- `docs/design/phase-2/` ~4 个 EP 设计文档
- `docs/internal/prd-round-{1,2}-review.md`
- `docs/internal/design-doc-round-1-review.md`

这些是历史文档，Phase B 不动它们。

### Phase B 新增

`docs/design/phase-b/`（本目录）：
- README + 00-07 八份设计文档
- 实施过程中产出 `phase-b-round-1-review.md`, `phase-b-round-2-review.md`（独立 reviewer agent 输出）
- 实施完成产出 `phase-b-implementation-report.md`

### `docs/spec/cdl.md` 更新

加入新形态：
- `trace-policy` 章节
- `type-state` 章节
- `effect-declarations` / `effect-annotation` / `effect-policy` 章节
- 删除 `agent` / `scope` / `inter-agent-contract` / `conflict` 章节

### 工程量

1 天。

---

## 九、重构总工程量汇总

| 重构项 | 工程量 |
| --- | --- |
| 删除 multi-agent 死形式 | 0.5 天 |
| check.ts stage registry | 1 天 |
| typescript-shape 统一为 type-driven-evaluator | 1.5 天 |
| render-stele.ts 拆分 | 1 天 |
| profile.yaml 字段清理 | 0.5 天 |
| architecture-runtime.ts 精简 | 0.5 天 |
| conformance 测试扩展 | 5 天 |
| 文档清理 | 1 天 |
| **合计** | **~11 天** |

## 十、执行顺序（Round 1 修订：sub-agent 串行化）

Round 1 reviewer B 指出：trace-policy / type-state / 三 effect form / multi-agent 删除 **全部改 structure-types.ts 同一文件同一类型定义**。多 sub-agent 并发必然冲突。必须串行。

### 文件级冲突分析

```
锁 packages/core/src/validator/structure-types.ts 的串行链：
  agent-0: multi-agent 删除 (含 normalize.ts)
  agent-1: trace-policy form 加（依赖 agent-0）
  agent-2: type-state form 加（依赖 agent-1）
  agent-3: effect 三 form 加（依赖 agent-2）

锁 packages/cli/src/commands/check.ts 的串行链：
  agent-0: stage registry 重构（PR1-PR2-PR3 序列）
  agent-1-2-3: 三新 stage 注册（依赖 agent-0，但彼此可并行）

锁 packages/cli/src/design-generator/render-stele.ts 的串行链：
  agent-0: 拆分（含 byte-stability snapshot）
  agent-1-3: 各新 render 函数（依赖 agent-0，但彼此可并行）

不冲突的可并行：
  - call-graph-core 包（新建独立包）
  - typescript-shape → type-driven-evaluator 包提取
  - profile.yaml 清理
  - architecture-runtime 精简
```

### B.1（4-6 周, TypeScript only）执行序列

```
Week 1: 重构基础（串行链）
  Day 1-2: agent-0a: 删除 multi-agent（含 normalize.ts + spec）
  Day 3-4: agent-0b: stage registry 重构 (PR1)
  Day 4-5: agent-0c: render-stele 拆分 + byte-stability snapshot
  Day 5  : agent-0d: typescript-shape → type-driven-evaluator 包提取
           agent-0e: profile.yaml 清理（并行）
           agent-0f: architecture-runtime 精简（并行）

Week 2: 公共基础（部分可并行）
  Day 6-7: agent-1: @stele/call-graph-core 包（types + pattern matcher +
                    NodeId disambiguator + extern-alias 解析）
  Day 8-10: agent-2: TS CallGraphExtractor (含 methodResolutionHash cache)

Week 3: Trace-Based Policy（串行依赖 structure-types）
  Day 11  : agent-3a: structure-types.ts + structure-parse.ts 加 trace-policy form
  Day 12-13: agent-3b: @stele/trace-evaluator 包 (worklist 算法)
  Day 14  : agent-3c: check stage 注册 (PR2)
  Day 15  : agent-3d: design-generator render + 单元测试

Week 4: Type State
  Day 16  : agent-4a: structure-types.ts 加 type-state form (依赖 agent-3a)
  Day 17-18: agent-4b: @stele/type-state-evaluator + TS phantom 推断
  Day 19  : agent-4c: check stage + 单元测试

Week 5: Effect System
  Day 20  : agent-5a: structure-types.ts 加 effect 三 form (依赖 agent-4a)
  Day 21-22: agent-5b: @stele/effect-evaluator (worklist + suppression CDL-only)
  Day 23  : agent-5c: TS JSDoc 解析 + propagation_chain 渲染
  Day 24  : agent-5d: check stage + 单元测试

Week 6: 收尾
  Day 25-26: stele 自身契约更新（trace/typestate/effect 自检规则）
  Day 27  : 性能基准（finance-guard + 10x 同义放大）
  Day 28  : spec 文档 + 错误码 + release tag v0.3.0-b1
```

**前 5 天重构基础就位，后 25 天 B.1 实施**。

注：上述序列每"day"=工作日；考虑调试和反馈循环 buffer，实际 4-6 周匹配 B.1 时间盒。

### B.2 / B.3 序列见 00-overview.md §六

### Round 1 修订 vs 原版工程量

| 项 | 原版 | Round 1 修订 |
|---|---|---|
| 重构 4 步 | 4 天 | 7 天（含 self-bootstrapping safety + 串行化） |
| call-graph 抽象 + pattern matcher | 2 天 | 3 天（NodeId disambiguator + extern-alias） |
| TS CallGraphExtractor | 3 天 | 5 天（含 methodResolutionHash + async） |
| Trace evaluator | 4 天 | 5 天（worklist + depth warning） |
| Type State evaluator | 5 天 | 7 天（async/promise 坦白文档 + 跨函数边界限制） |
| Effect evaluator | 3 天 | 5 天（worklist + suppression CDL-only） |
| 测试 + conformance（TS only） | 5 天 | 7 天（含 byte-stability snapshot + ratchet）|
| **B.1 合计** | ~26 天 | **~40 天 (含 buffer = 4-6 周)** |

文档诚实，不在工程量上欺骗自己。

## 十一、风险

| 风险 | 缓解 |
| --- | --- |
| 删除 multi-agent 影响外部用户 | 这些 form 没有 evaluator，**任何 .stele 用了都没效果**，删除不影响实际功能 |
| stage registry 改动 check.ts 主入口 | 完整 e2e 测试 + `stele check` 自检 |
| typescript-shape 包改名影响 import | grep-replace + tsc 报错引导，半天解决 |
| render-stele 拆分破坏 byte-stability | 拆分后 design generate 输出必须 byte-equal 原版（用 diff 验证） |
