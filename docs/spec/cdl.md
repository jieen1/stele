# Stele CDL Specification

This document describes the Stele Contract Definition Language (CDL) as implemented by the v0.3 (Phase B) toolchain in this repository. It is intentionally narrow: the source of truth is the shipped parser, validator, manifest logic, evaluators, and Python backend behavior. The `since` markers on individual operators and forms indicate the introducing version (v0.1, v0.2, or v0.3).

## Status and scope

CDL is an s-expression language for declaring invariants, checker-backed rules, scenario setup flows, imports, groups, code-shape constraints, architecture/core-node declarations, type-driven declarations (branded-id, smart-ctor), trace-based policies, type-state machines, and effect declarations / annotations / policies / suppressions. The shipped backend targets are Python + pytest (full coverage), TypeScript + vitest (Phase B evaluator surface), Go, Java, and Rust (test generation only — Phase B call-graph extractors are TypeScript-first; see "Phase B summary" for the deferred extractor work).

The toolchain currently consists of:

- lexical analysis and parsing
- recursive import loading
- structural validation
- uniqueness and reference validation
- static type checking against the built-in operator table
- normalized contract hashing
- manifest verification for protected files
- Python, TypeScript, Go, Java, and Rust test generation
- Phase B evaluators: call-graph cache, trace-based policy, type-state machine, effect system, type-driven (branded-id, smart-ctor)

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

The shipped CDL grammar (v0.3, Phase B) accepts only the following top-level declarations. Forms introduced after v0.1 carry the introducing phase or version in their dedicated section.

- `metadata`
- `import`
- `operator`
- `checker`
- `group`
- `invariant`
- `scenario`
- `boundary`
- `class-shape`
- `function-shape`
- `type-policy`
- `file-policy`
- `architecture`
- `core-node`
- `branded-id`
- `smart-ctor`
- `trace-policy`
- `type-state`
- `type-state-binding`
- `effect-declarations`
- `effect-annotation`
- `effect-policy`
- `effect-suppression`
- `extern-alias`

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
- `tags` — also the **provenance carrier**: `stele incident approve` writes `(tags "provenance:incident")` on every invariant it locks (plus `"teeth:unproven"` when approved without a teeth proof via `--teeth-unavailable-reason`). A convention over the existing `tags` field — no new grammar, operator, or error code. See [the incident-driven contracts guide](../guides/incident-driven-contracts.md).
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

### `architecture`

Form:

```lisp
(architecture "core-arch"
  (lang typescript)
  (module "domain" (path "src/domain/**/*.ts"))
  (module "api" (path "src/api/**/*.ts"))
  (module "infra" (path "src/infra/**/*.ts"))
  (allow "domain" (depends-on "infra"))
  (allow "api" (depends-on "domain"))
  (deny-cycles true))
```

The first item must be an identifier or string literal representing the architecture id. Fields:

- `lang`: exactly one language string or identifier (required). Currently only `typescript` is supported.
- `module`: one or more module declarations (required). Each `(module "id" (path "pattern") (path "pattern2"))` form declares a module with one or more glob patterns.
- `layer`: zero or more layer declarations (optional). Layers define ordering constraints between module groups: `(layer "top" "domain" "api")` means "top" modules may depend on "domain" and "api" modules, but not vice versa.
- `allow`: one or more dependency allowance declarations (required). Each `(allow "from-module" (depends-on "to-module1" "to-module2"))` form declares which modules the "from" module is permitted to import from.
- `deny-cycles`: exactly one boolean (required). When `true`, circular dependencies between modules are violations.

Architecture contracts are evaluated at runtime by `evaluateArchitectureContract()` using the TypeScript compiler API to extract import relationships. They produce `architecture_dependency` and `architecture_cycle` violation kinds.

**Note (v1):** `layer` and `public-entry` declarations are parsed and validated for structural correctness, but are **not enforced at runtime** in v1. They serve as documentation and agent guidance. Layer ordering enforcement and public-entry access rules are planned for v2. See `docs/internal/ddd-typedriven-gap-report.md` (DOC-1) for details.

### `core-node`

Form:

```lisp
(core-node "order-service"
  (lang typescript)
  (role business-core-service)
  (target "src/domain/order/OrderService.ts::OrderService")
  (description "Core order processing service")
  (rationale "Order processing is a business critical path that must remain maintainable")
  (metric sloc (ideal 220) (max 360))
  (metric public-method-count (ideal 8) (max 15))
  (metric max-cyclomatic (ideal 10) (max 20)))
```

The first item must be an identifier or string literal representing the core-node id. Fields:

- `lang`: exactly one language string or identifier (required). Currently only `typescript` is supported.
- `role`: exactly one role string or identifier (required). Currently only `business-core-service` is supported.
- `target`: exactly one target string (required). Format: `path/to/file.ts::ClassName`. The `::` separator divides the file path from the class name.
- `description`: exactly one string or identifier (optional).
- `rationale`: exactly one string or identifier (optional).
- `metric`: one to three metric declarations (at least one required). Each metric specifies a metric name, ideal boundary, and max boundary:
  - `sloc`: Source Lines of Code (excluding comments and blanks)
  - `public-method-count`: number of public methods (including getters/setters, excluding private/protected)
  - `max-cyclomatic`: maximum cyclomatic complexity across all public methods

Metric boundaries must satisfy `ideal <= max`. Metric names must be valid for the declared role.

Complexity violations occur when a metric value exceeds its `max` boundary. Notices are emitted when values exceed `ideal` but remain below `max`. Notices do not cause non-zero exit codes.

## Code-Shape declarations

Code-shape declarations express structural rules over a single named target in source code (currently `(lang python)` only). They are evaluated against the parsed source at the named `target` path. Every code-shape form shares the same header: `(<form> <id> (lang python) (target "<file-or-symbol>") ...)`. The five forms listed below differ only in which `(must-have-*)` / `(deny-*)` fields they accept.

### `boundary`

Form:

```lisp
(boundary "ledger-write-boundary"
  (lang python)
  (target "app/ledger.py::LedgerService")
  (deny-import "app.audit_log" "app.session")
  (deny-call "exec" "eval")
  (allow-target "app.repositories.*"))
```

Fields:

- `lang`: exactly one identifier or string (required). Currently only `python` is supported.
- `target`: exactly one string (required). A dotted symbol path, optionally `path/to/file.py::ClassName`.
- `deny-import`: zero or more import names that the target file must not import.
- `deny-call`: zero or more callee names that the target body must not invoke.
- `allow-target`: zero or more glob patterns scoping which call/import sites the rule applies to.

Code: `E0318`.

### `class-shape`

Form:

```lisp
(class-shape "OrderService"
  (lang python)
  (target "app/order/service.py::OrderService")
  (must-have-field repository "OrderRepository")
  (must-have-field active)
  (must-have-method "place" "cancel")
  (must-extend "ServiceBase"))
```

Fields:

- `must-have-field`: zero or more entries. Each entry is `(must-have-field <name>)` or `(must-have-field <name> "<Type>")`. The name is an identifier or string; the type literal (string) is optional. Note: multiple field requirements use multiple `(must-have-field ...)` forms — each form declares exactly one field.
- `must-have-method`: zero or more method names the class must declare.
- `must-extend`: zero or more base classes the class must extend.

Code: `E0318`.

### `function-shape`

Form:

```lisp
(function-shape "place-order"
  (lang python)
  (target "app/order/service.py::OrderService::place")
  (must-have-call "Repository.save")
  (must-have-decorator "@transactional")
  (must-have-parameter "order"))
```

Fields:

- `must-have-call`: zero or more callee names the function body must contain.
- `must-have-decorator`: zero or more decorator strings the function must carry (`@`-prefix optional).
- `must-have-parameter`: zero or more parameter names the function must declare.

Code: `E0318`.

### `type-policy`

Form:

```lisp
(type-policy "no-any"
  (lang python)
  (target "app/order/**")
  (deny-type "typing.Any" "Any")
  (require-type "OrderId"))
```

Fields:

- `deny-type`: zero or more type names that must not appear as annotations under the target glob.
- `require-type`: zero or more type names that must appear at least once under the target glob.

Code: `E0318`.

### `file-policy`

Form:

```lisp
(file-policy "module-headers"
  (lang python)
  (target "app/**/__init__.py")
  (must-contain "from __future__ import annotations")
  (must-end-with "\n"))
```

Fields:

- `must-contain`: zero or more substring fragments every matching file must contain.
- `must-end-with`: zero or more strings every matching file must end with.

Code: `E0318`.

## Type-Driven declarations

Type-driven declarations (Round 3 P0-7 and on) lock down value-object shape and constructor discipline. They are evaluated by `@stele/type-driven-evaluator`.

### `branded-id`

Form:

```lisp
(branded-id RuleId
  (target "packages/core/src/types/rule-id.ts::RuleId")
  (base-type string)
  (pattern "^[A-Z][A-Z0-9_]*$")
  (entity-scope "Rule"))
```

Fields:

- `target`: exactly one string (required). `path/to/file.ts::TypeName`.
- `base-type`: exactly one string or identifier (required). The primitive base (e.g. `string`, `number`).
- `pattern`: exactly one string (optional). A regex the brand value must match.
- `entity-scope`: exactly one string (optional). The entity the brand belongs to — used by uniqueness checks across branded ids.

Code: `E0327`.

### `smart-ctor`

Form:

```lisp
(smart-ctor RuleId
  (constructor "parseRuleId")
  (deny-raw "true")
  (target "packages/core/src/types/rule-id.ts::RuleId"))
```

Fields:

- `constructor`: exactly one string (required). The name of the validating constructor that callers must use.
- `deny-raw`: `(deny-raw "true")` or `(deny-raw "false")` (optional, default `false`). When `true`, callers must not construct the type via raw `as`-casts or object literals.
- `target`: exactly one string (optional, recommended). Pins the value-object type the constructor governs.

Code: `E0328`.

## Trace-Based Policy

`trace-policy` declarations express call-chain rules over the static call graph. They are part of Phase B and are recognised by the CDL parser today; the runtime evaluator ships in B.1 targeting TypeScript source. See `docs/design/phase-b/02-trace-based-policy.md` for the semantics.

Form:

```lisp
(trace-policy DB_VIA_REPOSITORY
  (description "All OrderService DB access goes through Repository.")
  (severity "error")
  (target "**::OrderService::*")
  (must-transit "**::Repository::*")
  (deny-direct "extern:pg::query(*)")
  (scope "src/**/*.ts")
  (exempt "src/admin/**::*" (reason "admin tooling bypasses repo"))
  (fix-hint "wrap the call in `Repository.findById` — see src/repo.ts:42"))
```

The first item must be an identifier or string literal representing the policy id. Fields:

- `description`: optional, exactly one string literal.
- `severity`: optional string literal, defaults to `"error"`. Allowed values: `"error"` and `"warning"`. Any other value fails with `E0336`.
- `target`: **required**, one or more NodeId patterns identifying the source frames the policy applies to. An empty `(target)` or a missing field fails with `E0332`.
- `must-transit`: every call from `target` to a forbidden sink must transit through at least one matching frame.
- `must-be-preceded-by`: every invocation of `target` must be preceded earlier in the chain by a matching frame.
- `must-be-followed-by`: every invocation of `target` must be followed in the chain by a matching frame.
- `deny-direct`: direct calls from `target` to a matching frame are forbidden.
- `deny-transit`: any call chain rooted at `target` that ever transits a matching frame is forbidden.
- `scope`: optional, one or more glob patterns narrowing which files participate. Default: whole project.
- `exempt`: optional, repeated. Each entry is `(exempt "<pattern>" (reason "<why>"))`. The reason is mandatory (`E0334`).
- `fix-hint`: optional string. To be useful for agents, the hint must contain either a backtick-quoted code snippet (\`Repository.find\`) or a `file:line` reference (`src/repo.ts:42`); vague prose fails with `E0339`.

A policy that declares only a `target` and no constraint clause fails with `E0333` — it would impose no rule on the call graph.

Patterns follow the NodeId pattern grammar from `@stele/call-graph-core` (see `pattern-matcher.ts`). Examples:

```
**::Repository::find(2)             ; exact arity
**::Order::pay(2)#abc12345          ; disambiguator (collision-safe)
extern:stripe::*                    ; extern logical-name match
src/**/*.{ts,py}::*                 ; brace expansion
```

Empty patterns, trailing `::`, or malformed arities such as `(notanumber)` fail with `E0335`.

Example — guard a side-effect with audit logging:

```lisp
(trace-policy AUDIT_AFTER_MUTATION
  (description "Mutating operations must be followed by an audit log write.")
  (target "**::*Service::update(*)" "**::*Service::delete(*)")
  (must-be-followed-by "**::AuditLog::write(*)")
  (fix-hint "call `AuditLog.write` immediately after the mutation"))
```

Error codes:

- `E0330` — trace-policy missing id
- `E0331` — duplicate trace-policy id (raised by uniqueness pass)
- `E0332` — missing or empty `(target ...)`
- `E0333` — no `must-*` or `deny-*` constraints
- `E0334` — exempt entry missing `(reason "...")`
- `E0335` — pattern syntax error (empty, trailing `::`, malformed arity, non-string)
- `E0336` — invalid severity value
- `E0337` — duplicate field (e.g. two `(target ...)`)
- `E0338` — unknown field
- `E0339` — fix-hint not actionable (no code reference, no file:line)

## Type State

`type-state` declarations lock a type's state machine into the contract: which states a value can occupy, how it transitions between them, and which operations are valid in each state. They are part of Phase B and are recognised by the CDL parser today; the runtime evaluator ships in B.1 targeting TypeScript and Python. See `docs/design/phase-b/03-type-state.md` for the semantics.

Form:

```lisp
(type-state ORDER_LIFECYCLE
  (description "Order can only transition: Draft → Submitted → Paid → Shipped, or Cancel/Refund branches.")
  (severity "error")
  (target "src/models/order.ts::Order")

  (states Draft Submitted Paid Shipped Cancelled Refunded)
  (initial Draft)
  (terminal Shipped Cancelled Refunded)

  (transition (from Draft)     (via submit)  (to Submitted))
  (transition (from Submitted) (via pay)     (to Paid))
  (transition (from Submitted) (via cancel)  (to Cancelled))
  (transition (from Paid)      (via ship)    (to Shipped))
  (transition (from Paid)      (via refund)  (to Refunded))

  (allowed-ops Draft addItem removeItem submit)
  (allowed-ops Submitted cancel pay)
  (allowed-ops Paid ship refund)

  (fix-hint "Check the order's current state before invoking `Order.addItem`."))
```

The first item must be an identifier or string literal representing the state machine id. Fields:

- `description`: optional, exactly one string literal.
- `severity`: optional string literal, defaults to `"error"`. Allowed values: `"error"` and `"warning"`.
- `target`: **required**, exactly one string. Either a `path::TypeName` form (TypeScript / Rust phantom-state case, e.g. `"src/models/order.ts::Order"`) or a NodeId glob (Go separate-types case, e.g. `"src/order/**::*Order"`). Empty, whitespace-only, missing `::`, or trailing `::` fails with `E0342`.
- `states`: **required**, one or more state symbols. An empty `(states)` fails with `E0343`.
- `initial`: **required**, exactly one state symbol that must appear in `(states ...)`. Missing or out-of-set fails with `E0344`.
- `terminal`: optional, zero or more state symbols. Each must appear in `(states ...)` (`E0345`). Terminal states must not appear as the source of any transition (`E0348`).
- `state-type-mapping`: optional. Pairs of `<state> "<path>::<TypeName>"` for Go separate-types projects where each state corresponds to a distinct concrete type. The list must have an even number of entries.
- `transition`: optional, repeated. Each transition has exactly one `(from <state> [<state> ...])`, `(via <method>)`, and `(to <state>)`. Multi-source sugar `(from A B)` declares one transition with multiple source states (Round 1 N-4). All `from` / `to` states must appear in `(states ...)` (`E0346`).
- `allowed-ops`: optional, one per state. Each entry is `(allowed-ops <state> <method> [<method> ...])`. The state must appear in `(states ...)` (`E0347`); each state may be declared at most once.
- `fix-hint`: optional string. Same actionability rule as `trace-policy` — must contain a backtick-quoted snippet or a `file:line` reference, or it fails with `E0349`.

Type-state ids must be unique across the project. The target also must be unique — a single type can have only one state machine. Both collisions raise `E0341` in the uniqueness pass.

Error codes:

- `E0340` — type-state missing id
- `E0341` — duplicate type-state id or duplicate target (uniqueness pass)
- `E0342` — missing or malformed target (must be `path::TypeName` or a NodeId glob)
- `E0343` — `(states ...)` is empty
- `E0344` — initial state is not in `(states ...)` or missing
- `E0345` — terminal contains a non-state
- `E0346` — transition.from or transition.to references a non-state
- `E0347` — `(allowed-ops <state> ...)` references a state not in `(states ...)`
- `E0348` — terminal state appears in `(transition (from ...) ...)`
- `E0349` — unknown field, duplicate field, malformed clause, or vague fix-hint

## Type State Binding

`type-state-binding` declarations annotate a function parameter's expected type-state. They give the runtime evaluator cross-function propagation hints (Round 1 MC-2): without explicit binding, type-state inference does not flow across function call boundaries.

Form:

```lisp
(type-state-binding
  (function "src/order/handler.ts::OrderHandler::process(1)")
  (param 0 state Submitted))
```

Fields:

- `function`: **required**, exactly one NodeId string identifying the function whose parameters are being bound. Empty strings fail with `E0349`.
- `param`: **required**, repeated. Each clause has the literal form `(param <index> state <state-name>)`. The index is a non-negative integer; the state is a non-empty identifier or string. Each parameter index may appear at most once per binding (`E0349`).

All malformed `type-state-binding` declarations — unknown fields, missing function, missing param, malformed param clause, duplicate function — raise `E0349`. The form intentionally reuses `E0349` rather than allocating new codes, so the effect-system error range (`E0350-E0359`) stays untouched.

Bindings are project-unique by `function` NodeId: two bindings for the same function NodeId raise `E0349` in the uniqueness pass.

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

CDL v0.2 ships **73 registered operators** (72 user-facing — `filter` is an alias of `where` and produces byte-identical generated code in both backends).

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

## Violation schema

Each violation surfaced by `stele check` carries the following stable fields:

- `rule_id` (string) — fully qualified rule identifier, e.g. `typedriven.branded-id.OrderId`.
- `rule_kind` (string) — high-level rule family.
- `severity` (`error` | `warning` | `info`) — current shipped values; Phase B evaluators may emit additional severities that sort with `info`.
- `source`, `location`, `cause`, `fix`, `fingerprint`, `scope_paths`, `status`, `suppressed_by`, `introduced_in` — see `@stele/core` `Violation` type.

Phase B Round 2 (reviewer E, P0) adds five optional fields used by trace, type-state, and effect evaluators to help agents triage multiple violations. They are all optional and default safely so Phase A baselines remain unchanged:

- `priority` (`blocking` | `major` | `minor`, default `major`) — sort hint for agents processing many violations.
- `group_id` (string, default `""`) — same-root-cause identifier. Typically a function NodeId or file path.
- `also_violates` (string[]) — other `rule_id`s firing on the same root.
- `resolves_with` (string[]) — `rule_id`s whose fix is expected to make this one disappear.
- `cross_rule_note` (string) — human-readable coupling note, e.g. "moving this code will not resolve the trace violations".

Agents should sort violations using `compareViolationsByPriority` (exported from `@stele/core`): priority → group_id → severity → location. The fingerprint deliberately excludes these advisory fields so editorial changes to them do not invalidate baselines.

## Effect System

The effect system declares which side effects (e.g. `db.read`, `http.outgoing`, `payment.charge`) a function performs, and lets a contract restrict which scopes are allowed to acquire those effects through the call graph. The four cooperating top-level forms are parsed today; the runtime evaluator ships in B.1 targeting TypeScript and Python. See `docs/design/phase-b/04-effect-system.md` for the propagation semantics.

Effect names follow lowercase dot-notation: `^[a-z][a-z0-9._-]*$` (e.g. `db.read`, `payment.charge`). Because identifiers in CDL cannot contain `.`, dotted effect names must be written as string literals (`"db.read"`); bare single-segment names (`render`) are accepted as identifiers.

**How a node's effects are determined (soundness model).** A function's effect set is the union of three sources, then propagated transitively up the call graph (a caller acquires every effect of its callees):

1. **Source annotations** — `@stele:effects <names>` in a JSDoc block (`/** ... */`) on the declaration. Only the block form is honored; a `//` line comment is NOT a valid annotation and is surfaced as an `effect.line_comment_annotation_ignored` notice (warning) when it occurs inside a policy's `target-scope`, so a mistaken line comment can never silently stand in for a real declaration.
2. **CDL `(effect-annotation ...)`** — attaches effects to nodes matched by NodeId patterns (contract-side, below).
3. **Inferred effects (B.1, TypeScript)** — the extractor uses the TypeScript type checker to resolve each call / `new` / property access in a function body to its origin and assigns the corresponding effect *without requiring an annotation*: e.g. `node:fs` write APIs → `fs.write`, read APIs → `fs.read`; `node:http`/`node:https`/`node:net`/global `fetch` → `network`; `node:child_process` → `child-process`; `Math.random`/`crypto.randomBytes` → `random`; `Date.now`/`new Date()` → `time`; `process.env` → `env`; other `process.*` → `process`; `node:crypto` `createHash` → `crypto.hash`. Resolution is checker-backed (it requires the call to resolve to the actual builtin/lib origin), so a user method that merely shares a name is not mis-attributed. Inference makes the system **sound for the common case**: an un-annotated forbidden call (e.g. a bare `fetch` in a hook) is caught even though nothing was declared. The closed-world `@stele:effects` override still applies for genuinely-dynamic callees the extractor cannot resolve (see `unresolved_call_blocks_evaluation`). Effect inference for non-TypeScript languages is deferred; an effect-policy in an unsupported language fails loud.

**Effect-name validation.** Every effect name referenced by `(effect-policy ...)`, `(effect-suppression ...)`, and `(effect-annotation ...)` must resolve to a declared effect (exact name declared, or a glob matching ≥1 declared effect); an unknown name fails with `E0350` in the uniqueness pass — a misspelled `(forbid "netork")` no longer silently enforces nothing. A source `@stele:effects` token naming an undeclared effect (inside a policy scope) is reported by the evaluator as `effect.undeclared_effect_name` (error).

### `effect-declarations`

The project-level name table for effects. Each file may declare at most one `(effect-declarations ...)` block; multiple files may contribute disjoint blocks that get merged.

```lisp
(effect-declarations
  (effect "db.read"        (description "Reading from database"))
  (effect "db.write"       (description "Writing to database"))
  (effect "http.outgoing"  (description "Outbound HTTP request"))
  (effect "payment.charge" (description "Calling payment provider for charge")))
```

Fields:

- `(effect <name> [(description "<string>")])`: required, one or more entries. The name must match the dot-notation pattern or it fails with `E0350`. The description, when present, is a single string literal.

Constraints:

- Each file may contain at most one `(effect-declarations ...)` block (`E0351`, raised by the uniqueness pass).
- An effect name may be declared at most once across all files (`E0352`).

Error codes:

- `E0350` — effect name violates lowercase dot-notation
- `E0351` — multiple `(effect-declarations ...)` blocks in the same file
- `E0352` — same effect name declared in more than one block
- `E0353` — `(effect ...)` entry is missing the name
- `E0354` — unknown field inside `(effect-declarations ...)` or `(effect ...)`

### `effect-annotation`

Attaches one or more effects to functions or methods matched by NodeId patterns.

```lisp
(effect-annotation
  (target "extern:typeorm::*" "**/db/raw/**::*")
  (annotates "db.read" "db.write"))
```

Fields:

- `target`: **required**, one or more NodeId patterns. Patterns share the trace-policy `compilePattern` syntax; malformed patterns fail with `E0335`.
- `annotates`: **required**, one or more effect names or globs (e.g. `payment.*`). The parser enforces the dot-notation pattern; the uniqueness pass additionally verifies every name resolves to a declared effect (exact name, or a glob matching ≥1 declared effect), failing with `E0350` otherwise.

Error codes:

- `E0335` — pattern syntax error in `(target ...)`
- `E0355` — missing or empty `(target ...)`
- `E0356` — missing or empty `(annotates ...)`
- `E0359` — unknown field

### `effect-policy`

Restricts which effects functions matched by `target-scope` may acquire. A policy uses **exactly one** of `(forbid ...)` or `(allow-only ...)`.

```lisp
(effect-policy NO_IO_IN_UI
  (description "UI components must be pure render functions.")
  (target-scope "**/views/**" "**/components/**")
  (forbid "db.read" "db.write" "http.outgoing" "payment.charge")
  (fix-hint "Move IO out of UI. Pass pre-fetched data via props — see `useLoaderData`."))

(effect-policy PURE_LIB_ONLY
  (target-scope "**/lib/pure/**")
  (allow-only "time.now")
  (fix-hint "Pure library functions cannot call `db.*` or `http.*`. Inject side-effectful collaborators."))
```

Fields:

- `<ID>`: required, identifier or string literal.
- `description`: optional, single string literal.
- `severity`: optional `"error"` or `"warning"`, defaults to `"error"`. Anything else fails with `E0336`.
- `target-scope`: **required**, one or more NodeId patterns. Pattern syntax errors raise `E0335`.
- `forbid` and `allow-only`: exactly one of the two is required. `(allow-only)` with no entries is legal — it means "no effects allowed in this scope".
- `fix-hint`: optional. Must reference code with backticks or cite a `file:line` location; vague hints fail with `E0339`.

Policy ids must be unique across the project (`E0359` in the uniqueness pass).

Error codes:

- `E0335` — pattern syntax error
- `E0336` — invalid severity
- `E0339` — fix-hint is not actionable
- `E0358` — both `(forbid ...)` and `(allow-only ...)` declared
- `E0359` — unknown field, missing both `forbid` / `allow-only`, or duplicate policy id

### `effect-suppression`

The **only** way to suppress an effect on a specific function. Source-code annotations (`@stele:effects.suppress`) are intentionally ignored — suppression must live in a contract file so an agent cannot bypass the system from inside the codebase. Round 2 D-CG-1 mandates a non-empty `(reason "...")`.

```lisp
(effect-suppression
  (target "src/cache/cached-get.ts::cachedGet(1)")
  (suppresses "db.read")
  (reason "Caching wrapper around getUser. The db.read leakage is intentional for the cache-invalidation path."))
```

Fields:

- `target`: **required**, a single NodeId string identifying the function whose effects are suppressed.
- `suppresses`: **required**, one or more effect names or globs.
- `reason`: **required**, non-empty string literal. Empty or missing reason fails with `E0357`.
- `severity`: optional `"warning"` or `"error"`, defaults to `"warning"`. `--strict-effects` upgrades all suppressions to `"error"` at evaluation time.

Error codes:

- `E0336` — invalid severity
- `E0357` — missing or empty `(reason "...")`
- `E0359` — unknown field, missing target, or missing suppresses

## Fix-hint A/B analysis branch

Stele's default fix-hints force agents to first determine whether a violation reflects a code issue or a contract issue, and only act after deciding.

Every default fix-hint emitted by the trace, type-state, and effect evaluators contains five required substrings: `code issue`, `contract issue`, `propose`, `[A]`, `[B]`. This is enforced by the self-protection invariant `FIX_HINT_REQUIRES_ANALYSIS_BRANCH` declared in `contract/main.stele` and the `fix-hint-requires-analysis-branch` checker.

Agent workflow:

- **`[A]` Code issue** — the rule is correct, the code is wrong: apply the suggested code change.
- **`[B]` Contract issue** — the rule itself is wrong, outdated, or no-longer-applicable: do **not** edit the contract directly. Investigate first (`git log`, `stele why <id>`, `stele explain effect <node>`). Document rationale (research, alternatives, impact). Submit `stele design propose <type> --id <id>` and wait for user approval.

Agents that "auto-fix" by going straight to `[A]` without considering `[B]` miss contract drift. Stele's hook system blocks direct edits to `contract/` files regardless, but the explicit `[A]`/`[B]` prompt aims to prevent the wrong fix from being applied in the wrong direction.

User-authored fix-hints in `(trace-policy ...)`, `(type-state ...)`, and `(effect-policy ...)` are checked only against the actionability rule (must contain backtick-quoted code or a `file:line` reference; otherwise `E0339`). The A/B-branch requirement applies to the **default** hints emitted by the evaluator source, not to author overrides.

### `extern-alias`

Cross-language symbol bridging. A trace, type-state, or effect pattern of the form `extern:<logical-name>::...` is resolved through the contract's extern-alias registry to the per-language package name before being matched against the call graph.

```lisp
(extern-alias stripe
  (description "Stripe SDK — same logical product across all backends")
  (typescript "stripe")
  (python     "stripe")
  (go         "github.com/stripe/stripe-go/v74")
  (java       "com.stripe:stripe-java")
  (rust       "stripe-rust"))
```

Required: the first item is the logical name (identifier or string) and at least one of `(typescript ...)`, `(python ...)`, `(go ...)`, `(java ...)`, `(rust ...)` must be present. Optional: `(description "...")`. Unknown fields fail with `E0361`; missing logical name or malformed shape fails with `E0360`; declaring no language bindings fails with `E0363`. Duplicate logical names across the loaded contract fail with `E0362`.

### Validation errors for extern-alias

| Code | Source | Trigger |
| --- | --- | --- |
| `E0360` | `validator/structure-extern-alias.ts` | Malformed form — missing logical name or non-list field entry |
| `E0361` | `validator/structure-extern-alias.ts` | Unknown field name inside the form |
| `E0362` | `validator/uniqueness.ts` | Duplicate logical name across the loaded contract |
| `E0363` | `validator/structure-extern-alias.ts` | No language bindings declared (at least one required) |
| `E0364` | `validator/structure-extern-alias.ts` | Language field value is not a string literal |

## CLI commands relevant to Phase B

The CLI exposes the following Phase-B-aware commands. All flag and argument shapes shown below are the ones registered today by the `stele` executable; flags not listed here are not part of the v0.3 contract.

### `stele check`

Runs the full pipeline: registry → toolchain → protected → call-graph cache → trace → type-state → effect → type-driven → other. The base command takes no Phase-B-specific CLI flags in v0.3 — the trace, type-state, and effect stages run in their default strict mode (`strictMode = true`). Strict mode routes unresolved-call and inference failures to violations; lenient mode (currently only reachable via programmatic stage options) emits notices instead. The repo's own self-protection invariant `STRICT_MODE_DEFAULT_IN_CI` forbids passing `--lenient-effects`, `--lenient-typestate`, `--lenient-callgraph`, or `--lenient-trace` from `.github/workflows/`.

Existing `check` options: `--diff [ref]`, `--diff-from <base>`, `--format <human|json|sarif>`, `--report-file <path>`, `--lenient` (skip code-shape checks), `--architecture-only`, `--complexity-only`, `--recursive`.

### `stele explain effect <node-id>`

Shows the effect propagation chain and the applicable effect policies for a function or method. Useful when answering "why is `db.read` reported on this function?".

Options:

- `--json` (declared on the parent `explain` command) — emit machine-readable JSON.
- `--no-cache` — force re-extraction of the call graph (skip the on-disk cache).

### `stele design propose <type>`

Add-only design proposal command. The proposed change is written to `contract/design/proposals/<timestamp>-<id>.yaml`, then diffed against the current profile; proposals that introduce non-additive changes (weakening or restructuring) are rejected with exit code 1.

`<type>` is one of:

- `invariant` — propose a new DDD core invariant.
- `branded-id` — propose a new branded-id declaration.
- `aggregate` — propose a new aggregate root.

Required option: `--id <id>`. Optional: `--description <text>`, `--evolvability <value>`, `--type-name <name>`, `--target <path>`.

Phase B trace-policy, type-state, and effect-policy proposals are made by writing a YAML file under `contract/design/proposals/` and having a human approve it through `stele design approve`; direct edits to `contract/**/*.stele` are blocked by the Claude Code plugin hooks.

## Errors and exit codes

### Core error families

- `E0001`-`E0003`: lexical errors
- `E0101`-`E0103`: parser errors
- `E0201`-`E0204`: loader errors
- `E0301`-`E0359`: validation errors (E0330-E0339 are trace-policy specific; E0340-E0349 are type-state / type-state-binding specific; E0350-E0359 are effect-system specific)
- `E0401`-`E0405`: manifest errors
- `E0501`-`E0505`: generator errors
- `E0601`-`E0606`: Python backend errors

All core diagnostics carry a category and, when available, file/line/column span information.

### Phase B validation error codes

The table below lists every validation error code in the Phase B range (E0317-E0359). Messages are quoted verbatim from `packages/core/src/errors/error-codes.ts`; the source column names the validator module that raises the code.

| Code | Source | Description |
| --- | --- | --- |
| `E0317` | `validator/structure-scenario.ts` | Scenario declaration error (unknown/repeated fields, format, missing required clauses) |
| `E0318` | `validator/structure-code-shape.ts` | Code shape declaration error (boundary, class-shape, function-shape, type-policy, file-policy) |
| `E0319` | `validator/structure-invariant.ts` | Structural invariant violation |
| `E0323` | `validator/structure-architecture.ts` | Architecture declaration error (modules, layers, allow-dependency, deny-cycles) |
| `E0324` | `validator/structure-core-node.ts` | Core-node declaration error (target, role, metrics) |
| `E0325` | `validator/uniqueness.ts` | Duplicate architecture id |
| `E0326` | `validator/uniqueness.ts` | Duplicate core-node id |
| `E0327` | `validator/structure-type-driven.ts` | Branded-id declaration error (id, target, base-type, pattern, entity-scope) |
| `E0328` | `validator/structure-type-driven.ts` | Smart-ctor declaration error (id, constructor, deny-raw, target) |
| `E0330` | `validator/structure-trace-policy.ts` | Trace-policy declaration is missing its id |
| `E0331` | `validator/uniqueness.ts` | Duplicate trace-policy id |
| `E0332` | `validator/structure-trace-policy.ts` | Trace-policy is missing the required `(target ...)` field |
| `E0333` | `validator/structure-trace-policy.ts` | Trace-policy must declare at least one must-*/deny-* constraint |
| `E0334` | `validator/structure-trace-policy.ts` | Trace-policy exempt entry is missing `(reason "...")` |
| `E0335` | `validator/structure-trace-policy.ts` | Trace-policy pattern has invalid syntax |
| `E0336` | `validator/structure-trace-policy.ts` | Trace-policy severity must be `"error"` or `"warning"` |
| `E0337` | `validator/structure-trace-policy.ts` | Trace-policy declares the same field twice |
| `E0338` | `validator/structure-trace-policy.ts` | Trace-policy contains an unknown field |
| `E0339` | `validator/structure-trace-policy.ts` | Trace-policy fix-hint must reference code (`...`) or a `file:line` location |
| `E0340` | `validator/structure-type-state.ts` | Type-state declaration is missing its id |
| `E0341` | `validator/uniqueness.ts` | Duplicate type-state id or target (one type can only have one state machine) |
| `E0342` | `validator/structure-type-state.ts` | Type-state missing or malformed target (expected `path::TypeName` or NodeId glob) |
| `E0343` | `validator/structure-type-state.ts` | Type-state declares an empty `(states ...)` field |
| `E0344` | `validator/structure-type-state.ts` | Type-state initial state is not in `(states ...)` |
| `E0345` | `validator/structure-type-state.ts` | Type-state terminal contains a non-state |
| `E0346` | `validator/structure-type-state.ts` | Type-state `transition.from` or `transition.to` references a non-state |
| `E0347` | `validator/structure-type-state.ts` | Type-state `(allowed-ops <state> ...)` references a non-state |
| `E0348` | `validator/structure-type-state.ts` | Type-state terminal state appears in `(transition (from ...) ...)` |
| `E0349` | `validator/structure-type-state.ts` | Type-state or type-state-binding has an unknown/malformed field |
| `E0350` | `validator/structure-effect.ts` | Effect name violates lowercase dot-notation pattern |
| `E0351` | `validator/uniqueness.ts` | Multiple `(effect-declarations ...)` blocks in the same file |
| `E0352` | `validator/structure-effect.ts` | Effect name declared in multiple effect-declarations blocks |
| `E0353` | `validator/structure-effect.ts` | Effect-declarations entry is missing the effect name |
| `E0354` | `validator/structure-effect.ts` | Effect-declarations contains an unknown field |
| `E0355` | `validator/structure-effect.ts` | Effect-annotation is missing the required `(target ...)` field |
| `E0356` | `validator/structure-effect.ts` | Effect-annotation is missing the required `(annotates ...)` field |
| `E0357` | `validator/structure-effect.ts` | Effect-suppression is missing or has an empty `(reason "...")` field |
| `E0358` | `validator/structure-effect.ts` | Effect-policy declares both `(forbid ...)` and `(allow-only ...)` |
| `E0359` | `validator/structure-effect.ts` | Effect-policy/annotation/suppression has an unknown field or missing both forbid/allow-only |

### CLI exit codes

`stele` uses these process exit codes:

- `0`: success
- `1`: general command failure, unsupported lookup, config failure, or uncategorized CLI error
- `2`: generated files do not match the canonical managed output
- `3`: manifest verification failed, protected files drifted, new protected files appeared without a fresh lock, or the current contract hash does not match the manifest
- `4`: generation failed (backend error)
- `5`: configuration error
- `6`: score below threshold (quality gate)
- `99`: internal error

The Claude Code plugin's `Stop` hook blocks completion on any non-zero `stele check` exit.

## Deprecation history

Phase B removes the multi-agent CDL forms (`agent`, `scope`, `inter-agent-contract`, `conflict`). These forms had a parser in v0.2 but no evaluator and were never enforced. The original spec text claimed MCP validate-edit integration; this was inaccurate — `validate-edit` only reads protected file patterns. The forms are removed entirely in v0.3.

## Phase B summary

This is the consolidated index of everything Phase B (v0.3) introduces. It is descriptive — authoritative grammar lives in the sections above.

New top-level forms:

- `trace-policy` — call-chain rules over the static call graph.
- `type-state` — locked state machines for a target type (states, transitions, allowed-ops).
- `type-state-binding` — cross-function parameter state hints for the type-state evaluator.
- `effect-declarations` — project-level effect name table.
- `effect-annotation` — attach effects to functions / methods via NodeId patterns.
- `effect-policy` — restrict which effects may be acquired through a target scope (`forbid` or `allow-only`).
- `effect-suppression` — contract-only suppression of an effect on a specific function, with a mandatory `(reason "...")`.

New validation error codes:

- Trace-policy: `E0330`-`E0339` (10 codes).
- Type-state and type-state-binding: `E0340`-`E0349` (10 codes; binding reuses `E0349`).
- Effect system: `E0350`-`E0359` (10 codes).

New self-protection invariants in `contract/main.stele` (also visible to `stele check` as part of the 31-invariant baseline):

- `ALL_EVALUATORS_COMPILE` — every Phase B evaluator package (`@stele/call-graph-core`, `@stele/trace-evaluator`, `@stele/type-state-evaluator`, `@stele/effect-evaluator`, `@stele/type-driven-evaluator`) must build to `dist/index.js` + `dist/index.d.ts`.
- `STRICT_MODE_DEFAULT_IN_CI` — `.github/workflows/` may not pass `--lenient-effects`, `--lenient-typestate`, `--lenient-callgraph`, or `--lenient-trace`.
- `FIX_HINT_REQUIRES_ANALYSIS_BRANCH` — every default fix-hint emitted by a trace, type-state, or effect evaluator must contain the substrings `code issue`, `contract issue`, `propose`, `[A]`, `[B]`. Round 3 P1-2 strengthened this from a pure keyword check to a structural check that asserts the canonical `[A] Code issue` and `[B] Contract issue` anchors appear in order, the `[B]` branch references the propose flow + `contract/design/proposals/<id>.yaml`, and the trailing `Choose [A] or [B] before acting` decision prompt is present.

  *Naming history.* This invariant is the renamed-and-promoted successor of the pre-0.3 `FIX_HINT_NOT_VAGUE` invariant. The earlier name and its `warning` severity made the check trivially ignorable; v0.3 ships under the explicit `FIX_HINT_REQUIRES_ANALYSIS_BRANCH` name and at `error` severity to communicate that an evaluator without an analysis-branch hint is a self-protection failure, not a style nit.

CLI surface added in Phase B:

- `stele explain effect <node-id>` (with `--json` from the parent `explain` command and a child-level `--no-cache`).
- `stele design propose <type>` with `<type>` in `{invariant, branded-id, aggregate}`; trace-policy, type-state, and effect-policy proposals route through the same YAML-under-`contract/design/proposals/` mechanism.

Out of scope for v0.3 (deferred):

- Call-graph extractors for Go, Java, and Rust. The Phase B evaluators currently consume only the TypeScript extractor; Python is covered by the type-state and effect evaluators but the call-graph extractor is TypeScript-first. Cross-language extractor coverage is tracked under B.3.
- Top-level CLI flags such as `--strict-effects`, `--strict-typestate`, `--strict-trace`, `--strict-callgraph`, or `--trace-max-depth` are not exposed by the `stele check` command in v0.3. Strict mode is the implicit default; lenient mode is reachable only via programmatic stage options and `--lenient-*` flags are forbidden in this repo's CI by `STRICT_MODE_DEFAULT_IN_CI`.
- `stele design propose --trace-policy <id>` / `--type-state <id>` / `--effect-policy <id>` flag shapes are not registered in v0.3. Use the YAML proposal workflow described above.
