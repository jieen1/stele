# P0.1 详细设计：npm 发布 v0.1.0

> PRD: [prd-phase-0.md §4](../../prd-phase-0.md) | 估算: 2-3 天 | 类别: 流程类

## 1. 目标

把 4 个现有包发布到 npm registry，并占用 5 个未来包名。同时完成 GitHub Marketplace 与 VS Code Marketplace 的发布者准备。

## 2. 公开 API 影响

无新公共 API。本工作项是**操作流程**，不修改源代码（除 `package.json` 的 `version` 字段如有需要）。

## 3. 工作分解

### 3.1 准备 (W0.1.a)

| 步骤 | 命令 / 操作 | 检查 |
|---|---|---|
| 1 | `npm login` （或 trusted publishing 已配置）| `npm whoami` 返回 stele 账户 |
| 2 | `npm org ls @stele` | scope 存在或申请新 scope |
| 3 | `pnpm release:dry-run` | 全部 4 包 pack + dry-run publish 通过 |
| 4 | 检查 `.github/workflows/publish.yml` 中 `id-token: write` 与 `--provenance` 标志 | trusted publishing 双向就绪 |

### 3.2 首次发布顺序 (W0.1.b)

依赖顺序：

```
@stele/core               (无依赖)
   ↓
@stele/backend-python     (依赖 core)
   ↓
@stele/cli                (依赖 core + backend-python)

@stele/claude-code-plugin (独立)
```

`scripts/publish-npm.mjs` 中 `publishPackageDirs` 顺序需匹配：

```js
const publishPackageDirs = [
  "packages/core",
  "packages/backend-python",
  "packages/cli",
  "packages/claude-code-plugin",
];
```

如顺序错误（cli 在 core 前），首次发布会因 dependency unavailable 失败。

### 3.3 占名 (W0.1.c)

为 5 个未来包发布 `0.0.1-placeholder`：

| 包名 | 用途 | Phase |
|---|---|---|
| `@stele/backend-typescript` | EP01 | Phase 1 |
| `@stele/github-action` | EP02 | Phase 1 |
| `@stele/agent-hooks` | EP09 | Phase 1 |
| `@stele/backend-go` | EP10 | Phase 2 |
| `@stele/vscode-extension` | EP11 | Phase 2（仅 npm 占名；实际通过 VS Code Marketplace 分发）|

每个 placeholder 包内容（ESM 与 monorepo `"type": "module"` 一致）：

```
package.json    -- "version": "0.0.1-placeholder", "type": "module", "main": "index.js"
README.md       -- "Reserved for Phase X delivery; see prd-phase-X.md"
index.js        -- export default {};
```

发布命令模板：

```bash
mkdir -p /tmp/stele-placeholder
cd /tmp/stele-placeholder
# 写 package.json + README.md + index.js
npm publish --access public
```

### 3.4 GitHub Marketplace publisher (W0.1.d)

按 [PRD §4.2.4](../../prd-phase-0.md)。无脚本需求；GitHub UI 操作。

### 3.5 VS Code Marketplace publisher (W0.1.e，对应 PRD §4.2.5)

```bash
# 在 https://dev.azure.com 创建 organization "stelehq"
# 在该 org 设置 → Personal Access Tokens 创建 PAT，scope: Marketplace (Manage)
npm install -g @vscode/vsce
vsce login stelehq
# PAT 输入后存入 ~/.vsce 缓存

# Placeholder publish: 占名 "stelehq.stele-vscode"
mkdir -p /tmp/stele-vscode-placeholder
cd /tmp/stele-vscode-placeholder
# vsce 要求 package.json 含 publisher + name
cat > package.json <<EOF
{
  "name": "stele-vscode",
  "displayName": "Stele Contract Tools (placeholder)",
  "publisher": "stelehq",
  "version": "0.0.1",
  "description": "Reserved for Phase 2 delivery",
  "engines": { "vscode": "^1.85.0" },
  "main": "./extension.js"
}
EOF
echo "module.exports.activate = () => {};" > extension.js
echo "Reserved for Phase 2 EP11" > README.md
vsce package
vsce publish
```

## 4. 错误处理

| 错误 | 响应 |
|---|---|
| npm `403 Forbidden` on first publish | scope 不存在或未授权；申请 scope 后重试 |
| npm `409 Conflict` (version exists) | 该版本已被占用；本流程不应触发，否则人工核查 |
| `vsce publish` 401 | PAT 失效或权限不足；重新生成 PAT，确保 Marketplace (Manage) scope |
| `npm publish --provenance` 失败 | trusted publishing 配置错误；fallback 用 token 发布并记录在 issue |

### 4.1 部分失败回滚

`scripts/publish-npm.mjs` 当前遇 publish 失败即 abort（无 try/catch in publish loop）。常见场景：`@stele/core` 发布成功，`@stele/backend-python` 失败，导致 npm 上有部分 v0.1.0 包。

**24 小时内可回滚**（npm 政策窗口）：

```bash
# 清理已发布的部分包
npm unpublish @stele/core@0.1.0
npm unpublish @stele/backend-python@0.1.0   # 如果它先成功
# ... 按发布顺序逆序 unpublish

# 修复阻塞问题，重新运行 release
pnpm release:dry-run
pnpm release:publish
```

**超出 24 小时**只能 deprecate（`npm deprecate <pkg>@<version> "..."`），无法撤回。推荐：在 Docker 干净环境（见 §5）跑 release:dry-run 全验证后再触发 release:publish。

## 5. 验收标准（来自 PRD §4.3）

- [ ] `npm view @stele/core` 返回 v0.1.0 元数据
- [ ] `npm view @stele/cli@0.1.0 dist.tarball` 返回有效 URL
- [ ] 在干净 Docker 环境运行 `npm install -g @stele/cli && stele --version` 成功输出版本
- [ ] `npm view @stele/backend-typescript` 返回 placeholder
- [ ] `vsce login stelehq` 成功
- [ ] `stelehq.stele-vscode` 在 Visual Studio Marketplace 上以 placeholder 0.0.1 占名

## 6. 不在范围内

- 自动化发布触发（保持 `pnpm release:publish` 手动触发）
- Action 实际发布到 GitHub Marketplace（EP02 完成时执行）
- VS Code 扩展实际功能版本（EP11 完成时升级 0.0.1 → 0.1.0）

## 7. 回滚

每个 npm 包发布**24 小时内**可 `npm unpublish @stele/<pkg>@0.1.0`。超出 24 小时仅可 deprecate（`npm deprecate`），不能撤回。本流程在干净 Docker 环境验证通过后再发布，错误率应可接受。
