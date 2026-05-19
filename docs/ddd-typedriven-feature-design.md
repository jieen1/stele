# 设计模式推荐与落地：功能设计文档

## 文档目的

本文档面向开发团队，描述在现有契约系统（DSL + 翻译 + Edit Hook 拦截）之上要新增的功能。

新增功能的核心目标：**让用户能够选择推荐的设计模式（DDD + Type-Driven Development），并把这些模式自动落地为契约系统能执行的具体规则**。

本文档不重复已有部分的设计，只描述要新增什么、为什么这样设计、怎么和已有系统衔接。

---

## 第一部分：背景与定位

### 1.1 为什么要做模式推荐

我们的契约系统能让用户写规则、把规则强制执行。但实践中遇到的问题是：**用户不知道该写什么规则**。

一个空白项目，用户面对 DSL 不知道从哪开始。一个已有项目，用户不知道哪些规则该提取成契约。结果是 DSL 的表达能力很强，但用户实际用的能力很浅，产品价值没释放出来。

模式推荐解决的就是这个问题：**用业界成熟的设计模式作为模板，引导用户做出关键的项目级选择，自动生成对应的契约规则**。

### 1.2 推荐的两个模式

经过调研评估，我们推荐两个模式组合使用：

**DDD（领域驱动设计）**：业界最成熟的复杂业务系统组织方法。它定义了"业务系统该如何分层、如何切分模块、如何组织业务规则"。这是项目骨架的方法论。

**Type-Driven Development（类型驱动开发）**：用类型系统编码业务约束，让违反约束的代码编译不过。这是骨架内部血肉的强制层。

两者关系：**DDD 决定项目长什么样，Type-Driven 决定每行代码必须遵守什么**。组合起来可以覆盖项目层面和代码层面两个维度。

### 1.3 为什么是这两个

简短理由（详细评估见附录 A）：

DDD 是覆盖面最广的设计模式，几乎适用所有复杂业务系统。它的"分层、限界上下文、聚合"等概念被业界广泛理解，用户接受度高。

Type-Driven 在 agent 编程时代价值被重新发现——它让 agent "想犯错都犯不出来"，是把约束做到极致的低成本方式。比 DDD 严格，但工程代价仍然可控。

更严格的范式（SPARK、TLA+）只适用极少场景，普通项目用不起。更宽松的范式（纯 OOP、CRUD）对 agent 约束不够。

DDD + Type-Driven 是当前 agent 时代代码组织的甜点位。

### 1.4 我们的产品在这套组合中的角色

我们不是 DDD 工具，也不是 Type-Driven 工具。**我们是这两个模式的执行引擎**。

DDD 提供"应该怎么组织业务系统"的方法论。
Type-Driven 提供"应该如何用类型约束代码"的技术手段。
我们的契约系统提供"如何让上面两件事被真正强制执行"的能力。

具体分工：
- DDD/Type-Driven 提供概念、模式、最佳实践
- 用户在我们的产品中选择适合自己项目的具体形态
- 我们的产品把用户的选择翻译成契约系统能执行的规则
- 已有的 DSL + 翻译 + 拦截机制负责执行

我们不需要在 DDD 或 Type-Driven 上做创新，我们的价值在于让它们能被持续、严格地执行。

---

## 第二部分：要新增的功能总览

按功能模块划分，需要新增三个主要功能：

**功能 A：初始化向导**
引导用户回答关于项目设计选择的结构化问题清单，记录答案。

**功能 B：契约自动生成器**
根据用户的答案，自动生成对应的 DSL 规则、模板代码、工具链配置。

**功能 C：Type-Driven 工具链集成**
对接 TypeScript 编译器、ESLint、Zod 等工具，把它们的输出接入已有的契约违反流程。

下面对每个功能展开。

---

## 第三部分:功能 A——初始化向导

### 3.1 功能描述

用户启动项目时，进入一个分步骤的问答流程，回答关于项目设计选择的问题。每个问题有结构化的选项、说明、推荐默认值。

回答完成后，用户得到一份"项目设计选择清单"（结构化文件，进入版本控制），同时触发功能 B 自动生成契约。

### 3.2 问题清单

下面列出第一版需要支持的问题。按"先回答的影响后回答"的顺序排列。

**问题清单分两组：DDD 相关 + Type-Driven 相关**。

#### DDD 相关问题（共 17 题）

**Q1：业务领域划分**
- A. 单一限界上下文（小项目，<5 个核心实体）
- B. 多个上下文，按业务功能划分（推荐：中型项目）
- C. 多个上下文，按团队边界划分
- D. 多个上下文，按数据所有权划分

输出：限界上下文清单（每个对应明确目录或模块）

**Q2：每对上下文之间的集成模式**（仅 Q1 选 B/C/D 时需要回答）
- A. Shared Kernel（共享小部分模型）
- B. Customer-Supplier（一方主导）
- C. Conformist（完全顺从上游）
- D. Anti-Corruption Layer（防腐层翻译外部概念）
- E. Open Host Service + Published Language
- F. Separate Ways

输出：每对上下文的集成方式声明

**Q3：每个上下文的子领域类型**
- A. Core（核心域，业务价值所在）
- B. Supporting（支撑域）
- C. Generic（通用域）

输出：影响 Q4 的可选项

**Q4：每个上下文的架构风格**
- A. Transaction Script（简单过程式，适合 Generic/Supporting + 简单 CRUD）
- B. Active Record（数据驱动，适合中等复杂度）
- C. Domain Model（领域模型，适合 Core）
- D. Event Sourcing（事件溯源，适合 Core + 需要审计/重放）

输出：该上下文的目录结构、必须存在的层、层间依赖规则

**Q5：领域对象模型风格**
- A. 充血模型（行为放在 entity 里）
- B. 贫血模型 + 领域服务
- C. 函数式风格（数据 + 纯函数，不可变）

输出：项目级风格约束，影响 entity 类的形态规则

**Q6：实体可变性策略**
- A. 完全不可变（每次变更产生新实例）
- B. 部分可变（只允许通过特定方法变更）
- C. 自由可变

输出：entity 类的可变性强制规则

**Q7：错误处理风格**
- A. 抛异常
- B. 返回 Result/Either 类型
- C. 混合：业务错误用 Result，系统错误抛异常

输出：方法签名的强制规则（业务方法不允许 throws 等）

**Q8：值对象 vs 实体的判定**
- A. 有生命周期/标识 = 实体；否则值对象
- B. 可变 = 实体；不可变 = 值对象
- C. 项目方明确清单（每个类显式标注）

输出：领域类的标注规则

**Q9：聚合边界划分原则**
- A. 强一致性边界（聚合内事务一致）
- B. 业务不变量边界（聚合保护业务规则）
- C. 概念完整性边界

输出：聚合声明的元数据规则

**Q10：聚合根复杂度上限**
- 行数上限（默认按节点类型推荐）
- 公开方法数上限
- 关联实体数上限

输出：核心节点的复杂度边界

**Q11：聚合之间如何引用**
- A. 只能通过 ID 引用
- B. 允许只读引用
- C. 完全禁止引用

输出：聚合间依赖的强制规则

**Q12：跨聚合的业务规则放在哪里**
- A. Domain Service
- B. Process Manager / Saga
- C. Application Service
- D. 领域事件 + 事件处理器

输出：业务规则代码的归属规则

**Q13：仓储接口归属层**
- A. Domain Layer（接口在领域层，实现在基础设施层）
- B. Application Layer
- C. Infrastructure Layer

输出：仓储接口的位置约束

**Q14：聚合-仓储的关系**
- A. 一聚合一仓储，仓储 = 聚合的唯一访问点（强烈推荐）
- B. 仓储可以提供跨聚合查询

输出：访问路径的强制规则（涉及防"绕过仓储直接访问数据库"）

**Q15：读写模型分离策略**
- A. 不分离
- B. 仓储分离（写用领域模型，读用查询模型）
- C. 完整 CQRS
- D. CQRS + Event Sourcing

输出：每个上下文内的目录和依赖规则

**Q16：仓储方法的设计约束**
- A. 只返回完整聚合（不返回部分数据）
- B. 必须分页（不允许返回全量集合）
- C. 必须带过滤条件（不允许 findAll）
- D. 上述全部（强烈推荐用于大表场景）

输出：仓储方法签名的硬性约束

**这一题特别重要——它直接解决"agent 在大表上查全量到内存"这类问题**。

**Q17：核心业务不变量清单**
- 列出项目里永远不能违反的业务规则
- 比如"账户余额不能为负"、"订单状态机的合法转换"
- 每条规则标记可演化性（永远不变 / 可经审核演化）

输出：L1 不可变契约的核心条目

#### Type-Driven 相关问题（共 5 题）

**Q18：是否启用 Branded Type 区分相似类型**
- A. 启用（推荐）——所有 ID 类型必须 branded
- B. 仅核心 ID 启用（如 UserId、OrderId）
- C. 不启用

输出：类型定义模板 + 强制规则（业务代码不能用裸 string 作为 ID）

**Q19：是否用 ADT/Sum Type 表达业务状态**
- A. 启用——所有有状态的实体使用 ADT
- B. 仅核心实体启用
- C. 不启用

输出：状态类型定义模板 + 强制 pattern match 穷尽性

**Q20：是否用 Smart Constructor 强制值对象不变量**
- A. 启用——所有值对象通过 smart constructor 创建
- B. 仅核心值对象启用
- C. 不启用

输出：值对象构造规则（不允许 public constructor）

**Q21：是否用 Type State Pattern 表达状态机**
- A. 启用——所有状态机用类型编码
- B. 仅核心状态机启用
- C. 不启用

输出：状态机的类型骨架模板

**Q22：运行时校验工具选择**
（仅 Type-Driven 选了启用时需要回答）
- A. Zod（TypeScript 推荐）
- B. io-ts（TypeScript 函数式风格）
- C. Bean Validation（Java）
- D. Vavr（Java 函数式）
- E. Pydantic（Python）
- F. 自定义

输出：工具链配置 + schema 模板

### 3.3 向导的交互设计

每个问题的展示要包含：
- 问题文本（一句话清楚）
- 选项列表（带简短说明）
- 决策指南（什么情况下选哪个，2-3 句话）
- 默认推荐（根据前面回答的项目特征智能推荐）
- 案例（可选，展示真实项目里的典型选择）

问题之间有依赖关系（如 Q2 依赖 Q1、Q4 依赖 Q3）。向导要正确处理这些依赖，不让用户回答无关的问题。

某些问题需要按粒度多次回答（比如 Q2 是每对上下文一次、Q4 是每个上下文一次、Q10 是每个核心节点一次）。向导要支持这种"按粒度的多次回答"。

### 3.4 向导的输出

完成后输出一份结构化的"项目设计选择清单"文件（建议格式：YAML 或 JSON，进入版本控制）。文件示例：

```yaml
project_design_choices:
  version: 1
  generated_at: 2026-05-19
  
  ddd:
    bounded_contexts_strategy: "by_business_function"
    bounded_contexts:
      - name: "account"
        subdomain_type: "core"
        architecture_style: "domain_model"
        aggregate_max_lines: 300
        aggregate_max_methods: 15
      - name: "payment"
        subdomain_type: "core"
        architecture_style: "event_sourcing"
        ...
    
    context_integrations:
      - from: "payment"
        to: "account"
        pattern: "anti_corruption_layer"
    
    domain_model_style: "rich"
    entity_mutability: "immutable"
    error_handling: "result_type"
    
    aggregate_reference_rule: "id_only"
    repository_location: "domain_layer"
    repository_pattern: "one_per_aggregate"
    query_constraints:
      - "no_full_table_scan"
      - "must_have_limit_or_cursor"
      - "must_return_complete_aggregate"
    
    cross_aggregate_rules_location: "domain_service"
    
    core_invariants:
      - id: "account_balance_non_negative"
        description: "账户余额永远不能为负"
        evolvability: "never"
      - id: "order_state_transitions"
        description: "订单状态机的合法转换"
        evolvability: "with_review"
  
  type_driven:
    branded_types: "core_ids_only"
    branded_id_types: ["UserId", "OrderId", "PaymentId", "AccountId"]
    
    adt_usage: "core_entities_only"
    adt_entities: ["Order", "Payment"]
    
    smart_constructors: "all_value_objects"
    value_objects: ["Email", "Money", "PhoneNumber"]
    
    type_state_pattern: "core_state_machines_only"
    state_machines: ["Order", "Payment"]
    
    runtime_validation_tool: "zod"
```

这份文件是后续所有工作的源头。

### 3.5 选择清单的演化

用户的选择可以演化（业务变化时）。演化机制：

- 选择清单本身是版本化的（每次修改产生新版本）
- 修改某项选择 = 触发对应的契约重新生成 + 现有代码的兼容性检查
- 重大修改（如改变限界上下文划分）需要用户显式确认 + 调研产出
- 演化历史记录到事件流

---

## 第四部分：功能 B——契约自动生成器

### 4.1 功能描述

根据用户在向导中的选择，自动生成三类输出：

1. **DSL 规则文件**——进入现有契约系统执行
2. **代码模板**——给项目方作为起点的脚手架
3. **工具链配置**——tsconfig、ESLint、测试框架等的配置文件

### 4.2 生成器的工作模式

生成器是个**模板引擎**——对每个可能的选择组合，预先准备好对应的模板。用户的选择驱动模板的具体实例化。

工作流程：

```
用户选择清单（YAML）
        ↓
模板引擎（按规则匹配模板）
        ↓
   ┌───────┴───────┐
   ↓               ↓
DSL 规则       代码模板
   ↓               ↓
现有契约       项目骨架
执行管道       脚手架
```

### 4.3 各类生成内容

#### 4.3.1 DSL 规则生成

每个用户选择映射到一组 DSL 规则。下面按选择项列出生成的规则类型（不写具体 DSL 语法，由实现时确定）：

**Q1 选择（限界上下文划分）** → 生成：
- 每个上下文的目录边界规则（"src/account/" 是 account 上下文）
- 跨上下文调用的拦截规则（默认禁止，除非显式声明）

**Q2 选择（集成模式）** → 生成：
- 例如选 ACL：生成"payment 上下文调用 account 上下文必须经过 AccountAdapter"
- 例如选 OHS：生成"account 上下文对外只能通过 public API 调用"

**Q4 选择（架构风格）** → 生成：
- 选 Domain Model：生成层次结构契约（presentation/application/domain/infrastructure）+ 层间依赖规则
- 选 Event Sourcing：生成事件存储和投影的目录结构 + 命令处理器规则

**Q5 选择（充血/贫血/函数式）** → 生成：
- 充血：domain service 应该薄、业务规则在 entity 里
- 贫血：entity 不应该有业务方法
- 函数式：entity 必须不可变 + 业务逻辑在纯函数里

**Q6 选择（可变性）** → 生成：
- 不可变：entity 字段必须 final/readonly、必须实现 with*() 方法返回新实例

**Q7 选择（错误处理）** → 生成：
- Result 类型：业务方法签名不允许 throws、必须返回 Result/Either

**Q8 选择（值对象/实体判定）** → 生成：
- 显式标注：每个领域类必须有 @Entity 或 @ValueObject 标注，否则违反契约

**Q9 选择（聚合边界）** → 生成：
- 聚合根类必须有 @AggregateRoot 标注
- 聚合内部类不能被聚合外部直接引用

**Q10 选择（复杂度上限）** → 生成：
- L3 复杂度契约的具体阈值

**Q11 选择（聚合间引用）** → 生成：
- 选"只能通过 ID 引用"：禁止聚合 A 的代码 import 聚合 B 的实体类型

**Q13/Q14 选择（仓储位置和模式）** → 生成：
- 仓储接口的位置规则
- 一聚合一仓储 + 仓储是聚合的唯一访问点

**Q16 选择（仓储方法约束）** → 生成：
- 仓储方法必须接受 limit/cursor 参数
- 仓储方法返回类型必须是 Stream 或 Page，不能是 List
- 不允许命名为 findAll 之类的全量查询方法
- 业务代码不能直接调用 ORM/数据库 API

**Q17 选择（核心不变量）** → 生成：
- L1 不可变契约的具体条目
- 每条不变量对应一个或多个单元测试

**Q18 选择（Branded Type）** → 生成：
- 类型定义模板（见 4.3.2）
- 规则：项目里所有标记为 ID 的字段必须使用 branded 类型，不能用裸 string

**Q19 选择（ADT）** → 生成：
- ADT 类型定义模板
- 规则：标记为有 ADT 状态的实体必须使用对应 ADT 类型、pattern match 必须穷尽

**Q20 选择（Smart Constructor）** → 生成：
- 值对象类必须 private constructor
- 必须提供 static factory method
- factory method 必须做不变量校验

**Q21 选择（Type State）** → 生成：
- 状态机类型骨架
- 规则：状态转换方法只能在对应状态类上存在

**Q22 选择（运行时验证工具）** → 生成：
- 对应工具的 schema 模板
- 规则：项目外部输入必须经过 schema 校验后才能进入业务代码

#### 4.3.2 代码模板生成

除了 DSL 规则，生成器还生成项目骨架代码——给用户一个能直接开始写业务的起点。

按用户选择生成的代码模板包括：

**目录结构**：按 Q1、Q4 选择生成上下文目录 + 层目录

**类型定义模板**：

如果选了 Branded Type（Q18），生成类似：
```typescript
// types/branded.ts （TypeScript 例子）
export type Brand<T, B> = T & { readonly __brand: B }
export type UserId = Brand<string, 'UserId'>
export type OrderId = Brand<string, 'OrderId'>
// ... 根据用户选择的 ID 类型清单生成

export const UserId = {
  from: (s: string): UserId | null => {
    if (!/^[a-z0-9-]+$/.test(s)) return null
    return s as UserId
  }
}
```

如果选了 ADT（Q19），生成类似：
```typescript
// domain/order/Order.ts
export type Order =
  | { type: 'draft', orderId: OrderId, items: Item[] }
  | { type: 'submitted', orderId: OrderId, items: Item[], submittedAt: Date }
  | { type: 'shipped', orderId: OrderId, items: Item[], submittedAt: Date, trackingNumber: string }
  | { type: 'cancelled', orderId: OrderId, reason: string }
```

如果选了 Smart Constructor（Q20），生成类似：
```typescript
// domain/common/Email.ts
export class Email {
  private constructor(public readonly value: string) {}
  
  static parse(input: string): Email | null {
    if (!input.includes('@') || input.length > 255) return null
    return new Email(input)
  }
}
```

**仓储接口模板**（按 Q14、Q16 选择）：

```typescript
// domain/account/AccountRepository.ts
export interface AccountRepository {
  // 必须带 limit/cursor 参数
  findByUserId(userId: UserId, limit: number, cursor?: string): Promise<AccountPage>
  
  // 单条查询带 ID
  findById(id: AccountId): Promise<Account | null>
  
  // 不允许 findAll 之类的方法（如果生成了会被规则禁止）
}
```

**业务流程骨架**（按 Q5、Q7、Q12 选择）。

#### 4.3.3 工具链配置生成

按用户选择生成工具链配置：

- TypeScript：tsconfig.json（strict、noImplicitAny 等）
- ESLint：eslint.config.js + 选定的规则包
- Zod/io-ts：基础 schema 文件
- 测试框架：jest.config.js / vitest.config.ts
- Git hooks：pre-commit 配置

这部分都是用模板生成，不需要复杂逻辑。

### 4.4 生成器的演化

生成器的模板需要随着实践积累而演化：

- 用户反馈某个模板有问题 → 模板修订
- 新的最佳实践出现 → 加入新模板
- 用户的某些组合选择没有现成模板 → 需要补充

建议模板和生成器代码分离——模板用类似 Handlebars/Jinja2 的格式，可以独立维护和扩展。

---

## 第五部分：功能 C——Type-Driven 工具链集成

### 5.1 功能描述

把 Type-Driven 相关的工具（编译器、linter、schema 校验库）接入已有的契约违反流程。

这部分**主要是适配工作，不是核心开发**——业界工具都现成，我们做的是把它们的输出转换成我们系统能理解的"契约违反事件"。

### 5.2 集成对象

**第一优先级（TypeScript 优先支持）**：

- **TypeScript 编译器（tsc）**：类型错误是最强的 Type-Driven 违反信号。tsc 报错 = 类型契约被违反 = 触发我们的拦截流程
- **typescript-eslint**：自定义 lint 规则，覆盖类型系统抓不到的部分
- **Zod**：运行时 schema 校验。在测试环境运行 schema 校验失败 = 契约违反

**第二优先级**：

- **Java：ArchUnit + Bean Validation + Vavr**
- **Python：mypy + Pydantic**
- **Rust：cargo check + clippy**

### 5.3 集成方式

对每个工具，需要做三件事：

**1. 调用工具并解析输出**
- 在合适的时机（write 时 / commit 时 / 编译时）调用工具
- 解析工具的输出（错误信息、文件位置、错误类型）

**2. 转换为契约违反事件**
- 把工具的错误转换成统一的"契约违反事件"格式
- 关联到对应的契约规则（哪条规则被违反了）
- 进入已有的事件流和拦截流程

**3. 触发已有的调研流程**
- agent 看到的是"你违反了 X 契约"，不是"tsc 报错了"
- 调研的产出和处理流程完全复用现有的

### 5.4 配置文件生成

集成的另一面是配置——每种工具需要正确的配置才能起到 Type-Driven 强制作用。

按用户选择，生成器要给出对应配置：

**TypeScript（如果用户选了 Type-Driven）**：

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

**typescript-eslint 规则集**：

```javascript
{
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/switch-exhaustiveness-check': 'error',
    '@typescript-eslint/no-non-null-assertion': 'error',
    // ...
  }
}
```

这些配置不需要复杂逻辑生成，预设几个套餐让用户选择即可。

### 5.5 工具集成的不做的事

明确不做的：

- 不自己写类型推断引擎、AST 解析器
- 不重新实现 Zod / Pydantic 等 schema 库
- 不替代任何已有工具

我们只做"调用 + 解析输出 + 转换格式"的胶水工作。

---

## 第六部分：和已有系统的衔接

### 6.1 关系图

```
新增功能：
┌──────────────────────────────────────────┐
│  功能 A：初始化向导（22 题问答）             │
│         ↓                                  │
│       用户选择清单（YAML）                   │
│         ↓                                  │
│  功能 B：契约生成器                          │
│  - 生成 DSL 规则                            │
│  - 生成代码模板                              │
│  - 生成工具链配置                            │
│         ↓                                  │
│  功能 C：Type-Driven 工具集成                │
│  - tsc/ESLint/Zod 错误 → 契约违反事件        │
└──────────────────────────────────────────┘
                  ↓
        已有契约系统（不改动）：
        - DSL 翻译 + 测试生成
        - Edit hook 拦截
        - 用户确认流程
        - 跨语言/测试框架适配
```

### 6.2 衔接点

**衔接点 1：DSL 规则**
功能 B 生成的 DSL 规则直接喂给已有的契约系统。已有系统按它现在的方式翻译、拦截、执行。**已有系统不需要任何改动**。

**衔接点 2：契约违反事件**
功能 C 把工具错误转换成契约违反事件，按已有系统的事件格式输出。已有的拦截流程接收事件并处理。**已有的拦截流程不需要任何改动**。

**衔接点 3：用户确认**
当用户的设计选择需要变更时，走已有的"用户确认契约修改"流程。新增的部分是：**选择清单的修改也走这个流程**——修改选择清单 = 修改一组契约 = 走确认流程。

### 6.3 已有系统需要的小改动

虽然衔接点都是新功能调用已有系统，但有几个小改动是需要的：

**改动 1：契约规则要支持"来源标记"**
每条规则要记录它是用户手写的还是生成器生成的。这样后续：
- 生成器更新模板时，能识别哪些规则可以自动更新（标记为生成的）、哪些不能（用户手写的）
- 可观测界面可以分别展示

**改动 2：契约违反事件要支持新的"违反类型"**
新的违反类型包括类型错误（来自 tsc）、ESLint 规则违反、schema 校验失败等。已有系统的事件 schema 要扩展。

**改动 3：用户确认流程要支持"批量确认"**
修改选择清单可能触发一组契约同时变更。已有流程需要支持"用户一次确认多个契约的修改"。

这三个改动都是小幅扩展，不破坏已有结构。

---

## 第七部分：分阶段实施计划

按优先级和价值排序，分四个阶段：

### 阶段一：DDD 初始化向导 + 契约生成（基础能力）

**目标**：让用户能通过问答生成基本的 DDD 契约。

**任务**：
1. 实现 DDD 部分的初始化向导（Q1-Q17）
2. 实现基本的契约生成器（DSL 规则 + 目录结构 + 简单代码模板）
3. 已有契约系统的"来源标记"改动

**产出**：用户答完 DDD 问题，能在项目里看到生成的契约文件和目录结构。

**验证**：在一个真实小项目里走通流程。

### 阶段二：Type-Driven 集成（TypeScript 优先）

**目标**：让 Type-Driven 选项变得可用，TypeScript 项目能享受强类型保护。

**任务**：
1. 实现 Type-Driven 部分的初始化向导（Q18-Q22）
2. TypeScript 的类型模板生成（Branded Type、ADT、Smart Constructor、Type State）
3. tsc / typescript-eslint / Zod 的集成
4. 工具错误 → 契约违反事件的转换

**产出**：TypeScript 项目能完整使用 DDD + Type-Driven。

**验证**：在一个真实 TypeScript 项目里验证 agent 写错类型会被拦截。

### 阶段三：用户体验完善

**目标**：让向导和生成器真正好用。

**任务**：
1. 向导的每题决策指南、案例补充
2. 智能默认推荐（根据前面回答推荐合理默认值）
3. 选择清单的修改流程（演化、版本化）
4. 生成器的模板可定制（用户可以修改模板）

**产出**：产品级体验，新用户能顺畅完成初始化。

### 阶段四：多语言扩展

**目标**：把能力扩展到 TypeScript 之外。

**任务**：
1. Java 集成：ArchUnit + Bean Validation + Vavr + sealed class
2. Python 集成：mypy + Pydantic
3. 按需扩展其他语言

**产出**：覆盖主流后端语言。

---

## 第八部分：关键设计决策记录

记录几个重要决策，避免未来重复纠结：

**决策 1：先做 DDD，再做 Type-Driven**
理由：DDD 覆盖面更广、用户接受度高。Type-Driven 是强化，在 DDD 之上做更有价值。

**决策 2：Type-Driven 第一语言选 TypeScript**
理由：TypeScript 的 Type-Driven 工具链最成熟（zod、io-ts、Effect-TS），用户基数大。Rust 虽然 Type-Driven 更纯粹但用户少。

**决策 3：不自己造工具，集成现有的**
理由：tsc、ArchUnit、Zod、ESLint 等已经经过工业验证，重新发明既无价值也拖慢交付。我们的差异化在于把它们的输出统一接入契约系统。

**决策 4：用户选择清单是版本化的、进入版本控制**
理由：选择清单是项目的核心设计文档，应该随代码一起演化、被 review、被追溯。

**决策 5：生成的代码是模板/脚手架，用户可以修改**
理由：生成器不可能完美匹配每个项目，必须允许用户调整。但调整后要被现有契约系统继续守护。

**决策 6：模式是推荐而非强制**
理由：不是所有项目都适合 DDD/Type-Driven。我们引导但不强迫。用户可以选择不用任何模式，仍然手写契约规则。

**决策 7：不和 DDD/Type-Driven 工具竞争**
理由：我们的产品定位是"约束的执行引擎"。设计模式领域我们不创新，我们让别人的创新能被严格执行。

---

## 附录 A：为什么选这两个模式

### A.1 设计模式严格度光谱

从松到紧，业界主要的代码组织方式：

1. **无约束 / 自由风格** - 最松，agent 时代灾难
2. **MVC / 分层架构** - 给出大方向，约束力弱
3. **DDD** - 提供完整方法论，约束力中等（靠人类纪律执行）
4. **DDD + ArchUnit** - DDD 加上架构层强制
5. **Type-Driven Development** - 用类型系统强制业务约束
6. **Design by Contract（Eiffel/Ada）** - pre/post condition 强制
7. **SPARK/Ada 形式化验证** - 数学证明级别
8. **TLA+/Coq 完全形式化** - 研究级，工程不可行

### A.2 为什么选 DDD（第 3 档）

- 覆盖面最广，适用绝大多数复杂业务系统
- 业界接受度最高，用户学习成本低
- 配套工具（ArchUnit 类）成熟
- 它的"靠人类纪律"问题正是我们的契约系统能解决的

### A.3 为什么加 Type-Driven（第 5 档）

- 在 DDD 基础上把约束做到更强
- agent 时代价值被重新发现——agent 没有人类直觉，类型强制对它特别有效
- 工程代价可控（不需要换语言，主流语言都能用）
- 工具链成熟（tsc、ESLint、Zod、io-ts 等）

### A.4 为什么不选更严格的

**Design by Contract（Eiffel/Ada）**：
- 主流语言原生支持弱
- 团队学习成本高
- 适用范围窄

**SPARK 形式化**：
- 只适用航空、医疗等高安全场景
- 开发速度慢 5-10 倍
- 普通团队完全不可行

**TLA+/Coq**：
- 研究级工具
- 工程实践基本不可能

### A.5 严格度的甜点位

约束的有效性 = 约束强度 × 实际被采用程度 × 项目实际需要

最严格的范式（SPARK/TLA+）"采用程度" 极低，乘积小。
DDD + Type-Driven 的"约束强度"够用，"采用程度"高，"项目实际需要"高，乘积最大。

这就是我们选择这两个模式的原因。

---

## 附录 B：术语速查

**Branded Type**：通过类型系统区分语义不同但底层相同的类型，比如 `UserId` 和 `OrderId` 底层都是 string，但通过 brand 让它们不能互相赋值。

**ADT（Algebraic Data Type）/ Sum Type / Discriminated Union**：用一组互斥的"形态"描述一个类型。比如 Order 可以是 Draft 或 Submitted 或 Shipped，每种形态有不同的字段。让"草稿状态有快递单号"这种非法组合在类型层面无法表达。

**Smart Constructor**：私有构造器 + 公开 factory method，让对象只能通过校验后的入口创建，保证不变量。

**Type State Pattern**：用不同的类型代表对象的不同状态，状态转换通过方法签名表达。比如 DraftOrder 上没有 ship() 方法，必须先 submit() 得到 SubmittedOrder 才能 ship()。

**限界上下文（Bounded Context）**：DDD 概念。一个明确划定的业务范围，里面的概念有特定的含义。同一个词"用户"在不同上下文可能指不同的东西。

**聚合（Aggregate）**：DDD 概念。一组紧密相关的对象的集合，作为一个一致性单元被处理。聚合根是这个集合的入口。

**仓储（Repository）**：DDD 概念。聚合的持久化抽象。理想情况下每个聚合一个仓储，仓储是访问聚合的唯一入口。

**ACL（Anti-Corruption Layer）**：DDD 概念。两个上下文之间的翻译层，防止外部上下文的概念污染自己的领域模型。

**CQRS（Command Query Responsibility Segregation）**：把"写操作"和"读操作"分离，用不同的模型处理。

**Event Sourcing**：把所有状态变更存为不可变事件流，当前状态通过事件回放计算得到。
