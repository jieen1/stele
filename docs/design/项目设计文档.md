# Stele 项目设计文档

> **版本**：v0.1（设计稿）
> **日期**：2026-05-04
> **状态**：设计待评审，未启动实现

---

## 目录

1. 项目愿景与定位
2. 核心理念
3. 整体架构
4. CDL 语言规范（Contract Definition Language）
5. 核心引擎设计
6. Stele CLI 设计
7. Claude Code 插件设计
8. 安全模型
9. 项目结构与代码组织
10. 分发与版本策略
11. 多语言扩展机制
12. 路线图
13. 与现有工具的关系
14. 开放问题
15. 附录

---

## 1. 项目愿景与定位

### 1.1 我们要解决的问题

AI 协作开发软件正在成为常态。但 AI 作为**不可靠执行者**有几个根本特性：

- 写代码自信，但对项目的隐性约定无知
- 修复 bug 时可能破坏其他不变量
- 测试通过 ≠ 业务规则成立
- 没有职业自觉，约束只能靠结构强制

**结果**：在 AI 主导的项目中，业务规则需要被显式表达、被强制验证、被结构性保护——而不是依赖 AI"理解后遵守"。

### 1.2 Stele 的定位

Stele 是一个**契约管理框架**，给 AI 协作的项目提供"刻在石头上的规则"：

- 项目的核心业务不变量被显式表达为 **CDL（Contract Definition Language）**
- CDL 文件是 agent 物理上不能修改的事实源
- 由 CDL 自动生成测试代码，确保任何代码变更都不能破坏契约
- 提供一系列工具，让 AI 在工作时主动遵守契约

它的角色类比：

- 在 Redux 中，**RTK** 是封装好的最佳实践
- 在 AI 协作中，**Stele** 是封装好的契约管理基础设施

### 1.3 目标用户

- 用 Claude Code（或类似工具）让 AI 写代码的开发者
- 想要在 AI 协作下保持系统可靠性的团队
- 项目规模从小到大都适用——但收益随项目复杂度增长

### 1.4 不是什么

明确边界，避免误解：

- **不是测试框架**——不替代 pytest/jest，是在它们之上的契约层
- **不是 linter**——不做代码风格检查
- **不是 CI 系统**——不替代 GitHub Actions 等
- **不是替代代码 review**——不审查代码质量
- **不是 AI 模型**——不和 OpenAI/Anthropic 等模型直接交互
- **不是通用约束系统**——专注于业务不变量，不是任意运行时检查

### 1.5 设计原则总览

整个项目贯穿以下原则（详见各章节）：

1. **结构强制优于自觉遵守**——所有约束必须能被物理强制
2. **声明式优于命令式**——CDL 表达"是什么"，不表达"怎么做"
3. **解析时优于运行时**——错误尽早发现
4. **核心稳定，扩展通过注册**——语法不变，能力通过注册扩展
5. **AI 写得稳定优于人写得舒服**——这是 AI 协作工具的特点
6. **可逆性优于完美预防**——支持回退、不一锤子买卖

---

## 2. 核心理念

### 2.1 三层防护

Stele 通过三层叠加机制实现"AI 不能违反契约"：

**第一层：契约定义（CDL）**
- 业务规则用 CDL 显式声明
- 文件位于受保护路径，agent 物理上无法修改

**第二层：自动生成测试**
- CDL 被翻译成目标语言的测试代码
- 生成的测试也受保护，agent 不能修改
- 任何代码变更通过测试守门

**第三层：行为拦截**
- Claude Code 插件通过 hook 拦截危险行为
- 直接修改契约文件的尝试被立即阻止
- agent 无论怎么"努力"都绕不过

三层缺一不可：

- 没有第一层，规则不存在
- 没有第二层，规则没有牙齿
- 没有第三层，agent 可能"创造性"绕过

### 2.2 事实源唯一性

**所有契约的唯一权威来源是 `.stele` 文件 + checker 实现代码**。

- 测试代码是派生物（自动生成）
- 文档是派生物（自动生成）
- 配置是派生物（自动生成）

只有事实源被人或受控流程修改。其他所有产物在 CI 或本地工具运行时被重新生成。如果生成结果和当前仓库内容不一致，CI 失败——这保证派生物永远忠实于事实源。

### 2.3 边界三角

Stele 在系统中划分三类区域：

```
受保护事实源              派生物                 普通代码
(human + agent edits)    (auto-generated)       (agent edits freely)
       │                        │                      │
   .stele 文件             tests/contract/         src/
   contract_checkers/      docs/contract/          tests/regular/
                                                   ...
```

- **受保护事实源**：通过 hook + CI 双重保护，agent 不能改
- **派生物**：生成器自动管理，agent 不能改
- **普通代码**：agent 自由工作

边界由路径定义，工具强制执行。

### 2.4 为 AI 而设计的语言

CDL 不是为人体工程学优化的，是**为 AI 生成稳定性优化的**：

- S-表达式语法极简，AI 几乎不出语法错
- 词汇受限，AI 不能"发挥创造力"
- 强类型严校验，写错立即报错
- 同一约束的不同写法被规范化为相同形态

这与传统 DSL 设计不同——传统 DSL 优化"人写得舒服"，CDL 优化"AI 写得稳定"。

---

## 3. 整体架构

### 3.1 分层

```
┌───────────────────────────────────────────────────────────┐
│  Layer 4: IDE/Tool 适配层（IDE-specific Adapters）        │
│  ┌──────────────────┐  ┌──────────────┐  ┌────────────┐   │
│  │ Claude Code 插件  │  │ Cursor 插件   │  │ ... future │   │
│  └────────┬─────────┘  └──────┬───────┘  └─────┬──────┘   │
└───────────┼──────────────────┼─────────────────┼──────────┘
            │                  │                 │
            └──────────┬───────┴─────────────────┘
                       ▼
┌──────────────────────────────────────────────────────────┐
│  Layer 3: Stele CLI（用户/CI 直接调用）                  │
│  - stele init                                            │
│  - stele check                                           │
│  - stele generate                                        │
│  - stele lock                                            │
│  - stele dev (watch mode)                                │
└─────────────────────┬────────────────────────────────────┘
                      ▼
┌──────────────────────────────────────────────────────────┐
│  Layer 2: 核心引擎（Core Engine）                        │
│  ┌──────────────┐  ┌────────────┐  ┌────────────────┐   │
│  │ Parser       │  │ Validator  │  │ Generator      │   │
│  └──────────────┘  └────────────┘  └────────────────┘   │
│  ┌──────────────┐  ┌────────────┐  ┌────────────────┐   │
│  │ Registry     │  │ Manifest   │  │ Runtime        │   │
│  └──────────────┘  └────────────┘  └────────────────┘   │
└─────────────────────┬────────────────────────────────────┘
                      ▼
┌──────────────────────────────────────────────────────────┐
│  Layer 1: 语言后端（Language Backends，pluggable）        │
│  ┌──────────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ Python (pytest)  │  │ TS (jest)*   │  │ Go*        │  │
│  └──────────────────┘  └──────────────┘  └────────────┘  │
│                                          *未来支持        │
└──────────────────────────────────────────────────────────┘
```

### 3.2 各层职责

**Layer 1: 语言后端**
- 把 CDL AST 节点翻译成目标语言的代码片段
- 每个后端是一个 TypeScript 包，注册到核心引擎
- 后端必须是纯函数：相同 AST 永远产生相同代码

**Layer 2: 核心引擎**
- CDL 文件的解析、校验
- 操作符注册表、checker 注册表
- 测试生成的协调
- 受保护文件的 manifest 管理
- 运行时执行器（在生产环境直接验证 CDL）

**Layer 3: Stele CLI**
- 用户和 CI 系统的统一入口
- 包装核心引擎的命令行接口
- 提供 dev 模式（watch 文件变化）

**Layer 4: IDE 适配层**
- Claude Code 插件：hooks + commands + subagents + skills
- Cursor 插件（未来）
- 其他 IDE 插件

### 3.3 数据流

**典型用户流程**：

```
1. 用户运行 stele init
   → CLI 启动 init 流程
   → 引擎扫描项目，建议初始 CDL 结构
   → 用户审核并确认
   → CDL 文件写入受保护路径

2. AI agent 在 Claude Code 中工作
   → 每次工具调用，hook 拦截
   → 检查目标路径是否受保护
   → 受保护 → 阻止；普通 → 放行
   → 工作结束，hook 触发 stele check
   → 校验失败 → 阻止结束，要求 agent 修复

3. CI 运行 stele check
   → 引擎重新生成派生物
   → 比对当前仓库内容
   → 不一致 → 失败
   → 一致 → 通过
```

### 3.4 跨进程边界的设计原则

由于核心引擎是 Node.js，目标语言生成的代码可能是 Python、TS、Go 等，不同的进程之间需要清晰边界：

- **核心引擎不执行目标语言代码**——只生成代码字符串
- **目标语言运行时（如 pytest）执行测试**——通过标准接口调用 checker
- **checker 实现语言可以和测试语言不同**——通过子进程或 IPC

这种解耦让 Stele 本身保持单一技术栈（TS），但能管理任意语言的项目。

---

## 4. CDL 语言规范

> 本章是契约语言的完整规范。实现层必须严格遵守。

### 4.1 文件格式

- **扩展名**：`.stele`
- **编码**：UTF-8（必须）
- **语法基础**：S-表达式

### 4.2 词法规则

**Token 类型**：

- **标识符（Identifier）**：`[a-zA-Z_][a-zA-Z0-9_-]*`
  - 例：`account`、`INV_001`、`balance-check`
  
- **关键字（Keyword）**：以 `:` 开头的标识符
  - 例：`:critical`、`:high`
  
- **字符串（String）**：用双引号包裹，支持转义
  - 例：`"账户总值等于持仓加现金"`
  - 转义：`\"`、`\\`、`\n`、`\t`、`\r`
  
- **数字（Number）**：整数或浮点
  - 例：`42`、`-3.14`、`0.001`、`1e-9`
  
- **括号**：`(` 和 `)` 用于列表
  
- **注释**：`;` 到行尾

**词法约束**：

- 不允许单引号字符串
- 不允许其他 Lisp 方言中的 `#`、`'`、` ` `（quote、quasiquote）
- 不允许多行字符串（每个字符串必须单行）

### 4.3 语法规则

```ebnf
File          = TopLevel*
TopLevel      = Metadata | Import | Operator | Checker | Group | Invariant
Metadata      = "(" "metadata" Field+ ")"
Import        = "(" "import" String ")"
Operator      = "(" "operator" Identifier OperatorBody ")"
Checker       = "(" "checker" Identifier CheckerBody ")"
Group         = "(" "group" Identifier Description Invariant+ ")"
Invariant     = "(" "invariant" Identifier InvariantBody ")"
InvariantBody = Severity Description ((Assert | UsesChecker) | OptionalField)*

Expression    = Atom | List
Atom          = Identifier | Keyword | String | Number
List          = "(" Operator Expression* ")"
```

完整 EBNF 见附录 A。

### 4.4 顶层声明

CDL 文件中只允许以下顶层声明：

| 声明 | 用途 | 出现次数 |
|------|------|----------|
| `metadata` | 文件元数据 | 0 或 1 |
| `import` | 引入其他文件 | 0 或多 |
| `operator` | 注册项目级操作符 | 0 或多 |
| `checker` | 注册 checker | 0 或多 |
| `group` | invariant 分组 | 0 或多 |
| `invariant` | 不变量定义 | 0 或多 |

任何其他顶层表达式 → 解析错误。

### 4.5 Metadata

```lisp
(metadata
  (stele-version "0.1")
  (project "crypto-pms")
  (description "PMS 系统核心契约")
  (last-updated "2026-05-04")
  (target-language python)
  (test-framework pytest))
```

**字段**：

- `stele-version`（必填）：CDL 版本号，工具据此选择解析规则
- `project`（必填）：项目标识
- `target-language`（必填）：默认目标语言，可被命令行覆盖
- `test-framework`（可选）：测试框架
- 其他字段可选

### 4.6 Invariant 完整结构

```lisp
(invariant <ID>
  (severity <level>)              ; 必填
  (description <string>)          ; 必填
  
  ;; 二选一
  (assert <expression>)
  (uses-checker <checker-id> <args>?)
  
  ;; 可选
  (category <category>)
  (tags <tag1> <tag2>...)
  (when <condition>)
  (tolerance <value>)
  (depends-on <inv-id>...)
  (rationale <string>)
  (since <version-or-date>)
  (applies-to <scope>))
```

#### 4.6.1 ID

- 类型：标识符
- 必须全局唯一（跨所有 import 的文件）
- 命名建议：`<DOMAIN>_<NUMBER>` 或 `<DOMAIN>_<DESCRIPTOR>`
- 创建后不应修改

#### 4.6.2 severity

固定 4 级（不可扩展）：

| 等级 | 含义 | 运行时行为 |
|------|------|-----------|
| `critical` | 数据损坏、资金错误、合规问题 | 立即阻断 |
| `high` | 功能错误 | 必须修复才能合并 |
| `medium` | 体验问题、潜在风险 | 合理时间内修复 |
| `low` | 不影响主流程 | 改进项 |

#### 4.6.3 description

- 字符串，1-2 句话
- 描述"保护什么"，不描述"怎么实现"
- 推荐 ≤ 200 字符

#### 4.6.4 assert

直接用 CDL 表达式声明约束。

```lisp
(assert
  (eq (path account total)
      (add (sum (collection positions) (path value))
           (path account cash))))
```

详见 4.7 表达式语言。

#### 4.6.5 uses-checker

引用注册的 checker。

```lisp
(uses-checker rebalance_value_conservation)

;; 或带参数
(uses-checker price_within_bounds
  (args (max-deviation 0.05)))
```

详见 4.8 Checker 机制。

#### 4.6.6 category（可选）

预定义分类（语言核心保留）：

- `data-integrity`
- `state-consistency`
- `temporal`
- `referential`
- `business-rule`
- `security`
- `performance`

项目可在 metadata 中扩展更多分类。

#### 4.6.7 tags（可选）

任意标签。例：`(tags critical-path payment regulatory)`

#### 4.6.8 when（可选）

约束的启用条件。

```lisp
(when (eq (env) production))
(when (modified (path account balance)))
```

如果未指定，约束总是启用。

#### 4.6.9 tolerance（可选）

数值容差。

```lisp
(tolerance 0.01)              ; 绝对容差
(tolerance (relative 0.001))  ; 相对容差（千分之一）
```

#### 4.6.10 depends-on（可选）

声明依赖的其他 invariant。

```lisp
(depends-on ACCT_001 SYNC_BASE_001)
```

用途：
- 校验顺序
- 失败诊断
- 文档生成

#### 4.6.11 rationale（强烈推荐）

为什么有这条约束。给未来的人和 AI 看的注释。

```lisp
(rationale "防止 2025 年 7 月生产事故复发：当时同步任务覆盖了未结算订单的状态")
```

#### 4.6.12 since（可选）

引入版本或日期。

#### 4.6.13 applies-to（可选）

约束的作用域。

```lisp
(applies-to (env production))
(applies-to (module "account-service"))
(applies-to (always))           ; 默认
```

### 4.7 表达式语言

#### 4.7.1 类型系统

| 类型 | 描述 |
|------|------|
| `Number` | 数字（不区分整数/浮点） |
| `String` | 字符串 |
| `Boolean` | 布尔 |
| `Path` | 数据路径 |
| `Collection` | 集合 |
| `Predicate` | 谓词（返回 Boolean） |
| `TimeRange` | 时间范围 |
| `Symbol` | 符号（用于变量绑定） |

类型在解析时静态检查。

#### 4.7.2 核心操作符（v0.1 必须支持）

**数据访问**

| 操作符 | 签名 | 说明 |
|--------|------|------|
| `path` | `(path Symbol+) -> Path` | 数据路径 |
| `field` | `(field Path Symbol) -> Path` | 字段访问 |
| `collection` | `(collection Symbol) -> Collection` | 集合引用 |
| `value` | `(value Any) -> Any` | 字面量 |

**比较运算**

| 操作符 | 签名 | 说明 |
|--------|------|------|
| `eq` | `(eq Any Any) -> Boolean` | 等于（类型必须一致） |
| `neq` | `(neq Any Any) -> Boolean` | 不等于 |
| `gt` | `(gt Number Number) -> Boolean` | 大于 |
| `gte` | `(gte Number Number) -> Boolean` | 大于等于 |
| `lt` | `(lt Number Number) -> Boolean` | 小于 |
| `lte` | `(lte Number Number) -> Boolean` | 小于等于 |
| `in` | `(in Any Collection) -> Boolean` | 元素在集合中 |
| `matches` | `(matches String String) -> Boolean` | 字符串匹配正则 |

**算术运算**

| 操作符 | 签名 | 说明 |
|--------|------|------|
| `add` | `(add Number Number+) -> Number` | 加 |
| `sub` | `(sub Number Number) -> Number` | 减 |
| `mul` | `(mul Number Number+) -> Number` | 乘 |
| `div` | `(div Number Number) -> Number` | 除 |
| `neg` | `(neg Number) -> Number` | 取负 |
| `abs` | `(abs Number) -> Number` | 绝对值 |

**集合聚合**

| 操作符 | 签名 | 说明 |
|--------|------|------|
| `sum` | `(sum Collection Path?) -> Number` | 求和 |
| `count` | `(count Collection) -> Number` | 计数 |
| `avg` | `(avg Collection Path?) -> Number` | 平均值 |
| `min` | `(min Collection Path?) -> Number` | 最小值 |
| `max` | `(max Collection Path?) -> Number` | 最大值 |
| `distinct` | `(distinct Collection Path?) -> Collection` | 去重 |

**量词**

| 操作符 | 签名 | 说明 |
|--------|------|------|
| `forall` | `(forall Symbol Collection Predicate) -> Boolean` | 全称 |
| `exists` | `(exists Symbol Collection Predicate) -> Boolean` | 存在 |
| `none` | `(none Symbol Collection Predicate) -> Boolean` | 不存在 |

**逻辑**

| 操作符 | 签名 | 说明 |
|--------|------|------|
| `and` | `(and Predicate+) -> Boolean` | 与 |
| `or` | `(or Predicate+) -> Boolean` | 或 |
| `not` | `(not Predicate) -> Boolean` | 非 |
| `implies` | `(implies Boolean Boolean) -> Boolean` | 蕴含 |
| `iff` | `(iff Boolean Boolean) -> Boolean` | 当且仅当 |

**条件**

| 操作符 | 签名 | 说明 |
|--------|------|------|
| `when` | `(when Boolean Predicate) -> Boolean` | 条件检查 |
| `if` | `(if Boolean Any Any) -> Any` | 条件表达式 |

**时序**

| 操作符 | 签名 | 说明 |
|--------|------|------|
| `within` | `(within Event Duration) -> Boolean` | 时间内 |
| `after` | `(after Event Event) -> Boolean` | 在...之后 |
| `before` | `(before Event Event) -> Boolean` | 在...之前 |
| `modified` | `(modified Path) -> Boolean` | 路径被修改 |
| `state-before` | `() -> State` | 操作前状态 |
| `state-after` | `() -> State` | 操作后状态 |

**引用完整性**

| 操作符 | 签名 | 说明 |
|--------|------|------|
| `exists-in` | `(exists-in Any Collection) -> Boolean` | ID 存在于集合 |
| `unique` | `(unique Collection Path?) -> Boolean` | 集合元素唯一 |
| `not-null` | `(not-null Path) -> Boolean` | 路径值非空 |

#### 4.7.3 操作符注册表

操作符不是写死在解析器中，而是注册在一个表中：

```typescript
type OperatorSpec = {
  name: string;
  arity: number | 'variadic';
  argTypes: Type[];
  returnType: Type;
  description: string;
  // 翻译到各语言后端
  translations: {
    [language: string]: TranslationTemplate;
  };
};
```

核心操作符在引擎初始化时注册。项目级操作符通过 `(operator ...)` 声明注册。

### 4.8 Checker 机制

#### 4.8.1 Checker 注册

```lisp
(checker rebalance_value_conservation
  (description "调仓前后总市值变化等于交易费用之和")
  (signature
    (input
      (state-before Snapshot)
      (state-after Snapshot)
      (transactions Collection))
    (output Boolean))
  (implementation
    (language python)
    (path "contract_checkers/rebalance_value_conservation.py")
    (function "check"))
  (checksum "sha256:..."))
```

#### 4.8.2 Checker 实现要求

无论用什么语言写：

- **纯函数性**：相同输入产生相同输出
- **确定性**：不依赖时间、随机、外部状态
- **可独立调用**：能被测试框架直接调用
- **幂等性**：多次调用结果一致

#### 4.8.3 Python Checker 实现规约（v0.1）

文件位置：`contract/checker_impls/<checker_id>.py`

约定的函数签名：

```python
def check(inputs: dict) -> dict:
    """
    Args:
        inputs: 字典，键对应 signature 中声明的 input 名
    
    Returns:
        {
            "passed": bool,
            "message": str | None,  # 失败原因
            "context": dict | None  # 额外上下文（可选）
        }
    """
```

引擎在生成测试代码时，会自动生成调用这个函数的代码。

### 4.9 Group 与 Import

**Group**：组织相关 invariant

```lisp
(group account-balance-consistency
  (description "账户余额一致性约束")
  
  (invariant ACCT_001 ...)
  (invariant ACCT_002 ...))
```

**Import**：模块化

```lisp
(import "modules/account.stele")
(import "modules/sync.stele")
```

规则：
- 路径相对当前文件
- 循环导入禁止
- 合并后命名空间中所有 ID 唯一

### 4.10 解析与校验流程

完整流程：

1. **词法分析** → token 流
2. **语法分析** → AST
3. **结构验证**：每个顶层声明合法
4. **import 解析**：递归加载所有引用文件
5. **操作符注册**：处理 `(operator ...)` 声明
6. **Checker 注册**：处理 `(checker ...)` 声明，验证文件存在
7. **类型检查**：每个表达式参数类型匹配
8. **引用验证**：所有 checker 引用存在
9. **依赖验证**：depends-on 的 ID 存在
10. **唯一性验证**：所有 ID 全局唯一

任何步骤失败 → 立即报错，包含位置和上下文。

### 4.11 错误信息规约

错误信息格式：

```
[Stele Error <code>] <category>: <one-line-summary>
  File: <path>:<line>:<column>
  
  <source-code-snippet-with-pointer>
  
  Detail: <full-explanation>
  Hint: <suggestion>
```

例：

```
[Stele Error E0042] Type Mismatch: 'eq' expects matching types
  File: contract/account.stele:12:8
  
    11 |   (assert
    12 |     (eq (path account total) "100"))
       |         ^^^^^^^^^^^^^^^^^^^^ Number
       |                              ^^^^^ String
  
  Detail: Operator 'eq' requires both arguments to have the same type,
          but got Number and String.
  Hint: Did you mean (eq (path account total) 100)?
        Or did you intend (eq (path account total-formatted) "100")?
```

### 4.12 规范化（Normalization）

每个解析后的 CDL 文件可以输出**规范化形式**：

- 字段顺序固定
- 空白标准化
- 等价表达式归一化（如可交换运算的参数排序）

**目的**：让"内容相同的两份 CDL"产生**逐字节相同**的规范化输出。这给"事实源不被篡改"提供硬保证。

---

## 5. 核心引擎设计

### 5.1 模块组织

```
@stele/core/
├── lexer/              ; 词法分析
├── parser/             ; 语法分析  
├── ast/                ; AST 数据结构
├── validator/          ; 校验器
│   ├── structure.ts
│   ├── types.ts
│   ├── references.ts
│   └── uniqueness.ts
├── registry/
│   ├── operators.ts    ; 操作符注册表
│   └── checkers.ts     ; checker 注册表
├── normalizer/         ; 规范化
├── manifest/           ; 清单 + 校验和
├── generator/          ; 生成器协调
│   └── coordinator.ts
└── index.ts            ; 公共 API
```

### 5.2 核心 API

```typescript
// 加载和校验 CDL
async function loadContract(rootPath: string): Promise<Contract>;

// 生成测试
async function generateTests(
  contract: Contract,
  language: string,
  framework: string,
  outputDir: string
): Promise<GenerationResult>;

// 校验：当前生成产物是否与契约一致
async function verifyGenerated(
  contract: Contract,
  generatedDir: string
): Promise<VerificationResult>;

// 计算并写入 manifest
async function writeManifest(
  protectedPaths: string[],
  manifestPath: string
): Promise<void>;

// 验证 manifest（用于 CI 检测篡改）
async function verifyManifest(
  manifestPath: string
): Promise<VerificationResult>;
```

### 5.3 Manifest 格式

`manifest.json`（项目根目录的受保护位置）：

```json
{
  "version": "1",
  "generated_at": "2026-05-04T10:00:00Z",
  "stele_version": "0.1.0",
  "protected_files": {
    "contract/main.stele": {
      "sha256": "abc123...",
      "size": 1234
    },
    "contract/checker_impls/rebalance_value_conservation.py": {
      "sha256": "def456...",
      "size": 567
    },
    "tests/contract/test_account_consistency.py": {
      "sha256": "...",
      "size": ...
    }
  },
  "contract_hash": "..."  
}
```

`contract_hash` 是所有 CDL 文件规范化形式的合并哈希，用于快速判断契约是否有变。

### 5.4 语言后端接口

```typescript
interface LanguageBackend {
  name: string;              // "python"
  framework: string;         // "pytest"
  fileExtension: string;     // ".py"
  
  // 把单个表达式翻译成语言代码
  translateExpression(expr: ASTNode, ctx: TranslationContext): string;
  
  // 把单个 invariant 翻译成测试函数
  translateInvariant(inv: Invariant, ctx: TranslationContext): string;
  
  // 生成测试文件的头部（imports、setup 等）
  generateFileHeader(group: Group | null): string;
  
  // 生成测试文件的尾部
  generateFileFooter(): string;
  
  // 输出文件路径策略
  getOutputPath(group: Group | null, baseDir: string): string;
}
```

### 5.5 运行时执行器（v0.5+）

除了生成测试，引擎还能直接对运行中的系统状态求值 CDL：

```typescript
interface RuntimeExecutor {
  evaluate(
    invariantId: string,
    systemState: SystemState
  ): EvaluationResult;
}
```

用途：
- 生产环境定期对账
- 故障诊断时即时验证
- API 测试时的契约验证

v0.1 不实现，预留接口。

---

## 6. Stele CLI 设计

### 6.1 安装

```bash
npm install -g stele
```

或在项目内：

```bash
npm install --save-dev stele
```

### 6.2 配置文件

`stele.config.json`（项目根目录）：

```json
{
  "version": "0.1",
  "contractDir": "contract",
  "generatedDir": "tests/contract",
  "checkerImplDir": "contract/checker_impls",
  "manifestPath": "contract/.manifest.json",
  "targetLanguage": "python",
  "testFramework": "pytest",
  "protected": [
    "contract/**/*.stele",
    "contract/checker_impls/**/*",
    "contract/.manifest.json",
    "tests/contract/**/*"
  ]
}
```

### 6.3 命令清单

#### `stele init`

初始化新项目。

```bash
stele init [--language python] [--framework pytest]
```

行为：
- 创建配置文件
- 创建标准目录结构
- 启动交互式向导（或调用 init agent）扫描项目
- 生成初始 CDL 文件
- 写入 manifest

#### `stele check`

完整校验（CI 用）。

```bash
stele check
```

行为：
- 加载并校验所有 CDL 文件
- 重新生成测试，比对当前内容
- 验证 manifest 完整性
- 不一致则失败并显示详细差异

退出码：
- `0`：一切正常
- `1`：CDL 文件错误
- `2`：生成内容不一致
- `3`：manifest 校验失败

#### `stele generate`

生成测试代码。

```bash
stele generate [--force]
```

行为：
- 加载 CDL
- 生成测试
- 更新 manifest

`--force` 跳过未变化检查，强制重新生成。

#### `stele lock`

更新 manifest（在合法修改契约后）。

```bash
stele lock [--reason "..."]
```

行为：
- 重新计算所有受保护文件的校验和
- 写入 manifest
- 记录变更日志

#### `stele dev`

开发模式（watch 文件变化）。

```bash
stele dev
```

行为：
- 监听 CDL 文件变化
- 自动重新生成测试
- 显示校验结果
- 提供 REPL 接口（可交互测试 CDL 表达式）

#### `stele add-checker`

添加新 checker 的脚手架。

```bash
stele add-checker <checker-id>
```

行为：
- 提示输入 signature
- 在 CDL 中注册
- 生成 checker 实现的 stub 文件

#### `stele explain`

解释指定 invariant。

```bash
stele explain INV_001
```

输出：
- invariant 的完整定义
- 生成的测试代码位置
- 依赖关系
- rationale 和历史

#### `stele list`

列出所有 invariant，支持过滤。

```bash
stele list [--severity critical] [--category data-integrity] [--tag payment]
```

#### `stele doc`

生成契约文档。

```bash
stele doc [--format html|markdown] [--output docs/]
```

### 6.4 退出码约定

所有命令统一：

- `0`：成功
- `1`：用户错误（错误的命令、错误的参数）
- `2`：契约校验失败
- `3`：篡改检测
- `4`：生成失败
- `5`：配置错误
- `99`：内部错误

CI 用 `stele check`，根据退出码决定流水线行为。

---

## 7. Claude Code 插件设计

### 7.1 插件结构

```
stele-claude-code/
├── .claude-plugin/
│   └── plugin.json              ; 插件元数据
├── commands/                     ; Slash commands
│   ├── stele-init.md
│   ├── stele-check.md
│   ├── stele-add.md
│   ├── stele-explain.md
│   └── stele-status.md
├── agents/                       ; Subagents
│   ├── contract-author.md
│   ├── contract-reviewer.md
│   └── contract-fixer.md
├── skills/                       ; Skills (auto-invoked)
│   ├── contract-aware-coding/
│   │   └── SKILL.md
│   └── contract-debugging/
│       └── SKILL.md
├── hooks/                        ; Event handlers
│   └── hooks.json
├── scripts/                      ; Hook 实现脚本
│   ├── pre-tool-protect.js
│   ├── post-tool-check.js
│   └── stop-validate.js
└── README.md
```

### 7.2 plugin.json

```json
{
  "name": "stele",
  "version": "0.1.0",
  "description": "Contract management for AI-assisted development",
  "author": {
    "name": "...",
    "email": "..."
  },
  "repository": "https://github.com/.../stele-claude-code",
  "license": "MIT",
  "keywords": ["contract", "testing", "ai-assist", "verification"],
  "requirements": {
    "stele-cli": "^0.1.0"
  }
}
```

### 7.3 Hooks

#### 7.3.1 PreToolUse Hook：保护契约文件

**最关键的 hook**——拦截对受保护文件的修改。

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/pre-tool-protect.js",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

**脚本逻辑**（`pre-tool-protect.js`）：

```typescript
// 1. 从 stdin 读取 hook 输入 JSON
// 2. 提取目标文件路径
// 3. 读取项目的 stele.config.json
// 4. 检查路径是否匹配 protected 模式
// 5. 如果是，输出 deny + 解释
// 6. 如果不是，正常通过
```

输出（拦截时）：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "This file is protected by Stele contract system. Use /stele:edit-contract to propose changes through the controlled flow."
  }
}
```

#### 7.3.2 PostToolUse Hook：自动校验

代码修改后自动跑 stele check。

```json
{
  "PostToolUse": [
    {
      "matcher": "Write|Edit|MultiEdit",
      "hooks": [
        {
          "type": "command",
          "command": "cd $CLAUDE_PROJECT_DIR && stele check --quick",
          "timeout": 30
        }
      ]
    }
  ]
}
```

`--quick` 跳过完整重新生成，只验证已有测试通过。

#### 7.3.3 Stop Hook：完成前最终校验

agent 想结束工作时，强制校验完整契约。

```json
{
  "Stop": [
    {
      "matcher": "*",
      "hooks": [
        {
          "type": "command",
          "command": "cd $CLAUDE_PROJECT_DIR && stele check",
          "timeout": 60
        }
      ]
    }
  ]
}
```

退出码非 0 → block，agent 必须继续修复。

#### 7.3.4 SessionStart Hook：注入契约上下文

新 session 开始时，把当前契约的概要加到上下文。

```json
{
  "SessionStart": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "${CLAUDE_PLUGIN_ROOT}/scripts/session-context.js"
        }
      ]
    }
  ]
}
```

脚本输出注入到上下文：

```
You are working in a project with Stele contract system.
- Total invariants: 47 (12 critical, 23 high, 12 medium)
- Protected files: contract/**, tests/contract/**
- DO NOT directly edit protected files. Use /stele:propose-change.
- Categories: data-integrity, business-rule, ...
- Most recent contract change: ACCT_004 added 2 days ago
```

### 7.4 Slash Commands

#### `/stele:init`

初始化项目。调用 `stele init`，引导用户完成设置。

#### `/stele:check`

主动跑 `stele check`，显示当前契约状态。

#### `/stele:add <description>`

添加新 invariant。调用 contract-author agent。

例：`/stele:add 用户提现金额不能超过账户可用余额`

#### `/stele:explain <id>`

解释 invariant。

#### `/stele:status`

显示契约整体状态：
- 总 invariant 数
- 各等级分布
- 最近变更
- 当前是否通过校验

#### `/stele:propose-change`

通过受控流程修改契约。这是 agent 想改契约时唯一合法路径。

流程：
1. agent 描述要改的内容和原因
2. contract-reviewer agent 评审
3. 显示 diff 给用户
4. 用户确认后才落盘
5. 自动运行 `stele lock`

### 7.5 Subagents

#### contract-author

**职责**：根据用户描述，生成结构良好的 CDL invariant。

`agents/contract-author.md`：

```markdown
---
name: contract-author
description: Authors new contract invariants based on user requirements. Use when adding new business rules or constraints to the project.
tools: Read, Bash
---

You are the Contract Author agent. Your job is to translate user-described 
business rules into well-formed CDL invariants.

## Process

1. Understand the rule completely. Ask clarifying questions if needed:
   - What is the business reason for this rule?
   - What are the boundary conditions?
   - Are there cases where it shouldn't apply?
   - What's the severity if violated?

2. Look at existing CDL files (read-only) to understand:
   - Naming conventions in this project
   - Existing categories and tags
   - Already-defined operators and checkers

3. Draft the invariant. Prefer:
   - Simple `assert` over `uses-checker` when possible
   - Built-in operators over registering new ones
   - Explicit rationale referencing real scenarios

4. Show the draft to the user for review.

5. Once approved, output a `/stele:propose-change` invocation.

## DO NOT

- Directly write to protected paths (you cannot, but don't even try)
- Invent new operators without checking existing registry
- Generate vague descriptions like "ensure correctness"
- Skip the rationale field
```

#### contract-reviewer

**职责**：评审契约变更，检查质量。

#### contract-fixer

**职责**：当代码改动违反契约时，分析失败原因并提出修复方案。**但不直接修改契约**——只能改源码。

### 7.6 Skills

#### contract-aware-coding

**自动激活场景**：用户让 agent 写代码时。

```markdown
---
description: Provides contract context when writing or modifying code. Auto-invoked when the user requests code changes in a project with Stele.
---

When writing or modifying code in this project:

1. Before making changes, run `stele list --module <relevant-module>` to see
   which invariants apply to the area you're changing.

2. Read the relevant invariants. Understand what they protect.

3. Make sure your code change does not violate any invariant.

4. After making changes, automated tests will run. If contract tests fail,
   DO NOT modify the test files (they are protected). Instead:
   - Re-read the failing invariant
   - Understand why your change violated it
   - Modify your source code to comply
   - If you believe the contract itself is wrong, use /stele:propose-change

5. Common patterns:
   - When adding a feature that touches money: check `category: data-integrity`
   - When changing data flow: check `category: state-consistency`
   - When modifying APIs: check `category: referential`
```

#### contract-debugging

**自动激活场景**：测试失败、契约违反时。

```markdown
---
description: Helps debug contract violations. Auto-invoked when contract tests fail or stele check reports issues.
---

When a contract test fails:

1. Run `stele explain <invariant-id>` to understand the rule.
2. Read the rationale to understand the business reason.
3. Look at the failing assertion to understand what was expected vs actual.
4. The fix is almost always in the source code, not the contract.
5. ...
```

### 7.7 命令权限映射

| 操作 | 谁可以做 |
|------|---------|
| 写源码 | agent, user |
| 写普通测试 | agent, user |
| 写 .stele 文件 | 仅 user (通过 contract-author + 用户确认) |
| 写 checker 实现 | 仅 user (通过受控流程) |
| 写生成测试 | 仅 stele CLI（自动） |
| 写 manifest | 仅 stele CLI（自动） |

---

## 8. 安全模型

### 8.1 威胁模型

我们防御的"威胁"：

1. **AI 主动修改契约**：agent 为了让自己的代码通过，试图改约束
2. **AI 修改生成的测试**：agent 改测试让它通过
3. **AI 修改 manifest**：agent 试图绕过校验和检查
4. **AI 修改 checker 实现**：agent 改 checker 让它返回 pass
5. **意外的人工修改**：开发者不小心改了不该改的

我们**不防御**的：
- 恶意人类直接绕过流程（这是组织/治理层面的问题，不是工具能解决的）
- 操作系统层面的篡改

### 8.2 多层防护

#### Layer 1：路径隔离

所有受保护文件位于明确路径模式下：

```
contract/**
contract/checker_impls/**
contract/.manifest.json
tests/contract/**
```

#### Layer 2：Hook 拦截（IDE 层）

Claude Code（和未来其他 IDE）的 PreToolUse hook 拦截写操作。**这是第一道防线**——agent 在工具层就被阻止。

#### Layer 3：Manifest 校验（CI 层）

CI 跑 `stele check`：
- 验证所有受保护文件的 SHA256 和 manifest 一致
- 验证 CDL 解析无错
- 验证生成测试与当前 CDL 一致

任何不一致 → CI 失败。**这是第二道防线**——即使 hook 被绕过，CI 也会发现。

#### Layer 4：Git 钩子（可选，用户配置）

提供 `pre-commit` 和 `pre-push` 模板：

```bash
#!/bin/sh
stele check || exit 1
```

#### Layer 5：仓库级保护（可选）

GitHub branch protection / GitLab push rules：要求修改受保护路径的 PR 必须有特殊 label 或 review。

### 8.3 合法修改流程

修改受保护内容的唯一合法路径：

```
1. 用户通过 /stele:propose-change 发起
   ↓
2. contract-reviewer agent 审查变更
   ↓
3. 显示完整 diff 给用户
   ↓
4. 用户明确确认
   ↓
5. CLI 写入文件（绕过 hook，因为这是合法工具调用）
   ↓
6. 自动运行 stele lock 更新 manifest
   ↓
7. 自动重新生成测试
   ↓
8. 提交时 CI 验证一切一致
```

### 8.4 紧急逃生通道

极少数情况下，用户可能需要直接编辑契约文件（比如 hook 系统本身坏了）。提供：

```bash
stele unlock --reason "..." --confirm
```

需要：
- 显式参数（不是默认行为）
- 强制说明原因
- 二次确认
- 会留下审计日志

`unlock` 后用户可以手工编辑，编辑完必须运行 `stele lock` 重新锁定。

---

## 9. 项目结构与代码组织

### 9.1 Monorepo 布局

整个项目使用 monorepo（推荐 pnpm workspaces 或 turborepo）：

```
stele/                                  ; 仓库根
├── README.md
├── LICENSE
├── package.json                        ; workspace 根
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── docs/                               ; 项目文档
│   ├── design.md                       ; 本文档
│   ├── cdl-spec.md                     ; CDL 详细规范
│   ├── plugin-guide.md
│   └── ...
├── packages/
│   ├── core/                           ; @stele/core
│   │   ├── src/
│   │   │   ├── lexer/
│   │   │   ├── parser/
│   │   │   ├── ast/
│   │   │   ├── validator/
│   │   │   ├── registry/
│   │   │   ├── normalizer/
│   │   │   ├── manifest/
│   │   │   ├── generator/
│   │   │   └── index.ts
│   │   ├── tests/
│   │   └── package.json
│   ├── cli/                            ; @stele/cli
│   │   ├── src/
│   │   │   ├── commands/
│   │   │   ├── config/
│   │   │   └── index.ts
│   │   ├── tests/
│   │   └── package.json
│   ├── backend-python/                 ; @stele/backend-python
│   │   ├── src/
│   │   │   ├── translator.ts
│   │   │   ├── templates/
│   │   │   └── index.ts
│   │   ├── tests/
│   │   └── package.json
│   └── claude-code-plugin/             ; @stele/claude-code-plugin
│       ├── .claude-plugin/
│       │   └── plugin.json
│       ├── commands/
│       ├── agents/
│       ├── skills/
│       ├── hooks/
│       ├── scripts/
│       │   └── (TS source compiled to JS)
│       └── package.json
├── examples/                           ; 示例项目
│   ├── pms-system/                     ; PMS 系统的 CDL 示例
│   └── todo-app/                       ; 简单项目示例
└── tools/                              ; 内部开发工具
    └── benchmarks/
```

### 9.2 包依赖关系

```
@stele/cli  
   └─> @stele/core
          └─> @stele/backend-python
                 (运行时按 config 加载)

@stele/claude-code-plugin
   └─> @stele/cli (作为 npm dep)
          └─> @stele/core
```

`backend-python` 是 `core` 的 peer——核心通过 plugin pattern 加载后端，不静态依赖任何特定后端。

### 9.3 Claude Code 插件如何使用 CLI

插件目录中包含 `package.json` 声明 `@stele/cli` 依赖。安装插件时 npm install 安装 CLI。

或者：**要求用户先全局安装 stele CLI**，插件直接调用全局命令。这样更简单。**v0.1 用全局安装方案**。

---

## 10. 分发与版本策略

### 10.1 npm 包分发

| 包 | 用途 | 安装方式 |
|----|------|----------|
| `@stele/core` | 核心引擎 | 通常作为依赖 |
| `@stele/cli` | CLI | `npm i -g stele` |
| `@stele/backend-python` | Python 后端 | 默认随 CLI 安装 |
| `@stele/backend-typescript`（未来） | TS 后端 | 按需 |

### 10.2 Claude Code 插件分发

通过 GitHub repository 作为 marketplace：

```bash
/plugin marketplace add username/stele-marketplace
/plugin install stele
```

Marketplace 仓库结构：

```
stele-marketplace/
├── .claude-plugin/
│   └── marketplace.json
└── plugins/
    └── stele/
        └── (插件文件)
```

### 10.3 版本策略

**Semantic Versioning** 严格遵守：

- **MAJOR**：CDL 语法的破坏性变更、CLI 命令的破坏性变更
- **MINOR**：新增操作符、新增命令、新增后端语言
- **PATCH**：bug 修复、文档改进

**CDL 版本号独立**于 CLI 版本号，但向后兼容：

- CLI v0.1 必须能解析 CDL v0.1 文件
- CLI v0.x.y 必须能解析 CDL v0.1 ~ v0.x 的文件

每个 CDL 文件在 metadata 中声明所遵循的版本：

```lisp
(metadata (stele-version "0.1"))
```

CLI 据此选择解析规则。

### 10.4 发布频率

- **patch**：随时
- **minor**：每月
- **major**：v1.0 之前不承诺向后兼容；v1.0 之后每年最多 1 次

---

## 11. 多语言扩展机制

### 11.1 新语言后端的实现路径

一个新后端是一个 npm 包，遵循以下结构：

```
@stele/backend-<language>/
├── src/
│   ├── translator.ts        ; 实现 LanguageBackend 接口
│   ├── templates/           ; 操作符到代码的模板
│   │   ├── arithmetic.ts
│   │   ├── comparison.ts
│   │   ├── quantifier.ts
│   │   └── ...
│   ├── runtime/             ; 运行时支持库（目标语言写）
│   │   └── <files in target language>
│   └── index.ts
└── package.json
```

### 11.2 LanguageBackend 接口

```typescript
interface LanguageBackend {
  // 元数据
  readonly name: string;
  readonly framework: string;
  readonly fileExtension: string;
  readonly version: string;
  
  // 翻译表达式为目标语言代码
  translateExpression(
    expr: ASTNode,
    ctx: TranslationContext
  ): CodeFragment;
  
  // 翻译完整 invariant 为测试函数
  translateInvariant(
    inv: Invariant,
    ctx: TranslationContext
  ): GeneratedFile;
  
  // 文件级辅助
  generateFileHeader(group: Group | null): string;
  generateFileFooter(): string;
  
  // 输出策略
  determineOutputPath(
    inv: Invariant,
    config: SteleConfig
  ): string;
  
  // checker 调用代码生成
  generateCheckerInvocation(
    checkerSpec: CheckerSpec,
    inputs: Record<string, CodeFragment>
  ): CodeFragment;
}
```

### 11.3 模板系统

每个操作符在每个后端有一个模板。例如 `eq` 在 Python 后端：

```typescript
const eqTemplate: OperatorTemplate = {
  operator: 'eq',
  pattern: '({left} == {right})',
  postprocess: (code, ctx) => {
    // 处理浮点容差等
    if (ctx.tolerance) {
      return `(abs(${left} - ${right}) < ${ctx.tolerance})`;
    }
    return code;
  }
};
```

### 11.4 v0.1 范围

仅实现 **Python + pytest 后端**。其他语言的接口预留，但不实现。

未来加新语言时，**不需要修改核心引擎**——只需新建一个后端包并注册。

### 11.5 Checker 实现的多语言

未来 checker 实现可以是任何语言。CDL 文件中通过 `(implementation (language ...))` 声明。

引擎根据语言选择不同的调用方式：

- Python: 直接 import 并调用
- TypeScript: 同进程调用
- Go/Rust: 通过子进程或本地 API

v0.1 仅支持 Python checker。

---

## 12. 路线图

### 12.1 v0.1（最小可行版本，4-6 周）

**目标**：在一个真实 Python 项目上跑通完整流程。

**Core 引擎**
- 完整 CDL 解析器（4.7 节核心操作符全实现）
- 校验器（结构、类型、引用、唯一性）
- Manifest 生成与校验
- 规范化

**Python 后端**
- 所有核心操作符的 pytest 翻译
- Python checker 调用支持

**CLI**
- `init`、`check`、`generate`、`lock`、`add-checker`、`explain`、`list`

**Claude Code 插件**
- PreToolUse hook（保护契约）
- Stop hook（强制最终校验）
- 4 个核心 slash commands（init、check、add、explain）
- 1 个 subagent（contract-author）
- 1 个 skill（contract-aware-coding）

**文档**
- CDL 规范
- 用户指南
- 示例项目（基于你的 PMS 系统）

**验收标准**
- 你能在 PMS 项目上写 20+ invariant
- 完整的"AI 想改契约 → 被阻止"流程可演示
- CI 集成可验证

### 12.2 v0.5（生产可用，2-3 个月）

**新增能力**
- 运行时执行器（生产环境对账）
- 项目级操作符注册
- TypeScript + jest 后端
- contract-reviewer 和 contract-fixer subagents
- Dev 模式（watch + REPL）
- 文档自动生成（HTML + Markdown）

**完善**
- 更多核心操作符
- 更完善的错误信息
- 性能优化（大型契约文件）

### 12.3 v1.0（稳定 API，6-12 个月）

**新增能力**
- 多 IDE 支持（Cursor、Codex CLI 等）
- Go、Rust 等更多目标语言后端
- Mutation testing 集成（验证测试有效性）
- 跨项目契约（公共契约库）
- 团队治理特性（变更审批工作流）

**承诺**
- API 稳定，破坏性变更有迁移路径
- 文档完整
- 性能基准

### 12.4 长期愿景

- 成为 AI 协作开发的契约层标准
- 支持非代码项目（数据契约、API 契约、规范契约）
- 可视化工具（契约关系图、覆盖率热图）

---

## 13. 与现有工具的关系

### 13.1 与测试框架（pytest/jest）

**关系**：互补，不替代。

Stele 生成的测试就是普通的 pytest/jest 测试。它们和项目的其他测试一起被测试框架运行。Stele 不实现测试运行——只实现"测试代码的生成"。

### 13.2 与代码 linter

**关系**：完全独立。

linter 关心代码风格和模式，Stele 关心业务规则。两者并行。

### 13.3 与 Git hooks

**关系**：可选集成。

提供 pre-commit/pre-push 模板，但不强制。用户可以选择只在 CI 跑校验。

### 13.4 与 CI 系统（GitHub Actions 等）

**关系**：CI 调用 Stele CLI。

在 CI 配置中加一步 `stele check`。Stele 不是 CI 系统的替代。

### 13.5 与 LLM 模型

**关系**：模型无关。

Stele 不调用任何 LLM。它管理契约和生成测试，所有 AI 协作通过 IDE 插件层进行——LLM 由 IDE 提供（Claude Code、Cursor 等）。

### 13.6 与其他契约/规约系统

参考但不直接依赖：

- **DbC（Design by Contract）**：哲学相似，但 DbC 是嵌入语言的，Stele 是独立工具
- **JSON Schema**：用途不同，Schema 是数据形态，Stele 是业务规则
- **OPA（Open Policy Agent）**：策略引擎，Stele 借鉴其声明式思想但更专注
- **TLA+/Alloy**：形式化验证，Stele 是工程级、不追求数学完备

---

## 14. 开放问题

实现过程中需要决策的事项：

### Q1: Path 的语义边界

`(path account total)` 在不同 Python 项目中映射到：
- `account.total`（属性访问）
- `account['total']`（字典）
- `account.get_total()`（方法）

**待决策**：是否在 CDL 中显式声明，还是按约定？建议在 metadata 中配置默认行为。

### Q2: 异步约束的执行模型

时序约束（`within`、`after`、`modified`）如何在测试中模拟？

**待决策**：是否引入"事件总线"抽象？实现时再确定。

### Q3: CDL 文件大小的实际边界

预期 100 条 invariant 之后开始遇到可读性挑战。

**待决策**：分文件粒度的最佳实践，需要实战验证。

### Q4: Hook 的跨平台兼容性

PreToolUse hook 在 Windows / macOS / Linux 行为是否一致？需要测试。

### Q5: checker 实现的依赖管理

Python checker 可能需要项目的 Python 包。如何确保 checker 在项目环境中可执行？

**初步方案**：约定 checker 必须用项目的 Python 解释器运行，通过 `python -m` 调用。

### Q6: CDL 错误恢复

解析时遇到错误，是立即停止还是收集多个错误一起报？

**初步方案**：收集（更友好），但实现复杂度更高。v0.1 先立即停止。

### Q7: 团队协作场景

多人同时修改契约时的冲突解决？**v0.1 不处理**——交给 git。v1.0 考虑专门的合并工具。

### Q8: 性能基准

100 个 invariant 解析+校验+生成应该多快？

**初步目标**：< 1 秒。v0.1 不优化，以正确性优先。

---

## 15. 附录

### 附录 A：CDL 完整 EBNF

```ebnf
File          = TopLevel*

TopLevel      = Metadata
              | Import
              | Operator
              | Checker
              | Group
              | Invariant

Metadata      = "(" "metadata" Field+ ")"
Import        = "(" "import" String ")"

Operator      = "(" "operator" Identifier 
                 Description?
                 Arity
                 Signature
                 Translations
                 ")"

Checker       = "(" "checker" Identifier
                 Description?
                 Signature
                 Implementation
                 Checksum?
                 ")"

Group         = "(" "group" Identifier
                 Description?
                 Invariant+
                 ")"

Invariant     = "(" "invariant" Identifier
                 Severity
                 Description
                 (Assert | UsesChecker)
                 OptionalField*
                 ")"

Severity      = "(" "severity" SeverityLevel ")"
SeverityLevel = "critical" | "high" | "medium" | "low"

Description   = "(" "description" String ")"

Assert        = "(" "assert" Expression ")"
UsesChecker   = "(" "uses-checker" Identifier Args? ")"

OptionalField = Category | Tags | When | Tolerance 
              | DependsOn | Rationale | Since | AppliesTo

Expression    = Atom | List
Atom          = Identifier | Keyword | String | Number
List          = "(" Identifier Expression* ")"

Identifier    = [a-zA-Z_][a-zA-Z0-9_-]*
Keyword       = ":" Identifier
String        = "\"" Char* "\""
Number        = Integer | Float
```

### 附录 B：完整示例（PMS 系统节选）

```lisp
;; main.stele

(metadata
  (stele-version "0.1")
  (project "crypto-pms")
  (description "加密货币 PMS 系统契约")
  (target-language python)
  (test-framework pytest)
  (last-updated "2026-05-04"))

(import "modules/account.stele")
(import "modules/strategy.stele")
(import "modules/sync.stele")
```

```lisp
;; modules/account.stele

(group account-integrity
  (description "账户层面的核心一致性约束")
  
  (invariant ACCT_001
    (severity critical)
    (category data-integrity)
    (description "账户总值等于持仓估值与现金之和")
    (rationale "保证资产报表准确，防止 P&L 计算偏差")
    (since "0.1.0")
    (assert
      (eq (path account total-value)
          (add (sum (collection positions) (path value))
               (path account cash)))))
  
  (invariant ACCT_002
    (severity critical)
    (category referential)
    (description "每条交易记录必须关联一个有效账户")
    (rationale "防止孤立交易导致账目无法追溯")
    (since "0.1.0")
    (assert
      (forall txn (collection transactions)
        (exists-in (path txn account-id) (collection accounts)))))
  
  (invariant ACCT_003
    (severity high)
    (category business-rule)
    (description "账户余额变化必须有对应交易记录")
    (rationale "审计要求：所有资金移动可追溯")
    (since "0.1.0")
    (when (modified (path account balance)))
    (uses-checker balance-change-has-transaction)))
```

```lisp
;; modules/checkers.stele

(checker balance-change-has-transaction
  (description "校验账户余额变化都有对应交易记录")
  (signature
    (input
      (account-id String)
      (balance-before Number)
      (balance-after Number)
      (transactions Collection))
    (output Boolean))
  (implementation
    (language python)
    (path "contract/checker_impls/balance_change_has_transaction.py")
    (function "check"))
  (checksum "sha256:abc123..."))
```

### 附录 C：术语表

- **CDL**：Contract Definition Language，本项目定义的契约语言
- **Invariant**：不变量，CDL 的核心声明
- **Checker**：复杂约束的外部实现
- **Generator/Backend**：把 CDL 翻译成目标语言测试的组件
- **Manifest**：受保护文件的清单和校验和
- **Receptor**：CDL 表达式中可用的内置或注册操作符
- **Stele**：本项目，得名于刻有古代法典的石碑

### 附录 D：命名考据

**Stele**（/ˈstiːliː/）来自希腊语 στήλη，指竖立的石碑。古代用来刻写法律、契约、纪念性文字。最著名的例子是汉谟拉比法典（刻在玄武岩石柱上）和罗塞塔石碑。

选择这个名字的理由：

1. 隐喻精准：契约像刻在石头上一样不可篡改
2. 简洁：5 个字母，CLI 命令短
3. 独特：技术领域少见，搜索友好
4. 历史感：暗示"这是基础设施而非趋势"

---

## 文档结束

> 这份文档是 Stele 项目的奠基蓝图。
> 实现过程中遇到与本文档冲突的设计决策，应优先记录在文档中并讨论，而非默默偏离。
> 
> 本文档应随项目演进而更新，但**不应轻易**——它代表项目的设计共识。
