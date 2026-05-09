# P0.2 详细设计：测试债冲刺

> PRD: [prd-phase-0.md §5](../../prd-phase-0.md) | 估算: 1 周 | 类别: 测试质量

## 1. 目标

`@stele/core` 整体覆盖率从 ~35% 提升到 ≥ 50%。关键模块达到独立指标。**核心可衡量目标**：EP01 conformance suite 能区分真正的 Python 后端回归 vs TypeScript 实现 bug。

## 2. 优先级（按阻塞程度排序）

| 优先级 | 文件 | 行数 | 当前直接覆盖 | 目标 | 阻塞 |
|---|---|---|---|---|---|
| P1 | `validator/structure-code-shape.ts` | 524 | 0 | 70% | EP06 Code Shape 直接消费 |
| P1 | `validator/structure-scenario.ts` | 392 | 0 | 70% | EP01 scenario runtime |
| P1 | `validator/structure-invariant.ts` | 316 | 0 | 70% | 所有 invariant 路径必经 |
| P1 | `validator/structure-parse.ts` | 329 | 0 | 70% | 所有顶层声明入口 |
| P2 | `validator/structure-types.ts` | 286 | 部分 | 70% | EP04 类型校验 |
| P2 | `loader/loadContract.ts` | 87 | 部分 | 75% | EP05 增量生成依赖图 |
| P2 | `manifest/manifest.ts` | (现有) | 部分 | 75% | EP05 缓存关联 |
| P3 | `errors/SteleError.ts` | 15 | 0 | 80% | EP02 注解输出 |
| P3 | `baseline/io.ts` | 83 | 0 | 70% | EP05 cache 兼容 |

加权聚合后整体行覆盖率应超 50%。

## 3. 测试设计模式

### 3.1 结构校验（structure-*）

每个 structure-* 文件遵循同一模式。**注意**：实际签名是 `parseInvariantDeclaration(filePath, node, groupId?)`（来自 `packages/core/src/validator/structure-invariant.ts:14`），错误码以源码 `grep "code:" packages/core/src/validator/structure-invariant.ts` 为准（典型为 `E0301`-`E0399` 系列）。

```ts
// tests/validator/structure-invariant.test.ts (sketch)
import { describe, it, expect } from "vitest";
import { parseInvariantDeclaration } from "@stele/core/validator/structure-invariant";
import { mkListNode } from "../helpers.js";  // 测试辅助

describe("structure-invariant", () => {
  const FILE_PATH = "fixtures/test.stele";
  describe("required fields", () => {
    it("rejects invariant without severity", () => {
      const node = mkListNode([/* invariant decl without severity */]);
      expect(() => parseInvariantDeclaration(FILE_PATH, node, undefined))
        .toThrow(/E03\d{2}/);  // 实际错误码以源码为准
    });
    it("rejects invariant without description", () => { /* ... */ });
    // ... per required field
  });

  describe("severity values", () => {
    it.each(["critical", "high", "medium", "low"])(
      "accepts %s severity",
      (sev) => { expect(parseInvariantDeclaration(mkAst({ severity: sev }))).not.toThrow(); }
    );
    it("rejects unknown severity", () => { /* ... */ });
  });

  describe("invariant body", () => {
    it("requires either assert or uses-checker", () => { /* E0204 */ });
    it("rejects both assert and uses-checker simultaneously", () => { /* E0205 */ });
  });

  describe("optional fields", () => {
    it.each(["category", "tags", "when", "tolerance", "depends-on", "rationale", "since", "applies-to"])(
      "accepts optional %s field",
      (field) => { /* ... */ }
    );
  });
});
```

**约束**：

- **不许引入新的 production code**：仅写测试
- **不许修改现有 production code 的接口**：可改内部实现，但导出函数签名冻结
- **fixture 来源**：复用 `fixtures/python-app/contract/`，不重复造样本
- **错误码引用**：用 `expect(...).toThrow(/E\d{4}/)` 模式，不依赖错误消息文本

### 3.2 错误类（SteleError）

⚠️ 真实 API 是**位置参数**（`packages/core/src/errors/SteleError.ts`，15 行）：

```typescript
new SteleError(code: string, category: string, message: string, span?, detail?, hint?)
```

无 `cause` 字段。测试相应：

```ts
describe("SteleError", () => {
  it("constructs with code + category + message", () => {
    const err = new SteleError("E0001", "ParseError", "unexpected token");
    expect(err.code).toBe("E0001");
    expect(err.category).toBe("ParseError");
    expect(err.message).toBe("unexpected token");
  });
  it("accepts optional span / detail / hint", () => {
    const err = new SteleError("E0001", "ParseError", "...", { line: 1, column: 1 }, "more detail", "try X");
    expect(err.span).toBeDefined();
    expect(err.detail).toBe("more detail");
    expect(err.hint).toBe("try X");
  });
  it("serializes to JSON without circular reference", () => {
    const err = new SteleError("E0001", "ParseError", "...");
    expect(() => JSON.stringify(err)).not.toThrow();
  });
  it("toString includes code + message", () => {
    const err = new SteleError("E0001", "ParseError", "msg");
    expect(String(err)).toContain("E0001");
    expect(String(err)).toContain("msg");
  });
});
```

### 3.3 IO 模块（baseline/io）

```ts
describe("baseline/io", () => {
  describe("readViolationBaseline", () => {
    it("returns null when file does not exist", async () => { /* ... */ });
    it("returns null when file is empty", async () => { /* ... */ });
    it("throws SteleError on malformed JSON", async () => { /* E04xx */ });
    it("throws SteleError on version mismatch", async () => { /* ... */ });
    it("parses valid baseline", async () => { /* ... */ });
  });
  describe("writeViolationBaseline", () => {
    it("writes atomically (no partial file on crash)", async () => {
      // 用 vi.mock fs.rename 模拟失败，验证临时文件被清理
    });
    it("creates parent directory if missing", async () => { /* ... */ });
    it("preserves indentation across re-writes", async () => { /* ... */ });
  });
});
```

## 4. Coverage 报告生成

```bash
pnpm --filter @stele/core test --coverage
# vitest 默认用 v8 coverage；输出 packages/core/coverage/index.html

# CI gate：检查 lcov 文件中 lines.pct ≥ 50.0
node -e '
  const lcov = require("fs").readFileSync("packages/core/coverage/lcov.info", "utf-8");
  const lines = lcov.match(/^LF:(\\d+)/gm).reduce((s, m) => s + parseInt(m.slice(3)), 0);
  const hits = lcov.match(/^LH:(\\d+)/gm).reduce((s, m) => s + parseInt(m.slice(3)), 0);
  if (hits / lines < 0.5) { console.error("Coverage below 50%"); process.exit(1); }
'
```

`.github/workflows/ci.yml` 增加 coverage gate step。

## 5. 验收对接

PRD §5.3 要求"全部 861 个旧测试**继续 100% 通过**"。CI 步骤：

```bash
pnpm test 2>&1 | tee test-output.log
TEST_COUNT=$(grep -E "^Tests +([0-9]+) passed" test-output.log | awk '{print $2}')
if [ "$TEST_COUNT" -lt 861 ]; then
  echo "Test count regressed: $TEST_COUNT < 861 baseline"
  exit 1
fi
```

注意：本数字 861 是 v2.0 起步时的快照。Phase 0 W0.2 完成后会上升；后续 Phase 1 baseline 重置。

## 6. 不在范围内

- 修复 production bug（即使测试发现 bug，本周仅记录到 issue，不在 W0.2 修）
- 引入新的测试框架（vitest 已是项目标准）
- 端到端 integration test（属 EP01 conformance suite 范畴）

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 写测试时发现 production bug | 记录到 issue 加 "found-by-W0.2" label；不在 W0.2 修 |
| 1 周不够达到 50% 总覆盖率 | 优先级表的 P1 全部完成即视为 W0.2 通过；P2/P3 可滚到 Phase 1 第一周 |
| Vitest snapshot 漂移 | 不使用 snapshot 测试；所有断言显式化 |

## 8. 验收标准

- [ ] `pnpm --filter @stele/core test --coverage` 行覆盖率 ≥ 50%
- [ ] `validator/structure-*.ts` 5 个拆分文件聚合 ≥ 60%
- [ ] `errors/SteleError.ts` ≥ 80%
- [ ] `baseline/io.ts` ≥ 70%
- [ ] 全部 861 个旧测试通过；不允许 `.skip`
- [ ] CI 增加 coverage gate（< 50% 失败）
- [ ] **不引入新 production code 文件**（`git diff --stat` 仅显示 `tests/`）
