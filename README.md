# Stele

Stele is a production contract tool for AI-assisted software delivery. It is designed to live inside real application repositories, generate enforceable artifacts, and fail local or CI workflows when contract rules drift.

This repository is the v0.1 monorepo scaffold. It is organized as four workspace packages:

- `@stele/core` for parsing, validation, manifests, and generation coordination
- `@stele/backend-python` for pytest-oriented code generation
- `@stele/cli` for the user and CI entrypoint
- `@stele/claude-code-plugin` for editor-side guardrails

This is not a demo repository. The goal is a publishable toolchain that can be installed into real Python application projects and used in local development, AI editing flows, and CI enforcement.
