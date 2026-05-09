# @stele/backend-typescript

TypeScript backend for [Stele](https://github.com/jieen/stele). Translates a
parsed [`@stele/core`](../core) `Contract` into a Vitest test suite plus the
`_stele_runtime.ts` helper module.

## Status

**Phase A skeleton (EP01).** Implements 11 operators:

| Group       | Operators                              |
| ----------- | -------------------------------------- |
| Path        | `path`                                 |
| Comparison  | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`  |
| Logic       | `and`, `or`, `not`                     |
| Test driver | `assert` (wraps `expect(...).toBe(true)`) |

The remaining 40+ operators (collection, arithmetic, scenario, checker,
temporal, etc.) land in subsequent phases of EP01. Using an unsupported
operator throws `SteleError` with code `E0601`.

## Usage

```ts
import backend from "@stele/backend-typescript";
import { loadContract, coordinateGeneration } from "@stele/core";

const contract = await loadContract("./contract/main.stele");
const files = coordinateGeneration(contract, backend, {
  projectRoot: process.cwd(),
  outputDir: "tests/contract",
});
// Each file: { path: "tests/contract/...", content: "..." }
```

The generated test files reference `./conftest.js` for the `steleContext`
fixture. Authors own that file; the backend never overwrites it.

## Generated output

```
tests/contract/
  _stele_runtime.ts    # SteleContext + path/eq/gt helpers (auto-generated)
  test_contract.ts     # one `describe` + one `it` per top-level invariant
  test_<group>.ts      # one file per (group ...) declaration
```

Run the generated suite with `vitest run tests/contract`.
