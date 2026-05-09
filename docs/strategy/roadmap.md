# Stele 扩展路线图

> 版本：0.1 | 日期：2026-05-08 | 状态：上游规划文档（已被 PRD 取代为可执行切片）

> **实施计划**：本文是上游意图。实际承诺的实施切片见
> [`docs/prd-phase-0.md`](../prd-phase-0.md)、[`docs/prd-phase-1.md`](../prd-phase-1.md)、[`docs/prd-phase-2.md`](../prd-phase-2.md)（v2.0，refined 2026-05-08）。
> PRD 经过两轮独立子 Agent 审查，做了多项裁剪与修正——以 PRD 为准。
>
> **历史基线说明**：本文中的"46 个操作符"是 v0.1 的旧记法；当前注册表实际有 **51 个**（见 `packages/core/src/registry/operators.ts`）。其他数字（17 个 CLI 命令、12 个顶层声明等）也建议按代码核对。本文不再因代码演进而更新——以源码与 PRD 为准。

---

## 目录

1. [项目定位](#1-项目定位)
2. [竞品分析](#2-竞品分析)
3. [Steles 独特优势](#3-steles-独特优势)
4. [扩展机会](#4-扩展机会)
5. [路线图](#5-路线图)
6. [风险与建议](#6-风险与建议)

---

## 1. 项目定位

### 1.1 Stele 是什么

Stele 是一个面向 **AI 辅助软件开发** 的生产级契约管理工具。它嵌入在已有的应用仓库中，将开发者声明的契约规则自动编译为可执行的测试工件（如 pytest 测试模块），并在本地或 CI 流水线中检测受保护契约状态的漂移。

核心组件：

| 包名 | 职责 |
|------ |
|---|---|
| `@stele/core` | CDL 词法分析、语法解析、结构校验、静态类型检查、操作符注册表、Manifest 管理、基线管理 |
| `@stele/backend-python` | CDL 到 Python pytest 测试代码的翻译引擎 |
| `@stele/cli` | 命令行接口（init/generate/lock/check/baseline/rules/explain/why/propose 等 17 个子命令） |
| `@stele/claude-code-plugin` | 编辑器端护栏插件（PreToolUse 文件保护、Stop 钩子校验、SessionStart 上下文注入、斜杠命令、智能合约提案流） |

### 1.2 解决什么问题

- **AI 编码的安全护栏**：防止 AI 代理（如 Claude Code）在编码过程中意外破坏关键业务不变量
- **契约即代码的自动测试**：开发者用领域语言声明规则，工具自动生成可运行的测试
- **代码库状态的持续验证**：通过 SHA-256 哈希锁定受保护文件，任何漂移都被检测并阻止
- **增量式知识积累**：AI 代理通过 `propose invariant` 命令将新发现的规则追加到契约中，但修改/删除必须由人类审批

### 1.3 目标用户

- **使用 AI 编码工具的团队**（Claude Code、Cursor、Copilot 等），希望在享受 AI 效率的同时保持代码库完整性
- **需要领域不变量验证的金融/医疗/合规项目**（如 Stele 示例中的账户/头寸/交易不变量）
- **微服务架构中的契约驱动开发团队**（需要消费者驱动的契约测试，但面向本地仓库而非远程服务）
- **追求高可靠性交付的 DevOps 团队**（需要在 CI 中自动验证代码库一致性）

---

## 2. 竞品分析

### 2.1 契约测试 / 消费者驱动契约（CDC）

| 项目 | 核心功能 | 与 Stele 的差异 | 可借鉴点 |
|---|---|---|---|
| **Pact** (pact-foundation/pact) | 消费者驱动契约测试，支持 HTTP/gRPC/Kafka 传输，DSL 定义交互，Mock 服务器回放 | 面向**服务间**的远程契约验证；需要消费者-提供者双方协作；不管理本地代码库状态 | 匹配器（Matchers）和生成器概念；契约版本管理；PactFlow 集中式契约仓库 |
| **Spring Cloud Contract** | Spring 生态中的 CDC 支持，HTTP 和消息契约，测试发布为工件 | 深度绑定 Java/Spring 生态；面向远程服务交互；不面向 AI 代理 | 契约到存根（stub）的自动生成；测试资产发布机制 |
| **WireMock** | HTTP 服务 Mock，请求匹配/存根/回放/故障注入 | 纯 Mock 工具，无契约声明语言；不验证不变量；不生成测试 | 请求验证（Request Verification）机制；故障注入；浏览器代理 |
| **Mountebank** | 多协议服务虚拟化（HTTP/TCP），高级谓词存根，JavaScript 注入 | 服务虚拟化平台，不管理代码仓库状态；无 DSL | 跨协议支持；Record-playback 代理模式 |

**分析**：CDC 工具面向**分布式系统间的远程契约**，Stele 面向**本地仓库内的代码不变量**。两者互补，Stele 可以考虑未来集成 Pact 作为远程契约验证后端。

### 2.2 AI 智能体 Schema / 验证

| 项目 | 核心功能 | 与 Stele 的差异 | 可借鉴点 |
|---|---|---|---|
| **Pydantic** (pydantic/pydantic) | Python 类型提示数据验证，自动类型转换，JSON Schema 输出 | 面向运行时数据验证（请求体/配置文件）；不验证代码结构；无契约语言 | 基于类型提示的声明式验证模式；性能优化策略；JSON Schema 互操作 |
| **Zod** (colinhacks/zod) | TypeScript 优先的 Schema 验证，静态类型推导，零依赖 | 面向运行时输入验证；不验证代码库不变量；无 DSL | 类型推导（`z.infer<>`）；不可变 API；链式构建模式 |
| **JSON Schema** | 通用的 JSON 数据验证标准 | 纯数据层验证；无法表达逻辑不变量（如 forall/exists） | 作为 Stele 与外部系统交互的数据格式；`applies-to` 字段可引用 JSON Schema |

### 2.3 AI 代码护栏 / 安全

| 项目 | 核心功能 | 与 Stele 的差异 | 可借鉴点 |
|---|---|---|---|
| **Instructor** (instructor-ai/instructor) | LLM 结构化输出，自动验证+重试，支持 Python/TS/Go/Rust | 验证**LLM 输出内容**而非代码库状态；不生成测试；不管理文件保护 | 自动重试机制；多语言支持；流式部分对象验证 |
| **Guidance** (guidance-ai/guidance) | 控制 LLM 输出格式（正则/CFG/JSON Schema），Token Fast-Forward | 面向 LLM 推理时的输出约束；不验证代码库；无测试生成 | 上下文无关语法约束；Token 预填充优化 |
| **NeMo Guardrails** (NVIDIA/NeMo-Guardrails) | 对话系统护栏（输入/对话/检索/执行/输出），Colang 建模语言 | 面向对话安全（防注入/幻觉检测）；不验证代码；使用 Colang DSL | Colang 专用 DSL 的设计思路；五层护栏架构（输入/执行/输出） |
| **LiteLLM** (BerriAI/litellm) | 100+ LLM 统一接口，代理网关，多租户成本追踪，虚拟密钥，护栏 | 是 LLM 网关/代理，不验证代码库；有成本追踪和日志 | 集中式仪表板；Per-project 自定义配置；多租户架构 |

### 2.4 软件契约 / 形式化验证

| 项目 | 核心功能 | 与 Stele 的差异 | 可借鉴点 |
|---|---|---|---|
| **Design by Contract (DbC)** | 前置条件/后置条件/不变量，Darwin/Spice 实现 | 学术性质偏强，工业界采用率极低；无测试代码生成；无 CI 集成 | 前置条件/后置条件的概念；`when` 条件的语义 |
| **Eiffel** | DbC 的完整实现语言，继承契约，变异契约 | 是一门独立语言，不是嵌入到现有语言的契约层；生态小 | 契约继承和变异的概念 |
| **F* / LiquidHaskell** | 形式化验证，依赖类型，定理证明 | 学术/安全关键领域；学习曲线陡峭；需要定理证明 | 不变量推理的严谨性 |

### 2.5 AI 辅助编码工具

| 项目 | 核心功能 | 契约/安全特性 | 与 Stele 的关系 |
|---|---|---|---|
| **Cursor** | AI 驱动的开发环境，Tab 自动补全，代理模式，多模型支持 | SOC 2 认证，安全代码索引；**无代码级契约验证** | Stele 可作为 Cursor 项目的补充护栏 |
| **GitHub Copilot** | 代码自动补全，Chat，Commands | 基本的代码质量建议；**无契约验证** | Stele 可集成到 Copilot 项目的 CI 中 |
| **Devin** | 自主 AI 软件工程师，独立完成任务 | 内部有安全检查；**无外部契约声明机制** | Stele 可部署在 Devin 的工作仓库中 |
| **Codeium** | 代码补全，聊天，Copilot 替代 | 基本的代码建议；**无契约层** | Stele 可作为 Codeium 用户的护栏 |
| **Windsurf** | AI 驱动的开发工具，类似 Cursor | 代码补全和编辑；**无契约验证** | Stele 可集成到 Windsurf 项目中 |

**关键发现**：当前所有 AI 编码工具都**缺乏内建的契约验证机制**。这是 Stele 最大的市场空白。

### 2.6 测试生成 / 属性测试

| 项目 | 核心功能 | 与 Stele 的差异 | 可借鉴点 |
|---|---|---|---|
| **Hypothesis** (HypothesisWorks/hypothesis) | Python 属性测试库，随机输入生成，最小化失败案例 | 验证函数输入-输出属性，不验证代码库结构不变量；无 DSL | **最小化失败案例（shrinking）**；输入范围定义；边缘案例覆盖 |
| **Fast-Check** (dubzzz/fast-check) | JavaScript/TypeScript 属性测试，链式操作，模型策略 | 验证函数属性，不验证代码库结构；无契约语言 | **模型策略**（验证接口/状态机）；异步时序问题检测；偏见生成 |
| **jsVerify** | JavaScript 属性测试 | 功能类似 Hypothesis，但生态较小 | 属性定义语法 |

### 2.7 竞品总结矩阵

```
                  本地代码     远程服务    AI代理    测试生成    DSL    护栏拦截
                  不变量     契约验证    集成      能力      专用   编辑器钩子
Stele              YES        NO         YES       YES      YES    YES
Pact               NO         YES        NO        NO       YES    NO
WireMock           NO         YES        NO        NO       NO     NO
Instructor         NO         NO         部分       NO       NO     NO
NeMo Guardrails    NO         NO         部分       NO       YES    NO
Hypothesis         部分       NO         NO        YES      NO     NO
Cursor             NO         NO         自身       NO       NO     NO
Pydantic           部分       NO         部分       NO       NO     NO
```

---

## 3. Steles 独特优势

### 3.1 别人没做或做不好的点

1. **唯一面向 AI 代理的契约工具**

   所有竞品要么面向传统测试（Hypothesis、Fast-Check），要么面向远程服务（Pact、WireMock），要么面向 LLM 输出内容（Instructor、NeMo Guardrails）。**Stele 是唯一将契约管理嵌入到 AI 编码代理工作流中的工具。**

2. **编辑器级护栏拦截**

   Claude Code 插件的 PreToolUse 钩子可以在 AI 代理**每次编辑前**拦截受保护文件的修改。这种"事前阻止"模式是所有竞品都做不到的。Pact 等工具只在测试阶段发现问题，Steles 在编辑阶段就阻止。

3. **领域专用语言（CDL）+ 自动测试生成**

   Stele 的 CDL 使用 S-expression 语法，提供了 46 个内置操作符（forall/exists/where/sum 等），可以表达复杂的领域不变量，并自动编译为可运行的 pytest 测试。这种"声明即测试"模式比 Hypothesis 的属性测试更面向业务语义。

4. **知识增量式积累**

   `stele propose invariant` 命令允许 AI 代理将新发现的规则追加到契约中，而修改/删除需要人类审批。这种"add-only by agent, human-reviewed changes"模式平衡了自动化和安全性。

5. **完整的锁定-验证-基线体系**

   SHA-256 锁定、Manifest 验证、基线管理（baseline-init/baseline-update）、diff-from 范围检查——这是一套完整的受保护状态管理体系，竞品中没有一个提供如此完整的方案。

6. **跨文件契约图**

   递归的 `import` 加载、全局唯一性校验、跨文件的 `depends-on` 依赖关系——Stele 将多个 `.stele` 文件视为一个有向无环图来统一验证。

### 3.2 差异化定位

```
传统测试工具 (pytest/Jest)          AI 编码工具 (Cursor/Copilot)
         |                                        |
         |    契约定义 (CDL) + 测试生成              |
         |           |                                |
         |           v                                |
         |    本地不变量验证 <------ Stele 桥梁 ------->|
         |           |                                |
         |           v                                |
         |    编辑器护栏 (PreToolUse)                  |
         |           |                                |
         v           v                                v
   传统 CI/CD  <------ Stele check ------->  AI 代理工作流
```

---

## 4. 扩展机会

### P0：高影响低代价（立即做）

#### 4.0.1 TypeScript/JavaScript 后端 (`@stele/backend-typescript`)

- **动机**：TypeScript 是 AI 编码的主要语言之一（Zod、LangChain、Express 等项目都是 TS）
- **实现**：复用 `@stele/core` 的解析和校验逻辑，新增 `backend-typescript` 包
- **目标**：CDL 到 Jest/Vitest 测试的翻译
- **关键映射**：
  - `forall` → `describe` + `it.each` 或 `for...of` + `expect`
  - `where` → `array.filter()`
  - `sum`/`avg`/`min`/`max` → `reduce()`
  - `matches` → `RegExp.test()`
- **估算**：2-3 周

#### 4.0.2 GitHub Actions 集成

- **动机**：GitHub 是最大的开发者平台，CI 集成是最直接的 adopt 路径
- **实现**：发布 `stele-action` 包
  - `stele-action/generate` — 生成测试
  - `stele-action/check` — 执行 `stele check --diff-from main`
  - `stele-action/lock` — 在 PR merge 后更新锁定
- **PR 检查标注**：当 `stele check` 发现违约时，在 PR diff 上标注具体文件
- **估算**：1-2 周

#### 4.0.3 pre-commit 钩子

- **动机**：pre-commit 是最广泛使用的 Git 钩子框架，覆盖率极高
- **实现**：
  - `stele check` 作为 pre-commit 钩子
  - `stele generate` 作为 prepare-commit-msg 钩子（自动更新生成文件）
- **估算**：1 周

#### 4.0.4 CDL 操作符增强

当前 46 个操作符已覆盖基础场景，以下操作符可快速添加高价值：

| 操作符 | 签名 | 描述 |
|---|---|---|
| `length` | `(Collection) -> Number` | 集合长度（已有 `has-length` 但无独立的 `length`） |
| `concat` | `(Collection, Collection) -> Collection` | 集合拼接 |
| `sort-by` | `(Symbol, Collection, Path) -> Collection` | 按路径排序 |
| `group-by` | `(Symbol, Collection, Path) -> Collection` | 按路径分组 |
| `json-path` | `(Unknown, String) -> Unknown` | JSONPath 查询 |
| `type-of` | `(Unknown) -> String` | 返回值的类型名 |
| `round` | `(Number, Number) -> Number` | 四舍五入到指定位数 |
| `ceil`/`floor` | `(Number) -> Number` | 向上/向下取整 |
| `trim`/`lower`/`upper` | `(String) -> String` | 字符串操作 |
| `split`/`join` | `(String, String) -> Collection` / `(Collection, String) -> String` | 分割/拼接 |
| `regex-groups` | `(String, String) -> Collection` | 正则捕获组 |
| `percentile` | `(Collection, Path, Number) -> Number` | 百分位计算 |

**估算**：1-2 周（每批 5-6 个）

#### 4.0.5 性能优化：增量生成

- **动机**：大型项目全量生成耗时较长
- **实现**：
  - 基于文件哈希的增量检测：只重新生成变更的 `.stele` 文件对应的测试
  - 缓存编译后的 AST 节点
  - 并行生成多个 group 的测试文件
- **估算**：2 周

### P1：高影响需要投入（近期做）

#### 4.1.1 Go 后端 (`@stele/backend-go`)

- **动机**：Go 在基础设施和云原生领域广泛使用，AI 编码的热门语言
- **实现**：CDL 到 Go `testing.T` 或 `testify` 测试的翻译
- **关键挑战**：Go 的强类型需要额外的类型推断
- **估算**：3-4 周

#### 4.1.2 VS Code 扩展

- **动机**：VS Code 是最大的 IDE 用户群，不依赖 Claude Code 也能使用 Stele
- **功能**：
  - `.stele` 文件的语法高亮（Tree-sitter 语法）
  - 内联违约提示（Diagnostics）
  - 命令面板：`Stele: Check`、`Stele: Generate`、`Stele: Lock`
  - 契约文件导航（跳转到相关的 invariant/uses-checker）
  - 右键菜单：`Stele: Explain This Violation`
- **估算**：4-6 周

#### 4.1.3 自我修复契约（Self-Healing Contracts）

- **动机**：当违约发生时，自动分析代码变更并建议修复方案
- **实现**：
  - 新的 CLI 命令：`stele fix --auto` 或 `stele fix --suggest`
  - 分析违约原因：是代码变更导致的合理漂移，还是真正的 bug
  - 如果是合理漂移，自动生成 `stele propose invariant` 的提案
  - 如果是 bug，生成修复补丁
- **技术基础**：利用 AI 代理能力 + Stele 的上下文信息（agent-context、why）
- **估算**：3-4 周

#### 4.1.4 契约变更检测与自动建议（Contract Suggestions from Code Changes）

- **动机**：当开发者修改代码时，自动识别可能影响的契约规则
- **实现**：
  - Git diff 分析：识别修改了哪些函数/类
  - AST 分析：识别变更的代码结构（新增字段、修改方法签名）
  - 匹配受影响的契约规则：`applies-to`、`depends-on` 链
  - 生成变更建议：是否需要更新 invariant、是否需要新增 invariant
- **与 Self-Healing 的区别**：这是在编辑**之前**的预防性建议，Self-Healing 是在违约**之后**的修复
- **估算**：3-4 周

#### 4.1.5 观察性仪表板（Stele Dashboard）

- **动机**：大型团队需要可视化的契约健康度报告
- **功能**：
  - 契约覆盖率：多少代码被契约保护
  - 违约趋势：按时间的违约数量变化
  - 严重性分布：error/warning/info 的饼图
  - 热点文件：违约最多的文件/模块
  - 契约年龄：每个 invariant 的 `since` 时间线
- **技术选型**：
  - 方案 A：简单的 HTML 报告（`stele doc --format html`）
  - 方案 B：Web 仪表板（Next.js + 本地 SQLite）
  - 方案 C：集成到 Grafana（Prometheus 指标导出）
- **估算**：方案 A 2 周，方案 B 4-6 周

#### 4.1.6 代码形状（Code Shape）增强

当前 `boundary`、`class-shape`、`function-shape`、`type-policy`、`file-policy` 是 CDL 中的高级声明类型，但在结构类型定义中已经存在。需要：

- **补充 Python 后端实现**：目前这些类型在 structure-types.ts 中定义，但 Python 后端尚未完全实现所有 CodeShape 的校验逻辑
- **新增 CDL 声明类型**：
  - `module-shape` — 模块级别的形状约束（必须导出哪些符号）
  - `api-shape` — API 端点的形状约束（HTTP 方法、路径模式、请求/响应模式）
  - `config-shape` — 配置文件的形状约束
- **估算**：3-4 周

### P2：战略性布局（中期规划）

#### 4.2.1 Rust 后端 (`@stele/backend-rust`)

- **动机**：Rust 在安全关键系统中广泛使用，AI 编码的上升趋势
- **实现**：CDL 到 Rust `assert!` 或 `expect_test` 的翻译
- **关键优势**：Rust 的类型系统可以与 Stele 的静态类型检查深度集成
- **估算**：4-6 周

#### 4.2.2 Java 后端 (`@stele/backend-java`)

- **动机**：Java 企业市场庞大，Spring Cloud Contract 的用户可能迁移
- **实现**：CDL 到 JUnit 5 测试的翻译
- **估算**：4-6 周

#### 4.2.3 插件生态系统

- **动机**：允许第三方扩展 Stele 的能力
- **设计**：
  - **操作符插件**：用户可注册自定义操作符（如 `(http-get "/api/users")`）
  - **后端插件**：支持新的测试框架或语言
  - **校验器插件**：自定义的 checker 实现可注册为插件
  - **格式插件**：支持新的契约文件格式（如 YAML-based CDL）
- **插件加载机制**：
  - `stele.config.json` 中的 `plugins` 字段
  - 从 `node_modules` 或本地目录加载
  - 插件 API：`registerOperator()`、`registerBackend()`、`registerChecker()`
- **估算**：4-6 周

#### 4.2.4 远程契约验证集成

- **动机**：与 Pact 集成，实现本地+远程的完整契约验证
- **实现**：
  - 新增 CDL 声明类型：`remote-contract`
    ```lisp
    (remote-contract user-service-contract
      (type pact)
      (consumer "checkout-service")
      (provider "user-service")
      (pact-url "https://pactflow.io/pacts/user-service/checkout-service/latest"))
    ```
  - 在 `stele check` 中触发远程契约验证
  - 将远程契约验证结果纳入 Manifest 锁定
- **估算**：4-6 周

#### 4.2.5 属性测试集成（Property-Based Testing）

- **动机**：结合 Hypothesis/Fast-Check 的随机测试能力
- **实现**：
  - 新增 CDL 声明类型：`property`
    ```lisp
    (property BALANCE_NEVER_NEGATIVE
      (description "Account balance should never be negative after any transaction.")
      (strategy (generate-account))
      (invariant (gte (path account balance) 0)))
    ```
  - 生成 Hypothesis/Fast-Check 风格的测试，自动随机生成输入
  - 利用 shrinking 找到最小反例
- **估算**：4-6 周

#### 4.2.6 GitLab CI / Azure DevOps 集成

- **动机**：覆盖主流 CI 平台
- **实现**：
  - `.gitlab-ci.yml` 模板
  - `azure-pipelines.yml` 模板
  - `stele init` 增加 `--ci` 选项，自动选择 CI 平台
- **估算**：1-2 周

### P3：长远愿景（未来探索）

#### 4.3.1 Stele Cloud（SaaS）

- **愿景**：集中式契约管理和仪表板
- **功能**：
  - 多仓库契约聚合
  - 团队共享的契约库（类似 PACTFlow）
  - 契约变更通知（Slack/Teams 集成）
  - 契约审计日志
  - 跨仓库的契约依赖分析
- **估算**：3-6 个月

#### 4.3.2 跨语言契约

- **愿景**：一个仓库中同时管理 Python、TypeScript、Go 的契约
- **挑战**：不同语言的测试框架、类型系统、运行时差异
- **路径**：先支持多后端共存，再探索跨语言不变量
- **估算**：6-12 个月

#### 4.3.3 AI 代理间契约市场

- **愿景**：开发者可以分享和复用契约规则
- **功能**：
  - `stele publish` — 发布契约包到市场
  - `stele install <package>` — 安装他人发布的契约规则
  - 版本管理和兼容性检查
- **估算**：6-12 个月

#### 4.3.4 形式化验证集成

- **愿景**：将 Stele 的不变量与形式化验证工具（如 Dafny、F*）集成
- **路径**：将 CDL 的不变量翻译为 Dafny 前置/后置条件
- **估算**：9-12 个月

---

## 5. 路线图

### 第一阶段：快速见效（1-2 个月）

目标：**扩大语言覆盖，建立 CI 集成，提升核心体验**

| 序号 | 任务 | 优先级 | 估算 | 依赖 |
|---|---|---|---|---|
| 1 | TypeScript/JavaScript 后端 | P0 | 2-3 周 | `@stele/core` |
| 2 | GitHub Actions 集成 | P0 | 1-2 周 | CLI |
| 3 | pre-commit 钩子 | P0 | 1 周 | CLI |
| 4 | CDL 操作符增强（批次 1） | P0 | 1 周 | `@stele/core` |
| 5 | 增量生成性能优化 | P0 | 2 周 | `@stele/core` |
| 6 | 代码形状（Code Shape）Python 后端补全 | P1 | 2-3 周 | `@stele/core` |

**里程碑**：

- 第一个月：TypeScript 后端 MVP + GitHub Actions + pre-commit
- 第二个月：操作符增强 + 性能优化 + Code Shape 补全

### 第二阶段：平台扩张（3-6 个月）

目标：**覆盖更多语言，增强 AI 代理能力，建立观察性**

| 序号 | 任务 | 优先级 | 估算 | 依赖 |
|---|---|---|---|---|
| 7 | Go 后端 | P1 | 3-4 周 | `@stele/core` |
| 8 | VS Code 扩展 | P1 | 4-6 周 | Tree-sitter 语法 |
| 9 | 自我修复契约 | P1 | 3-4 周 | AI 集成 |
| 10 | 契约变更检测与自动建议 | P1 | 3-4 周 | Git diff 分析 |
| 11 | 观察性仪表板（HTML 报告） | P1 | 2 周 | `stele doc` |
| 12 | 插件生态系统 | P2 | 4-6 周 | 插件 API 设计 |
| 13 | Rust 后端 | P2 | 4-6 周 | `@stele/core` |
| 14 | CDL 操作符增强（批次 2） | P0 | 1 周 | `@stele/core` |

**里程碑**：

- 第三个月：Go 后端 + 观察性仪表板
- 第四个月：VS Code 扩展 MVP + 自我修复契约
- 第五个月：契约变更检测 + 插件系统 MVP
- 第六个月：Rust 后端 + 插件生态完善

### 第三阶段：生态构建（6-12 个月）

目标：**建立完整的生态系统，探索前沿能力**

| 序号 | 任务 | 优先级 | 估算 | 依赖 |
|---|---|---|---|---|
| 15 | Java 后端 | P2 | 4-6 周 | `@stele/core` |
| 16 | 远程契约验证（Pact 集成） | P2 | 4-6 周 | Pact 生态 |
| 17 | 属性测试集成 | P2 | 4-6 周 | Hypothesis/Fast-Check |
| 18 | GitLab CI / Azure DevOps | P2 | 1-2 周 | CLI |
| 19 | Stele Cloud MVP | P3 | 3-6 个月 | 团队规模 |
| 20 | 跨语言契约 | P3 | 6-12 个月 | 多后端 |
| 21 | 契约市场 | P3 | 6-12 个月 | 社区 |
| 22 | 形式化验证集成 | P3 | 9-12 个月 | 学术合作 |

**里程碑**：

- 第八个月：Java 后端 + 远程契约验证
- 第十个月：属性测试集成 + GitLab/Azure CI
- 第十二个月：Stele Cloud MVP + 跨语言契约探索

---

## 6. 风险与建议

### 6.1 技术风险

| 风险 | 严重性 | 缓解措施 |
|---|---|---|
| **CDL 语法学习曲线**：S-expression 对不熟悉 Lisp 的开发者有门槛 | 高 | 提供 YAML/JSON 格式的替代输入；IDE 自动补全和语法高亮 |
| **多语言后端的维护负担**：每新增一个后端需要同步 46+ 操作符的翻译 | 高 | 抽象操作符翻译层（IR），后端只需实现 IR 到目标语言的翻译 |
| **增量生成的正确性**：增量检测遗漏导致不完整的测试生成 | 中 | 严格变更追踪；增量生成后全量校验哈希 |
| **AI 代理的自我修复误判**：自动修复可能引入错误的契约变更 | 高 | 所有自动修复必须经过人类审批；提供 diff 预览和解释 |
| **性能瓶颈**：大型仓库（1000+ 文件）的全量检查耗时过长 | 中 | 增量生成 + 并行化 + 编译缓存 |

### 6.2 市场风险

| 风险 | 严重性 | 缓解措施 |
|---|---|---|
| **Claude Code 平台依赖**：当前深度绑定 Claude Code，如果 Claude Code 改变钩子 API 或关闭平台 | 高 | 优先开发 VS Code 扩展和独立的 CLI 工具；保持与平台无关的核心能力 |
| **AI 编码工具内置类似功能**：Cursor/Copilot 可能推出内建契约验证 | 中 | 保持跨平台（支持所有 AI 编码工具）；建立社区和文档护城河 |
| **开发者对契约工具的疲劳**：已有 Pact/WireMock 等，开发者可能不愿意学习新工具 | 中 | 强调 Stele 的独特价值（AI 代理护栏 + 本地不变量 + 自动测试生成）；提供简单的入门引导 |
| **v0.1 只有 Python 后端**：非 Python 项目无法使用 | 高 | 第一阶段优先开发 TypeScript 后端（JS/TS 是最大的非 Python 市场） |

### 6.3 资源建议

1. **核心团队最小配置**（第一阶段）：
   - 1 名核心开发（TypeScript 后端 + 操作符增强）
   - 1 名集成开发（GitHub Actions + pre-commit + VS Code 扩展）

2. **工具链投资**：
   - 为每个新增后端建立统一的测试 fixture（跨语言的示例项目）
   - 建立 CI 矩阵确保所有后端在所有主要平台上通过测试

3. **文档优先**：
   - 每个新后端发布时必须附带快速入门指南
   - 维护一个 `examples/` 目录，展示各种场景的 CDL 用法
   - 录制视频教程：5 分钟入门 Stele

4. **社区建设**：
   - 在 GitHub Discussions 开放用户反馈通道
   - 举办"契约黑客松"，鼓励用户提交自定义操作符和 checker
   - 编写博客文章系列："在 AI 编码时代保护你的代码库"

5. **商业化路径**（远期）：
   - 开源核心（core + CLI + 后端），SaaS 提供集中式管理（Stele Cloud）
   - 企业版功能：审计日志、合规报告、多租户管理
   - 支持合同：为大型企业提供定制后端开发

---

## 附录 A：CDL 操作符清单（当前 v0.1，共 46 个）

**数据访问**：`path`、`field`、`collection`、`value`

**比较**：`eq`、`neq`、`gt`、`gte`、`lt`、`lte`、`in`、`matches`、`exists-in`、`not-null`、`between`、`approx-eq`、`contains`、`is-empty`、`starts-with`、`ends-with`、`has-length`

**算术**：`add`、`sub`、`mul`、`div`、`neg`、`abs`

**聚合/集合**：`sum`、`count`、`avg`、`min`、`max`、`distinct`、`where`、`unique`

**量词**：`forall`、`exists`、`none`

**布尔/控制流**：`and`、`or`、`not`、`implies`、`iff`、`when`、`if`

**时间/状态**：`within`、`after`、`before`、`modified`、`state-before`、`state-after`

## 附录 B：CDL 声明类型清单（当前 v0.1，共 17 种）

| 声明类型 | 描述 | 后端支持 |
|---|---|---|
| `metadata` | 项目元数据 | 解析/存储 |
| `import` | 递归导入其他契约文件 | 解析/加载 |
| `operator` | 自定义操作符声明 | 解析（不扩展注册表） |
| `checker` | 外部校验器声明 | Python 后端 |
| `group` | 不变量分组 | Python 后端 |
| `invariant` | 核心不变量声明 | Python 后端 |
| `scenario` | 场景设置流程 | Python 后端 |
| `boundary` | 模块边界约束 | 结构类型已定义 |
| `class-shape` | 类结构约束 | 结构类型已定义 |
| `function-shape` | 函数结构约束 | 结构类型已定义 |
| `type-policy` | 类型使用策略 | 结构类型已定义 |
| `file-policy` | 文件内容策略 | 结构类型已定义 |

## 附录 C：CLI 命令清单（当前 v0.1，共 17 个）

| 命令 | 描述 |
|---|---|
| `version` | 打印版本 |
| `baseline-init` | 初始化基线（抑制已知违约） |
| `baseline-update` | 更新现有基线 |
| `check` | 验证契约不变量（`--diff-from`、`--json`、`--report-file`、`--lenient`） |
| `generate` | 从契约源生成测试文件（`--force`） |
| `lock` | 锁定 Manifest（`--reason`） |
| `list` | 列出所有不变量（`--severity`、`--category`、`--tag`、`--format`） |
| `rules` | 显示契约规则清单（`--json`） |
| `explain` | 解释特定不变量（`--json`） |
| `agent-context` | 生成 AI 代理上下文（`--json`、`--focus`） |
| `why` | 显示违约原因（`--json`） |
| `add-checker` | 新增校验器实现 |
| `propose invariant` | 通过受限命令添加新不变量（`--id`、`--severity`、`--description`、`--assert`、`--category`、`--rationale`、`--apply`） |
| `maintenance-summary` | 总结契约维护活动（`--from`、`--output`） |
| `init` | 初始化 Stele 项目（`--language`、`--dry-run`） |
| `dev` | 监听契约变更并自动重新生成（`--once`） |
| `unlock` | 紧急移除锁定（`--reason`、`--confirm`） |
| `doc` | 生成契约文档（`--format`、`--output`） |
