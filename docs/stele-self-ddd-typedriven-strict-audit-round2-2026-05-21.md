# Stele 自身 DDD + Type-Driven 严格审查报告 Round 2

审查日期：2026-05-21  
审查范围：开发声称修复后的当前本地工作区 `E:\project\stele`。本轮按上一轮 P0 清单复验，并重新执行 CLI build、Stele 自检、architecture/complexity/design check、全仓 typecheck、CLI 测试、ESLint 与关键源码审查。

## 总结结论

本轮有两项关键进展：

- 默认 `stele check` 已经不再跳过 complexity stage。
- `stele check --complexity-only` 已经通过，上一轮 10 条 core-node `missing-target` 表面上已修复。

但当前仍不能交付，也不能认定为“严格 DDD + type-driven 已完成”。原因很直接：默认 `stele check` 现在失败，`pnpm -r run typecheck` 也失败；同时 DDD 架构覆盖、layer/public-entry 执行、type-driven 实质约束、ESLint 严格接入、self no-baseline 等上一轮核心问题仍未闭环。

## 本轮执行结果

通过项：

- `pnpm --filter @stele/cli run build`：通过。注意：这只是 tsup build，不代表类型检查通过。
- `node packages\cli\dist\index.js check --complexity-only --format json`：通过，0 violations。
- `node packages\cli\dist\index.js check --architecture-only --format json`：通过，0 violations。
- `node packages\cli\dist\index.js design check --json`：通过。
- `pnpm --filter @stele/cli run test`：单独重跑通过，50 个测试文件 / 668 个测试通过。
- `contract/.baseline.json`：不存在。

失败项：

- `node packages\cli\dist\index.js check --format json`：失败，2 条 active violations。
- `pnpm -r run typecheck`：失败，`@stele/cli` 有 2 个 TS2345。
- `pnpm exec eslint --format json .`：exit=0，但仍有 146 条 warning，主要是 `@typescript-eslint/no-unused-vars`。

备注：CLI 测试在与 typecheck/ESLint 并行执行时曾出现一次 5000ms 超时，单独重跑通过。按当前证据先不把它列为确定功能失败，但这说明测试性能余量不大。

## P0 问题

### P0-1 当前默认 `stele check` 和全仓 typecheck 都失败

事实：

`node packages\cli\dist\index.js check --format json` 返回失败：

- `typedriven.typescript.diagnostic.TS2345`
- `src/complexity/evaluate.ts:181:60`
- `src/complexity/evaluate.ts:188:65`
- 原因：`Argument of type 'Expression | undefined' is not assignable to parameter of type 'Node'.`

`pnpm -r run typecheck` 同样失败：

- `packages/cli typecheck: src/complexity/evaluate.ts(181,60): error TS2345`
- `packages/cli typecheck: src/complexity/evaluate.ts(188,65): error TS2345`

影响：

这是阻断交付的硬失败。好消息是默认 Stele 闸门现在能抓到 TypeScript diagnostics；坏消息是当前修复本身没有通过这个闸门。

必须修：

1. 修复 `packages/cli/src/complexity/evaluate.ts` 第 181、188 行的 `Expression | undefined` 问题，不允许用 `any` 或断言硬压过去。
2. 修完后重新跑：
   - `pnpm -r run typecheck`
   - `node packages\cli\dist\index.js check --format json`
   - `node packages\cli\dist\index.js check --complexity-only --format json`
3. 把这个失败保留为回归测试：core-node function/arrow/function-expression target 的 body 处理必须类型安全。

### P0-2 发布链路仍可能在 typecheck 失败时打包

事实：

- `pnpm --filter @stele/cli run build` 成功。
- 但 `pnpm -r run typecheck` 失败。
- `packages/cli/package.json` 的 `prepack` 是 `npm run build`，不包含 typecheck。
- `scripts/publish-npm.mjs` 里发布前只执行 `pnpm build`，没有执行 `pnpm typecheck`、`pnpm test`、`stele check`。

影响：

当前状态下，构建可以成功但类型检查失败。如果发布脚本只依赖 build，就可能把不满足严格契约的包打出去。对一个契约工具来说，这是流程级别 P0。

必须修：

1. 发布流程必须在 pack/publish 前执行至少：
   - `pnpm -r run typecheck`
   - `pnpm -r run test`
   - `node packages\cli\dist\index.js check --format json` 或等价 `pnpm exec stele check --format json`
2. `prepack` 至少不能只 build；如果担心每个 package prepack 太慢，根 `release:publish` 必须强制跑完整 gate。
3. 增加 dry-run 验证，证明 typecheck 失败时 publish 脚本不会继续 pack。

### P0-3 DDD 架构覆盖问题仍未修复

本轮重新对 `contract/generated/ddd-typedriven.stele` 中的 architecture path pattern 做覆盖检查：

- `ddd-backends-ts: files=0; emptyPatterns=packages/backend-typescript/src`
- `ddd-backends-py: files=0; emptyPatterns=packages/backend-python/src`
- `ddd-hooks: files=13; emptyPatterns=packages/agent-hooks/src/{protocol}/**`
- `ddd-mcp: files=12; emptyPatterns=packages/mcp-server/src/{server,sessions,types}/**`
- `ddd-context-map: files=46; emptyPatterns=packages/backend-typescript/src, packages/backend-python/src, packages/mcp-server/src/{server,sessions,types}/**`

未覆盖核心文件仍存在：

- `ddd-cli` 下 78 个 `packages/cli/src` 文件中有 7 个未被覆盖：
  - `packages/cli/src/architecture-runtime.ts`
  - `packages/cli/src/backend-registry.ts`
  - `packages/cli/src/errors.ts`
  - `packages/cli/src/index.ts`
  - `packages/cli/src/last-report.ts`
  - `packages/cli/src/recursive-discovery.ts`
  - `packages/cli/src/version.ts`
- `ddd-core` 未覆盖 `packages/core/src/index.ts`。
- `ddd-mcp` 下 20 个 `packages/mcp-server/src` 文件中有 8 个未覆盖：
  - `packages/mcp-server/src/contract-cache.ts`
  - `packages/mcp-server/src/error-sanitizer.ts`
  - `packages/mcp-server/src/index.ts`
  - `packages/mcp-server/src/path-validation.ts`
  - `packages/mcp-server/src/server.ts`
  - `packages/mcp-server/src/session-state.ts`
  - `packages/mcp-server/src/stele-binary.ts`
  - `packages/mcp-server/src/types.ts`

同时，`node packages\cli\dist\index.js check --architecture-only --format json` 仍然通过。

影响：

这说明架构检查仍会在明显空 pattern 和未覆盖文件存在时通过。当前 architecture-only 的通过不能证明项目按 DDD 严格执行。

必须修：

1. profile 中的目录路径必须改为真正匹配文件的 glob，例如 `packages/backend-typescript/src/**`。
2. `server.ts`、`types.ts` 这类根文件不能用目录 glob 假设。
3. architecture runtime 必须枚举 context root 下的所有应管源文件，而不是只枚举 module path 匹配到的文件。
4. 空 module pattern、unowned file、ambiguous file 必须成为 architecture violation。
5. 给这些场景补 fixture 测试，并证明 `architecture-only` 会失败。

### P0-4 `layer` 和 `public-entry` 仍未运行时执行

事实：

- `packages/cli/src/architecture-runtime.ts` 仍然把 `layers` 设为 `[]`。
- 同文件注释仍写着 `layers` 和 `publicEntries` parsed/validated，但 v1 runtime 不执行。
- `packages/cli/src/architecture/stage.ts` 也把 `publicEntries: []`、`layers: []` 传给 evaluation。
- `packages/architecture-core/src/evaluate.ts` 仍只执行 allow-dependency 和 deny-cycles。

影响：

这依旧不是完整 DDD layer 约束。DSL 里写了 `(layer ...)`，但运行时没有执行 layer direction；`public-entry` 也没有执行 import 限制。

必须修：

1. 如果文档和生成器继续输出 `layer` / `public-entry`，runtime 必须执行。
2. 如果暂时不做，就不能宣称严格 DDD，只能说当前是 module allow-dependency + deny-cycles。
3. 每个已支持 DSL 字段都必须有解析、执行、负例测试。

### P0-5 Type-driven 仍然是空壳

事实：

`contract/design/profile.yaml` 仍然是：

- `branded_ids.mode: advisory`
- `branded_ids.declarations: []`
- `smart_constructors.mode: advisory`
- `smart_constructors.value_objects: []`
- `adt.mode: advisory`
- `type_state.mode: advisory`

`tsconfig.base.json` 仍没有 `noUncheckedIndexedAccess`。

影响：

当前 type-driven 仍主要是 tsc diagnostics + 部分 tsconfig policy，而不是 Stele 自身领域类型的严格约束。它不能阻止 raw string path/rule id/hash/command 等关键值绕过构造边界。

必须修：

1. 为 Stele 自身定义最小 hard type-driven 集合：RuleId、ContractPath、ManifestPath、Sha256、CommandName、PackageName 等。
2. profile 中写入真实 declarations/value_objects，并生成可执行检查。
3. 所有核心入口必须通过 smart constructor 或 parser，禁止 raw string 直接进入 domain。
4. 增加负例测试，证明绕过 smart constructor 会被 Stele/tsc 检出。

### P0-6 ESLint 严格接入仍未闭环

事实：

- `pnpm exec eslint --format json .` 当前仍有 146 条 warning。
- 主要 rule 是 `@typescript-eslint/no-unused-vars`。
- profile 中仍配置 `no-unused-vars` 和 `no-console`，没有配置 `@typescript-eslint/no-unused-vars`。
- `packages/cli/src/toolchain/eslint.ts` 仍是 exact rule id match。

影响：

当前 ESLint 被执行，但 TypeScript 项目的实际 warning 没有被 Stele 严格接入。若目标是严格工程约束，warning 不能只是日志。

必须修：

1. profile 使用真实 rule id：`@typescript-eslint/no-unused-vars`。
2. 明确 warning 是否 fail；在 strict self 项目里建议 fail。
3. Stele parser 至少要报告 profile 配置的 rule id 与实际 ESLint rule id 不匹配，否则配置错误会静默通过。

### P0-7 Stele 自身仍没有禁止 baseline/跳过项的硬契约

事实：

- `contract/.baseline.json` 当前不存在。
- 但 `check.ts` 仍会自动读取 baseline 并 suppress violations。
- `stele.config.json` 仍把 `contract/.baseline.json` 放进 protected，而不是声明本项目禁止 baseline。
- 未看到 self-strict 契约能在 baseline 文件出现时失败。

影响：

“当前没有 baseline 文件”不等于“严格禁止 baseline”。用户要求本项目不允许白名单或跳过历史检查，这必须是硬规则。

必须修：

1. Stele 自身契约中加入 `contract/.baseline.json must not exist`。
2. 一旦 baseline 文件出现，默认 `stele check` 必须失败。
3. stop hook 和 release gate 不允许用 `--diff-from`、`--lenient` 或任何跳过项作为最终通过条件。

## P1 问题

### P1-1 protected 输出仍缺 generated design contract

`node packages\cli\dist\index.js rules --json` 和 `agent-context --json` 的 protected 列表仍不包含 `contract/generated/ddd-typedriven.stele`，但默认 config 中有这个路径，manifest 也保护了它。

影响是 agent 看到的 protected context 和 manifest 实际保护范围不一致。需要统一 `rules`、`agent-context`、hook 和 manifest 的 protected 来源。

### P1-2 toolchain diagnostic 路径不是仓库相对路径

默认 `stele check` 报告里 TypeScript 错误位置是 `src/complexity/evaluate.ts`，不是 `packages/cli/src/complexity/evaluate.ts`。

在 monorepo 中这会误导 agent 和开发定位文件。原因是 tsc command 在 package cwd 下输出 package-relative path，Stele 没有把它规范化为 repo-relative path。

### P1-3 core-node 在 agent context 中仍标为 partial

`agent-context --json` 中 architecture rules 是 `hard`，但 10 个 core-node 仍是 `partial`。如果 core-node 是核心 Stele 契约的一部分，应该明确 partial 的含义；如果只是 complexity 指标，不应被包装成完整“核心契约已严格执行”。

### P1-4 工作树仍是未提交/未清理状态

当前工作树有大量 modified/untracked，包括：

- `contract/.manifest.json`
- `contract/design/profile.yaml`
- `contract/generated/ddd-typedriven.stele`
- CLI / architecture-core / mcp-server / plugin hook 源码
- `pnpm-lock.yaml`
- `eslint.config.mjs`
- `.stele/`
- `eslint-output.json`
- 旧审查文档
- `packages/core/src/loader/loadContract.ts` 删除，新增 `packages/core/src/loader/load-contract.ts`

严格交付前必须清理临时文件、提交必要文件，并验证大小写/重命名在大小写敏感文件系统上没有问题。

## 上一轮问题状态对照

- 默认 check 漏跑 complexity：已修复，默认 check 会进入 complexity/toolchain。
- core-node missing-target：有进展，`--complexity-only` 当前通过。
- DDD 架构空扫描/未覆盖：未修复。
- layer/public-entry 不执行：未修复。
- type-driven 空配置：未修复。
- ESLint warning 未接入：未修复。
- self no-baseline 硬规则：未修复。
- protected context 缺 generated contract：未修复。

## 下一轮验收标准

开发修复后，请至少提供以下事实结果：

1. `pnpm -r run typecheck` 通过。
2. `pnpm -r run test` 通过。
3. `pnpm exec eslint --format json .` 在 strict profile 下没有未处理 warning，或 Stele 明确把 warning 转为失败。
4. `node packages\cli\dist\index.js check --format json` 通过。
5. `node packages\cli\dist\index.js check --architecture-only --format json` 对空 pattern/unowned/ambiguous 的负例会失败。
6. `node packages\cli\dist\index.js check --complexity-only --format json` 通过，且 core-node 目标有真实 metrics，不是 missing-target 或 0 值糊弄。
7. 新增 `contract/.baseline.json` 的负例测试会失败。
8. publish dry-run 在 typecheck/test/stele check 失败时会停止。
9. `rules --json`、`agent-context --json`、manifest、hook 使用一致的 protected 列表。

当前结论：第二轮修复有进展，但仍未达到严格交付标准。最先修的是 typecheck/default check 失败，其次是 architecture coverage 继续空跑的问题。
