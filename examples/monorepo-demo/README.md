# Stele monorepo demo

This directory demonstrates Stele's `--recursive` flag (EP08, Phase 1) for
checking, generating, and locking across multiple projects from a monorepo
root with one command.

## Layout

```
examples/monorepo-demo/
  packages/
    core/                          # Python project
      stele.config.json
      contract/main.stele
    api/                           # TypeScript project
      stele.config.json
      contract/main.stele
```

The two projects intentionally use different backends (`python/pytest` and
`typescript/vitest`) to show that `--recursive` correctly resolves the right
backend for each project.

## Usage

From this directory, generate test files for both projects in one command:

```bash
stele generate --recursive
```

Then lock both:

```bash
stele lock --recursive --reason "initial monorepo demo lock"
```

Then verify both:

```bash
stele check --recursive
```

Each command discovers `stele.config.json` files under the current directory
(skipping `node_modules`, `.git`, `dist`, `build`, etc.), processes each
project in lex-sorted order, and aggregates exit codes per the EP08 spec:

* All success → exit 0
* Any project hits exit 1 (user/internal error) → total exit 1
* Otherwise, max of remaining drift exit codes (2 or 3)

## JSON output

Add `--json` to emit a single aggregate JSON document with per-project
sub-reports:

```bash
stele check --recursive --json
```

The schema is documented in `docs/spec/cli-output.md` § 4.4.

## Nested projects

If a directory contains `stele.config.json`, `--recursive` does **not**
descend into it. Nested projects are not allowed; restructure to keep each
Stele project at its own first-class directory.
