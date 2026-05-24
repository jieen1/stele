// Round 13 M-11: canonical schema for the YAML the `stele design
// propose` flow emits. Each kind has a required-field list; the
// validator asserts every field is present and has the right primitive
// type. The propose command runs this AFTER building its content
// object and BEFORE writeFileSync, so the YAML on disk is always
// schema-conformant. The approve flow re-runs the same validator
// against the proposal YAML to detect post-hoc tampering.
//
// Why this matters: the propose emitter is mechanical, but human
// authors are also allowed to edit a proposal YAML before running
// approve (the Phase B kinds explicitly expect this). The schema is
// the contract for "what a proposal must look like by the time it
// reaches approve."

export type ProposalKind =
  | "invariant"
  | "branded-id"
  | "aggregate"
  | "trace-policy"
  | "type-state"
  | "effect-policy"
  | "effect-suppression";

export const ALL_PROPOSAL_KINDS: ReadonlyArray<ProposalKind> = [
  "invariant",
  "branded-id",
  "aggregate",
  "trace-policy",
  "type-state",
  "effect-policy",
  "effect-suppression",
];

export const PHASE_A_KINDS: ReadonlySet<string> = new Set<string>([
  "invariant",
  "branded-id",
  "aggregate",
]);

export const PHASE_B_KINDS: ReadonlySet<string> = new Set<string>([
  "trace-policy",
  "type-state",
  "effect-policy",
  "effect-suppression",
]);

interface FieldSpec {
  required: boolean;
  type: "string" | "iso-date";
}

const BASE_FIELDS: Record<string, FieldSpec> = {
  id: { required: true, type: "string" },
  kind: { required: true, type: "string" },
  created_at: { required: true, type: "iso-date" },
};

const PER_KIND_FIELDS: Record<ProposalKind, Record<string, FieldSpec>> = {
  "invariant": {
    description: { required: true, type: "string" },
    evolvability: { required: true, type: "string" },
  },
  "branded-id": {
    type_name: { required: true, type: "string" },
    target: { required: true, type: "string" },
  },
  "aggregate": {
    description: { required: true, type: "string" },
    target: { required: true, type: "string" },
  },
  "trace-policy": {
    description: { required: true, type: "string" },
  },
  "type-state": {
    description: { required: true, type: "string" },
  },
  "effect-policy": {
    description: { required: true, type: "string" },
  },
  "effect-suppression": {
    description: { required: true, type: "string" },
  },
};

export interface ProposalSchemaError {
  field: string;
  message: string;
}

const _ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function isProposalKind(value: unknown): value is ProposalKind {
  return typeof value === "string" && (ALL_PROPOSAL_KINDS as ReadonlyArray<string>).includes(value);
}

/**
 * Validate a proposal YAML body against the canonical schema. Returns
 * an array of errors — empty when the body is conformant.
 */
export function validateProposalSchema(
  body: Record<string, unknown>,
): ProposalSchemaError[] {
  const errors: ProposalSchemaError[] = [];

  // Base envelope: id / kind / created_at.
  for (const [name, spec] of Object.entries(BASE_FIELDS)) {
    const err = checkField(body, name, spec);
    if (err) errors.push(err);
  }

  const kind = body.kind;
  if (typeof kind !== "string") {
    return errors;
  }
  if (!isProposalKind(kind)) {
    errors.push({
      field: "kind",
      message: `unknown kind "${kind}"; allowed: ${ALL_PROPOSAL_KINDS.join(", ")}`,
    });
    return errors;
  }
  const perKindSpec = PER_KIND_FIELDS[kind];
  for (const [name, spec] of Object.entries(perKindSpec)) {
    const err = checkField(body, name, spec);
    if (err) errors.push(err);
  }

  return errors;
}

function checkField(
  body: Record<string, unknown>,
  name: string,
  spec: FieldSpec,
): ProposalSchemaError | null {
  const present = Object.prototype.hasOwnProperty.call(body, name);
  if (!present) {
    if (spec.required) {
      return { field: name, message: "required field is missing" };
    }
    return null;
  }
  const value = body[name];
  if (spec.type === "string") {
    if (typeof value !== "string") {
      return { field: name, message: `expected string, got ${describeType(value)}` };
    }
    if (value.length === 0) {
      return { field: name, message: "string must be non-empty" };
    }
    return null;
  }
  if (spec.type === "iso-date") {
    if (typeof value !== "string") {
      return { field: name, message: `expected ISO date string, got ${describeType(value)}` };
    }
    if (!_ISO_DATE_RE.test(value)) {
      return { field: name, message: "value is not an ISO-8601 timestamp" };
    }
    return null;
  }
  return null;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
