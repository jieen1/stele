# Stele 自身 DDD + Type-Driven 严格审查报告

审查日期：2026-05-21  
审查范围：当前本地工作区 `E:\project\stele`，包含 Stele 自身契约、DDD/type-driven profile、CLI 检查链路、architecture/core-node/toolchain 执行链路、agent hook 默认闸门。

## 结论

当前版本不能认定为“已完整按照 DDD 和 type-driven 严格执行”。常规工程测试是绿的，但严格契约闸门存在实质空洞：默认 `stele check` 会通过，单独执行 complexity 阶段却失败 10 条；多处 DDD 架构规则存在空扫描或未覆盖文件；type-driven 配置仍基本是 advisory/空声明；若按“核心 Stele 契约不接受妥协”的标准，必须继续修。

这不是让开发补几个表面规则的问题。当前最严重的问题是：系统已经生成了看起来严格的契约，但默认验证链路没有完整执行这些契约，且部分契约的源文件覆盖范围不完整。

## 已执行验证

通过项：

- `pnpm -r run typecheck`：通过。
- `pnpm -r run test`：通过，13 个 workspace project，CLI 50 个测试文件 / 668 个测试通过，全仓测试通过。
- `node packages\cli\dist\index.js design check --json`：通过，`profileValid=true`、`manifestValid=true`、`ownershipValid=true`、`sourceOwnershipValid=true`。
- `node packages\cli\dist\index.js check --architecture-only --format json`：通过，0 violations。
- `node packages\cli\dist\index.js check --format json`：通过，`OK 27 invariants checked; 3 generated files and 11 protected files verified.`。
- `contract/.baseline.json`：不存在，这是正确方向。

失败/异常项：

- `node packages\cli\dist\index.js check --complexity-only --format json`：失败，exit=3，10 条 active violation。
- `pnpm exec eslint --format json .`：exit=0，但仍有 146 条 warning，全部来自 `@typescript-eslint/no-unused-vars`；当前 Stele profile 没有把这些 warning 变成严格契约失败。
- 当前工作树仍是 dirty 状态，涉及 contract、profile、generated、CLI、architecture-core、plugin hook、lockfile 等文件，另有 `.stele/`、`eslint.config.mjs`、`eslint-output.json`、旧审查文档等未跟踪文件。严格交付前必须提交或清理，不能用当前脏工作树作为可发布状态。

## P0 问题

### P0-1 默认 `stele check` 漏跑 complexity 阶段

事实：

- 默认 `node packages\cli\dist\index.js check --format json` 返回通过，0 violations。
- 但 `node packages\cli\dist\index.js check --complexity-only --format json` 返回 10 条 active violation。
- `packages/cli/src/index.ts` 中 `--no-complexity` 被注册为 `.option("--no-complexity", ..., false)`。
- `packages/cli/src/commands/check.ts` 中默认阶段通过 `if (options.complexity !== false)` 判断是否加入 complexity stage。
- Commander 的 negative option 在这里导致默认 `options.complexity` 为 `false`，于是默认 check 实际跳过 complexity。
- `packages/claude-code-plugin/scripts/stop-validate.js` 只执行 `stele check`，因此 stop hook 当前也会漏掉这 10 条失败。

影响：

这是最严重的问题。用户和 agent 看到默认 check 通过，会误以为严格契约全部生效；实际核心 complexity 契约没有进入默认闸门。

必须修：

1. 修正 CLI option 默认值，默认必须启用 complexity，只有显式 `--no-complexity` 才跳过。
2. 增加回归测试：当 `--complexity-only` 会失败时，默认 `stele check` 也必须失败。
3. stop hook 不应该依赖有歧义的默认行为；至少在修复前显式覆盖验证，修复后也要有 hook 级回归测试证明 complexity 失败会阻断 Stop。

### P0-2 core-node 契约全部处于失效状态

事实：`--complexity-only` 的 10 条 active violation 全部是 `missing-target`：

- `complexity.core-operator-registry-aggregate.missing-target`
- `complexity.core-invariant-validator-aggregate.missing-target`
- `complexity.core-contract-loader-aggregate.missing-target`
- `complexity.core-manifest-engine-aggregate.missing-target`
- `complexity.cli-check-orchestrator-aggregate.missing-target`
- `complexity.cli-code-shape-evaluator-aggregate.missing-target`
- `complexity.cli-design-diff-engine-aggregate.missing-target`
- `complexity.cli-cli-program-factory-aggregate.missing-target`
- `complexity.cli-design-profile-validator-aggregate.missing-target`
- `complexity.architecture-architecture-evaluator-aggregate.missing-target`

根因：

- `contract/generated/ddd-typedriven.stele` 生成了 `core-node` 目标，例如 `packages/cli/src/commands/check.ts::runCheck`、`packages/architecture-core/src/evaluate.ts::evaluateArchitecture`。
- 这些目标多数是 function 或 interface，不是 class。
- `packages/cli/src/complexity/evaluate.ts` 只调用 `findClassByName(sourceFile, className)`，找不到 function/interface 就报 missing-target。
- 例如 `packages/core/src/registry/operators.ts` 里是 `export interface OperatorRegistry` 和 `class InMemoryOperatorRegistry implements OperatorRegistry`，没有名为 `OperatorRegistry` 的 class。

影响：

core-node 是当前“核心 Stele 契约”的关键，但它现在没有真正测到目标代码复杂度。更糟糕的是，默认 `stele check` 又漏掉了这个失败。

必须修：

1. 明确 core-node target 语义：到底是 class、interface、function、exported const，还是任意 symbol。
2. evaluator 必须支持当前 profile 生成的 target 类型，至少支持 `file::functionName`、`file::interfaceName`、`file::className`。
3. 若目标是 interface，必须定义可执行指标，不能把 interface 当 class 算 public method / cyclomatic。
4. 对 missing-target 增加 fixture 测试，并确保默认 `stele check` 失败。
5. 修复失败报告，不能再出现 `Reduce missing-target ... below 0` 这种无意义修复建议。

### P0-3 DDD 架构扫描存在空扫描和未覆盖文件

我用生成的 `contract/generated/ddd-typedriven.stele` 中的 architecture path pattern 对实际文件做了覆盖检查，结果如下：

- `ddd-backends-ts: files=0; emptyPatterns=packages/backend-typescript/src`
- `ddd-backends-py: files=0; emptyPatterns=packages/backend-python/src`
- `ddd-mcp: files=12; emptyPatterns=packages/mcp-server/src/{server,sessions,types}/**`
- `ddd-context-map: files=46; emptyPatterns=packages/backend-typescript/src, packages/backend-python/src, packages/mcp-server/src/{server,sessions,types}/**`
- `ddd-cli` 有 7 个 `packages/cli/src` 下的重要文件未被任何 `ddd-cli` module pattern 覆盖：
  - `packages/cli/src/architecture-runtime.ts`
  - `packages/cli/src/backend-registry.ts`
  - `packages/cli/src/errors.ts`
  - `packages/cli/src/index.ts`
  - `packages/cli/src/last-report.ts`
  - `packages/cli/src/recursive-discovery.ts`
  - `packages/cli/src/version.ts`
- `ddd-core` 未覆盖 `packages/core/src/index.ts`。

根因：

- `safeGlob` 只匹配文件。`packages/backend-typescript/src` 这种目录路径不会匹配目录下文件，必须是 `packages/backend-typescript/src/**` 或更明确的 `packages/backend-typescript/src/**/*.ts`。
- `packages/mcp-server/src/{server,sessions,types}/**` 假设 `server`、`sessions`、`types` 是目录，但实际是 `server.ts`、`session-state.ts`、`types.ts` 等根文件。
- `packages/cli/src/{commands,index}/**` 不匹配 `packages/cli/src/index.ts`。
- `packages/cli/src/architecture-runtime.ts` 这类核心 runtime 文件没有被任何 module 覆盖。
- `packages/cli/src/architecture-runtime.ts` 构建图时只从 module path glob 扫描 `allFiles`，没有从 context root 枚举所有源文件，因此 pattern 漏掉的文件直接不可见。
- 同文件还把 `graph.unownedFiles` 固定为 `[]`，没有把未归属文件作为违例上报。

影响：

`architecture-only` 通过不等于 DDD 约束真的覆盖了仓库。部分 bounded context 现在是空跑，部分核心文件在架构检查外。严格 DDD 不能接受这种情况。

必须修：

1. profile 必须区分 `context root` 和 `module path`：先枚举 context root 下所有应该受管的源文件，再验证每个文件必须且只能属于一个 module。
2. 空 module pattern 必须失败，不能通过。
3. 未归属源文件必须失败，不能静默跳过。
4. 重叠归属文件必须失败，不能“分配给第一个 module 后继续跑”。
5. 所有目录型 path 必须标准化为可匹配文件的 glob。
6. 修正当前 profile 的错误路径，尤其是 backend、mcp、cli root 文件。
7. 增加回归 fixture：新增一个未被 module 覆盖的 `src/new-file.ts`，`stele check --architecture-only` 必须失败。

### P0-4 `layer` 和 `public-entry` 目前主要是声明，不是运行时强约束

事实：

- `contract/generated/ddd-typedriven.stele` 生成了大量 `(layer ...)`。
- `packages/core/src/validator/structure-architecture.ts` 会解析并校验 layer/public-entry 的结构。
- 但 `packages/cli/src/architecture-runtime.ts` 中运行时 declaration 直接设置 `layers: []`，并有 TODO 说明 `layers` 和 `publicEntries` 在 v1 不执行。
- `packages/architecture-core/src/evaluate.ts` 实际只执行 allow-dependency 和 deny-cycles。

影响：

当前 DDD 运行时约束实质上是 module dependency allowlist + cycles，不是真正完整的 layer/public-entry 约束。可以接受作为 MVP，但不能标注为“完整严格 DDD”。

必须修：

1. 如果 `layer` 是硬契约，runtime 必须传入并执行 layer direction。
2. 如果 `public-entry` 是 DSL 支持项，必须执行“跨 module/context 只能 import public entry”的限制；否则从 DSL 中移除或标明未支持。
3. 每个 DSL 字段必须有三件事：解析、执行、测试。只解析不执行不能算契约。

### P0-5 Type-driven 仍是空配置/弱约束

事实：

`contract/design/profile.yaml` 当前 type-driven 段落是：

- `branded_ids.mode: advisory`
- `branded_ids.declarations: []`
- `smart_constructors.mode: advisory`
- `smart_constructors.value_objects: []`
- `adt.mode: advisory`
- `type_state.mode: advisory`

同时 `toolchain_contracts.typescript_config.required_options` 包含 `strict`、`noImplicitAny`、`noImplicitOverride`、`noFallthroughCasesInSwitch`、`moduleResolution`、`target`，但没有 `noUncheckedIndexedAccess`。根 `tsconfig.base.json` 也没有 `noUncheckedIndexedAccess`。

影响：

当前所谓 type-driven 主要是“开启部分 TypeScript 编译选项 + typecheck + eslint”，不是严格 type-driven 设计。没有 branded id、smart constructor、ADT、typestate 的具体约束，也没有对应生成规则和负例测试。

必须修：

1. 先定义 Stele 自身最小 type-driven 严格集，不要泛泛而谈。
2. 对核心 ID/路径/哈希/规则 ID/文件路径/命令路径等关键类型定义 branded type 或 value object。
3. 对外部输入到内部领域对象的转换必须通过 smart constructor，不允许裸 string 直接流入核心领域。
4. profile 中不能继续是 advisory + 空数组。没有明确条目就不要声称 type-driven 已严格执行。
5. 补充负例测试：绕过 smart constructor、把 raw string 当 branded id、switch 遗漏 ADT case 等都必须失败。

### P0-6 ESLint toolchain 契约没有把当前 warning 纳入失败

事实：

- `pnpm exec eslint --format json .` 当前 exit=0，但有 146 条 warning。
- warning 主要是 `@typescript-eslint/no-unused-vars`。
- `contract/design/profile.yaml` 中配置的是：
  - `no-unused-vars`
  - `no-console`
- `packages/cli/src/toolchain/eslint.ts` 只做 exact rule id match：`profileRules.includes(msg.ruleId)`。
- 因此当前 TypeScript unused warnings 不会被 `no-unused-vars` 捕获为 Stele typedriven violation。

影响：

如果项目要求严格 type-driven / strict code health，则当前 ESLint 只是跑了命令，但没有把实际 warning 接入契约失败。

必须修：

1. profile 使用真实 rule id：`@typescript-eslint/no-unused-vars`。
2. 明确 severity policy：strict 模式下 warning 是否 fail。若不 fail，就不能说严格。
3. Stele 的 ESLint parser 应支持 rule alias 或直接要求 profile 写完整 rule id，但不能静默错配。
4. 增加测试：fixture 中出现 `@typescript-eslint/no-unused-vars` warning 时，严格 profile 必须让 `stele check` 失败。

### P0-7 Stele 自身项目还没有“禁止 baseline/跳过项”的硬规则

事实：

- 当前 `contract/.baseline.json` 不存在，这是正确的。
- 但 CLI 仍支持 `baseline-init` / `baseline-update`，`check.ts` 仍会读取 baseline 并进行过滤。
- `stele.config.json` 仍把 `contract/.baseline.json` 列为 protected，而不是声明“本项目禁止 baseline 存在”。
- CLI 仍提供 `--lenient`、`--no-complexity`、`--diff-from` 等跳过/缩小范围能力。作为产品功能可以存在，但 Stele 自身的严格自检不应允许这些能力成为默认交付闸门的一部分。

影响：

用户要求“本项目不允许配置任何白名单或者跳过历史检查”。当前只是没有 baseline 文件，不是有硬契约禁止它回来。

必须修：

1. 给 Stele 自身增加 self-strict 契约：`contract/.baseline.json` 一旦存在，默认 `stele check` 必须失败。
2. stop hook / 自检脚本必须使用严格模式，禁止 `--lenient`、`--no-complexity` 作为通过条件。
3. 如果产品继续支持 baseline，要在 Stele 自身 profile 中显式声明“不使用 baseline”，并添加测试覆盖。

## P1 问题

### P1-1 失败报告质量还不够指导 agent 修复

complexity missing-target 的 JSON 报告只有 `location.path`，没有 line；cause 是 `missing-target value 0 exceeds max 0`；fix 是 `Reduce missing-target ... below 0`。

这不符合 Stele 自己定义的“失败必教人”。至少需要：

- 指出 CDL 来源：`contract/generated/ddd-typedriven.stele:line`。
- 指出目标文件和 symbol。
- 明确原因：`target symbol was declared as function/interface but evaluator only supports class`。
- 给出可执行修复：修改 profile target，或扩展 evaluator 支持 symbol kind。

### P1-2 架构运行时对 internal target outside module 的跳过过于宽松

`architecture-runtime.ts` 对 resolved target 如果不属于当前 architecture module，会按“cross-architecture dependency”静默跳过。严格 DDD 下，跨 context 依赖应该由 context map 接管；如果 context map 也没覆盖，就应该失败或至少报告为未受管依赖。

必须增加：

- internal dependency resolved but not owned 的 violation。
- context-map 覆盖验证。
- 明确 external package 与 internal unowned file 的区别。

### P1-3 toolchain 命令非零退出的处理仍有风险

`runCommandFromShell` 目前对 child close 不看 exit code，只返回 stdout/stderr，注释说由调用方解析输出。这个策略对 tsc/eslint 的“有诊断时非零”是合理的，但如果命令非零且输出不可解析，严格模式必须产生 command_failed violation，不能被解析成 0 条后通过。

### P1-4 当前仓库存在未跟踪/临时文件

当前未跟踪项包括：

- `.stele/`
- `docs/stele-self-ddd-typedriven-audit.md`
- `eslint-output.json`
- `eslint.config.mjs`

如果 `eslint.config.mjs` 是契约工具链的一部分，必须纳入版本管理并加入 protected 或自检范围；如果 `eslint-output.json` 是临时输出，必须清理。严格开源项目不能留下含糊状态。

## 必须补的测试

开发完成修复后，至少补这些高价值测试，不接受只测 happy path：

1. 默认 `stele check` 必须包含 complexity stage。
2. `--no-complexity` 只有显式传入才跳过，并且 stop hook 不使用它。
3. core-node target 为 function/interface/class 时分别有有效指标或明确错误。
4. missing core-node target 会让默认 check 失败。
5. architecture module path 为空匹配时失败。
6. architecture context root 下新增未归属源文件时失败。
7. architecture 文件被多个 module 匹配时失败。
8. layer 方向违规时失败。
9. public-entry 违规 import 时失败，若暂不支持则 DSL 不应声称支持。
10. type-driven branded id / smart constructor 负例失败。
11. ESLint `@typescript-eslint/no-unused-vars` 在严格 profile 下失败。
12. `contract/.baseline.json` 在 Stele 自身项目出现时失败。

## 修复验收标准

只有满足以下条件，才能说“Stele 自身严格执行 DDD + type-driven”：

1. `node packages\cli\dist\index.js check --format json`、`--architecture-only`、`--complexity-only` 都通过，且没有任何 hidden failing stage。
2. 所有 generated architecture module pattern 至少匹配一个预期文件；允许空 module 必须有显式 reason，但本项目核心上下文不应允许空 module。
3. 每个 context root 下所有源文件都被 exactly one module 管理。
4. core-node 10 条全部真实测到目标 symbol，不再出现 missing-target。
5. type-driven profile 不再是 advisory + empty declarations，而是有明确的 Stele 自身核心类型约束。
6. ESLint/typecheck 结果按 profile 严格转为 Stele violation。
7. `contract/.baseline.json` 不存在，并且一旦出现会被 Stele 自身契约拦截。
8. stop hook 能阻断 complexity、architecture、type-driven 任一失败。
9. 工作树干净，契约、generated、manifest、profile、toolchain config 全部一致并已提交。

## 建议修复顺序

1. 先修默认 check 漏跑 complexity，这是当前最大误导源。
2. 修 architecture 覆盖模型：context root、empty pattern、unowned/ambiguous 文件。
3. 修 core-node target/evaluator，让 10 条 complexity 契约变成真实测量。
4. 定义并落地 Stele 自身最小 type-driven 严格集。
5. 收紧 ESLint/toolchain 和 self no-baseline 严格模式。
6. 最后优化失败报告和 agent guidance。

当前状态下，我不建议合并为“严格 DDD/type-driven 已完成”。可以说：基础实现已经接近，但关键验证链路还存在会让 agent 和用户误判的空洞。
