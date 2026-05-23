# Stele 项目 — Phase B 实施后系统状态评估

**生成时间**：Phase B v0.3.0-b1 推送后（HEAD `d64f7ad`）
**目的**：盘点所有未完成功能、遗留问题、已知限制，作为后续工作的参考。本文档不是给最终用户看的；它是工程内部基线。

---

## 一、Phase B 已交付能力（baseline of "what works")

### 1.1 三个新机制（B.1 阶段已完成）

| 机制 | 包 | 覆盖语言 | 状态 |
|---|---|---|---|
| **Trace-Based Policy** | `@stele/trace-evaluator` (89 tests) | **TypeScript only** | ✅ 5 个约束 (must-transit / must-be-preceded-by / must-be-followed-by / deny-direct / deny-transit) + worklist algorithm + cross-rule dedup + depth cap (default 10, error severity) |
| **Type State** | `@stele/type-state-evaluator` (73 tests) | **TypeScript only** | ✅ phantom-type inference + type-state-binding 跨函数显式标注 + multi-source transition + lenient/strict mode |
| **Effect System** | `@stele/effect-evaluator` (116 tests) | **TypeScript only** | ✅ worklist 不动点 propagation + CDL-only suppression + unresolved fail-closed + JSDoc `@stele:effects` 注解读取 |

### 1.2 基础设施

- `@stele/call-graph-core` (72 tests) — 跨语言 CallGraph 数据结构 + NodeId 规范 + pattern matcher + extern-alias
- `@stele/backend-typescript/extractors/` — call-graph + type-state-inference + effect-annotations（3 个 TS extractor）
- Stage registry (`check-stages-registry.ts`) — 11 stages 注册化，phase-a + phase-b 全部在 STAGES_ALWAYS

### 1.3 自我保护契约

- `ALL_EVALUATORS_COMPILE` — 5 个 evaluator 包必须可构建
- `STRICT_MODE_DEFAULT_IN_CI` — `.github/workflows/*.yml` 不允许 `--lenient-*` 字串
- `FIX_HINT_REQUIRES_ANALYSIS_BRANCH` — 强制 fix-hint 含 `code issue` + `contract issue` + `propose` + `[A]` + `[B]`

### 1.4 Stop hook loop guard（Bug 修复）

`.stele/stop-state.json` 记录失败 fingerprint。同 fingerprint 连续 2 次 → exit 0 释放给用户。3 个测试覆盖。

### 1.5 fix-hint A/B 分析模板

trace + type-state + effect evaluators 的 default fix-hint 强制 agent 先决定 [A] 改代码 / [B] 走 YAML proposal 流程。

---

## 二、已知 GAP（按严重程度）

### 🔴 P0 — Phase B 自身契约空虚（**最严重**）

**`contract/main.stele` 没有任何 `(trace-policy ...)` / `(type-state ...)` / `(effect-policy ...)` 实例**。

```bash
grep -cE '^\(trace-policy|^\(type-state|^\(effect-' contract/main.stele
# → 0 各类
```

只有 invariant 形态在 main.stele。这意味着 **Stele 项目自身代码没有被 Phase B 三个机制保护**。三个机制实现了、测试了、wire 了，但没在自己项目里 dogfood。

**影响**：
- 我们不知道 Phase B 机制在真实大型 TS 项目上的实际表现
- 看不到 Stele 实际遵守自己的"调用链/状态机/副作用"契约
- 验证只是合成 fixture，不是真实场景

**修复**：Phase B-1 follow-up — 至少声明 5-10 条覆盖 stele 自身关键路径的 trace-policy / effect-policy。例如：
- DB 访问必经 manifest layer（核心生成过程）
- Architecture evaluator 不能调用 cli 命令
- protected-file write 必经 hook 层

### 🔴 P0 — 跨语言 CallGraphExtractor **完全没有**（Python/Go/Java/Rust）

```bash
ls packages/backend-{python,go,java,rust}/src/extractors/
# → cannot access: No such file or directory  ×4
```

设计稿 FINAL-SPEC §B.2 / §B.3 承诺过这些，但实际**只有 TypeScript extractor**。`docs/spec/cdl.md` 已诚实声明这是 deferred to B.3。但 `check-stages-trace.ts:88` / `check-stages-type-state.ts:100` / `check-stages-effect.ts:100` 三处都写："`<X> not yet supported for targetLanguage=python/go/java/rust`" → 静默 skip + warning notice。

**影响**：用户在 Python/Go/Java/Rust 项目上配 trace-policy → 静默无效（仅 warning，不报错也不拦截）。这是 *fail-open* 行为，违反"机械联锁"哲学。

**修复**：
- 选项 A：实施 Python pyright daemon 集成（B.2 4-6 周）
- 选项 B：暂时把非 TS 的 trace-policy 升级为 error severity（让用户明确知道不支持，而不是 silent skip）

### 🔴 P0 — conformance suite **没有 Phase B 跨语言覆盖**

```
tests/conformance/fixtures/
├─ 01-simple-invariant
├─ 02-forall-collection
├─ 03-scenario-checker
├─ 04-temporal-modified
├─ 05-baseline-suppression
├─ 06-code-shape
└─ 07-negative-failing-invariant
```

**没有 trace-policy / type-state / effect-policy 的 conformance fixture**。Phase B 设计明确要求跨语言一致性，但实际只有 per-package fixture（在 cli/tests/fixtures/{trace-policy,type-state,effect}/），不在 `tests/conformance/`。

**影响**：跨语言一致性是 Stele 的设计承诺，无 conformance test → 设计承诺无法验证。

**修复**：B.2 阶段开始时加入跨语言 conformance fixture（即便目前只有 TS extractor，至少建好 fixture 结构）。

### 🟡 P1 — DEFAULT_PROTECTED_PATTERNS **两份不一致**

```
packages/core/src/config/defaults.ts:   5 patterns (basic)
packages/cli/src/config/defaults.ts:    13 patterns (含 design/, generated/, plugin scripts, stele.config.json)
```

当一个项目用 `@stele/core` 但不用 `@stele/cli` 时（未来 IDE 插件 / API 直调场景），它看到的 protected 列表少 8 项——design profile、generated、plugin scripts、config 都不在 protected 内。

**影响**：API 调用者可能误以为 contract 是 protected，实际只覆盖最小子集。

**修复**：把 `@stele/core` 的 DEFAULT_PROTECTED_PATTERNS 扩展到与 cli 一致，或者明确文档化"core only 提供最小集，cli 添加完整集"。

### 🟡 P1 — `stele explain effect` 跑在 lenient mode（read-only inspection）

`packages/cli/src/commands/explain.ts` 中 `runExplainEffect` 用 `strictMode: false` 调用 evaluator。意图是 inspection 不要 fail-closed widening，但这意味着 explain 输出的 effect 集合**可能比 stele check 实际报告的少**（因为 strict 模式下 unresolved → fail-closed 把节点的 effect 集合扩成全集，explain lenient 看不到这扩展）。

**影响**：agent 用 `stele explain effect` 调研时看到的 propagation chain 与 `stele check` 报告的违例上下文不一致——可能误判 [A] vs [B]。

**修复**：explain 输出里加一行 `(strict mode would also include: [list of effects from unresolved fail-closed widening])`，或加 `--strict` flag。

### 🟡 P1 — CLI `--strict-*` / `--lenient-*` flags 不存在

`STRICT_MODE_DEFAULT_IN_CI` invariant 检查 CI 配置里不含 `--lenient-` 字串。但 **flag 本身不存在**——即便用户在 CI 里写 `stele check --lenient-effects`，commander 会报"unknown option"而不是把它传给 evaluator。这条 invariant 防的是一个**当前不可能发生的事情**。

```bash
grep -E '\-\-lenient|\-\-strict' packages/cli/src/index.ts
# → 0 matches in option declarations (现在没有这些 flag)
```

**影响**：
- invariant 实际上是 placeholder，等 flag 被实现后才有意义
- 用户阅读 spec 时可能误以为 `--strict-effects` 存在

**修复**：要么实现这些 flag（推荐——让用户能在 PR 评审时本地放宽），要么从 contract 和 spec 中移除 invariant 直到 flag 真实存在。

### 🟡 P1 — `stele design propose <type>` 不支持 Phase B types

```
$ stele design propose --help
Arguments:
  type    type of proposal: invariant, branded-id, aggregate
```

fix-hint 已修正指向 YAML proposal 流程（写 `contract/design/proposals/<id>.yaml` + 让人审），但 CLI 命令的 type 参数没扩展。如果用户想 propose 一条新 trace-policy / type-state / effect-policy，**没有干净的命令路径**——只能手写 yaml 然后 `stele design propose invariant` 借用名字。

**影响**：propose 流程的 UX 不闭环。Agent 真的写完 rationale 后，命令告诉它"unknown type"。

**修复**：扩展 propose 命令支持 `trace-policy` / `type-state` / `effect-policy` / `effect-suppression` 4 个新 type。

### 🟢 P2 — DDD `layer` + `public-entry` 历史 v1 限制

`docs/spec/cdl.md:322` 明示：

> `layer` and `public-entry` declarations are parsed and validated for structural correctness, but are **not enforced at runtime** in v1.

这是 v0.2 历史 gap，Phase B 没改善。`architecture` form 的 `(allow-dependency ...)` 和 `(deny-cycles)` 已 enforce；但 layer 顺序和 public-entry 访问规则 not enforced。

**影响**：项目可以宣称 layered architecture，但 Stele 不会真正拦截 layer 违规（虽然 dependency 违规会被拦）。

**修复**：v2 issue，不属于 Phase B 范围。

### 🟢 P2 — `agent-hooks/continue-dev` adapter 未实现

```
packages/agent-hooks/src/adapters/continue-dev.ts:43:
  "ContinueDevAdapter.${method} is not yet implemented (Phase 3 candidate)."
```

`stele install --agent continue-dev` 会抛 `E_AGENT_NOT_IMPLEMENTED`。

**影响**：Continue.dev 用户暂时无法用 Stele 自动化保护。

**修复**：Phase 3 范围，不阻塞 Phase B。

### 🟢 P2 — `backend-python` 部分 operator 未实现

```
packages/backend-python/src/expression.ts:81:
  "This operator is not yet implemented by @stele/backend-python."
```

具体哪些 operator 还没 grep 出来。

**影响**：Python 生成的 pytest 在某些 CDL operator 下可能抛运行时错误。

**修复**：grep 列出未实现的 operator，决定是否补全。

### 🟢 P2 — `cli/version.ts` 硬编码版本

```
packages/cli/src/version.ts:9:
  "Derive from package.json at build time in a follow-up."
```

`stele --version` 输出可能与 package.json 不同步。

**修复**：build-time 注入。

### 🟢 P2 — `stele-binary.ts` 版本验证

`packages/mcp-server/src/stele-binary.ts:6`：硬编码期望 `@stele/cli` 版本。需要 follow-up 让 MCP server 不绑死。

---

## 三、Phase B 设计文档承诺 vs 实际状态

逐一对照 `docs/design/phase-b/FINAL-SPEC.md`：

| FINAL-SPEC 承诺 | 实际状态 | 备注 |
|---|---|---|
| B.1 TypeScript only — 三机制完整 | ✅ 完成 | 见 1.1 |
| B.2 Python 加入：pyright daemon + 跨语言 conformance | ❌ 完全未做 | P0 gap：见上文 P0-2 + P0-3 |
| B.3 Go/Java/Rust 独立立项 | ❌ 完全未做 | 文档化为 deferred |
| Worklist + reverse postorder propagation (Round 2 MC-7) | ✅ 实现 | effect-evaluator + trace-evaluator |
| 默认 strict mode (Round 2 D-CG-1) | ✅ 实现 | 所有 evaluator strictMode=true 默认 |
| Unresolved fail-closed (Round 2 D-CG-5) | ✅ effect-evaluator 实现 | trace/type-state 也有不同形式 |
| Suppression CDL-only (Round 2 D-CG-1) | ✅ 实现 | source `@stele:effects.suppress` 被忽略；CDL `(effect-suppression ...)` 必须 reason |
| fix-hint A/B branch (Round 2 MC-15) | ✅ 实现并由 invariant 强制 | FIX_HINT_REQUIRES_ANALYSIS_BRANCH |
| 跨语言 conformance fixture | ❌ 缺失 | P0-3 |
| Phase B 自检契约 | ⚠️ 仅 3 个 invariant，无 trace/type-state/effect 实例 | P0-1 |
| `stele explain effect` 命令 | ✅ 实现 | 但 lenient mode 默认（P1） |
| `--strict-*` / `--lenient-*` CLI flags | ❌ 未实现 | P1 |
| 性能：medium project < 60s | ✅ 8.5s（本仓库 1215 文件） | 远低于预算 |

---

## 四、测试 / 质量盘点

### 4.1 测试 counts

| 包 | tests | 备注 |
|---|---|---|
| @stele/core | 1309 | |
| @stele/call-graph-core | 72 | |
| @stele/trace-evaluator | 89 | |
| @stele/type-state-evaluator | 73 | |
| @stele/effect-evaluator | 116 | |
| @stele/type-driven-evaluator | 31 | |
| @stele/backend-typescript | 385 | |
| @stele/cli | 825 (+1 skipped) | 含 fixture runner 等 |
| **合计 Phase B 相关** | ≈ 2900 | |

### 4.2 预先存在的失败

| 包 | 失败数 | 原因 | 状态 |
|---|---|---|---|
| @stele/backend-python | 10 | pytest 未安装在 env | env 问题，非 Phase B 引入 |
| @stele/cli | 4 | 3× pytest 缺失 + 1× Linux 上跑 Windows path | 同上 |
| @stele/mcp-server | 2 | Linux 上跑 UNC path test | 同上 |
| tests/conformance | 7 | 同上 | 同上 |

总计 23 个 env-related 失败。**这些与 Phase B 改动无关**——Phase B 实施前后失败列表完全一致。

### 4.3 自检 invariant 是否有单元测试？

| Invariant | Python checker 实现 | 单元测试 |
|---|---|---|
| ALL_BACKENDS_COMPILE (Phase A) | self_protection.py | ❌ 仅手动负向测试 |
| ALL_EVALUATORS_COMPILE | self_protection.py | ❌ 仅手动负向测试 |
| STRICT_MODE_DEFAULT_IN_CI | self_protection.py | ❌ 仅手动负向测试 |
| FIX_HINT_REQUIRES_ANALYSIS_BRANCH | self_protection.py | ❌ 仅手动负向测试 |

**P1 follow-up**：给 Python checker functions 加单元测试（在 contract/checker_impls/ 目录或 packages/core/tests/）。手动负向测试不能持续 regression-protect。

### 4.4 fixture runner 的 skip-on-missing-infra 路径

3 个 fixture runner 测试（trace/typestate/effect）有 fallback：infrastructure 未 build 时 skip 而非 fail。当前 infra 全部 build，因此所有 fixture 实际跑过 evaluator。

**潜在风险**：未来如果某个 evaluator 包 build 失败，fixture test 会 silently skip。已经有 `ALL_EVALUATORS_COMPILE` invariant 在 stele check 阶段拦截这种情形，但**单元测试层面**仍可能误报"绿"。

**P2 follow-up**：让 fixture runner 在 STELE_PHASE=phase-b 时 *必须* infrastructure available，否则 fail（防止 silent skip）。

---

## 五、CLI 状态盘点

### 5.1 注册的命令

```
stele baseline-init / baseline-update
stele check               # Phase B 三个 stage 已集成
stele generate
stele lock
stele list / rules
stele explain [id]        # Phase A 老命令
  └─ effect <node-id>     # Phase B 新增 (T5.6)
stele agent-context
stele why <id-or-fingerprint>
stele add-checker <id>
stele propose
  └─ invariant            # Phase A 老命令
stele maintenance-summary
stele observe
stele mcp
stele init
stele dev
stele unlock
stele doc
stele score               # 实现状态未审查
stele complexity          # 实现状态未审查
stele suggest             # 实现状态未审查
stele design
  ├─ init
  ├─ generate
  ├─ check
  ├─ explain <target>
  ├─ diff
  ├─ propose <type>       # type ∈ {invariant, branded-id, aggregate}
  └─ approve
```

### 5.2 Phase B 增加的 CLI surface

仅 `stele explain effect <node-id>` 是 Phase B 新增的子命令。

**Aspirational but not implemented**（应实现或从文档移除）：
- `stele check --strict-effects` / `--lenient-effects`
- `stele check --strict-typestate` / `--lenient-typestate`
- `stele check --strict-trace`
- `stele check --strict-callgraph`
- `stele check --trace-max-depth <N>`
- `stele design propose --trace-policy <id>` (等)

---

## 六、设计文档 / spec 状态

### 6.1 文档覆盖

| 文档 | 状态 |
|---|---|
| `docs/design/phase-b/FINAL-SPEC.md` | ✅ 最终设计稿，含两轮 review |
| `docs/design/phase-b/00-overview.md` ～ `07-cross-language-strategy.md` | ✅ 8 份详细设计文档 |
| `docs/design/phase-b/round-1-*.md` / `round-2-*.md` | ✅ 5 个 reviewer 审查 + 2 个 synthesis |
| `docs/spec/cdl.md` | ✅ Phase B 全部章节添加，含 `Out of scope` 明示 |
| `docs/internal/phase-b-performance-baseline.md` | ✅ 性能基准记录 |
| `docs/internal/post-phase-b-status.md` | ✅ 本文档 |

### 6.2 docs/spec/cdl.md 已 documented gaps

明示 deferred:
- 跨语言 call-graph extractors (Go/Java/Rust)
- `--strict-*` / `--lenient-*` flags
- `stele design propose --trace-policy <id>` 等 flag shapes

### 6.3 内部 gap report

`docs/internal/ddd-typedriven-gap-report.md`（v0.2 时代）—— DDD layer/public-entry not enforced at runtime, DOC-1。Phase B 没消化这个 gap。

---

## 七、潜在攻击面（agent 绕过 Stele 的路径）

### 7.1 已堵的路径

- ✅ 直接编辑 protected files → pre-edit-protect hook 拦截
- ✅ 源码内 `@stele:effects.suppress` JSDoc → evaluator 忽略
- ✅ Stop hook 死循环 → loop guard 第二次释放
- ✅ 多 evaluator 包 build 缺失 → ALL_EVALUATORS_COMPILE 拦截
- ✅ fix-hint 退化为单 [A] 模板 → FIX_HINT_REQUIRES_ANALYSIS_BRANCH 拦截

### 7.2 未完全堵的路径

#### 🔴 7.2.1 — 修改 evaluator dist/ 之外的代码

evaluator 包源代码（`packages/*/src/`）不在 protected glob 内。Agent 可以修改 evaluator 逻辑、删除 violation builder、绕过自己的契约。Stele 假设 evaluator 包是 trusted code。

**修复**：把 evaluator 包源码加入 protected glob？但这阻止合法的功能迭代。需要更精细的"功能内部 vs 安全核心"区分。

#### 🔴 7.2.2 — 修改 fix-hint 文本（保留 [A]/[B] 字符串但移除 propose URL）

`FIX_HINT_REQUIRES_ANALYSIS_BRANCH` 仅检查 5 个 substring。Agent 可以保留 [A]/[B] 但把 `stele design propose` 改成 `rm -rf /`（极端例子）。Check 不会捕到 semantic 篡改。

**修复**：加更严格的 substring 检查（`contract/design/proposals/` 必须出现、`Do NOT edit the contract directly` 必须出现）。

#### 🟡 7.2.3 — 篡改 `.stele/stop-state.json`

Stop state file 不在 protected glob。Agent 可以删除或编辑它来重置 loop guard counter。

**影响**：限制有限——agent 仍需让 Stop hook 跑一次，且 fingerprint 计算不依赖文件，只依赖 stderr/stdout。但**绕过 loop release** 路径存在：agent 故意制造略微不同的 stderr 让 fingerprint 变化。

**修复**：state file 加入 protected glob，或用 audit-only（不依赖 state file 的内容，依赖时间戳序列）。

#### 🟡 7.2.4 — 非 TS 项目的 trace-policy / type-state / effect-policy 静默失效

Python/Go/Java/Rust 项目即便配了三机制，evaluator 输出 warning notice 而非 error，stele check 通过。

**修复**：见 P0-2。

#### 🟡 7.2.5 — `stele explain effect` lenient mode 给 agent 错误情报

见 P1（5.2 节）。

---

## 八、后续工作建议序列（按 ROI 排）

按"花费时间 × 撬动安全/质量"排序：

| # | 工作项 | 工作量 | 杠杆 | 备注 |
|---|---|---|---|---|
| 1 | 给 stele 自己加 5-10 条 trace-policy / effect-policy（dogfood） | 1-2 天 | 巨大 | P0-1；马上能验证 Phase B 在真实代码上的表现 |
| 2 | 给 3 个新自检 invariant 加单元测试 | 0.5 天 | 中 | 防止 silent regression |
| 3 | 非 TS 项目 trace-policy/type-state/effect → 升级为 error (而非 warning notice) | 0.5 天 | 大 | 修复 silent skip 的 fail-open 行为 |
| 4 | 实现 `stele check --lenient-*` flags (或从 contract 删除 STRICT_MODE_DEFAULT_IN_CI 直到 flag 存在) | 1 天 | 中 | 让 invariant 真有意义 |
| 5 | 扩展 `stele design propose <type>` 支持 trace-policy/type-state/effect-policy 4 个新 type | 1-2 天 | 大 | 闭环 propose 流程 |
| 6 | conformance 跨语言 fixture（至少 TS 占位） | 1 天 | 中 | 修 P0-3 |
| 7 | DEFAULT_PROTECTED_PATTERNS 在 core/cli 之间对齐 | 0.5 天 | 中 | 修 P1 |
| 8 | `.stele/stop-state.json` 加入 protected | 0.2 天 | 小-中 | 防 loop guard 篡改 |
| 9 | `stele explain effect --strict` 选项 + 输出标注 | 0.3 天 | 小 | 调研 UX 改善 |
| 10 | Python pyright daemon 集成（B.2 启动） | 4-6 周 | 巨大 | Phase B.2 主体工作 |
| 11 | Go/Java/Rust extractors（B.3） | 6-9 周 | 巨大 | 独立立项 |

**强烈建议**：先做 1-9（约 1 周工作量），它们把 Phase B 从"机制已实现"提升到"自身在用、真正闭环"。然后再 B.2。

---

## 九、附：扫描方法（reproduce）

```bash
# 1. TODO/FIXME
grep -rnE 'TODO|FIXME|XXX|HACK|@todo' --include='*.ts' --include='*.py' packages/ contract/

# 2. 限制声明
grep -rnE 'not yet|follow-?up|deferred|out of scope|planned' --include='*.ts' --include='*.py' --include='*.md' packages/ docs/

# 3. 自身契约 Phase B 实例
grep -cE '^\(trace-policy|^\(type-state |^\(effect-' contract/main.stele

# 4. 跨语言 extractor 实际
ls packages/backend-{python,go,java,rust,typescript}/src/extractors/ 2>&1

# 5. CLI flag 实际
grep -E '\.option\(' packages/cli/src/index.ts | grep -E 'strict|lenient|max-depth'

# 6. conformance fixtures
ls tests/conformance/fixtures/

# 7. Protected patterns 一致性
grep -A 20 'DEFAULT_PROTECTED_PATTERNS\|protected:' packages/core/src/config/defaults.ts packages/cli/src/config/defaults.ts
```

每个 P0/P1/P2 都附带可重现的 grep 或 ls 命令，未来 reviewer 可独立验证状态。

---

## 十、总结

Phase B B.1 阶段（TypeScript only）**机制完整**，但有三类 gap：

1. **自身契约空虚**（P0-1）：未 dogfood 自己的新机制
2. **跨语言断层**（P0-2, P0-3）：仅 TS extractor + 无 conformance
3. **CLI / propose 流程不闭环**（P1）：flag + propose type 缺失

按本文档第八节的优先级序列推进，先做项 1-9（约 1 周），Phase B 才算"在用"。然后 B.2 Python 集成是下一个主体。
