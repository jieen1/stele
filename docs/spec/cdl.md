# Stele CDL Specification

This document describes the Stele Contract Definition Language (CDL) implemented by the v0.1 toolchain in this repository. It is intentionally narrow: the source of truth is the shipped parser, validator, manifest logic, and Python backend behavior.

## Status and scope

CDL v0.1 is an s-expression language for declaring invariants, checker-backed rules, scenario setup flows, imports, groups, and metadata. The shipped backend target is Python + pytest.

The toolchain currently consists of:

- lexical analysis and parsing
- recursive import loading
- structural validation
- uniqueness and reference validation
- static type checking against the built-in operator table
- normalized contract hashing
- manifest verification for protected files
- Python pytest generation

## Lexical grammar

Comments begin with `;` and continue to the end of the line.

Whitespace outside strings is insignificant.

Atoms:

- identifiers: start with `A-Z`, `a-z`, or `_`; continue with letters, digits, `_`, or `-`
- keywords: `:` followed by an identifier body
- strings: double-quoted only
- numbers: integer, decimal, or exponent form such as `0`, `-42`, `3.14`, `1e-9`, `-2.5E+3`

Supported string escapes:

- `\\n`
- `\\t`
- `\\r`
- `\\\\`
- `\\\"`

Single-quoted strings are invalid. Strings may not span lines.

## Concrete grammar

The parser accepts nested lists whose head must be an identifier.

```ebnf
file        = { form } ;
form        = atom | list ;
list        = "(" identifier { form } ")" ;
atom        = identifier | keyword | string | number ;
identifier  = letter_or_underscore , { letter | digit | "_" | "-" } ;
keyword     = ":" , identifier ;
string      = '"' , { character | escape } , '"' ;
number      = [ "-" ] , digits , [ "." , digits ] , [ exponent ] ;
```

Empty lists are invalid because every list head must be an identifier.

## Top-level declarations

Only these top-level declarations are valid in v0.1:

- `metadata`
- `import`
- `operator`
- `checker`
- `group`
- `invariant`
- `scenario`
- `agent`
- `scope`
- `inter-agent-contract`
- `conflict`

Any other top-level declaration fails validation with `E0301`.

### `metadata`

Form:

```lisp
(metadata
  (stele-version "0.1")
  (project "ledger")
  (target-language python))
```

`metadata` may appear at most once per file. The current implementation preserves the nested fields as AST nodes but does not impose a schema beyond the outer declaration shape. `stele-version`, `project`, and `target-language` are conventional fields used by examples and docs, not validator-enforced field names.

### `import`

Form:

```lisp
(import "./modules/account.stele")
```

Requirements:

- exactly one argument
- the argument must be a string literal
- the path is resolved relative to the importing file
- circular imports fail with `E0203`

### `operator`

Form:

```lisp
(operator project_op ...)
```

The first item must be an identifier. In v0.1, top-level operator declarations are parsed and deduplicated, but they do not extend the executable operator registry. The static type checker still only knows the built-in operator table described later in this document.

### `checker`

Form:

```lisp
(checker balance-change-has-transaction
  (description "Validate that a balance delta is backed by a transaction entry."))
```

The first item must be an identifier. Checker ids must be unique across the loaded contract graph.

CDL identifiers may contain hyphens after the first character, so hyphenated checker ids such as `balance-change-has-transaction` are valid. When `stele add-checker` scaffolds a Python implementation, it keeps the CDL id unchanged in the emitted declaration and writes the Python file with hyphens normalized to underscores, for example `balance_change_has_transaction.py`.

### `group`

Form:

```lisp
(group account-rules
  (description "Optional group description")
  (invariant ...)
  (invariant ...))
```

Rules:

- the first item must be an identifier
- groups may contain at most one `(description "...")`
- groups may contain only `description` and nested `invariant` forms
- group ids must be unique across the loaded contract graph

Groups affect generated file layout: each group generates its own pytest module.

### `invariant`

Form:

```lisp
(invariant ACCOUNT_IS_ACTIVE
  (severity high)
  (description "The account admitted to the contract remains active.")
  (assert (eq (path account status) "active")))
```

The first item must be an identifier. Invariant ids must be unique across top-level and grouped invariants, including imported files.

## Invariant fields

Allowed fields:

- `severity`
- `description`
- `assert`
- `uses-checker`
- `uses-scenario`
- `category`
- `tags`
- `when`
- `tolerance`
- `depends-on`
- `rationale`
- `since`
- `applies-to`
- `explain`

Unknown or repeated fields fail with `E0305`.

### Required fields

Every invariant must include:

- exactly one `severity`
- exactly one `description`
- exactly one executable body, which means either `assert` or `uses-checker`, but not both

### Field requirements

- `severity`: exactly one identifier or string
- `description`: exactly one string
- `assert`: exactly one expression
- `uses-checker`: checker id as the first argument, followed by zero or more raw AST arguments
- `category`: exactly one value node
- `tags`: one or more value nodes
- `when`: exactly one expression
- `tolerance`: exactly one value node
- `depends-on`: zero or more invariant ids as identifiers
- `rationale`: exactly one value node
- `since`: exactly one value node
- `applies-to`: exactly one value node
- `explain`: exactly one value node (string preferred)

### Checker requirements

`uses-checker` must reference a declared checker id; unresolved checker references fail with `E0307`.

In v0.1, checker arguments are preserved in the contract model but the Python backend rejects them during generation. Checker-backed rules must therefore use:

```lisp
(uses-checker checker_id)
```

without additional arguments.

### Dependency requirements

`depends-on` entries must reference known invariant ids. Unknown dependencies fail with `E0308`.

### Scenario requirements

`uses-scenario` must reference a declared scenario id. Unknown scenario references fail with `E0316`.

### Explain operator

`(explain "...")` attaches a human-readable explanation to an invariant. It is consumed by `stele explain` CLI output, SARIF reports, and MCP explain tools.

```lisp
(invariant USER_EMAIL_MUST_BE_VALID
  (severity error)
  (description "User email must match service pattern.")
  (explain "Email format check ensures only valid service emails enter the system.")
  (assert (matches (path user email) "[a-z]+@[a-z]+\\.com")))
```

The `(explain)` field is optional. When present:

- `stele explain INVARIANT_ID` shows the explanation as the "why" line in the trace output
- SARIF output includes the explanation in the result description
- The expression trace engine uses it to annotate sub-expression failures

The `(explain)` value must be a string literal or identifier. The explanation text is used as-is — no interpolation or templating is performed.

### `scenario`

Form:

```lisp
(scenario fund-pnl-flow
  (sandbox transactional)
  (executor python-import)
  (step setup-fund
    (call "tests.contract_scenarios:create_fund"
      (body (object (name (gen unique-name "fund")))))
    (capture fund))
  (capture-state pnl
    (call "tests.contract_scenarios:get_pnl"
      (body (object (fund-id (ref fund id)))))))
```

Rules in the current Python vertical slice:

- the first item must be an identifier
- `sandbox` is required and only `transactional` is accepted
- `executor` is required and only `python-import` is accepted
- at least one `step` or `capture-state` form is required
- scenario ids must be unique across the loaded contract graph

`step` forms may contain one `call` and an optional `capture`. `capture-state` forms must start with the capture id and contain exactly one `call`.

`python-import` call targets must use `module:function` text. The generated runtime imports that module, calls `function(body, stele_context)`, and stores any captured return values in scenario context before the invariant assertion runs.

Supported scenario body expressions in v0.1:

- `(object (key expr) ...)`
- `(ref capture field...)`
- `(gen unique-name "prefix")`

The lexer does not support `$`-prefixed interpolation syntax in v0.1, so scenario references are always explicit forms such as `(ref fund id)`.

## Agent declarations

Agent declarations define identities, permissions, and conflict resolution for multi-agent systems.

### `agent`

Form:

```lisp
(agent "code-reviewer"
  (description "Reviews code changes for quality and compliance.")
  (allowed-paths "src/**" "tests/**")
  (denied-paths "contract/**" "config/**"))
```

The first item must be an identifier or string literal. Fields:

- `description`: exactly one string or identifier (optional)
- `allowed-paths`: zero or more string literals (optional)
- `denied-paths`: zero or more string literals (optional)

Agent identity is determined by the first item. Duplicate `description` fields fail with `E0317`.

### `scope`

Form:

```lisp
(scope "code-reviewer"
  (path "src/lib/**")
  (path "tests/lib/**"))
```

The first item must be an identifier or string literal representing the agent id. Each `(path "...")` form declares a path pattern owned by that agent. At least one path is required.

### `inter-agent-contract`

Form:

```lisp
(inter-agent-contract "review-before-merge"
  (description "All feature-writer changes must be reviewed.")
  (agents "code-reviewer" "feature-writer")
  (requires "feature-writer" (path "src/**") (approved-by "code-reviewer")))
```

The first item must be an identifier or string literal. Fields:

- `description`: exactly one string or identifier (optional)
- `agents`: one or more agent id string literals (required)
- `requires`: one or more requirement clauses (required)

Each `(requires ...)` clause has the form:

```lisp
(requires "agent-id" (path "pattern") (approved-by "approver-id"))
```

### `conflict`

Form:

```lisp
(conflict (path "src/core/engine.ts")
  (agents "feature-writer" "perf-optimizer")
  (resolution "last-writer-wins")
  (fallback "manual-review"))
```

The first item must be a `(path "...")` form. Fields:

- `path`: exactly one string literal (required, first position)
- `agents`: zero or more agent id string literals (optional)
- `resolution`: exactly one strategy (required)
- `fallback`: exactly one strategy (optional)

Valid resolution strategies: `last-writer-wins`, `manual-review`, `merge-strategy`, `contract-gated`.

Agent declarations are consumed by the MCP server's `stele-validate-edit` tool and the agent policy evaluation engine. They do not affect invariant verification or test generation in v0.1.

## Expressions and operator semantics

Expressions are either atoms or operator lists.

### Value model

- numbers are `Number`
- strings are `String`
- unbound identifiers are `Symbol`
- bound quantifier identifiers behave like symbols with an unknown runtime value
- `path` produces a structural `Path` whose runtime value type is `Unknown`
- `collection` produces `Collection`

Because `path` has `Unknown` value type, it is valid in value slots such as `eq`, `gt`, or `add`, but it is not valid where a real collection or path structure is required unless the operator expects a `Path`.

### Core operators

<!-- BEGIN_CORE_OPERATORS -->

CDL v0.2 ships **70 registered operators** (69 user-facing — `filter` is an alias of `where` and produces byte-identical generated code in both backends).

The next subsections are partitioned by category. Each entry uses the format `name(param: Type, ...) -> ReturnType` and notes the introducing version (`since`) for operators added after v0.1.

#### Data access

- `path(Symbol, ...Symbol) -> Path [value: Unknown]`
- `field(Path, Symbol) -> Path [value: Unknown]`
- `collection(Symbol) -> Collection`
- `value(Unknown) -> Unknown`
- `type-of(Unknown) -> String` (since 0.2)
  - Returns one of `"number"`, `"string"`, `"boolean"`, `"collection"`, `"object"`, `"null"`, or `"undefined"`.
  - Cross-backend semantics: identical. Python collapses `undefined` into `"null"` because Python only has `None`; TypeScript distinguishes the two but both backends agree on the same seven-tag set otherwise.

#### Equality and comparison

- `eq(Unknown, Unknown) -> Boolean`
- `neq(Unknown, Unknown) -> Boolean`
- `gt(Number, Number) -> Boolean`
- `gte(Number, Number) -> Boolean`
- `lt(Number, Number) -> Boolean`
- `lte(Number, Number) -> Boolean`
- `in(Unknown, Collection) -> Boolean`
- `matches(String, String) -> Boolean`
- `exists-in(Unknown, Collection) -> Boolean`
- `not-null(Path) -> Boolean`

`eq` and `neq` reject only statically provable mismatches. Comparing a `Number` to a `String` fails, but comparing a known type to an unknown path value is allowed.

#### Arithmetic

- `add(Number, Number, ...Number) -> Number`
- `sub(Number, Number) -> Number`
- `mul(Number, Number, ...Number) -> Number`
- `div(Number, Number) -> Number`
- `neg(Number) -> Number`
- `abs(Number) -> Number`
- `mod(Number, Number) -> Number` (since 0.2)
  - Sign-of-divisor (Python) semantics: `mod(-7, 3) = 2`, `mod(7, -3) = -2`.
  - Divisor of zero raises `SteleRuntimeError`.
  - Cross-backend semantics: identical. The TypeScript backend wraps JS `%` (sign-of-dividend) so both backends produce sign-of-divisor results.
- `pow(Number, Number) -> Number` (since 0.2)
  - IEEE-754 double power, equivalent to `Math.pow`.
  - Negative base with non-integer exponent yields `NaN` (no exception).
  - Cross-backend semantics: identical.
- `round(Number, Number?) -> Number` (since 0.2)
  - Banker's rounding (half to even). `round(0.5) = 0`, `round(1.5) = 2`, `round(2.5) = 2`, `round(3.5) = 4`, `round(-0.5) = 0`.
  - Optional second argument is the number of fractional digits, defaulting to `0`. The digits argument must be an integer-valued number; non-integer digits raise `SteleRuntimeError`.
  - `NaN` and `±Infinity` propagate without error.
  - Cross-backend semantics: identical. Python 3's built-in `round` is already banker's; the TypeScript backend wraps `Math.round` (half-away-from-zero) to break ties to even.
- `ceil(Number) -> Number` (since 0.2)
  - Round toward `+∞`. `NaN` propagates.
  - Cross-backend semantics: identical.
- `floor(Number) -> Number` (since 0.2)
  - Round toward `-∞`. `NaN` propagates.
  - Cross-backend semantics: identical.

#### Aggregation and collection transforms

- `sum(Collection, Path?) -> Number`
- `count(Collection) -> Number`
- `avg(Collection, Path?) -> Number`
- `min(Collection, Path?) -> Number`
- `max(Collection, Path?) -> Number`
- `distinct(Collection, Path?) -> Collection`
- `where(Symbol, Collection, Predicate) -> Collection`
- `unique(Collection, Path?) -> Boolean`
- `length(Collection) -> Number` (since 0.2)
  - Returns the number of elements; empty collection returns `0`. Non-collection input raises `SteleRuntimeError`.
  - Cross-backend semantics: identical (Python `len()`, TypeScript `Array.length`).
- `concat(Collection, ...Collection) -> Collection` (since 0.2)
  - Variadic flat concatenation of one or more collections; preserves duplicates and original element order. Element types are not coerced (e.g. concatenating numbers and strings yields a mixed-type collection).
  - Cross-backend semantics: identical.
- `sort-by(Collection, Path) -> Collection` (since 0.2)
  - Stable ascending sort projected by a path. Numbers compare via `<`; strings compare lexicographically by raw byte/codepoint order (locale-independent). `NaN` sorts to the front; `null`/`undefined` sort to the end.
  - Cross-backend semantics: identical.
- `sort-by-desc(Collection, Path) -> Collection` (since 0.2)
  - Stable descending counterpart of `sort-by`. `NaN` still sorts to the front and `null`/`undefined` still sort to the end (the descending order applies to the comparable middle tier only).
  - Cross-backend semantics: identical.
- `map(Collection, Path) -> Collection` (since 0.2)
  - Project each item by a path; elements where the path is missing are skipped silently (different from `forall`/`exists`/`none`, which surface path errors).
  - Cross-backend semantics: identical.
- `first(Collection) -> Unknown` (since 0.2)
  - Returns the first element. Empty collection raises `SteleRuntimeError` (does not return `null`/`undefined`).
  - Cross-backend semantics: identical.
- `last(Collection) -> Unknown` (since 0.2)
  - Returns the last element. Empty collection raises `SteleRuntimeError`.
  - Cross-backend semantics: identical.
- `filter(Symbol, Collection, Predicate) -> Collection` (since 0.2)
  - Strict alias of `where`. Translators lower `(filter ...)` to the same generated form as `(where ...)`, so conformance fixtures see byte-identical output between the two operator names.
  - Cross-backend semantics: identical.

#### Quantifiers

- `forall(Symbol, Collection, Predicate) -> Boolean`
- `exists(Symbol, Collection, Predicate) -> Boolean`
- `none(Symbol, Collection, Predicate) -> Boolean`

The first argument must be an identifier. The second argument must type-check as `Collection`. The bound identifier is only in scope inside the predicate body.

Use `(collection name)` for the collection operand. A data path is a scalar/value path, not a collection reference, so this is invalid:

```lisp
; Invalid: (path positions) is a Path, not a Collection.
(forall p (path positions)
  (gt (path p market-value) 0))
```

Write it like this instead:

```lisp
; Valid: positions is read from stele_context["positions"].
(forall p (collection positions)
  (gt (path p market-value) 0))
```

Inside the predicate, the bound variable becomes the root for item fields. In the example above, `(path p market-value)` reads `p["market-value"]` or `p.market_value` for each item in `positions`.

#### Filtered collections

`where` binds an item name, evaluates a predicate for each item in a collection, and returns the matching items as a collection:

```lisp
(where txn (collection transactions)
  (eq (path txn budget-id) (path budget id)))
```

The bound item is only available inside the `where` predicate. Outer bindings remain visible, so `where` can express common cross-table constraints without precomputing booleans in `conftest.py`:

```lisp
(forall budget (collection budgets)
  (lte
    (sum
      (where txn (collection transactions)
        (eq (path txn budget-id) (path budget id)))
      (path amount))
    (path budget limit)))
```

The filtered collection can be used anywhere a `Collection` is expected by the core type checker. The Python backend currently supports it in `sum`, `avg`, `min`, `max`, `count`, and nested quantifiers.

`filter` is a strict alias of `where` introduced in v0.2; the translator lowers it to the same generated form, so the two operators produce byte-identical backend output.

#### String operators

- `matches(String, String) -> Boolean`
- `contains(String, String) -> Boolean`
- `starts-with(String, String) -> Boolean`
- `ends-with(String, String) -> Boolean`
- `trim(String) -> String` (since 0.2)
  - Strips leading and trailing Unicode whitespace (parity with JS `String.prototype.trim()`).
  - Cross-backend semantics: identical.
- `lower(String) -> String` (since 0.2)
  - Locale-independent Unicode lowercase. Both backends use the locale-free variant (`String.toLowerCase` in TypeScript, `str.lower` in Python).
  - Cross-backend semantics: identical.
- `upper(String) -> String` (since 0.2)
  - Locale-independent Unicode uppercase counterpart of `lower`.
  - Cross-backend semantics: identical.
- `split(String, String) -> Collection<String>` (since 0.2)
  - Splits the input by the literal separator string. The separator is matched verbatim (no regex parsing).
  - Empty separator raises `SteleRuntimeError` in both backends.
  - Cross-backend semantics: identical.
- `join(Collection<String>, String) -> String` (since 0.2)
  - Joins a collection of strings with a separator. Elements that are not strings raise `SteleRuntimeError` at runtime; the validator additionally recognizes `join` so its argument count and argument structural types are enforced statically.
  - Cross-backend semantics: identical.

#### Boolean and control-flow operators

- `and(Predicate, ...Predicate) -> Boolean`
- `or(Predicate, ...Predicate) -> Boolean`
- `not(Predicate) -> Boolean`
- `implies(Boolean, Boolean) -> Boolean`
- `iff(Boolean, Boolean) -> Boolean`
- `when(Boolean, Predicate) -> Boolean`
- `if(Boolean, Unknown, Unknown) -> Unknown`

`assert` and invariant-level `when` expressions must both type-check as predicates.

#### Temporal and state operators

- `within(Unknown, TimeRange) -> Boolean`
- `after(Unknown, Unknown) -> Boolean`
- `before(Unknown, Unknown) -> Boolean`
- `modified(Path) -> Boolean`
- `state-before() -> Unknown`
- `state-after() -> Unknown`

The Python backend specifically implements `modified` against `stele_context["state-before"]` and `stele_context["state-after"]`.

#### Cross-backend semantics summary (EP04 batch 1)

The following table calls out the new operators introduced in v0.2 and the cross-backend implementation notes that keep their behavior byte-equal:

| Operator | Cross-backend implementation note |
|---|---|
| `length` | Python `len(coll)`; TypeScript `Array.length`. Non-collection raises `SteleRuntimeError` in both. |
| `concat` | Variadic flat concatenation; preserves duplicates and order. |
| `sort-by` / `sort-by-desc` | Stable sort. NaN sorts to the front, null/undefined to the end, comparable values in the middle. Strings compare via raw codepoint/byte order (no locale). |
| `mod` | Sign-of-divisor (Python). The TypeScript backend wraps JS `%` (sign-of-dividend) to match. |
| `pow` | IEEE-754 `Math.pow`. Negative base + non-integer exponent yields `NaN` (no exception). |
| `round` | Banker's rounding. Python 3's built-in `round` is already banker's; the TypeScript backend wraps `Math.round` (half-away-from-zero) to break ties to even. |
| `ceil` / `floor` | Standard rounding directions; `NaN` propagates without raising. |
| `trim` | Unicode whitespace; parity with JS `String.prototype.trim()`. Python uses `re.sub(r"^\\s+|\\s+$", "", s, flags=re.UNICODE)` for parity. |
| `lower` / `upper` | Locale-independent Unicode case mapping (`str.lower` / `String.toLowerCase`, never the locale-aware variants). |
| `split` | Empty separator raises `SteleRuntimeError`. Separator matched as a literal (no regex). |
| `join` | Mixed-type collection raises `SteleRuntimeError` (per-element check); validator enforces the structural argument types statically. |
| `type-of` | Returns one of `"number"`, `"string"`, `"boolean"`, `"collection"`, `"object"`, `"null"`, `"undefined"`. Python collapses `undefined` into `"null"` because Python only has `None`. |
| `map` | Path-not-found elements skipped silently (different from `forall`/`exists`/`none`). |
| `first` / `last` | Empty collection raises `SteleRuntimeError` (does not return null/undefined). |
| `filter` | Strict alias of `where`; produces byte-identical generated code in both backends. |

<!-- END_CORE_OPERATORS -->

## Static type checking

The type checker validates every `assert` and invariant-level `when` expression.

### Structural types

The built-in structural types are:

- `Number`
- `String`
- `Boolean`
- `Path`
- `Collection`
- `Predicate`
- `TimeRange`
- `Symbol`
- `Unknown`

### `Unknown` semantics

`Unknown` is deliberately permissive in value positions:

- any operator argument declared as `Unknown` accepts any expression
- value-slot operators such as `eq`, `gt`, or `if` accept expressions whose runtime value type is unknown
- `Unknown` does not satisfy structural-only slots such as `Collection`, `Path`, `Symbol`, or `TimeRange`

This is why a path expression can be used in `(gt (path account total) 0)` but a path expression cannot be used as the collection operand of `forall`.

### Predicate compatibility

`Boolean` and `Predicate` are treated as compatible for assertion and logical purposes. A provable mismatch, such as passing a `String` where a predicate is required, fails with `E0310`.

### Unknown operators

Expressions may only use the built-in operator table. A call to an unknown operator fails with `E0311`, even if a top-level `(operator ...)` declaration exists elsewhere in the contract.

## Imports and groups

Contract loading is recursive. The loader reads the configured entry file, resolves imports depth-first, and validates the combined contract graph.

Important invariants:

- imports are relative to the importing file
- cycles are rejected
- uniqueness checks are global across the loaded graph
- grouped invariants share the same global id namespace as top-level invariants

## Manifest behavior

Stele records approved protected state in `contract/.manifest.json`.

Manifest fields:

- `version`
- `generated_at`
- `stele_version`
- `protected_files`
- `contract_hash`

Behavior:

- `contract_hash` is computed from the normalized contract, not raw file text
- semantically equivalent contracts with different field order normalize to the same hash
- `generated_at` is intentionally not part of the hash
- protected files are recorded by SHA-256 and byte size
- manifest paths are stored as POSIX-style project-relative paths from the manifest base directory

Manifest verification fails when:

- the manifest is missing or unreadable
- the JSON is invalid
- the shape is invalid
- a protected file is missing
- a protected file changed
- the manifest contains an invalid protected path

## Generated tests

For the Python backend, Stele manages these files:

- `tests/contract/__init__.py`
- `tests/contract/_stele_runtime.py`
- `tests/contract/test_contract.py` for top-level invariants, when any exist
- `tests/contract/test_<sanitized-group-id>.py` for each group

The generated runtime helper implements path traversal, sum helpers, checker invocation, modified-state comparison, and scenario execution helpers. `tests/contract/conftest.py` is application-owned and is allowed to remain alongside the generated files.

## Errors and exit codes

### Core error families

- `E0001`-`E0003`: lexical errors
- `E0101`-`E0102`: parser errors
- `E0201`-`E0203`: loader errors
- `E0301`-`E0317`: validation errors
- `E0401`-`E0404`: manifest errors
- `E0601`-`E0606`: Python backend errors

All core diagnostics carry a category and, when available, file/line/column span information.

### CLI exit codes

`stele` uses these process exit codes:

- `0`: success
- `1`: general command failure, unsupported lookup, config failure, or uncategorized CLI error
- `2`: generated files do not match the canonical managed output
- `3`: manifest verification failed, protected files drifted, new protected files appeared without a fresh lock, or the current contract hash does not match the manifest

The Claude Code plugin's `Stop` hook blocks completion on any non-zero `stele check` exit.
