// Design Profile types — Phase 1.1 of DDD + TypeDriven feature.
// These types mirror the YAML schema defined in docs/design/ddd-typedriven-implementation-design.md §4.

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type Decision = {
  id: string;
  question_id: string;
  selected_option: string;
  rationale: string;
  approved_by: string;
  approved_at: string;
};

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export type Project = {
  language: string;
  source_roots: string[];
  ignore: string[];
  tsconfig?: string;
};

// ---------------------------------------------------------------------------
// Bounded Context
// ---------------------------------------------------------------------------

export type AggregateRoot = {
  id: string;
  decision_ref?: string;
  class: string;
  target: string; // "path.ts::ClassName"
  /**
   * Phase 6 self-dogfooding: when populated, the design generator emits a
   * paired `(class-shape …)` declaration alongside the aggregate's
   * `(core-node …)`. The `target` field must resolve to a real class
   * declaration for the class-shape evaluator to bind — function targets
   * are silently dropped (logged at generate time). Both fields are
   * optional; an aggregate without them is metric-bounded only.
   */
  required_methods?: string[];
  required_fields?: string[];
  metrics: {
    sloc?: { ideal: number; max: number };
    "public-method-count"?: { ideal: number; max: number };
    "max-cyclomatic"?: { ideal: number; max: number };
  };
};

export type Context = {
  id: string;
  decision_ref?: string;
  name: string;
  subdomain_type: "core" | "supporting" | "generic";
  root: string;
  architecture_style?: "domain_model" | "transaction_script" | "hexagonal";
  architecture_style_decision_ref?: string;
  layers: Record<string, string | string[]>;
  layer_dependencies?: Record<string, string[]>;
  aggregate_roots?: AggregateRoot[];
};

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

export type Integration = {
  from: string;
  to: string;
  decision_ref?: string;
  pattern: "anti_corruption_layer" | "open_host_service" | "published_language";
  adapter_module?: string;
};

// ---------------------------------------------------------------------------
// Shared Kernel
// ---------------------------------------------------------------------------

export type SharedKernel = {
  id: string;
  decision_ref?: string;
  paths: string[];
};

// ---------------------------------------------------------------------------
// Core Invariant
// ---------------------------------------------------------------------------

export type CoreInvariant = {
  id: string;
  description: string;
  evolvability: "never" | "with-review" | "flexible";
  status: "pending" | "enforced";
  enforcement?: {
    kind: "stele-rule" | "scenario-required" | "external-tool";
    rule_ref?: string;
    scenario_ref?: string;
    external_tool_ref?: string;
  };
};

// ---------------------------------------------------------------------------
// DDD section
// ---------------------------------------------------------------------------

export type DddSection = {
  bounded_context_strategy: string;
  contexts: Context[];
  shared_kernels?: SharedKernel[];
  integrations?: Integration[];
  domain_model_style?: string;
  entity_mutability?: string;
  error_handling?: string;
  aggregate_reference_rule?: string;
  repository_location?: string;
  repository_pattern?: string;
  query_constraints?: {
    no_find_all?: boolean;
    require_pagination?: boolean;
    require_filter?: boolean;
  };
  core_invariants?: CoreInvariant[];
};

// ---------------------------------------------------------------------------
// Branded ID
// ---------------------------------------------------------------------------

export type BrandedId = {
  id?: string;
  name?: string;
  decision_ref?: string;
  type_name?: string;
  type_target?: string;
};

// ---------------------------------------------------------------------------
// Smart Constructor
// ---------------------------------------------------------------------------

export type SmartConstructor = {
  id?: string;
  name?: string;
  decision_ref?: string;
  class_target?: string;
  factory_methods?: string[];
};

// ---------------------------------------------------------------------------
// Type-Driven section
// ---------------------------------------------------------------------------

export type TypeDrivenSection = {
  enabled: boolean;
  decision_ref?: string;
  branded_ids?: {
    mode: string;
    declarations?: BrandedId[];
    entity_id_map?: Array<{ aggregate: string; id_type: string }>;
  };
  /**
   * @deprecated Phase B removes ADT exhaustiveness. This field is parsed but ignored; will be removed in v0.4.
   *             If your profile uses it, no action is needed — Stele 0.3 silently ignores the field.
   */
  adt?: {
    mode: string;
    entities?: Array<{ name: string; type_target: string }>;
  };
  smart_constructors?: {
    mode: string;
    value_objects?: SmartConstructor[];
  };
  type_state?: {
    mode: string;
    state_machines?: Array<{ name: string; api_target: string }>;
  };
  runtime_validation?: {
    tool: string;
    schemas?: unknown[];
  };
};

// ---------------------------------------------------------------------------
// Toolchain Contracts
// ---------------------------------------------------------------------------

export type ToolchainContracts = {
  typescript_config?: {
    decision_ref?: string;
    required_options?: Record<string, unknown>;
    tsconfig_path?: string;
  };
  typescript_diagnostics?: {
    enabled: boolean;
    command: string;
  };
  eslint?: {
    enabled: boolean;
    format: string;
    rules: string[];
    command?: string;
    warning_is_error?: boolean;
  };
};

// ---------------------------------------------------------------------------
// Trace Policy (Phase B T3.4 — call-graph trace-policy declarations)
// ---------------------------------------------------------------------------

/**
 * Single trace-policy entry as captured in the design profile YAML.
 *
 * Field names use snake_case to match the surrounding YAML convention; the
 * design-generator renders them out as kebab-case CDL forms
 * (must_transit → must-transit, deny_direct → deny-direct, fix_hint →
 * fix-hint, …). The structural parser in `@stele/core` consumes the
 * kebab-case form.
 */
export interface TracePolicySpec {
  id: string;
  description?: string;
  severity?: "error" | "warning";
  target: readonly string[];
  must_transit?: readonly string[];
  must_be_preceded_by?: readonly string[];
  must_be_followed_by?: readonly string[];
  deny_direct?: readonly string[];
  deny_transit?: readonly string[];
  scope?: readonly string[];
  exempt?: readonly { pattern: string; reason: string }[];
  fix_hint?: string;
}

export interface TraceSection {
  policies: readonly TracePolicySpec[];
}

// ---------------------------------------------------------------------------
// Self Constraints (for Stele's own strict self-check)
// ---------------------------------------------------------------------------

export type SelfConstraints = {
  no_baseline?: boolean;
};

// ---------------------------------------------------------------------------
// Design Profile (top-level)
// ---------------------------------------------------------------------------

export type DesignProfile = {
  schema_version: number;
  kind: string;
  profile_id: string;
  created_at: string;
  updated_at: string;
  decisions?: Decision[];
  project: Project;
  ddd?: DddSection;
  type_driven?: TypeDrivenSection;
  trace?: TraceSection;
  toolchain_contracts?: ToolchainContracts;
  self_constraints?: SelfConstraints;
};
