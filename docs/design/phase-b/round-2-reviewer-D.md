# Phase B Design Round 2 Review — Reviewer D (Security + Self-Protection)

视角：验证修订版是否真把"agent 不能绕过契约"覆盖严密。已对照源码（`contract/main.stele`、`contract/checker_impls/self_protection.py`、`packages/cli/src/commands/check-stages-type-driven.ts`、`packages/cli/src/commands/check.ts`、`packages/cli/src/backend-registry.ts`、`packages/cli/src/config/defaults.ts`）核对。

## Critical Security Gaps

### CG-1 (Critical). `--strict-*` opt-in 默认是 warning，自检 CI 无任何强制
修订版要求 effect-suppression / type-state inference failure / unresolved calls 都 gate 在 `--strict-effects` / `--strict-typestate` / `--strict-callgraph` 后。但 04-§五.3 和 03-§四"状态推断失败"明确写默认 lenient/warning，只有 opt-in 才升级 error。**用户 CI 不开 flag，agent 就拿到一整套零成本绕过路径**：

- 任何 type-state 推断不出的函数 → 默认无违例（绕过路径）
- 任何 effect-suppression（CDL 里写一条）→ 默认 warning，CI 绿
- callgraph unresolved → 默认 notice

而设计原则 1 是"机械联锁，不要求人审"。warning ≠ block ≠ mechanical interlock。round-1-reviewer-A 的 C4 反馈仍未真正解决：suppression 不再可从源码触发，但 CDL suppression 默认 warning 同样让契约违例移出热路径。**Stele 自身的 contract（`contract/main.stele`）没有 `--strict-*` 字段或 profile 字段**，自检 CI 会绿，但 agent 在用户项目仍可绕过。

修订版的"safe default"应是 **strict, with explicit `--lenient` opt-out**（而非反过来）。否则 round-1 CI-4 的修订只是把后门从源码搬到 CLI flag。

### CG-2 (Critical). Trace depth cap > 10 静默失效
02-§三.2 写明 path > maxDepth 时 emit warning，不算违例。**这是可被 agent 利用的绕过路径**：agent 写"DB 调 stripe.charge" 时，**故意经过 11 层间接调用**（每层套一个 helper），就让 trace-policy 完全不检查。warning 在 CI 大量噪音中容易被忽略。

修订版承诺"不静默跳过"，但 warning 实际上**就是静默失效**：违例不报。应当：
- depth-cap-exceeded 默认升级到 **error**（block），让 agent 必须显式重构调用链或在 CDL 里加 exempt
- 或者 trace evaluator 把超过 depth 的"未完整检查"视同未检查并 fallback 到 effect-policy 的传递闭包（更鲁棒）

### CG-3 (Critical). Phase B 新包未真正纳入 `ALL_BACKENDS_COMPILE`
源码核对 `contract/checker_impls/self_protection.py` L172-212 的 `all_backends_compile()`：它只迭代 `REGISTERED_BACKENDS`（`packages/cli/src/backend-registry.ts`），仅 5 个 language backend。这个 list 是 stele.config.json `targetLanguage` 路由表，**不是"所有 @stele/* package"的列表**。

round-1 MC-12 说"新包必须 register"，但 05-§十 / 06-§六/§七 都没说**怎么注册**。Phase B 的 `@stele/call-graph-core`、`@stele/trace-evaluator`、`@stele/type-state-evaluator`、`@stele/effect-evaluator`、`@stele/type-driven-evaluator` 不能塞进 `REGISTERED_BACKENDS`（它们没有 `generate()`），但又必须有等价的 dist 检查。**修订版根本没设计这个 checker**。

如果直接把新包加到 `REGISTERED_BACKENDS`，会破坏 `backend_registries()`（L136-149：硬断言 5 个 + 期望集是 `{python, typescript, go, rust, java}`）—— 自检立即 fail。Phase B sub-agent 实施时若不知道这个陷阱，自举链路会断。

**反例验证**：在 `REGISTERED_BACKENDS` 加一行 `@stele/trace-evaluator` → `backend_registries()` 报 "Expected 5 backends, found 6" → `stele check` exit 2 → Phase B 自检立即失效。

### CG-4 (Major). Rule_id stability 测试基于错误前提
05-§四 / round-1 CI-8 说 "Phase A 的 rule_id 是 `type_driven.branded_id.*` / `type_driven.smart_ctor.*`"。**源码核对错误**：`packages/cli/src/commands/check-stages-type-driven.ts:79,133` 实际写的是 `typedriven.branded-id.${b.id}` 和 `typedriven.smart-ctor.${...}` —— **dot+hyphen，不是 underscore**。`packages/cli/src/typescript-shape/branded-ids.ts:7` 也是 `typedriven.shape.branded-id`。

设计文档要求保持的 rule_id 字符串和真实生产的不一致。如果按文档照搬"Phase B 不动 `type_driven.branded_id.*`"，重构后用户 baseline 会全部失效（因为 baseline 实际存储的是 `typedriven.branded-id.*`）。stability test 必须用**真实字符串**断言，否则 test 自身就是错的。

### CG-5 (Major). Effect-policy 自身设计后门
04-§3.3 允许 `(allow-only ())` 表示"任何 effect 都不允许"。**但 effect-annotation 里 agent 写新代码不带 `@stele:effects` 注解 + 推断失败 / unresolved**，effect 集合就是空集，自动满足 `allow-only ()`。绕过：

```python
def fetch_user(id):
    raw_query = getattr(db_session, "query")  # ast.Call 解析为 unresolved
    return raw_query(...)
```

`extractors/calls.py` 把 `getattr().()` 标 unresolved → effect propagation 拿不到 db.read → policy 通过。设计承认 unresolved 不阻塞主流程（01-§七），但**没有把 unresolved → effect-policy fail-closed**。 fail-open 在安全敏感域反 stele 原则。

### CG-6 (Major). 04-§十四 风险表与 §五.3 自相矛盾
04-§五.3 (line 285) 明确写："`--strict-effects` 把 suppression 的存在升级为 **error**"。  
04-§十四 (line 518) 的 risk 表又写："`--strict-effects` 把所有 suppression 升级为 **warning**"。  

两条相反描述并存。Phase B sub-agent 实施时会随便选一条。CI 行为不可预测——这种"文档自身不闭环"在安全设计里是 critical doc-bug。

## Defense Verification

修订版**成功堵住**的路径：
1. 源码内 `@stele:effects.suppress` 注解被完全忽略（04-§五.3 line 284）— OK，agent 无法从源码层面声明 suppression
2. CDL 的 `(effect-suppression ...)` 写在 `contract/**/*.stele` 内，已被 `DEFAULT_CONFIG.protected` (`packages/cli/src/config/defaults.ts:37` `"contract/**/*.stele"`) 覆盖，agent 直接 Edit 会被 pre-edit hook 拒
3. `(effect-suppression ...)` 强制 reason 字段（06-§4.8）— 不能空字符串，验证侧 E0357
4. 06-§九 的新 generated 文件 `contract/generated/effect-policies.stele` 落在 `contract/**/*.stele` glob 内 — 自动被保护
5. type-state fix-hint (03-§六 line 271-273) 正确写明 "Do NOT edit the contract file directly — it is protected"
6. round-1 CI-6 normalize.ts 和 spec.md 的删除清单已补全

## Real Bypass Simulation

场景：用户写好 `(effect-policy NO_IO_IN_UI (target-scope "**/components/**") (forbid db.* http.*))`。agent 接到任务"在 UserCard 加用户数据获取"。逐路径验证：

| 绕过路径 | 修订版是否堵死 | 备注 |
|---|---|---|
| 1. JSDoc `@stele:effects.suppress` | **堵死** | 04-§五.3 evaluator 完全忽略 |
| 2. 在 contract/ 加 `(effect-suppression ...)` | **堵死** | `contract/**/*.stele` 被 protected glob 拦截 |
| 3. db 调用套一层 helper | **没堵死** | effect 通过 call-graph 传播，但若 helper 跨函数边界 + extractor unresolved → effect 丢失 (CG-5) |
| 4. effect-annotation 把 stripe 标 `(annotates render)` | **没堵死** | effect-annotation 在 contract/ 里被保护，但 agent 可以在 propose 流程改契约时滥用——这超出 CI 自检范围，需要 review 流程兜底，但流程不在 Phase B 设计内 |
| 5. 多套 11 层调用栈 > maxDepth | **没堵死 (CG-2)** | trace-policy 超过 depth cap 只 warning，effect-policy 不受 depth 影响所以这里部分缓解，但 trace-policy 仍然绕过 |
| 6. 写 getattr / 动态导入让 callgraph extractor 标 unresolved | **没堵死 (CG-5)** | unresolved 默认不阻塞 |

总结：路径 3/5/6 仍可绕过。Stele 自身 CI 若不强制 `--strict-effects --strict-callgraph --strict-typestate`，agent 知道这三个 flag 的存在后会构造对应绕过。

## Self-Bootstrapping Audit

PR1-PR3 渐进式重构的窗口风险（05-§一.A）：

- **PR1 阶段（双轨保留）**：`CHECK_STAGES` registry 加入但 `check.ts` 仍走硬编码 L153-157。registry-completeness 测试存在但没人调用 registry → test 通过但不证明任何 protective 行为
- **PR2 阶段**：`check.ts` 切到 `runAllStages(registry)`。**此时若 registry 漏一个 stage**（例如 effect-stage 因为 PR2 还没合并），原硬编码 stage 一并消失 → 静默丢失契约覆盖
- 元检查 1 (registry completeness test) 的 `REQUIRED_STAGE_IDS` 在 PR2 阶段必须**包含**"trace/type-state/effect"，但这三 stage 是 Week 3-5 实施的。如果 PR2 排在 Week 1（按 05-§十 的 day 3-4），test 会强制存在不存在的 stage → CI 永远 fail。Plan 文件级冲突 vs registry test 完整性的时序自相矛盾。

建议：`REQUIRED_STAGE_IDS` 必须按 **PR 实际合并版本**动态调整 / 加 `phase` 标签，否则 self-bootstrap test 自己变成 PR 的 blocker。

另外 `runCheck` (check.ts L240-270) 有第二条调用链（`buildRawCheckReport`，programmatic API），同样硬编码。PR2 必须**两处都切**，05-§二 只描述了一处。

## Phase A Compatibility Audit

**Rule_id stability**：
- 文档声称 `type_driven.branded_id.*`（underscore）；实际源码 `typedriven.branded-id.*`（hyphen + dot）。stability test 必须用真实字符串。设计文档要修。
- 新增 `type_driven.type_state.*` / `type_driven.effect.*`（设计文档版本）和真实命名约定（`typedriven.type-state.*` / `typedriven.effect.*`）会**再次造成命名空间分裂**。建议显式选定一种约定。我推荐 `typedriven.{form}.{id}` 保持现有惯例。

**`ALL_BACKENDS_COMPILE` invariant**：见 CG-3。需新增 checker `all_evaluators_compile`，等价 dist 检查覆盖 `@stele/call-graph-core`、`@stele/trace-evaluator`、`@stele/type-state-evaluator`、`@stele/effect-evaluator`、`@stele/type-driven-evaluator`。或者重构 `all_backends_compile` 接受额外 evaluator list（不动 `REGISTERED_BACKENDS`）。

`contract/generated/effect-policies.stele` 自动落入 protected glob `contract/**/*.stele`（已验证 `packages/cli/src/config/defaults.ts:37`），不需要单独加 protected 项。

## Recommended Fixes

1. **CG-1 修正**：将 strict 改为默认行为。新增 `--lenient-effects` / `--lenient-typestate` / `--lenient-callgraph` 作为 opt-out flag。Stele 自身 `contract/main.stele` 增加 invariant `STRICT_MODE_DEFAULT_IN_CI` 自检本仓库 CI 没改 lenient。
2. **CG-2 修正**：trace depth-cap-exceeded 默认 error。若用户场景需要 deep chain，在 CDL 里 `(exempt ... (reason ...))` 显式声明（写在 protected 文件内）。
3. **CG-3 修正**：05-§九 / 06-§六 增加一节明确：
   - 新增 `contract/main.stele` checker `all-evaluators-compile`
   - `contract/checker_impls/self_protection.py` 加 `all_evaluators_compile()`，硬编码 evaluator 包列表
   - 不动 `REGISTERED_BACKENDS`（避免 backend_registries 误判）
4. **CG-4 修正**：05-§四 把 rule_id stability 文档中所有 `type_driven.branded_id.*` 等占位字符串替换为源码真实字符串 `typedriven.branded-id.*` 等。新增的 Phase B rule_id 统一为 `typedriven.{form}.{id}` 格式，不引入 underscore 变体。
5. **CG-5 修正**：04-§五 Step 3 在 policy 评估时，如果 scope 内某 node 含 `unresolvedCalls`，默认 fail（同 strict 模式），输出 fix-hint "无法静态确定此函数的副作用，使用 `(effect-annotation ...)` 显式标注或重构调用为静态可解析形式"。
6. **CG-6 修正**：删除 04-§十四 risk 表中 "升级为 warning" 的过期描述，统一为 error。
7. **Self-bootstrap 修正**：`REQUIRED_STAGE_IDS` 按 PR 排程分级，PR1 不要求 trace/typestate/effect 存在；PR2 时序排到 Week 5 之后；`buildRawCheckReport` 同步切换。
8. **小修**：04-§三.2 `(effect-suppression ...)` 文档应明示"必须写在 protected 的 contract/* 路径下"——目前只隐含。
