# Stele Rust App Integration

Stele attaches to an existing Rust application via `cargo test`. Your application owns runtime state through a `stele_context()` helper; generated Stele tests read that state directly and never fabricate domain objects.

> **Phase A only.** Rust has the Phase A pipeline (CDL → `tests/contract/*.rs` via `cargo test`). Phase B forms are TypeScript-only today and fail loud on Rust (Round 4 F-A-02).

## Install and adopt

```bash
npm install --save-dev @stele/cli @stele/claude-code-plugin
npx stele init --language rust
```

After `stele init`:

- `stele.config.json` (with `"targetLanguage": "rust"`, `"testFramework": "cargo-test"`)
- `contract/main.stele`
- `contract/checker_impls/.gitkeep`
- `tests/contract/stele_context.rs` (you implement this)

Your `Cargo.toml` must include `tests/contract/` in its test-discovery path (default `tests/` works).

## Contract layout

```
contract/
  main.stele                  # entry
  modules/*.stele
  checker_impls/*.rs          # custom Rust checker functions
  .manifest.json
tests/contract/
  contract_test.rs            # generated; do not edit
  stele_runtime.rs            # generated helper; do not edit
  stele_context.rs            # user-owned; implements pub fn stele_context()
```

## The `stele_context()` helper

Return a JSON-like value (e.g., `serde_json::Value`) from your application:

```rust
// tests/contract/stele_context.rs
use serde_json::{json, Value};
use myapp::repository;

pub fn stele_context() -> Value {
    let users = repository::load_users().expect("load_users");
    let orders = repository::load_orders().expect("load_orders");
    json!({
        "user": users[0],
        "orders": orders,
        "_stele_checkers": {
            "validate-email": "validate_email"  // function name; runtime looks it up
        }
    })
}

pub fn validate_email(ctx: &Value) -> bool {
    ctx["user"]["email"]
        .as_str()
        .map(|e| e.contains('@'))
        .unwrap_or(false)
}
```

Generated tests call `stele_context()` once per test; contract assertions read the returned `Value`.

### Optional or empty app data

Return `serde_json::Value::Null` for keys your app doesn't have — `(path …)` resolves to Null and the invariant skips. Use `Value::Bool(false)` if you want the invariant to actively fail.

## Generate, run, lock

```bash
npx stele generate            # CDL → tests/contract/*.rs
cargo test --test contract_test
npx stele lock --reason "initial baseline"
npx stele check               # 0 = clean, 2 = drift, 3 = tamper
```

## Custom checkers

```bash
npx stele add-checker validate-email
```

Scaffolds `contract/checker_impls/validate_email.rs`. Register the function name in the `_stele_checkers` map.

## Writing contract source

CDL grammar is shared across all backends. See `docs/spec/cdl.md`.

## Generated tests

Generated `tests/contract/*.rs` is deterministic and byte-stable. Do not hand-edit.

## Protected files and AI editing

Same as other backends — 57 paths protected by `@stele/claude-code-plugin`. See `docs/guides/claude-code-plugin.md`.

## CI

```yaml
- name: Verify Stele contracts
  run: |
    npx stele generate
    cargo test --test contract_test --quiet
    npx stele check
```

## Controlled contract-change flow

See `docs/guides/python-integration.md` § "Controlled contract-change flow".

## Phase B contracts on Rust projects (F-A-02 fail-loud)

`trace-policy` / `type-state` / `effect-policy` / `branded-id` / `smart-ctor` fail loud on Rust:

```text
[error] trace-policy not yet supported for targetLanguage="rust".
```

Workarounds:

1. **Remove the Phase B form** and use an `invariant` + Rust `checker` for the runtime equivalent.
2. **Wait for the Rust Phase B evaluator** (the `branded-id` form is the most natural Rust fit — newtype pattern — and is on the roadmap).
3. **Scope Phase B to a TypeScript subproject.**

## Packed adoption caveat

Pre-publish, install from local tarballs (see `python-integration.md`).
