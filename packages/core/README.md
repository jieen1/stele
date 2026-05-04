# @stele/core

Core library for Stele contract loading, validation, normalization, manifest management, and generated-file coordination.

## Install

```bash
npm install @stele/core
```

## What it exports

- `parseFile()` and `lex()` for CDL parsing
- `loadContract()` and `validateContract()` for recursive contract loading
- `normalizeContract()` for stable hashing and review output
- `writeManifest()` and `verifyManifest()` for protected-file locking
- `coordinateGeneration()` and `verifyGenerated()` for backend-driven file generation
- The public AST, error, and operator registry types

`@stele/core` is the library layer used by the Stele CLI and language backends.
