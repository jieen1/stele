# Design Doc Round 1 Review — Synthesis

> 日期: 2026-05-08 | 状态: 完成 | 审查者: 3 个独立子 Agent

3 个独立 Agent 平行审查 17 份 design doc：
- **Agent A**: Phase 0 设计（4 份），关注接口正确性 + Phase 0 → 后续阶段消费链
- **Agent B**: Phase 1 设计（9 份），关注算法 + 跨 EP 一致性
- **Agent C**: Phase 2 设计（4 份）+ 跨阶段一致性

发现严重程度高于 PRD 评审：设计层面接触代码 schema、constructor、接口签名等具体事实，**多份设计基于错误的 schema 假设**。

## 1. BLOCKER: Schema field names 大规模 drift

**多 reviewer 独立发现**：design docs 引用的 `Violation` 与 `ViolationCause` 字段大部分**不存在于实际 `packages/core/src/report/types.ts`**。

| Design 引用 | 实际 schema | 影响 docs |
|---|---|---|
| `invariant_id` | `rule_id` | EP02, EP07, EP10, EP11, EP12, P0.4 |
| `location.file` | `location.path` | EP02, EP11 |
| `cause.detail.message` | `cause.detail` (string，非对象) | EP02, EP11 |
| `cause.kind` | **不存在** | EP02 |
| `cause.expected_value`, `cause.actual_value` | **不存在** | EP07, P0.4 |

实际 `Violation` 字段：
```typescript
type Violation = {
  rule_id: string;
  rule_kind: string;
  severity: ViolationSeverity;
  source: ViolationSource;
  location: ViolationLocation;
  cause: ViolationCause;
  fingerprint: string;
  scope_paths: string[];
  status?, suppressed_by?, fix?, introduced_in?
};
type ViolationCause = {
  summary: string;
  detail?: string;
  missing?: string[];
  changed?: string[];
  extra?: string[];
  new_files?: string[];
  expected_hash?, actual_hash?
};
type ViolationLocation = {
  path?: string;
  manifest_path?, generated_dir?, line?, column?
};
```

**决策**：保持 schema_version 为 "1"，**保持现有真实字段名**。`failure_witness` 作为 `ViolationCause` 的新可选字段（与 `summary`、`detail` 同级），不引入对象式 detail、不引入 invariant_id 别名。

## 2. BLOCKER: SteleError 构造 API mismatch

**实际**（`packages/core/src/errors/SteleError.ts`，15 行）：
```typescript
constructor(code, category, message, span?, detail?, hint?)
```
**6 个位置参数**，**无 cause 字段**。

**Design docs 引用**：`new SteleError({ code, message, cause })`（对象形式 + cause）—— 不存在。

影响：P0.2 §3.2 测试代码不能运行；P0.3 §3.1 整段 `loadBackend` 不能编译。

**决策**：
- 设计文档改用真实位置 API
- 不引入 `cause` 字段
- 不引入 `STELE_ERROR_CODES` 常量对象（按 design doc 设想）—— 错误码直接是字符串字面量

## 3. BLOCKER: `@stele/backend-python` 无 LanguageBackend default 导出

**实际**：包导出 `getPythonRuntimeSource`、`generatePytestSource`、`sanitizePythonIdentifier` 等命名函数；`createLanguageBackend` 主体在 `cli/src/commands/generate.ts:75-129`（**不在包里**）。

**Design**：P0.3 假设 `mod.default ?? mod.backend` 可用 —— 不可行。

**决策**：P0.3 增加显式前置子任务：把 `createLanguageBackend` 主体从 cli 移入 `@stele/backend-python`，加 `export default backend`。同时改 `cli/src/commands/check.ts:29` import。

## 4. BLOCKER: EP05 phantom backend.generate(scope) API

**实际接口**（`coordinator.ts:24`）：`generate(contract, config) -> GeneratedFile[]`，**无 scope 参数**。

**EP05 设计**：`backend.generate({ ...contract, scope: [path] }, ...)` —— 字段不存在。

**决策**：选 (b) full-regenerate-and-filter：每次增量也执行完整 generate，然后按 output_path 比对哈希；只重写哈希不同的文件。性能损失可接受（generator 是 ms 级别，IO 占主导）。文档明确这是性能权衡。

## 5. BLOCKER: EP07 conftest.py ownership contradiction

**Spec**：`docs/spec/cdl.md:474` 说 conftest.py is application-owned，generator does NOT overwrite。

**EP07 §5**：`Generator emit 的 conftest 中加 hook` —— 矛盾。

**决策**：emit `tests/contract/_stele_conftest.py` 单独文件，包含 `pytest_runtest_makereport` hook；用户自己的 `conftest.py` 通过 `pytest_plugins = ["_stele_conftest"]` 注册（pytest 自动发现机制）。如果用户没装 conftest.py，generator 在 `_stele_runtime.py` 中放注册指令，README 说明。

## 6. BLOCKER: EP10 Go witness transport unreliable

**问题**：`STELE_WITNESS:<json>` 通过 t.Logf 输出在 `go test -v -parallel=N` 模式下行间穿插，无法可靠 parse。

**决策**：file-based channel：每个 test 把 witness 写到 `${TMPDIR}/stele-witness-${PID}-${TEST_ID}.json`；`stele check` 在 `go test` 退出后扫描 `${TMPDIR}/stele-witness-*.json` 收集；marker 失效问题消除。

## 7. BLOCKER: EP10 TestMain ownership conflict

**问题**：generator emit TestMain 与用户 setup_test.go 中 TestMain 冲突（Go 仅允许一个）。

**决策**：generator emit 的 `contract_main_test.go` 含唯一 TestMain，调用用户提供的 `SetupSteleContext()`；用户 `setup_test.go` 仅导出该函数，**不写 TestMain**。文档明示。

## 8. CRITICAL: EP11 命令注入

**问题**：`cp.spawn` with `shell: true` + 用户可配置的 `cliCommand` = workspace 信任代码执行漏洞。

**决策**：
- `vscode.workspace.isTrusted` 检查后才执行 spawn
- 删除 `shell: true`
- `cliCommand` 验证 against allowlist regex `/^(npx |pnpm |yarn |stele$)/`
- 写入 `packages/vscode-extension/SECURITY.md`

## 9. CRITICAL: EP13 unique-by JSON.stringify ordering bug

**问题**：`{a:1, b:2}` 与 `{b:2, a:1}` JSON.stringify 不同 → 错误标记为 distinct。

**决策**：用 `@stele/core/src/report/types.ts:156-175` 的 `stableStringify`（递归排序 keys）；同时 validator 阶段拒绝非 scalar path（E0312 类错误）。

## 10. CRITICAL: EP13 lint regex 误匹配顶层 form headers

**问题**：`### \`metadata\`` 等顶层 form headers 会被 operator lint 当作 operator。

**决策**：lint 限定到 `cdl.md` 的 `## Core operators` 章节内（用 `awk` 或显式起止 marker `<!-- BEGIN_CORE_OPERATORS -->` `<!-- END_CORE_OPERATORS -->`）。

## 11. 一致性：FailureWitness 双重定义

EP01 §4.1 与 EP07 §3.1 各自声明 `FailureWitness`，字段不一致（EP01 缺 `truncated`）。

**决策**：单一来源—— `@stele/core/src/report/types.ts` 中导出，EP01 + EP07 + EP10 + EP02 + EP11 全部 import。

## 12. 一致性：safeSerialize 签名不同

EP01 调用 `safeSerialize(item, 2)` 返回 value；EP07 定义返回 `{serialized, truncated}`。

**决策**：以 EP07 §3.2 签名为准，EP01 更新调用点。

## 13. 一致性：操作符总数 EP10 vs EP13

EP10 §10 说 51 + 18 + 5 = 74。EP13 §6 说 75。差 1（filter alias）。

**决策**：标准化 "75 registered（含 filter alias）/ 74 user-facing"，EP10 与 EP13 同步。

## 14. 一致性：conformance fixture 命名 prefix

Phase 0 用 `01-...` `02-...`；EP04 用 `ep04-...`；EP06 用 `06-...`；EP13 用 `ep13-...`。

**决策**：统一为 `epNN-...`，Phase 0 fixture 重命名为 `ep00-...`（W0.4 不依赖 EP 编号）—— 实际更易：保持 `NN-...` 数字前缀，重命名 EP04/EP13 fixture 为 `04-...` / `13-...`。两 reviewer 中一个偏好前者，一个后者；用后者（数字前缀）更简单。

## 15. P0.4 conformance suite 模型完全错误

P0.4 §5 假设 `stele check --json` 返回 per-invariant pytest violations；实际 stele check 返回 drift-shaped violations（`generated_drift`、`manifest_drift` 等），不是 invariant 失败列表。

**决策**：P0.4 runner 改为：
1. `stele generate` 生成 test 文件
2. 执行 test runner（pytest/vitest/go test）with junitxml output
3. 解析 junitxml 提取 per-invariant pass/fail
4. 同时跑 `stele check` 验证 drift（独立 assertion）
5. 比较 junitxml + drift 与 expected fixture

## 16. 其他重要修正（按 doc 分组）

### P0.1 npm publish
- §3.3 placeholder template 改 ESM (`export default {}` + `"type": "module"`)
- §4 加 partial-failure rollback procedure
- §5 加显式 Docker recipe

### P0.2 test debt
- §3.1 用真实 `parseInvariantDeclaration(filePath, node, groupId?)` 签名
- §3.2 用真实 SteleError 位置 API
- §5 baseline 测试数确定方法（Docker recipe，不依赖本地）

### P0.3 backend registry
- §2.2 删除 `STELE_ERROR_CODES` 常量对象提议；错误码直接字符串字面量
- §3.1 决定 python entry framework：保留 `"pytest"`（兼容现有配置；缺 testFramework 时用 init 默认值填）
- §4 immutability test 用 `Object.freeze` + `isFrozen`
- §3.1 加 hint message：未注册 backend 给安装指引
- 加 cli/package.json `exports` 加 `"./backend-registry": "./dist/backend-registry.js"`

### EP01 TS backend
- §4.2 path access：`hasOwnProperty` 命中失败时再尝试 `seg in record`（处理 prototype-defined getters；防原型污染检查 `Object.prototype.hasOwnProperty.call(Object.getPrototypeOf(record), seg)` 或 own only）—— 实际更安全：直接用 `record[seg] !== undefined && Object.prototype.propertyIsEnumerable.call(record, seg)` 模式
- §5.4 STELE_ALLOWED_IMPORTS 扩展：加 `Date`、用户应用代码前缀策略
- §4.3 `safeSerialize` 调用更新为 `{serialized, truncated} = safeSerialize(item, 2)`

### EP02 GitHub Action
- §6 marker 检测改 `body.includes`
- §6 删除 `v.cause.kind` 引用（不存在），改读 `v.cause.summary` + `v.cause.detail`
- §3.2.4 字段名修正：`v.location?.file` → `v.location?.path`；`v.invariant_id` → `v.rule_id`；`v.detail?.message` → `v.cause.detail`
- §3.3 加 octokit retry plugin (`@octokit/plugin-retry`)

### EP04 operators batch 1
- §3.3 round wrapper 加文档：`(round 2.675 2)` 在 IEEE-754 下返回 2.67（与 Python 3 一致），加 conformance fixture
- §2.4 type-of 明示数组返回 "collection"；普通对象返回 "object"
- §3.3 split runtime 加类型检查：`if (typeof sep !== "string") throw`
- §5.6 acceptance：`51 + 18 + 1 = 70 注册`（含 filter alias）/ 69 用户面

### EP05 incremental gen
- §4 算法：选 full-regenerate-and-filter（不需要 backend.generate scope 参数）；按 output_path hash 决定是否重写文件
- §6 并发：文档化为 UB（"同时运行多个 stele generate 的结果未定义；并发时 cache 可能滞后"）
- §3.2 operator_registry_hash：用 `stableStringify` 而非 `JSON.stringify`
- §3.2 cache 路径全部 posix-normalized

### EP06 Code Shape Python
- §4 把 `_STELE_ALLOWED_MODULES` 拆为 `_STELE_USER_ALLOWED_MODULES`（保持现状）+ `_STELE_INTERNAL_ALLOWED_MODULES`（importlib/inspect/ast/glob/typing/re，仅 Stele runtime 内部用）
- §3 `stele_read_file` 加 realpath 检查 + project root prefix
- §3 `stele_type_matches` 修正 `Number` 排除 `bool`、加 `Decimal`
- §3 `stele_resolve_class` 文档化"qualified_name 是 module.ClassName，不支持嵌套类"约束

### EP07 stele why witness
- §5 conftest 机制：emit `_stele_conftest.py` + `pytest_plugins = ["_stele_conftest"]` 注册；用户自己的 conftest.py 不变
- §3.1 FailureWitness 单一定义在 `@stele/core/src/report/types.ts`；EP01/02/10/11 都 import
- §3.1 加到 `ViolationCause` 作为可选 sibling 字段（与 summary/detail 平级，**不**嵌套到 detail 内）
- §3.2 `MAX_WITNESS_BYTES` 从 16 KB 提到 64 KB；分子项 cap：predicate_source ≤ 4 KB、failed_item ≤ 8 KB、其他 ≤ 4 KB
- §3.2 `safeSerialize` 数组截断时设置 `truncated = true`（line 73 后加）

### EP08 --recursive
- §5 退出码优先级：1（错误）> 2/3（drift）。具体规则：任一 project exit 1 → 总 exit 1；否则取 max(2, 3)
- §7 JSON schema 与 §4 调用例对齐

### EP09 agent-hooks SDK
- §5.4 加 overwrite protection：`stele install --agent cursor` 检测 `.cursor/rules/stele.md` 已含非空非自动生成内容时拒绝（除非 `--force`）；自动生成内容用 marker `<!-- stele-auto:v1 -->` 区分
- §5.3 文档化 stop hook 仅返回违约 count，不暴露 witness（隐私边界）
- §10 文档化 ESM dynamic import 冷启动成本（refactored hook 比原 inline 慢 30-80ms）

### EP10 Go backend
- §5.1 加 `"encoding/json"` import
- §5.1 fix float32 case：检测非整数 → `isFloat = true`
- §5.1 文档化 v0.2 不支持 `*big.Int`、`*big.Float`、`decimal.Decimal`、`time.Duration`
- §7 TestMain 仅 generator emit，用户 setup_test.go 仅含 `SetupSteleContext` 函数（不含 TestMain）
- §9 witness transport 改为 file-based channel
- §10 操作符总数 51 + 18 + 1 (filter alias) + 5 = **75 registered（74 user-facing）**
- §10 `safeSerialize` 与 EP07 一致；`steleCompare` 在 §5 显式定义

### EP11 VS Code MVP
- §4 加 `vscode.workspace.isTrusted` 检查；删除 `shell: true`；加 cliCommand allowlist regex
- §3 文档化 multi-root workspace：activate 仅取 first folder（v0.2 限制；不与 EP08 monorepo 等价）
- §5 schema 字段名修正同 EP02
- §3 加 SECURITY.md（描述威胁模型）

### EP12 stele impact
- §3.4 matchesAppliesTo：split on **last** colon；后缀检查 identifier 形状（`/^[A-Za-z_][\w.]*$/`）才视为 file:symbol；否则全字符串视为 file
- §3.3 浅克隆 fallback：`git rev-parse --is-shallow-repository` 检测，输出引导文档
- §3.5 fileOrPatternExists：用 minimatch + `git ls-files --full-name` 列出所有，JS 端 filter（不用 git pathspec）
- §6 PR comment marker 文档化为 `<!-- stele-impact:v1 -->`，与 EP02 `<!-- stele-report:v1 -->` 不同 marker

### EP13 operators batch 2
- §4.2 unique-by：用 `stableStringify`；validator 阶段拒绝非 scalar path
- §4.1 max-by TS：mixed type 显式抛 SteleRuntimeError（不依赖 `>` 类型强转）
- §4.1 max-by/min-by：`steleCompare` 在 EP10 §5 定义后，本 EP 引用
- §4.1 max-by Python：捕获 TypeError 包装为 SteleRuntimeError
- §7 lint 限定 cdl.md `## Core operators` 章节内（用 marker `<!-- BEGIN_CORE_OPERATORS -->`）
- §6 操作符总数 70 + 5 = **75 registered（74 user-facing）**

## 17. 决策摘要表

| 议题 | 决定 |
|---|---|
| Schema 字段名 | 全部回归真实 schema（rule_id, location.path, cause.detail string） |
| failure_witness 位置 | 作为 `ViolationCause` 可选 sibling 字段 |
| SteleError API | 真实位置 API（6 参数） |
| backend-python LanguageBackend | P0.3 加前置子任务：移植 + export default |
| EP05 generate scope | full-regenerate-and-filter（按 output hash） |
| EP05 并发 | 文档化为 UB |
| EP07 conftest | emit `_stele_conftest.py` + pytest_plugins |
| EP10 witness transport | file-based channel `${TMPDIR}/stele-witness-*.json` |
| EP10 TestMain | generator emit only |
| EP11 命令注入 | trust check + drop shell:true + allowlist |
| EP13 unique-by | stableStringify + validator-reject 非 scalar |
| EP13 lint regex | 章节 marker 限定 |
| Operator 总数 | Phase 1 末 70 (69 用户面)；Phase 2 末 75 (74 用户面) |
| Conformance fixture prefix | 统一数字前缀 `NN-...` |

## 18. 后续动作

1. ✅ 保存本审查记录
2. ✅ 应用所有上述修正到设计文档（first pass）
3. ✅ Round 2 design doc review（独立 Agent 验证）—— 找出 15 项二次 drift（schema 字段未根除、SteleError API 残留、stableStringify 私有、EP10 缺 import、EP09 无覆盖保护）
4. ✅ 应用 Round 2 修正（second pass）
5. ✅ 全文 grep 验证：`invariant_id` 仅在注释中作为"曾经误用，现修正"标注；`new SteleError({` 仅一处在 P0.3 §2.3 解释 rename
6. → 设计文档冻结，可开始实施

## 19. 设计文档定稿状态

| Doc | Round 1 verdict | Round 2 verdict | 当前状态 |
|---|---|---|---|
| P0.1 npm publish | READY (minor) | VERIFIED | ✓ 实施 ready |
| P0.2 test debt | NEEDS-WORK | VERIFIED | ✓ |
| P0.3 backend registry | BLOCKED | VERIFIED | ✓ |
| P0.4 conformance suite | BLOCKED | VERIFIED | ✓ |
| EP01 TypeScript backend | NEEDS-WORK | VERIFIED | ✓ |
| EP02 GitHub Action | NEEDS-WORK | VERIFIED | ✓ |
| EP03 pre-commit | READY | VERIFIED | ✓ |
| EP04 operators batch 1 | NEEDS-WORK | VERIFIED | ✓ |
| EP05 incremental gen | NEEDS-WORK | VERIFIED | ✓ |
| EP06 Code Shape Python | NEEDS-WORK | VERIFIED | ✓ |
| EP07 stele why witness | BLOCKED | VERIFIED | ✓ |
| EP08 --recursive | READY | VERIFIED | ✓ |
| EP09 agent-hooks SDK | NEEDS-WORK | VERIFIED | ✓ |
| EP10 Go backend | NEEDS-WORK | VERIFIED | ✓ |
| EP11 VS Code MVP | NEEDS-WORK | VERIFIED | ✓ |
| EP12 stele impact | READY (minor) | VERIFIED | ✓ |
| EP13 operators batch 2 | NEEDS-WORK | VERIFIED | ✓ |

17/17 设计文档通过两轮独立审查 + 一次定向修正。所有 BLOCKER 与 CRITICAL 问题已闭环。可进入实施。
