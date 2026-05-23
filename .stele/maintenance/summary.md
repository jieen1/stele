# Stele Maintenance Summary

## Contract inventory
- Invariants: 27
- Code-shape rules: 0
- Scenarios: 0
- Protected globs: contract/**/*.stele, contract/checker_impls/**/*, contract/design/**/*, contract/design/proposals/**/*, contract/.baseline.json, contract/.manifest.json, tests/contract/**/*

## Design profile

- Profile hash: ce02ba807b519860a39d80c91aecafca93c8a6ac362de41ca5b7884932827cd4
- Profile ID: stele-self
- Decisions: 1
- Manifest valid: true
- Manifest drifts: <none>

## Recent changed files
- <none>

## Current check status
- Stele check report: 10 active violation(s) need attention.

## Candidate questions for newly learned behavior
- Did recent work reveal a domain invariant that should be checked every time?
- Did a repeated bug pattern suggest a boundary, type-policy, or invariant?
- Can the new knowledge be added as a new rule without modifying or deleting existing contract material?

## Agent maintenance instructions
- Additions: use `stele propose invariant --apply --id <ID> --severity <level> --description <text> --assert <expr>`.
- Modifications and deletions require explicit user review before editing existing contract files.
- Do not run `stele lock` or baseline updates unless the user approved the contract change and reason.
