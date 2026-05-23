# @stele/call-graph-core

Language-agnostic call-graph primitives for Stele's Phase B evaluators
(trace, type-state, effect). This package owns the canonical
`CallGraph` shape that per-language extractors (TypeScript, Python,
Go, Java, Rust) produce, plus helpers for parsing and matching the
cross-language `NodeId` strings used in CDL patterns.

There are zero language toolchain dependencies here. The actual
extraction of source code into a `CallGraph` lives in the per-language
backend packages; this package only defines the types they all
implement and the NodeId / pattern / extern-alias logic they share.
