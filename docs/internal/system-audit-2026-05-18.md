# Stele 全系统审查报告

Generated: 2026-05-18
Scope: full repository, release flow, contract enforcement, agent hooks, MCP, GitHub Action, tests, conformance, packaging
Method: multi-agent read-only review + local verification

## 结论

当前 Stele 的产品方向成立，尤其是用 contract 约束 agent、并让 agent 持续理解和维护 contract 这一条线有长期价值。

但当前状态不建议作为稳定开源版本发布，也不建议承诺“生产级可用”。主要问题不是缺少功能，而是多个关键 gate 还不能证明真实用户安装、真实发布、跨语言执行和安全边界都可靠。

最重要的判断：

- 单元测试通过不能代表系统可发布，因为 typecheck、lint、packed adoption 仍有硬失败。
- conformance 名义存在，但当前主要覆盖 Python happy path，不能证明多语言 backend 语义一致。
- contract/hook 保护层已经有雏形，但 control-plane 自保护和 Bash/MCP 等绕路风险仍然存在。
- 发布链路没有形成可信闭环，尤其是 CLI tarball、agent-hooks 依赖、GitHub Action dist、npm package contents。

## 本地验证事实

- `pnpm test`: 通过；但 conformance 有 skipped，且主要是 happy path。
- `pnpm typecheck`: 失败，集中在 `packages/core/tests/layout.test.ts`。
- `pnpm lint`: 失败，原因同 typecheck。
- `pnpm test:packed-adoption`: 失败，临时项目没有安装 packed `@stele/cli`，却执行 `npx stele`。
- `pnpm release:dry-run`: 能跑完，但暴露 package contents 和发布清单问题。
- `git status --short --branch`: `main...origin/main [ahead 76]`，并有未跟踪 `.cursor/rules/stele.md` 和 `packages/agent-hooks/.cursor/rules/stele.md`。
- `git diff --check`: 通过。

## P0 硬阻断

### 1. Typecheck 和 lint 当前失败

位置：`packages/core/tests/layout.test.ts`

问题：

- 从 `../src/validator/structure.js` 导入了不存在的 `ParsedFile` 和 `ListNode`。
- `LanguageBackend.generate` 的测试实现返回 async promise，但接口期望不是 promise。

影响：

- 工程基础 gate 不可信。
- 不能以“unit tests pass”作为发布依据。

整改：

- 修正测试 import 和 backend mock 类型。
- 把 `typecheck` 和 `lint` 作为发布前绝对阻断。

### 2. Packed adoption 没有验证真实 CLI 安装闭环

位置：`scripts/verify-packed-adoption.mjs`

问题：

- `publishPackageDirs` 中有多个包，但 `adoptionPackageDirs = publishPackageDirs.slice(0, 3)` 实际只安装 core、backend-python、backend-go。
- 后续执行 `npx stele`，但临时项目并未安装本次 pack 出来的 `@stele/cli`。

影响：

- 当前 adoption test 不能证明用户在干净项目里能安装并运行 Stele。
- 甚至可能误用 registry 或环境里的其他 `stele`。

整改：

- adoption 必须安装本次 pack 出来的 `@stele/cli` tarball。
- 显式断言 `npx stele --version` 的 resolved binary 来自临时项目。
- 覆盖 `init/check/generate/baseline/propose/maintenance-summary` 等核心 CLI 链路。

### 3. 发布清单漏掉 `@stele/agent-hooks`

位置：

- `scripts/publish-npm.mjs`
- `packages/claude-code-plugin/package.json`
- `packages/mcp-server/package.json`

问题：

- `@stele/claude-code-plugin` 和 `@stele/mcp-server` 都依赖 `@stele/agent-hooks`。
- 发布清单没有 `packages/agent-hooks`。

影响：

- 发布后的 plugin 或 MCP server 可能安装失败。
- workspace 内通过，不代表 npm 用户可用。

整改：

- 如果 `agent-hooks` 是 runtime dependency，就纳入发布清单。
- 如果不想公开发布，就不能让 public package 运行时依赖它。

### 4. `stele check --diff` 存在 no-op 成功风险

位置：`packages/cli/src/commands/check.ts`

问题：

- diff 模式下如果 changed files 为空，会直接返回 no-changes result。
- 这会跳过 generated/protected 文件完整性校验。
- git diff 收集失败时也可能退化为空集合。

影响：

- diff gate 可能给出错误的成功信号。
- contract 锁、generated 文件和 protected 文件保护被削弱。

整改：

- diff 模式仍必须执行 manifest/protected/generated 完整性校验。
- git diff 失败应 fail closed。
- path matching 要统一 absolute/project-relative 语义。

### 5. Claude plugin 生命周期脚本存在 shell 注入风险

位置：`packages/claude-code-plugin/scripts/lifecycle-context.js`

问题：

- 使用 `spawn(..., { shell: true })`。
- 参数里包含来自 hook payload 或 git diff 的 focus path。

影响：

- 在 Windows/shell 场景下，恶意文件名或输入可能进入 shell 解释层。

整改：

- 改为 `shell: false` 或 `execFile` 风格。
- Windows `.cmd` 需要单独安全处理。
- 对 focus path 做严格 project-root 约束和字符校验。

### 6. GitHub Action dist 没有被 git 跟踪

位置：`packages/github-action/action.yml`

问题：

- action 入口指向 `dist/index.js`。
- `packages/github-action/dist` 当前没有被 git 跟踪。

影响：

- 用户通过 repo tag 引用 Action 时可能找不到入口。

整改：

- 要么 commit action dist。
- 要么改为 composite action，避免依赖未提交 build output。
- 发布前加 action self-test。

### 7. 多语言 backend 还不是同等可信

问题：

- Go/Java/Rust/TypeScript 后端大量测试停留在生成文本断言。
- scenario/checker 在非 Python 后端存在不可执行或不完整路径。
- TypeScript runner 仍 skip。

影响：

- 多语言包可以发布，但用户实际运行可能失败。
- conformance 不能阻止语义漂移。

整改：

- 在 CI 中真实执行 `go test`、`cargo test`、`mvn test`、`vitest`。
- 每个 backend 都要跑相同 fixture 的 pass/fail golden。
- 对暂不完整的语言明确标注 experimental，并在 CLI 能力矩阵中展示。

## P1 高风险问题

### 1. Conformance 缺负向 golden

当前 fixtures 基本都是 `ok: true`。

影响：

- 无法证明 violation report、baseline suppression、checker/scenario failure、exit code 映射正确。

整改：

- 每个语法/primitive 至少有 pass/fail 成对 fixture。
- 失败报告 JSON 和 human output 都要有 golden。

### 2. Code-shape target no-match 可能静默通过

问题：

- boundary/type-policy 等规则 target 没匹配任何文件时，可能不报错。

影响：

- 规则看起来存在，实际没有保护任何文件。

整改：

- 默认 no-match 应失败。
- 如确实允许空匹配，应显式声明 `(allow-empty true)`。

### 3. Control-plane 自保护不足

问题：

- `stele.config.json`、baseline、manifest、hooks、contract generated 文件等控制面需要统一保护。
- 当前 Bash、配置修改、间接写入仍存在绕路。

整改：

- 明确 hard protected 和 advisory protected 两层。
- Stop hook 不只拦截，也要解释规则，让 agent 优先不改 contract，必要时找用户审查。
- CI 或本地 release gate 检查 protected control-plane 是否被未授权修改。

### 4. MCP server projectDir 和 binary trust 边界不够强

问题：

- MCP tools 接受 `projectDir`，并可能执行该目录下 local `node_modules/.bin/stele`。
- 仅校验 package name 不足以证明 binary 可信。

整改：

- MCP server 启动时绑定 workspace root allowlist。
- tools 不接受任意跨 root projectDir。
- local binary identity 验证要包含 realpath、package root、integrity/version。

### 5. Baseline fingerprint 不够稳定

问题：

- fingerprint 如果包含诊断文案、fix text 等，会因文案变更导致 baseline 漂移。

整改：

- fingerprint 只包含 rule id、canonical location、canonical cause、stable witness。
- human text/fix 不参与 fingerprint。

### 6. Lockfile 和 package manifest 可能不一致

问题：

- `pnpm-lock.yaml` 中部分依赖方向与 package manifest 不一致。

影响：

- frozen install 或发布依赖闭包可能出问题。

整改：

- 重新生成 lockfile。
- 明确 `cli`、`agent-hooks`、`mcp-server` 的依赖方向，避免隐性循环。

## P2 维护质量问题

- Release 文档仍写四个 public npm packages，但发布脚本实际涉及更多包。
- README package list 没有同步 `agent-hooks`、`mcp-server`、`github-action`。
- 多个 package 声明 README，但实际缺失。
- npm package manifest 缺 `license`、`repository`、`homepage`、`bugs`。
- `@stele/mcp-server` 没有 `files` 白名单，pack 会带源码、测试和构建配置。
- `backend-python` pack 曾暴露 `__pycache__`。
- GitHub Action 一部分 tests 不在 package script 执行范围内。
- 缺 coverage 门槛，parser、validator、evaluator、path safety、report formatting 这些高价值区域没有硬指标。
- 工作区存在 `packages/foo` 这种噪音目录，以及未跟踪 `.cursor` 规则，需要决定提交或忽略。
- 开源维护文件不足：`SECURITY.md`、`CONTRIBUTING.md`、issue template、PR template、CHANGELOG、Dependabot 等需要补齐。

## 建议整改顺序

### Phase 1: 发布前止血

目标：所有基础 gate 真实可信。

- 修复 `typecheck` 和 `lint`。
- 修复 packed adoption，确保安装 packed CLI。
- 把 `agent-hooks` 纳入发布清单或移除 public runtime dependency。
- 修 GitHub Action dist/入口问题。
- 给所有发布包补 `files`、README、license/repository/bugs。
- release dry-run 和 packed adoption 都进入 CI/publish 阻断链。

### Phase 2: Contract 保护层可信化

目标：contract 不是“建议”，而是可验证约束。

- 修 `check --diff` no-op 成功问题。
- generated/protected/baseline 校验在任何 check 模式都执行。
- code-shape no-match 默认失败。
- 统一 severity、error code、fingerprint 语义。
- control-plane 文件纳入统一保护模型。

### Phase 3: 安全边界修复

目标：agent/plugin/MCP 不提供明显绕路。

- 生命周期脚本去掉不安全 shell 执行。
- Bash 写入策略从“补 matcher”升级为“明确 advisory/hard 策略”。
- MCP 限定 workspace root 和 binary trust。
- hooks 报告要教育 agent：优先不改 contract，真需要修改时请求用户审查。

### Phase 4: Conformance 真实化

目标：多语言 backend 的可信度由真实执行证明。

- conformance 增加负向 golden。
- Python/TypeScript/Go/Rust/Java 分别跑真实 runner。
- comparator 增加严格模式，覆盖 path、line、detail、fingerprint。
- 对不完整 backend 显式 experimental，不让用户误以为全稳定。

### Phase 5: 开源项目工程化

目标：长期维护成本可控。

- 补开源治理文件。
- 建立 release checklist。
- 加 coverage 门槛。
- 加 dependency update 机制。
- 清理 workspace 噪音。
- 把“新增 contract 允许、修改/删除 contract 严管”的维护策略写进 AGENTS/CLAUDE/Stele guidance。

## 后续开发方向

优先方向不是继续扩 DSL，而是先把现有能力变成可信系统：

1. 真实安装闭环：用户在空项目里安装、初始化、检查、生成、hook 生效。
2. 真实 contract 闭环：规则能匹配、能失败、能解释、能 baseline、能防止被无声绕过。
3. 真实 agent 协作闭环：agent 能理解规则、优先不乱改、必要时提出新增或请求审查。
4. 真实发布闭环：每个 npm 包、Action、MCP server 都能从 tarball/repo tag 证明可用。
5. 真实多语言闭环：不承诺没验证过的语言；承诺的语言必须跑真实 runner。

Stele 的核心价值应该是“让 agent 在长期项目中持续受 contract 约束并持续维护 contract”。这要求失败报告、维护入口、baseline、hooks、MCP、release gate 全部形成闭环。当前最值得投入的是让这些闭环变硬，而不是继续增加表层功能。
