# Phase B Design Review — Reviewer B (Feasibility + Effort + Performance)

视角：实施可行性 / 工程量 / 性能可行性。基于 repo 现状（packages/* 实际代码）和工业实践数据校准。

## Critical Issues

**C-1. Non-TS 后端 0 行 AST 解析代码，估算严重低估**

`packages/backend-{go,java,rust}/src/` 只有 `translator.ts`（≤44 KB TS 代码，纯 codegen），**完全没有任何宿主语言 AST 解析能力**。Python 后端同样只有 `code-shape-renderer.ts` 等 TS 渲染器。文档假设"复用 5 个 backend 已有 AST 解析能力（codegen 用）"——这个前提**不成立**。

后果：
- Python CallGraphExtractor 不是"3 天"。必须新建 Python 子进程（pyright server 或自写 walker），定义 JSON IPC 协议，跨平台子进程管理（Windows pytest 已有过坑），缓存反序列化。实际 **8-12 天**。
- Go CallGraphExtractor 需要 Go 二进制（`go build` 出一个 stele-go-extractor），分发到 `local-packages/`，CI 矩阵增加 go toolchain，发布脚本要打 5 个平台二进制（linux-x64, linux-arm64, mac-x64, mac-arm64, win-x64）。实际 **10-14 天**。
- Java / Rust 同理（JavaParser 是 maven artifact，需要 JVM；`syn` 需要 rustc）。各 **10-14 天**。

**C-2. NodeId arity 规范在重载语言上是有缺陷的标识符**

§3 NodeId 以 `name(arity)` 区分重载。Java 允许 `foo(int)` 和 `foo(long)`，**同 arity 不同签名**。Rust trait impl 同理。`stripe::charges::create(2)` 也无法区分 npm/pip stripe 的不同语言重载。这会导致 5-15% 边解析错配——而契约系统**默默错配比没有更糟**：agent 收到的违例信息会指向错误的目标函数。

修复方向：arity 不够，得带 normalized 参数类型；或者用源码 span 当 ID。规范要返工。

**C-3. 增量缓存策略在"transitive callers"上退化为全图扫描**

§六 "改动文件 F 自身重新解析 + F 的所有 callers 重新解析"。在 monolith / 共享 utils 项目里，`utils/log.ts` 被 80% 文件直接/间接调用。改一行 → "transitive callers" ≈ 整个项目。**增量退化为全量是常态，不是边界**。文档"< 5s 增量"目标失败概率 > 50%。

实际可行方案：只重析 F，依赖图谱里 stale 的 inbound edges——但文档自己承认"会让某些违例发现延迟"。这个 trade-off 必须前置决策，否则发布之后用户改一行等 60s。

## Major Concerns

**M-1. Effect 不动点迭代的"实际 < 5 轮"无依据**

§5 算法是 O(|nodes| × |edges|) per round。每轮所有 edge 扫一遍是 O(|E|)，不动点上界 = max effect-set 增量传播深度 ≈ call-graph diameter。中等 TS 项目 diameter 10-20，**不是 5**。10000 节点 50000 边 × 15 轮 = 7.5 × 10⁶ edge-visit，每 visit 含 Set 并/比较 ~O(|effects|) ≈ 30。**总 2.25 × 10⁸ 操作，单线程 V8 实测 ~30-60s**——独占整个 60s 预算。

正确算法：worklist + reverse postorder，平均 1.5 趟收敛。文档算法是教学版本，实施时必须换。

**M-2. trace-policy 路径枚举的"max depth = 6"过紧**

文档承认"现实代码 10-15 层"。设 cap = 6 意味着深调用链根本不被检查，**契约失效是静默的**。例子：UserController → ContractService → OrderService → PaymentService → AuditWrapper → StripeAdapter → stripe.charge = 6 跳。一旦中间多一个 transformer / middleware，规则就漏检。

cap = 6 + 不报警 = 假阳性零、假阴性巨大。应当超过 cap 时显式 emit warning "trace path exceeded depth, rule not enforced"，否则等于没做。

**M-3. Type State 状态推断在 async / promise / callback 下普遍失败**

§4 的推断算法假设 `submit(o)` 返回 `Order<Submitted>` 直接赋给变量。现实 TS：
```ts
const o = await orderService.submit(orderId); // 经过 service 中转，类型擦除
queue.push(() => o.addItem(...));  // callback 内
```
mypy/pyright 在 Generic phantom + 跨函数边界推断率 < 40%（已有 pyright 性能报告）。lenient 模式 = 不报 = 形同虚设。strict 模式 = 海量误报。**这个机制在不重写代码的项目里基本不可用**。

**M-4. mypy/pyright 子进程在大项目首次启动 8-30s**

Python TypeState 推断"调 pyright 子进程"——pyright 加载 stdlib + 第三方 stub 是冷启动主要开销。每次 stele check 重启 = 不可接受。必须做 pyright daemon 模式 + 长连接 JSON-RPC，又是 3-5 天额外工程。

**M-5. 50 个跨语言 conformance fixture 的维护是黑洞**

§01 §10 + §05 §七：5 语言 × 10 callgraph + 3 机制各 5 语言 × 5 fixture = 至少 65 fixture，每个需要 5 份等价源码 + expected JSON。语义等价（async / 泛型 / closure 在 5 语言里语义差异巨大）人工维护几乎不可能正确。这一项实际工程量 **15-20 天**，且 CI 时间 +20-30 分钟。

**M-6. stage registry 重构会让 stele check 自身在迁移期间挂**

`check.ts` 530 行有 8 个 stage，每个 stage 是 stele 自检的硬约束。重构期任何 stage 被错误标 `shouldRun: () => false` → stele 自身 contract 失守而 CI 仍绿（因为它本来检查的就是 stele 自己）。**自举系统重构是高危**，必须先加 "registry 必含 stage" 元检查。

**M-7. 单 sub-agent 并行写 packages/core/src/validator/structure-types.ts 注定合并冲突**

trace-policy / type-state / 三个 effect form 都会增 `Contract` 字段；删 multi-agent 也改这个文件。文档"重构 4 步 sub-agent 各自独立完成不冲突" — 假的。这五处改动**全在同一文件同一类型定义里**，必须串行。

## Effort Reestimation

| 子任务 | 文档估 | 我估 | 理由 |
|---|---|---|---|
| 重构 4 步（multi-agent 删除 + stage registry + type-driven 包 + render 拆分） | 4 天 | **7 天** | 自举重构需加元检查 + structure-types.ts 串行化 |
| call-graph 抽象 + pattern matcher | 2 天 | 3 天 | NodeId 规范要返工 |
| TS CallGraphExtractor | 3 天 | **6 天** | tsc Program 全项目 + async/decorator/HOC 不可避免要处理边界 |
| Python CallGraphExtractor | 3 天 | **10 天** | 子进程 + pyright 集成（无现成代码） |
| Go CallGraphExtractor | 4 天 | **12 天** | 新建 Go 二进制 + 5 平台发布 |
| Java CallGraphExtractor | 4 天 | **12 天** | JVM 依赖 + JavaParser symbol-solver 配置 |
| Rust CallGraphExtractor | 4 天 | **14 天** | syn + 可选 rust-analyzer + macro 展开 |
| trace-evaluator | 4 天 | 6 天 | 路径枚举 + cap 策略 + worklist |
| type-state evaluator + 推断 | 5 天 | **10 天** | async/promise/callback 真实场景 |
| effect evaluator | 3 天 | 5 天 | worklist 不动点 + suppression |
| CDL 解析 / validator / uniqueness | 4 天 | 4 天 | 合理 |
| design-generator render | 2 天 | 2 天 | 合理 |
| check stage + CLI 集成 | 3 天 | 3 天 | 合理 |
| Conformance / 单元 / 集成测试 | 12 天 | **20 天** | 65 fixture × 5 语言 + CI 矩阵 |
| 文档 + spec 更新 + 错误码 | 1 天 | 3 天 | spec + 错误反馈 + 用户指引 |
| 调试 / agent 反馈循环 / 修 bug buffer | 0 天 | **10 天** | 文档完全没算 |

**第一波（TS + Python）真实估算**：~50 天 → **70-80 天 / 3-3.5 人月**。

**5 语言全做**：~80 天 → **130-150 天 / 6-7 人月**。

文档低估 **40-100%**。

## Performance Reality Check

| 指标 | 文档预算 | 实测预期（中等 TS 项目 1000 文件） | 来源 |
|---|---|---|---|
| TS CallGraph 提取（冷） | <10s | **30-90s** | ts-morph / typescript-eslint --type-check 全项目 typically 60-180s |
| TS CallGraph 提取（热缓存） | - | 10-20s | tsc Program 重建本身就要这个量级 |
| Python pyright 全项目 | - | **45-120s** | pyright 官方 benchmark；冷启动 8-15s |
| 不动点 effect 传播 | <500ms | **3-10s** | 10000 节点 × ~15 轮 V8 实测 |
| 大项目（10000 文件）全检查 | <60s | **3-8 分钟** | 与 SonarQube TS analyzer 同量级 |
| 增量 < 5s | <5s | **20-60s**（除非只改叶子文件） | transitive callers 退化 |
| call-graph.json 文件大小 | "可忽略" | **30-200 MB**（10000 节点 50000 边 + signature 文本） | JSON IO 在 SSD 上 200-800ms，HDD 5-15s |

预算与现实差距 **3-10×**。如果性能目标是用户体验底线，要么砍范围（只检查 src/，不含 tests/）、要么换数据格式（msgpack / sqlite）、要么承认大项目跑 5 分钟。

## Risk Watchlist

按风险大小（即"做错则 Phase B 整体流产"的概率）排序：

1. **(高) 非 TS 后端的 AST 解析栈从 0 起步** — 团队从未在仓库里写过 Go/Rust/Java 解析。低估难度 + 跨语言 ABI / 子进程协议设计不到位 → 第二波永远不会发生。
2. **(高) 性能预算与现实差 3-10×** — 用户实测后失去耐心。MVP 必须先在 finance-guard 示例（~50 文件）和 fixtures/python-app 上做真实性能基准，再约束。
3. **(高) Python TypeState 在主要用例（async/decorator）下推断率 < 50%** — 机制宣传"agent 写不出错"，实测大量误报或漏报，信任崩溃。
4. **(中) NodeId arity 规范的同名重载错配** — 静默给错位置，agent 跟错指示越改越乱。
5. **(中) 自举重构期间 stele check 自检失效** — 需要 ratchet 测试，文档没规划。
6. **(中) 跨语言 conformance fixture 维护悖论** — 5 语言语义不等价的边界（Python 的 dataclass / Go 的 receiver value vs pointer / Rust 的 lifetime）使得"一致结果"目标本身可疑。
7. **(中) sub-agent 并发改 structure-types.ts** — 必须串行化任务图。文档没指出谁先谁后。
8. **(低) 缓存文件 IO 时间** — 30-200 MB JSON 反序列化在普通 SSD ~500ms-3s。可以接受，但应纳入预算。
9. **(低) presets 包（@stele/preset-stripe 等）维护负担** — 在 v0.3 之前都不是阻塞。

## What's Good

- 三机制（trace / typestate / effect）的**语义建模本身正确**——这是真实的契约空白，业界（Rust typestate、Koka effect）已验证形态。
- **D-B-003 决策合理**：第一波只 TS + Python。这是少数对的优先级判断。
- **错误反馈规范（00-overview §D-B-006、02 §6）写得好**：actual_chain + expected + fix-hint + fingerprint，是 agent 能自动修复的关键。这部分不要砍。
- **缓存策略思路正确**：与 v0.2 hash-manifest 复用同机制。
- **MVP 边界（§01 九）正确**：高阶函数 unresolved、polymorphism ambiguous——接受 1% 漏检换 10× 速度，这是工业实践。
- **trace-policy 与 architecture rule 互补、effect 与 trace 互补的定位清晰**，没有重复造轮子。
- **删除 multi-agent 死形式**是该做的清理，工程量 0.5 天估对了。
- **stage registry 重构方向正确**，只是需要加自检 ratchet。

---

**底线建议**：把 Phase B 第一波重新切片成两个 milestone：
- B.1（4-6 周）：TS-only。所有 5 语言 CallGraph 推迟。先证明三机制在最容易的语言上能跑、性能能 take。
- B.2（4-6 周）：Python 加入 + 真实性能基准 + 跨语言 conformance 收敛到 2 语言（不是 5）。

5 语言 CallGraph 作为 Phase B.3 单独立项。这样能把"不知道能不能跑"的风险隔离在 B.1 的小范围里。
