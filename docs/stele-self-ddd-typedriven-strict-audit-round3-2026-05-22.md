# Stele 自身 DDD / Type-Driven 严格审查 Round 3

审查日期：2026-05-22  
审查范围：当前工作区全量实现，不只看 diff。重点审查 Stele 自身是否已经能严格执行 DDD 与 type-driven 契约、实现是否符合设计、测试是否有真实信号、发布与 Hook 链路是否足够可靠。

## 总结结论

当前状态：**不可合入 main，不可发布**。

这轮相较上一轮有明显进展：`pnpm -r run typecheck` 通过，`pnpm -r run test` 通过，CLI 测试规模较大，Hook 提示和 project-local 命令解析有改善，发布脚本也开始加入 typecheck/test/stele check gate。

但核心问题仍然是：**Stele 自身的严格契约没有闭环**。当前 `stele check` 是红的，`stele design check` 是红的；DDD 架构契约存在 profile/生成文件/运行期检查三者不一致；type-driven 目前主要是 profile 声明和局部 checker，并没有接入 `check` 管线形成真实约束。

本轮整改口径应收敛为：**先把 TypeScript 实现做好**。这里的 `backend-go` / `backend-java` / `backend-rust` 等包名指的是 Stele 的后端生成器包，主体实现仍是 TypeScript；当前不应把问题扩展成“立即支持 Go/Java/Rust AST 的 DDD 检查”。对这些包，当前只要求检查它们的 TypeScript 源码归属、TypeScript import 边界和生成器职责边界；嵌入的目标语言 runtime/template 文件应暂时从 TS 严格自审范围中显式排除或单独建模。

## 验证证据

| 检查项 | 结果 | 说明 |
|---|---:|---|
| `pnpm --filter @stele/cli run build` | 通过 | CLI dist 可构建。 |
| `pnpm -r run typecheck` | 通过 | 全 workspace typecheck 通过。 |
| `pnpm --filter @stele/cli run test` | 通过 | CLI 50 个测试文件，673 个测试通过。 |
| `pnpm -r run test` | 通过但有跳过 | 全 workspace 测试通过，但 conformance 有 7 个测试因 `pytest not installed` 跳过。 |
| `pnpm --filter @stele/conformance-tests test` | 通过但无有效执行 | 1 个 test file pass，7 skipped，全部提示 `python:pytest: pytest not installed`。 |
| `pnpm exec eslint --format json .` | 0 error, 2 warning | 仍有 `no-unused-vars` 与 unused eslint-disable warning。 |
| `node packages\cli\dist\index.js check --format json` | 失败 | 2 个 active violation：manifest drift 和 design profile load failure。 |
| `node packages\cli\dist\index.js design check --json` | 失败 | `profileValid=false`，错误为 `Cannot convert undefined or null to object`。 |
| `node packages\cli\dist\index.js check --architecture-only --format json` | 失败 | 同样受 manifest drift 和 design profile load failure 影响。 |
| `node packages\cli\dist\index.js check --complexity-only --format json` | 失败 | manifest drift 阻断。 |

## P0 阻断问题

### P0-1：Stele 自身 contract 当前是红的

事实：

- `stele check --format json` 返回 `ok=false`。
- 当前 violation：
  - `stele.check.manifest_drift`：`contract/design/profile.yaml` 已变更，但 `contract/.manifest.json` 未被合法刷新。
  - `design_integrity.violation`：`[profile] Failed to load profile: Cannot convert undefined or null to object`。
- `stele design check --json` 返回：
  - `status=fail`
  - `profileValid=false`
  - `manifestValid=true`
  - `ownershipValid=true`
  - `sourceOwnershipValid=true`
  - `errors=["[profile] Failed to load profile: Cannot convert undefined or null to object"]`

根因：

- `contract/design/profile.yaml` 的 `backends-go` context 不完整：

```yaml
- id: backends-go
  decision_ref: d1
  name: Go Test Backend
  subdomain: "packages/backend-go/src/**"
  aggregate_roots: []
```

它缺少其他 context 都具备的 `subdomain_type`、`architecture_style`、`root`、`layers`。这个问题不是要求现在做 Go AST 支持，而是当前 profile 把一个 TypeScript 实现的 Go 后端生成器包建模坏了。

- `packages/cli/src/design-profile/validate.ts` 的 `collectPaths(context)` 直接执行 `Object.values(context.layers)`，没有先校验 `context.layers` 是否存在。
- `packages/cli/src/design-profile/load.ts` 只是 `yaml.load(text) as DesignProfile`，没有运行时 schema parse，所以 YAML 结构错误会在后续 validator 内部炸成 TypeError。

影响：

- 自身 profile 一旦有一个 context 写错，`design check` 不能给出结构化的字段级错误，而是泛化为 load failure。
- `sourceOwnershipValid=true` 这个输出容易误导，因为 profile invalid 时 source ownership 实际没有被完整执行。
- 在用户要求“Stele 自己严格执行 DDD/type-driven，不能白名单、不能历史跳过”的前提下，当前状态不能合入。

必须修复：

1. 按 TS-only 口径修正 `backends-go` context：如果它属于当前严格自审范围，就把它建模为 TypeScript 后端生成器 context，并补齐 `root`、`layers`；如果暂时不纳入，就从 strict `source_roots` / `contexts` 中移出，不能留下半截 context。
2. `loadProfile` 后必须做运行时 schema validation，不能裸 cast。
3. `validateProfile` 必须对缺字段返回结构化错误，例如 `ddd.contexts.backends-go.layers is required`，不能抛 TypeError。
4. 增加测试：直接加载仓库真实的 `contract/design/profile.yaml`，要求 `validateProfile(profile)` 返回空数组，并且 `stele design check --json` 通过。
5. profile 修复后，通过合法 review/lock 流程刷新 `contract/.manifest.json`。

### P0-2：DDD 架构约束还没有端到端执行

事实 1：profile 对源码归属仍不完整。

用当前 profile 的 context root + layer glob 做覆盖检查，发现：

- `core` 有 1 个未归属文件：`packages/core/src/index.ts`
- `cli` 有 7 个未归属文件：
  - `packages/cli/src/architecture-runtime.ts`
  - `packages/cli/src/backend-registry.ts`
  - `packages/cli/src/errors.ts`
  - `packages/cli/src/index.ts`
  - `packages/cli/src/last-report.ts`
  - `packages/cli/src/recursive-discovery.ts`
  - `packages/cli/src/version.ts`
- `hooks` 有 2 个未归属文件：
  - `packages/agent-hooks/src/index.ts`
  - `packages/agent-hooks/src/protocol.ts`
- `mcp` 有 8 个未归属文件：
  - `packages/mcp-server/src/contract-cache.ts`
  - `packages/mcp-server/src/error-sanitizer.ts`
  - `packages/mcp-server/src/index.ts`
  - `packages/mcp-server/src/path-validation.ts`
  - `packages/mcp-server/src/server.ts`
  - `packages/mcp-server/src/session-state.ts`
  - `packages/mcp-server/src/stele-binary.ts`
  - `packages/mcp-server/src/types.ts`
- `backends-go` 缺 root，导致该 TypeScript 后端生成器包无法被 DDD context 正常拥有。

事实 2：profile 里仍有空 layer glob。

- `packages/agent-hooks/src/{protocol}/**` 没有匹配真实文件，真实文件是 `packages/agent-hooks/src/protocol.ts`。
- `packages/mcp-server/src/{server,sessions,types}/**` 没有匹配真实文件，真实文件是 `server.ts`、`session-state.ts`、`types.ts`。

事实 3：运行期架构检查没有完整报告核心 DDD violation。

- `packages/architecture-core/src/evaluate.ts` 已经能计算：
  - `layerDirectionViolations`
  - `publicEntryViolations`
- 但 `packages/cli/src/architecture-runtime.ts` 只把 dependency violation、cycle violation、unresolved specifier、ambiguous file 转成 `ArchitectureViolation`。
- `packages/cli/src/architecture/stage.ts` 只对 dependency violation 和 cycle violation 生成最终 Stele violation。
- `publicEntries` 在 `architecture-runtime.ts` 和 `architecture/stage.ts` 里仍被填成空数组，所以 public-entry 检查事实上不会触发。
- `architecture-runtime.ts` 写了 `const unownedFiles: string[] = [];`，注释说要追踪 unowned file，但实际没有填充。当前 graph 的 unowned file 永远为空。

影响：

- profile/生成 contract 里看起来有 DDD layer，但 `stele check` 没有可靠地拦截：
  - 文件落在 context root 下但不属于任何 layer。
  - layer pattern 写错导致实际空覆盖。
  - 违反 layer direction。
  - 绕过 public entry 直接 import 内部文件。
- 这正是 Stele 想解决的核心问题：AI 把代码放到“不受约束的缝隙”里，表面测试仍然绿。

必须修复：

1. DDD profile validator 增加强校验：
   - 每个 context 必须有 `root`、`layers`。
   - 每个 layer glob 必须至少匹配一个源文件，除非显式声明为 intentionally-empty 且需要审批。
   - context root 下所有源码文件必须被某个 layer 拥有。
2. 架构 graph 构建必须从 TS context root/source roots 收集 TypeScript 源文件，再判定 module ownership；不能只从 module path 收集文件。目标语言 runtime 文件要么明确 ignore，要么作为后续多语言阶段单独建模。
3. 将 `unownedFiles`、`layerDirectionViolations`、`publicEntryViolations` 全部转成标准 Stele violation。
4. CDL/parser/profile/generator 如要支持 public-entry，需要生成、解析、执行完整链路；如果当前不支持，就不要在设计里声称 public-entry 已实现。
5. 增加负向测试：
   - context root 下新增未归属文件，`stele check` 必须 fail。
   - layer glob 为空，`stele design check` 必须 fail。
   - domain 反向 import application，`stele check` 必须 fail。
   - 外部 module import 目标 module 内部文件，绕过 public entry，`stele check` 必须 fail。

### P0-3：Type-driven 目前不是可执行契约

事实：

- `contract/design/profile.yaml` 中的 type-driven 声明使用的是：

```yaml
branded_ids:
  mode: hard
  declarations:
    - name: RuleId
      base_type: string
      invariant: "matches /^[a-z][a-z0-9_.]*$/"
```

- 但 `packages/cli/src/design-profile/types.ts` 里的 `BrandedId` 类型是：

```ts
export type BrandedId = {
  id?: string;
  name?: string;
  decision_ref?: string;
  type_name?: string;
  type_target?: string;
};
```

- `packages/cli/src/typescript-shape/types.ts` 的 `BrandedIdDeclaration` 又要求：

```ts
typeName: string
typeTarget: string
entityScope?: string
```

- `validateProfile` 只在 `type_target` 存在时校验 target format；当前 profile 的 `base_type` / `invariant` 不会转化成任何可执行检查。
- `packages/cli/src/commands/check.ts` 的 toolchain stage 只运行：
  - tsconfig policy
  - TypeScript diagnostics
  - ESLint JSON ingestion
- 没有调用 `checkBrandedIds`，也没有调用 `smart-constructors` checker。
- `contract/generated/ddd-typedriven.stele` 只生成了 architecture 和 core-node，没有生成 type-driven 的 executable rule。
- `packages/core/src/util/branded-types.ts` 里的实现和 profile 也不一致：
  - profile `RuleId` invariant 是 `^[a-z][a-z0-9_.]*$`
  - 实现 `isValidRuleId` 要求 `stele:*` 或 `custom:*`
  - profile smart constructor 写的是 `parseRuleId` / `parseContractPath` / `parseSha256`
  - 实现导出的是 `ruleId` / `contractPath` / `sha256`

影响：

- `type_driven.enabled: true` 和 `mode: hard` 当前更像文档声明，不是硬约束。
- AI 可以继续用 raw string 传递 RuleId、ContractPath、Sha256，只要 TypeScript 本身不报错，Stele check 不会因为 profile 的 type-driven 契约 fail。
- 这会造成“设计上写了严格 type-driven，实际没有执行”的信任断层。

必须修复：

1. 统一 type-driven schema。二选一：
   - 采用 `id/type_name/type_target/entity_scope`，用 AST checker 执行。
   - 或采用 `name/base_type/invariant`，但必须实现对应的 value-object/branded-type 生成和检查器。
2. `stele check` 必须显式运行 TypeScript type-driven shape stage：
   - branded ID raw string 检查。
   - smart constructor bypass 检查。
   - ADT exhaustive handling 检查，如当前不做就不要标 `mode: hard`。
   - type-state 检查，如当前不做就不要标 `mode: hard`。
3. `design generate` 必须把 type-driven profile 编译为可执行 contract，或在 `check` 中直接从 profile 执行，但二者必须有一个作为权威路径。
4. Stele 自身必须有负向 fixtures：
   - 加一个 raw `ruleId: string` 字段，`stele check` fail。
   - 绕过 smart constructor 直接 cast，`stele check` fail。
   - 删除 branded type target，`stele design check` fail。
5. 统一 profile 中的 constructor 名称和实际 export 名称。

### P0-4：profile loader/validator 缺运行时 schema，当前测试没有守住真实 profile

事实：

- `loadProfile`：

```ts
const parsed = yaml.load(text) as DesignProfile;
return parsed;
```

- `validateProfile` 直接访问 `context.layers`、`sk.paths` 等字段。
- 当前真实 profile 已经出现 schema drift，但测试仍然全绿。

影响：

- TypeScript 类型没有保护 YAML 输入。
- 开发可以在 profile 里写错字段名，例如 `subdomain` 代替 `root/layers`，编译和单元测试都不会暴露，直到真实 `design check` 才以 TypeError 暴露。

必须修复：

1. 增加运行时 schema parse。可以用 Zod，也可以用手写 parser，但必须输出字段级错误。
2. validator 禁止 throw：所有 profile 错误都应该进入 `ValidationErrors`。
3. 增加“真实 profile contract test”：测试仓库根目录的 `contract/design/profile.yaml` 必须通过 schema、profile validation、source ownership、manifest ownership。

### P0-5：测试通过但 conformance 没有真实执行

事实：

- `pnpm --filter @stele/conformance-tests test` 输出：
  - `Test Files 1 passed`
  - `Tests 7 skipped`
  - 每个 skip 原因都是 `python:pytest: pytest not installed`
- `tests/conformance/runner.ts` 在 `runnerSkipped` 时会 `context.skip()`。
- `tests/conformance/runner-impl.ts` 的 `mergeReports` 对 `runner.skipped` 直接返回 drift report，不产生 failure。

影响：

- release gate 里的 `pnpm -r run test` 可以在 conformance 完全没有执行真实 pytest 的情况下通过。
- 这与 Stele 的核心定位冲突：不能把“测试环境缺失导致跳过”伪装成契约真实通过。

必须修复：

1. conformance 在默认/release 模式下禁止 skip。缺 pytest、go、cargo、mvn 等 runner 应该 fail。
2. 可以保留本地开发的 lenient 模式，但必须显式环境变量，例如 `STELE_CONFORMANCE_ALLOW_SKIP=1`。
3. release 脚本必须运行 strict conformance。
4. test output/report 里必须明确实际执行的 backend 数量和 skipped 数量。

### P0-6：发布 gate 顺序仍不安全

事实：

- `scripts/publish-npm.mjs` 当前顺序：
  1. `pnpm -r run typecheck`
  2. `pnpm -r run test`
  3. `node packages/cli/dist/index.js check --format json`
  4. `pnpm build`
  5. `pnpm pack`
- 也就是说 `stele check` 使用的是已有 dist，而不是本次 source build 之后的 dist。
- 当前因为 `stele check` 已经红，所以 release 会被挡住；但一旦 profile 修复，这个顺序可能让旧 dist 误判新 source。

影响：

- 发布 gate 可能验证的是旧 CLI。
- 对一个契约工具来说，发布 gate 必须避免这种 stale dist 窗口。

必须修复：

1. 发布脚本顺序改为：
   - clean-tree 检查，或至少拒绝 required untracked files。
   - build。
   - typecheck。
   - test。
   - strict conformance。
   - `stele check` 使用刚 build 出来的 dist。
   - pack。
   - verify packed manifest 无 `workspace:*`。
   - dry-run/install adoption test。
2. 当前 `verifyPackedManifest` 能检查 tarball 内 `workspace:*`，这是好的，但必须保留并配套 dry-run 证据。

## P1 质量问题

### P1-1：ESLint warning 与 `warning_is_error` 没有形成严格约束

事实：

- 当前 ESLint 输出仍有 2 个 warning：
  - `packages/claude-code-plugin/scripts/observation-hook.js:2:27`：`writeFile` unused。
  - `packages/cli/src/commands/lock.ts:34:1`：unused eslint-disable。
- profile 中写了：

```yaml
eslint:
  enabled: true
  rules:
    - "@typescript-eslint/no-unused-vars"
    - "@typescript-eslint/no-explicit-any"
  warning_is_error: true
```

- `parseEslintReport(report, eslintConfig.rules ?? [])` 没有接收 `warning_is_error`。
- JS 文件的 `no-unused-vars` 不在 profile rule list 内，因此没有被 type-driven toolchain 捕获。

要求：

1. 如果 profile 声明 `warning_is_error: true`，Stele violation severity 必须提升到 error。
2. 当前 repo 要么做到 ESLint 0 warning，要么明确不要声明 warning_is_error。
3. JS 与 TS 规则要统一纳入 profile，不能只保护 TS 文件。

### P1-2：大文件和职责混杂仍然明显

当前最大源文件：

- `packages/backend-typescript/src/runtime/_stele_runtime.ts`：1703 行。
- `packages/backend-typescript/src/translator.ts`：1577 行。
- `packages/cli/src/code-shape/evaluate.ts`：1338 行。
- `packages/cli/src/commands/check.ts`：1158 行。
- `packages/cli/src/commands/design/diff.ts`：1036 行。
- `packages/backend-rust/src/translator.ts`：946 行。
- `packages/backend-go/src/translator.ts`：820 行。

影响：

- 这类文件是 AI 时代最容易被持续补丁式修改、形成隐藏技术债的区域。
- 当前 core-node complexity 主要针对函数/aggregate target，不等价于“文件级职责边界”。

要求：

1. 不建议立刻大重构，但必须把这些文件列入 core-node 或 file-policy 级监控。
2. 对 `check.ts` 这种 orchestration 文件，建议拆成 manifest/design/architecture/complexity/toolchain/report stage modules。
3. 对 translator/runtime 文件，建议建立 translator pass pipeline 的显式阶段，而不是继续单文件堆叠。

### P1-3：工作区状态不适合作为交付基线

事实：

- 当前有 108 个 tracked file 变更。
- 有多个关键 untracked 文件：
  - `eslint.config.mjs`
  - `packages/core/src/loader/load-contract.ts`
  - `packages/core/src/util/branded-types.ts`
  - `.stele/`
  - `%TEMP%stele-check.json`
  - `Etemp_rules.json`
  - 多个 audit report 文件
- `packages/core/src/index.ts` 已经 export `./util/branded-types.js`，但该源文件当前仍是 untracked。如果忘记纳入提交，干净 checkout 会坏。

要求：

1. 开发交付前必须清理工作区：需要提交的源码纳入 git，不应提交的临时文件加入 `.gitignore` 或删除。
2. 发布脚本建议增加 clean-tree gate，至少禁止 required source files untracked。
3. `.stele/maintenance/summary.md` 如果是运行时产物，应加入 ignore；如果要保留，则要有明确生命周期。

### P1-4：Hook 链路有改善，但仍需要验收口径

已改善：

- `pre-tool-protect.js` 已有 repeat marker，后续同 session 只显示短提示。
- 提示里明确不再引导 `Skill(stele:add)`，改为 `stele propose invariant ... --apply`。
- Bash payload 已进入扫描路径，能提取部分写文件目标。
- `stop-validate.js` 已支持 project-local `node_modules/.bin/stele` 和 venv/PATH fallback。

仍需验收：

1. 增加端到端测试：第一次 protected edit 显示完整提示，第二次同 session 显示短提示。
2. 增加端到端测试：按提示执行 `stele propose invariant ... --apply`，命令在安装后的项目里可用。
3. Bash 写文件扫描只能降低绕过概率，不应被描述成强权限模型。
4. stop hook 中 `pnpm test` 对所有 Node 项目默认执行可能很重，需要确认这是有意设计；否则应改为 contract-test command 可配置。

## 已经做得比较好的地方

- CLI build、全量 typecheck、全量 workspace unit tests 当前是绿的。
- `stele check` 对 manifest drift 能正确 fail，没有让 contract profile 的未授权修改直接通过。
- `agent-context --json` 中 protected path 已包含 contract/generated 相关路径。
- Hook 提示从“单纯拦截”转为引导 agent 优先修源码、必要时找用户审查，这符合当前产品方向。
- 发布脚本已加入 packed manifest 检查，能发现 tarball 中残留 `workspace:*` dependency。
- `@stele/core` 开始引入 branded primitives，这是正确方向，但还没和 type-driven contract 打通。

## 必须达到的合入验收标准

开发修复后，请至少提供以下命令的真实输出：

```powershell
pnpm --filter @stele/cli run build
pnpm -r run typecheck
pnpm -r run test
pnpm --filter @stele/conformance-tests test
pnpm exec eslint --format json .
node packages\cli\dist\index.js design check --json
node packages\cli\dist\index.js check --format json
node packages\cli\dist\index.js check --architecture-only --format json
node packages\cli\dist\index.js check --complexity-only --format json
pnpm release:dry-run
git status --short
```

期望：

- `stele check` 的 `ok=true`。
- `design check` 的 `status=pass`。
- conformance 不能有默认 skipped。
- ESLint 0 error、0 warning，或 profile 不再声明 warning-as-error。
- `release:dry-run` 通过，packed manifest 无 `workspace:*`。
- `git status --short` 只包含准备提交的文件，不包含临时产物；关键源码不能 untracked。

## 建议的修复顺序

1. **先把 TS-only 自审范围定死**：profile 只声明当前能严格检查的 TypeScript 实现范围；目标语言 runtime/template 文件不要混入 TS 严格 DDD 判断。
2. **先让 Stele 自身 contract 变绿**：修 profile schema、backends-go 的 TS 生成器建模、manifest drift、真实 profile 测试。
3. **补齐 TypeScript DDD 端到端执行**：source ownership、empty layer、unowned file、layer direction、public-entry 全部进入 `stele check` violation。
4. **补齐 TypeScript type-driven 端到端执行**：统一 schema，接入 `check`，生成或直接执行可验证规则，补负向测试。
5. **让测试和发布 gate 诚实**：conformance 默认不允许 skip，发布先 build 再 check，release dry-run 作为强 gate。
6. **再处理结构性技术债**：拆 `check.ts`、translator、runtime、code-shape evaluator 等大文件，并用 Stele 自身规则防止继续膨胀。

## 给开发的核心判断

这轮不能只修到“测试绿”。当前真正的失败点是：**设计里声明的 DDD/type-driven 强约束，没有完全变成 Stele 自身可执行、可报告、可阻断的契约**。

修复完成的标准不是“单测补了几个”，而是：

- profile 错误能被结构化发现；
- 真实 self profile 能通过；
- 真实 self source tree 没有未归属层；
- 违反 DDD layer/public-entry/unowned/type-driven 的负向 fixture 必须让 `stele check` fail；
- release 与 conformance 不能在跳过关键验证时仍显示成功。
