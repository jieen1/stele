# Stele CLI JSON 输出 Schema

> 状态: v0.2 起草 | 最后更新: 2026-05-08
> 单一权威来源；其他设计文档引用本文，不重复 schema 定义

本文档定义 Stele CLI 命令 `--json` 输出格式，与 [`cdl.md`](cdl.md)（CDL 语言规范）相区别。CI 集成（`@stele/github-action`）、IDE 扩展（`@stele/vscode-extension`）、agent-hooks SDK 都基于本文档定义的字段消费。

## 1. 通用规则

- 顶层始终含 `schema_version: "1"` 与 `tool: string`、`command: string`
- 字段命名 `snake_case`（与 `packages/core/src/report/types.ts` 一致）
- 时间戳 ISO 8601 字符串
- 浮点数比较容差 1e-9
- 未知字段消费者必须容忍（forward compatibility）

## 2. 真实 Violation schema（v0.2 基线）

源码：`packages/core/src/report/types.ts`。本文档反映**当前实际**字段。

```typescript
type Violation = {
  rule_id: string;            // NOT invariant_id; 与 v0.1 一致
  rule_kind: string;          // 例: "invariant" | "generated_drift" | "manifest_drift" | ...
  severity: "error" | "warning" | "info";
  source: { tool: string; command: string; kind: string };
  location: ViolationLocation;
  cause: ViolationCause;
  fingerprint: string;        // SHA-256 hex
  scope_paths: string[];      // unique-sorted
  status?: "active" | "suppressed" | "out_of_scope";
  suppressed_by?: "baseline";
  fix?: { summary: string; command?: string };
  introduced_in?: string;
};

type ViolationLocation = {
  path?: string;              // NOT file; 真实字段名
  manifest_path?: string;
  generated_dir?: string;
  line?: number;
  column?: number;
};

type ViolationCause = {
  summary: string;            // 一行人类可读描述
  detail?: string;            // 多行扩展（string，NOT 对象）
  missing?: string[];
  changed?: string[];
  extra?: string[];
  new_files?: string[];
  expected_hash?: string;
  actual_hash?: string;
  failure_witness?: FailureWitness;  // v0.2 新增：见 §3
};

type ViolationReport = {
  schema_version: "1";
  tool: string;
  command: string;
  ok: boolean;
  summary: ViolationReportSummary;
  violations: Violation[];
};
```

**注意**：早期 design doc 草稿引用了 `invariant_id`、`location.file`、`cause.kind`、`cause.expected_value`、`cause.actual_value`、`cause.detail.message` 等字段——这些**全部不存在于实际 schema**。所有 design doc 与 PRD 已修正以使用真实字段名。

## 3. failure_witness 字段（v0.2 EP07 新增）

```typescript
type FailureWitness = {
  operator: "forall" | "exists" | "where" | "none";
  collection_size: number;
  failed_at_index?: number;
  failed_item?: unknown;          // 浅层快照（max_depth=2，敏感字段已 redact）
  predicate_source?: string;      // 失败子表达式源码
  truncated: boolean;             // 序列化是否被截断
};
```

约束：

- 单 witness 序列化后 ≤ **64 KB**（之前 16 KB 提议被 EP07 round 2 决议提到 64 KB）
- 子项 cap：`predicate_source` ≤ 4 KB；`failed_item` ≤ 8 KB；`failed_item` 数组截断 100 项时设置 `truncated: true`
- 字段名包含 `password`、`token`、`secret`、`api[_-]?key`（不区分大小写）→ 替换为 `"<redacted>"`
- 只在 `forall`/`exists`/`where`/`none` 失败时填充；其他 `cause.kind` 不含

`FailureWitness` 类型**单一定义**在 `packages/core/src/report/types.ts`，由 EP01/EP02/EP07/EP10/EP11 共享 import。

## 4. 命令 schema

### 4.1 `stele check --json`

输出 `ViolationReport`（§2 schema）。`tool: "@stele/cli"`，`command: "check"`。

### 4.2 `stele why <id-or-fingerprint> --json`（v0.2 EP07）

```json
{
  "schema_version": "1",
  "tool": "@stele/cli",
  "command": "why",
  "rule_id": "BALANCE_NON_NEGATIVE",
  "severity": "error",
  "description": "Account balance must be non-negative.",
  "rationale": "...",
  "last_check_at": "2026-05-08T10:00:00Z",
  "last_check_status": "failed",
  "violation": {
    "rule_id": "...",
    "fingerprint": "sha256:...",
    "cause": {
      "summary": "forall failed at index 3",
      "detail": "...",
      "failure_witness": { "operator": "forall", "collection_size": 47, "failed_at_index": 3, ... }
    },
    "...": "..."
  }
}
```

### 4.3 `stele impact --json`（v0.3 EP12）

```json
{
  "schema_version": "1",
  "tool": "@stele/cli",
  "command": "impact",
  "diff_from": "main",
  "head_ref": "feature/balance-refactor",
  "generated_at": "2026-05-08T10:00:00Z",
  "changed_files": ["..."],
  "affected_invariants": [
    {
      "rule_id": "BALANCE_NON_NEGATIVE",
      "matched_files": ["ledger/account.py"],
      "applies_to": "ledger/account.py",
      "recommendation": "review"
    }
  ],
  "uncovered_changes": [...],
  "orphan_invariants": [...]
}
```

**显式不含**：v1.0 PRD 草稿提议的 `indirect_impacts`（v2.0 已删除）。

### 4.4 `stele check --recursive --json`（v0.2 EP08）

```json
{
  "schema_version": "1",
  "tool": "@stele/cli",
  "command": "check",
  "generated_at": "2026-05-08T10:00:00Z",
  "cwd": "/repo",
  "projects": [
    {
      "project": "/repo/packages/core",
      "exit_code": 0,
      "summary": { "violation_count": 0, "..." : "..." },
      "violations": []
    }
  ],
  "max_exit_code": 0,
  "passed": 1,
  "failed": 0
}
```

### 4.5 现有 v0.1 命令

`stele rules --json`、`stele agent-context --json`、`stele list --format json`、`stele explain --json`、`stele why <fingerprint> --json`、`stele propose ... --json`、`stele maintenance-summary --json`：v0.1 已实现；schema 在 v0.4 文档冲刺时统一汇编进本文。

## 5. 时间戳字段命名规范

| 语义 | 字段名 |
|---|---|
| 当前 CLI 调用产生此输出的时刻 | `generated_at` |
| 最近一次 stele check 完成的时刻（仅 stele why 类回顾命令） | `last_check_at` |

不要用 `timestamp`（歧义）。

## 6. 消费者失败处理矩阵

| 消费者 | schema_version 不匹配 | 字段缺失 | 处理 |
|---|---|---|---|
| `@stele/github-action` | 用人类可读 fallback | tolerate | log warning，continue |
| `@stele/vscode-extension` | 显示原始 stderr | tolerate | diagnostic 不显示 |
| `@stele/agent-hooks` | fail-closed | fail-closed | hook deny |
