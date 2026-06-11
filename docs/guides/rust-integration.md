# Stele Rust app integration

Stele attaches to a Rust application via `cargo test`. Your app owns runtime state
through a `stele_context()` function; generated Stele tests read that state and never
fabricate domain objects.

> **Phase A only.** Rust supports the Phase A pipeline (CDL → `tests/contract/*.rs`
> via `cargo test`). The declarative static mechanisms are TypeScript/Python-only and
> **fail loud** on Rust — see [Mechanism support](#mechanism-support-on-rust).

## What you can enforce on Rust today

- ✅ `(invariant … (assert <expr>))` — a predicate over data returned by
  `stele_context()`; becomes a `#[test]`.
- ✅ `(invariant … (uses-checker <id>))` — your own Rust checker function for
  arbitrary structural/code rules (`stele add-checker <id>`).
- ❌ Everything else (`code-shape`, `architecture`, `core-node`, `branded-id`,
  `trace-policy`, `type-state`, `effect-policy`) — not supported for Rust; see below.

## Prerequisites

- **A Rust toolchain** (`cargo`) — to run the generated tests.
- **Node.js + npm** — the `stele` CLI and the Claude Code plugin are Node packages
  (a Rust repo still needs Node for the tooling).

## 1. Install & initialize

```bash
npm install --save-dev @stele/cli @stele/claude-code-plugin   # pre-publish: install from local tarballs
npx stele init --language rust
```

`stele init --language rust` scaffolds **exactly** these files:

```
stele.config.json            # targetLanguage=rust, testFramework=cargo-test, protected[] list
contract/main.stele          # entry contract — ships with 3 EXAMPLE invariants (see step 2)
contract/checker_impls/      # custom Rust checkers go here
Cargo.toml                   # adds dev-deps: serde, serde_json, regex, once_cell
src/lib.rs                   # "// Required by Cargo for compilation."
tests/contract/mod.rs        # placeholder — you implement stele_context() here (step 3)
.gitignore                   # Stele block (manifest, baseline, generated tests)
```

It does **not** create `stele_context.rs`, `.gitkeep`, `contract/modules/`, or touch
`CLAUDE.md`. **Verify:** `ls stele.config.json contract/main.stele Cargo.toml`.

## 2. The example invariants (clean-baseline caveat)

`contract/main.stele` ships with 3 **example** invariants (`account.balance`,
`orders`, `user.status`). They reference data that only exists once you wire
`stele_context()`. So a fresh project is **not green** until you either:

- **(a)** implement `stele_context()` to return that data (step 3), or
- **(b)** delete the examples and start from an empty contract (the contract still
  locks + `stele check` passes with 0 invariants — a valid placeholder baseline).

Pick (b) if you want a clean baseline first and will add real rules later.

## 3. Implement `stele_context()`

Generated tests call a free function `stele_context()` (and merge scenario context
into `stele_assert_context`). Implement it in the scaffolded `tests/contract/mod.rs`
(or any module the test crate compiles). Return a `serde_json::Value`:

```rust
// tests/contract/mod.rs
use serde_json::{json, Value};

pub fn stele_context() -> Value {
    json!({
        "account": { "balance": 100 },
        "orders": [],
        "user": { "status": "active" },
        "_stele_checkers": { "validate-email": "validate_email" } // checker-id -> fn name
    })
}

pub fn validate_email(ctx: &Value) -> bool {
    ctx["user"]["email"].as_str().map(|e| e.contains('@')).unwrap_or(false)
}
```

A `(path …)` that resolves to `Null` makes the invariant **skip**; return
`Value::Bool(false)` to make it actively fail.

## 4. Generate → test → lock → check (with what to verify)

```bash
npx stele generate            # CDL -> tests/contract/_stele_runtime.rs + test_contract.rs
cargo test --test test_contract
npx stele lock --reason "initial baseline"
npx stele check
```

What each step should show:

| Step | Expected | If not |
|---|---|---|
| `generate` | `OK generated N file(s) in tests/contract` — `_stele_runtime.rs` always, plus `test_contract.rs` (and `test_<group>.rs` per group) when there are invariants | a CDL error → fix `contract/main.stele` |
| `cargo test` | the generated `#[test]`s pass | a failing assert → fix **source/context**, not the contract |
| `lock` | `OK manifest locked: contract/.manifest.json (N invariants, M protected files)` | — |
| `check` | `OK … invariants checked; … protected files verified.` and **exit 0** | exit **2** = generated drift (`stele generate` not re-run) · exit **3** = manifest/protected tamper |

`stele check` is the authoritative gate; the Stop hook runs it and fails closed.

## 5. Enable the Claude Code hooks

The npm install above placed the plugin at
`node_modules/@stele/claude-code-plugin`. Register + enable it:

```bash
npx stele plugin install --claude-code   # writes ~/.claude/plugins/installed_plugins.json + settings.json
# then RESTART Claude Code so the plugin loads
```

The Stop hook resolves the `stele` binary from `node_modules/.bin/stele` then
`PATH`, so the npm install just works. **Verify** the protect hook denies a contract
edit (see the simulation + troubleshooting in
[`claude-code-plugin.md`](claude-code-plugin.md), which is the source of truth for
hook setup, behavior, and the `Unable to run "stele check"` fix).

## 6. Document it in CLAUDE.md (keep it lean)

`stele init` does not modify `CLAUDE.md`. Add a **short** Stele block to your
project's `CLAUDE.md` — a one-line description, "do not edit protected paths",
"`stele check` is the authoritative gate", and a link to this guide. **Do not** paste
the protected-path list or workflow into `CLAUDE.md`; keep detail in `docs/` and
reference it (CLAUDE.md is injected into every agent session — keep it small).

## Custom checkers

```bash
npx stele add-checker validate-email   # scaffolds contract/checker_impls/validate_email.rs
```

Register the function name in the `_stele_checkers` map returned by `stele_context()`.

## Mechanism support on Rust

Only `invariant` (`assert` / `uses-checker`) is supported. The rest fail at validation
or check time — by design, so you never get a false sense of protection:

- `code-shape` (class/function/type/file/boundary) — the validator accepts Python
  (and TS); declaring `(lang rust)` is rejected: *"lang … is not supported."*
- `architecture` — TypeScript import-graph based; not Rust.
- `trace-policy` / `type-state` / `effect-policy` / `branded-id` / `smart-ctor` —
  Phase B; on a Rust target the corresponding stage emits a `*_unsupported_language`
  error, e.g. `trace-policy not yet supported for targetLanguage="rust"`. (These CDL
  forms still parse — they are evaluated only for TypeScript/Python targets.)

**Express those rules as `uses-checker` Rust checkers instead** (the `branded-id`
newtype pattern is the most natural Rust fit and is on the roadmap for native support).

## Controlled contract-change flow

See [`python-integration.md`](python-integration.md) § "Controlled contract-change flow".

## CI

```yaml
- name: Verify Stele contracts
  run: |
    npx stele generate
    cargo test --test test_contract --quiet
    npx stele check
```

## Pre-publish caveat

Until `@stele/*` publish to npm, install from local tarballs (see
[`python-integration.md`](python-integration.md)). The protected paths are exactly
those in your `stele.config.json` `protected` array.
