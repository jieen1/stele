# Stele TypeScript App Integration

Stele attaches to an existing TypeScript application via `vitest`. Your application owns runtime state through a `stele_context` fixture returned from a setup helper; generated Stele tests read that state directly and never fabricate domain objects.

TypeScript is Stele's **fullest-coverage backend**: in addition to Phase A `invariant` / `scenario` checks, Phase B `trace-policy` / `type-state` / `effect-policy` / `branded-id` / `smart-ctor` evaluators consume TypeScript call graphs, type-state inference, and effect annotations. Python also supports most Phase B forms (see `python-integration.md`); Go, Rust, and Java fail loud on Phase B forms (Round 4 F-A-02).

## Install and adopt

```bash
npm install --save-dev @stele/cli @stele/claude-code-plugin
npx stele init --language typescript
```

After `stele init`, your repository has:

- `stele.config.json` (with `"targetLanguage": "typescript"`, `"testFramework": "vitest"`)
- `contract/main.stele`
- `contract/checker_impls/.gitkeep`
- `tests/contract/_stele_context.ts` (you implement this)

Your project must have `vitest` installed and configured to discover tests under `tests/contract/`.

## Contract layout

```
contract/
  main.stele                  # entry; referenced by stele.config.json
  modules/*.stele             # imported contract modules
  checker_impls/*.ts          # custom checker implementations
  .manifest.json              # protected-file lock
tests/contract/
  test_contract.spec.ts       # generated; do not edit
  _stele_runtime.ts           # generated helper; do not edit
  _stele_context.ts           # user-owned; exports buildSteleContext()
```

`tests/contract/_stele_context.ts` is user-owned and lives alongside generated files.

## The `stele_context` setup helper

Your application returns the contract surface from `buildSteleContext()`:

```ts
// tests/contract/_stele_context.ts
import { loadOrders, loadUsers } from "../../src/repository.js";

export async function buildSteleContext(): Promise<Record<string, unknown>> {
  return {
    user: await loadUsers().then((u) => u[0]),
    orders: await loadOrders(),
    _stele_checkers: {
      "validate-email": validateEmailChecker,
    },
  };
}

function validateEmailChecker(ctx: Record<string, unknown>): boolean {
  const user = ctx.user as { email: string };
  return /^[^@]+@[^@]+$/.test(user.email);
}
```

Generated tests `await buildSteleContext()` in `beforeAll`; contract assertions read whatever you return.

### Optional or empty app data

Return `undefined` for keys whose data your app doesn't yet have — generated tests skip invariants whose `(path …)` resolves to `undefined`. To actively fail, return `null` instead.

### `stele_sandbox`

If your contract uses `(scenario …)` for setup-then-assert flows, also export `buildSteleSandbox()`:

```ts
export async function buildSteleSandbox(): Promise<SandboxAdapter> {
  // Implement the SandboxAdapter interface — see _stele_runtime.ts for the type.
  return { /* ... */ };
}
```

## Generate, run, lock

```bash
npx stele generate          # CDL → tests/contract/*.spec.ts (vitest)
npx vitest run tests/contract
npx stele lock --reason "initial baseline"
npx stele check             # 0 = clean, 2 = drift, 3 = tamper
```

## Phase B

TypeScript has full Phase B evaluator coverage. You can write:

- `(trace-policy …)` — assert call-chain rules via `@stele/trace-evaluator`
- `(type-state …)` — assert phantom-type state machines via `@stele/type-state-evaluator`
- `(effect-policy …)` — declare + propagate effects via `@stele/effect-evaluator`
- `(branded-id …)` + `(smart-ctor …)` — value-object discipline via `@stele/type-driven-evaluator`

Each uses the TypeScript compiler API to walk your `tsconfig.json`-rooted source tree. See `docs/spec/cdl.md` for grammar and `docs/design/phase-b/` for design notes.

Python also supports `trace-policy`, `effect-policy`, `effect-annotation`, `effect-declarations`, `effect-suppression`, `architecture`, and `core-node` (Round 14). The forms that remain TypeScript-only are `type-state`, `type-state-binding`, `branded-id`, and `smart-ctor`.

If you move TypeScript-only contracts (`type-state`, `branded-id`, `smart-ctor`) to a Python, Go, Rust, or Java project, `stele check` will fail loud (Round 4 F-A-02):

```text
[error] type-state not yet supported for targetLanguage="<lang>".
```

If you move `trace-policy` / `effect-policy` / `architecture` contracts to a Go, Rust, or Java project, those also fail loud:

```text
[error] trace-policy not yet supported for targetLanguage="<lang>".
```

This is intentional — Stele refuses to silently no-op a contract.

## Writing contract source

CDL syntax is the same across all backends; only the `(uses-checker …)` implementations are language-specific. See `docs/spec/cdl.md` for the full grammar.

## Checker implementations

Add a custom checker:

```bash
npx stele add-checker validate-email
```

This scaffolds `contract/checker_impls/validate_email.ts` with a typed signature. Wire it into `_stele_context.ts`'s `_stele_checkers` map under the same id you used in CDL.

## Generated tests

Generated `*.spec.ts` files are deterministic and byte-stable. Do not hand-edit — `stele check` will report drift. If a contract change requires regeneration, run `stele generate` and commit the new output.

## Protected files and AI editing

If you use the Claude Code plugin (`@stele/claude-code-plugin`), the paths in your `stele.config.json` `protected` array — `contract/**`, `tests/contract/**`, and any supply-chain shape you add (`pnpm-lock.yaml`, `package.json`, `tsconfig.base.json`, etc.) — are protected from direct agent writes. See `docs/guides/claude-code-plugin.md`.

## Agent rule maintenance

`stele rules --json` lists every loaded invariant with severity, source file, and explanation — feed it to your agent when asking it to add new rules.

## Controlled contract-change flow

```
stele design propose invariant --id NEW_RULE --description "..." --evolvability never
# human review of contract/design/proposals/<id>.yaml
stele design approve --reason "approved per review #123"
stele design generate
```

The `STELE_APPROVED_BY` env (must contain `@` or `:`, no self-attesting tokens like `bot` / `agent` / `dogfood` / `round*`) gates approval in non-TTY contexts.

## CI

```yaml
- name: Verify Stele contracts
  run: |
    npx stele generate
    npx vitest run tests/contract
    npx stele check
```

`stele check` is the non-mutating enforcement step; exit code maps to `ExitCode` enum (0/1/2/3/4/5/6/99).

## Packed adoption caveat

Pre-publish, install via local tarballs:

```bash
npm install --save-dev /path/to/stele-core-0.1.0.tgz /path/to/stele-cli-0.1.0.tgz /path/to/stele-backend-typescript-0.1.0.tgz
```
