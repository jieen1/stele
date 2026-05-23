# Round 3 综合：实施审查关键发现

3 个独立 reviewer (F 设计 vs 实施 / G 安全自我保护 / H 测试质量) 全部完成。

## 严重程度排序

### 🔴 P0 — 必须修复（demonstrated bypasses + spec violations）

| # | 来源 | 问题 | 影响 |
|---|---|---|---|
| **P0-1** | G | **`.stele/**` 不在 protected glob** | Agent 可预填 stop-state.json 绕过 loop guard |
| **P0-2** | G | **`stele check` 不调用 3 个新自检 invariant** — 只有 pytest 才跑 | TS/Go/Rust/Java 用户实际**没有** STRICT_MODE_DEFAULT_IN_CI / ALL_EVALUATORS_COMPILE / FIX_HINT_REQUIRES_ANALYSIS_BRANCH 强制（empirically verified） |
| **P0-3** | G | **`loadConfig()` 用用户 config 替换 default protected** — 不是 union | 项目 `stele.config.json` 没列 hook scripts → agent 可直接编辑 `stop-validate.js`（**完整 kill switch**） |
| **P0-4** | G | **`stele design generate` 写 protected files 无审批检查** | Bash 命令 `stele design generate` 改 3 个 protected 文件，pre-tool-protect 不拦 stele 子命令 |
| **P0-5** | F | **Trace depth-cap-exceeded 硬编码 warning** (`violation-builder.ts:68-70`) | 违反 Round 2 D-CG-2；evaluator 完全无 strictMode 参数 |
| **P0-6** | F | **`(extern-alias ...)` parser 未注册** | resolver 代码存在但 unreachable；跨语言 alias 设计**无法用** |
| **P0-7** | F | **Fix-hint 引用不存在的 `--no-strict-effects` flag** | Agent 试这个 flag 会 commander 报错 |
| **P0-8** | H | **3 个新自检 invariant 无 negative tests** | 仅 happy-path test，无 regression protection |
| **P0-9** | H | **conformance suite 0 个 Phase B fixture** | 跨语言一致性设计承诺无法验证 |

### 🟡 P1 — 强烈建议修复

| # | 来源 | 问题 |
|---|---|---|
| P1-1 | G | ALL_EVALUATORS_COMPILE 被 TS7016 shadowed（stage 顺序） |
| P1-2 | G | FIX_HINT_REQUIRES_ANALYSIS_BRANCH 仅 keyword 检查 — "[A] propose this code change to the contract issue" 会过（semantically inverted） |
| P1-3 | G | STRICT_MODE_DEFAULT_IN_CI 不解析 shell variables / 引用脚本 |
| P1-4 | F | Cross-rule dedup 仅 trace-evaluator 内 — effect/typestate/trace 不共享 also_violates |
| P1-5 | F | Propagation chain depth cap = 5 在 effect-evaluator 未实现 |
| P1-6 | F | direct_effects_on_node / inherited_effects 不是 first-class Violation 字段 |
| P1-7 | H | fixture runner silent-skip 风险（dist 缺失时 console.log + return） |
| P1-8 | F | FIX_HINT_NOT_VAGUE → FIX_HINT_REQUIRES_ANALYSIS_BRANCH 重命名 + severity warning→error 未文档化 |

### 🟢 P2 — Nice to have

| # | 来源 | 问题 |
|---|---|---|
| P2-1 | G | `.stele/stop-state.json` symlink rejection |
| P2-2 | G | HMAC sign stop-state file |
| P2-3 | G | E2E 测试覆盖 STRICT_MODE_DEFAULT_IN_CI 触发路径 |
| P2-4 | H | 自递归 / 多 distinct edges to self 单元测试 |
| P2-5 | H | `(allow-only ())` literal 端到端测试 |
| P2-6 | H | terminal-state method-call 单元测试（非 fixture-driven） |

## 修复 plan（按 ROI 排序）

**Round 1 — 堵住已 demonstrated 的 bypass**（关键，最高优先级）：

1. **P0-3**: 改 `pre-tool-protect.js` 让 `protected` 是 *union* 不是 *replace*；core `DEFAULT_PROTECTED_PATTERNS` 加 hook scripts
2. **P0-1**: `.stele/**` 加入 core `DEFAULT_PROTECTED_PATTERNS` 和 cli `DEFAULT_CONFIG.protected`
3. **P0-2**: `stele check` 必须调用 3 个 self-protection invariants（不只 pytest）

**Round 2 — 修真实 spec violations**：

4. **P0-5**: Trace `depth-cap-exceeded` 默认 severity → error + 加 `strictMode` 参数
5. **P0-6**: 注册 `(extern-alias ...)` parser
6. **P0-7**: 移除 fix-hint 中 `--no-strict-effects` 错误引用
7. **P0-4**: `stele design generate` 加 approval gate

**Round 3 — 补测试 + conformance**：

8. **P0-8**: 加 3 个 self-protection negative tests
9. **P0-9**: 加 2-3 个 Phase B conformance fixtures

**Round 4 — P1 polish**（按需）：

10. **P1-2**: FIX_HINT_REQUIRES_ANALYSIS_BRANCH 改 structural check
11. **P1-1**: ALL_EVALUATORS_COMPILE 重排在 TS7016 之前
12. 其他 P1（cross-rule dedup、propagation depth cap、direct/inherited effects 字段）

**Round 5 — P2**（可选）

## 已验证健康（不需要改）

- 47 fixture tests 真跑（非 silent skip）— H
- fix-hint A/B 关键字 enforcement 三层检查 — H
- worklist + reverse-postorder propagation — F
- 默认 strict mode — F (除 trace depth-cap)
- Suppression CDL-only + (reason) 必填 — F + G
- E0357 enforces (reason "...") — G
- Phase A rule_ids 保持 — F
- Stop hook loop guard 结构正确（但被 P0-1 削弱）— G
- 5 个 trace 约束全工作 — F
- Multi-source transitions — F
- TS phantom-type inference — F
- Test 数完全匹配（1309/72/89/73/116/31/385）— F
- pre-existing failures 是 env 问题，非 Phase B regression — H

## 启动修复

按上述 plan 顺序逐项修复。我会自己做 Round 1（最关键 3 项），Round 2/3/4 用 sub-agent 完成更大块工作。
