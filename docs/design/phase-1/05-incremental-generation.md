# EP05 详细设计：增量生成性能优化

> PRD: [prd-phase-1.md §6](../../prd-phase-1.md) | 估算: 2-3 周 | 类别: 性能 + 缓存

## 1. 目标

`stele generate` 默认增量。100 个 `.stele` 文件改 1 个时，生成时间减少 ≥ 90%。**架构正确性约束**：变更被传递依赖（imports）的所有文件必须重新生成；增量与全量生成结果**byte-equal**。

## 2. 核心算法：transitive_hash

### 2.1 输入

- 项目根 `.stele` 文件集 `F = {f_1, f_2, ...}`
- 每个文件的 import DAG（由 `loadContract` 提供）
- `stele.config.json`
- 当前 CLI version (`stele_version`)
- 当前操作符注册表内容（`CORE_OPERATOR_SPECS`）

### 2.2 关键观察

仅哈希文件本身**不够**：

```
A.stele imports B.stele
用户改 B.stele 但不改 A.stele
   ↓
A.stele own_hash 未变 → 错误地跳过 A 的重新生成
```

正确算法：每个文件计算 `transitive_hash`，含传递依赖。

### 2.3 算法（伪代码）

```
function buildTransitiveHash(files: Map<Path, ParsedFile>, dag: DAG): Map<Path, Hash> {
  // 拓扑排序（叶子在前）
  sorted = topologicalSort(dag)
  result = new Map<Path, Hash>()

  for (file in sorted) {
    own = sha256(normalizeContract(file.ast))
    deps_hashes = file.deps
                    .map(d => result.get(d))
                    .sort()  // determinism: 排序消除迭代顺序不稳定
    transitive = sha256(own + "|" + deps_hashes.join("|"))
    result.set(file.path, transitive)
  }

  return result
}
```

`normalizeContract` 引用 `@stele/core/src/normalizer/normalize.ts`（见 `index.ts:42`）。它做：

- 字段顺序归一化（不依赖 source 顺序）
- 去除 comments + whitespace（不影响语义）
- 字符串字面量保持

## 3. 缓存文件设计

### 3.1 路径

`contract/.cache/hash-manifest.json`

注意：

- **不**用 `.stele/cache/`（与现有 `contract/.manifest.json`、`contract/.baseline.json` 冲突）
- snake_case 字段（与 `manifest/manifest.ts` 一致）
- 默认**不**加 .gitignore（用户可选）

### 3.2 Schema

```typescript
export interface HashManifest {
  version: string;                     // "1"
  generated_at: string;                // ISO 8601
  stele_version: string;               // 生成时 CLI 版本
  backend: string;                     // 生成时 targetLanguage
  operator_registry_hash: string;      // SHA-256 of CORE_OPERATOR_SPECS
  config_hash: string;                 // SHA-256 of stele.config.json (排除 timestamps)
  files: Record<string, FileEntry>;
}

export interface FileEntry {
  own_hash: string;                    // SHA-256(normalizeContract(self).serialized)
  transitive_hash: string;             // SHA-256(own_hash || sort(transitive_hash[deps]))
  deps: string[];                      // 直接依赖文件相对路径（排序）
  output_paths: string[];              // 该文件产生的生成物
  output_hashes: Record<string, string>; // 各生成物内容哈希（防外部篡改）
}
```

**为什么含 `output_hashes`**：用户可能手动篡改 `tests/contract/test_*.ts`。如果 own/transitive_hash 未变但生成物 hash 变了 → 检测篡改并重新生成。

## 4. Generate 算法（修正：full-regenerate-and-filter）

⚠️ **关键修正**：早期草稿写 `backend.generate({ ...contract, scope: [path] }, ...)`——但 `LanguageBackend.generate` **没有** `scope` 参数（`coordinator.ts:24`）。修改 backend 接口让所有 backend 实现 scope 是侵入性大的；v0.2 选择**全量生成 + 按 output_path 哈希过滤写入**：每次都跑完整 generate，但只把哈希变更的文件写盘。

性能权衡：generator 是纯计算（ms 级），主要成本在文件 IO。Skip 写盘节约 90%+ 的实际耗时；满足 §10 性能目标。

```typescript
async function generateIncremental(opts: GenerateOpts): Promise<GenerateResult> {
  const projectRoot = process.cwd();
  const config = await loadConfig(projectRoot);
  const cachePath = join(projectRoot, "contract/.cache/hash-manifest.json");

  // 1. 读现有 manifest（如有；容忍损坏）
  let cached: HashManifest | null = null;
  try {
    cached = JSON.parse(await fs.readFile(cachePath, "utf-8"));
  } catch (err) {
    if (!isENOENT(err) && !isJSONParseError(err)) throw err;
  }

  // 2. 全量失效条件
  const currentConfigHash = stableStringifyHash(config);
  const currentBackend = config.targetLanguage;
  const currentSteleVersion = STELE_CLI_VERSION;
  const currentOperatorRegistryHash = stableStringifyHash(CORE_OPERATOR_SPECS);
  // 用 stableStringify（已存在于 packages/core/src/report/types.ts:156-175）
  // 而非 JSON.stringify，避免对象属性顺序敏感

  const fullInvalidate = (
    !cached ||
    cached.version !== "1" ||
    cached.config_hash !== currentConfigHash ||
    cached.backend !== currentBackend ||
    cached.stele_version !== currentSteleVersion ||
    cached.operator_registry_hash !== currentOperatorRegistryHash
  );

  // 3. 加载 contract DAG
  const contract = await loadContract(config.entry, projectRoot);

  // 4. 计算 transitive_hash（用于 manifest 记录与未来快速判断）
  const transitiveHashes = buildTransitiveHash(contract.files, contract.dag);

  // 5. 全量生成（以 backend 视角无变化）
  const backend = await loadBackend(config.targetLanguage, config.testFramework);
  const generationConfig = { projectRoot, outputDir: config.generatedDir };
  const allGenerated = backend.generate(contract, generationConfig);
  // generated.length 通常约为 contract.files.size；每条目 { path, content }

  // 6. 用 output_path 哈希过滤要写盘的文件
  let writtenCount = 0, skippedCount = 0;
  const newOutputHashes: Record<string, string> = {};

  for (const file of allGenerated) {
    const newHash = sha256(file.content);
    newOutputHashes[file.path] = newHash;

    // 强制全量 / 缓存失效 / 缓存里无此文件 → 写
    if (fullInvalidate || opts.force) {
      await writeAtomic(file.path, file.content);
      writtenCount++;
      continue;
    }

    // 寻找此 output_path 在 cached 中的旧哈希
    const oldHash = findOldHash(cached, file.path);
    if (oldHash === newHash) {
      // 内容相同；再确认磁盘上文件存在且未被外部篡改
      const onDiskHash = await sha256OfFileOrNull(file.path);
      if (onDiskHash === oldHash) {
        skippedCount++;
        continue;
      }
    }
    await writeAtomic(file.path, file.content);
    writtenCount++;
  }

  // 7. 计算需要删除的 stale outputs（cached 中曾存在但 allGenerated 中不再有）
  const generatedPaths = new Set(allGenerated.map((f) => posixNormalize(f.path)));
  const toDelete: string[] = [];
  if (cached) {
    for (const entry of Object.values(cached.files)) {
      for (const oldOut of entry.output_paths) {
        if (!generatedPaths.has(posixNormalize(oldOut))) {
          toDelete.push(oldOut);
        }
      }
    }
  }
  for (const out of toDelete) {
    await fs.unlink(out).catch((err) => {
      if (!isENOENT(err)) throw err;
    });
  }

  // 8. 重建 file entries（按 contract.files 重建，丢弃孤儿 cache 条目）
  const newFileEntries: Record<string, FileEntry> = {};
  for (const [filePath, fileAst] of contract.files.entries()) {
    const ownHash = sha256(serializeNormalized(fileAst));
    const transHash = transitiveHashes.get(filePath)!;
    // 该 .stele 产生的 output_paths 由 backend 决定；用启发式：
    // backend 根据 group 名 emit test_<group>.ts；这里需 backend 提供 outputPathsFor(filePath)
    // v0.2 简化：把所有 generated 视为整个 contract 的产物（不按 .stele 文件归属）
    // → 仅记录 contract.entry 的 entry，不记录每文件的 output 关系
    newFileEntries[filePath] = {
      own_hash: ownHash,
      transitive_hash: transHash,
      deps: Array.from(fileAst.imports).sort(),
      output_paths: [],         // v0.2：留空（不细粒度归属）
      output_hashes: {},        // 同上
    };
  }

  // 9. 写新 manifest（如非 --no-cache）
  if (!opts.noCache) {
    const newManifest: HashManifest = {
      version: "1",
      generated_at: new Date().toISOString(),
      stele_version: currentSteleVersion,
      backend: currentBackend,
      operator_registry_hash: currentOperatorRegistryHash,
      config_hash: currentConfigHash,
      files: newFileEntries,
      output_hashes_global: newOutputHashes,  // v0.2：把 output_hash 集中存
    };
    await writeAtomic(cachePath, JSON.stringify(newManifest, null, 2));
  }

  return {
    written: writtenCount,
    skipped: skippedCount,
    deleted: toDelete.length,
  };
}

function findOldHash(cached: HashManifest | null, outputPath: string): string | undefined {
  if (!cached) return undefined;
  return cached.output_hashes_global?.[posixNormalize(outputPath)];
}

function posixNormalize(p: string): string {
  return p.replace(/\\/g, "/");
}
```

### 4.1 Schema 微调

`HashManifest.output_hashes_global` 是 v0.2 新增字段：

```typescript
interface HashManifest {
  version: "1";
  generated_at: string;
  stele_version: string;
  backend: string;
  operator_registry_hash: string;
  config_hash: string;
  files: Record<string, FileEntry>;
  output_hashes_global: Record<string, string>;  // v0.2 新增：所有生成物 path → SHA-256
}
```

`output_hashes_global` 替代 v1.0 草稿的"per-file output_hashes"，因为算法不再按 .stele 文件粒度归属生成物。

### 4.2 并发安全（修正：UB 文档化）

⚠️ 早期草稿说"两个并发 stele generate 不互相破坏"是过度承诺。实际：

- 进程 A 读 cache v0 → 生成 → 写 v1 → 落盘 file_a
- 进程 B 同时读 cache v0 → 生成 → 写 v2 → 落盘 file_b
- B 的 manifest 不含 A 的 file_a 写入 → 下次 stele check 看 file_a 哈希与 manifest 不匹配 → 假阳性"file_a 被篡改"

**v0.2 决策**：文档化为**未定义行为**：

> 同时运行多个 `stele generate` 的结果未定义。CI 应串行调用；本地开发不应并行触发。如发现哈希误报，运行 `stele generate --force`。

未来 v0.5 候选：用 `proper-lockfile` 在 `contract/.cache/.lock` 加文件锁。

## 5. 原子写

```typescript
async function writeAtomic(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, content, "utf-8");
  try {
    await fs.rename(tmp, path);
  } catch (err) {
    // Windows: rename may fail if dest exists
    await fs.unlink(path).catch(() => undefined);
    await fs.rename(tmp, path);
  }
}
```

## 6. 并发

参见 §4.2：v0.2 文档化并发为 UB。`writeAtomic` 仍用 atomic rename 防止部分写；但两进程并行 generate 的最终一致性**不**保证。

测试：

- 单测中模拟并发（two child processes）
- 验证最终 `hash-manifest.json` 总是 valid JSON（不损坏）
- **不**验证最终 output_hashes 与 manifest 一致（UB）

## 7. CLI

```typescript
program.command("generate")
  .option("--force", "Ignore cache, regenerate all files", false)
  .option("--no-cache", "Skip cache (read or write)", false)
  .action(async (opts) => { /* ... */ });

program.command("cache")
  .description("Manage Stele incremental generation cache")
  .command("clean")
    .description("Delete contract/.cache/hash-manifest.json")
    .action(async () => {
      const path = join(process.cwd(), "contract/.cache/hash-manifest.json");
      await fs.unlink(path).catch(() => undefined);
      console.log("Cleaned.");
    });
  .command("info")
    .description("Show cache stats")
    .action(async () => {
      // 输出 entries 数、总大小、generated_at
    });
```

flag 行为表：

| flag | 读 cache | 写 cache | 何时用 |
|---|---|---|---|
| (默认) | ✓ | ✓ | 日常 |
| `--force` | ✗ | ✓ | 怀疑缓存损坏，重建 |
| `--no-cache` | ✗ | ✗ | CI 一次性运行，不污染 |

## 8. 配置变化检测

`config_hash` 计算：

```typescript
function sha256OfConfig(config: SteleConfig): string {
  // 排除 timestamps 字段（如果有）
  const stable = JSON.stringify(config, Object.keys(config).sort().filter((k) => k !== "_generated_at"));
  return sha256(stable);
}
```

任何 config 改动 → 全量。这是"保守安全"的策略；可优化但 v0.2 不必。

## 9. Migration

EP05 默认增量是**行为变更**：

- 现有 CI/local 流程**不需要变更**（增量与全量 byte-equal）
- 如需 v0.1 行为：`stele generate --force`
- `contract/.cache/` 可加 .gitignore（推荐但不强制）

`docs/contributing/migration-v0.2.md`：

```markdown
# Migration v0.1 → v0.2

## EP05: stele generate default

v0.2 默认增量。99% 用户**无需变更**。

例外场景：
- 怀疑缓存腐败：`stele generate --force`
- CI 临时一次性：`stele generate --no-cache`

新增文件：`contract/.cache/hash-manifest.json`
- 大小：~ 100B per .stele 文件
- 应否 gitignore？取决于团队偏好；推荐 gitignore 因为是 derived state
```

## 10. 性能预期

| 项目大小 | 全量时间 | 增量（1 文件改）| 加速 |
|---|---|---|---|
| 10 .stele | 0.3s | 0.05s | 6× |
| 100 .stele | 2.5s | 0.15s | 16× |
| 500 .stele | 12s | 0.4s | 30× |

测试：`tests/conformance/` 增加 `99-incremental-perf` fixture（含 100 .stele 文件 + 1 个变化），CI 检查 < 10% 全量时间。

## 11. 测试

```typescript
describe("incremental generation", () => {
  it("regenerates all files on first run", async () => { /* ... */ });
  it("skips unchanged files on second run", async () => { /* ... */ });
  it("regenerates dependent files when import changes", async () => {
    // 创建 A imports B; 改 B 不动 A
    // 验证 A 的 test file 也重新生成
  });
  it("invalidates on stele_version change", async () => { /* ... */ });
  it("invalidates on operator_registry_hash change", async () => { /* ... */ });
  it("invalidates on config change", async () => { /* ... */ });
  it("recovers from corrupted cache (malformed JSON)", async () => { /* ... */ });
  it("cleans up stale outputs when .stele file deleted", async () => { /* ... */ });
  it("--force regenerates all", async () => { /* ... */ });
  it("--no-cache does not write cache", async () => { /* ... */ });
  it("byte-equal output: incremental vs --force", async () => {
    // 关键：增量和全量必须输出相同
  });
});
```

## 12. 不在范围内（v0.5+）

- 并行生成（`Promise.all` over groups）
- Distributed cache（多机器共享）
- Watch mode（auto-regenerate on file change）—— `stele dev` 已有但不集成增量缓存

## 13. 验收标准（来自 PRD §6.4）

- [ ] **import 依赖正确性**：改 B.stele 时所有 import 它的文件被重新生成
- [ ] config 改动 → 全量失效
- [ ] CLI 升级（stele_version 变化）→ 全量失效
- [ ] 操作符注册表变化（operator_registry_hash 变化）→ 全量失效
- [ ] 缓存损坏 → 优雅退化为全量
- [ ] 并发两个 `stele generate` 不互相破坏
- [ ] 增量与全量输出**byte-equal**
- [ ] Migration 文档 `docs/contributing/migration-v0.2.md` 含本节内容
- [ ] 100 文件单改场景加速 ≥ 90%
