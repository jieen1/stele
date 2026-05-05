# Stele CDL Specification

This document describes the Stele Contract Definition Language (CDL) implemented by the v0.1 toolchain in this repository. It is intentionally narrow: the source of truth is the shipped parser, validator, manifest logic, and Python backend behavior.

## Status and scope

CDL v0.1 is an s-expression language for declaring invariants, checker-backed rules, imports, groups, and metadata. The shipped backend target is Python + pytest.

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
- `category`
- `tags`
- `when`
- `tolerance`
- `depends-on`
- `rationale`
- `since`
- `applies-to`

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

### Checker requirements

`uses-checker` must reference a declared checker id; unresolved checker references fail with `E0307`.

In v0.1, checker arguments are preserved in the contract model but the Python backend rejects them during generation. Checker-backed rules must therefore use:

```lisp
(uses-checker checker_id)
```

without additional arguments.

### Dependency requirements

`depends-on` entries must reference known invariant ids. Unknown dependencies fail with `E0308`.

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

#### Data access

- `path(Symbol, ...Symbol) -> Path [value: Unknown]`
- `field(Path, Symbol) -> Path [value: Unknown]`
- `collection(Symbol) -> Collection`
- `value(Unknown) -> Unknown`

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

#### Aggregation and collection transforms

- `sum(Collection, Path?) -> Number`
- `count(Collection) -> Number`
- `avg(Collection, Path?) -> Number`
- `min(Collection, Path?) -> Number`
- `max(Collection, Path?) -> Number`
- `distinct(Collection, Path?) -> Collection`
- `unique(Collection, Path?) -> Boolean`

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

The generated runtime helper implements path traversal, sum helpers, checker invocation, and modified-state comparison. `tests/contract/conftest.py` is application-owned and is allowed to remain alongside the generated files.

## Errors and exit codes

### Core error families

- `E0001`-`E0003`: lexical errors
- `E0101`-`E0102`: parser errors
- `E0201`-`E0203`: loader errors
- `E0301`-`E0314`: validation errors
- `E0401`-`E0404`: manifest errors
- `E0601`-`E0604`: Python backend errors

All core diagnostics carry a category and, when available, file/line/column span information.

### CLI exit codes

`stele` uses these process exit codes:

- `0`: success
- `1`: general command failure, unsupported lookup, config failure, or uncategorized CLI error
- `2`: generated files do not match the canonical managed output
- `3`: manifest verification failed, protected files drifted, new protected files appeared without a fresh lock, or the current contract hash does not match the manifest

The Claude Code plugin's `Stop` hook blocks completion on any non-zero `stele check` exit.
