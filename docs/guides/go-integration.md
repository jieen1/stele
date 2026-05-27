# Stele Go App Integration

Stele attaches to an existing Go application via the standard `testing` package. Your application owns runtime state through a `SteleContext()` helper; generated Stele tests read that state directly and never fabricate domain objects.

> **Phase A only.** Go has the Phase A pipeline (CDL → `_test.go` via `go test`). Phase B forms (`trace-policy`, `type-state`, `effect-policy`) are supported on TypeScript and Python projects only; Go projects fail loud (Round 4 F-A-02). See the bottom of this guide for the workaround.

## Install and adopt

```bash
npm install --save-dev @stele/cli @stele/claude-code-plugin
npx stele init --language go
```

After `stele init`, your repository has:

- `stele.config.json` (with `"targetLanguage": "go"`, `"testFramework": "testing"`)
- `contract/main.stele`
- `contract/checker_impls/.gitkeep`
- `tests/contract/stele_context.go` (you implement this)

Your project must have a `go.mod` at the root that includes `tests/contract/` in its module tree.

## Contract layout

```
contract/
  main.stele                  # entry
  modules/*.stele
  checker_impls/*.go          # custom Go checker functions
  .manifest.json
tests/contract/
  contract_test.go            # generated; do not edit
  stele_runtime.go            # generated helper; do not edit
  stele_context.go            # user-owned; implements func SteleContext()
```

## The `SteleContext()` helper

Your application returns the contract surface from `SteleContext()`:

```go
// tests/contract/stele_context.go
package contract

import (
    "context"
    "myapp/internal/repository"
)

func SteleContext() map[string]any {
    ctx := context.Background()
    users, _ := repository.LoadUsers(ctx)
    orders, _ := repository.LoadOrders(ctx)
    return map[string]any{
        "user":   users[0],
        "orders": orders,
        "_stele_checkers": map[string]any{
            "validate-email": validateEmail,
        },
    }
}

func validateEmail(ctx map[string]any) bool {
    user := ctx["user"].(map[string]any)
    email := user["email"].(string)
    return len(email) > 3 && strings.Contains(email, "@")
}
```

Generated `*_test.go` files invoke `SteleContext()` once per test invocation; contract assertions read whatever map you return.

### Optional or empty app data

Return `nil` for keys your app doesn't have — assertions on `(path …)` resolve to nil and the invariant skips. Use a sentinel value (e.g., an empty struct) if you want the invariant to actively fail.

## Generate, run, lock

```bash
npx stele generate            # CDL → tests/contract/*_test.go
go test ./tests/contract/...
npx stele lock --reason "initial baseline"
npx stele check               # 0 = clean, 2 = drift, 3 = tamper
```

## Custom checkers

Scaffold a checker:

```bash
npx stele add-checker validate-email
```

This creates a stub Go function under `contract/checker_impls/validate_email.go`. The generator includes its source verbatim in the generated test file; wire the function name into `_stele_checkers` in `stele_context.go`.

## Writing contract source

CDL grammar is shared across all backends. See `docs/spec/cdl.md` for the full reference.

## Generated tests

Generated `*_test.go` files are deterministic and byte-stable. Do not hand-edit — `stele check` will report drift.

## Protected files and AI editing

Same as other backends: with the Claude Code plugin enabled, 57 paths are protected from direct agent edits. See `docs/guides/claude-code-plugin.md`.

## CI

```yaml
- name: Verify Stele contracts
  run: |
    npx stele generate
    go test ./tests/contract/...
    npx stele check
```

## Controlled contract-change flow

Identical across languages — see `docs/guides/python-integration.md` § "Controlled contract-change flow".

## Phase B contracts on Go projects (F-A-02 fail-loud)

Stele will refuse to silently no-op `trace-policy` / `type-state` / `effect-policy` declarations on Go projects. TypeScript and Python projects use the Phase B evaluator; Go does not:

```text
[error] trace-policy not yet supported for targetLanguage="go".
        Round 4 F-A-02: failing loud so the contract surface matches the
        enforcement surface.
```

Three workarounds:

1. **Remove the Phase B form** and replace with an `invariant` + Go `checker` that performs the equivalent runtime check.
2. **Wait for the Go Phase B evaluator** (tracked in `docs/strategy/roadmap.md`).
3. **Scope Phase B contracts to a TypeScript or Python subproject** if your repo has one.

## Packed adoption caveat

Pre-publish, install from local tarballs (see `python-integration.md` for the command pattern; swap `@stele/backend-python` for `@stele/backend-go`).
