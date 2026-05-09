# EP03 详细设计：pre-commit 钩子

> PRD: [prd-phase-1.md §4](../../prd-phase-1.md) | 估算: 1 周 | 类别: 工具链集成

## 1. 目标

提供 pre-commit framework 的 Stele 钩子模板 + `stele init --pre-commit` 自动安装命令。

## 2. 模板文件

`packages/cli/templates/pre-commit-config.yaml`（v0.2 新增）：

```yaml
repos:
  - repo: local
    hooks:
      - id: stele-generate
        name: Stele Generate
        entry: npx stele generate
        language: node
        pass_filenames: false
        stages: [pre-commit]
        files: ^(contract/.*\.stele|stele\.config\.json)$

      - id: stele-check
        name: Stele Check
        entry: npx stele check
        language: node
        pass_filenames: false
        stages: [pre-commit]
```

**显式不含**：`stele-lock` pre-push 钩子。`pre-push` 自动 lock 会静默批准 manifest 漂移；lock 是审慎的人类行为。

## 3. `stele init --pre-commit`

`packages/cli/src/commands/init.ts` 扩展：

```typescript
import { promises as fs } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

interface InitOptions {
  language: string;
  preCommit: boolean;
  // 现有 ...
}

async function maybeInstallPreCommit(projectRoot: string): Promise<void> {
  const configPath = join(projectRoot, ".pre-commit-config.yaml");
  const templatePath = /* templates/pre-commit-config.yaml in @stele/cli package */;
  const template = yaml.load(await fs.readFile(templatePath, "utf-8")) as PreCommitConfig;

  let existing: PreCommitConfig | null = null;
  try {
    existing = yaml.load(await fs.readFile(configPath, "utf-8")) as PreCommitConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  if (existing == null) {
    // 1. 不存在 → 创建
    await fs.writeFile(configPath, yaml.dump(template, { lineWidth: -1, noRefs: true }));
    console.log(`Created .pre-commit-config.yaml with Stele hooks.`);
    return;
  }

  // 2. 已存在 → 找 repo: local 块
  const localRepo = existing.repos?.find((r) => r.repo === "local");
  const steleHookIds = ["stele-generate", "stele-check"];

  if (localRepo) {
    const existingSteleHooks = (localRepo.hooks ?? []).filter((h) => steleHookIds.includes(h.id));
    if (existingSteleHooks.length === steleHookIds.length) {
      // 3. 已含全部 Stele hooks → 跳过
      console.log(`.pre-commit-config.yaml already has Stele hooks; skipping.`);
      return;
    }

    // 4. 部分含 / 完全无 → 追加缺失的
    const templateLocalRepo = template.repos!.find((r) => r.repo === "local")!;
    for (const h of templateLocalRepo.hooks!) {
      if (!localRepo.hooks!.find((eh) => eh.id === h.id)) {
        localRepo.hooks!.push(h);
      }
    }
    await fs.writeFile(configPath, yaml.dump(existing, { lineWidth: -1, noRefs: true }));
    console.log(`Added missing Stele hooks to existing .pre-commit-config.yaml.`);
    return;
  }

  // 5. 已存在但无 repo: local → 追加 Stele 块
  existing.repos = existing.repos ?? [];
  existing.repos.push(template.repos![0]);
  await fs.writeFile(configPath, yaml.dump(existing, { lineWidth: -1, noRefs: true }));
  console.log(`Appended Stele local hooks block to existing .pre-commit-config.yaml.`);
}
```

幂等行为表：

| 现状 | 行为 |
|---|---|
| 文件不存在 | 创建 |
| 文件存在但无 `repo: local` | 追加 `repo: local` 含 Stele hooks |
| 文件存在含 `repo: local` 但无 Stele hooks | 在已有 `hooks:` 数组追加 Stele hooks |
| 文件存在含部分 Stele hooks（仅 `stele-check`，缺 `stele-generate`）| 追加缺失的 |
| 文件存在含全部 Stele hooks | 跳过，无写入 |

## 4. CLI 标志

```bash
stele init --language python --pre-commit
stele init --language typescript --pre-commit
stele init --pre-commit                       # 不指定 language 时报错（与现有 init 行为一致）
```

`--pre-commit` 标志通过 commander.js 添加：

```typescript
program
  .command("init")
  .option("--language <lang>", "...")
  .option("--pre-commit", "Install Stele hooks into .pre-commit-config.yaml", false)
  .action(async (opts) => { /* ... */ });
```

## 5. 测试

```typescript
// packages/cli/tests/init-precommit.test.ts
describe("stele init --pre-commit", () => {
  it("creates .pre-commit-config.yaml when missing", async () => { /* ... */ });
  it("is idempotent on re-run", async () => {
    await runInit(tmpdir, { preCommit: true });
    const before = await fs.readFile(configPath, "utf-8");
    await runInit(tmpdir, { preCommit: true });
    const after = await fs.readFile(configPath, "utf-8");
    expect(after).toBe(before);
  });
  it("appends to existing repo: local block", async () => { /* ... */ });
  it("appends new repo: local when only other repos present", async () => { /* ... */ });
  it("does NOT install stele-lock", async () => {
    const result = yaml.load(await fs.readFile(configPath, "utf-8")) as PreCommitConfig;
    const hookIds = result.repos!.flatMap((r) => r.hooks!.map((h) => h.id));
    expect(hookIds).not.toContain("stele-lock");
  });
});
```

## 6. 文档

`docs/contributing/pre-commit-setup.md`（v0.2 新建）：

- pip install / pre-commit install 步骤
- `stele init --pre-commit` 使用
- Windows 注意事项：
  - `npx` 路径解析在 `cmd.exe` 中可能找不到 npx；建议在 Git Bash / WSL 中运行
  - 行尾问题：`pre-commit` 默认追加 LF；`.pre-commit-config.yaml` 需保持 LF
- 调试：`pre-commit run --all-files --verbose`
- 与 Husky / lefthook 共存：建议二选一，不混用

## 7. 不在范围内

- 自动安装 `pre-commit` 工具本身（用户自己 `pip install pre-commit`）
- 钩子覆盖率统计
- pre-push 钩子（除非 v0.5 有新需求）

## 8. 验收标准（来自 PRD §4.1）

- [ ] `stele init --pre-commit` 在新项目正确生成 `.pre-commit-config.yaml`
- [ ] 同一项目反复运行 `stele init --pre-commit` 不重复 hooks
- [ ] `pre-commit run stele-check --all-files` 拦截违约提交
- [ ] **不存在** `stele-lock` 钩子
- [ ] `docs/contributing/pre-commit-setup.md` 涵盖 Windows 已知问题
