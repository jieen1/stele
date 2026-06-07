# Checker corpus archaeology

**The empirical finding that motivates this document:** Stele's self-contract has
**52 `(invariant)`s, all `(uses-checker)` — zero `(assert)` value-expressions.** The
value-assert DSL (the surface `stele lint` / Z3 analyzes) has *zero* self-dogfooding.

That is **not** "the author avoids the declarative DSL" — Stele uses 71 *structural*
declarative declarations (class-shape, architecture, trace-policy, effect-policy, …)
heavily. It is narrower and more useful: Stele's self-invariants are **meta/structural
assertions** (about its own code, config, registries), a domain the value-assert DSL
(predicates over runtime data paths) was never built for. So structural assertions
escaped into hand-written Python — and many of them are the *same shape* copy-pasted.

This survey classifies all 52 checkers to produce the precise list of what a future
**declarative structural-assertion form** would need to express (the form itself is a
separate, deferred design — this is only the gap list).

## Classification

| Kind | Count |
|---|---|
| **structural-assertion-in-disguise** (a declarative form could express it) | ~38 |
| **genuinely-imperative** (needs arbitrary computation — must stay code) | ~14 |

The canonical disguise case: `backend_contains_python/typescript/go/rust/java` are
five near-identical functions, each `return _check_backend_present("<lang>")` — one
parameterized declaration in disguise.

## The disguise buckets (what a declarative form must express)

| Bucket | ~Count | A declarative form would need |
|---|---|---|
| **forbidden/required-pattern text scan over a glob** | 13 | `(glob\|file) × (forbidden\|required set) × context(any\|code-only\|comment-only\|string-aware) × allowlist`. Needs a built-in **masked source view** (strip comments/strings) + a quote-aware lexer (`cdl_no_single_quotes`). Largest bucket. |
| **registry membership / count** | 7 | parse a TS array-of-objects into a **typed relation**, then `<value> ∈ column(X)` / `count(rows)==N` / `set(column)==literal-set`. Collapses the 5 `backend_contains_*` + `backend_registries`. **The canonical case.** |
| **cross-file consistency / referential integrity** | 6 | project a field across N files, assert all-equal / set-equal / every-reference-resolves (`versions_pinned_together`, `inline_version_sync`). |
| **ast-assertion over extracted blocks/symbols** | 6 | count call-sites; assert each block has required keys; assert a declaration's member shape/count (`operator_count_stable`, `structural_types_stable`). |
| **config value-equals / key-presence / enum-shape** | 4 | assert a JSON/JSONC path equals a literal / contains required keys (`config_schema_valid`, `tsconfig_base_strict_mode`). |
| **file/artifact existence over a derived path set** | 3 | for each registry/list row derive a path and assert it exists (`all_backends_compile` is here only for the *existence* half). |
| **value-expression-shape classification at sites** | 5 | RHS / first-arg must be a smart-ctor call / cast / bare-ident, never a raw literal (the `*_uses_branded_type` family). The TS `type-driven-evaluator` already does this at the type level; these are text defense-in-depth. |

## Must stay imperative (~14)

Three irreducible reasons:

1. **Control-flow / dataflow analysis** — catch-block scoping (`hooks_fail_closed`),
   import-binding resolution + smuggle rejection (`cli_io_through_path_utils`),
   cross-file reachability closure (`strict_mode_default_in_ci`), ordered semantic
   regions (`fix_hint_requires_analysis_branch`).
2. **External state** — git-blob diff (`manifest_version_stable`), symlink/realpath +
   bucket walk (`scratch_never_hashed`), build-artifact existence
   (`all_backends_compile`, `all_evaluators_compile`).
3. **Value-expression-shape** parsing where the type-level evaluator isn't text-aware
   (the 5 branded-id text checks — defense-in-depth on top of `type-driven-evaluator`).

## Implications

- The **value-assert DSL is unvalidated by dogfooding** — `stele lint`/Z3 operate on a
  surface Stele itself never uses. Expressiveness/ergonomics for *users* is unproven.
- ~38 checkers are **analyzability debt**: opaque Python where a declarative,
  statically-analyzable form would do — invisible to lint, to tighten/loosen
  classification, to coverage attribution.
- **Recommended next step (deferred, needs its own design):** a parameterized
  *structural-assertion* CDL form. The two highest-leverage primitives are the
  **registry-relation** bucket (collapses the 5 backend checkers + 2 more into
  parameter rows) and the **masked-source pattern-scan** bucket (13 checkers). A
  **declarative-ratio** health metric (analyzable declarations ÷ total, ratcheted,
  with an allowlist for the ~14 justified imperatives) should land with that form and
  be enforced on Stele itself.
