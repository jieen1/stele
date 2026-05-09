# Stele 详细设计文档

> 状态: 起草中 | 基于: [PRD v2.0 套件](../prd-phase-0.md)

每个 PRD EP 对应一份详细设计文档，回答"如何实施"。设计文档涵盖：

- **接口与类型**：导出的函数签名、类型定义、错误码
- **数据结构**：on-disk format、in-memory representation、序列化协议
- **算法**：关键路径的伪代码或显式步骤
- **错误路径与边界条件**：什么情况下抛、抛什么、用户怎么恢复
- **测试计划**：单测覆盖目标、conformance fixture、集成测试
- **迁移与向后兼容**：从 v0.1 / 现有代码到本设计的过渡

## 目录

### Phase 0 — 前置（4 项）

| # | 设计文档 | 工作项 |
|---|---|---|
| P0.1 | [phase-0/01-npm-publish.md](phase-0/01-npm-publish.md) | npm 发布 |
| P0.2 | [phase-0/02-test-debt-sprint.md](phase-0/02-test-debt-sprint.md) | 测试债冲刺 |
| P0.3 | [phase-0/03-backend-registry.md](phase-0/03-backend-registry.md) | LanguageBackend 注册表 |
| P0.4 | [phase-0/04-conformance-suite.md](phase-0/04-conformance-suite.md) | 跨后端一致性测试套件 |

### Phase 1 — 9 个 EP

| # | 设计文档 | EP |
|---|---|---|
| EP01 | [phase-1/01-typescript-backend.md](phase-1/01-typescript-backend.md) | TypeScript/JavaScript 后端 |
| EP02 | [phase-1/02-github-action.md](phase-1/02-github-action.md) | GitHub Action（含 PR 评论）|
| EP03 | [phase-1/03-pre-commit.md](phase-1/03-pre-commit.md) | pre-commit 钩子 |
| EP04 | [phase-1/04-operators-batch-1.md](phase-1/04-operators-batch-1.md) | CDL 操作符批次 1 |
| EP05 | [phase-1/05-incremental-generation.md](phase-1/05-incremental-generation.md) | 增量生成性能优化 |
| EP06 | [phase-1/06-code-shape-python.md](phase-1/06-code-shape-python.md) | Code Shape Python 后端补全 |
| EP07 | [phase-1/07-stele-why-witness.md](phase-1/07-stele-why-witness.md) | stele why 失败见证 |
| EP08 | [phase-1/08-recursive-flag.md](phase-1/08-recursive-flag.md) | 多项目 --recursive 标志 |
| EP09 | [phase-1/09-agent-hooks-sdk.md](phase-1/09-agent-hooks-sdk.md) | agent-hooks SDK + Cursor 适配器 |

### Phase 2 — 4 个 EP

| # | 设计文档 | EP |
|---|---|---|
| EP10 | [phase-2/10-go-backend.md](phase-2/10-go-backend.md) | Go 后端 |
| EP11 | [phase-2/11-vscode-mvp.md](phase-2/11-vscode-mvp.md) | VS Code 扩展 MVP |
| EP12 | [phase-2/12-stele-impact.md](phase-2/12-stele-impact.md) | stele impact 变更影响分析 |
| EP13 | [phase-2/13-operators-batch-2.md](phase-2/13-operators-batch-2.md) | CDL 操作符批次 2 |

## 设计原则（适用于全部设计文档）

1. **接口优先**：每份设计先写公共 API + 类型，再写实现
2. **确定性强制**：任何引入非确定性（clock、random、env、文件序）的设计必须显式声明 carve-out
3. **fail-closed**：错误路径默认拒绝；不允许"忽略错误继续"
4. **跨语言对等**：Python / TypeScript / Go runtime 行为差异在设计文档中明文列出，不留给读者推测
5. **测试 first**：每个公共 API 在交付前必须有 conformance fixture 验证

## 评审与版本管理

每份设计文档在 PRD 完成后**至少经历 2 轮独立评审**（参见 [docs/internal/](../internal/)）。设计文档版本号与 PRD 版本对齐：v0.2 PRD → v0.2 设计；如设计中发现 PRD 漏洞，回到 PRD 修订。
