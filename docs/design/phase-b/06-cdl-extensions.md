# 06 — CDL 扩展总清单

Phase B 引入的所有 CDL 改动汇总。

## 一、新增 top-level forms

| Form | 文件 | 错误码段 |
| --- | --- | --- |
| `trace-policy` | structure-trace-policy.ts | E0330-E0339 |
| `type-state` | structure-type-state.ts | E0340-E0349 |
| `effect-declarations` | structure-effect.ts | E0350-E0354 |
| `effect-annotation` | structure-effect.ts | E0355-E0357 |
| `effect-policy` | structure-effect.ts | E0358-E0359 |
| `effect-suppression` | structure-effect.ts | E0357-E0358（含 reason 强制）|
| `extern-alias` (Round 1 新增) | structure-extern-alias.ts | E0360-E0364 |
| `type-state-binding` (Round 1 新增) | structure-type-state.ts | E0349-extras |

## 二、删除的 top-level forms

| Form | 原因 |
| --- | --- |
| `agent` | multi-agent 不做（D-B-004） |
| `scope` | 同上 |
| `inter-agent-contract` | 同上 |
| `conflict` | 同上 |

## 三、TOP_LEVEL_DECLARATIONS 最终列表（Round 1 修订）

```typescript
export const TOP_LEVEL_DECLARATIONS = new Set([
  // 元信息
  "metadata",
  "import",
  
  // 算子与规则
  "operator",
  "checker",
  "group",
  "invariant",
  
  // 场景
  "scenario",
  
  // Code Shape（v0.2）
  "boundary",
  "class-shape",
  "function-shape",
  "type-policy",
  "file-policy",
  
  // 架构（v0.2）
  "architecture",
  "core-node",
  
  // Type-Driven（Phase A）
  "branded-id",
  "smart-ctor",
  
  // Phase B 新增
  "trace-policy",
  "type-state",
  "type-state-binding",       // Round 1 新增：显式参数状态标注
  "effect-declarations",
  "effect-annotation",
  "effect-policy",
  "effect-suppression",       // Round 1 修订：CDL-only suppression
  "extern-alias",             // Round 1 新增：跨语言包名映射
]);
```

总计 **22 个顶层 form**（v0.2 的 14 + Phase A 的 2 + Phase B 的 7-1=6，删除 4 multi-agent）。

## 四、各 form 详细 grammar

### 4.1 `(trace-policy ...)`

完整语法：

```cdl
(trace-policy <ID:symbol>
  [(description "<string>")]
  [(severity "error" | "warning")]              ; default: error
  
  ;; 必填：至少 target
  (target "<pattern>" ["<pattern>" ...])
  
  ;; 可选约束（至少一个 must-* 或 deny-*）
  [(must-transit "<pattern>" ["<pattern>" ...])]
  [(must-be-preceded-by "<pattern>" ["<pattern>" ...])]
  [(must-be-followed-by "<pattern>" ["<pattern>" ...])]
  [(deny-direct "<pattern>" ["<pattern>" ...])]
  [(deny-transit "<pattern>" ["<pattern>" ...])]
  
  ;; 可选作用域
  [(scope "<pattern>" ["<pattern>" ...])]
  [(exempt "<pattern>" (reason "<string>"))]   ; 可多次
  
  ;; 可选修复指引
  [(fix-hint "<string>")])
```

Error codes:
- E0330 — trace-policy 缺 id
- E0331 — trace-policy 重复 id
- E0332 — 缺 target
- E0333 — 缺所有约束（must-* / deny-* 至少一个）
- E0334 — exempt 缺 reason
- E0335 — pattern 语法错误
- E0336 — severity 不是 error/warning
- E0337 — 重复字段
- E0338 — 未知字段
- E0339 — 保留

### 4.2 `(type-state ...)`

```cdl
(type-state <ID:symbol>
  (target "<file>::<TypeName>")
  [(description "<string>")]
  [(severity "error" | "warning")]
  
  (states <symbol> [<symbol> ...])
  (initial <symbol>)
  [(terminal <symbol> [<symbol> ...])]
  
  (transition
    (from <state>) (via <method>) (to <state>))
  [(transition ...)]                            ; 可多个
  
  (allowed-ops <state> <method> [<method> ...])
  [(allowed-ops <state> ...)]                   ; 每个 state 一次
  
  [(fix-hint "<string>")])
```

Error codes:
- E0340 — 缺 id
- E0341 — 重复 id
- E0342 — 缺 target / target 格式错（必须 path::TypeName）
- E0343 — states 为空
- E0344 — initial ∉ states
- E0345 — terminal 含非 state
- E0346 — transition.from / .to ∉ states
- E0347 — allowed-ops 的 state ∉ states
- E0348 — 终态在 transition.from 出现（无 allow-terminal-transition）
- E0349 — 未知字段

### 4.3 `(effect-declarations ...)`

```cdl
(effect-declarations
  (effect <name> [(description "<string>")])
  [(effect ...)])                               ; 可多次
```

约束：每文件最多一个 `effect-declarations` 块（集中声明）。多文件均可声明，最终合并去重。

Error codes:
- E0350 — effect name 不符合 dot-notation pattern `[a-z][a-z0-9._-]*`
- E0351 — 同一 file 内有多个 effect-declarations
- E0352 — effect 重复声明
- E0353 — 缺 effect 名
- E0354 — 未知字段

### 4.4 `(effect-annotation ...)`

```cdl
(effect-annotation
  (target "<pattern>" ["<pattern>" ...])
  (annotates <effect> [<effect> ...]))
```

约束：annotates 列表的 effect 必须在 effect-declarations 里声明过（或是 `*` glob）。

Error codes:
- E0355 — 缺 target
- E0356 — 缺 annotates
- E0357 — 引用了未声明的 effect

### 4.5 `(effect-policy ...)`

```cdl
(effect-policy <ID:symbol>
  [(description "<string>")]
  [(severity "error" | "warning")]
  
  (target-scope "<pattern>" ["<pattern>" ...])
  
  ;; forbid / allow-only 二选一
  (forbid <effect> [<effect> ...])
  ;; 或
  (allow-only <effect> [<effect> ...])           ; 空 () = 任何 effect 都不允许
  
  [(fix-hint "<string>")])
```

Error codes:
- E0358 — 同时声明 forbid 和 allow-only
- E0359 — 二者都缺

### 4.6 `(extern-alias ...)`（Round 1 新增）

跨语言包名映射，让 `extern:logical-name::` pattern 在不同语言项目里正确解析到具体包。

```cdl
(extern-alias <logical-name:symbol>
  [(typescript "<npm-package>")]
  [(python "<pip-package>")]
  [(go "<go-module-path>")]
  [(java "<maven-coordinates>")]
  [(rust "<cargo-crate>")])
```

约束：
- logical-name 必须 lowercase + kebab-case + 起始字母
- 至少一个语言别名
- 同一 logical-name 全项目唯一
- pattern 中 `extern:<logical-name>::*` 自动经此别名表展开到当前项目语言的实际包名

例：

```cdl
(extern-alias stripe
  (typescript "stripe")
  (python "stripe")
  (rust "stripe-rust")
  (java "com.stripe:stripe-java")
  (go "github.com/stripe/stripe-go/v74"))

(extern-alias django-db
  (python "django.db"))

(extern-alias gorm
  (go "gorm.io/gorm"))
```

Preset：`@stele/preset-aliases/common.stele` 提供常见库（typeorm/prisma/django.db/sqlalchemy/gorm/jdbc/hibernate/diesel/sea-orm/stripe/alipay/paypal）的预制 alias。用户 `(import "@stele/preset-aliases/common.stele")` 一行复用。

Error codes:
- E0360 — extern-alias 缺 logical-name
- E0361 — logical-name 不符合 kebab-case
- E0362 — 至少一个语言别名缺失
- E0363 — 重复 logical-name
- E0364 — 未知字段

### 4.7 `(type-state-binding ...)`（Round 1 新增）

显式标注函数参数的 type-state 状态。用于跨函数边界传播时给 evaluator 提示。

```cdl
(type-state-binding
  (function "<NodeId>")
  (param <index> state <state>)
  [(param <index> state <state>)])
```

例：

```cdl
(type-state-binding
  (function "src/order/handler.ts::OrderHandler::process(1)")
  (param 0 state Submitted))
```

声明 `OrderHandler.process` 第 0 个参数必须是 Submitted 状态。evaluator 在分析 process 内部对参数的操作时，把它当 Submitted 处理。

### 4.8 `(effect-suppression ...)`（Round 1 修订强化）

CDL-only suppression。**强制 `(reason "...")`**。

```cdl
(effect-suppression
  (target "<NodeId>")
  (suppresses <effect> [<effect> ...])
  (reason "<non-empty string>")
  [(severity "warning" | "error")])
```

默认 severity = "warning"。`--strict-effects` 把 active suppression 升级为 error。

约束：
- target 必须解析到 CallGraph node
- reason 不能为空（E0357）
- 源码内的 `@stele:effects.suppress` 注解被 **忽略**（不是 deprecated，是 ignored）

## 五、Validator 跨 form 校验

### 5.1 NodeId pattern 语法校验

所有 pattern 共享 NodeId glob 语法（见 `01-call-graph-extractor.md` §三）。新增 `packages/core/src/validator/structure-pattern.ts`：

```typescript
export interface ParsedPattern {
  rawText: string;
  isGlob: boolean;
  pathGlob?: string;        // "src/db/**"
  symbolGlob?: string;      // "Repository::find"
  arityConstraint?: number; // 5
  isExtern: boolean;        // extern:* 前缀
  externPackage?: string;
}

export function parsePattern(text: string): ParsedPattern | null;
```

trace-policy / effect-annotation 等所有用 pattern 的 form 通过此函数预校验。

Error code: E0335 — pattern syntax error.

### 5.2 跨 form 引用一致性

- effect-policy 的 forbid/allow-only effect 名 必须在 effect-declarations 声明
- type-state 的 transition.via method 名 应该是 target 类型的方法（可选 warning）

### 5.3 形态间冲突检查

- 同一 (target, scope) 不同 effect-policy 冲突时报 warning（一个 forbid X、一个 allow X）
- 同一 target type 多个 type-state declaration 是 error（一个类型只能有一个状态机）
- 同一 trace-policy id 重复 → error

## 六、Parser dispatcher 改动

`packages/core/src/validator/structure-parse.ts` 的 switch 增删：

```typescript
// 删除
case "agent":
case "scope":
case "inter-agent-contract":
case "conflict":
  // 删除这 4 个 case 和对应 push 操作

// 新增
case "trace-policy":
  tracePolicies.push(parseTracePolicyDeclaration(file.path, node));
  break;
case "type-state":
  typeStates.push(parseTypeStateDeclaration(file.path, node));
  break;
case "effect-declarations":
  if (effectDeclarations !== undefined) {
    throw validationError("E0351", "...", node.span, ...);
  }
  effectDeclarations = parseEffectDeclarationsBlock(file.path, node);
  break;
case "effect-annotation":
  effectAnnotations.push(parseEffectAnnotationDeclaration(file.path, node));
  break;
case "effect-policy":
  effectPolicies.push(parseEffectPolicyDeclaration(file.path, node));
  break;
```

## 七、Contract 类型扩展

`packages/core/src/validator/structure-types.ts`：

```typescript
// 删除字段（multi-agent）：
//   agents, scopes, interAgentContracts, conflicts

// 新增字段：
export interface Contract {
  // ...（保留 v0.2 + Phase A 全部字段）
  
  tracePolicies: TracePolicyDeclaration[];
  typeStates: TypeStateDeclaration[];
  effectDeclarations: EffectDeclarationsBlock | undefined;  // 多文件合并后
  effectAnnotations: EffectAnnotationDeclaration[];
  effectPolicies: EffectPolicyDeclaration[];
}

// ContractFile 同步加上述字段
```

## 八、Uniqueness 检查

`packages/core/src/validator/uniqueness.ts`：

新增检查：
- trace-policy.id 全项目唯一
- type-state.id 全项目唯一
- type-state.target 全项目唯一（一个类型只能有一个状态机）
- effect-policy.id 全项目唯一

删除检查：
- agent.id / inter-agent-contract.id 等（已删除的 form）

## 九、design-generator 输出

`contract/generated/` 目录将产出**两个文件**（而非现在的一个）：

```
contract/generated/
├─ ddd-typedriven.stele        # 现有：architecture / core-node / branded-id / smart-ctor / context-map / type-state
└─ effect-policies.stele       # NEW：effect-declarations / effect-annotation / effect-policy
```

理由：
- effect 配置可能很长（项目有几十个 effect）
- 拆开文件让 git diff 更清晰
- type-state 与 architecture / branded-id 概念紧密，留在同文件

design-generator 主入口：

```typescript
// packages/cli/src/design-generator/render-stele.ts (主入口)
export function renderAllDeclarations(profile: NormalizedProfile): {
  dddTypedriven: string;        // architecture + core-node + branded-id + smart-ctor + type-state + context-map
  effectPolicies: string;       // effect-declarations + effect-annotation + effect-policy
  tracePolicies?: string;        // trace-policy（可选独立文件，详情见 §十）
}
```

## 十、trace-policy 放哪？

trace-policy 是项目级架构规则，与 architecture / code-shape 同维度。可选两种组织：

**选项 A**：留在 `contract/main.stele`（人工写）。
**选项 B**：放 `contract/generated/trace-policies.stele`（profile 驱动生成）。

**Phase B 决策**：先选 **A**。Trace-policy 是项目级架构决策，由人在 main.stele 显式编写。等使用增多再考虑 profile-yaml 驱动。

profile.yaml 暂不引入 `trace.policies[]` 字段。

## 十一、Spec 文档更新

`docs/spec/cdl.md` 必须在 Phase B PR 中同步更新：

- 新增章节：Trace-Based Policy / Type State / Effect System
- 删除章节：Multi-Agent forms（移到 deprecation history）
- 错误码表更新：E0330-E0359 加入

按 CLAUDE.md 规则："Don't add a new top-level CDL form, operator, or error code without updating `docs/spec/cdl.md` in the same change."

## 十二、版本号

CDL 形态版本 bump 到 0.2（从 0.1）。已有 .stele 文件不需要改 `(stele-version "0.1")` —— 向后兼容（不引入 breaking change，只是加新 form）。

但 manifest hash schema 不变（仍 SHA-256）—— 这是用户契约级别的稳定性承诺。
