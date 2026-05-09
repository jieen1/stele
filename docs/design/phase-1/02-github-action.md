# EP02 详细设计：GitHub Action（含 PR 评论）

> PRD: [prd-phase-1.md §3](../../prd-phase-1.md) | 估算: 2-3 周 | 类别: CI 集成

## 1. 目标

为 GitHub PR 提供契约验证 Action，含两种模式（check / generate）、行内 annotations、单条 live-updating PR 评论。Marketplace 发布。

## 2. Action manifest

`packages/github-action/action.yml`：

```yaml
name: "Stele Contract Check"
description: "Verify Stele contracts on pull requests"
author: "stelehq"
branding:
  icon: "shield"
  color: "blue"

inputs:
  mode:
    description: "check | generate"
    required: false
    default: "check"
  diff-from:
    description: "Base ref for --diff-from (default: PR base SHA)"
    required: false
    default: ${{ github.event.pull_request.base.sha }}
  fail-on:
    description: "error | warning | all"
    required: false
    default: "error"
  annotate:
    description: "Emit GitHub annotations on PR diff"
    required: false
    default: "true"
  pr-comment:
    description: "Post / update single PR comment with violation summary"
    required: false
    default: "true"
  token:
    description: "GitHub token (needs pull-requests:write + checks:write)"
    required: true

runs:
  using: "node20"
  main: "dist/index.js"
```

JS Action（不是 composite），用 `@vercel/ncc` 打包到 `dist/index.js`。

## 3. 入口分派

`src/main.ts`:

```typescript
import * as core from "@actions/core";
import { runCheck } from "./modes/check.js";
import { runGenerate } from "./modes/generate.js";

async function main() {
  const mode = core.getInput("mode");
  try {
    switch (mode) {
      case "check": await runCheck(); break;
      case "generate": await runGenerate(); break;
      default:
        core.setFailed(`Unsupported mode: ${mode}. Allowed: check | generate.`);
        return;
    }
  } catch (err) {
    core.setFailed(`Stele Action failed: ${(err as Error).message}`);
  }
}

main();
```

**显式拒绝** `mode: lock`：报错并指向迁移 doc。

## 4. mode: check 实现

```typescript
// src/modes/check.ts
import * as core from "@actions/core";
import { spawnCli } from "../cli-runner.js";
import { emitAnnotations } from "../annotate.js";
import { upsertPrComment } from "../pr-comment.js";

export async function runCheck() {
  const diffFrom = core.getInput("diff-from");
  const failOn = core.getInput("fail-on") as "error" | "warning" | "all";
  const annotate = core.getBooleanInput("annotate");
  const prComment = core.getBooleanInput("pr-comment");

  const result = await spawnCli(["check", "--diff-from", diffFrom, "--json"]);

  if (result.exitCode === 3) {
    // manifest drift
    core.setFailed("Manifest drift detected. Run `stele lock` after reviewing.");
    return;
  }

  const report: ViolationReport = JSON.parse(result.stdout);
  const violations = filterByFailOn(report.violations, failOn);

  if (annotate) emitAnnotations(violations, /* total= */ report.violations.length);
  if (prComment) await upsertPrComment(violations, report);

  if (violations.length > 0) {
    core.setFailed(`${violations.length} contract violation${violations.length > 1 ? "s" : ""} found.`);
  }
}

function filterByFailOn(
  vs: Violation[],
  failOn: "error" | "warning" | "all",
): Violation[] {
  switch (failOn) {
    case "error": return vs.filter((v) => v.severity === "error");
    case "warning": return vs.filter((v) => v.severity === "error" || v.severity === "warning");
    case "all": return vs;
  }
}
```

## 5. Annotations

```typescript
// src/annotate.ts
import * as core from "@actions/core";

const MAX_ERROR_ANNOTATIONS = 50;
const MAX_WARNING_ANNOTATIONS = 50;

export function emitAnnotations(violations: Violation[], totalCount: number) {
  const errors = violations.filter((v) => v.severity === "error").slice(0, MAX_ERROR_ANNOTATIONS);
  const warnings = violations.filter((v) => v.severity === "warning").slice(0, MAX_WARNING_ANNOTATIONS);

  for (const v of errors) emit("error", v);
  for (const v of warnings) emit("warning", v);

  if (violations.length > errors.length + warnings.length) {
    core.notice(
      `Showing ${errors.length + warnings.length} of ${totalCount} violations as inline annotations. See PR comment for full list.`,
    );
  }
}

function emit(level: "error" | "warning", v: Violation) {
  // 字段名修正（v0.2）：rule_id 不是 invariant_id；location.path 不是 location.file；cause.summary 不是 detail.message
  const file = v.location?.path;
  const line = v.location?.line ?? 1;
  const message = v.cause.summary;
  if (file) {
    core[level](message, {
      title: `Stele: ${v.rule_id}`,
      file,
      startLine: line,
    });
  } else {
    // 没有 path（如 manifest drift）→ 全局 notice，不带文件锚
    core[level](`Stele: ${v.rule_id}: ${message}`);
  }
}
```

## 6. PR Comment

```typescript
// src/pr-comment.ts
import * as github from "@actions/github";

const COMMENT_MARKER = "<!-- stele-report:v1 -->";

export async function upsertPrComment(violations: Violation[], report: ViolationReport) {
  const ctx = github.context;
  if (!ctx.payload.pull_request) return; // 仅 PR 触发

  const octokit = github.getOctokit(core.getInput("token"));
  const owner = ctx.repo.owner;
  const repo = ctx.repo.repo;
  const prNumber = ctx.payload.pull_request.number;

  // 1. 列出现有评论，找 marker
  // body.includes 比 startsWith 更稳健（容忍 BOM / 前置空白 / mobile UI 添加的换行）
  const existing = await octokit.paginate(octokit.rest.issues.listComments, {
    owner, repo, issue_number: prNumber,
  });
  const marker = existing.find((c) => c.body?.includes(COMMENT_MARKER));

  const body = renderComment(violations, report, ctx.runId);

  if (marker) {
    await octokit.rest.issues.updateComment({
      owner, repo, comment_id: marker.id, body,
    });
  } else {
    await octokit.rest.issues.createComment({
      owner, repo, issue_number: prNumber, body,
    });
  }
}

function renderComment(violations: Violation[], report: ViolationReport, runId: number): string {
  const status = violations.length === 0 ? "✅ Passing" : `❌ ${violations.length} violation${violations.length > 1 ? "s" : ""}`;
  const lines = [
    COMMENT_MARKER,
    `## 🛡️ Stele Contract Report`,
    "",
    `**Status**: ${status} | **Run**: [#${runId}](${runUrl(runId)})`,
    "",
  ];
  if (violations.length > 0) {
    lines.push("### Violations", "");
    for (const v of violations.slice(0, 50)) {
      lines.push(renderViolation(v));
    }
    if (violations.length > 50) {
      lines.push("", `_${violations.length - 50} more violations omitted from comment._`);
    }
  }
  lines.push("", "---", `*This comment auto-updates on every push. Generated at ${new Date().toISOString()} by \`@stele/github-action@${ACTION_VERSION}\`.*`);
  return lines.join("\n");
}

function renderViolation(v: Violation): string {
  // 字段名修正（v0.2）：rule_id（不是 invariant_id），location.path（不是 location.file），
  // cause.summary + cause.detail（不是 cause.kind）
  const witness = v.cause.failure_witness;
  const witnessLine = witness
    ? `- **Witness**: index ${witness.failed_at_index} of ${witness.collection_size}, item: \`${truncate(JSON.stringify(witness.failed_item), 80)}\``
    : "";
  const where = v.location?.path
    ? `\`${v.location.path}\`${v.location.line ? ` (line ${v.location.line})` : ""}`
    : "(no specific location)";
  return [
    `#### \`${v.rule_id}\` (${v.severity})`,
    `- **Where**: ${where}`,
    `- **Cause**: ${v.cause.summary}`,
    v.cause.detail ? `- **Detail**: ${v.cause.detail}` : "",
    witnessLine,
    `- **Suppress**: \`npx stele baseline-update --reason "..."\``,
    "",
  ].filter(Boolean).join("\n");
}
```

## 7. CLI Runner

```typescript
// src/cli-runner.ts
import { spawnSync } from "node:child_process";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function spawnCli(args: string[]): Promise<CliResult> {
  // 1. 检查 npx stele 可用
  const versionCheck = spawnSync("npx", ["stele", "--version"], { encoding: "utf-8" });
  if (versionCheck.status !== 0) {
    throw new Error("Stele CLI not found. Run `npm install --save-dev @stele/cli` in your repo.");
  }

  // 2. 执行 stele 命令
  const r = spawnSync("npx", ["stele", ...args], { encoding: "utf-8" });
  return {
    exitCode: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}
```

## 8. mode: generate 实现

```typescript
// src/modes/generate.ts
export async function runGenerate() {
  const result = await spawnCli(["generate"]);
  if (result.exitCode === 2) {
    core.setFailed("Generated test files drifted from CDL. Run `stele generate` locally and commit.");
  } else if (result.exitCode !== 0) {
    core.setFailed(`stele generate failed: ${result.stderr}`);
  }
}
```

## 9. 退出码与错误处理

| 来源 | 退出码 | Action 行为 |
|---|---|---|
| `stele check` exit 0 | — | Action exit 0 |
| `stele check` exit 2 | generated drift | `core.setFailed` |
| `stele check` exit 3 | manifest drift | `core.setFailed` 含 lock 修复指令 |
| `stele check` exit 1 | I/O / 类型错 | `core.setFailed` 含 stderr |
| violation 数 > 0 + fail-on 匹配 | — | `core.setFailed` |
| violation 数 > 0 + fail-on 不匹配 | — | exit 0（仅 annotate / comment）|

## 10. 测试

```typescript
// __tests__/main.test.ts
describe("github-action", () => {
  describe("mode dispatch", () => {
    it("calls runCheck for mode=check", async () => { /* mock core.getInput */ });
    it("rejects mode=lock with helpful error", async () => { /* ... */ });
    it("rejects unknown mode", async () => { /* ... */ });
  });
  describe("annotation cap", () => {
    it("limits to 50 errors when violations > 50", () => { /* ... */ });
    it("emits notice with X of Y count", () => { /* ... */ });
  });
  describe("PR comment", () => {
    it("creates new comment when none exists", async () => { /* mock octokit */ });
    it("updates existing comment matching marker", async () => { /* ... */ });
    it("includes witness when available", () => { /* ... */ });
  });
});
```

本地集成测试用 `nektos/act` 运行整 workflow。

## 11. 包结构

```
packages/github-action/
  action.yml
  package.json                          -- "main": "dist/index.js"
  src/
    main.ts
    cli-runner.ts
    annotate.ts
    pr-comment.ts
    modes/
      check.ts
      generate.ts
  __tests__/
  dist/                                 -- ncc 构建产物（.gitignore 但 release 时 commit）
```

`package.json`:

```json
{
  "scripts": {
    "build": "ncc build src/main.ts -o dist --license licenses.txt",
    "test": "vitest run __tests__"
  },
  "dependencies": {
    "@actions/core": "^1.10.1",
    "@actions/github": "^6.0.0"
  },
  "devDependencies": {
    "@vercel/ncc": "^0.38.0"
  }
}
```

## 12. 发布流程

GitHub Action 通过**git tag** 发布到 Marketplace：

```bash
# 1. 构建
pnpm --filter @stele/github-action build

# 2. 提交 dist/
git add packages/github-action/dist
git commit -m "chore(github-action): build v0.1.0"

# 3. tag
git tag stele-action-v0.1.0
git push origin stele-action-v0.1.0

# 4. GitHub UI: Releases → Draft new release → Publish to Marketplace
```

Marketplace 不读 npm；Action 用户在 workflow 中写 `uses: stelehq/stele-action@v1`。

## 13. 验收标准（来自 PRD §3.5）

- [ ] PR 触发 Stele check 通过
- [ ] 违约时 ≤ 50 注解；超出时评论列全部
- [ ] PR 评论 live-updating（多次 push 一条评论）
- [ ] PR 评论 Witness 字段在 forall/exists 失败时显示具体元素与值（依赖 EP07）
- [ ] generate 模式检测漂移并以退出码 2 失败
- [ ] **不存在** `mode: lock`
- [ ] permissions 不足时给出明确错误信息
- [ ] Action 在 GitHub Marketplace 列出
