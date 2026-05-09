# Fixture 02: forall-collection

**Purpose**: validate collection iteration plus aggregation operators.

**CDL features exercised**:

- `(forall <var> (collection <name>) <predicate>)` quantification
- `(gt ...)` comparison nested under `forall`
- `(sum (collection ...) (path ...))` aggregation
- `(lt ...)` numeric comparison on aggregate output
- Multiple top-level invariants in one file

**Why this fixture**: backends must lower `forall` and `sum` consistently so
that downstream witness emission (EP07) can attach `failure_witness` payloads
in a structurally identical way. The fixture asserts that all three positions
have positive quantity and that the sum of market values is below 100 000.
