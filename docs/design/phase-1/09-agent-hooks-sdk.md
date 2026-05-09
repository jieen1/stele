# EP09 详细设计：agent-hooks SDK + Cursor 适配器

> PRD: [prd-phase-1.md §10](../../prd-phase-1.md) | 估算: 3-4 周 | 类别: 编辑器集成 + SDK

## 1. 目标

把 Claude Code 插件中的 PreToolUse / Stop / SessionStart 模式抽象为编辑器无关的 SDK；提供 Cursor 适配器（最佳努力）；为 Continue.dev 留接口。

## 2. 关于 Cursor 强制能力的诚实表述

Cursor 的 hook 机制：

- **静态规则** (`.cursor/rules/*.md`)：注入到 prompt；**agent 可忽略**
- **Composer rules**：动态触发 shell；agent 主动调用
- **没有等价 PreToolUse 的硬阻止**

因此 Cursor 适配器：

- 层 1（CDL）+ 层 2（生成测试）通过 CLI / CI fallback 完整保护
- 层 3（编辑器钩子）的**最佳努力上下文注入**（架构白皮书警示的失效模式）
- composer-rule shell hook 是 Cursor 上最接近 PreToolUse 的可用机制

EP02 GitHub Action 是 Cursor 用户的硬强制层。这一切必须在文档中明文声明。

## 3. SDK 公开 API

### 3.1 包结构

```
packages/agent-hooks/
  src/
    index.ts                       -- 公共 API barrel
    protocol.ts                    -- Hook 协议类型
    handlers/
      pre-edit-protect.ts          -- PreToolUse 等价
      session-start-context.ts     -- SessionStart 等价
      stop-validate.ts             -- Stop 等价
      post-edit-observe.ts         -- PostToolUse 等价
    adapters/
      claude-code.ts               -- 适配 Claude Code hooks 协议
      cursor.ts                    -- Cursor 适配器
      continue-dev.ts              -- Continue.dev SDK 接口（v0.2 仅签名）
    install/
      cursor-installer.ts          -- stele install --agent cursor 实现
    util/
      stele-config-loader.ts       -- 复用 @stele/cli 的 loadConfig
      path-glob.ts                 -- protected paths 匹配
  tests/
    adapters/
      claude-code.test.ts
      cursor.test.ts
    handlers/
      pre-edit-protect.test.ts
```

### 3.2 通用 Hook 协议

```typescript
// src/protocol.ts
export interface AgentHookContext {
  /** Agent IDE 标识 */
  agent: AgentId;
  /** 工具名（read/write/edit/bash 等）*/
  tool: ToolKind;
  /** 工具参数标准化视图 */
  args: ToolArgs;
  /** 项目根（用于 loadConfig）*/
  projectRoot: string;
  /** 用户原始 prompt（若可用）*/
  prompt?: string;
}

export type AgentId = "claude-code" | "cursor" | "continue-dev" | string;

export type ToolKind = "read" | "write" | "edit" | "bash" | "search" | string;

export interface ToolArgs {
  /** 目标文件路径（read/write/edit）*/
  filePath?: string;
  /** 命令（bash）*/
  command?: string;
  /** 其他工具特定参数 */
  [key: string]: unknown;
}

export interface HookDecision {
  action: "allow" | "deny" | "warn";
  reason?: string;
  /** 注入到 agent 上下文的额外文本 */
  injectContext?: string;
}

export type PreEditHook = (ctx: AgentHookContext) => Promise<HookDecision>;
export type PostEditHook = (ctx: AgentHookContext) => Promise<void>;
export type SessionStartHook = (ctx: { projectRoot: string; agent: AgentId }) => Promise<{ context: string }>;
export type StopHook = (ctx: { projectRoot: string; agent: AgentId }) => Promise<HookDecision>;
```

### 3.3 Handler 工厂

```typescript
// src/handlers/pre-edit-protect.ts
import type { SteleConfig } from "@stele/cli";
import { matchProtectedPath } from "../util/path-glob.js";

export function createPreEditProtect(config: SteleConfig): PreEditHook {
  return async (ctx: AgentHookContext): Promise<HookDecision> => {
    if (ctx.tool !== "write" && ctx.tool !== "edit" && ctx.tool !== "bash") {
      return { action: "allow" };
    }
    const target = ctx.args.filePath;
    if (!target) {
      // bash 命令检查路径泄漏（参见 claude-code 现有 pre-tool-protect.js）
      const bashTarget = extractBashWriteTarget(ctx.args.command);
      if (!bashTarget) return { action: "allow" };
      if (matchProtectedPath(bashTarget, config.protected)) {
        return {
          action: "deny",
          reason: `Bash command would modify protected path: ${bashTarget}. See ${config.contractDir}/main.stele.`,
        };
      }
      return { action: "allow" };
    }
    if (matchProtectedPath(target, config.protected)) {
      return {
        action: "deny",
        reason: `Direct edit to protected path "${target}" is not allowed. Use \`stele propose invariant\` for additions; modifications require human review.`,
      };
    }
    return { action: "allow" };
  };
}
```

```typescript
// src/handlers/session-start-context.ts
export function createSessionStartContext(config: SteleConfig): SessionStartHook {
  return async (ctx) => {
    const contract = await loadContract(config.entry, ctx.projectRoot);
    const summary = renderInvariantSummary(contract.invariants);
    return {
      context: [
        "# Stele Contract Context",
        `Project has ${contract.invariants.length} invariants under ${config.contractDir}/.`,
        `Protected paths: ${config.protected.join(", ")}.`,
        "",
        "Direct edits to protected paths are blocked. Use `stele propose` for new invariants.",
        "",
        "## Active Invariants",
        summary,
      ].join("\n"),
    };
  };
}
```

```typescript
// src/handlers/stop-validate.ts
import { spawnSync } from "node:child_process";

export function createStopValidate(
  config: SteleConfig,
  runStele: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
): StopHook {
  return async (ctx) => {
    const { exitCode, stdout, stderr } = await runStele(["check", "--json"]);
    if (exitCode === 0) return { action: "allow" };
    if (exitCode === 3) {
      return {
        action: "deny",
        reason: `Manifest drift detected. Run \`stele lock --reason "..."\` to update.`,
      };
    }
    // exit 1, 2, or violations
    const report = tryParseJson(stdout);
    return {
      action: "deny",
      reason: `Contract check failed (${report?.violations?.length ?? "?"} violations). Fix or suppress with \`stele baseline-update\` before finishing.`,
    };
  };
}
```

## 4. Claude Code 适配器（refactor）

### 4.1 重构现有插件

`packages/claude-code-plugin/scripts/pre-tool-protect.js` 改为消费 SDK：

```javascript
// 改造后
const { createPreEditProtect } = require("@stele/agent-hooks");
const { ClaudeCodeAdapter } = require("@stele/agent-hooks/adapters/claude-code");
const { loadConfig } = require("@stele/cli/lib/config-loader");

(async () => {
  const projectRoot = process.cwd();
  const config = await loadConfig(projectRoot);
  const hook = createPreEditProtect(config);
  const adapter = new ClaudeCodeAdapter();
  const decision = await adapter.runPreEditHook(hook);
  process.exit(decision.action === "deny" ? 2 : 0);
})();
```

### 4.2 ClaudeCodeAdapter

```typescript
// src/adapters/claude-code.ts
export class ClaudeCodeAdapter {
  async runPreEditHook(hook: PreEditHook): Promise<HookDecision> {
    // Claude Code 通过 stdin 注入 hook 输入；解析 JSON
    const input = JSON.parse(await readStdin());
    const ctx: AgentHookContext = {
      agent: "claude-code",
      tool: input.tool_name,
      args: input.tool_input,
      projectRoot: process.cwd(),
      prompt: input.prompt,
    };
    return hook(ctx);
  }
  // 类似 runStopHook、runSessionStartHook
}
```

### 4.3 行为等价

`packages/claude-code-plugin/tests/` 现有 6 个测试文件**全部继续通过**（不改一行 test 代码）：

- hooks-config.test.ts
- lifecycle-context.test.ts
- observation-hook.test.ts
- observation-hook-extended.test.ts
- pre-tool-protect.test.ts
- stop-validate.test.ts

## 5. Cursor 适配器

### 5.1 包发现

Cursor 没有等价 hook 注入；通过 `.cursor/` 目录配置：

```
your-project/
  .cursor/
    rules/
      stele.md          # 静态规则注入到 prompt
    composer/
      stele-check.sh    # 用户保存后触发 stele check
```

### 5.2 stele install --agent cursor

`packages/cli/src/commands/install.ts`（新增）：

```typescript
program.command("install")
  .description("Install Stele integration with an agent IDE")
  .requiredOption("--agent <name>", "cursor | claude-code | continue-dev")
  .option("--enable-shell", "Enable composer-rule shell hooks (Cursor only)", false)
  .option("--uninstall", "Remove integration", false)
  .option("--force", "Overwrite existing manually-edited files (Cursor only)", false)
  .action(async (opts) => {
    if (opts.agent === "cursor") {
      const installer = await import("@stele/agent-hooks/install/cursor-installer.js");
      if (opts.uninstall) await installer.uninstall(process.cwd());
      else await installer.install(process.cwd(), { enableShell: opts.enableShell, force: opts.force });
    } else {
      throw new SteleError(
        "E_UNSUPPORTED_AGENT",
        "AgentHooksError",
        `Agent ${opts.agent} not supported. Supported: cursor.`,
      );
    }
  });
```

### 5.3 cursor-installer

```typescript
// packages/agent-hooks/src/install/cursor-installer.ts
const AUTO_MARKER = "<!-- stele-auto:v1 -->";

export async function install(projectRoot: string, opts: { enableShell: boolean; force?: boolean }): Promise<void> {
  const config = await loadConfig(projectRoot);
  const rulesDir = join(projectRoot, ".cursor/rules");
  const rulesFile = join(rulesDir, "stele.md");

  // 覆盖保护：检测已存在 stele.md 是否含 auto-marker
  try {
    const existing = await fs.readFile(rulesFile, "utf-8");
    if (!existing.startsWith(AUTO_MARKER) && !opts.force) {
      throw new SteleError(
        "E_CURSOR_RULES_OVERWRITE",
        "AgentHooksError",
        `${rulesFile} exists and was not auto-generated. Use --force to overwrite.`,
        undefined,
        undefined,
        "Move custom rules to a separate file like .cursor/rules/stele.user.md (Cursor reads all .md in rules/).",
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // 不存在 → 直接 write
  }

  const contract = await loadContract(config.entry, projectRoot);

  // 1. 写 .cursor/rules/stele.md
  const rulesDir = join(projectRoot, ".cursor/rules");
  await fs.mkdir(rulesDir, { recursive: true });
  const rulesContent = renderRulesMarkdown(config, contract);
  await fs.writeFile(join(rulesDir, "stele.md"), rulesContent, "utf-8");

  // 2. 可选：写 composer shell hook
  if (opts.enableShell) {
    const composerDir = join(projectRoot, ".cursor/composer");
    await fs.mkdir(composerDir, { recursive: true });
    await fs.writeFile(
      join(composerDir, "stele-check.sh"),
      "#!/usr/bin/env bash\n" +
      "set -e\n" +
      "npx stele check --json | tee .cursor/last-stele-report.json\n",
      { mode: 0o755 },
    );
  }

  console.log(
    `Installed Stele rules into ${rulesDir}.\n` +
    (opts.enableShell ? "Composer shell hook installed.\n" : "") +
    "Note: Cursor static rules are best-effort; agents may ignore them.\n" +
    "For hard enforcement, ensure your CI uses @stele/github-action.",
  );
}

export async function uninstall(projectRoot: string): Promise<void> {
  await fs.rm(join(projectRoot, ".cursor/rules/stele.md")).catch(() => undefined);
  await fs.rm(join(projectRoot, ".cursor/composer/stele-check.sh")).catch(() => undefined);
  console.log("Removed Stele Cursor integration.");
}

function renderRulesMarkdown(config: SteleConfig, contract: Contract): string {
  return [
    AUTO_MARKER,                                        // sentinel for overwrite detection
    "# Stele Contract Rules (auto-generated)",
    "",
    "> This project uses Stele for contract enforcement. Direct edits to protected paths are blocked by CI.",
    "> Do not edit this file; it is regenerated by `stele install --agent cursor`.",
    "> For custom rules, create `.cursor/rules/stele.user.md` (Cursor reads all .md in rules/).",
    "",
    "## Protected Paths",
    "",
    config.protected.map((p) => `- \`${p}\``).join("\n"),
    "",
    "## Active Invariants",
    "",
    contract.invariants.slice(0, 30).map((i) =>
      `- **${i.id}** (${i.severity}): ${i.description}`
    ).join("\n"),
    contract.invariants.length > 30 ? `\n_(+ ${contract.invariants.length - 30} more)_` : "",
    "",
    "## Rules for Agent",
    "",
    "1. Do not edit files under `contract/` or `tests/contract/` directly.",
    "2. To add a new invariant, run `stele propose invariant --apply ...`.",
    "3. To modify or delete an existing invariant, ask the human user; this requires human review.",
    "4. Run `stele check` after edits to verify contracts still pass.",
    "",
    "_Generated by stele install --agent cursor._",
  ].join("\n");
}
```

### 5.4 安全约束

- **默认不安装 shell hook**（除非 `--enable-shell`）
- 静态规则**不导出** stele.config.json 全部内容（只 invariant id + description；不含 rationale 等可能含敏感信息的字段）
- agent-hooks SDK 不依赖任何外部网络服务

## 6. Continue.dev 适配器（v0.2 仅签名）

```typescript
// src/adapters/continue-dev.ts
export class ContinueDevAdapter {
  async runPreEditHook(hook: PreEditHook): Promise<HookDecision> {
    throw new Error("ContinueDevAdapter is not yet implemented (Phase 3 candidate)");
  }
}
```

签名稳定后，Phase 3 实现完整逻辑。

## 7. 与 EP11 (VS Code MVP) 的关系

| 维度 | EP11 (VS Code 扩展) | EP09 (agent-hooks SDK) |
|---|---|---|
| 用户 | 不用 AI agent 的 VS Code 用户 | 用 AI agent 的开发者 |
| 触发 | 文件保存 | agent 工具调用 |
| 主要功能 | 内联诊断 | 编辑前拦截 + 上下文注入 |
| 强制性 | 软（可绕过）| 硬（PreToolUse deny；Cursor 适配器仅软）|

互补不重叠。

## 8. 测试

```typescript
// tests/adapters/claude-code.test.ts
describe("ClaudeCodeAdapter", () => {
  it("preserves all 6 existing test files behavior", async () => {
    // 重新跑 packages/claude-code-plugin/tests/ 整套
  });
});

// tests/handlers/pre-edit-protect.test.ts
describe("createPreEditProtect", () => {
  it("denies write to contract/main.stele", async () => { /* ... */ });
  it("allows write to src/foo.ts", async () => { /* ... */ });
  it("denies bash command writing to contract/", async () => { /* ... */ });
  it("allows read tools regardless", async () => { /* ... */ });
});

// tests/install/cursor-installer.test.ts
describe("cursor-installer", () => {
  it("creates .cursor/rules/stele.md", async () => { /* ... */ });
  it("does not create composer hook by default", async () => { /* ... */ });
  it("creates composer hook with --enable-shell", async () => { /* ... */ });
  it("uninstall removes both files", async () => { /* ... */ });
  it("static rules do not include rationale field", async () => {
    // 安全：不泄漏 rationale
  });
});
```

## 9. 文档

`docs/guides/agent-hooks-sdk.md`（新建）：

- SDK 公共 API 文档
- 写自定义 adapter 的步骤
- 已有 adapter 行为表

`docs/guides/cursor-integration.md`（新建）：

- 用户视角：如何启用 Stele 在 Cursor 项目中
- 限制：Cursor 静态规则是 best-effort
- CI fallback：必须配 `@stele/github-action`

`examples/cursor-demo/`：完整示例 + screenshots。

## 10. 估算分解

| 工作 | 估算 |
|---|---|
| SDK 公共 API + protocol | 2 天 |
| Handler 工厂 (4 个) | 3 天 |
| Claude Code adapter + refactor 现有 plugin | 4 天 |
| Cursor installer + 静态规则模板 | 3 天 |
| Cursor composer hook + 安全 | 2 天 |
| Continue.dev 签名 | 1 天 |
| 测试（含 6 个旧 test 文件保持通过）| 4 天 |
| 文档 + examples + 真实 Cursor 验证 | 3 天 |
| **合计** | **22 天 ≈ 4-5 周（1 FTE）/ 2.5-3 周（2 FTE）**|

## 11. 验收标准（来自 PRD §10.7）

- [ ] `@stele/agent-hooks` 公开 API 文档化（`docs/guides/agent-hooks-sdk.md`）
- [ ] Claude Code 插件重构后**全部 6 个 tests 文件**通过（无新增 fail，无 skip）
- [ ] `stele install --agent cursor` 在 examples/finance-guard 生成有效 `.cursor/rules/stele.md`
- [ ] `stele install --agent cursor --enable-shell` 生成有效 composer shell script
- [ ] `stele install --agent cursor --uninstall` 干净撤销
- [ ] Cursor 适配器在真实 Cursor 客户端中加载（人工验证 + 截图归档）
- [ ] Continue.dev SDK 层签名稳定
- [ ] `docs/guides/agent-hooks-sdk.md` + `docs/guides/cursor-integration.md` 完整
- [ ] PRD 与文档**明文承认 Cursor 适配器是软约束**，硬强制依赖 CI（EP02）
