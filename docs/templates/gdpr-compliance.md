# GDPR Compliance Contract Template

## Overview

This template encodes core invariants from the EU General Data Protection
Regulation (Regulation 2016/679) as machine-checkable Stele contracts. It is
designed as a proof-of-concept to demonstrate how Stele can enforce privacy
compliance at the data-model level.

The template covers **six GDPR articles** with **16 invariants** organized into
six groups. Each invariant maps to a specific regulatory requirement.

## Quick start

```bash
# 1. Copy the template into your project's contract directory
cp node_modules/@stele/core/templates/gdpr.stele contract/gdpr.stele

# 2. Stele generates the pytest modules
stele generate

# 3. Wire your data model into conftest.py so the generated tests
#    can read your collections (see "Adapting to your data model" below).

# 4. Run the check
stele check
```

## Invariant catalogue

| ID | Group | GDPR Article | Severity | What it checks |
|----|-------|-------------|----------|----------------|
| `GDPR_MIN_001` | data-minimization | Art. 5(1)(c) | critical | Every field on a data-subject record is in the approved-field whitelist. |
| `GDPR_MIN_002` | data-minimization | Art. 5(1)(c) | high | The approved-fields list is not empty. |
| `GDPR_MIN_003` | data-minimization | Art. 5(1)(c), Art. 9 | medium | Sensitive fields carry an explicit `lawful-basis` tag. |
| `GDPR_CNS_001` | consent-management | Art. 7 | critical | Consent-based processing has a valid consent-id and timestamp. |
| `GDPR_CNS_002` | consent-management | Art. 7(3) | critical | Active processing stops when consent is withdrawn. |
| `GDPR_CNS_003` | consent-management | Art. 7(3) | high | Withdrawn consents record the withdrawal timestamp. |
| `GDPR_RET_001` | data-retention | Art. 5(1)(e) | critical | Active records do not exceed their retention period. |
| `GDPR_RET_002` | data-retention | Art. 5(1)(e) | high | Expired records are marked `pending-deletion`. |
| `GDPR_ERS_001` | erasure | Art. 17 | critical | Erasure requests end as completed or rejected-with-reason. |
| `GDPR_ERS_002` | erasure | Art. 17 | critical | Completed erasures resolve within 30 days. |
| `GDPR_ERS_003` | erasure | Art. 17 | high | Pending erasures older than 20 days are escalated. |
| `GDPR_ERS_004` | erasure | Art. 17 | critical | Completed erasures leave zero active copies. |
| `GDPR_PROC_001` | processor-authorization | Art. 28 | critical | Assigned processors are in the authorized list. |
| `GDPR_PROC_002` | processor-authorization | Art. 28 | high | Authorized processors have a signed DPA on file. |
| `GDPR_BRN_001` | breach-notification | Art. 33 | critical | Personal-data breaches are reported within 72 hours. |
| `GDPR_BRN_002` | breach-notification | Art. 33 | critical | Reported breaches have an impact assessment. |
| `GDPR_BRN_003` | breach-notification | Art. 33 | high | Breaches cannot close without a remediation plan. |

## CDL structure

```
gdpr.stele
├── metadata
├── group data-minimization         (Art. 5(1)(c))
│   ├── GDPR_MIN_001  (forall + in)
│   ├── GDPR_MIN_002  (length check)
│   └── GDPR_MIN_003  (forall + not-null)
├── group consent-management        (Art. 7)
│   ├── GDPR_CNS_001  (forall + implies + and)
│   ├── GDPR_CNS_002  (forall + implies + not)
│   └── GDPR_CNS_003  (forall + implies)
├── group data-retention            (Art. 5(1)(e))
│   ├── GDPR_RET_001  (forall + implies + lte)
│   └── GDPR_RET_002  (forall + implies + gt)
├── group erasure                   (Art. 17)
│   ├── GDPR_ERS_001  (forall + or)
│   ├── GDPR_ERS_002  (forall + implies + lte)
│   ├── GDPR_ERS_003  (forall + implies + gt)
│   └── GDPR_ERS_004  (forall + implies + eq)
├── group processor-authorization   (Art. 28)
│   ├── GDPR_PROC_001 (forall + in)
│   └── GDPR_PROC_002 (forall + not-null)
└── group breach-notification       (Art. 33)
    ├── GDPR_BRN_001  (forall + implies + lte)
    ├── GDPR_BRN_002  (forall + implies + not-null)
    └── GDPR_BRN_003  (forall + implies + not-null)
```

## Adapting to your data model

The template references these collections. Each maps to a key in
`stele_context` that your `conftest.py` fixture must populate:

| Collection | Description | Example fixture key |
|---|---|---|
| `data-subject-fields` | Field names present on a data-subject record | `["name", "email", "phone"]` |
| `approved-fields` | Whitelist of fields your privacy policy permits | `["name", "email"]` |
| `sensitive-fields` | Fields classified as sensitive (special category) | `[{name: "health", lawful-basis: "explicit_consent"}]` |
| `processing-records` | Records of each personal-data processing activity | See schema below |
| `consents` | Consent entries from your consent manager | See schema below |
| `data-records` | Stored personal-data records with retention metadata | See schema below |
| `erasure-requests` | Incoming subject erasure requests (DSARs) | See schema below |
| `authorized-processors` | Approved third-party processors | `[{name: "Stripe", dpa-effective-date: "..."}]` |
| `breaches` | Detected data breaches | See schema below |

### Processing record schema

```python
{
    "legal_basis": "consent",        # or "contract", "legitimate_interest", etc.
    "consent_id": "c-12345",
    "consent_timestamp": "2026-01-15T10:30:00Z",
    "consent_withdrawn": False,
    "status": "active",
    "processor_name": "Stripe",
}
```

### Erasure request schema

```python
{
    "status": "completed",           # "pending" | "completed" | "rejected"
    "rejection_reason": None,        # required when status == "rejected"
    "days_since_created": 12,
    "escalated": False,
    "remaining_active_copies": 0,
}
```

### Breach schema

```python
{
    "severity": "personal-data",     # or "internal" (non-personal)
    "hours_until_reported": 48,
    "reported": True,
    "impact_assessment": "DPIA-2026-001",
    "status": "closed",
    "remediation_plan": "REMEDIATION-42",
}
```

## Extending the template

- **Add custom checkers** for domain-specific rules (e.g., checking that
  anonymized data cannot be re-identified). Use `(checker ...)` and
  `(uses-checker ...)` in place of `assert`.
- **Add scenario-driven tests** for end-to-end flows (e.g., submit erasure
  request -> verify deletion). Use `(scenario ...)` with
  `python-import` executor.
- **Adjust severity levels** to match your risk assessment. The template
  uses conservative defaults.

## Limitations

This template covers the most commonly audited GDPR articles. It does not
encode every provision of the regulation. Notable gaps:

- **Data Portability** (Art. 20) — requires format-specific assertions.
- **Privacy by Design** (Art. 25) — procedural, hard to encode declaratively.
- **Data Protection Impact Assessments** (Art. 35) — policy-level requirement.
- **Cross-border transfers** (Ch. V) — jurisdiction-specific rules.
