# Architecture

A concise tour of how Stele is built. For the full design blueprint, see [`design/项目设计文档.md`](design/项目设计文档.md). For the language reference, see [`spec/cdl.md`](spec/cdl.md).

## The three layers of protection

Stele's premise is that AI agents cannot be trusted to honor contracts by reading and remembering — only by structural enforcement. Three layers stack:

1. **Contracts in CDL** — business invariants are declared in `.stele` files. The files live at protected paths the agent physically cannot edit.
2. **Generated tests** — CDL is translated into pytest source. The generated tests are protected too. Every code change must pass them.
3. **Editor hooks** — the Claude Code plugin's `PreToolUse` hook denies direct writes/edits/bash to protected paths; the `Stop` hook runs `stele check` and pytest before the agent finishes.

Remove any layer and the property breaks: layer 1 alone is documentation, layer 1+2 alone is bypassable by an "improvement" to the tests, layer 1+2+3 together is what the user actually relies on.

## The four-layer codebase

```
┌──────────────────────────────────────────────────────────────┐
│ Layer 4 — IDE adapters                                       │
│   packages/claude-code-plugin                                │
│     hooks · commands · subagents · skills                    │
└──────────────────────────────────────────────────────────────┘
                           │
┌──────────────────────────────────────────────────────────────┐
│ Layer 3 — CLI                                                │
│   packages/cli                                               │
│     init · generate · check · lock · baseline · …            │
└──────────────────────────────────────────────────────────────┘
                           │
┌──────────────────────────────────────────────────────────────┐
│ Layer 2 — Core engine (pure)                                 │
│   packages/core                                              │
│     lexer → parser → validator → normalizer → registry       │
│     manifest · generator coordinator · report                │
└──────────────────────────────────────────────────────────────┘
                           │
┌──────────────────────────────────────────────────────────────┐
│ Layer 1 — Language backends                                  │
│   packages/backend-python   (TS translator + Python runtime) │
│     future: backend-typescript, backend-go, …                │
└──────────────────────────────────────────────────────────────┘
```

### Layer 1 — Language backends

A backend translates validated CDL AST into target-language test code. Each backend is a TypeScript package that registers itself with the core engine. The contract:

- Pure function — same AST in, same code out.
- No filesystem, no clock, no environment.
- Ships any runtime helper its generated code needs (e.g. `_stele_runtime.py`).

Currently shipping: `@stele/backend-python` → pytest. The translator lives in `packages/backend-python/src/translator.ts`; the runtime helper lives in `packages/backend-python/src/runtime/`.

### Layer 2 — Core engine

The core is a single TypeScript library (`@stele/core`) that owns everything language-agnostic:

| Module | Responsibility |
| --- | --- |
| `lexer/` | Tokenize `.stele` source. |
| `parser/` | Parse tokens into AST; resolve cross-file references. |
| `validator/` | Structure, types, code-shape, references, uniqueness checks; produce typed errors. |
| `normalizer/` | Canonicalize the AST for stable hashing and review. |
| `loader/` | Recursively load imports, prevent cycles. |
| `registry/` | Operator and checker registries. |
| `manifest/` | Read/write `.manifest.json` with SHA-256 hashes of protected files. |
| `baseline/` | Read/write `.baseline.json` for suppression of known legacy violations. |
| `generator/` | Coordinate backend invocation and emit/verify generated files. |
| `report/` | Build, format, fingerprint, and filter violation reports. |

The core never executes target-language code. It produces strings.

### Layer 3 — CLI

`@stele/cli` is the surface humans, CI, and agents use. Each command in `packages/cli/src/commands/` is a thin wrapper around core APIs.

User-facing commands: `init`, `generate`, `check`, `lock`, `unlock`, `baseline-init`, `baseline-update`, `add-checker`, `list`, `dev`, `doc`.

Agent-facing commands (read-only or add-only): `rules`, `agent-context`, `explain`, `why`, `propose`, `maintenance-summary`.

`stele check` is the enforcement step. Exit codes are part of the user contract:
- `0` — clean
- `1` — general failure
- `2` — generated tests drifted from CDL
- `3` — protected manifest or protected file set is out of date

### Layer 4 — IDE adapters

`@stele/claude-code-plugin` wires Stele into Claude Code:

| Hook event | Script | Purpose |
| --- | --- | --- |
| `SessionStart`, `UserPromptSubmit` | `lifecycle-context.js` | Inject contract context into the agent session. |
| `PreToolUse` (Read/Write/Edit/Bash) | `lifecycle-context.js`, `pre-tool-protect.js` | Inject focused context; block direct edits to protected paths. |
| `PostToolUse` | `observation-hook.js` | Record material source edits for later contract review. |
| `Stop` | `stop-validate.js` | Run `stele check` + pytest; prompt for maintenance review on material changes. |

Slash commands (`/stele:init`, `/stele:check`, `/stele:add`, `/stele:explain`, `/stele:rules`, `/stele:context`, `/stele:why`, `/stele:maintain`), three subagents (`contract-author`, `contract-fixer`, `contract-reviewer`), and two skills (`contract-aware-coding`, `contract-debugging`) ship in the same package.

## Data flow

```
                       ┌─────────────────┐
       agent edits ───►│  Claude Code    │
                       │  PreToolUse     │──denied──► error to agent
                       └────────┬────────┘
                                │ allowed
                                ▼
                       ┌─────────────────┐
                       │ source files    │
                       └────────┬────────┘
                                │
                                ▼ (Stop hook fires)
                       ┌─────────────────┐
                       │ stele check     │
                       │ + pytest        │
                       └────────┬────────┘
                                │
        clean ◄─────exit 0──────┤
                                │
        drift ◄────exit 2/3─────┘
        (agent must fix)
```

CI mirrors the Stop hook: `npx stele generate && pytest tests/contract && npx stele check`.

## Repository layout

```
packages/
  core/                    # @stele/core
  backend-python/          # @stele/backend-python
  cli/                     # @stele/cli
  claude-code-plugin/      # @stele/claude-code-plugin

scripts/
  publish-npm.mjs          # release packing + publish
  verify-packed-adoption.mjs   # packed-tarball install integration test

local-packages/
  install-stele-local.ps1  # Windows local install from this checkout
  *.tgz                    # packed tarballs (gitignored)

fixtures/
  python-app/              # internal Python fixture used by integration tests

examples/
  finance-guard/           # full FastAPI-style demo with real contracts

docs/                      # all documentation (you are here)

.github/workflows/         # CI and publish workflows
```

## Extension points

The cleanest place to extend is **adding a language backend**:

1. Create `packages/backend-<lang>/` mirroring `packages/backend-python/`.
2. Implement `LanguageBackend` from `@stele/core/generator/coordinator.ts`.
3. Register the backend with the CLI's `init` and `generate` commands.
4. Ship a runtime helper if the generated tests need one.

Other extension points:

- **CDL operators** — extend the registry in `packages/core/src/registry/operators.ts` and the spec in `docs/spec/cdl.md`. New operators must have a Python runtime implementation in `packages/backend-python/src/runtime/`.
- **CLI commands** — add to `packages/cli/src/commands/` and register in `packages/cli/src/index.ts`.
- **IDE adapters** — model after `packages/claude-code-plugin/`; the same hook contract (PreToolUse deny, Stop validate) generalizes to any agentic IDE.

For the strategic priority order (TypeScript backend first, then Go, then Java), see [`strategy/roadmap.md`](strategy/roadmap.md).

## Determinism is load-bearing

Every layer is deterministic by design:

- The lexer/parser/validator are pure functions over file content.
- The normalizer produces stable AST canonicalization.
- The generator coordinator emits files whose contents depend only on AST + backend.
- The manifest uses SHA-256 over generated and protected files.

If you introduce nondeterminism — a clock, a random seed, a non-stable iteration order — the manifest hashes drift and `stele check` fails for users who have not changed anything. This is the most common way to break trust in the tool. When in doubt, sort.
