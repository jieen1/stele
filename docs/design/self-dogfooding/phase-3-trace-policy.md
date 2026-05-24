# Phase 3 — Trace-Policy Rules for Stele's Own Source

**Goal:** Write 6 `trace-policy` contracts that the existing
`@stele/trace-evaluator` runs against THIS repo's TS call graph.

**Why:** Trace-policy is Stele's flagship Phase B mechanism. The
evaluator + extractor (`tsCallGraphExtractor`) are production-ready.
We've shipped them and never used them on ourselves. This Phase fixes
that.

**Estimated effort:** 3 working days.

**Out of scope:**
- Cross-repo trace policies
- Trace policies on Python source (use Phase 4 effect-policy instead
  if needed; Phase B Python extractor is brand-new and not yet hardened)

## Required dependency

**Phase 0** must be complete (`phaseLanguages.trace = "typescript"`)
so the trace stage actually runs against the TS call graph.

## Scope summary

Write 6 trace-policy contracts. Each one locks down a "must transit"
or "deny direct" relationship that's currently enforced by convention
or by Python checker only.

**Reviewer V-09 reminder:** target NodeIds may be arity-less (the
pattern matcher treats arity-less as wildcard). For Phase 3 the
arity-less form is acceptable unless the source has overloaded methods.
Confirm by reading source for each target before locking the contract
— if two methods named `foo` exist, the contract MUST disambiguate
with arity. See CC-11 in README.md.

## The 6 contracts

### 3.1 — `FS_WRITES_VIA_WRITE_ATOMIC`

```lisp
(trace-policy FS_WRITES_VIA_WRITE_ATOMIC
  (description "Every fs-write call from @stele/core/manifest must transit through writeAtomic.")
  (severity error)
  (target "packages/core/src/manifest/**::*")
  (must-transit "packages/core/src/manifest/hash-manifest.ts::writeAtomic")
  (deny-direct "node:fs/promises::writeFile")
  (scope "packages/core/src/**/*.ts")
  (fix-hint "[A] If your code path needs a non-atomic write, route it through writeAtomic. [B] If the trace policy is too strict, propose loosening it via the design propose flow."))
```

### 3.2 — `CLI_CHECK_VIA_LOAD_CONTRACT`

```lisp
(trace-policy CLI_CHECK_VIA_LOAD_CONTRACT
  (description "stele check must load the contract via loadContract — short-circuiting that loader skips validation.")
  (severity error)
  (target "packages/cli/src/commands/check.ts::runCheck")
  (must-transit "packages/core/src/loader/load-contract.ts::loadContract")
  (scope "packages/cli/src/**/*.ts")
  (fix-hint "[A] If you bypassed loadContract, restore the call. [B] If you need a different loader, add an extern-alias and route through it."))
```

### 3.3 — `GENERATE_VIA_COORDINATOR`

```lisp
(trace-policy GENERATE_VIA_COORDINATOR
  (description "stele generate must call coordinateGeneration — backend generation must not bypass the core coordinator.")
  (severity error)
  (target "packages/cli/src/commands/generate.ts::runGenerate")
  (must-transit "packages/core/src/generator/coordinator.ts::coordinateGeneration")
  (scope "packages/cli/src/**/*.ts")
  (fix-hint "[A] If you bypassed coordinateGeneration, restore the call. [B] If the coordinator is broken, fix it — don't route around it."))
```

### 3.4 — `EVALUATOR_VIA_EXTERN_REGISTRY`

```lisp
(trace-policy EVALUATOR_VIA_EXTERN_REGISTRY
  (description "Phase B evaluators (trace / type-state / effect) must call buildExternAliasRegistry before evaluating — extern aliases are how cross-language target resolution works.")
  (severity error)
  (target "packages/cli/src/commands/check-stages-trace.ts::buildTraceStage")
  (must-transit "packages/call-graph-core/src/extern-alias-registry.ts::buildExternAliasRegistry")
  (scope "packages/cli/src/commands/check-stages-*.ts")
  (fix-hint "[A] Restore the buildExternAliasRegistry call. [B] If you're refactoring extern handling, the trace policy needs to be updated in lockstep."))
```

### 3.5 — `APPROVE_VIA_RESOLVE_APPROVED_BY`

```lisp
(trace-policy APPROVE_VIA_RESOLVE_APPROVED_BY
  (description "runDesignApprove must call resolveApprovedBy before writing any approval record — the human-identity gate is the security model.")
  (severity error)
  (target "packages/cli/src/commands/design/approve.ts::runDesignApprove")
  (must-transit "packages/cli/src/commands/design/approve.ts::resolveApprovedBy")
  (deny-direct "node:fs::writeFileSync")
  (scope "packages/cli/src/**/*.ts")
  (fix-hint "[A] Approve flow MUST gate through resolveApprovedBy. Re-add the call. [B] If you're replacing the identity gate, write a new policy first."))
```

### 3.6 — `BACKEND_LOAD_VIA_REGISTRY`

```lisp
(trace-policy BACKEND_LOAD_VIA_REGISTRY
  (description "Backends must be loaded via @stele/cli/backend-registry::loadBackend — direct dynamic imports of @stele/backend-* skip the supported-backend validation.")
  (severity error)
  (target "packages/cli/src/**::*")
  (deny-direct "@stele/backend-python")
  (deny-direct "@stele/backend-typescript")
  (deny-direct "@stele/backend-go")
  (deny-direct "@stele/backend-rust")
  (deny-direct "@stele/backend-java")
  (scope "packages/cli/src/**/*.ts")
  (exempt "packages/cli/src/backend-registry.ts" (reason "the registry IS the loader"))
  (exempt "packages/cli/src/commands/check-stages-trace.ts" (reason "Phase B extractor is loaded directly"))
  (exempt "packages/cli/src/commands/check-stages-effect.ts" (reason "Phase B extractor is loaded directly"))
  (fix-hint "[A] Route the backend load through loadBackend(language, framework). [B] If you need a new exemption, document the reason here."))
```

## Implementation steps

### Step 3.1 — Pre-flight: extract a CallGraph from the live repo

Before writing any contracts, verify the TS CallGraph extractor
produces sensible output on this repo:

```bash
node -e "
const { tsCallGraphExtractor } = await import('@stele/backend-typescript');
const g = await tsCallGraphExtractor.extract({
  projectRoot: process.cwd(),
  tsconfigPath: 'tsconfig.base.json',
});
console.log('nodes:', g.nodes.length, 'edges:', g.edges.length);
"
```

Expected: hundreds of nodes, hundreds of edges. If the extractor
fails or produces 0 nodes, file the issue and stop Phase 3.

### Step 3.2 — Land contracts in order

Land them one by one (in 6 separate commits). For each:

1. Write the `trace-policy` declaration in `contract/main.stele`
2. Run `stele check`
3. Observe the violations (if any)
4. Fix the source (if source is wrong) OR refine the contract (if
   the target/scope is too broad)
5. Add a paired negative test
6. Re-lock

### Step 3.3 — Add 6 negative tests

Each test injects a regression (e.g., replace `loadContract` call
with raw file read) and asserts the trace policy fails.

Negative tests for trace-policy are HARDER than for code-shape
because they need the call graph to actually be re-extracted. Use
the `_clearCallGraphCacheForTests` helper.

### Step 3.4 — Performance baseline

Trace-policy evaluation on the whole repo may add 5–30 seconds to
`stele check`. Measure before/after:

```
time node packages/cli/dist/index.js check
```

If it adds >30s, file a Phase 7 follow-up for caching / scoping.

### Step 3.5 — Re-lock + verify

```
pnpm build
node packages/cli/dist/index.js generate --force
node packages/cli/dist/index.js lock --reason "Phase 3: 6 trace-policy contracts"
node packages/cli/dist/index.js check     # exit 0, ~66 invariants
```

## Acceptance criteria

- [ ] All 6 trace-policy declarations in `contract/main.stele`
- [ ] All 6 pass against the live repo's call graph
- [ ] 6 paired negative tests
- [ ] `stele check` exit 0
- [ ] No regression in any other test suite
- [ ] Performance baseline recorded in commit message

## Dependencies

- **Phase 0**: required (`phaseLanguages.trace = "typescript"`)
- Phase 1: helpful (RuleId branded types make the policy IDs typed)

## Rollback strategy

Per-policy revert. Each policy is in its own commit.

## Sub-agent execution prompt

```
Read docs/design/self-dogfooding/README.md and
docs/design/self-dogfooding/phase-3-trace-policy.md.

Confirm Phase 0 is complete (`grep phaseLanguages stele.config.json`).

Land policies in order 3.1 → 3.6, one per commit. Run `stele check`
after each. If a policy fails because the target / scope pattern
doesn't match the actual call graph, STOP and ask the main agent —
do not invent a fix.
```
