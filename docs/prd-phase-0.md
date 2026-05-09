# Stele Phase 0 需求文档

> 版本: 2.0 | 日期: 2026-05-08 | 状态: 已审查 (Round 1 + Round 2)
> 范围: Phase 1 启动前的硬性前置（约 2 周）
> 依据: [Round 1 审查综合](internal/prd-round-1-review.md) §3.1 关键路径

---

## 1. 背景

Phase 1 的 5 个 EP 全部假设了若干基础设施事实，而这些事实当前**不成立**：

- npm 包未发布到公共 registry（README 文档 tarball 安装），但 EP02（GitHub Action）需要 Marketplace 发布且 Marketplace 拒收依赖私有 tarball 的 Action
- `@stele/core` 测试覆盖率约 35%，关键文件（`structure.ts` 1700 行、`SteleError.ts`、`baseline/io.ts`）直接单测为 0；在此基座上加 EP01 的 TypeScript 后端会让"对比测试通过"假阳性化
- `LanguageBackend` 调度在 `packages/cli/src/commands/generate.ts:75-82` 硬编码 `if (targetLanguage !== "python") throw`；EP01/EP06/EP12 都假设这是注册表式调度
- EP01 验收要求"TS 后端与 Python 后端对同一 CDL 文件行为一致"，但没有 fixture 集、没有比对工具、没有"一致"的定义

Phase 0 显式承担这四件事，让 Phase 1 在确定的地基上启动。

## 2. 目标

| # | 工作项 | 包/位置 | 估算 |
|---|---|---|---|
| W0.1 | 首发 npm 发布 v0.1.0 | `@stele/core`, `@stele/backend-python`, `@stele/cli`, `@stele/claude-code-plugin` | 2-3 天 |
| W0.2 | 测试债冲刺（核心覆盖率 ≥ 50%） | `@stele/core` 关键模块 | 1 周 |
| W0.3 | `LanguageBackend` 调度重构 | `@stele/cli`、`@stele/core` | 2-3 天 |
| W0.4 | 跨后端一致性测试套件 | 新目录 `tests/conformance/` | 2-3 天 |

并行执行：W0.1 和 W0.2 可以并行（不同人/时段），W0.3 必须先于 W0.4。

## 3. 设计原则

- **不增加新功能**：本阶段只清理现有承诺的债务，不引入新的用户可见功能
- **可验证**：每一项有可运行的验收命令
- **不破坏现有用户**：内部重构与发布不改变外部 CLI 接口

## 4. W0.1: npm 发布 v0.1.0

### 4.1 背景

`scripts/publish-npm.mjs` 已支持打包、`workspace:*` 校验、`provenance` 上传。但**实际发布从未执行**。这阻塞 EP02 的 Marketplace 发布与外部用户的 `npm install -g @stele/cli` 路径。

### 4.2 需求规格

#### 4.2.1 npm 账户与信任发布

- 在 npm 上申请 `@stele` scope（如已存在则确认所有权）
- 在 GitHub 仓库上配置 [trusted publishing](https://docs.npmjs.com/trusted-publishers)：把 `.github/workflows/publish.yml` 与 npm 包绑定
- 验证 `id-token: write` 权限已启用（`.github/workflows/publish.yml` 已有该字段，需确认未被回滚）

#### 4.2.2 首次发布顺序

```
1. @stele/core               (其他包依赖)
2. @stele/backend-python     (依赖 core)
3. @stele/cli                (依赖 core + backend-python)
4. @stele/claude-code-plugin (独立)
```

`scripts/publish-npm.mjs` 当前按目录顺序处理，需确认依赖顺序正确。

#### 4.2.3 占名（name squat 防御）

提前占用 Phase 1/2 计划新增的 npm 包名：

- `@stele/backend-typescript`（EP01 占用）
- `@stele/github-action`（EP02，**注意**：Action 实际通过 GitHub Marketplace 分发，不通过 npm；但占用 npm 名以防混淆）
- `@stele/backend-go`（Phase 2 EP09 占用）
- `@stele/agent-hooks`（Phase 2 EP14 占用）
- `@stele/vscode-extension`（Phase 2 EP10 占用，**注意**：VS Code 扩展通过 Marketplace 分发；占用 npm 名仅为防混淆）

每个占名包发布 `0.0.1-placeholder` 版本，README 写明"reserved for future release"。

#### 4.2.4 GitHub Marketplace 准备

- 在 GitHub 上申请 publisher 账户（个人或组织）
- 检查 `gh auth status` 在发布机器有效
- 确认 GitHub Action 的 publishing 权限范围（Action 通过 git tag + Marketplace UI 提交，不是 npm publish）

#### 4.2.5 VS Code Marketplace 准备

VS Code 扩展（Phase 2 EP11）通过 Microsoft 的 [Visual Studio Marketplace](https://marketplace.visualstudio.com) 分发，与 GitHub Marketplace 是不同体系。Phase 0 仅完成账户准备工作，实际发布在 EP11 完成时执行：

- 在 [Azure DevOps](https://dev.azure.com) 创建 organization 并获取 Personal Access Token (PAT)
- 在 Visual Studio Marketplace 注册 publisher（推荐 publisher id：`stelehq`）
- 在发布机器上 `npm install -g @vscode/vsce` 并通过 `vsce login stelehq` 验证 PAT 有效
- 占用 extension id `stelehq.stele-vscode`（通过推送一个仅含 README 的 placeholder version `0.0.1`，避免被他人占名）

### 4.3 验收标准

- [ ] `npm view @stele/core` 返回 v0.1.0 元数据
- [ ] `npm view @stele/cli@0.1.0 dist.tarball` 返回有效 URL
- [ ] 在干净 Docker 环境运行 `npm install -g @stele/cli && stele --version` 成功输出版本
- [ ] `npm view @stele/backend-typescript` 返回 placeholder（占名成功）
- [ ] GitHub trusted publishing 工作流上 `id-token` 与 npm registry 双向验证通过
- [ ] `vsce login stelehq` 成功（VS Code Marketplace publisher 账户就位）
- [ ] `stelehq.stele-vscode` 在 Visual Studio Marketplace 上以 placeholder 0.0.1 占名

### 4.4 不在范围内

- Marketplace 实际发布 GitHub Action（Phase 1 EP02 完成时执行）
- VS Code Marketplace 实际发布扩展（Phase 2 EP11 完成时执行）
- 自动化版本发布（保持 `pnpm release:publish` 手动触发）

## 5. W0.2: 测试债冲刺

### 5.1 背景

`docs/internal/test-coverage-gap-report.md`（2026-05-07 快照）后代码经过重构。**当前实际状态**（2026-05-08 验证）：

| 模块 | 行数 | 直接单测 | 备注 |
|---|---|---|---|
| `validator/structure.ts` | 72 | 部分 | 重构后变薄；主要逻辑迁移到下方 5 个文件 |
| `validator/structure-code-shape.ts` | 524 | 0 | 拆分产物，含 boundary/class-shape/function-shape/type-policy/file-policy 校验 |
| `validator/structure-invariant.ts` | 316 | 0 | 拆分产物，invariant 字段校验 |
| `validator/structure-parse.ts` | 329 | 0 | 拆分产物，顶层声明分派 |
| `validator/structure-scenario.ts` | 392 | 0 | 拆分产物，scenario / step / capture 校验 |
| `validator/structure-types.ts` | 286 | 部分 | 拆分产物，AST 类型 + 类型推导 |
| `validator/structure-error.ts` | 14 | 0 | 错误码常量 |
| `errors/SteleError.ts` | 15 | 0 | 错误类构造（小但是公共 API）|
| `baseline/io.ts` | 83 | 0 | baseline 文件读写 |
| `loader/loadContract.ts` | 87 | 部分 | 递归 import 加载 |
| 其他模块 | — | — | 平均 ~50% |
| **整体核心** | — | — | **~35%** |

EP01 会在结构校验之上叠加新的 backend；EP04 会在操作符注册表之上叠加 18 个新操作符。在覆盖率不达 50% 的基座上加这些代码，"现有测试通过"承诺会假阳性。

### 5.2 需求规格

#### 5.2.1 覆盖目标

- `@stele/core` 整体行覆盖率 **≥ 50%**（用 `vitest --coverage`）
- `validator/structure-*.ts` 拆分系列**整体**直接单测覆盖率 **≥ 60%**（重点：每种顶层声明 + 错误路径；five files 聚合统计）
- `errors/SteleError.ts` **≥ 80%**（错误构造、序列化、code 映射；文件小但是公共 API）
- `baseline/io.ts` **≥ 70%**（读、写、损坏文件、不存在文件、版本不匹配）
- 现有 861 个测试**继续 100% 通过**

> 实际更可衡量的目标：**EP01 conformance suite 能区分真正的 Python 后端回归 vs TypeScript 实现 bug**。覆盖率百分比是手段，不是终点；如果覆盖率达标但 conformance suite 仍假阳性，本 W0.2 不算完成。

#### 5.2.2 测试编写约束

- **不许引入新的 production code**：仅写测试
- **不许修改现有 production code 的接口**：可修内部细节但外部 API 冻结
- **必须用 vitest 框架**：与项目其余测试一致
- **使用 `fixtures/python-app/` 已有 contract 文件作为 fixture 来源**：不重复造样本

#### 5.2.3 优先级排序

按"被 EP01-EP05 直接引用 × 当前覆盖低"双维度优先：

1. `validator/structure-code-shape.ts`（524 行，被 EP06 Code Shape 直接消费；0 直接单测）
2. `validator/structure-scenario.ts`（392 行，被 EP01 scenario runtime 间接消费）
3. `validator/structure-invariant.ts`（316 行，所有 invariant 路径必经）
4. `validator/structure-parse.ts`（329 行，所有顶层声明入口）
5. `loader/loadContract.ts`（被 EP01/EP05 调用）
6. `manifest/manifest.ts`（被 EP05 增量缓存关联）
7. `errors/SteleError.ts`（在 EP02 注解输出中暴露；小文件但公共 API）
8. `baseline/io.ts`（被 EP05 调用）

### 5.3 验收标准

- [ ] `pnpm --filter @stele/core test --coverage` 输出行覆盖率 ≥ 50%
- [ ] `validator/structure-*.ts`（5 个拆分文件聚合）直接单测覆盖率 ≥ 60%（用 c8/v8 报告确认；72 行的 `structure.ts` shim 文件不单独要求覆盖率）
- [ ] 全部 861 个旧测试继续通过，不允许标记 `.skip`
- [ ] 不允许引入新 production code 文件（`git diff --stat` 仅显示 `tests/` 修改）

## 6. W0.3: LanguageBackend 调度重构

### 6.1 背景

当前实现：

```ts
// packages/cli/src/commands/generate.ts:75-82
if (targetLanguage !== "python") {
  throw new Error(`Unsupported target language: ${targetLanguage}. Only "python" is supported.`);
}
const backend = await import("@stele/backend-python");
```

EP01（TypeScript 后端）和 Phase 2 EP09（Go 后端）都假设这是一个注册表式调度。

### 6.2 需求规格

#### 6.2.1 注册表设计

新增 `packages/cli/src/backend-registry.ts`：

```ts
import type { LanguageBackend } from "@stele/core";

interface BackendModule {
  default?: LanguageBackend;
  backend?: LanguageBackend;
}

interface RegisteredBackend {
  /** 配置中 targetLanguage 字段值 */
  language: string;
  /** 配置中 testFramework 字段值，可省略表示任意 framework */
  framework?: string;
  /** 动态导入的 npm 包名 */
  packageName: string;
  /** 命令展示名 */
  displayName: string;
}

const REGISTERED_BACKENDS: readonly RegisteredBackend[] = [
  {
    language: "python",
    framework: "pytest",
    packageName: "@stele/backend-python",
    displayName: "Python (pytest)",
  },
];

export async function loadBackend(
  language: string,
  framework: string | undefined
): Promise<LanguageBackend> {
  const entry = REGISTERED_BACKENDS.find(
    (b) => b.language === language && (!b.framework || b.framework === framework)
  );
  if (!entry) {
    const supported = REGISTERED_BACKENDS.map((b) => b.displayName).join(", ");
    throw new SteleError({
      code: "E_UNSUPPORTED_BACKEND",
      message: `Unsupported backend: ${language}/${framework ?? "*"}. Supported: ${supported}.`,
    });
  }
  const mod = (await import(entry.packageName)) as BackendModule;
  const backend = mod.default ?? mod.backend;
  if (!backend) {
    throw new SteleError({
      code: "E_BACKEND_LOAD_FAILED",
      message: `Backend package ${entry.packageName} did not export a default backend.`,
    });
  }
  return backend;
}
```

#### 6.2.2 既有调用点改造

替换以下文件中的硬编码分支：

- `packages/cli/src/commands/generate.ts`
- `packages/cli/src/commands/check.ts`（如有同样硬编码）
- `packages/cli/src/commands/init.ts`（init 时验证 language 已注册）

#### 6.2.3 错误码新增

在 `packages/core/src/errors/SteleError.ts` 加 `E_UNSUPPORTED_BACKEND`、`E_BACKEND_LOAD_FAILED`，更新 `docs/spec/cdl.md` "Error codes" 节。

### 6.3 验收标准

- [ ] `stele init --language python` 行为与重构前完全一致
- [ ] `stele init --language ruby` 报 `E_UNSUPPORTED_BACKEND` 错误并列出 `Python (pytest)`
- [ ] `packages/cli/src/commands/generate.ts` 中不再含有硬编码的 `if (targetLanguage !== "python")` 分支
- [ ] EP01 / EP06 / EP09 可通过在 `REGISTERED_BACKENDS` 中追加一项接入新 backend，而不修改其他文件

## 7. W0.4: 跨后端一致性测试套件

### 7.1 背景

EP01 验收"TS 后端与 Python 后端对同一 CDL 文件行为一致"，但 PRD-v0.1 没有定义"一致"。同样的歧义会出现在 EP06 (Go)、未来 Java/Rust。Phase 0 建立一次，所有 backend EP 直接复用。

### 7.2 需求规格

#### 7.2.1 套件目录

```
tests/conformance/
  fixtures/
    01-simple-invariant/
      contract/main.stele
      stele.config.json           # 不含 backend，由测试 runner 注入
      app-state.json              # 模拟 stele_context 数据
      expected-violations.json    # 规范化违约报告
    02-forall-collection/
      ...
    03-scenario-checker/
      ...
    04-temporal-modified/
      ...
    05-baseline-suppression/
      ...
  runner.ts                       # 套件执行器
  README.md                       # 如何添加新 fixture
```

每个 fixture 包含：

- `contract/main.stele` ——契约源
- `app-state.json` —— 同一份输入数据（被注入到目标语言 fixture）
- `expected-violations.json` —— **规范化**的违约报告，所有 backend 必须产出相同结构

#### 7.2.2 "一致"的定义

两个 backend 对同一 fixture 的输出**一致**当且仅当：

1. 生成的 test 文件**全部执行通过/失败的状态相同**
2. 失败时产生的 `ViolationReport` JSON 在以下字段上**逐字节相同**：
   - `invariant_id`
   - `severity`
   - `scope_paths`（排序后比较）
   - `cause.kind`
   - `cause.expected_value` 和 `cause.actual_value`（数值类型容差 1e-9）
3. 不要求一致的字段：`location.file`（不同 backend 路径不同）、`detail.stack_trace`、生成时间戳

#### 7.2.3 Runner 设计

```ts
// tests/conformance/runner.ts (sketch)
import { runFixture } from "./runner-impl.js";

const FIXTURES = await loadFixtures("./fixtures");
const BACKENDS = ["python"]; // EP01 后扩展为 ["python", "typescript"]

for (const fixture of FIXTURES) {
  for (const backend of BACKENDS) {
    test(`${fixture.id} on ${backend}`, async () => {
      const result = await runFixture(fixture, backend);
      const expected = fixture.expectedViolations;
      assertViolationReportsEqual(result, expected, { tolerance: 1e-9 });
    });
  }
}
```

#### 7.2.4 初始 fixture 集

Phase 0 交付 5 个最小 fixture，覆盖：

1. **simple-invariant** —— 单 invariant + assert（基础路径）
2. **forall-collection** —— `forall` + `where` + `gt`（集合 + 数值）
3. **scenario-checker** —— `scenario` 步骤 + 自定义 checker（runtime 完整性）
4. **temporal-modified** —— `state-before`/`state-after` + `modified`（时态语义）
5. **baseline-suppression** —— `baseline-init` 抑制 + 新违约（baseline 行为）

后续 EP 添加新功能时**必须**追加对应 fixture（这是 EP01 的硬性验收前置）。

### 7.3 验收标准

- [ ] `pnpm --filter @stele test:conformance` 在 Python backend 上 5 个 fixture 全通过
- [ ] `assertViolationReportsEqual` 工具公开，被记录在 `docs/contributing/testing.md`
- [ ] 添加新 fixture 流程文档化（`tests/conformance/README.md`）

## 8. 里程碑

```
W0.1 npm 发布           ──┐
                          ├── 都完成后 → Phase 1 W1 启动
W0.2 测试债冲刺         ──┤
                          │
W0.3 Backend 调度重构 ──┐ │
                       │ │
W0.4 一致性套件       ──┴─┤
                          │
                          v
                      Phase 1 EP01-EP08
```

W0.1 和 W0.2 可以由不同人**并行**执行（不同源代码区域）；W0.3 必须在 W0.4 之前完成（W0.4 的 runner 依赖注册表）。

## 9. 验收标准（总）

Phase 0 完成意味着：

- [ ] npm registry 上 `@stele/*` 可公开 `npm install`
- [ ] 占名包就位，未来 EP 可直接发布 0.1.0
- [ ] `@stele/core` 整体覆盖率 ≥ 50%，关键模块 ≥ 60%
- [ ] 添加新 backend 不需要修改 `@stele/cli` 现有命令的代码
- [ ] 5 个 fixture 在 Python backend 上通过的同时定义了"一致"的可运行规范
- [ ] 全部 861 个旧测试 + 新增测试通过；不引入功能回归

进入 Phase 1 W1 的硬性前置条件全部满足。
