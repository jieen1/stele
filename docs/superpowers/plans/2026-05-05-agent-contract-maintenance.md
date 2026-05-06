# Agent Contract Maintenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first production slice that lets agents understand, validate, and continuously add Stele contract knowledge while keeping edits/deletions under strict user-reviewed flows.

**Architecture:** Add a rule-intelligence layer in the CLI that derives machine-readable rule indexes from the existing loaded contract, check report, baseline, and config. Add agent-facing commands that produce focused Markdown/JSON context, explain failures, and append new contract entries through a constrained add-only command that never refreshes manifest locks by itself.

**Tech Stack:** TypeScript CLI, existing `@stele/core` contract model/report types, Vitest, existing Claude Code plugin docs/skills.

---

### Task 1: Rule Index And Explain JSON

**Files:**
- Create: `packages/cli/src/commands/rules.ts`
- Modify: `packages/cli/src/commands/explain.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/tests/commands.test.ts`

- [x] **Step 1: Add failing tests**

Add tests that call `runRules(projectDir, { json: true })` and `runExplain(projectDir, "ROOT_PAYMENT_BALANCE", { json: true })`. Assert the JSON includes invariant id, kind, severity, category, tags, file path, line, generated test path, dependencies, checker/scenario linkage, code-shape entries, scenario entries, and protected globs.

- [x] **Step 2: Verify red**

Run:

```bash
pnpm --filter @stele/cli test -- commands.test.ts
```

Expected: TypeScript/Vitest fails because `runRules` and explain JSON options are not implemented.

- [x] **Step 3: Implement minimal rule index**

Implement `buildRuleIndex(projectDir)` and `runRules(projectDir, options)` in `rules.ts`. Reuse `loadConfig`, `loadContract`, and small local AST formatting helpers. Output JSON when `--json` is set; output a concise human table otherwise.

- [x] **Step 4: Add explain JSON**

Extend `runExplain` to accept `{ json?: boolean }`. Preserve the current human output by default. JSON mode should return one matching rule object plus source text.

- [x] **Step 5: Wire CLI**

Add `stele rules [--json]` and `stele explain <id> [--json]` to `createProgram`, with dependency injection for tests.

### Task 2: Agent Context And Why

**Files:**
- Create: `packages/cli/src/commands/agentContext.ts`
- Create: `packages/cli/src/commands/why.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/tests/commands.test.ts`

- [x] **Step 1: Add failing tests**

Add tests for `runAgentContext(projectDir, { format: "markdown", focus: ["src/payments.py"] })` and `runWhy(projectDir, "ROOT_PAYMENT_BALANCE", { json: false })`. Assert the agent context includes protected files, maintenance policy, relevant high-severity rules, and explicit guidance to repair source/fixtures before contract edits.

- [x] **Step 2: Verify red**

Run:

```bash
pnpm --filter @stele/cli test -- commands.test.ts
```

Expected: fails because commands do not exist.

- [x] **Step 3: Implement agent context**

Produce Markdown and JSON from the rule index. Focus support should include rules whose `applies-to`, code-shape target, or source path text overlaps the provided focus paths; when no focus matches, include critical/high rules and all protected path guidance.

- [x] **Step 4: Implement why**

Accept a rule id or violation fingerprint. For rule ids, use explain data. For fingerprints, run `buildRawCheckReport` and match active/suppressed/out-of-scope violations. Human output must include cause, location, fix, and whether the agent should modify source, add a new rule, or ask user review for contract changes.

- [x] **Step 5: Wire CLI**

Add `stele agent-context [--json] [--focus <path...>]` and `stele why <id-or-fingerprint> [--json]`.

### Task 3: Add-Only Contract Maintenance

**Files:**
- Create: `packages/cli/src/commands/propose.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/tests/commands.test.ts`

- [x] **Step 1: Add failing tests**

Add tests for `runPropose(projectDir, { kind: "invariant", id, severity, description, rationale, category, assert, apply: true })`. Assert it appends a valid invariant to `contract/proposals/agent-additions.stele`, imports that file from `contract/main.stele` only when missing, refuses duplicate ids, refuses existing contract-file writes outside the proposal file, and does not run `generate`, `lock`, or mutate the manifest.

- [x] **Step 2: Verify red**

Run:

```bash
pnpm --filter @stele/cli test -- commands.test.ts
```

Expected: fails because `runPropose` is missing.

- [x] **Step 3: Implement add-only proposal**

Support invariant proposals first. Validate id shape, required fields, and parse/load the resulting contract after append. Default to printing the proposal; require `--apply` to write. Never support modify/delete in this command.

- [x] **Step 4: Wire CLI**

Add `stele propose invariant --id ... --severity ... --description ... --assert ... [--category ...] [--rationale ...] [--apply]`.

### Task 4: Maintenance Summary Artifact

**Files:**
- Create: `packages/cli/src/commands/maintenance.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/tests/commands.test.ts`

- [x] **Step 1: Add failing tests**

Add tests for `runMaintenanceSummary(projectDir, { from: "HEAD~1", output: ".stele/maintenance/summary.md" })`. Assert the file contains recent changed files, current contract inventory, active check status, candidate missing-rule questions, and commands for add-only proposals.

- [x] **Step 2: Verify red**

Run:

```bash
pnpm --filter @stele/cli test -- commands.test.ts
```

Expected: fails because maintenance summary is missing.

- [x] **Step 3: Implement summary**

Use git diff when available; fall back to a no-diff message. Include agent instructions: add new rules through `stele propose invariant --apply`; contract modifications/deletions require explicit user review and lock flow.

- [x] **Step 4: Wire CLI**

Add `stele maintenance-summary [--from <git-ref>] [--output <path>]`.

### Task 5: Plugin Documentation And Skill Guidance

**Files:**
- Modify: `packages/claude-code-plugin/skills/contract-aware-coding/SKILL.md`
- Modify: `packages/claude-code-plugin/commands/explain.md`
- Create: `packages/claude-code-plugin/commands/rules.md`
- Create: `packages/claude-code-plugin/commands/why.md`
- Create: `packages/claude-code-plugin/commands/maintain.md`
- Modify: `docs/plugin-guide.md`
- Modify: `docs/app-integration-guide.md`
- Test: `packages/claude-code-plugin/tests/hooks-config.test.ts` only if plugin command registration changes.

- [x] **Step 1: Update guidance**

Document the new operating model: agents should read `stele agent-context`, use `stele why` for failures, use `stele propose invariant --apply` for additions, and ask the user before modifying/deleting existing contract material.

- [x] **Step 2: Add slash command docs**

Add command docs that wrap `rules`, `why`, and `maintenance-summary`.

### Task 6: Full Verification

**Files:** no new files.

- [x] **Step 1: Run targeted CLI tests**

```bash
pnpm --filter @stele/cli test -- commands.test.ts cli.test.ts
```

- [x] **Step 2: Run full tests**

```bash
pnpm test
```

- [x] **Step 3: Run typecheck and lint**

```bash
pnpm typecheck
pnpm lint
```

- [x] **Step 4: Run packed adoption**

```bash
pnpm test:packed-adoption
```

- [x] **Step 5: Inspect diff**

```bash
git status --short --branch
git diff --stat
```
