# Stele 自身 DDD + Type-Driven 严格执行审查报告

审查时间：2026-05-20

审查对象：本仓库 `E:\project\stele` 当前本地代码状态。

审查标准：Stele 自身仓库要作为标杆项目，不允许通过白名单、baseline、历史跳过、lenient、out-of-scope 等方式隐藏问题。所有 DDD / type-driven 契约要么真实执行，要么不能宣称为严格约束。

## 一、结论

当前 DDD + Type-Driven 功能代码和生成物已经进入仓库，`contract/design/profile.yaml`、`contract/design/manifest.json`、`contract/generated/ddd-typedriven.stele` 都存在，`stele design check` 也能通过。

但当前状态不能算“Stele 自身已经严格执行 DDD + Type-Driven”。原因是：

1. `stele check` 的大量问题被 `contract/.baseline.json` suppress 掉了。
2. 本项目显式 `stele.config.json` 没保护新的 design/generated 文件。
3. `pnpm exec stele` 当前会静默 exit 0，导致本地入口可能假通过。
4. DDD runtime 目前只执行部分 import 图规则，`layers` / `publicEntries` 仍只是文档和 agent guidance。
5. type-driven 当前基本是空声明 + advisory，实际只剩 tsconfig policy。
6. TypeScript diagnostics 配置命令是坏的，而且执行失败会被静默跳过。
7. core-node / complexity 当前 10 个目标全部 missing-target，但被 baseline suppress。

按“零白名单、零历史豁免”标准，当前仓库必须继续整改。

## 二、实际命令与结果

### 1. Design profile 完整性检查

命令：

```powershell
node packages\cli\dist\index.js design check --json
```

结果：

```json
{
  "status": "pass",
  "profileValid": true,
  "manifestValid": true,
  "ownershipValid": true,
  "sourceOwnershipValid": true,
  "errors": [],
  "warnings": []
}
```

说明：profile/schema/manifest/ownership 这条链路表面通过。

### 2. 全量 stele check

命令：

```powershell
node packages\cli\dist\index.js check --format json
```

结果摘要：

```json
{
  "invariant_count": 27,
  "violation_count": 232,
  "active_violation_count": 3,
  "suppressed_violation_count": 229,
  "out_of_scope_violation_count": 0
}
```

active 只有 3 条：

```text
stele.baseline.human_file_drift
typedriven.typescript.config.noImplicitAny
typedriven.typescript.config.noUncheckedIndexedAccess
```

但这不是健康状态，因为 229 条问题被 baseline suppress。按本项目要求，这 229 条都不能视为通过。

### 3. Architecture-only check

命令：

```powershell
node packages\cli\dist\index.js check --architecture-only --format human
```

结果：

```text
[error] stele.baseline.human_file_drift
229 baseline violations suppressed.
```

说明：当前 DDD/architecture 问题大量存在，但被 baseline 压住。

### 4. Complexity-only check

命令：

```powershell
node packages\cli\dist\index.js check --complexity-only --format json
```

结果摘要：

```json
{
  "violation_count": 11,
  "active_violation_count": 1,
  "suppressed_violation_count": 10
}
```

其中 10 条 suppressed 都是 generated core-node 的 `missing-target`。

### 5. pnpm 本地入口检查

命令：

```powershell
pnpm exec stele check --format human
```

结果：

```text
exit=0
```

无 stdout，无实际 check 输出。这是严重问题：本地 bin 入口可能让 hook 或用户误以为检查通过。

## 三、必须整改的问题

## P0-1：Stele 自身仓库不能使用 baseline suppress

证据文件：

```text
contract/.baseline.json
```

文件开头写明：

```json
{
  "version": "1",
  "reason": "Baseline existing architecture violations as technical debt. New code must comply with DDD layer rules.",
  "violations": { ... }
}
```

这与当前产品定位冲突。Stele 自身仓库如果作为标杆，不能把当前 DDD/architecture 问题记录成 accepted legacy debt。

相关实现：

```text
packages/cli/src/commands/check.ts
packages/core/src/baseline/types.ts
```

关键逻辑：

```ts
baseline: await tryReadViolationBaseline(resolve(context.projectDir, STELE_BASELINE_FILE))
```

```ts
if (options.baseline?.violations[normalized.fingerprint] !== undefined && isSuppressible(normalized)) {
  return {
    ...normalized,
    status: "suppressed",
    suppressed_by: "baseline",
  };
}
```

整改要求：

1. Stele 自身仓库必须删除 `contract/.baseline.json` 或让 self-strict 模式下存在 baseline 即 fail。
2. self-strict check 不允许 baseline suppress。
3. self-strict check 不允许 `--diff-from` 把问题标记为 out-of-scope。
4. self-strict check 不允许 `--lenient` 跳过 code-shape。
5. 最终目标是 `suppressed_violation_count = 0`。

验收标准：

```powershell
node packages\cli\dist\index.js check --format json
```

必须满足：

```json
{
  "active_violation_count": 0,
  "suppressed_violation_count": 0,
  "out_of_scope_violation_count": 0
}
```

## P0-2：本项目没有保护新的 design/generated 文件

证据文件：

```text
stele.config.json
```

当前 protected：

```json
[
  "contract/**/*.stele",
  "contract/checker_impls/**/*",
  "contract/.baseline.json",
  "contract/.manifest.json",
  "tests/contract/**/*"
]
```

但默认配置里已经有：

```ts
"contract/design/**/*",
"contract/design/proposals/**/*",
"contract/generated/ddd-typedriven.stele"
```

位置：

```text
packages/cli/src/config/defaults.ts
```

问题：

因为本项目显式配置了 `protected`，覆盖了默认配置，导致：

```text
contract/design/profile.yaml
contract/design/manifest.json
contract/generated/ddd-typedriven.stele
```

没有进入当前项目的 protected 列表。

整改要求：

1. 本项目 `stele.config.json` 必须补上 design/generated protection。
2. 更好的产品级修复：用户显式配置 protected 时，默认关键保护项不能被静默覆盖，至少要 merge required protected globs 或报配置错误。
3. `stele rules --json` 输出的 `protected` 必须包含 design/generated 路径。

验收命令：

```powershell
node packages\cli\dist\index.js rules --json
```

验收标准：输出中必须包含：

```text
contract/design/**/*
contract/design/proposals/**/*
contract/generated/ddd-typedriven.stele
```

## P0-3：`pnpm exec stele` / local bin 静默 no-op

命令：

```powershell
pnpm exec stele check --format human
```

当前结果：

```text
exit=0
```

无 stdout，无 stderr，无实际检查。

直接执行下面命令才有真实结果：

```powershell
node packages\cli\dist\index.js check --format human
```

疑似原因：

```text
packages/cli/src/index.ts
```

当前入口判断：

```ts
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
```

pnpm / node_modules junction / symlink 场景下，`import.meta.url` 和 `process.argv[1]` 的路径可能不一致，导致 `runCli()` 没有执行。

整改要求：

1. 修复 CLI entrypoint 判断，pnpm exec / npm bin / node_modules junction 下必须执行。
2. 增加测试覆盖：通过 node_modules bin 或 simulated symlink path 调用必须输出版本/check 结果。
3. 不允许出现 “exit 0 but no output and no command execution”。

验收命令：

```powershell
pnpm exec stele --version
pnpm exec stele check --format human
```

验收标准：

1. `--version` 必须输出 Stele 版本。
2. `check` 必须真实执行，并根据 violation 返回非 0 或成功输出。

## P0-4：DDD runtime 没有真正严格执行 layer/publicEntries

证据文件：

```text
packages/cli/src/architecture-runtime.ts
```

当前代码注释：

```ts
// TODO(v2): `layers` and `publicEntries` are parsed/validated by `structure-architecture.ts`
// but not enforced at runtime in v1. They serve as documentation and agent guidance.
```

问题：

当前 generated contract 中包含：

```stele
(layer ...)
(allow-dependency ...)
(deny-cycles)
```

但 runtime 实际只把 modules、allowDependencies、denyCycles 交给 evaluator。`layers` 和 `publicEntries` 没有真实 enforcement。

这会导致产品表述和实际能力不一致：不能说 DDD 被严格执行，只能说部分 dependency graph 被执行。

整改要求：

1. 要么实现 layer/publicEntries enforcement。
2. 要么从文档、manifest、agent context 中移除 “hard/strict DDD” 表述。
3. hard enforcement 的规则必须真实进入 check pipeline，并能产生 active violation。

验收标准：

1. 对一个违反 layer/public entry 的 fixture，`stele check` 必须失败。
2. 对一个只通过 private/internal module 绕过 public API 的 fixture，`stele check` 必须失败。
3. 测试不能只检查 parser/generator，必须检查 check pipeline 的最终 violation。

## P0-5：架构规则产生大量低质量 violation

当前 229 条 architecture suppressed 大致分布：

```text
architecture.ddd-context-map: 97
architecture.ddd-cli: 71
architecture.ddd-mcp: 46
architecture.ddd-hooks: 10
architecture.ddd-core: 3
architecture.ddd-architecture: 2
```

典型问题：

1. 外部包被当成 `toModule=""` 的 unresolved violation，例如 `typescript`、`minimatch`、`@stele/core`。
2. 正常内部相对路径没有被当前 module globs 覆盖，也被当成 unresolved。
3. context-map 生成了重叠 module，导致 ambiguous ownership。
4. `packages/backend-typescript/src`、`packages/backend-python/src` 这种路径不是 `/**` glob，可能不能覆盖真实文件。

相关实现：

```text
packages/cli/src/architecture-runtime.ts
packages/cli/src/architecture/module-map.ts
packages/cli/src/design-generator/render-stele.ts
```

当前 unresolved 会被转成：

```ts
toModule: ""
specifier: `unresolved: "..."`
```

整改要求：

1. 外部 package import 应明确归类为 external dependency，不应默认变成 architecture violation。
2. workspace package import 要么映射到 context，要么明确支持 external/workspace boundary policy。
3. generated module globs 必须覆盖该 context 的真实 source files。
4. context-map 不能生成重叠 module ownership。
5. ambiguous ownership 必须为 0。
6. unresolved internal imports 必须是配置错误，不能混在普通 dependency violation 里。

验收标准：

1. `architecture.ddd-context-map` 不应再因为自身生成的重叠 module 报 ambiguous。
2. 外部库 import 不应污染 DDD violation。
3. 每个 architecture violation 都应该是开发者能理解并能修的真实边界问题。

## P0-6：type-driven 当前基本没有严格执行

证据文件：

```text
contract/design/profile.yaml
```

当前配置：

```yaml
type_driven:
  enabled: true
  branded_ids:
    mode: advisory
    declarations: []
  smart_constructors:
    mode: advisory
    value_objects: []
  adt:
    mode: advisory
  type_state:
    mode: advisory
```

问题：

这不能称为严格 type-driven enforcement。当前真正执行的是 tsconfig policy，而不是 branded ID、smart constructor、ADT、type-state。

整改要求：

1. 如果本项目要说 “strict type-driven”，必须至少有真实 hard rule 和 declarations。
2. advisory/空 declaration 只能作为 agent context，不应算严格约束。
3. `rules --json` / `agent-context` 应明确区分 hard、partial、advisory，不能让用户误解。

验收标准：

1. 至少一个 branded ID 或 smart constructor fixture 能在违反时让 `stele check` fail。
2. 空 declarations 不应被展示成“已经执行 type-driven”。

## P0-7：TypeScript diagnostics 命令配置错误，并且失败被静默跳过

证据文件：

```text
contract/design/profile.yaml
```

当前配置：

```yaml
typescript_diagnostics:
  enabled: true
  command: "pnpm --filter @stele/cli run tsc --noEmit"
```

实际执行：

```powershell
pnpm --filter @stele/cli run tsc --noEmit
```

结果：

```text
None of the selected packages has a "tsc" script
```

`@stele/cli/package.json` 里实际有：

```json
"typecheck": "tsc --project tsconfig.json --noEmit --pretty false"
```

没有 `tsc` script。

更严重的是 toolchain stage 对失败静默跳过：

```ts
} catch {
  // tsc not available or failed to run — skip silently
}
```

位置：

```text
packages/cli/src/commands/check.ts
```

整改要求：

1. 修正 profile 命令为真实可执行命令，例如 `pnpm --filter @stele/cli run typecheck`。
2. toolchain command 不存在、执行失败、输出无法解析，都必须变成 violation。
3. 不允许 enabled=true 但实际未执行还通过。
4. 测试必须覆盖 command missing / non-zero / empty-output / parse-failed。

验收标准：

```powershell
node packages\cli\dist\index.js check --format json
```

如果 diagnostics enabled 且命令坏了，必须出现明确 violation，而不是静默跳过。

## P0-8：core-node / complexity 当前全部 missing-target

命令：

```powershell
node packages\cli\dist\index.js check --complexity-only --format json
```

结果里 10 条 suppressed 都是：

```text
complexity.*.missing-target
```

原因：

generated core-node 使用了函数目标，例如：

```text
packages/cli/src/commands/check.ts::runCheck
packages/cli/src/design-profile/validate.ts::validateProfile
packages/core/src/manifest/hash-manifest.ts::hashManifest
```

但 evaluator 当前按 class 查找：

```text
packages/cli/src/complexity/evaluate.ts
```

整改要求：

1. core-node target 要么只生成真实 class target。
2. 要么 complexity evaluator 支持 function target。
3. missing-target 必须 active fail，不能 baseline suppress。
4. missing-target 的 fix message 不能写成 “Reduce missing-target below 0”，要给真实修复建议。

验收标准：

1. `check --complexity-only` 不能再出现 suppressed missing-target。
2. 所有 generated core-node 都必须真实命中目标。
3. 如果目标不存在，必须 active fail 且错误信息可操作。

## P1-1：Design check PASS 不能代表 enforcement PASS

当前：

```powershell
node packages\cli\dist\index.js design check --json
```

结果 PASS。

但 full check 仍有 232 violations，其中 229 被 suppress。

问题：

`design check` 只说明 profile/manifest/ownership 通过，不能说明 generated rules 被真实执行并通过。

整改要求：

1. 文档和 CLI 输出要明确区分：
   - design integrity pass
   - enforcement pass
2. 可以增加 `stele design check --enforcement` 或让 `stele check` 输出 design enforcement summary。
3. 如果 generated rule 是 hard，但被 baseline suppress，应在 summary 中明确标红。

## P1-2：报告质量需要区分配置错误和真实架构违规

当前很多 rule_id 是：

```text
architecture.ddd-cli.cli-presentation.
architecture.ddd-mcp.mcp-infrastructure.
```

`toModule` 为空，开发者很难判断这是代码问题、profile 问题、resolver 问题，还是外部依赖问题。

整改要求：

1. unresolved internal import：rule_kind 应为 `architecture_configuration` 或类似名称。
2. external dependency：默认不应报架构违规，除非 profile 显式声明 deny/allow external policy。
3. ambiguous ownership：应独立为 `architecture_ownership_ambiguous`。
4. 普通 layer dependency violation 才使用 `architecture_dependency`。

## 四、开发修复优先级

### 第一批必须修到可验收

1. 修复 `pnpm exec stele` 静默 no-op。
2. 本项目禁止 baseline suppress，至少 self-strict 下 baseline 存在即 fail。
3. `stele.config.json` 补齐 design/generated protected globs。
4. 修复 tsconfig active 两条：`noImplicitAny`、`noUncheckedIndexedAccess`。
5. 修复 diagnostics command，并且 enabled command 失败必须 fail。

### 第二批修规则质量

1. 修 generated DDD profile/module globs，消除 ambiguous ownership。
2. 区分 external package、workspace package、internal unresolved。
3. 消除当前 229 条 architecture suppressed，不允许靠 baseline。
4. 修 core-node target 生成/evaluator，让 complexity 真正命中。

### 第三批修能力边界

1. layer/publicEntries 要么实现 enforcement，要么降级表述。
2. type-driven advisory/空声明不能宣称 hard enforcement。
3. agent-context/rules 输出要明确 hard/partial/advisory 和是否真实执行。

## 五、最终验收命令

开发修完后必须给出这些命令的真实输出：

```powershell
pnpm exec stele --version
pnpm exec stele check --format human
node packages\cli\dist\index.js design check --json
node packages\cli\dist\index.js check --format json
node packages\cli\dist\index.js check --architecture-only --format json
node packages\cli\dist\index.js check --complexity-only --format json
node packages\cli\dist\index.js rules --json
pnpm --filter @stele/cli run typecheck
pnpm --filter @stele/cli run test
```

最终硬性标准：

```text
active_violation_count = 0
suppressed_violation_count = 0
out_of_scope_violation_count = 0
baseline 文件不存在，或 self-strict 下 baseline 存在即 fail
pnpm exec stele 能真实执行
design/generated 文件在 protected 列表中
toolchain enabled=true 的命令失败会产生 violation
core-node 全部命中真实目标
architecture violation 不包含外部包误报和 generated ambiguous ownership
```

## 六、一句话给开发

现在不是“DDD + Type-Driven 已经严格落地”，而是“规则生成链路已经接上，但大量 enforcement 被 baseline suppress，部分检查静默跳过，部分 generated rule 质量不足”。Stele 自身仓库要作为标杆，必须做到零 baseline、零 suppressed、零 silent skip、零假通过。
